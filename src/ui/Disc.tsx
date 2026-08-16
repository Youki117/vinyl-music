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
  const cover = usePlayer((s) => s.current()?.cover ?? null)
  const playing = status === "playing"

  // 贴纸优先级：皮肤指定的图（跟随底图或单独指定）> 曲目内嵌封面 > 空。
  // 底图联动是核心需求，永远排第一；但还没设过底图时，用曲目自带的专辑封面
  // 总比留一个空盘好——这也是主流播放器的默认行为。
  const art = label
    ? labelBackground(label.url, focus, label.width, label.height)
    : cover
      ? { backgroundImage: `url(${cover})`, backgroundSize: "cover", backgroundPosition: "center" }
      : undefined

  const hasArt = Boolean(label || cover)

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
        {!hasArt && <span className="disc-label-empty" />}
      </span>
      <span className="disc-shine" />
      <span className="disc-spindle" />
    </button>
  )
}
