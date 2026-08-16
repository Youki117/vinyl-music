import { useEffect, useRef, useState, type ReactNode } from "react"

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
  const { frac: progress, time, duration: engineDuration } = useProgress()
  const track = usePlayer((s) => s.current())
  const [loop, setLoop] = useState(engine.loop)

  useEffect(() => engine.onLoopChange(setLoop), [])

  // 曲目还没载入时引擎时长是 0，退回元数据里的时长 ——
  // 否则选中一首歌但没按播放，总时长会一直显示 00:00
  const duration = engineDuration > 0 ? engineDuration : (track?.duration ?? 0)

  const seekAt = (clientX: number) => {
    const el = barRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    engine.seek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)))
  }

  return (
    // data-keep-panel：整条传输栏是常驻操控件。混音面板开着时本来就要一边拖
    // 进度条一边看时间轴，把它算成"面板外的空白处"会让面板一碰就关。
    <div className="playback" data-keep-panel>
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

        {/* A-B 循环区间：在进度条上标出来，否则用户不知道自己设在哪儿了 */}
        {duration > 0 && loop.a !== null && (
          <div className="loop-mark loop-a" style={{ left: `${(loop.a / duration) * 100}%` }} title="A 点" />
        )}
        {duration > 0 && loop.a !== null && loop.b !== null && (
          <>
            <div className="loop-mark loop-b" style={{ left: `${(loop.b / duration) * 100}%` }} title="B 点" />
            <div
              className="loop-span"
              style={{
                left: `${(loop.a / duration) * 100}%`,
                width: `${((loop.b - loop.a) / duration) * 100}%`,
              }}
            />
          </>
        )}

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
