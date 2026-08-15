export type LyricLine = { t: number; text: string }

/** M1 占位歌词，取自效果图。M4 接上 LRC 解析后由真实歌词替换。 */
export const DEMO_LYRICS: LyricLine[] = [
  { t: 0, text: "震颤一分抖的感动" },
  { t: 6, text: "是否爱上一个人不问明天过后" },
  { t: 12, text: "山明水秀不比你有看头" },
  { t: 18, text: "牵着你的手一直走到最后" },
  { t: 24, text: "这一刻怎么回头" },
  { t: 30, text: "没有星星的夜空" },
]

/**
 * E5：歌词栏。当前行居中、加粗加深，上下各三行按距离渐隐。
 */
export default function Lyrics({
  lines = DEMO_LYRICS,
  activeIndex = 2,
  onSeek,
}: {
  lines?: LyricLine[]
  activeIndex?: number
  onSeek?: (t: number) => void
}) {
  if (lines.length === 0) return null

  return (
    <div className="lyrics" role="list">
      {lines.map((line, i) => {
        const dist = Math.abs(i - activeIndex)
        return (
          <button
            key={`${line.t}-${i}`}
            role="listitem"
            className="lyric-line"
            data-active={i === activeIndex}
            style={{ opacity: Math.max(0.25, 1 - dist * 0.22) }}
            onClick={() => onSeek?.(line.t)}
          >
            {line.text}
          </button>
        )
      })}
    </div>
  )
}
