import { useEffect, useState } from "react"

/**
 * 设计基准坐标系。所有元素坐标直接写设计稿数值，不做响应式重排。
 *
 * 1243×688 不是拍脑袋定的：参考图 design-ref/target/ref-veil-primary.png 剥掉
 * 录屏黑边后正好是这个尺寸。采用它做基准，元素坐标可以 1:1 照抄参考图，视觉
 * 对拍也不需要任何缩放 —— 缩放会引入系统性偏移，把 SSIM 白白吃掉一大截。
 */
export const DESIGN_W = 1243
export const DESIGN_H = 688

export type StageFit = {
  /** 缩放系数 */
  scale: number
  /** 舞台在窗口中的物理像素尺寸，用于给 canvas 分配后备缓冲区 */
  deviceW: number
  deviceH: number
  dpr: number
}

/**
 * 舞台等比缩放。窗口内其余部分填黑。
 *
 * 这是保证"任何窗口尺寸下都和效果图一致"最省事也最可靠的做法：只有一套坐标，
 * 不存在断点，不会出现某个分辨率下版式跑偏。
 */
export function useStageFit(): StageFit {
  const [fit, setFit] = useState<StageFit>(() => compute())

  useEffect(() => {
    let timer = 0
    const update = () => {
      window.clearTimeout(timer)
      // 防抖：拖拽窗口时不反复重建 GL 后备缓冲区
      timer = window.setTimeout(() => setFit(compute()), 100)
    }
    window.addEventListener("resize", update)
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    mq.addEventListener("change", update)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("resize", update)
      mq.removeEventListener("change", update)
    }
  }, [])

  return fit
}

function compute(): StageFit {
  const w = window.innerWidth
  const h = window.innerHeight
  const scale = Math.min(w / DESIGN_W, h / DESIGN_H)
  const dpr = window.devicePixelRatio || 1
  return {
    scale,
    dpr,
    deviceW: Math.max(1, Math.round(DESIGN_W * scale * dpr)),
    deviceH: Math.max(1, Math.round(DESIGN_H * scale * dpr)),
  }
}
