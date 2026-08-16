import { useEffect, useRef, useState } from "react"

import { useProgress } from "@/audio/useProgress"
import { clipAt, clipEnd, moveClip, trimClip, type Clip } from "@/audio/clips"

const W = 384
const H = 74
const PAD = 4
/** 距离片段边缘多少像素内算作"拖边缘裁剪"而不是"整体移动" */
const EDGE = 6

type Drag =
  | { kind: "move"; id: string; grabOffset: number }
  | { kind: "trim"; id: string; side: "start" | "end" }
  | null

/**
 * 片段时间轴。横轴是主音轨的时间。
 *
 * 交互按剪辑软件的通行习惯：点选中、拖动整体移位、拖边缘裁剪。
 * 分割/删除/复制放在外面做成按钮——那些操作靠点击命中判定太容易误触。
 */
export default function Timeline({
  hostDuration,
  sourceDuration,
  clips,
  peaks,
  selectedId,
  onSelect,
  onChange,
}: {
  hostDuration: number
  sourceDuration: number
  clips: Clip[]
  peaks: Float32Array | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (clips: Clip[]) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drag = useRef<Drag>(null)
  const [hoverCursor, setHoverCursor] = useState("default")
  const { time } = useProgress()

  const dur = Math.max(1, hostDuration)
  const toX = (t: number) => PAD + (t / dur) * (W - PAD * 2)
  const fromX = (x: number) => ((x - PAD) / (W - PAD * 2)) * dur

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // 时间刻度：每 30 秒一道
    ctx.strokeStyle = "rgba(255,255,255,0.07)"
    ctx.lineWidth = 1
    for (let t = 0; t <= dur; t += 30) {
      const x = Math.round(toX(t)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }

    for (const c of clips) {
      const x0 = toX(c.at)
      const x1 = toX(clipEnd(c))
      const w = Math.max(2, x1 - x0)
      const on = c.id === selectedId

      ctx.fillStyle = on ? "rgba(178,132,95,0.34)" : "rgba(255,255,255,0.10)"
      ctx.fillRect(x0, PAD, w, H - PAD * 2)
      ctx.strokeStyle = on ? "#b2845f" : "rgba(255,255,255,0.26)"
      ctx.lineWidth = on ? 1.5 : 1
      ctx.strokeRect(x0 + 0.5, PAD + 0.5, w - 1, H - PAD * 2 - 1)

      // 片段内的波形：按 sourceStart 取源文件对应区间
      if (peaks && peaks.length > 0 && sourceDuration > 0) {
        ctx.fillStyle = on ? "rgba(255,240,225,0.72)" : "rgba(255,255,255,0.40)"
        const mid = H / 2
        const half = (H - PAD * 2) / 2 - 2
        for (let px = Math.ceil(x0); px < x1 - 1; px++) {
          const tHost = fromX(px)
          const tSrc = c.sourceStart + (tHost - c.at)
          const i = Math.floor((tSrc / sourceDuration) * peaks.length)
          if (i < 0 || i >= peaks.length) continue
          const h = Math.max(0.7, peaks[i] * half * c.gain)
          ctx.fillRect(px, mid - h, 1, h * 2)
        }
      }

      // 音量低于满值时在顶部标一条线，一眼看出这段被压过
      if (c.gain < 0.99) {
        const y = PAD + (1 - c.gain) * (H - PAD * 2)
        ctx.strokeStyle = "#b2845f"
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(x0, y)
        ctx.lineTo(x1, y)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // 播放头
    if (time >= 0 && time <= dur) {
      ctx.strokeStyle = "#f2efe9"
      ctx.lineWidth = 1
      const x = Math.round(toX(time)) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, H)
      ctx.stroke()
    }
  }, [clips, peaks, selectedId, time, dur, sourceDuration])

  const localX = (e: React.PointerEvent | React.MouseEvent) =>
    e.clientX - (e.currentTarget as HTMLCanvasElement).getBoundingClientRect().left

  /** 判断指针落在哪个片段的哪个部位 */
  const hit = (x: number): { clip: Clip; part: "start" | "end" | "body" } | null => {
    for (const c of clips) {
      const x0 = toX(c.at)
      const x1 = toX(clipEnd(c))
      if (x < x0 - EDGE || x > x1 + EDGE) continue
      if (Math.abs(x - x0) <= EDGE) return { clip: c, part: "start" }
      if (Math.abs(x - x1) <= EDGE) return { clip: c, part: "end" }
      if (x >= x0 && x <= x1) return { clip: c, part: "body" }
    }
    return null
  }

  return (
    <canvas
      ref={ref}
      className="timeline"
      style={{ width: W, height: H, cursor: hoverCursor }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const x = localX(e)
        const h = hit(x)
        e.currentTarget.setPointerCapture(e.pointerId)
        if (!h) {
          onSelect(null)
          drag.current = null
          return
        }
        onSelect(h.clip.id)
        drag.current =
          h.part === "body"
            ? { kind: "move", id: h.clip.id, grabOffset: fromX(x) - h.clip.at }
            : { kind: "trim", id: h.clip.id, side: h.part }
      }}
      onPointerMove={(e) => {
        const x = localX(e)
        if (!drag.current || e.buttons !== 1) {
          const h = hit(x)
          setHoverCursor(!h ? "default" : h.part === "body" ? "grab" : "ew-resize")
          return
        }
        const d = drag.current
        if (d.kind === "move") {
          onChange(moveClip(clips, d.id, fromX(x) - d.grabOffset, dur))
        } else {
          onChange(trimClip(clips, d.id, d.side, fromX(x), sourceDuration || dur))
        }
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onDoubleClick={(e) => {
        // 双击空白处把播放头附近的片段选中，方便接着按分割
        const c = clipAt(clips, fromX(localX(e)))
        onSelect(c?.id ?? null)
      }}
    />
  )
}
