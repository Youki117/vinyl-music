import type { ReactNode } from "react"

import Backdrop from "./Backdrop"
import Veil from "./Veil"
import { DESIGN_H, DESIGN_W, useStageFit } from "./useStageFit"
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
  const ink = useSkin((s) => s.skin.ink)
  const backdrop = useSkin((s) => s.backdrop)

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
