import { useSkin } from "@/store/skin"
import { labelBackground } from "@/skin/resolve"
import { usePlayer } from "@/store/player"

/**
 * E6/E7：黑胶与唱片贴纸。
 *
 * 旋转必须用 animation-play-state 切换，不能移除动画或设 animation: none ——
 * 后者会让唱片瞬间弹回 0°，违反 PRD F4.1「暂停时就地停住」。用 play-state 时
 * 浏览器保留动画时间轴，且整个动画跑在合成器线程上。
 */
export default function Disc({
  onToggle,
  onContextMenu,
}: {
  onToggle?: () => void
  onContextMenu?: () => void
}) {
  const label = useSkin((s) => s.label)
  const focus = useSkin((s) => s.skin.label.focus)
  const status = usePlayer((s) => s.status)
  const playing = status === "playing"

  const art = label
    ? labelBackground(label.url, focus, label.width, label.height)
    : undefined

  return (
    <button
      className="disc"
      data-playing={playing}
      onClick={onToggle}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.()
      }}
      aria-label={playing ? "暂停" : "播放"}
      aria-pressed={playing}
    >
      <span className="disc-grooves" />
      <span className="disc-label" style={art}>
        {!label && <span className="disc-label-empty" />}
      </span>
      <span className="disc-shine" />
      <span className="disc-spindle" />
    </button>
  )
}
