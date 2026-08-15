import type { Ink } from "./model"
import type { VeilParams } from "@/stage/veil/renderer"

/** sRGB 相对亮度（WCAG 定义）。 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [255, 255, 255]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")
  return `#${c(r)}${c(g)}${c(b)}`
}

/** 把颜色按比例推向黑或白。amount > 0 变亮，< 0 变暗。 */
function shift(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  const t = amount > 0 ? 255 : 0
  const k = Math.abs(amount)
  return rgbToHex(r + (t - r) * k, g + (t - g) * k, b + (t - b) * k)
}

const MIN_CONTRAST = 4.5

/**
 * 从底图平均色推导文字配色。
 *
 * 底图会被蒙版压向 veil.tint，所以真正决定可读性的是"混合后"的背景亮度，
 * 不是底图本身的亮度 —— 直接拿底图算会在深色图 + 高不透明度蒙版时判断反向。
 */
export function deriveInk(backdropAvg: [number, number, number] | null, veil: VeilParams, base: Ink): Ink {
  if (!backdropAvg) return base

  const bdL = relativeLuminance(...backdropAvg)
  const [tr, tg, tb] = hexToRgb(veil.tint)
  const tintL = relativeLuminance(tr, tg, tb)
  const opacity = Math.min(veil.opacity, 0.92)
  const bgL = bdL * (1 - opacity) + tintL * opacity

  // 不能用固定亮度阈值决定深浅：背景亮度落在中段时，两个方向的对比度差别很大，
  // 阈值切错会得到一个"技术上合法但根本读不清"的配色。两边都算一遍取更优的。
  const dark = contrastRatio(relativeLuminance(0, 0, 0), bgL) >= contrastRatio(relativeLuminance(255, 255, 255), bgL)

  let primary = dark ? "#33322f" : "#ebe9e3"
  let secondary = dark ? "#7b7975" : "#b9b6b0"

  primary = ensureContrast(primary, bgL, dark)
  secondary = ensureContrast(secondary, bgL, dark, 3)

  // 铜金色是品牌色，只在对比度不足时调明度，保持色相
  let accent = base.accent
  let guard = 0
  while (contrastRatio(relativeLuminance(...hexToRgb(accent)), bgL) < 3 && guard++ < 12) {
    accent = shift(accent, dark ? -0.1 : 0.1)
  }

  return { ...base, primary, secondary, accent }
}

function ensureContrast(color: string, bgL: number, darkText: boolean, min = MIN_CONTRAST): string {
  let c = color
  let guard = 0
  while (contrastRatio(relativeLuminance(...hexToRgb(c)), bgL) < min && guard++ < 20) {
    c = shift(c, darkText ? -0.08 : 0.08)
  }
  return c
}
