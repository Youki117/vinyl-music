import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"

import { useDismiss } from "./useDismiss"

/**
 * 右键菜单。**必须挂到 document.body 上，不能留在抽屉里。**
 *
 * ## 为什么
 *
 * 菜单是 `position: fixed`，本以为它按视口定位。但 `.drawer` 上有
 * `backdrop-filter: blur(20px)` —— 按规范，非 none 的 filter / backdrop-filter 会让
 * 元素**成为 fixed 后代的包含块**。于是 `left: 1016px` 不是相对视口，而是相对抽屉
 * 左边缘（x≈845）再乘上舞台缩放，实测落到 x≈1910，而视口只有 1280 宽 ——
 * 菜单每次都正常打开，只是整个在屏幕外面。看起来就是"右键没反应"。
 *
 * `.content` 的 transform / perspective 也是同类包含块，所以只能整个 portal 出去：
 * body 上没有这些属性，fixed 才真的是相对视口。
 *
 * 顺带把菜单钳进视口内。这两个菜单都开在右侧抽屉里，天然贴着右边缘 ——
 * 不钳的话，靠右一点右键就会露出半截。
 *
 * ## data-keep-panel
 *
 * portal 出去之后，菜单在 DOM 上不再是抽屉的后代，抽屉那个"点外面就关"的判定
 * （useDismiss 用的是 `contains`）会把点菜单当成点了抽屉外面，顺手把抽屉也关掉。
 * 标上 data-keep-panel 就豁免了 —— 而菜单自己这层用 `respectKeepOpen: false`，
 * 所以点哪儿它自己都照样收起来。
 */
export default function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  const ref = useDismiss<HTMLDivElement>(true, onClose, false)
  const [pos, setPos] = useState({ left: x, top: y })
  // 每次换位置都要重新钳一遍，否则第二次右键会沿用上一次的钳位结果
  const asked = useRef({ x, y })
  asked.current = { x, y }

  // useLayoutEffect 而不是 useEffect：钳位要在浏览器绘制之前完成，
  // 否则菜单会先在越界的位置闪一帧
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 6
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    })
  }, [x, y, ref])

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      data-keep-panel
      style={{ left: pos.left, top: pos.top }}
      onClick={onClose}
    >
      {children}
    </div>,
    document.body,
  )
}
