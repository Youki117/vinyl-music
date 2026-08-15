import { useRef, type ReactNode } from "react"

import { engine } from "@/audio/engine"
import { useProgress } from "@/audio/useProgress"
import { formatTime, usePlayer } from "@/store/player"
import Waveform from "./Waveform"

/**
 * E9/E10：进度条、时间与曲名。
 *
 * 控制条作为 children 放进来，与进度条共用同一个定位容器 —— 二者在效果图里
 * 左右对齐，拆成两个独立定位的块只会让两处坐标各自漂移。
 */
export default function Progress({ children }: { children?: ReactNode }) {
  const barRef = useRef<HTMLDivElement>(null)
  const { frac: progress, time, duration } = useProgress()
  const track = usePlayer((s) => s.current())

  const seekAt = (clientX: number) => {
    const el = barRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    engine.seek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)))
  }

  return (
    <div className="playback">
      <div className="wave-row" style={{ ["--playhead" as string]: `${progress * 100}%` }}>
        <Waveform progress={progress} />
      </div>

      <div
        ref={barRef}
        className="progress"
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          seekAt(e.clientX)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekAt(e.clientX)
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") engine.seek(Math.max(0, progress - 0.02))
          if (e.key === "ArrowRight") engine.seek(Math.min(1, progress + 0.02))
        }}
      >
        <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
        <div className="progress-thumb" style={{ left: `${progress * 100}%` }} />
      </div>

      <div className="timing">
        <span>{formatTime(time)}</span>
        <b>{track?.title ?? "未选择曲目"}</b>
        <span>{formatTime(duration)}</span>
      </div>

      {children}
    </div>
  )
}
