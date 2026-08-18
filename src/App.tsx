import { useEffect, useState } from "react"

import Stage from "@/stage/Stage"
import Masthead from "@/ui/Masthead"
import Lyrics from "@/ui/Lyrics"
import Disc from "@/ui/Disc"
import Progress from "@/ui/Progress"
import Controls from "@/ui/Controls"
import Actions from "@/ui/Actions"
import TitleBar from "@/ui/TitleBar"
import Sidebar from "@/ui/Sidebar"
import Playlist from "@/ui/panels/Playlist"
import SkinEditor from "@/ui/panels/SkinEditor"
import Playback from "@/ui/panels/Playback"
import { useLibrary } from "@/store/library"
import { useAi } from "@/store/ai"
import { useMix } from "@/store/mix"
import MixPanel from "@/ui/panels/Mix"
import { engine } from "@/audio/engine"
import { usePlayer } from "@/store/player"
import { useSkin } from "@/store/skin"
import { isAudioFile, isLyricFile, isPlaylistFile, platform, type FileRef } from "@/platform"
/*
 * 在线音源**按需加载**，不在启动路径上。
 *
 * 这一条是踩出来的：音源依赖的 node polyfill（crypto/zlib/Buffer）目前在打包构建里
 * 还没配通，同步 import 会让整个应用启动即白屏。改成动态 import 之后，音源没配好
 * 也只影响搜索本身，播放器照常能用 —— 这个隔离本来就该有，不该让一个可选功能
 * 拖垮主流程。
 *
 * window.__source 是给端到端核查用的入口（scripts/verify-source.mjs）：音源请求必须
 * 走 Tauri 的 plugin-http 从 Rust 侧发，普通浏览器里没有 __TAURI_INTERNALS__，
 * 导航到 dev server 又会被 ACL 当远程源挡掉，只有在应用自己的源里才测得到。
 * 暴露的都是查询函数，不含任何写权限。
 */
declare global {
  interface Window {
    __source?: typeof import("@/source")
  }
}
void import("@/source")
  .then((m) => {
    window.__source = m
  })
  .catch((err) => {
    console.warn("[source] 在线音源加载失败，搜索不可用，播放器其余功能不受影响", err)
  })

/** 右侧抽屉同一时刻只能开一个 */
type PanelId = "playlist" | "skin" | "playback" | "mix" | null

export default function App() {
  const loadSkin = useSkin((s) => s.load)
  const setBackdrop = useSkin((s) => s.setBackdrop)
  const init = usePlayer((s) => s.init)
  const addFiles = useLibrary((s) => s.addFiles)
  const toggle = usePlayer((s) => s.toggle)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const error = usePlayer((s) => s.error)
  const queueLength = usePlayer((s) => s.queue.length)
  // 四个抽屉都在右侧同一位置，本来就只能显示一个。
  // 之前用四个布尔量拼 `open={a && !b && !c}`，被盖住的那个状态还是 true，
  // 关掉上面那个它就自己冒出来了 —— 换成单一状态，互斥是结构自带的。
  const [panel, setPanel] = useState<PanelId>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const togglePanel = (id: Exclude<PanelId, null>) =>
    setPanel((cur) => (cur === id ? null : id))

  // 导入后队列还是空的话，直接把新导入的曲目接上，省得用户再去列表里点一次
  const importAndQueue = async (files: Parameters<typeof addFiles>[0]) => {
    const added = await addFiles(files)
    if (added.length > 0 && usePlayer.getState().queue.length === 0) {
      usePlayer.setState({ queue: added, index: 0 })
    }
  }

  const say = (msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 3200)
  }

  useEffect(() => {
    void loadSkin()
    void init()
    void useAi.getState().load()
  }, [loadSkin, init])

  // 切歌时：套用该曲已有的 AI 配图，并把混音编排切到这首歌上
  useEffect(() => {
    void useMix.getState().load()
    let last: string | null = null
    return usePlayer.subscribe((s) => {
      const t = s.current()
      if (!t || t.id === last) return
      last = t.id
      void useAi.getState().maybeAuto(t)
      void useMix.getState().setHost(t.id)
    })
  }, [])

  // 拖文件进窗口导入（F2.2）。音频进播放列表，图片直接当底图 —— 换皮肤最快的路径。
  useEffect(() => {
    return platform.onFileDrop((files) => {
      const audio = files.filter((f) => isAudioFile(f.name))
      const lrc = files.filter((f) => isLyricFile(f.name))
      const m3u = files.find((f) => isPlaylistFile(f.name))
      const image = files.find((f) => /\.(png|jpe?g|webp|avif|bmp)$/i.test(f.name))

      void (async () => {
        // 歌词要在音频入库之后才挂得上——同名匹配需要曲目已经存在
        if (audio.length > 0) await importAndQueue(audio)
        if (lrc.length > 0) {
          const n = await useLibrary.getState().attachLyrics(lrc)
          usePlayer.getState().refreshQueueMeta()
          say(n > 0 ? `已挂上 ${n} 份歌词` : "没有找到同名的曲目，歌词未挂上")
        }
        if (m3u) {
          const r = await useLibrary.getState().importPlaylist(m3u)
          say(
            r.playlistId
              ? `已导入 ${r.matched} 首${r.missing > 0 ? `，${r.missing} 首找不到文件` : ""}`
              : "歌单里的曲目一首都没找到",
          )
        }
        if (image) await setBackdrop(image)
      })()
    })
    // importAndQueue / say 只读 store 的最新状态，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setBackdrop])

  // 外壳交进来的文件：命令行、「打开方式」、拖到 exe 图标上。
  // 与拖进窗口走同一条导入路径，导完直接播第一首 —— 用户点开一个 mp3 就是想听它。
  useEffect(() => {
    return platform.onOpenFiles((paths) => {
      void (async () => {
        // 必须走 platform 拿真实的 size/mtime，不能手搓 FileRef：size 缺省成 0 会让
        // engine 里的 200MB 上限判定恒不成立（命令行开一个超大 wav 就直接放行），
        // 而波形磁盘缓存的键含 size|mtime —— 缺省值会让同一个文件从命令行和从对话框
        // 导入算出两个键，各存一份。resolvePath 顺带做了能力域放行和存在性检查。
        const audio = paths.filter((p) => isAudioFile(p))
        const refs = (await Promise.all(audio.map((p) => platform.resolvePath(p, p)))).filter(
          (r): r is FileRef => r !== null,
        )
        if (refs.length === 0) return
        const added = await addFiles(refs)
        const list = added.length > 0 ? added : refs.map((r) => useLibrary.getState().byId(r.id)!).filter(Boolean)
        if (list.length > 0) await usePlayer.getState().playFrom(list, 0)
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 媒体键与托盘菜单（F8.4/F8.6）。外壳把来源统一成指令，这里不关心是谁触发的。
  useEffect(() => {
    return platform.onCommand((cmd) => {
      const p = usePlayer.getState()
      if (cmd === "toggle") p.toggle()
      else if (cmd === "pause") engine.pause()
      else if (cmd === "next") void p.next()
      else if (cmd === "prev") void p.prev()
    })
  }, [])

  // 应用内快捷键（F8.8）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
      const p = usePlayer.getState()
      switch (e.key) {
        case " ":
          e.preventDefault()
          p.toggle()
          break
        case "ArrowLeft":
          engine.seekBy(-5)
          break
        case "ArrowRight":
          engine.seekBy(5)
          break
        case "ArrowUp":
          e.preventDefault()
          p.setVolume(Math.min(1, p.volume + 0.05))
          break
        case "ArrowDown":
          e.preventDefault()
          p.setVolume(Math.max(0, p.volume - 0.05))
          break
        case "m":
        case "M":
          p.toggleMute()
          break
        case "l":
        case "L":
          // 依次是：设 A → 设 B → 清除
          engine.cycleLoop()
          break
        case "p":
        case "P":
          togglePanel("playlist")
          break
        case "s":
        case "S":
          togglePanel("skin")
          break
        case "e":
        case "E":
          togglePanel("playback")
          break
        case "x":
        case "X":
          togglePanel("mix")
          break
        case "Escape":
          setPanel(null)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  /**
   * 换底图的快捷路径：**选完图直接换掉，不弹面板**。
   *
   * 原来换完会顺手 `setPanel("skin")` 把皮肤面板打开。但这个按钮的意思就是"我要换张图"，
   * 换完弹出一整列设置项属于多做一步 —— 想调蒙版/文案/取景的人本来就会去点左上角那个
   * 皮肤按钮。两条路各干各的：右下角＝直接换图，左上角＝打开面板慢慢调。
   */
  const importBackdrop = async () => {
    const ref = await platform.pickImage()
    if (ref) await setBackdrop(ref)
  }

  return (
    <Stage>
      <TitleBar />
      <Sidebar
        onOpenPlayback={() => togglePanel("playback")}
        onOpenSkin={() => togglePanel("skin")}
        onOpenMix={() => togglePanel("mix")}
        active={panel}
      />
      <Masthead />
      <Lyrics />
      <div className="disc-ring" />
      <Disc onToggle={toggle} onContextMenu={() => setPanel("skin")} />
      <div className="disc-lighting" />
      <Actions />
      <Progress>
        <Controls
          onToggle={toggle}
          onPrev={() => void prev()}
          onNext={() => void next()}
          onOpenPlaylist={() => togglePanel("playlist")}
          playlistOpen={panel === "playlist"}
        />
      </Progress>

      {queueLength === 0 && (
        <div className="empty-hint">
          <button onClick={() => void platform.pickAudioFiles().then(importAndQueue)}>
            添加音乐文件
          </button>
          {" 或 "}
          <button onClick={() => void platform.pickAudioFolder().then(importAndQueue)}>
            选择文件夹
          </button>
        </div>
      )}

      {error && <div className="toast">{error}</div>}
      {notice && !error && <div className="toast notice">{notice}</div>}

      {/*
        常驻操控件，点它不该被当成"点了面板外面"。
        图标用相框而不是原来的四角星：四角星在这套界面里已经代表 AI（皮肤面板有
        「AI 配图」标签页），而这个按钮做的是"选一张本地图片换底图"，用星星会指错。
      */}
      <button
        className="skin-quick"
        data-keep-panel
        onClick={importBackdrop}
        aria-label="更换底图"
        title="更换底图（选图后直接生效）"
      >
        <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
          <rect
            x="3"
            y="5"
            width="18"
            height="14"
            rx="2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <circle cx="8.6" cy="10" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M4.2 17.4 9.6 12l3.3 3.3L16.3 12l3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <Playlist open={panel === "playlist"} onClose={() => setPanel(null)} />
      <SkinEditor open={panel === "skin"} onClose={() => setPanel(null)} />
      <Playback open={panel === "playback"} onClose={() => setPanel(null)} />
      <MixPanel open={panel === "mix"} onClose={() => setPanel(null)} />
    </Stage>
  )
}
