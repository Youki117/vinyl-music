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

/**
 * 蒙版后备缓冲的宽度上限。
 *
 * 蒙版是一团柔和的雾：fbm 噪声、softness 把边缘拉得很开，没有文字也没有硬边。
 * 这种内容按物理像素渲染是浪费 —— 一张 GPU 合成层从来不是只存一份（GL 前后缓冲、
 * 合成器的纹理副本、交换链、ANGLE 的暂存区），画布尺寸是超线性收费的。
 *
 * 孤立基准（scripts/perf/dbg-size.mjs，每档冷启动两次取平均，只有一个画布的空页面）：
 *
 *   画布 2440×1351（缓冲 13MB）   比空白页多 215MB
 *   画布 1220×676 （缓冲 3.3MB）  比空白页多  60MB
 *
 * ⚠ **这 155MB 的差值是假的，别拿去预期收益。** 后来在完整应用里做了两次对照：
 * 封顶前后 453 → 442MB（只省 11MB）；再后来干脆用 `--disable-webgl` 让蒙版整个退到
 * CSS 降级路径，内存差是 **−6MB，即零**（scripts/perf/dbg-breakdown.mjs）。
 *
 * 原因是孤立基准把整套 GPU/ANGLE 基础设施都算到了那张画布头上。真实应用里底图、
 * 颗粒、内容本来就要合成，那套设施早就在了，蒙版只是往已有的纹理池里再放一张。
 *
 * **蒙版真正的代价在 CPU 不在内存**：空闲态（12fps 档）就吃掉 9.2 个百分点。想省
 * 就往帧率和着色器复杂度上使劲，别再动分辨率了。
 *
 * 封顶保留只是因为它不要钱、方向也没错（SSIM 建模代价 ≤ 0.026）。
 * 取 1280 是折中：再往下（610 宽）4 倍上采样开始能看出边缘色带。
 */
const VEIL_MAX_W = 1280

export type StageFit = {
  /** 缩放系数 */
  scale: number
  /**
   * 蒙版画布的后备缓冲尺寸。
   *
   * 注意这不是物理像素 —— 是按 VEIL_MAX_W 封顶之后的尺寸，通常小于舞台的物理
   * 像素数，靠 CSS 的 width/height:100% 上采样铺满。对这团雾来说看不出区别。
   */
  veilW: number
  veilH: number
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

  // 舞台的物理像素数是上限，但不超过 VEIL_MAX_W；小窗口就照实际尺寸来，不放大
  const physW = DESIGN_W * scale * dpr
  const veilW = Math.min(physW, VEIL_MAX_W)
  return {
    scale,
    veilW: Math.max(1, Math.round(veilW)),
    veilH: Math.max(1, Math.round((veilW / DESIGN_W) * DESIGN_H)),
  }
}
