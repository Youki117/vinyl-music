import { useMemo, type ReactNode } from "react"

import Backdrop from "./Backdrop"
import Veil from "./Veil"
import { useActiveTint } from "./useActiveTint"
import { DESIGN_H, DESIGN_W, useStageFit } from "./useStageFit"
import { deriveInk } from "@/skin/palette"
import { useSkin } from "@/store/skin"

/**
 * 舞台。固定 1243×688 设计坐标系（见 useStageFit 的 DESIGN_W/H）整体等比缩放居中，
 * 窗口内其余部分填黑。
 *
 * 内容层用 transform: scale 缩放。蒙版画布走另一条路：它的后备缓冲有意小于物理
 * 像素（见 useStageFit 的 VEIL_MAX_W），靠 CSS 上采样铺满 —— 一团柔和的雾拉伸看
 * 不出来，但按物理像素渲染要多花上百兆。
 */
export default function Stage({ children }: { children: ReactNode }) {
  const fit = useStageFit()
  const backdrop = useSkin((s) => s.backdrop)
  const baseInk = useSkin((s) => s.skin.ink)
  const veil = useSkin((s) => s.skin.veil)
  const backdropAvg = useSkin((s) => s.backdropAvg)
  const tint = useActiveTint()

  /*
   * 文字配色在这里现算，而不是换图时算一次存进皮肤。
   *
   * 自动取色会让蒙版色在一首歌里换三次，而且色一放开就可能很深（血红、近黑）。
   * 配色的输入里就有蒙版色 —— 底图被蒙版压过之后的混合亮度才决定文字读不读得清 ——
   * 所以蒙版一变，配色必须跟着变，否则会出现深底深字。
   *
   * 成本是每首歌三次重算，deriveInk 只有几十次循环，可以忽略。
   */
  const ink = useMemo(
    () => (baseInk.auto ? deriveInk(backdropAvg, { ...veil, tint }, baseInk) : baseInk),
    [baseInk, backdropAvg, veil, tint],
  )

  return (
    <div className="viewport">
      {/*
        黑边填充。舞台是固定 1243×688 等比缩放居中的，窗口比例一变就必然多出黑边
        （16:10 的笔记本上约 11%）。这里把同一张底图铺满整个窗口、模糊压暗垫在舞台
        后面，黑边就被"同一张图的延伸"接上了，版式一分不用动。
        没有底图时不渲染，露出 .viewport 的黑底，与改动前一致。
      */}
      {backdrop && (
        <div className="viewport-bleed" style={{ backgroundImage: `url(${backdrop.url})` }} />
      )}
      <div
        className="stage"
        style={{
          width: DESIGN_W * fit.scale,
          height: DESIGN_H * fit.scale,
          ["--ink-primary" as string]: ink.primary,
          ["--ink-secondary" as string]: ink.secondary,
          ["--ink-accent" as string]: ink.accent,
        }}
      >
        <Backdrop />
        <Veil />
        <div className="layer grain" />
        <div
          className="content"
          style={{
            width: DESIGN_W,
            height: DESIGN_H,
            transform: `scale(${fit.scale})`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
