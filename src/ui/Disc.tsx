import { useSkin } from "@/store/skin"
import { labelBackground } from "@/skin/resolve"
import { usePlayer } from "@/store/player"
import { useLibrary } from "@/store/library"

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
  ref,
}: {
  onToggle?: () => void
  onContextMenu?: () => void
  /** 换片动效要够到这个节点。React 19 起 ref 就是普通 prop，不用 forwardRef */
  ref?: React.Ref<HTMLButtonElement>
}) {
  const label = useSkin((s) => s.label)
  const focus = useSkin((s) => s.skin.label.focus)
  const prefer = useSkin((s) => s.skin.label.prefer)
  const status = usePlayer((s) => s.status)
  // 封面从曲库读，不读队列里那份副本 —— 曲库是唯一来源，它按 LRU 淘汰并 revoke 时
  // 这里会跟着变 null，而副本不会，那样贴纸就指着一个死 URL 了
  const currentId = usePlayer((s) => s.current()?.id ?? null)
  const cover = useLibrary((s) => (currentId ? (s.byId(currentId)?.cover ?? null) : null))
  const playing = status === "playing"

  /*
   * 贴纸优先级由皮肤里的 `label.prefer` 决定，两种都保留了另一方作兜底：
   *
   * - `"cover"`（默认）：内嵌封面 > 皮肤图 > 空。唱片上放专辑封面是主流播放器的
   *   样子；没有封面的曲目（在线曲目、没打标签的文件）照样由底图接管。
   * - `"skin"`：皮肤图 > 内嵌封面 > 空。这是出厂带默认底图之前的老行为 ——
   *   那时"还没设过底图"才轮得到封面，现在成了一个显式选项。
   */
  // 贴纸吃 poster 而不是 url：底图是视频时 url 是 blob 流，background-image 放不了；
  // poster 是冻住的取样帧（图片底图的 poster 就是 url 自己），两种来源通吃
  const skinArt = label ? labelBackground(label.poster, focus, label.width, label.height) : undefined
  const coverArt = cover
    ? { backgroundImage: `url(${cover})`, backgroundSize: "cover", backgroundPosition: "center" }
    : undefined
  const art = prefer === "skin" ? (skinArt ?? coverArt) : (coverArt ?? skinArt)

  const hasArt = Boolean(label || cover)

  return (
    <button
      ref={ref}
      className="disc"
      data-part="disc"
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
