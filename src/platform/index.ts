/**
 * 平台分发。按运行环境惰性加载对应实现，Tauri 模块在浏览器下不会被求值。
 */
import type { FileRef, Platform, PlatformKind, PlayerCommand } from "./types"

export type { FileRef, Platform, PlatformKind, PlayerCommand, WindowControls } from "./types"
export { AUDIO_EXTENSIONS, isAudioFile } from "./types"

export const IS_TAURI: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

let cached: Promise<Platform> | null = null

function impl(): Promise<Platform> {
  if (!cached) {
    cached = IS_TAURI
      ? import("./tauri").then((m) => m.create())
      : import("./browser").then((m) => m.create())
  }
  return cached
}

export const platform = {
  kind: (IS_TAURI ? "tauri" : "browser") as PlatformKind,

  pickAudioFiles: (): Promise<FileRef[]> => impl().then((p) => p.pickAudioFiles()),
  pickAudioFolder: (): Promise<FileRef[]> => impl().then((p) => p.pickAudioFolder()),
  pickImage: (): Promise<FileRef | null> => impl().then((p) => p.pickImage()),

  readFile: (ref: FileRef): Promise<Uint8Array> => impl().then((p) => p.readFile(ref)),

  readConfig: <T>(name: string): Promise<T | null> => impl().then((p) => p.readConfig<T>(name)),
  writeConfig: <T>(name: string, value: T): Promise<void> =>
    impl().then((p) => p.writeConfig(name, value)),

  onFileDrop: (handler: (files: FileRef[]) => void): (() => void) => {
    let dispose: (() => void) | null = null
    let cancelled = false
    void impl().then((p) => {
      if (cancelled) return
      dispose = p.onFileDrop(handler)
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  },

  onCommand: (handler: (cmd: PlayerCommand) => void): (() => void) => {
    let dispose: (() => void) | null = null
    let cancelled = false
    void impl().then((p) => {
      if (cancelled) return
      dispose = p.onCommand(handler)
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  },

  readCache: (key: string): Promise<Uint8Array | null> => impl().then((p) => p.readCache(key)),
  writeCache: (key: string, data: Uint8Array): Promise<void> =>
    impl().then((p) => p.writeCache(key, data)),

  window: {
    minimize: () => impl().then((p) => p.window.minimize()),
    toggleMaximize: () => impl().then((p) => p.window.toggleMaximize()),
    close: () => impl().then((p) => p.window.close()),
    setFullscreen: (on: boolean) => impl().then((p) => p.window.setFullscreen(on)),
    isFullscreen: () => impl().then((p) => p.window.isFullscreen()),
  },
}

/**
 * 从 FileRef 造一个可直接喂给 <audio>/<img> 的 object URL。
 *
 * 注意这里刻意不用 Tauri 的 convertFileSrc —— 它产生的是跨源 URL，
 * createMediaElementSource 会污染音频图，getByteFrequencyData() 将恒返回全 0
 * 且不报任何错。Blob 是同源的，分析器一定能工作。
 *
 * 调用方负责在不用时调 URL.revokeObjectURL，否则就是稳定的内存泄漏。
 */
export async function toObjectUrl(ref: FileRef, mime?: string): Promise<string> {
  const bytes = await platform.readFile(ref)
  return URL.createObjectURL(new Blob([bytes as BlobPart], mime ? { type: mime } : undefined))
}
