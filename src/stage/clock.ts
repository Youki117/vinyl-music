/**
 * 全局渲染时钟。整个应用只有这一个 requestAnimationFrame 循环 —— 每个组件各开
 * 一个 rAF 是常见的性能事故来源。
 *
 * 支持降频：蒙版静止时没必要每秒重画 60 次同样的东西（技术文档 §11）。
 */

export type FrameFn = (timeSec: number, deltaMs: number) => void

type Sub = { fn: FrameFn; minIntervalMs: number; lastMs: number }

const subs = new Set<Sub>()

let raf = 0
let startMs = 0
let lastMs = 0
let running = false

/** 连续掉帧探测，供蒙版自动降级用（PRD F10.6）。 */
let slowFrames = 0
const slowListeners = new Set<() => void>()

function loop(nowMs: number): void {
  raf = requestAnimationFrame(loop)

  const delta = lastMs === 0 ? 16.7 : nowMs - lastMs
  lastMs = nowMs
  const timeSec = (nowMs - startMs) / 1000

  if (delta > 20) {
    if (++slowFrames >= 30) {
      slowFrames = 0
      for (const fn of slowListeners) fn()
    }
  } else if (slowFrames > 0) {
    slowFrames--
  }

  for (const sub of subs) {
    if (nowMs - sub.lastMs < sub.minIntervalMs) continue
    sub.lastMs = nowMs
    sub.fn(timeSec, delta)
  }
}

function start(): void {
  if (running || subs.size === 0 || document.hidden) return
  running = true
  startMs = startMs || performance.now()
  lastMs = 0
  raf = requestAnimationFrame(loop)
}

function stop(): void {
  if (!running) return
  running = false
  cancelAnimationFrame(raf)
  raf = 0
}

if (typeof document !== "undefined") {
  // 窗口不可见时完全停摆，音频不受影响
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop()
    else start()
  })
}

/**
 * 订阅每帧回调。
 * @param fps 期望帧率上限；60 为全速，10 表示最多每 100ms 调一次。
 * @returns 取消订阅
 */
export function subscribe(fn: FrameFn, fps = 60): () => void {
  const sub: Sub = { fn, minIntervalMs: fps > 0 ? 1000 / fps - 1 : Infinity, lastMs: 0 }
  subs.add(sub)
  start()
  return () => {
    subs.delete(sub)
    if (subs.size === 0) stop()
  }
}

/** 掉帧超阈值时触发，用于逐级降级。 */
export function onSustainedSlowdown(fn: () => void): () => void {
  slowListeners.add(fn)
  return () => slowListeners.delete(fn)
}
