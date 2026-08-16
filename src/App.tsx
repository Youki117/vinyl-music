import { useEffect, useState } from "react"

import Stage from "@/stage/Stage"
import Masthead from "@/ui/Masthead"
import Lyrics from "@/ui/Lyrics"
import Disc from "@/ui/Disc"
import Progress from "@/ui/Progress"
import Controls from "@/ui/Controls"
import Actions from "@/ui/Actions"
import TitleBar from "@/ui/TitleBar"
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
import { isAudioFile, isLyricFile, isPlaylistFile, platform } from "@/platform"

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

  // 黑胶右键直接换底图，是 PRD §6.2 要求的三步内完成的主路径
  const importBackdrop = async () => {
    const ref = await platform.pickImage()
    if (ref) {
      await setBackdrop(ref)
      setPanel("skin")
    }
  }

  return (
    <Stage>
      <TitleBar
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

      {/* 常驻操控件，点它不该被当成"点了面板外面" */}
      <button
        className="sparkle"
        data-keep-panel
        onClick={importBackdrop}
        aria-label="更换底图"
        title="更换底图"
      >
        <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2.6c.7 3.9 2.9 6.1 6.8 6.8-3.9.7-6.1 2.9-6.8 6.8-.7-3.9-2.9-6.1-6.8-6.8 3.9-.7 6.1-2.9 6.8-6.8Z"
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
