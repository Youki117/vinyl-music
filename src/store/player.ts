import { create } from "zustand"
import type { FileRef } from "@/platform"

export type Track = {
  id: string
  ref: FileRef | null
  title: string
  artist: string
  album: string
  duration: number
  /** 内嵌封面的 object URL */
  cover: string | null
  playCount: number
  liked: boolean
}

export type PlayStatus = "empty" | "loading" | "paused" | "playing" | "error"

/** 列表循环 → 单曲循环 → 随机 → 顺序（播完停止） */
export type RepeatMode = "all" | "one" | "shuffle" | "once"

export const REPEAT_ORDER: RepeatMode[] = ["all", "one", "shuffle", "once"]

export const REPEAT_LABEL: Record<RepeatMode, string> = {
  all: "列表循环",
  one: "单曲循环",
  shuffle: "随机播放",
  once: "顺序播放",
}

type PlayerState = {
  status: PlayStatus
  error: string | null
  queue: Track[]
  /** 在 queue 中的下标；-1 表示未选中 */
  index: number
  duration: number
  volume: number
  muted: boolean
  mode: RepeatMode
  /** 波形峰值，0..1，长度约 500。null 表示尚未算出 */
  peaks: Float32Array | null

  current(): Track | null
  cycleMode(): void
  toggleLike(): void
}

/**
 * M1 阶段的占位数据，让静态版面有东西可渲染。M2 接上播放引擎后，
 * queue 由曲库导入填充，这里的假曲目会被移除。
 */
const DEMO: Track = {
  id: "demo",
  ref: null,
  title: "山明水秀不比你有看头",
  artist: "Xiaojie",
  album: "FASHION",
  duration: 300,
  cover: null,
  playCount: 4500,
  liked: true,
}

export const usePlayer = create<PlayerState>((set, get) => ({
  status: "paused",
  error: null,
  queue: [DEMO],
  index: 0,
  duration: DEMO.duration,
  volume: 0.8,
  muted: false,
  mode: "all",
  peaks: null,

  current() {
    const { queue, index } = get()
    return index >= 0 && index < queue.length ? queue[index] : null
  },

  cycleMode() {
    const i = REPEAT_ORDER.indexOf(get().mode)
    set({ mode: REPEAT_ORDER[(i + 1) % REPEAT_ORDER.length] })
  },

  toggleLike() {
    const { queue, index } = get()
    if (index < 0 || index >= queue.length) return
    const next = [...queue]
    next[index] = { ...next[index], liked: !next[index].liked }
    set({ queue: next })
  },
}))

/** 8.8w 这类紧凑写法，与效果图一致。 */
export function compactCount(n: number): string {
  if (n < 10000) return String(n)
  const w = n / 10000
  return `${w >= 100 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, "")}w`
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}
