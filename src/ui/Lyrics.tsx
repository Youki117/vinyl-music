import { useLayoutEffect, useMemo, useRef } from "react"

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

/**
 * 距当前行 n 行时的不透明度。
 *
 * 指数衰减而不是线性：参考图里当前行的上下一行就已经明显变淡，再往外几乎看不见，
 * 线性衰减做不出这种"聚焦感"。0.52 是照 design-ref 的两张图取的 ——
 * 1 → 0.52 → 0.27 → 0.14，与图上的层次基本对得上。
 */
const dim = (dist: number) => Math.max(0.1, 0.52 ** dist)

/**
 * E5：歌词栏。
 *
 * **当前行固定在同一个槽位，歌词从它下面滚过去** —— 这是和主流播放器观感差距最大的
 * 一点，也是之前做错的地方。原实现按 `active ± RADIUS` 切一段出来渲染，于是歌刚开始时
 * 当前行贴在栏顶，唱到第四句才慢慢挪到中间；而且每换一行整段列表重新切片、硬跳一格，
 * 没有任何过渡。
 *
 * 这个 bug 一直没被对拍发现，因为占位歌词把 active 硬编码成 2，截图里永远是"第 3 行
 * 居中"，正好和参考图吻合 —— 测试绿着，真跑起来是歪的。
 *
 * 现在整篇歌词都渲染出来，靠滚动容器把当前行送到固定槽位（槽位偏移就是 CSS 里
 * `.lyrics-track` 的 padding-top，不在这里重复写死）。行高不等（长句折两行）也不影响，
 * 因为用的是元素实测的 offsetTop，不是按行号乘固定行距算的。
 *
 * 有词级时间戳（增强型 LRC）时，当前行做逐字推进：底层是暗色整行，上层是亮色
 * 副本按 clip-path 逐渐揭开。用两层叠加而不是给每个字包 span，是因为换行时
 * 逐字节点的宽度会跳变，而整行副本天然与底层对齐。
 */
export default function Lyrics() {
  const track = usePlayer((s) => s.current())
  const { time } = useProgress()

  const boxRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  /** 首次定位要瞬间到位，不要让用户看着歌词从头"滚"下来 */
  const settled = useRef(false)

  const parsed = useMemo(() => (track?.lyrics ? parseLrc(track.lyrics) : null), [track?.lyrics])

  const lines = parsed?.lines.length ? parsed.lines : track ? [] : PLACEHOLDER
  const isPlaceholder = !parsed?.lines.length && !track

  // 二分定位，不要线性扫描：这段代码跟着进度更新走
  const at = isPlaceholder ? 12 : time + (parsed?.offset ?? 0) / 1000
  const active = isPlaceholder ? 2 : activeLineIndex(lines, at)

  useLayoutEffect(() => {
    const box = boxRef.current
    const el = activeRef.current
    const inner = trackRef.current
    if (!box || !el || !inner) return

    // 槽位偏移以 CSS 为准，避免和样式表各写一份对不上
    const slot = parseFloat(getComputedStyle(inner).paddingTop) || 0
    const top = el.offsetTop - slot
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    box.scrollTo({ top, behavior: settled.current && !reduce ? "smooth" : "auto" })
    settled.current = true
  }, [active, lines])

  // 换曲目时重新瞬间定位，否则会从上一首的位置一路滚过来
  useLayoutEffect(() => {
    settled.current = false
  }, [track?.id])

  // 无歌词时整块隐藏，其余版式不位移（F6.5）
  if (lines.length === 0) return null

  return (
    <div className="lyrics" data-part="lyrics" ref={boxRef}>
      <div className="lyrics-track" ref={trackRef} role="list">
        {lines.map((line, idx) => {
          const isActive = idx === active
          const dist = Math.abs(idx - active)
          // 唱完了但下一句还没到（间奏），当前行不该继续保持高亮
          const spent = isActive && line.end !== undefined && at > line.end
          const fill = isActive && !spent ? lineFill(line, at) : 0

          return (
            <button
              key={`${line.t}-${idx}`}
              ref={isActive ? activeRef : undefined}
              role="listitem"
              className="lyric-line"
              data-active={isActive && !spent}
              style={{ opacity: dim(dist) }}
              onClick={() => {
                const d = engine.duration
                if (d > 0 && !isPlaceholder) engine.seek(line.t / d)
              }}
            >
              {line.text}
              {fill > 0 && (
                <span
                  className="lyric-fill"
                  aria-hidden="true"
                  style={{ "--fill": `${fill * 100}%` } as never}
                >
                  {line.text}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
