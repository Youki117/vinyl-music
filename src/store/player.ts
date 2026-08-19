import { create } from "zustand"

import { platform } from "@/platform"
import { engine, type EngineStatus } from "@/audio/engine"
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

const SETTINGS_SCHEMA = 1

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
  next(auto?: boolean): Promise<void>
  prev(): Promise<void>
  cycleMode(): void
  toggleLike(): void
  setVolume(v: number): void
  toggleMute(): void
  setSpeed(v: number): void
  /** 切输出设备并落盘。失败时抛，由界面提示。 */
  setOutputDevice(id: string): Promise<void>
}

const shuffle = new ShuffleOrder()

/**
 * 在线曲目的播放与元数据。
 *
 * `@/source` 一律**动态引入**：它会拉起整个 vendored musicSdk（几百 KB），
 * 只放本地文件的用户不该为此付出加载成本 —— App.tsx 里也是这么处理的。
 */
async function onlineModule() {
  return import("@/source")
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
async function loadOnline(track: Track): Promise<Uint8Array> {
  const online = asOnlineTrack(track)
  if (!online) throw new Error("曲目来源不明")
  const { resolvePlayUrl } = await onlineModule()
  const { url } = await resolvePlayUrl(online, DEFAULT_ONLINE_QUALITY)
  return engine.loadUrl(url)
}

/** 在线曲目播放音质。音源脚本对各平台声明的档位不一，128k 是唯一五平台都有的。 */
const DEFAULT_ONLINE_QUALITY = "128k"

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

/** 播放计时，用于播放次数的计数规则 */
let playedSec = 0
let lastTime = 0
let counted = false
let consecutiveErrors = 0

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
        set({ volume: s.volume ?? 0.8, mode: s.mode ?? "all", speed: s.speed ?? 1 })
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
      set({ index: i })
      resetPlayCounter()

      try {
        const ref = localRef(track)
        const bytes = ref ? await engine.load(ref) : await loadOnline(track)
        consecutiveErrors = 0
        await engine.play()
        save()

        if (ref) {
          // 曲库落盘时不存歌词正文与封面，重启后要在这里补回来。
          // 封面直接从已经读进内存的字节里解，不再多读一次盘。
          const lib = useLibrary.getState()
          void Promise.all([
            lib.ensureLyrics(track.id).catch(() => null),
            lib.ensureCover(track.id, bytes).catch(() => null),
          ]).then(([lrc, cover]) => {
            if (get().index !== i) return
            if (lrc || cover) get().refreshQueueMeta()
            // 封面要等解出来、落盘之后才报给系统媒体面板，否则任务栏那格是空的
            if (cover?.path) {
              coverPaths.set(track.id, cover.path)
              pushNowPlaying(get().current(), engine.status === "playing", engine.currentTime, "cover")
            }
          })
        } else {
          // 在线曲目的歌词与封面来自平台接口，和本地那条路完全不同
          void fillOnlineMeta(track, () => get().index === i, () => get().refreshQueueMeta())
        }

        pushNowPlaying(track, true, 0)

        // 这里原本还会顺手算一遍波形峰值缓存起来。进度条上方那段小波形删掉之后，
        // 播放路径已经没人要这份数据了 —— 而算它要把整首歌解码一遍（约 16MB PCM）。
        // 混音面板仍然用得上波形，但它自己会惰性取（audio/peaks.ts 的 loadPeaks
        // 支持传取字节的函数，缓存命中时连文件都不读）。
      } catch {
        useLibrary.getState().markMissing(track.id)
        // 连续 3 首失败则停止，避免整个列表都坏时无限跳转
        if (++consecutiveErrors >= 3) {
          consecutiveErrors = 0
          set({ status: "error", error: "连续多首无法播放，已停止" })
          return
        }
        window.setTimeout(() => void get().next(true), 2000)
      }
    },

    playNext(track) {
      set((s) => {
        const q = s.queue.filter((t) => t.id !== track.id)
        const at = Math.min(q.length, s.index + 1)
        q.splice(at, 0, track)
        return { queue: q, index: s.index }
      })
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
      engine.pause()
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
      if (index < 0) {
        void get().playAt(0)
        return
      }
      // 队列里选中了曲目但还没真正载入过
      if (!engine.duration) {
        void get().playAt(index)
        return
      }
      engine.toggle()
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

    async setOutputDevice(id) {
      await engine.setOutputDevice(id)
      save()
    },
  }
})

export { compactCount, formatTime } from "@/lib/format"
