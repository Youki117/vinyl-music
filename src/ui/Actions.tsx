import { compactCount, usePlayer } from "@/store/player"
import { IconHeart, IconPlayCount } from "./icons"

/**
 * E11 收藏按钮 + E12 播放次数。
 *
 * 效果图这两个位置原本是点赞数与评论数，本地播放器没有这两个数据的真实来源，
 * 已改为收藏与播放次数（PRD §9 Q2），视觉位置与字号保持不变。
 */
export default function Actions() {
  const track = usePlayer((s) => s.current())
  const toggleLike = usePlayer((s) => s.toggleLike)

  return (
    <div className="actions">
      <button
        className="action like"
        data-liked={track?.liked ?? false}
        onClick={toggleLike}
        aria-label={track?.liked ? "取消收藏" : "收藏"}
        aria-pressed={track?.liked ?? false}
      >
        <IconHeart filled={track?.liked ?? false} />
      </button>

      <div className="action count" title="本地播放次数">
        <IconPlayCount />
        <em>{compactCount(track?.playCount ?? 0)}</em>
      </div>
    </div>
  )
}
