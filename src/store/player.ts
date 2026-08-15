import { create } from "zustand"

import { platform, type FileRef } from "@/platform"
import { engine, type EngineStatus } from "@/audio/engine"
import { readMetadata } from "@/audio/metadata"
import { loadPeaks } from "@/audio/peaks"
import { ShuffleOrder } from "./shuffle"

export type Track = {
  id: string
  ref: FileRef
  title: string
  artist: string
  album: string
  duration: number
  cover: string | null
  lyrics: string | null
  playCount: number
  liked: boolean
  /** 源文件不存在时标灰 */
  missing: boolean
}

/** 列表循环 → 单曲循环 → 随机 → 顺序（播完停止） */
export type RepeatMode = "all" | "one" | "shuffle" | "once"

export const REPEAT_ORDER: RepeatMode[] = ["all", "one", "shuffle", "once"]

export const REPEAT_LABEL: Record<RepeatMode, string> = {
  all: "列表循环",
  one: "单曲循环",
  shuffle: "随机播放",
  once: "顺序播放",
}

const LIBRARY_SCHEMA = 1

type LibraryFile = {
  schemaVersion: number
  tracks: Array<Pick<Track, "id" | "title" | "artist" | "album" | "duration" | "playCount" | "liked"> & {
    ref: FileRef
  }>
  volume: number
  mode: RepeatMode
  lastId: string | null
}

type PlayerState = {
  status: EngineStatus
  error: string | null
  queue: Track[]
  index: number
  duration: number
  volume: number
  muted: boolean
  mode: RepeatMode
  peaks: Float32Array | null
  scanning: { done: number; total: number } | null

  current(): Track | null
  init(): Promise<void>
  addFiles(refs: FileRef[]): Promise<void>
  playAt(i: number): Promise<void>
  toggle(): void
  next(auto?: boolean): Promise<void>
  prev(): Promise<void>
  cycleMode(): void
  toggleLike(): void
  setVolume(v: number): void
  toggleMute(): void
  removeAt(i: number): void
}

const shuffle = new ShuffleOrder()

/** 播放计时，用于 F9.2 的计数规则 */
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

export const usePlayer = create<PlayerState>((set, get) => {
  const save = () => {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const s = get()
      const file: LibraryFile = {
        schemaVersion: LIBRARY_SCHEMA,
        tracks: s.queue.map((t) => ({
          id: t.id,
          ref: t.ref,
          title: t.title,
          artist: t.artist,
          album: t.album,
          duration: t.duration,
          playCount: t.playCount,
          liked: t.liked,
        })),
        volume: s.volume,
        mode: s.mode,
        lastId: s.current()?.id ?? null,
      }
      void platform.writeConfig("library", file)
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
    peaks: null,
    scanning: null,

    current() {
      const { queue, index } = get()
      return index >= 0 && index < queue.length ? queue[index] : null
    },

    async init() {
      engine.onStatus((status, error) => set({ status, error }))
      engine.onProgress((t, d) => {
        set((s) => (s.duration === d ? s : { ...s, duration: d }))

        // 播放计数：累计超过时长 50% 或 30 秒（取较小者）才计一次，
        // 否则快速切歌就能把数字刷爆，这个数字就没意义了。
        // 累计的是真实听到的时长：跳转产生的大跨度增量不计入，拖着进度条
        // 从头拉到尾不应该算作听完一遍。
        if (engine.status === "playing") {
          const delta = t - lastTime
          if (delta > 0 && delta < 1) playedSec += delta
          lastTime = t

          const track = get().current()
          if (!counted && track) {
            const need = Math.min(track.duration * 0.5, 30)
            if (need > 0 && playedSec >= need) {
              counted = true
              set((s) => {
                const q = [...s.queue]
                const i = s.index
                if (i >= 0 && i < q.length) q[i] = { ...q[i], playCount: q[i].playCount + 1 }
                return { queue: q }
              })
              save()
            }
          }
        }
      })

      engine.onEnded = () => {
        if (get().mode === "one") {
          engine.seek(0)
          void engine.play()
          resetPlayCounter()
        } else {
          void get().next(true)
        }
      }

      const file = await platform.readConfig<LibraryFile>("library")
      if (file?.tracks?.length) {
        const queue: Track[] = file.tracks.map((t) => ({
          ...t,
          cover: null,
          lyrics: null,
          missing: false,
        }))
        set({ queue, volume: file.volume ?? 0.8, mode: file.mode ?? "all" })
        engine.setVolume(file.volume ?? 0.8)
        const i = file.lastId ? queue.findIndex((t) => t.id === file.lastId) : 0
        set({ index: i >= 0 ? i : 0 })
      }
    },

    async addFiles(refs) {
      if (refs.length === 0) return
      const existing = new Set(get().queue.map((t) => t.ref.id))
      const fresh = refs.filter((r) => !existing.has(r.id))
      if (fresh.length === 0) return

      set({ scanning: { done: 0, total: fresh.length } })

      const added: Track[] = []
      for (let i = 0; i < fresh.length; i++) {
        const ref = fresh[i]
        try {
          const bytes = await platform.readFile(ref)
          const meta = await readMetadata(ref, bytes)
          added.push({
            id: ref.id,
            ref,
            title: meta.title,
            artist: meta.artist,
            album: meta.album,
            duration: meta.duration,
            cover: meta.cover,
            lyrics: meta.lyrics,
            playCount: 0,
            liked: false,
            missing: false,
          })
        } catch {
          // 单个文件读失败不该中断整批导入
        }
        set({ scanning: { done: i + 1, total: fresh.length } })
        // 让出主线程，导入 500 首时界面不冻住
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0))
      }

      set((s) => ({
        queue: [...s.queue, ...added],
        index: s.index < 0 && added.length > 0 ? s.queue.length : s.index,
        scanning: null,
      }))
      if (get().mode === "shuffle") shuffle.reshuffle(get().queue.length)
      save()
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

        // 波形不阻塞播放（F3.4）
        const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200))
        idle(() => {
          void loadPeaks(track.ref, bytes)
            .then((p) => {
              if (get().index === i) set({ peaks: p })
            })
            .catch(() => {})
        })
      } catch {
        set((s) => {
          const q = [...s.queue]
          q[i] = { ...q[i], missing: true }
          return { queue: q }
        })
        // 连续 3 首失败则停止，避免整个列表都坏时无限跳转
        if (++consecutiveErrors >= 3) {
          consecutiveErrors = 0
          set({ status: "error", error: "连续多首无法播放，已停止" })
          return
        }
        window.setTimeout(() => void get().next(true), 2000)
      }
    },

    toggle() {
      const { index, queue, status } = get()
      if (index < 0 && queue.length > 0) {
        void get().playAt(0)
        return
      }
      if (status === "empty" || (!engine.duration && index >= 0)) {
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
      // 播放超过 3 秒时，"上一首"先回到本曲开头，这是播放器的通行行为
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
      const { queue, index } = get()
      if (index < 0 || index >= queue.length) return
      const q = [...queue]
      q[index] = { ...q[index], liked: !q[index].liked }
      set({ queue: q })
      save()
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

    removeAt(i) {
      set((s) => {
        const q = s.queue.filter((_, k) => k !== i)
        let index = s.index
        if (i < s.index) index--
        else if (i === s.index) index = Math.min(index, q.length - 1)
        return { queue: q, index }
      })
      if (get().mode === "shuffle") shuffle.reshuffle(get().queue.length)
      save()
    },
  }
})

export { compactCount, formatTime } from "@/lib/format"

