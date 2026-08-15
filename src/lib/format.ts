/** 纯格式化工具。刻意与 store 分开：不依赖 DOM，也不依赖播放引擎。 */

/** 8.8w 这类紧凑写法，与效果图一致（PRD F9.3）。 */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0"
  if (n < 10000) return String(Math.floor(n))
  const w = n / 10000
  return `${w >= 100 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, "")}w`
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}
