import { useEffect, type RefObject } from "react"

/**
 * 横向卡片轨道的滚轮接话：光标悬在轨道上时，竖向滚轮转成横向滚动。
 *
 * 规则刻意做成**完全接管**：轨道溢出（卡片没放完）就消费掉全部滚轮增量，
 * 滚到端点就停在端点 —— 不把滚轮还给外层面板。否则同一手势会在中途从
 * 横滚切成纵滚，页面动一下轨道又动一下，正是"两个滚轮打架"的体感来源。
 * 想滚面板，把光标移出轨道即可；轨道只有几十像素高，不是大面积障碍。
 *
 * 没溢出（卡片一排放得下）就不接管，滚轮原样穿透给面板。
 *
 * React 的 onWheel 会被注册成 passive，SyntheticEvent.preventDefault 不能可靠
 * 阻止外层面板同时纵向滚动 —— 必须挂 non-passive 的原生监听。
 * 背景图片栏与 Wallpaper Engine 栏共用这一套，手感必须一致。
 */
export function useRailWheel(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const rail = ref.current
    if (!active || !rail) return

    const onWheel = (event: WheelEvent) => {
      // 没溢出就完全不掺和：滚轮穿透给面板
      if (rail.scrollWidth <= rail.clientWidth + 1) return
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      if (delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      // 到端点后浏览器自己钳住，多出来的增量被消费掉但不产生位移
      rail.scrollLeft += delta
    }
    rail.addEventListener("wheel", onWheel, { passive: false })
    return () => rail.removeEventListener("wheel", onWheel)
  }, [ref, active])
}
