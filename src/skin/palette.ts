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

/**
 * 从像素里提取若干主色调。
 *
 * fast-average-color 只给一个平均色/主色，拿不到"第二、第三主色"，所以自己做一遍
 * 粗量化：把 RGB 各压到 16 级（4096 个桶）统计，再按像素数从多到少挑。
 *
 * 挑选用**最远点采样**而不是"按出现次数取前三"：色调统一的照片里，第二、第三名
 * 通常就是第一名的相邻色阶，取出来三个看着是同一个颜色。实测一张暖色调底图取出的是
 * rgb(213,193,173) / (214,191,175) / (211,193,171) —— 摆在面板上分不出来，等于白做。
 *
 * 所以先按出现次数取前 POOL 个候选（滤掉几像素的杂色），再从中反复挑"离已选的最远的
 * 那一个"。这样即便图本身色调很窄，拿到的也是它能给出的最大差异。
 *
 * @param rgba  RGBA 像素，长度须为 4 的倍数
 * @param count 要几个
 */
export function dominantColors(rgba: ArrayLike<number>, count = 3): string[] {
  const BITS = 4
  const SHIFT = 8 - BITS
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()

  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue // 透明像素不参与
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const key = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT)
    const e = buckets.get(key)
    if (e) {
      e.n++
      e.r += r
      e.g += g
      e.b += b
    } else {
      buckets.set(key, { n: 1, r, g, b })
    }
  }

  // 桶内取平均而不是取桶心：量化到 16 级之后桶心最多偏 8，平均值更接近真实颜色
  const ranked = [...buckets.values()].sort((a, b) => b.n - a.n)
  if (ranked.length === 0) return []

  // 候选池。要挡的是"几个像素的杂色"—— 那种颜色离得最远，最远点采样会一头撞上去，
  // 但它根本不是这张图的主色调。
  //
  // 门槛按**像素占比**而不是名次：名次只在桶很多时才起过滤作用，桶少的时候
  // 杂色照样排进前几名。占比不吃这个亏。名次上限只是顺带削掉长尾，省点循环。
  const total = ranked.reduce((n, e) => n + e.n, 0)
  const MIN_SHARE = 0.005
  const POOL = 48
  const pool = ranked
    .filter((e, i) => i === 0 || e.n / total >= MIN_SHARE) // 第一名无条件保留，避免池子空掉
    .slice(0, POOL)
    .map((e) => [e.r / e.n, e.g / e.n, e.b / e.n] as [number, number, number])

  const gap = (a: [number, number, number], b: [number, number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  const picked: [number, number, number][] = [pool[0]] // 最常见的那个先占位
  while (picked.length < count && picked.length < pool.length) {
    let best: [number, number, number] | null = null
    let bestGap = -1
    for (const c of pool) {
      if (picked.includes(c)) continue
      const d = Math.min(...picked.map((p) => gap(p, c)))
      if (d > bestGap) {
        bestGap = d
        best = c
      }
    }
    if (!best) break
    picked.push(best)
  }

  return picked.map(([r, g, b]) => rgbToHex(r, g, b))
}

/**
 * 把一个主色调整成"能当蒙版用"的样子。
 *
 * 直接拿原色当蒙版会翻车：蒙版是压在底图左半边、不透明度 0.89 的一大片，
 * 高饱和的原色铺这么大一片会非常刺眼，很暗的原色则会把整个左半边糊死。
 * 所以压饱和、把亮度抬进一个可用区间 —— 保留色相（认得出是从图里来的），
 * 但不喧宾夺主。
 *
 * 文字对比度不用在这里操心：deriveInk 会拿最终的 tint 重新推一遍配色。
 */
export function veilTintFrom(hex: string): string {
  const [h, s0, l0] = rgbToHsl(...hexToRgb(hex))
  // 饱和度只设上限，不按比例压 —— 按比例压就是三色变灰的元凶
  const s = Math.min(s0, VEIL_TINT_MAX_SAT)

  const lum = lumOf(hslToHex(h, s, l0))
  let l = l0
  if (lum < VEIL_TINT_MIN_LUM) l = solveLightness(h, s, VEIL_TINT_MIN_LUM)
  else if (lum > VEIL_TINT_MAX_LUM) l = solveLightness(h, s, VEIL_TINT_MAX_LUM)
  return hslToHex(h, s, l)
}

/**
 * 一次处理一组主色 —— 自动取色**必须**走这个，不能对每个色单独调 veilTintFrom。
 *
 * 逐色处理会在真实照片上垮掉，因为它保留色相、抹平明暗和饱和，而大多数照片的三个主色
 * 恰恰是同一个色相的深浅变化：
 *   backdrop-1 取到 #090603 / #dacaa9 / #996628（原始距离 176）—— 全是同一种暖色
 *   backdrop-2 取到 #878787 / #090909 / #f5f5f5 —— 灰度图，压根没有色相
 * 逐色处理完分别是 #d5c1ad/#d5c8ae/#d3c1ab（距离 3）和 #c4c4c4/#c4c4c4/#efefef（距离 0），
 * 面板上就是一个色块。**明暗正是这些图唯一的信息，不能抹掉。**
 *
 * 所以亮度不再各自往区间边缘收，而是按原始明暗次序摊到整个区间上：最暗的落到区间下沿、
 * 最亮的落到上沿、中间的居中。区间本身还是要守（蒙版是压在左半边、不透明度 0.89 的
 * 一大片，太暗糊死、太亮等于没取色），但同一个区间里三个色是分开摆的，不是叠在一起。
 *
 * 返回顺序与入参一致（入参是按出现次数排的，第一个是最主要的色），只有亮度目标按明暗
 * 次序分配。
 */
export function veilTintsFrom(hexes: string[]): string[] {
  if (hexes.length <= 1) return hexes.map(veilTintFrom)

  const prepped = hexes.map((hex, i) => {
    const [h, s0] = rgbToHsl(...hexToRgb(hex))
    return { i, h, s: Math.min(s0, VEIL_TINT_MAX_SAT), lum: lumOf(hex) }
  })

  const out: string[] = new Array(hexes.length)
  const span = VEIL_TINT_MAX_LUM - VEIL_TINT_MIN_LUM
  ;[...prepped]
    .sort((a, b) => a.lum - b.lum)
    .forEach((c, rank, all) => {
      const target = VEIL_TINT_MIN_LUM + span * (rank / (all.length - 1))
      out[c.i] = hslToHex(c.h, c.s, solveLightness(c.h, c.s, target))
    })
  return out
}

/**
 * 二分求出让 WCAG 亮度达到 target 的 HSL 明度。固定 H/S 时亮度对 L 单调递增。
 *
 * 只动明度轴、按感知亮度二分 —— 这一点是前两版翻车的地方：第一版乘系数抬亮度，
 * 暗色根本抬不动（#101018 乘到上限仍是 0.013）；第二版改成"向白混合"，混合本身
 * 就在毁饱和度，三个主色全被推进一条窄灰带。
 */
function solveLightness(h: number, s: number, target: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (lumOf(hslToHex(h, s, mid)) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * 自动取色后蒙版色的取值范围。看着不满意先调这三个数。
 *
 * 亮度区间用的是 **WCAG 相对亮度**而不是 HSL 明度：后者不是感知量，
 * 同样 L=0.62 的黄色看着比蓝色亮得多，三个色摆一起会明暗不齐。
 * 蒙版是压在左半边、不透明度 0.89 的一大片，太暗会把整个左半边糊死；
 * 太亮又和默认的近白色（#f7f5f0，亮度约 0.90）没区别，等于白取一趟色。
 *
 * 区间两端都远在"深色文字胜出"的一侧（亮度 0.55 对黑字对比度已有 12:1），
 * 所以三色轮换不会让 deriveInk 的深浅判断来回翻，文字不会一段黑一段白。
 */
const VEIL_TINT_MIN_LUM = 0.55
const VEIL_TINT_MAX_LUM = 0.86
const VEIL_TINT_MAX_SAT = 0.32

const lumOf = (hex: string): number => relativeLuminance(...hexToRgb(hex))

/** RGB(0..255) → HSL(0..1) */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6
  else if (max === gg) h = ((bb - rr) / d + 2) / 6
  else h = ((rr - gg) / d + 4) / 6
  return [h, s, l]
}

/** HSL(0..1) → #rrggbb */
export function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) return rgbToHex(l * 255, l * 255, l * 255)
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const at = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return rgbToHex(at(h + 1 / 3) * 255, at(h) * 255, at(h - 1 / 3) * 255)
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
