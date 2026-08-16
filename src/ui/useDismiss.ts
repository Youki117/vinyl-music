import { useEffect, useRef } from "react"

/**
 * 标了这个属性的区域，点击不会关闭浮层。
 *
 * 传输栏（进度条、播放控制、音量）和标题栏属于"常驻操控件"，不是"面板外的空白处"：
 * 混音面板开着的时候本来就要一边拖进度条一边看时间轴，点一下就把面板关掉是帮倒忙。
 */
export const KEEP_OPEN_ATTR = "data-keep-panel"

/** 同一次点击可能同时触发多个浮层的关闭，吞掉一次就够了 */
let swallowArmed = false

/**
 * 吞掉紧随其后的那次 click。
 *
 * 点面板外部时，用户的意图是"关掉它"，而不是"关掉它并且顺手按到底下那个按钮"。
 * 主流软件都是第一次点击只负责关闭，所以这里要把这次点击拦下来。
 */
function swallowNextClick(): void {
  if (swallowArmed) return
  swallowArmed = true

  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    cleanup()
  }
  const cleanup = () => {
    swallowArmed = false
    document.removeEventListener("click", stop, true)
    window.clearTimeout(timer)
  }
  // pointerdown 之后未必跟得上 click（比如按下就拖走了），留个超时兜底，
  // 否则这个监听器会一直挂着，把下一次正常点击也吞掉
  const timer = window.setTimeout(cleanup, 400)
  document.addEventListener("click", stop, true)
}

/**
 * 点浮层外部就关掉它。
 *
 * 用 pointerdown 而不是 click：在面板里按下、拖到面板外松开（拖滑块、拖取景框
 * 都会这样）不该算作"点了外面"。判定按下时落在哪里才是对的。
 *
 * @param open  浮层当前是否可见；不可见时不挂监听
 * @param onClose 关闭回调
 * @param respectKeepOpen 是否豁免 [data-keep-panel] 区域。右键菜单这类瞬时浮层
 *                        应当传 false —— 点哪儿都该收起来。
 */
export function useDismiss<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  respectKeepOpen = true,
) {
  const ref = useRef<T>(null)
  // 回调放进 ref，避免调用方每次渲染传新函数导致监听器反复装卸
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || !(target instanceof Element)) return
      if (ref.current?.contains(target)) return
      if (respectKeepOpen && target.closest(`[${KEEP_OPEN_ATTR}]`)) return

      closeRef.current()
      swallowNextClick()
    }

    // 捕获阶段：面板内部有些控件会 stopPropagation，冒泡阶段可能收不到
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [open, respectKeepOpen])

  return ref
}
