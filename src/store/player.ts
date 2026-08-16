import { create } from "zustand"

import { platform } from "@/platform"
import { engine, type EngineStatus } from "@/audio/engine"
import { loadPeaks } from "@/audio/peaks"
import { useLibrary, type Track } from "./library"
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
  peaks: Float32Array | null

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
 * 报给系统媒体面板。切歌、播放/暂停时调用。
 *
 * @param force 封面是异步解出来的，解完要再报一次，这时曲目与状态都没变，
 *              必须绕过去重判断，否则任务栏那格永远是空的
 */
function pushNowPlaying(
  track: Track | null,
  playing: boolean,
  position: number,
  force = false,
): void {
  if (!track) return
  // 只在曲目或播放状态变了时才重报；位置每秒变四次，跟着报纯属浪费 IPC
  const key = `${track.id}|${playing}`
  if (!force && key === smtcKey) return
  smtcKey = key

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
    peaks: null,

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
        pushNowPlaying(get().current(), engine.status === "playing", t, true)
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
      set({ index: i, peaks: null })
      resetPlayCounter()

      try {
        const bytes = await engine.load(track.ref)
        consecutiveErrors = 0
        await engine.play()
        save()

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
            pushNowPlaying(get().current(), engine.status === "playing", engine.currentTime, true)
          }
        })

        pushNowPlaying(track, true, 0)

        // 波形不阻塞播放
        const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200))
        idle(() => {
          void loadPeaks(track.ref, bytes)
            .then((p) => {
              if (get().index === i) set({ peaks: p })
            })
            .catch(() => {})
        })
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
      set({ queue: [], index: -1, peaks: null })
    },

    refreshQueueMeta() {
      const lib = useLibrary.getState()
      set((s) => ({
        queue: s.queue.map((q) => {
          const t = lib.byId(q.id)
          return t ? { ...q, lyrics: t.lyrics ?? q.lyrics, cover: t.cover ?? q.cover, liked: t.liked } : q
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
