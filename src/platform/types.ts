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

  /** 读取文本文件，自动判码（UTF-8 / GBK / UTF-16）。 */
  readText(ref: FileRef): Promise<string>

  /**
   * 读取与音频同名、只换扩展名的伴随文件（外挂歌词）。不存在返回 null。
   *
   * 网上下到的音频九成没有内嵌歌词，`歌名.lrc` 放在旁边才是通行做法。
   */
  readSidecar(ref: FileRef, ext: string): Promise<string | null>

  /** 选一个播放列表文件（m3u / m3u8）。用户取消返回 null。 */
  pickPlaylistFile(): Promise<FileRef | null>

  /** 弹保存对话框写一个文本文件。用户取消返回 false。 */
  saveText(suggestedName: string, text: string): Promise<boolean>

  /**
   * 把播放列表里的一条路径解析成 FileRef。
   * 相对路径按 baseId 所在目录解析；解析不出或文件不存在时返回 null。
   */
  resolvePath(baseId: string, entry: string): Promise<FileRef | null>

  /**
   * 确保这些路径可读。
   *
   * Tauri 下 fs 有一份静态能力域，只含 $HOME/Music 等标准目录；对话框选中的文件
   * 会被自动放行，拖放的、以及上次存进曲库的则不会。重启后要先把曲库里的路径
   * 重新放行一遍，否则音乐库不在标准目录下的用户会发现整个库都播不了。
   * 浏览器实现下是空操作。
   */
  ensureReadable(paths: string[]): Promise<void>

  /**
   * 把当前播放信息报给系统媒体面板（Windows 上是 SMTC：任务栏缩略图与锁屏
   * 上的那个音乐控件）。浏览器实现下是空操作。
   */
  updateNowPlaying(info: NowPlaying): Promise<void>

  /** 读取一个 JSON 配置。不存在时返回 null。 */
  readConfig<T>(name: string): Promise<T | null>
  /** 写入一个 JSON 配置（实现需保证原子性）。 */
  writeConfig<T>(name: string, value: T): Promise<void>

  /** 读取二进制缓存（波形峰值等）。不存在时返回 null。 */
  readCache(key: string): Promise<Uint8Array | null>
  writeCache(key: string, data: Uint8Array): Promise<void>

  /**
   * 监听拖入窗口的文件。返回取消监听的函数。
   * 只回调音频文件与图片，其余忽略。
   */
  onFileDrop(handler: (files: FileRef[]) => void): () => void

  /**
   * 来自外壳的播放指令：媒体键、托盘菜单、系统媒体面板。
   * 前端只认指令不认来源。
   */
  onCommand(handler: (cmd: PlayerCommand) => void): () => void

  /**
   * 发外部 HTTP 请求。
   *
   * Tauri 下走 plugin-http 由 Rust 转发：OpenAI 兼容的服务基本不给浏览器来源发
   * CORS 头，从 WebView 直接 fetch 会被拦；而且外部域名也过不了 CSP。
   */
  request(url: string, init: RequestInit): Promise<Response>

  /**
   * 把生成的图片存进应用数据目录，返回可当底图用的引用。
   */
  saveImage(name: string, bytes: Uint8Array): Promise<FileRef>

  readonly window: WindowControls
}

export type PlayerCommand = "toggle" | "pause" | "next" | "prev"

/** 报给系统媒体面板的当前曲目信息。时间单位是秒。 */
export type NowPlaying = {
  title: string
  artist: string
  album: string
  playing: boolean
  duration: number
  position: number
  /** 封面文件的绝对路径。系统面板读不了 blob: URL，必须是真实文件。 */
  coverPath: string | null
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

/** 外挂歌词扩展名 */
export const LYRIC_EXTENSIONS = ["lrc"] as const

/** 播放列表扩展名 */
export const PLAYLIST_EXTENSIONS = ["m3u", "m3u8"] as const

function extOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase()
}

export function isAudioFile(name: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extOf(name))
}

export function isLyricFile(name: string): boolean {
  return (LYRIC_EXTENSIONS as readonly string[]).includes(extOf(name))
}

export function isPlaylistFile(name: string): boolean {
  return (PLAYLIST_EXTENSIONS as readonly string[]).includes(extOf(name))
}
