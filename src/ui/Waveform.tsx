import { useEffect, useRef } from "react"

import { usePlayer } from "@/store/player"

const WINDOW_W = 118
const WINDOW_H = 32
/** 波形窗口覆盖的时长（秒），playhead 居中 */
const SPAN_SEC = 40

/**
 * E8：进度条上方的局部波形。
 *
 * 参考图里这块不是整首歌的波形铺满进度条，而是一小段跟着播放头走的窗口 ——
 * 尺寸和位置都对得上。这里按同样的语义实现：显示播放头前后各 20 秒的波形。
 */
export default function Waveform({ progress = 0.27 }: { progress?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaks = usePlayer((s) => s.peaks)
  const duration = usePlayer((s) => s.duration)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = WINDOW_W * dpr
    canvas.height = WINDOW_H * dpr
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, WINDOW_W, WINDOW_H)

    const data = peaks ?? placeholderPeaks()
    const half = duration > 0 ? SPAN_SEC / 2 / duration : 0.08
    const from = progress - half
    const to = progress + half
    const mid = WINDOW_H / 2

    ctx.fillStyle = getComputedStyle(canvas).color
    for (let px = 0; px < WINDOW_W; px++) {
      const f = from + ((to - from) * px) / WINDOW_W
      if (f < 0 || f > 1) continue
      const v = data[Math.min(data.length - 1, Math.floor(f * data.length))] ?? 0
      const h = Math.max(0.6, v * (WINDOW_H - 4))
      // 播放头之后的部分淡一些
      ctx.globalAlpha = f <= progress ? 0.85 : 0.4
      ctx.fillRect(px, mid - h / 2, 0.8, h)
    }
  }, [peaks, progress, duration])

  return <canvas ref={canvasRef} className="waveform" style={{ width: WINDOW_W, height: WINDOW_H }} />
}

/** 波形尚未算出时的占位图形，不阻塞播放（PRD F3.4）。 */
let cachedPlaceholder: Float32Array | null = null
function placeholderPeaks(): Float32Array {
  if (cachedPlaceholder) return cachedPlaceholder
  const n = 512
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / n
    a[i] =
      0.18 +
      0.32 * Math.abs(Math.sin(t * 47)) +
      0.22 * Math.abs(Math.sin(t * 131 + 1.3)) +
      0.12 * Math.abs(Math.sin(t * 311 + 0.7))
  }
  cachedPlaceholder = a
  return a
}
