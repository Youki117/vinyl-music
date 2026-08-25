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

  /**
   * 读取文件的一段字节。越过文件尾时返回实际能读到的部分，不报错。
   *
   * 导入只为读标签，却要把整首无损搬过 IPC —— 这是导入耗时与内存峰值的大头。
   * 元数据解析走 audio/metadata.ts 的 SliceTokenizer，按需取片，
   * 通常一首歌只读头部一片；ogg 求时长时会再取一片尾部。
   */
  readSlice(ref: FileRef, offset: number, length: number): Promise<Uint8Array>

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

  /**
   * 选一个音源脚本（.js）。用户取消返回 null。
   *
   * 音源脚本不随应用分发（见 src/source/builtin/README.md），所以必须给用户
   * 一条自己放进来的路。
   */
  pickScript(): Promise<FileRef | null>

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
   * 外壳交进来的文件：命令行参数、「打开方式」、拖到 exe 图标上。
   * 浏览器实现下永不触发。
   */
  onOpenFiles(handler: (paths: string[]) => void): () => void

  /**
   * 发外部 HTTP 请求。
   *
   * Tauri 下走 plugin-http 由 Rust 转发：OpenAI 兼容的服务基本不给浏览器来源发
   * CORS 头，从 WebView 直接 fetch 会被拦；而且外部域名也过不了 CSP。
   */
  request(url: string, init: RequestInit): Promise<Response>

  /**
   * 列出本机 Wallpaper Engine 的壁纸（工坊 + 本地项目）。
   * 没装 Steam/WE 时返回空数组。浏览器实现下恒为空。
   */
  listWallpaperEngine(): Promise<WeWallpaper[]>

  /**
   * 把生成的图片存进应用数据目录，返回可当底图用的引用。
   */
  saveImage(name: string, bytes: Uint8Array): Promise<FileRef>

  /**
   * 列出 saveImage 写出去的文件，按文件名前缀筛。
   *
   * 存在的理由只有一个：账本与磁盘会对不上。图片先落盘、账本走防抖，中间崩一次
   * 就留下一个谁也不认识的文件。没有这个方法，面板上那句"已用 320MB"就只是
   * 账本的自述，不是磁盘的实情。
   */
  listImages(prefix: string): Promise<FileRef[]>

  /**
   * 删除应用自己写出去的文件（封面副本、AI 生成图）。
   * **只用于应用数据目录内的文件**，不碰用户的音乐库。
   */
  removeFile(path: string): Promise<void>

  readonly window: WindowControls
}

export type PlayerCommand = "toggle" | "pause" | "next" | "prev"

/** 一个 Wallpaper Engine 壁纸的元信息。media 只有 video/image 类型才有。 */
export type WeWallpaper = {
  /** 工坊 id，或 my: 前缀的本地项目目录名 */
  id: string
  title: string
  type: "video" | "image" | "scene" | "web" | "application" | "unknown"
  /** 可直接当底图的主文件绝对路径（video/image） */
  media: string | null
  /** 预览图绝对路径 */
  preview: string | null
}

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
  /**
   * 迷你模式的**全部**窗口动作，一次做完：尺寸、可否缩放、置顶、最小尺寸下限。
   *
   * 刻意做成一个方法而不是暴露四个原语 —— 这四件事必须一起变，顺序也讲究
   * （先放开最小尺寸下限才缩得下去）。拆开给上层，上层迟早会漏掉一个。
   *
   * `setMini(false)` 是**幂等**的，可以在启动时无条件调一次：窗口状态插件会把
   * 上次退出时的尺寸恢复回来，万一上次是在迷你模式里退的，这一下就把它救回来。
   */
  setMini(on: boolean): Promise<void>
}

/** 受支持的音频扩展名，不含点号，全小写。 */
export const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"] as const

/** 外挂歌词扩展名 */
export const LYRIC_EXTENSIONS = ["lrc"] as const

/** 播放列表扩展名 */
export const PLAYLIST_EXTENSIONS = ["m3u", "m3u8"] as const

/** 音源脚本扩展名 */
export const SCRIPT_EXTENSIONS = ["js"] as const

/**
 * 可当底图用的图片扩展名。
 *
 * gif 在列表里是因为 Wallpaper Engine 有一批 gif 壁纸（`type: "image"`），而 gif
 * 走的是图片那条路（`<img>` + background-image），Chromium 自己会让它动起来。
 * 代价是它**不受视频底图那两道暂停闸门管**：曲目暂停时 gif 照动。浏览器在标签页
 * 不可见时会自己停掉 gif 动画，所以真正漏掉的只有"暂停音乐"这一种情形。
 */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif"] as const

/**
 * 可当底图用的视频扩展名。
 *
 * 只列 WebView2（Chromium）自带解码器认得的容器 —— mkv、avi 这类即使让用户选进来
 * 也只会得到一块黑屏，不如在选择器里就不出现。mov 属于半通：装 H.264 能放，
 * 装 ProRes 不能，留着是因为能放的那部分占多数。
 */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "mov"] as const

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

export function isImageFile(name: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extOf(name))
}

export function isVideoFile(name: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(extOf(name))
}

/** 能不能当底图。图片和视频都算。 */
export function isBackdropFile(name: string): boolean {
  return isImageFile(name) || isVideoFile(name)
}

/**
 * 视频的 MIME。
 *
 * 必须显式给出：底图走的是 Blob URL，而没有 type 的 Blob 让 Chromium 拿不到
 * Content-Type，`<video>` 会直接判定"没有可用的源"——**不抛错，只是一片空白**。
 * 图片没这个问题（解码器嗅探字节就够），所以只有视频需要这张表。
 */
export function videoMime(name: string): string {
  switch (extOf(name)) {
    case "webm":
      return "video/webm"
    case "mov":
      return "video/quicktime"
    default:
      return "video/mp4"
  }
}
