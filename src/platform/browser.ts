/**
 * 浏览器实现 —— 纯开发用途，让 M1~M3 可以脱离 Tauri 迭代。
 *
 * 与 Tauri 版的能力差异（有意为之，不视为缺陷）：
 *  - 没有真实文件路径，File 对象只活在本次会话，刷新页面后曲库需重新导入。
 *  - 缓存只在内存里，不落盘。
 *  - 窗口控制是空操作。
 */
import type { FileRef, Platform, WindowControls } from "./types"
import { isAudioFile, PLAYLIST_EXTENSIONS } from "./types"
import { decodeText, stripExt } from "@/lib/text"

/** id -> File。浏览器下没有路径，用这张表把 FileRef 还原成 File。 */
const handles = new Map<string, File>()
/** 文件名（小写）-> File。没有目录概念，只能靠同名来找外挂歌词。 */
const byName = new Map<string, File>()
const memCache = new Map<string, Uint8Array>()

let seq = 0

function toRef(file: File): FileRef {
  const id = `blob:${++seq}:${file.name}`
  handles.set(id, file)
  byName.set(file.name.toLowerCase(), file)
  return { id, name: file.name, size: file.size, mtime: file.lastModified }
}

function openPicker(opts: { accept?: string; multiple?: boolean; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    if (opts.accept) input.accept = opts.accept
    if (opts.multiple) input.multiple = true
    if (opts.directory) {
      // 非标准属性，Chromium 系支持；开发环境够用
      input.setAttribute("webkitdirectory", "")
      input.setAttribute("directory", "")
    }
    input.style.display = "none"
    document.body.appendChild(input)

    // 用户取消时 change 不触发，靠 window focus 兜底，否则 Promise 永远挂着
    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      input.remove()
      window.removeEventListener("focus", onFocus)
      resolve(files)
    }
    const onFocus = () => setTimeout(() => finish([]), 500)

    input.addEventListener("change", () => {
      const picked = Array.from(input.files ?? [])
      // 先全部记名再交给调用方筛选：同一次选中的 .lrc 会被 isAudioFile 滤掉，
      // 但它正是我们找外挂歌词时要查的东西
      for (const f of picked) byName.set(f.name.toLowerCase(), f)
      finish(picked)
    })
    window.addEventListener("focus", onFocus, { once: true })
    input.click()
  })
}

const windowControls: WindowControls = {
  async minimize() {},
  async toggleMaximize() {},
  async close() {},
  async setFullscreen(on) {
    if (on) await document.documentElement.requestFullscreen().catch(() => {})
    else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
  },
  async isFullscreen() {
    return document.fullscreenElement !== null
  },
  // 浏览器里没有窗口可以缩，界面照样会切成迷你版式
  async setMini() {},
}

export function create(): Platform {
  return {
    kind: "browser",

    async pickAudioFiles() {
      // accept 里带上 .lrc，用户可以连歌词一起选进来
      const files = await openPicker({ accept: "audio/*,.lrc", multiple: true })
      return files.filter((f) => isAudioFile(f.name)).map(toRef)
    },

    async pickAudioFolder() {
      const files = await openPicker({ directory: true, multiple: true })
      return files.filter((f) => isAudioFile(f.name)).map(toRef)
    },

    async pickImage() {
      const [file] = await openPicker({ accept: "image/*" })
      return file ? toRef(file) : null
    },

    async readFile(ref) {
      const file = handles.get(ref.id)
      if (!file) throw new Error(`浏览器会话中找不到文件句柄：${ref.name}（刷新页面后需重新导入）`)
      return new Uint8Array(await file.arrayBuffer())
    },

    async readSlice(ref, offset, length) {
      const file = handles.get(ref.id)
      if (!file) throw new Error(`浏览器会话中找不到文件句柄：${ref.name}（刷新页面后需重新导入）`)
      // Blob.slice 自己会把越界的终点夹到文件尾，语义与 Rust 侧一致
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
    },

    async readText(ref) {
      const file = handles.get(ref.id)
      if (!file) throw new Error(`浏览器会话中找不到文件句柄：${ref.name}`)
      return decodeText(new Uint8Array(await file.arrayBuffer()))
    },

    async readSidecar(ref, ext) {
      // 没有目录概念，只能看这次会话里有没有导入过同名的那个文件
      const file = byName.get(`${stripExt(ref.name)}.${ext}`.toLowerCase())
      if (!file) return null
      return decodeText(new Uint8Array(await file.arrayBuffer()))
    },

    async pickPlaylistFile() {
      const [file] = await openPicker({ accept: PLAYLIST_EXTENSIONS.map((e) => `.${e}`).join(",") })
      return file ? toRef(file) : null
    },

    async pickScript() {
      const [file] = await openPicker({ accept: ".js" })
      return file ? toRef(file) : null
    },

    async saveText(suggestedName, text) {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }))
      const a = document.createElement("a")
      a.href = url
      a.download = suggestedName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      return true
    },

    async resolvePath() {
      // 浏览器下没有真实路径，交给调用方按文件名兜底
      return null
    },

    async ensureReadable() {
      // 浏览器没有能力域这回事
    },

    async listImages() {
      // 浏览器下 saveImage 只造了个内存里的 File，磁盘上没有可列的东西
      return []
    },

    async removeFile() {
      // 浏览器下 saveImage 只造了个内存里的 File，没有可删的东西
    },

    async updateNowPlaying() {
      // 浏览器下没有系统媒体面板
    },

    async readConfig<T>(name: string): Promise<T | null> {
      const raw = localStorage.getItem(`vinyl:${name}`)
      if (raw === null) return null
      try {
        return JSON.parse(raw) as T
      } catch {
        return null
      }
    },

    async writeConfig<T>(name: string, value: T) {
      localStorage.setItem(`vinyl:${name}`, JSON.stringify(value))
    },

    async readCache(key) {
      return memCache.get(key) ?? null
    },

    async writeCache(key, data) {
      memCache.set(key, data)
    },

    onFileDrop(handler) {
      const prevent = (e: DragEvent) => e.preventDefault()
      const onDrop = (e: DragEvent) => {
        e.preventDefault()
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (files.length > 0) handler(files.map(toRef))
      }
      window.addEventListener("dragover", prevent)
      window.addEventListener("drop", onDrop)
      return () => {
        window.removeEventListener("dragover", prevent)
        window.removeEventListener("drop", onDrop)
      }
    },

    async request(url, init) {
      // 浏览器开发路径下会受 CORS 限制，属预期行为；正式外壳走 Rust 转发。
      return fetch(url, init)
    },

    async saveImage(name, bytes) {
      const file = new File([bytes as BlobPart], name, { type: "image/png" })
      return toRef(file)
    },

    onOpenFiles() {
      // 浏览器下没有命令行
      return () => {}
    },

    onCommand() {
      // 浏览器下没有媒体键与托盘。Media Session API 只在有音频播放时才有意义，
      // 开发路径用不上，留空即可。
      return () => {}
    },

    window: windowControls,
  }
}
