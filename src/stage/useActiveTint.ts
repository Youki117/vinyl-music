import { useSkin } from "@/store/skin"
import { useTintPhase } from "./useTintPhase"

/**
 * 当前生效的蒙版色。
 *
 * 自动取色开着且真的取到了色，就用底图的主色，按播放进度每首歌换三次；
 * 否则用皮肤里存的 tint。
 *
 * 抽成 hook 是因为**有两个地方要用同一个值**：蒙版自己要拿它上色，Stage 要拿它
 * 推文字配色。蒙版色一放开就可能很深（血红、近黑），文字配色不跟着走就会出现
 * 深底深字。两边各算一遍容易走岔，所以只留这一处。
 *
 * 自动色**不写回皮肤**：写回去的话一首歌要往配置里落三次盘，还会把用户存在预设里的
 * 颜色悄悄改掉 —— 那正是"用户优先"要防的事。
 */
export function useActiveTint(): string {
  const tint = useSkin((s) => s.skin.veil.tint)
  const tintAuto = useSkin((s) => s.skin.tintAuto)
  const tintColors = useSkin((s) => s.tintColors)

  const autoOn = tintAuto && tintColors.length > 0
  const phase = useTintPhase(autoOn, tintColors.length || 3)

  return autoOn ? tintColors[Math.min(phase, tintColors.length - 1)] : tint
}
