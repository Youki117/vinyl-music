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

  const total = ranked.reduce((n, e) => n + e.n, 0)
  const gap = (a: [number, number, number], b: [number, number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  // 先聚类，再过占比门槛。
  //
  // 量化会把一片渐变打散成几十个小桶 —— 火星飞溅的红、草丛里的橙花都是这种形状。
  // 每个小桶单独都够不着门槛，于是整个强调色凭空消失。而人眼说的"最鲜明的颜色"
  // 恰恰常常正是这类面积不大的强调色，不是面积最大的那片背景。
  //
  // 簇的代表色取**簇内最常见的那个桶**，不取全簇平均：平均会把强调色朝周围的
  // 背景色拉回去，等于又抹平一次。
  // 60 而不是 40：一片背景的明暗过渡（近黑 → 暗栗 → 灰栗）在感知上就是"那片暗底"，
  // 分成三个簇的话它们会各自带着不低的分数去抢名额，三个位置全被同一片暗底占掉。
  const MERGE = 60
  const clusters: { rgb: [number, number, number]; n: number }[] = []
  for (const e of ranked) {
    const c: [number, number, number] = [e.r / e.n, e.g / e.n, e.b / e.n]
    const hit = clusters.find((k) => gap(k.rgb, c) < MERGE)
    if (hit) hit.n += e.n
    else clusters.push({ rgb: c, n: e.n })
  }
  clusters.sort((a, b) => b.n - a.n) // 合并改了权重，重排

  // 先过资格线，再按"显眼程度"排 —— 不是按面积排。
  //
  // 按面积排是错的：面积最大的几乎总是背景。实测那张暗色人物图，近黑的 #0b0809
  // 占了 85.51%，于是它必然是第一名，后面两个也只能在剩下的面积顺序里挑。
  // 而人在说"这张图最明显的三个颜色"时，指的是最跳眼的那几个，不是铺得最满的那个。
  //
  // 资格线仍然按面积（挡几个像素的杂色），且随饱和度下调：越鲜艳，占的面积可以越小。
  // 画面上一小片发光的火星按面积一刀切正好会被滤掉，只剩大片暗色。
  // ABS_MIN 给这个让步兜底 —— 再鲜艳，几个像素也还是杂色。
  const MIN_SHARE = 0.008
  const ABS_MIN = 0.0025
  const satOf = (c: [number, number, number]) => rgbToHsl(c[0], c[1], c[2])[1]

  // 面积开根号压一下：不压的话一片背景的权重能盖过一切，压过头又会挑到犄角旮旯。
  const score = (k: { rgb: [number, number, number]; n: number }) =>
    0.6 * satOf(k.rgb) + 0.4 * Math.sqrt(k.n / total)

  const qualified = clusters.filter(
    (k, i) => i === 0 || k.n / total >= Math.max(ABS_MIN, MIN_SHARE * (1 - 0.75 * satOf(k.rgb))),
  )
  const POOL = 8
  const pool = [...qualified]
    .sort((a, b) => score(b) - score(a))
    .slice(0, POOL)
    .map((k) => k.rgb)

  // 后两个也按显眼程度挑，距离只当**去重护栏**用，不当目标。
  //
  // 只按距离挑（纯最远点采样）会挑错：那张暗色人物图里血红 #551718 就在候选里，
  // 但离黑底只有 88，而一块浅灰粉离黑底有 266，纯比距离就把浅灰粉挑走了 —— 一张
  // 满屏血红的图，取出来的三个色里没有红。
  // 所以距离超过 DIVERSITY 之后就不再加分（够分得开就行），剩下的交给显眼程度。
  // 除了颜色要分得开，**明暗也要分得开**。
  //
  // 只看 RGB 距离不够：两个深色天生就挨得近，于是一张暗调图会把三个名额全给暗色，
  // 画面上那块亮的（人物的衣服、高光）永远选不上 —— 而那恰恰是人一眼会看到的第三个色。
  // 所以再加一道明暗护栏，和颜色护栏一样只到阈值为止，够开就不再加分。
  const DIVERSITY = 90
  const LUM_SPREAD = 0.1
  const picked: [number, number, number][] = [pool[0]] // 最显眼的那个先占位
  const rest = qualified.filter((k) => k.rgb !== pool[0])
  while (picked.length < count && rest.length > 0) {
    let best = -1
    let bestScore = -1
    rest.forEach((k, i) => {
      const near = Math.min(...picked.map((p) => gap(p, k.rgb)))
      const lum = relativeLuminance(...k.rgb)
      const nearLum = Math.min(...picked.map((p) => Math.abs(relativeLuminance(...p) - lum)))
      const s =
        score(k) * Math.min(1, near / DIVERSITY) * Math.min(1, nearLum / LUM_SPREAD)
      if (s > bestScore) {
        bestScore = s
        best = i
      }
    })
    if (best < 0) break
    picked.push(rest[best].rgb)
    rest.splice(best, 1)
  }

  return picked.map(([r, g, b]) => rgbToHex(r, g, b))
}

/**
 * 把一个主色调整成"能当蒙版用"的样子。**基本是原样放行，只挡两个极端。**
 *
 * 这里前后错了三版，根子都是同一个：想当然地认为蒙版必须是浅色，于是把亮度硬压进
 * 一个窄而浅的区间。结果是取出来的色再准也没用 —— 实测四张底图十二个色，
 * 没有一个不是淡的：
 *   #a65927（饱满的铁锈橙）→ #f4ede9（近白）
 *   #0b0808 #543737 #2c2224（黑 + 血红，正是人眼看到的）→ 三个几乎一样的淡粉
 * 而用户自己手调的蒙版色是 #5e0d0d，亮度 0.028 —— 想要的方向和那个区间正相反。
 *
 * 所以现在只做两件事：把饱和度压到不刺眼（挡霓虹），把亮度挡在纯黑纯白之外
 * （纯黑丢色相，纯白等于没蒙版）。中间一律原样。
 *
 * 文字可读性不在这里管：Stage 会拿**当前生效的** tint 走一遍 deriveInk，
 * 蒙版变深文字就跟着变浅。
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
 * 一组主色一起过滤。
 *
 * 上一版这里做的是"把三个色按明暗次序摊到亮度区间上"，那是为了补救区间太窄导致
 * 三色撞在一起。区间放开之后这个补救就不需要了，而且有害：三个色原始亮度挤在
 * 0.03/0.13/0.15 时，硬摊开会把只亮了一点点的那个推到区间顶端 —— 铁锈橙变白就是
 * 这么来的。**保真优先于拉开差异**：原图里差多少，出来就差多少。
 *
 * 保留这个函数而不是让调用方自己 map，是因为"整组一起看"这个约束值得留在类型上：
 * 以后要加"三色太接近时轻推一下"之类的规则，入口在这里。
 */
export function veilTintsFrom(hexes: string[]): string[] {
  return hexes.map(veilTintFrom)
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
 * 这是**护栏，不是风格**——区间开得很宽，绝大多数颜色原样通过。三个数各挡一件事：
 *
 * - MIN_LUM：纯黑没有色相，铺一大片就是个黑块，看不出是从图里来的。只要抬离纯黑，
 *   不要抬到"看得出变亮"—— 0.004 大约相当于 #0d0d0d。这个数放大到 0.015 就已经会
 *   把 #0b0808 顶到 #2c2224 身上，两个原本差 50 的色挤成差 7，保真度当场就没了。
 * - MAX_LUM：太亮就和没有蒙版没区别（默认色 #f7f5f0 亮度约 0.90）。
 * - MAX_SAT：0.89 不透明度、占屏幕小一半的一整片纯色，饱和度拉满会刺眼。0.7 只挡霓虹。
 *
 * 亮度用 **WCAG 相对亮度**而不是 HSL 明度：后者不是感知量，同样 L=0.62 的黄色
 * 看着比蓝色亮得多。
 */
const VEIL_TINT_MIN_LUM = 0.004
const VEIL_TINT_MAX_LUM = 0.9
const VEIL_TINT_MAX_SAT = 0.7

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
