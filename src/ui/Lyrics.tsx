import { useMemo } from "react"

import { engine } from "@/audio/engine"
import { useProgress } from "@/audio/useProgress"
import { activeLineIndex, lineFill, parseLrc, type LyricLine } from "@/lyrics/parse"
import { usePlayer } from "@/store/player"

/** 没有曲目时展示的占位歌词，取自效果图，让空状态下版面不塌。 */
const PLACEHOLDER: LyricLine[] = [
  "震颤一分抖的感动",
  "是否爱上一个人不问明天过后",
  "山明水秀不比你有看头",
  "牵着你的手一直走到最后",
  "这一刻怎么回头",
  "没有星星的夜空",
].map((text, i) => ({ t: i * 6, text, end: i * 6 + 5 }))

/** 当前行前后各显示这么多行 */
const RADIUS = 3

/**
 * E5：歌词栏。当前行居中、加粗加深，上下按距离渐隐。
 *
 * 有词级时间戳（增强型 LRC）时，当前行做逐字推进：底层是暗色整行，上层是亮色
 * 副本按 clip-path 逐渐揭开。用两层叠加而不是给每个字包 span，是因为换行时
 * 逐字节点的宽度会跳变，而整行副本天然与底层对齐。
 */
export default function Lyrics() {
  const track = usePlayer((s) => s.current())
  const { time } = useProgress()

  const parsed = useMemo(() => (track?.lyrics ? parseLrc(track.lyrics) : null), [track?.lyrics])

  const lines = parsed?.lines.length ? parsed.lines : track ? [] : PLACEHOLDER
  const isPlaceholder = !parsed?.lines.length && !track

  // 二分定位，不要线性扫描：这段代码跟着进度更新走
  const at = isPlaceholder ? 12 : time + (parsed?.offset ?? 0) / 1000
  const active = isPlaceholder ? 2 : activeLineIndex(lines, at)

  // 无歌词时整块隐藏，其余版式不位移（F6.5）
  if (lines.length === 0) return null

  const from = Math.max(0, active - RADIUS)
  const to = Math.min(lines.length, Math.max(RADIUS * 2 + 1, active + RADIUS + 1))
  const window = lines.slice(from, to)

  return (
    <div className="lyrics" role="list">
      {window.map((line, i) => {
        const idx = from + i
        const isActive = idx === active
        const dist = Math.abs(idx - active)
        // 唱完了但下一句还没到（间奏），当前行不该继续保持高亮
        const spent = isActive && line.end !== undefined && at > line.end
        const fill = isActive && !spent ? lineFill(line, at) : 0

        return (
          <button
            key={`${line.t}-${idx}`}
            role="listitem"
            className="lyric-line"
            data-active={isActive && !spent}
            style={{ opacity: Math.max(0.22, 1 - dist * 0.24) }}
            onClick={() => {
              const d = engine.duration
              if (d > 0 && !isPlaceholder) engine.seek(line.t / d)
            }}
          >
            {line.text}
            {fill > 0 && (
              <span className="lyric-fill" aria-hidden="true" style={{ "--fill": `${fill * 100}%` } as never}>
                {line.text}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
