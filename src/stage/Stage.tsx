import { useMemo, type ReactNode } from "react"

import Backdrop from "./Backdrop"
import Veil from "./Veil"
import { useActiveTint } from "./useActiveTint"
import { deriveInk } from "@/skin/palette"
import { useSkin } from "@/store/skin"
import { offsetsToVars, useLayout } from "@/store/layout"

/**
 * 舞台。固定 1243×688 设计坐标系（见 useStageFit 的 DESIGN_W/H）。
 *
 * 窗口比例被 Rust 侧锁定在设计比例（src-tauri/src/aspect.rs），舞台按 cover 铺满窗口，
 * 任何比例下都不会露出底色 —— 尺寸算式与理由见 stage.css 的 `.stage`。
 *
 * 内容层用 transform: scale 缩放，系数是 CSS 变量 --stage-scale，也由 CSS 算出来 ——
 * **整条缩放链路没有 JS**，所以拖窗口时本组件一次都不重渲染，也不可能落后于窗口。
 *
 * 蒙版画布走另一条路：它的后备缓冲有意小于物理像素（见 useStageFit 的 VEIL_MAX_W），
 * 靠 CSS 上采样铺满 —— 一团柔和的雾拉伸看不出来，但按物理像素渲染要多花上百兆。
 */
export default function Stage({ children }: { children: ReactNode }) {
  const baseInk = useSkin((s) => s.skin.ink)
  const veil = useSkin((s) => s.skin.veil)
  const backdropAvg = useSkin((s) => s.backdropAvg)
  const tint = useActiveTint()
  const offsets = useLayout((s) => s.offsets)
  const editing = useLayout((s) => s.editing)
  const vars = useMemo(() => offsetsToVars(offsets), [offsets])

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
      <div
        className="stage"
        style={{
          ["--ink-primary" as string]: ink.primary,
          ["--ink-secondary" as string]: ink.secondary,
          ["--ink-accent" as string]: ink.accent,
        }}
      >
        <Backdrop />
        <Veil />
        <div className="layer grain" />
        {/*
          自定义布局的偏移量以 CSS 变量的形式挂在这里（需求 §4.3）。挂在 .content 上
          而不是各个部件自己读 store：部件不需要知道有"布局编辑"这回事，CSS 里
          `translate: var(--off-x, 0) var(--off-y, 0)` 一行就够，没动过的部件连变量都没有。
        */}
        <div className="content" style={vars} data-layout-edit={editing || undefined}>
          {children}
        </div>
      </div>
    </div>
  )
}
