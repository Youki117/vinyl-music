/**
 * Tauri 实现。所有 @tauri-apps/* 的 import 都收敛在本文件里。
 */
import type { FileRef, Platform, WeWallpaper, WindowControls } from "./types"
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  PLAYLIST_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from "./types"
import { decodeText } from "@/lib/text"
import { isUnderDir, normalizeWin } from "@/lib/path"

import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { appDataDir } from "@tauri-apps/api/path"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { open, save } from "@tauri-apps/plugin-dialog"
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readFile as fsReadFile,
  readTextFile,
  remove,
  rename,
  stat,
  writeFile as fsWriteFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs"

const CACHE_DIR = "cache"
const SKIN_DIR = "skins"

/** Rust 侧 scan_audio_files 命令的返回形状。 */
type ScannedFile = { path: string; name: string; size: number; mtime: number }

async function refOf(path: string): Promise<FileRef> {
  const info = await stat(path)
  return {
    id: path,
    name: path.split(/[\\/]/).pop() ?? path,
    size: info.size,
    mtime: info.mtime?.getTime() ?? 0,
  }
}

/** 取所在目录，不含末尾分隔符。两种分隔符都要认——m3u 里两种都见得到。 */
function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"))
  return i < 0 ? "" : path.slice(0, i)
}

function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/")
}

/**
 * 把路径加进 fs 运行时能力域。
 *
 * 对话框选的文件由 dialog 插件自动放行，拖放与曲库恢复不会 —— 必须显式补一刀，
 * 否则音乐库只要不在 $HOME/Music 这几个标准目录下就整个读不了。
 */
async function grantPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    await invoke<number>("allow_paths", { paths })
  } catch (e) {
    // 放行失败不该让导入整个失败：域内的文件仍然读得到
    console.warn("放行路径失败", e)
  }
}

async function ensureCacheDir(): Promise<void> {
  if (!(await exists(CACHE_DIR, { baseDir: BaseDirectory.AppData }))) {
    await mkdir(CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
  }
}

/**
 * 断电窗口恢复（writeConfig 的另一半）。
 *
 * 写流程是「写 tmp → 删旧 → 改名」。在删旧与改名之间崩掉的话，正式文件不在而 tmp
 * 完好 —— 曲库这种攒出来的数据不能就这么没了。这里把 tmp 扶正并返回内容；
 * tmp 自己也坏（写在半截断电）就当没有，那时旧文件还没被删，正常路径读得到。
 */
async function recoverTmp<T>(name: string): Promise<T | null> {
  const tmp = `${name}.tmp.json`
  const dst = `${name}.json`
  try {
    if (!(await exists(tmp, { baseDir: BaseDirectory.AppData }))) return null
    const value = JSON.parse(await readTextFile(tmp, { baseDir: BaseDirectory.AppData })) as T
    await rename(tmp, dst, {
      oldPathBaseDir: BaseDirectory.AppData,
      newPathBaseDir: BaseDirectory.AppData,
    }).catch(() => {})
    console.warn(`配置 ${dst} 从中断的写入中恢复`)
    return value
  } catch {
    return null
  }
}

/*
 * 迷你模式的窗口尺寸，以及正常模式的下限。
 *
 * 下限那两个数要和 tauri.conf.json 的 minWidth/minHeight、src-tauri/src/aspect.rs 的
 * MIN_W/MIN_H 对得上 —— 三处是同一件事，改一处要一起改。
 */
const MINI_W = 380
const MINI_H = 104
const NORMAL_MIN_W = 780
const NORMAL_MIN_H = 432
/** 没有保存过尺寸时退回这个，与 tauri.conf.json 的 width/height 一致 */
const DEFAULT_W = 1280
const DEFAULT_H = 708

function makeWindowControls(): WindowControls {
  const w = getCurrentWindow()
  /** 缩进迷你模式之前的正常尺寸。只在本次运行内有效，退出不留。 */
  let normal: { width: number; height: number } | null = null

  return {
    minimize: () => w.minimize(),
    toggleMaximize: () => w.toggleMaximize(),
    close: () => w.close(),
    setFullscreen: (on) => w.setFullscreen(on),
    isFullscreen: () => w.isFullscreen(),

    async setMini(on) {
      if (on) {
        /*
         * 顺序有讲究：**先放开最小尺寸下限，再缩**。反过来的话 setSize 会被
         * 下限挡住，窗口纹丝不动，而且不报错 —— 排查起来很费劲。
         *
         * 缩完设 resizable(false)，顺带把 aspect.rs 那把比例锁绕开了：它挂在
         * WM_SIZING 上，而不可缩放的窗口根本不会收到这条消息。所以迷你模式
         * 不需要动 Rust 那一侧。
         */
        if (await w.isFullscreen()) await w.setFullscreen(false)
        const size = await w.outerSize()
        const scale = await w.scaleFactor()
        const logical = size.toLogical(scale)
        // 已经是迷你尺寸了（多半是上次在迷你模式里退出、窗口状态插件又恢复了它），
        // 那这份就不能当"正常尺寸"记下来
        if (logical.width >= NORMAL_MIN_W) normal = { width: logical.width, height: logical.height }
        await w.setMinSize(new LogicalSize(MINI_W, MINI_H))
        await w.setSize(new LogicalSize(MINI_W, MINI_H))
        await w.setResizable(false)
        await w.setAlwaysOnTop(true)
        return
      }

      await w.setAlwaysOnTop(false)
      await w.setResizable(true)
      await w.setMinSize(new LogicalSize(NORMAL_MIN_W, NORMAL_MIN_H))
      // 只有窗口确实还缩着才动它的尺寸 —— 启动时无条件调一次 setMini(false)，
      // 不能顺手把用户上次调好的正常尺寸抹掉
      const size = (await w.outerSize()).toLogical(await w.scaleFactor())
      if (size.width < NORMAL_MIN_W || size.height < NORMAL_MIN_H) {
        const back = normal ?? { width: DEFAULT_W, height: DEFAULT_H }
        await w.setSize(new LogicalSize(back.width, back.height))
        await w.center()
      }
      normal = null
    },
  }
}

export function create(): Platform {
  return {
    kind: "tauri",

    async pickAudioFiles() {
      const picked = await open({
        multiple: true,
        directory: false,
        filters: [{ name: "音频文件", extensions: [...AUDIO_EXTENSIONS] }],
      })
      if (!picked) return []
      const paths = Array.isArray(picked) ? picked : [picked]
      return Promise.all(paths.map(refOf))
    },

    async pickAudioFolder() {
      const dir = await open({ directory: true, multiple: false })
      if (!dir || Array.isArray(dir)) return []
      // 递归扫描放在 Rust 侧：前端逐层 readDir 意味着上千次 IPC 往返，
      // 达不到 PRD F2.6 要求的 1000 首 / 15 秒。
      const found = await invoke<ScannedFile[]>("scan_audio_files", { dir })
      // 对话框放行的是这个目录本身，递归扫出来的子目录文件未必在内
      await grantPaths([dir])
      return found.map((f) => ({ id: f.path, name: f.name, size: f.size, mtime: f.mtime }))
    },

    async pickImage() {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          { name: "图片或视频", extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] },
          { name: "图片", extensions: [...IMAGE_EXTENSIONS] },
          { name: "视频", extensions: [...VIDEO_EXTENSIONS] },
        ],
      })
      if (!picked || Array.isArray(picked)) return null
      return refOf(picked)
    },

    async readFile(ref) {
      return fsReadFile(ref.id)
    },

    async streamUrl(path) {
      /*
       * 放行必须在返回之前 await 完。
       *
       * asset 协议查的是**自己那份** scope（tauri 的 protocol/asset.rs 里
       * `scope.is_allowed`），`allow_paths` 放行过的路径在这里照样 403。而 403 落到
       * `<video>` 上就是"没有可用的源"—— 不抛错，只是一片空白。放行要是与返回并行
       * 发出去，就变成一个只在慢机器上偶发的空白底图。
       */
      await invoke<number>("allow_asset_paths", { paths: [path] }).catch((e) => {
        console.warn("放行 asset 路径失败", e)
      })
      return convertFileSrc(path)
    },

    async readSlice(ref, offset, length) {
      // 走自家的 read_file_slice 而不是 plugin-fs：插件只给「整个文件」这一种粒度。
      // Rust 侧回的是裸字节，不经 JSON 编码。
      const buf = await invoke<ArrayBuffer>("read_file_slice", {
        path: ref.id,
        offset,
        length,
      })
      return new Uint8Array(buf)
    },

    async readText(ref) {
      return decodeText(await fsReadFile(ref.id))
    },

    async readSidecar(ref, ext) {
      // 只换扩展名。Windows 文件系统不分大小写，.LRC 也能被 .lrc 找到
      const path = `${ref.id.replace(/\.[^.\\/]+$/, "")}.${ext}`
      // 放行音频文件不等于放行它旁边的 .lrc，得单独补一刀，
      // 否则能力域外的外挂歌词会静默地"找不到"
      await grantPaths([path])
      try {
        if (!(await exists(path))) return null
        return decodeText(await fsReadFile(path))
      } catch {
        return null
      }
    },

    async pickPlaylistFile() {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "播放列表", extensions: [...PLAYLIST_EXTENSIONS] }],
      })
      if (!picked || Array.isArray(picked)) return null
      return refOf(picked)
    },

    async pickScript() {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "音源脚本", extensions: [...SCRIPT_EXTENSIONS] }],
      })
      if (!picked || Array.isArray(picked)) return null
      // 脚本通常放在下载目录之外，读之前得先放行
      await grantPaths([picked])
      return refOf(picked)
    },

    async saveText(suggestedName, text) {
      const path = await save({
        defaultPath: suggestedName,
        filters: [{ name: "播放列表", extensions: [...PLAYLIST_EXTENSIONS] }],
      })
      if (!path) return false
      await writeTextFile(path, text)
      return true
    },

    async resolvePath(baseId, entry) {
      const cleaned = entry.trim().replace(/^file:\/\/\/?/i, "")
      if (!cleaned) return null
      const abs = isAbsolute(cleaned) ? cleaned : `${dirOf(baseId)}/${cleaned}`
      // m3u 指向的文件通常散落在能力域之外，先放行
      await grantPaths([abs])
      try {
        if (!(await exists(abs))) return null
        return await refOf(abs)
      } catch {
        return null
      }
    },

    async ensureReadable(paths) {
      await grantPaths(paths)
    },

    async listImages(prefix) {
      if (!(await exists(SKIN_DIR, { baseDir: BaseDirectory.AppData }))) return []
      const root = await appDataDir()
      const entries = await readDir(SKIN_DIR, { baseDir: BaseDirectory.AppData })
      const out: FileRef[] = []
      for (const entry of entries) {
        if (!entry.isFile || !entry.name.startsWith(prefix)) continue
        // 和 saveImage 拼绝对路径的方式保持一致，否则账本里的 path 对不上
        const abs = `${root}\\${SKIN_DIR}/${entry.name}`.replace(/\//g, "\\")
        try {
          const info = await stat(abs)
          out.push({ id: abs, name: entry.name, size: info.size, mtime: info.mtime?.getTime() ?? 0 })
        } catch {
          // 刚被别处删掉了，跳过就是
        }
      }
      return out
    },

    async removeFile(path) {
      // 只允许删应用数据目录里的东西 —— 这个方法拿到的是绝对路径，
      // 万一调用方传错，不该有把用户音乐删掉的可能。
      // 归一化 + 边界判定见 isUnderDir，裸 startsWith 挡不住 `..`
      const root = await appDataDir()
      if (!isUnderDir(root, path)) {
        throw new Error("拒绝删除应用数据目录之外的文件")
      }
      await remove(normalizeWin(path))
    },

    async updateNowPlaying(info) {
      try {
        await invoke("smtc_update", { info })
      } catch {
        // 系统面板注册不上（旧系统、被策略禁用）不该影响播放本身
      }
    },

    async readConfig<T>(name: string): Promise<T | null> {
      const file = `${name}.json`
      let raw: string
      try {
        if (!(await exists(file, { baseDir: BaseDirectory.AppData }))) {
          // 正式文件不在，先看看是不是倒在了"删旧→改名"的断电窗口里
          return recoverTmp<T>(name)
        }
        raw = await readTextFile(file, { baseDir: BaseDirectory.AppData })
      } catch (e) {
        // 权限或 IO 问题。抛出去会把整个 init() 带崩，界面停在空白态；
        // 这里降级成"没有配置"，同时留下痕迹，别让它无声无息。
        console.error(`读取配置 ${file} 失败`, e)
        return null
      }
      try {
        return JSON.parse(raw) as T
      } catch {
        // 配置损坏时留档再重建，不静默吞掉用户数据（技术文档 §12）
        await rename(file, `${name}.corrupt.json`, {
          oldPathBaseDir: BaseDirectory.AppData,
          newPathBaseDir: BaseDirectory.AppData,
        }).catch(() => {})
        return null
      }
    },

    async writeConfig<T>(name: string, value: T) {
      // 先写临时文件再原子 rename：直接覆写遇到断电会得到半截 JSON，曲库就没了
      const tmp = `${name}.tmp.json`
      const dst = `${name}.json`
      await writeTextFile(tmp, JSON.stringify(value, null, 2), { baseDir: BaseDirectory.AppData })
      if (await exists(dst, { baseDir: BaseDirectory.AppData })) {
        await remove(dst, { baseDir: BaseDirectory.AppData })
      }
      await rename(tmp, dst, {
        oldPathBaseDir: BaseDirectory.AppData,
        newPathBaseDir: BaseDirectory.AppData,
      })
    },

    async readCache(key) {
      const file = `${CACHE_DIR}/${key}`
      if (!(await exists(file, { baseDir: BaseDirectory.AppData }))) return null
      return fsReadFile(file, { baseDir: BaseDirectory.AppData })
    },

    async writeCache(key, data) {
      await ensureCacheDir()
      await fsWriteFile(`${CACHE_DIR}/${key}`, data, { baseDir: BaseDirectory.AppData })
    },

    onFileDrop(handler) {
      // tauri.conf.json 开了 dragDropEnabled，所以 HTML5 的 drop 事件不会触发，
      // 得走 Tauri 自己的事件 —— 好处是直接拿到真实路径，不必再要一次授权。
      let unlisten: (() => void) | null = null
      let cancelled = false

      void getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (event.payload.type !== "drop") return
          const paths = event.payload.paths ?? []
          // 先放行再 stat：拖进来的路径默认不在能力域里，不放行连 stat 都会被拒
          await grantPaths(paths)
          const refs: FileRef[] = []
          for (const p of paths) {
            try {
              const info = await stat(p)
              if (info.isDirectory) {
                const found = await invoke<ScannedFile[]>("scan_audio_files", { dir: p })
                refs.push(...found.map((f) => ({ id: f.path, name: f.name, size: f.size, mtime: f.mtime })))
              } else {
                refs.push(await refOf(p))
              }
            } catch {
              // 单个路径失败不影响其余
            }
          }
          if (refs.length > 0) handler(refs)
        })
        .then((fn) => {
          if (cancelled) fn()
          else unlisten = fn
        })

      return () => {
        cancelled = true
        unlisten?.()
      }
    },

    async request(url, init) {
      return tauriFetch(url, init)
    },

    async saveImage(name, bytes) {
      const dir = `${SKIN_DIR}/${name}`
      if (!(await exists(SKIN_DIR, { baseDir: BaseDirectory.AppData }))) {
        await mkdir(SKIN_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
      }
      await fsWriteFile(dir, bytes, { baseDir: BaseDirectory.AppData })
      // 底图加载走的是绝对路径，这里把 appdata 目录解析出来拼上。
      // 统一成反斜杠：混着两种分隔符的路径传给系统 API 容易出事
      const abs = `${await appDataDir()}\\${dir}`.replace(/\//g, "\\")
      return { id: abs, name, size: bytes.byteLength, mtime: Date.now() }
    },

    onOpenFiles(handler) {
      let unlisten: (() => void) | null = null
      let cancelled = false

      const deliver = async (paths: string[]): Promise<void> => {
        if (paths.length === 0) return
        // 命令行传进来的路径同样不在静态能力域里
        await grantPaths(paths)
        // 取回执和放行都是异步的，这中间可能已经退订了。退订之后再回调，
        // 等于把文件交给一个不在了的界面
        if (cancelled) return
        handler(paths)
      }

      void listen<string[]>("player://open-files", (e) => {
        void deliver(e.payload ?? [])
      }).then((fn) => {
        if (cancelled) {
          fn()
          return
        }
        unlisten = fn
        /*
         * 监听挂稳了，回来取启动期间攒下的那批文件（命令行、"打开方式"、拖到 exe 上）。
         * Rust 侧把它们存在托管队列里等这一取 —— 取完即清，此后二次启动走事件。
         * 之前是 Rust 睡 1200ms 赌这边就位，慢机器上会静默丢文件。
         */
        void invoke<string[]>("take_open_files")
          .then((pending) => deliver(pending))
          .catch(() => {})
      })

      return () => {
        cancelled = true
        unlisten?.()
      }
    },

    onCommand(handler) {
      let unlisten: (() => void) | null = null
      let cancelled = false
      void listen<string>("player://command", (e) => {
        const cmd = e.payload
        if (cmd === "toggle" || cmd === "pause" || cmd === "next" || cmd === "prev") handler(cmd)
      }).then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      return () => {
        cancelled = true
        unlisten?.()
      }
    },

    async listWallpaperEngine() {
      return invoke<WeWallpaper[]>("list_we_wallpapers")
    },

    window: makeWindowControls(),
  }
}
