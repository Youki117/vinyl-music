import type { ReactNode } from "react"

import Backdrop from "./Backdrop"
import Veil from "./Veil"
import { DESIGN_H, DESIGN_W, useStageFit } from "./useStageFit"
import { useSkin } from "@/store/skin"

/**
 * 舞台。固定 1220×688 设计坐标系整体等比缩放居中，窗口内其余部分填黑。
 *
 * 内容层用 transform: scale 缩放；蒙版画布不能这么干 —— CSS 缩放会把画布当图片
 * 拉伸导致模糊，所以它的后备缓冲区按真实物理像素分配（见 useStageFit）。
 */
export default function Stage({ children }: { children: ReactNode }) {
  const fit = useStageFit()
  const ink = useSkin((s) => s.skin.ink)

  return (
    <div className="viewport">
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
