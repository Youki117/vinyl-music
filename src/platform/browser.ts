/**
 * 浏览器实现 —— 纯开发用途，让 M1~M3 可以脱离 Tauri 迭代。
 *
 * 与 Tauri 版的能力差异（有意为之，不视为缺陷）：
 *  - 没有真实文件路径，File 对象只活在本次会话，刷新页面后曲库需重新导入。
 *  - 缓存只在内存里，不落盘。
 *  - 窗口控制是空操作。
 */
import type { FileRef, Platform, WindowControls } from "./types"
import { isAudioFile } from "./types"

/** id -> File。浏览器下没有路径，用这张表把 FileRef 还原成 File。 */
const handles = new Map<string, File>()
const memCache = new Map<string, Uint8Array>()

let seq = 0

function toRef(file: File): FileRef {
  const id = `blob:${++seq}:${file.name}`
  handles.set(id, file)
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

    input.addEventListener("change", () => finish(Array.from(input.files ?? [])))
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
}

export function create(): Platform {
  return {
    kind: "browser",

    async pickAudioFiles() {
      const files = await openPicker({ accept: "audio/*", multiple: true })
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

    onCommand() {
      // 浏览器下没有媒体键与托盘。Media Session API 只在有音频播放时才有意义，
      // 开发路径用不上，留空即可。
      return () => {}
    },

    window: windowControls,
  }
}
