/**
 * Tauri 实现。所有 @tauri-apps/* 的 import 都收敛在本文件里。
 */
import type { FileRef, Platform, WindowControls } from "./types"
import { AUDIO_EXTENSIONS, PLAYLIST_EXTENSIONS } from "./types"
import { decodeText } from "@/lib/text"

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { appDataDir } from "@tauri-apps/api/path"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { open, save } from "@tauri-apps/plugin-dialog"
import {
  BaseDirectory,
  exists,
  mkdir,
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

async function ensureCacheDir(): Promise<void> {
  if (!(await exists(CACHE_DIR, { baseDir: BaseDirectory.AppData }))) {
    await mkdir(CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true })
  }
}

function makeWindowControls(): WindowControls {
  const w = getCurrentWindow()
  return {
    minimize: () => w.minimize(),
    toggleMaximize: () => w.toggleMaximize(),
    close: () => w.close(),
    setFullscreen: (on) => w.setFullscreen(on),
    isFullscreen: () => w.isFullscreen(),
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
      return found.map((f) => ({ id: f.path, name: f.name, size: f.size, mtime: f.mtime }))
    },

    async pickImage() {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "avif", "bmp"] }],
      })
      if (!picked || Array.isArray(picked)) return null
      return refOf(picked)
    },

    async readFile(ref) {
      return fsReadFile(ref.id)
    },

    async readText(ref) {
      return decodeText(await fsReadFile(ref.id))
    },

    async readSidecar(ref, ext) {
      // 只换扩展名。Windows 文件系统不分大小写，.LRC 也能被 .lrc 找到
      const path = `${ref.id.replace(/\.[^.\\/]+$/, "")}.${ext}`
      try {
        if (!(await exists(path))) return null
        return decodeText(await fsReadFile(path))
      } catch {
        // 落在 fs scope 之外时会抛，这时当作没有外挂歌词
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
      try {
        if (!(await exists(abs))) return null
        return await refOf(abs)
      } catch {
        return null
      }
    },

    async readConfig<T>(name: string): Promise<T | null> {
      const file = `${name}.json`
      if (!(await exists(file, { baseDir: BaseDirectory.AppData }))) return null
      const raw = await readTextFile(file, { baseDir: BaseDirectory.AppData })
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
      // 底图加载走的是绝对路径，这里把 appdata 目录解析出来拼上
      const abs = `${await appDataDir()}/${dir}`
      return { id: abs, name, size: bytes.byteLength, mtime: Date.now() }
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

    window: makeWindowControls(),
  }
}
