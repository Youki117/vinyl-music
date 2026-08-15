/**
 * 外壳无关的平台接口。
 *
 * 这是整个前端与 Tauri 之间唯一的接缝：除 src/platform/ 之外，任何文件都不得
 * import @tauri-apps/*。代价是多写一层薄封装，收益是 UI 层与音频层可以直接在
 * 普通浏览器里跑 —— 调蒙版着色器和版式不需要等 Rust 编译。
 */

/** 一个文件的引用。Tauri 下 id 是绝对路径；浏览器下是生成的 uid。 */
export type FileRef = {
  id: string
  name: string
  size: number
  /** 毫秒时间戳。与 size 一起构成缓存键的一部分。 */
  mtime: number
}

export type PlatformKind = "tauri" | "browser"

export interface Platform {
  readonly kind: PlatformKind

  /** 选择若干音频文件。用户取消时返回空数组。 */
  pickAudioFiles(): Promise<FileRef[]>
  /** 选择一个文件夹并递归扫描其中的音频文件。 */
  pickAudioFolder(): Promise<FileRef[]>
  /** 选择一张图片。用户取消时返回 null。 */
  pickImage(): Promise<FileRef | null>

  /** 读取文件全部字节。 */
  readFile(ref: FileRef): Promise<Uint8Array>

  /** 读取一个 JSON 配置。不存在时返回 null。 */
  readConfig<T>(name: string): Promise<T | null>
  /** 写入一个 JSON 配置（实现需保证原子性）。 */
  writeConfig<T>(name: string, value: T): Promise<void>

  /** 读取二进制缓存（波形峰值等）。不存在时返回 null。 */
  readCache(key: string): Promise<Uint8Array | null>
  writeCache(key: string, data: Uint8Array): Promise<void>

  readonly window: WindowControls
}

export interface WindowControls {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  setFullscreen(on: boolean): Promise<void>
  isFullscreen(): Promise<boolean>
}

/** 受支持的音频扩展名，不含点号，全小写。 */
export const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"] as const

export function isAudioFile(name: string): boolean {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return false
  const ext = name.slice(dot + 1).toLowerCase()
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext)
}
