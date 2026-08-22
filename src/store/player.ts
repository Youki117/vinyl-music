import { create } from "zustand"

import { platform } from "@/platform"
import {
  AudioLoadCancelledError,
  engine,
  isAudioLoadCancelled,
  type EngineStatus,
} from "@/audio/engine"
import { clampGainDb, gainDbFor, loadLoudness } from "@/audio/loudness"
import { ensureSource } from "@/source/boot"
import { localRef, useLibrary, type Track } from "./library"
import { ShuffleOrder } from "./shuffle"

export type { Track } from "./library"

/** 列表循环 → 单曲循环 → 随机 → 顺序（播完停止） */
export type RepeatMode = "all" | "one" | "shuffle" | "once"

export const REPEAT_ORDER: RepeatMode[] = ["all", "one", "shuffle", "once"]

export const REPEAT_LABEL: Record<RepeatMode, string> = {
  all: "列表循环",
  one: "单曲循环",
  shuffle: "随机播放",
  once: "顺序播放",
}

export const ONLINE_QUALITY_OPTIONS = [
  { id: "128k", label: "标准", detail: "128 kbps" },
  { id: "320k", label: "高品", detail: "320 kbps" },
  { id: "flac", label: "无损", detail: "FLAC" },
  { id: "flac24bit", label: "Hi-Res", detail: "24-bit FLAC" },
] as const

export type OnlineQuality = (typeof ONLINE_QUALITY_OPTIONS)[number]["id"]

const ONLINE_QUALITY_IDS = new Set<string>(ONLINE_QUALITY_OPTIONS.map((q) => q.id))
const DEFAULT_ONLINE_QUALITY: OnlineQuality = "128k"

/**
 * 全局偏好不等于每首歌都真有这个档位。优先用所选档位；没有时向下取最接近的档位，
 * 再没有才用这首歌声明的最低可用档，避免因为一首歌缺无损就整首无法播放。
 */
export function qualityForTrack(track: Track, preferred: OnlineQuality): OnlineQuality {
  if (track.origin.kind !== "online") return preferred
  const qualities = Array.isArray(track.origin.qualities) ? track.origin.qualities : []
  const available = qualities.filter((q): q is OnlineQuality => ONLINE_QUALITY_IDS.has(q))
  if (available.length === 0 || available.includes(preferred)) return preferred

  const wanted = ONLINE_QUALITY_OPTIONS.findIndex((q) => q.id === preferred)
  for (let i = wanted - 1; i >= 0; i--) {
    const candidate = ONLINE_QUALITY_OPTIONS[i].id
    if (available.includes(candidate)) return candidate
  }
  return ONLINE_QUALITY_OPTIONS.find((q) => available.includes(q.id))?.id ?? preferred
}

const SETTINGS_SCHEMA = 3

type SettingsFile = {
  schemaVersion: number
  volume: number
  mode: RepeatMode
  speed: number
  eqEnabled: boolean
  eqGains: number[]
  lastTrackId: string | null
  /** 输出设备。同一个面板里 EQ 与速度都记，唯独这项不记说不过去。 */
  outputDevice: string
  /** 音量归一化。PRD F7.4 要求默认关闭 */
  normalize: boolean
  /** 在线歌曲的全局首选音质；单曲缺档位时 qualityForTrack 会就近降级。 */
  onlineQuality: OnlineQuality
}

type PlayerState = {
  status: EngineStatus
  error: string | null
  /** 播放队列。与曲库/歌单分离——插播不该改动原歌单 */
  queue: Track[]
  index: number
  duration: number
  volume: number
  muted: boolean
  mode: RepeatMode
  speed: number
  /** 音量归一化开关（F7.4），默认关闭 */
  normalize: boolean
  /** 全局首选音质。 */
  onlineQuality: OnlineQuality
  /** 当前真正载入的在线音质；本地曲目为 null。 */
  activeOnlineQuality: OnlineQuality | null
  qualityStatus: "idle" | "switching" | "error"
  qualityError: string | null
  /**
   * 换片动效的信号。每换一首**并且真的开始出声**时 +1，界面据此放一次唱片淡入。
   * 是个计数器而不是布尔量，因为界面要的是"又发生了一次"，而不是"现在正在放"。
   */
  cue: number

  current(): Track | null
  init(): Promise<void>
  playFrom(tracks: Track[], i: number): Promise<void>
  playAt(i: number): Promise<void>
  /** 插到当前曲目之后，不改动来源歌单 */
  playNext(track: Track): void
  appendToQueue(tracks: Track[]): void
  removeFromQueue(i: number): void
  clearQueue(): void
  /**
   * 从曲库重新取一遍队列里的可变字段（歌词、收藏）。
   * 队列存的是曲目副本，曲库那边改了不会自动传过来。
   */
  refreshQueueMeta(): void

  toggle(): void
  /** 暂停并作废尚未完成的切歌，防止晚到请求重新开声。 */
  pause(): void
  next(auto?: boolean): Promise<void>
  prev(): Promise<void>
  cycleMode(): void
  toggleLike(): void
  setVolume(v: number): void
  toggleMute(): void
  setSpeed(v: number): void
  setNormalize(on: boolean): void
  /** 立即切换当前在线曲目，准备完成后保持原播放位置与播放状态。 */
  setOnlineQuality(quality: OnlineQuality): Promise<void>
  /**
   * 均衡器。开关与增益的权威都在 engine 上（store 不镜像一份），这里存在的
   * 意义是**落盘**：settings 里的 eqEnabled/eqGains 是 save() 从 engine 上读的，
   * 而 save() 只被这几个 setter 触发。界面直接调 engine 的话，改完 EQ 不碰
   * 别的设置就退出，这次调整就丢了。
   */
  setEqEnabled(on: boolean): void
  setEqGains(gains: number[]): void
  /** 切输出设备并落盘。失败时抛，由界面提示。 */
  setOutputDevice(id: string): Promise<void>
}

const shuffle = new ShuffleOrder()

/**
 * 在线曲目的播放与元数据。
 *
 * 音源模块**用到才拉**：它会带起整个 vendored musicSdk、一串 node 垫片，
 * 还有一个跑音源脚本的 Worker。只放本地文件的用户从头到尾用不上这些。
 * 详见 source/boot.ts。
 */
async function onlineModule() {
  return ensureSource()
}

/** Track 的在线来源 → src/source 的 OnlineTrack。两边字段名有出入，转换只此一处。 */
function asOnlineTrack(track: Track) {
  const o = track.origin
  if (o.kind !== "online") return null
  return {
    source: o.source,
    id: o.songId,
    title: track.title,
    artist: track.artist,
    album: track.album,
    // OnlineTrack 的 duration 是平台给的 "mm:ss" 文本，播放路径上用不到
    duration: "",
    qualities: o.qualities,
    raw: o.raw,
  }
}

/** 解析地址 → 取回字节。换源与地址验证都在 resolvePlayUrl 里，这里不重复。 */
async function loadOnline(
  track: Track,
  quality: OnlineQuality,
  stillCurrent: () => boolean,
): Promise<Uint8Array> {
  const online = asOnlineTrack(track)
  if (!online) throw new Error("曲目来源不明")
  const { resolvePlayUrl } = await onlineModule()
  if (!stillCurrent()) throw new AudioLoadCancelledError()
  const { url } = await resolvePlayUrl(online, quality)
  // 地址解析本身也可能很慢。旧请求不能在这里才闯进引擎、反过来取消新歌。
  if (!stillCurrent()) throw new AudioLoadCancelledError()
  return engine.loadUrl(url)
}

/** 只取回字节，不碰 `<audio>`。预取用它 —— 那时当前这首还在放。 */
async function fetchOnlineBytes(track: Track, quality: OnlineQuality): Promise<Uint8Array> {
  const online = asOnlineTrack(track)
  if (!online) throw new Error("曲目来源不明")
  const { resolvePlayUrl } = await onlineModule()
  const { url } = await resolvePlayUrl(online, quality)
  return engine.fetchAudio(url)
}

/**
 * 补齐在线曲目的歌词与封面。**不阻塞播放** —— 声音已经出来了，这两样晚几百毫秒到没关系。
 *
 * @param stillCurrent 回调时先问一句还是不是这一首，切歌快的时候会有过期的结果回来
 */
async function fillOnlineMeta(track: Track, stillCurrent: () => boolean, refresh: () => void) {
  const online = asOnlineTrack(track)
  if (!online) return
  const src = await onlineModule()
  const lib = useLibrary.getState()

  void src
    .resolveLyric(online)
    .then((l) => {
      if (!stillCurrent()) return
      lib.setLyrics(track.id, l.lrc)
      refresh()
    })
    .catch(() => {
      // 没歌词是常态，不该报错打扰
    })

  void src
    .resolveCover(online)
    .then(async (url) => {
      if (!url || !stillCurrent()) return
      await lib.setRemoteCover(track.id, url)
      if (!stillCurrent()) return
      refresh()
    })
    .catch(() => {})
}

/** 曲目的响度缓存键。本地带上大小与修改时间，文件被换掉时缓存自动失效 */
function loudnessKey(track: Track): string {
  const ref = localRef(track)
  return ref ? `${ref.id}|${ref.size}|${ref.mtime}` : track.id
}

/**
 * 对齐这首歌的响度（F7.4）。
 *
 * 标签优先：文件里写着 ReplayGain 就直接用，零成本。没写才自己测 —— 那要解码整首歌，
 * 所以结果落盘缓存，同一个文件只算一次；**测量不挡播放**，声音先出来，量完再用 250ms
 * 的斜坡滑过去（engine.applyNorm）。
 *
 * @param bytes 已经在手上的文件字节；传 null 表示只查缓存不解码
 * @param stillCurrent 回调时先问一句还是不是这一首 —— 测量可能要几百毫秒
 */
async function applyTrackGain(
  track: Track,
  bytes: Uint8Array | null,
  stillCurrent: () => boolean,
): Promise<void> {
  if (!engine.normalize) return

  if (track.gainDb != null) {
    engine.setTrackGainDb(clampGainDb(track.gainDb, track.gainPeak))
    return
  }
  const got = await loadLoudness(loudnessKey(track), bytes)
  if (!got || !stillCurrent()) return
  engine.setTrackGainDb(gainDbFor(got.lufs, got.peak))
}

// ── 预加载下一首（F1.6：切换间隔 < 200ms）────────────────────

/**
 * 预取好的下一首。**只留一首。**
 *
 * 切歌那一刻才开始读文件（Tauri 下还要整个过一遍 IPC）或者才开始解析在线地址并下载，
 * 是切歌延迟里最贵的一块 —— 在线那条动辄一两秒。提前一首把字节拿在手上，
 * 切过去就只剩建 Blob 和等 loadedmetadata。
 *
 * 代价是常驻一份下一首的字节（几 MB 到几十 MB）。留两首就是双倍代价换一个更不准的
 * 猜测：用户按下一首的次数远多于按下下一首。
 */
let prefetched: { id: string; quality: OnlineQuality | null; bytes: Uint8Array } | null = null
/** 预取序号，用来作废在途的过期预取（切歌比下载快时会发生） */
let prefetchSeq = 0
let prefetchTimer = 0

/**
 * 太大的文件不预取。40MB 的无损专辑轨常驻在内存里，为的只是省掉一次读盘 ——
 * 这笔账在 §10 那份内存账单面前划不来。
 */
const PREFETCH_MAX_BYTES = 32 * 1024 * 1024

/**
 * 等这么久再开始预取。
 *
 * 刚起播的那一两秒，在线曲目正在拉歌词和封面、本地曲目正在解封面，
 * 这时候再插一个整文件读取进去，抢的是用户马上就能看见的东西。
 */
const PREFETCH_DELAY_MS = 1500

function dropPrefetch(): void {
  window.clearTimeout(prefetchTimer)
  // 序号一变，在途的那次预取回来时会发现自己已经过期，直接丢掉
  prefetchSeq++
  prefetched = null
}

/**
 * 下一首在队列里的下标。null 表示没有下一首、或者**现在还不知道**。
 *
 * 随机模式走到本轮最后一首时就是"还不知道"：下一轮是那时才洗的。
 * 单曲循环也返回 null —— 下一首就是它自己，字节还在 `<audio>` 里。
 */
function peekNextIndex(): number | null {
  const { queue, index, mode } = usePlayer.getState()
  if (queue.length === 0 || index < 0) return null
  if (mode === "one") return null
  if (mode === "shuffle") return shuffle.peek(queue.length)
  const last = index >= queue.length - 1
  if (last && mode === "once") return null
  return last ? 0 : index + 1
}

async function prefetchNext(): Promise<void> {
  const i = peekNextIndex()
  if (i == null) return
  const track = usePlayer.getState().queue[i]
  if (!track) return
  const ref = localRef(track)
  const quality = ref ? null : qualityForTrack(track, usePlayer.getState().onlineQuality)
  if (prefetched?.id === track.id && prefetched.quality === quality) return

  if (ref && ref.size > PREFETCH_MAX_BYTES) return

  const mine = ++prefetchSeq
  try {
    const bytes = ref ? await platform.readFile(ref) : await fetchOnlineBytes(track, quality!)
    // 切歌比下载快时会走到这里：这份字节已经没人要了，别占着内存
    if (mine !== prefetchSeq || bytes.byteLength > PREFETCH_MAX_BYTES) return
    prefetched = { id: track.id, quality, bytes }

    // 顺带把响度也量出来。测量要解码整首歌（几百毫秒），放在这里意味着下一首
    // 一开声就是对齐的，不用等测量回来再滑一次音量
    if (engine.normalize && track.gainDb == null) {
      void loadLoudness(loudnessKey(track), bytes)
    }
  } catch {
    // 预取失败无所谓：真播到的时候会走正常路径再来一遍，该报的错在那里报
  }
}

function schedulePrefetch(): void {
  window.clearTimeout(prefetchTimer)
  prefetchTimer = window.setTimeout(() => void prefetchNext(), PREFETCH_DELAY_MS)
}

/** 播放计时，用于播放次数的计数规则 */
let playedSec = 0
let lastTime = 0
let counted = false
let consecutiveErrors = 0

/**
 * 播放失败后自动跳下一首的定时器。
 *
 * 本文件里另外三个定时器（save / seek 上报 / 预取）都带句柄且会被取消，唯独这条
 * 早先是撒手不管的：那 2 秒里用户要是自己点了别的歌，孤儿定时器照样触发，
 * 把人家刚选的歌跳掉。连续失败还能叠出好几个，一次跳好几首。
 */
let retryTimer = 0
/**
 * **发声权**代际：只有最后一次用户操作有权开声、报错或安排失败重试。
 *
 * 暂停也会推进它 —— 加载中按暂停，晚回来的那份字节绝不能自己开声（这正是
 * "连点几首再暂停，软件自己响起来并一首几秒地乱跳" 那个 bug 的根）。
 */
let playSeq = 0
/**
 * **当前曲目**代际：只在真的换歌时推进，暂停不推进。
 *
 * 歌词、封面、响度这三样补齐是慢的（在线的要等平台接口），而它们的有效性只取决于
 * "还是不是这首歌"，跟"现在是放着还是停着"无关。早先这三样也挂在 playSeq 上，
 * 于是起播后一两秒内按一下暂停，它们就被永久作废、恢复播放也不会重取。
 */
let trackSeq = 0
/** 音质切换代际：连续点多个档位时只允许最后一次换入音频。 */
let qualitySeq = 0

/**
 * 引擎里**当前真正挂着**的是哪一首。载入失败时为 null。
 *
 * 早先 toggle() 拿 `engine.duration` 是否为 0 来判断"这一首载入过没有"，那是把
 * "引擎里有音频"当成了"引擎里有 index 指向的那首"。两者在载入失败时会脱钩：
 * playAt 先把 index 改成新歌（界面随即显示新歌名），载入失败后引擎里仍是上一首
 * 稳定载入的音频，duration 非 0 —— 于是按播放键放回的是上一首，而歌名显示的是
 * 新那首。音源挂掉时每首都失败，这个 bug 就变成了"永远只播第一首"。
 */
let loadedTrackId: string | null = null

/**
 * 上一次放过换片动效的是哪一首。**动效的节流全靠它 + playSeq，没有别的定时器。**
 *
 * 用户短时间内连点五首歌，会发起五次 playAt，但前四次都在 `mine !== playSeq` 那道
 * 关卡上原地返回（旧的载入还被 AbortController 掐掉了），根本走不到下面记 cue 的
 * 那一行 —— 所以连点多少次，动效都只放最后活下来的那一次。这比"两秒内不重复播"
 * 那类去抖好，因为它不需要猜多快算快：**动效跟着"哪一首真的出声了"走**。
 *
 * 记 id 而不是只记次数，是为了把这几件事挡在外面：切音质（playAt 同一首重跑一遍）、
 * 单曲循环、暂停后继续。它们都不是换片，唱片没离开过唱盘。
 */
let cuedTrackId: string | null = null

/**
 * 连播三首都失败时给用户看的那句话。
 *
 * 早先统一是"连续多首无法播放，已停止" —— 说了等于没说：用户分不清是音源服务端
 * 不给地址、还是本地文件被挪走了，这两件事的处理方式完全不同（前者改代码没用，
 * 等服务端或换音源；后者去找文件）。在线曲目失败时 resolvePlayUrl 抛的错里已经
 * 带着每个平台的失败原因，截一段带出来，至少能看出是哪一类。
 */
function stopReason(track: Track, error: unknown): string {
  if (track.origin.kind !== "online") {
    return "连续多首本地文件无法播放，已停止。文件可能被移动或删除了"
  }
  const detail = error instanceof Error ? error.message : ""
  const head = "连续多首在线歌曲拿不到播放地址，已停止。多为音源服务端的问题，与本机设置无关"
  return detail ? `${head}（${detail.slice(0, 120)}）` : head
}

/** 取消待触发的失败重试。用户自己动了播放，就不该再自动跳。 */
function cancelRetry(): void {
  window.clearTimeout(retryTimer)
  retryTimer = 0
}

function resetPlayCounter(): void {
  playedSec = 0
  lastTime = 0
  counted = false
}

let saveTimer = 0

/** 上一次报给系统媒体面板的曲目与状态，用来判断有没有必要再报一次 */
let smtcKey = ""
/** 曲目 id → 封面文件路径。由 library.ensureCover 落盘后回填。 */
const coverPaths = new Map<string, string>()

/**
 * 上报原因。三种情况对去重与节流的要求不一样，用一个 boolean 的 force 区分不开：
 *
 * - `state` 切歌、播放/暂停：按 曲目|状态 去重，位置每秒变四次不该跟着报
 * - `cover` 封面异步解出来后补报：曲目与状态都没变，必须绕过去重，否则任务栏那格
 *   永远是空的。频率极低，直发
 * - `seek`  跳转：也要绕过去重（否则面板位置停在旧值直到下次暂停或切歌），但拖进度条
 *   时每个 pointermove 都会触发一次，直发等于几秒内上百次 IPC 打进 COM，必须节流
 */
type PushReason = "state" | "cover" | "seek"

/** 拖动时的上报间隔。给足平滑感，又不至于把 IPC 打爆 */
const SEEK_PUSH_MS = 250
let seekTimer = 0
let seekPending: { track: Track; playing: boolean; position: number } | null = null

function sendNowPlaying(track: Track, playing: boolean, position: number): void {
  smtcKey = `${track.id}|${playing}`
  void platform.updateNowPlaying({
    title: track.title,
    artist: track.artist,
    album: track.album,
    playing,
    duration: track.duration || engine.duration,
    position,
    coverPath: coverPaths.get(track.id) ?? null,
  })
}

/** 报给系统媒体面板。 */
function pushNowPlaying(
  track: Track | null,
  playing: boolean,
  position: number,
  reason: PushReason = "state",
): void {
  if (!track) return

  if (reason === "seek") {
    // 首尾都发：首帧让面板立刻跟上，尾帧保证松手后的最终位置一定落地 ——
    // 只做前沿节流的话，拖完停在哪儿面板是不知道的
    seekPending = { track, playing, position }
    if (seekTimer) return
    seekPending = null
    sendNowPlaying(track, playing, position)
    seekTimer = window.setTimeout(() => {
      seekTimer = 0
      const p = seekPending
      seekPending = null
      if (p) sendNowPlaying(p.track, p.playing, p.position)
    }, SEEK_PUSH_MS)
    return
  }

  if (reason === "state" && `${track.id}|${playing}` === smtcKey) return
  sendNowPlaying(track, playing, position)
}

export const usePlayer = create<PlayerState>((set, get) => {
  const save = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const s = get()
      const file: SettingsFile = {
        schemaVersion: SETTINGS_SCHEMA,
        volume: s.volume,
        mode: s.mode,
        speed: s.speed,
        eqEnabled: engine.eqEnabled,
        eqGains: engine.eqGains,
        lastTrackId: s.current()?.id ?? null,
        outputDevice: engine.outputDevice,
        normalize: s.normalize,
        onlineQuality: s.onlineQuality,
      }
      void platform.writeConfig("settings", file)
    }, 1000)
  }

  return {
    status: "empty",
    error: null,
    queue: [],
    index: -1,
    duration: 0,
    volume: 0.8,
    muted: false,
    mode: "all",
    speed: 1,
    normalize: false,
    onlineQuality: DEFAULT_ONLINE_QUALITY,
    activeOnlineQuality: null,
    qualityStatus: "idle",
    qualityError: null,
    cue: 0,

    current() {
      const { queue, index } = get()
      return index >= 0 && index < queue.length ? queue[index] : null
    },

    async init() {
      engine.onStatus((status, error) => {
        set({ status, error })
        pushNowPlaying(get().current(), status === "playing", engine.currentTime)
      })

      // 跳转不改变播放状态，不在这里补一刀的话，系统媒体面板的位置会一直停在
      // 旧值，直到下次暂停或切歌
      engine.onSeek((t) => {
        pushNowPlaying(get().current(), engine.status === "playing", t, "seek")
      })

      engine.onProgress((t, d) => {
        set((s) => (s.duration === d ? s : { ...s, duration: d }))

        // 播放次数：累计真实听到的时长超过曲目 50% 或 30 秒（取较小者）才计一次。
        // 跳转产生的大跨度增量不计入——拖着进度条从头拉到尾不该算听完一遍。
        if (engine.status !== "playing") return
        const delta = t - lastTime
        if (delta > 0 && delta < 1) playedSec += delta
        lastTime = t

        const track = get().current()
        if (counted || !track) return
        const need = Math.min(track.duration * 0.5, 30)
        if (need > 0 && playedSec >= need) {
          counted = true
          useLibrary.getState().recordPlay(track.id)
        }
      })

      engine.onEnded = () => {
        // 睡眠定时器设了「播完当前曲目再停」
        if (engine.consumeSleepPending()) {
          engine.pause()
          return
        }
        if (get().mode === "one") {
          engine.seek(0)
          void engine.play()
          resetPlayCounter()
        } else {
          void get().next(true)
        }
      }

      // 曲库读失败不该让整个启动流程断在这里 —— 后面还有音量、均衡器、
      // 上次曲目要恢复，界面也还等着这段跑完
      await useLibrary
        .getState()
        .load()
        .catch((e) => console.error("曲库载入失败", e))

      const s = await platform.readConfig<SettingsFile>("settings")
      if (s) {
        set({
          volume: s.volume ?? 0.8,
          mode: s.mode ?? "all",
          speed: s.speed ?? 1,
          normalize: s.normalize ?? false,
          onlineQuality: ONLINE_QUALITY_IDS.has(s.onlineQuality)
            ? s.onlineQuality
            : DEFAULT_ONLINE_QUALITY,
        })
        engine.setNormalize(s.normalize ?? false)
        engine.setVolume(s.volume ?? 0.8)
        engine.setSpeed(s.speed ?? 1)
        if (s.eqGains?.length) engine.setEqGains(s.eqGains)
        if (s.eqEnabled) engine.setEqEnabled(true)
        // 设备可能已经拔了，setSinkId 会抛，吞掉退回系统默认即可
        if (s.outputDevice) {
          void engine.setOutputDevice(s.outputDevice).catch(() => {})
        }
      }

      // 恢复上次的队列：用当前视图，定位到上次那首
      const tracks = useLibrary.getState().visible()
      if (tracks.length > 0) {
        const i = s?.lastTrackId ? tracks.findIndex((t) => t.id === s.lastTrackId) : 0
        set({ queue: tracks, index: i >= 0 ? i : 0 })
      }
    },

    async playFrom(tracks, i) {
      set({ queue: tracks, index: i })
      if (get().mode === "shuffle") shuffle.reshuffle(tracks.length, null)
      await get().playAt(i)
    },

    async playAt(i) {
      const { queue } = get()
      if (i < 0 || i >= queue.length) return
      const track = queue[i]
      const mine = ++playSeq
      // 换歌才作废元数据补齐；同一首歌上的暂停/继续不该把在途的歌词封面丢掉
      const mineTrack = ++trackSeq
      qualitySeq++
      cancelRetry()
      // 先停旧声音，再更新界面；加载期间绝不能还放着上一首。
      engine.pause()
      // 从这一刻起引擎里那首就不作数了：界面已经指向新歌，旧音频不该再被当成"已载入"
      loadedTrackId = null
      const onlineQuality = qualityForTrack(track, get().onlineQuality)
      set({
        index: i,
        activeOnlineQuality: null,
        qualityStatus: "idle",
        qualityError: null,
      })
      resetPlayCounter()
      // 上一首的归一化增益必须显式清掉，否则会留在节点上加到这一首头上
      engine.setTrackGainDb(0)

      // 预取命中就直接用手上的字节。必须在 dropPrefetch 之前取走
      const ready =
        prefetched?.id === track.id &&
        (track.origin.kind === "local" || prefetched.quality === onlineQuality)
          ? prefetched.bytes
          : null
      dropPrefetch()

      try {
        const ref = localRef(track)
        let bytes: Uint8Array
        if (ready) {
          await engine.loadBytes(ready)
          bytes = ready
        } else {
          bytes = ref
            ? await engine.load(ref)
            : await loadOnline(track, onlineQuality, () => mine === playSeq)
        }
        if (mine !== playSeq) return
        consecutiveErrors = 0
        loadedTrackId = track.id
        await engine.play()
        if (mine !== playSeq) return
        // 走到这里意味着：这次 playAt 没被后面的操作顶掉，且声音已经出来了。
        // 换片动效只认这一刻 —— 理由见 cuedTrackId 上面那段
        const changedTrack = cuedTrackId !== track.id
        cuedTrackId = track.id
        set({
          activeOnlineQuality: ref ? null : onlineQuality,
          qualityStatus: "idle",
          qualityError: null,
          cue: changedTrack ? get().cue + 1 : get().cue,
        })
        save()

        // 响度对齐。标签命中是同步的，测量那条要解码整首歌，所以不 await ——
        // 声音先出来，量完再用斜坡滑过去
        void applyTrackGain(track, bytes, () => mineTrack === trackSeq && get().index === i)

        // 把下一首提前拿到手上（F1.6）。延后一点点开始，别和刚起播时的封面歌词抢
        schedulePrefetch()

        if (ref) {
          // 曲库落盘时不存歌词正文与封面，重启后要在这里补回来。
          // 封面直接从已经读进内存的字节里解，不再多读一次盘。
          const lib = useLibrary.getState()
          void Promise.all([
            lib.ensureLyrics(track.id).catch(() => null),
            lib.ensureCover(track.id, bytes).catch(() => null),
          ]).then(([lrc, cover]) => {
            if (mineTrack !== trackSeq || get().index !== i) return
            if (lrc || cover) get().refreshQueueMeta()
            // 封面要等解出来、落盘之后才报给系统媒体面板，否则任务栏那格是空的
            if (cover?.path) {
              coverPaths.set(track.id, cover.path)
              pushNowPlaying(get().current(), engine.status === "playing", engine.currentTime, "cover")
            }
          })
        } else {
          /*
           * 在线曲目**播了才入库**。搜索结果整页塞进「全部音乐」是污染，但真播出声的
           * 这首必须在库里 —— 下面 fillOnlineMeta 写回的歌词封面、以及收藏与播放统计，
           * 全都按曲库里的 id 存，不在库里它们会静默地什么都不做（setRemoteCover
           * 开头那句 byId 检查就直接 return 了）。
           */
          useLibrary.getState().addTracks([track])
          // 在线曲目的歌词与封面来自平台接口，和本地那条路完全不同
          void fillOnlineMeta(
            track,
            () => mineTrack === trackSeq && get().index === i,
            () => get().refreshQueueMeta(),
          )
        }

        pushNowPlaying(track, true, 0)

        // 这里原本还会顺手算一遍波形峰值缓存起来。进度条上方那段小波形删掉之后，
        // 播放路径已经没人要这份数据了 —— 而算它要把整首歌解码一遍（约 16MB PCM）。
        // 混音面板仍然用得上波形，但它自己会惰性取（audio/peaks.ts 的 loadPeaks
        // 支持传取字节的函数，缓存命中时连文件都不读）。
      } catch (error) {
        // 新的切歌或暂停主动取代了它：不是坏文件，不能标丢失或自动跳下一首。
        if (mine !== playSeq || isAudioLoadCancelled(error)) return
        set({
          qualityStatus: track.origin.kind === "online" ? "error" : "idle",
          qualityError:
            track.origin.kind === "online"
              ? error instanceof Error
                ? error.message
                : "音质载入失败"
              : null,
        })
        useLibrary.getState().markMissing(track.id)
        // 连续 3 首失败则停止，避免整个列表都坏时无限跳转
        if (++consecutiveErrors >= 3) {
          consecutiveErrors = 0
          set({ status: "error", error: stopReason(track, error) })
          return
        }
        retryTimer = window.setTimeout(() => {
          retryTimer = 0
          // 这 2 秒里用户可能已经自己点了别的歌。文件里其它异步回调都用
          // `get().index === i` 守着代际，这条也一样：还停在出错这首上才继续跳
          if (get().index !== i) return
          void get().next(true)
        }, 2000)
      }
    },

    playNext(track) {
      set((s) => {
        const q = s.queue.filter((t) => t.id !== track.id)
        const at = Math.min(q.length, s.index + 1)
        q.splice(at, 0, track)
        return { queue: q, index: s.index }
      })
      // 下一首换人了，之前预取的那份已经不是下一首
      dropPrefetch()
      schedulePrefetch()
    },

    appendToQueue(tracks) {
      set((s) => {
        const have = new Set(s.queue.map((t) => t.id))
        return { queue: [...s.queue, ...tracks.filter((t) => !have.has(t.id))] }
      })
    },

    removeFromQueue(i) {
      set((s) => {
        const q = s.queue.filter((_, k) => k !== i)
        let index = s.index
        if (i < s.index) index--
        else if (i === s.index) index = Math.min(index, q.length - 1)
        return { queue: q, index }
      })
    },

    clearQueue() {
      get().pause()
      dropPrefetch()
      // 队列空了，引擎里那首也不再属于任何一行
      loadedTrackId = null
      cuedTrackId = null
      set({ queue: [], index: -1 })
    },

    /**
     * 队列里刻意**不**同步封面：封面的唯一来源是曲库（Disc 按曲目 id 直接从那里读）。
     * 队列再存一份的话，曲库那边按 LRU 淘汰并 revoke 之后，这份副本就成了指向死
     * URL 的悬空引用，唱片贴纸会变成一个裂图。
     */
    refreshQueueMeta() {
      const lib = useLibrary.getState()
      set((s) => ({
        queue: s.queue.map((q) => {
          const t = lib.byId(q.id)
          return t ? { ...q, lyrics: t.lyrics ?? q.lyrics, liked: t.liked } : q
        }),
      }))
    },

    toggle() {
      const { index, queue } = get()
      if (queue.length === 0) return
      // 出错后手动暂停，不该在 2 秒后被自动跳转唤醒
      cancelRetry()
      if (get().status === "loading") {
        get().pause()
        return
      }
      if (index < 0) {
        void get().playAt(0)
        return
      }
      /*
       * 引擎里挂着的**不是**当前选中这一首，就重新载入而不是直接开声。
       *
       * 判据必须是"引擎里是哪一首"，不能是 `engine.duration` 是否为 0：后者只说明
       * 引擎里有音频，不说明那是 index 指向的那首。载入失败时两者会脱钩，于是
       * 按播放键放回上一首、歌名却显示新那首（音源挂掉时表现为"永远只播第一首"）。
       */
      if (loadedTrackId !== queue[index]?.id) {
        void get().playAt(index)
        return
      }
      if (engine.status === "playing") get().pause()
      else void engine.play()
    },

    pause() {
      playSeq++
      qualitySeq++
      cancelRetry()
      engine.pause()
      set((s) => (s.qualityStatus === "switching" ? { qualityStatus: "idle" } : s))
    },

    async next(auto = false) {
      const { queue, index, mode } = get()
      if (queue.length === 0) return

      if (mode === "shuffle") {
        shuffle.advance(queue.length)
        await get().playAt(shuffle.current)
        return
      }

      const last = index >= queue.length - 1
      if (last && mode === "once" && auto) {
        engine.pause()
        return
      }
      await get().playAt(last ? 0 : index + 1)
    },

    async prev() {
      const { queue, index, mode } = get()
      if (queue.length === 0) return
      // 播放超过 3 秒时先回到本曲开头，这是播放器的通行行为
      if (engine.currentTime > 3) {
        engine.seek(0)
        return
      }
      if (mode === "shuffle") {
        shuffle.back()
        await get().playAt(shuffle.current)
        return
      }
      await get().playAt(index <= 0 ? queue.length - 1 : index - 1)
    },

    cycleMode() {
      const i = REPEAT_ORDER.indexOf(get().mode)
      const mode = REPEAT_ORDER[(i + 1) % REPEAT_ORDER.length]
      set({ mode })
      if (mode === "shuffle") shuffle.reshuffle(get().queue.length, get().index)
      save()
    },

    toggleLike() {
      const t = get().current()
      if (!t) return
      useLibrary.getState().toggleLike(t.id)
      // 队列里的副本也要跟着变，否则红心不亮
      set((s) => ({
        queue: s.queue.map((q) => (q.id === t.id ? { ...q, liked: !q.liked } : q)),
      }))
    },

    setVolume(v) {
      set({ volume: v, muted: false })
      engine.setVolume(v)
      engine.setMuted(false)
      save()
    },

    toggleMute() {
      const m = !get().muted
      set({ muted: m })
      engine.setMuted(m)
    },

    setSpeed(v) {
      set({ speed: v })
      engine.setSpeed(v)
      save()
    },

    setEqEnabled(on) {
      engine.setEqEnabled(on)
      save()
    },

    setEqGains(gains) {
      engine.setEqGains(gains)
      save()
    },

    setNormalize(on) {
      set({ normalize: on })
      engine.setNormalize(on)
      // 打开时把当前这首也对齐上，别等到下一首。字节已经不在手上了，所以只查缓存 ——
      // 为一个开关重新解码整首歌不值得（loadLoudness 的 bytes 传 null 就是这个意思）
      const t = get().current()
      if (on && t) void applyTrackGain(t, null, () => get().current()?.id === t.id)
      else if (!on) engine.setTrackGainDb(0)
      save()
    },

    async setOnlineQuality(quality) {
      if (!ONLINE_QUALITY_IDS.has(quality)) return
      set({ onlineQuality: quality, qualityError: null })
      save()
      dropPrefetch()

      const track = get().current()
      if (!track || track.origin.kind !== "online") {
        set({ qualityStatus: "idle", activeOnlineQuality: null })
        schedulePrefetch()
        return
      }

      const effective = qualityForTrack(track, quality)
      if (effective === get().activeOnlineQuality && get().status !== "loading") {
        set({ qualityStatus: "idle" })
        schedulePrefetch()
        return
      }

      // 正在首次载入时没有可保留的进度，直接用新偏好重走当前曲目最干净。
      if (get().status === "loading") {
        await get().playAt(get().index)
        return
      }

      const mine = ++qualitySeq
      const trackId = track.id
      let previousBytes: Uint8Array | null = null
      let position = 0
      let shouldResume = false
      let loop: { a: number | null; b: number | null } = { a: null, b: null }
      set({ qualityStatus: "switching", qualityError: null })

      try {
        // 下载阶段不碰引擎，让旧音质继续播放；只有完整字节准备好才原子换入。
        const bytes = await fetchOnlineBytes(track, effective)
        if (mine !== qualitySeq || get().current()?.id !== trackId) return

        /*
         * 真正换入前留一份临时回滚副本。下载失败时完全不会走到这里，旧音频继续播放；
         * 新字节万一解码失败，也能把旧音质放回原进度，而不是突然静音。
         *
         * **代价：这一小段里内存同时压着新旧两份完整音频**，Hi-Res 切换时峰值约为
         * 单曲体积的两倍（PRD 的播放峰值指标按 524MB 记）。所以副本只在"下载已成功、
         * 马上要换入"这一刻才取，换入成功后立刻撒手，不让它活到 pushNowPlaying 之后。
         */
        previousBytes = await engine.copyLoadedBytes()
        if (mine !== qualitySeq || get().current()?.id !== trackId) return
        position = engine.currentTime
        shouldResume = engine.status === "playing"
        loop = engine.loop
        playSeq++
        cancelRetry()

        await engine.loadBytes(bytes)
        if (mine !== qualitySeq || get().current()?.id !== trackId) return
        engine.seekSeconds(position)
        engine.setLoop(loop.a, loop.b)
        if (shouldResume) await engine.play()
        if (mine !== qualitySeq || get().current()?.id !== trackId) return

        // 新音质已经稳定发声，回滚副本再无用处：立刻撒手，别让它多活一次事件循环
        previousBytes = null

        set({
          activeOnlineQuality: effective,
          qualityStatus: "idle",
          qualityError: null,
        })
        pushNowPlaying(track, shouldResume, position, "seek")
        schedulePrefetch()
      } catch (error) {
        if (mine !== qualitySeq || isAudioLoadCancelled(error)) return
        if (previousBytes && get().current()?.id === trackId) {
          try {
            await engine.loadBytes(previousBytes)
            if (mine !== qualitySeq || get().current()?.id !== trackId) return
            engine.seekSeconds(position)
            engine.setLoop(loop.a, loop.b)
            if (shouldResume) await engine.play()
          } catch {
            // 回滚也失败时保留原始切换错误；engine 会把真实解码错误同步到播放器状态。
          }
        }
        set({
          qualityStatus: "error",
          qualityError: error instanceof Error ? error.message : "音质切换失败",
        })
      }
    },

    async setOutputDevice(id) {
      await engine.setOutputDevice(id)
      save()
    },
  }
})

export { compactCount, formatTime } from "@/lib/format"
