/**
 * 测定参考素材本身的 SSIM 上限。
 *
 * 用户给的两张参考图是同一份设计的两次录屏（分辨率不同）。把它们互相对拍，
 * 得到的分数就是"完美还原"在这套素材上能拿到的理论最高分 —— 任何实现都不可能
 * 超过它。这个数字决定了 PRD A5 的阈值该定在哪里。
 *
 *   node scripts/reference-ceiling.mjs
 */
import { readFileSync } from "node:fs"
import { PNG } from "pngjs"

const A = "design-ref/target/ref-veil-primary.png"
const B = "design-ref/figma-make/figma-input.png"
const W = 1243
const H = 688
const COMPARE_RIGHT = 0.52
const DISC = { cx: 359, cy: 344, r: 153 }

const a = PNG.sync.read(readFileSync(A))
const b = PNG.sync.read(readFileSync(B))
const sa = strip(a)
const sb = strip(b)

console.log(`${A}  剥黑边后 ${sa.width}×${sa.height}  比例 ${(sa.width / sa.height).toFixed(3)}`)
console.log(`${B}  剥黑边后 ${sb.width}×${sb.height}  比例 ${(sb.width / sb.height).toFixed(3)}`)

const ga = gray(resize(sa, W, H))
const gb = gray(resize(sb, W, H))

const full = ssim(ga, gb, false)
const noDisc = ssim(ga, gb, true)

console.log(`\n两张参考图互相对拍（同一份设计的两次录屏）`)
console.log(`  含黑胶   SSIM = ${full.toFixed(4)}`)
console.log(`  排除黑胶 SSIM = ${noDisc.toFixed(4)}`)
console.log(
  `\n这就是本套素材的理论上限：完美还原也不可能超过它。` +
    `\nPRD A5 的阈值必须定在这个数字之下才有意义。`,
)

function ssim(x, y, excludeDisc) {
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  const B = 8
  const limit = Math.round(W * COMPARE_RIGHT)
  let total = 0
  let n = 0
  for (let by = 0; by + B <= H; by += B) {
    for (let bx = 0; bx + B <= limit; bx += B) {
      const cx = bx + B / 2 - DISC.cx
      const cy = by + B / 2 - DISC.cy
      const r = excludeDisc ? DISC.r : 96
      if (cx * cx + cy * cy < r * r) continue
      let ma = 0,
        mb = 0
      for (let j = 0; j < B; j++)
        for (let i = 0; i < B; i++) {
          ma += x[(by + j) * W + bx + i]
          mb += y[(by + j) * W + bx + i]
        }
      const c = B * B
      ma /= c
      mb /= c
      let va = 0,
        vb = 0,
        cov = 0
      for (let j = 0; j < B; j++)
        for (let i = 0; i < B; i++) {
          const da = x[(by + j) * W + bx + i] - ma
          const db = y[(by + j) * W + bx + i] - mb
          va += da * da
          vb += db * db
          cov += da * db
        }
      va /= c - 1
      vb /= c - 1
      cov /= c - 1
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      n++
    }
  }
  return n ? total / n : 0
}

function strip(png) {
  const { width: w, height: h, data } = png
  const l = (x, y) => {
    const i = (y * w + x) * 4
    return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
  }
  const col = (x) => {
    let s = 0
    for (let y = 0; y < h; y += 3) s += l(x, y)
    return s / Math.ceil(h / 3)
  }
  const row = (y) => {
    let s = 0
    for (let x = 0; x < w; x += 3) s += l(x, y)
    return s / Math.ceil(w / 3)
  }
  let L = 0,
    R = w - 1,
    T = 0,
    Bm = h - 1
  while (L < w / 3 && col(L) < 0.02) L++
  while (R > (w * 2) / 3 && col(R) < 0.02) R--
  while (T < h / 3 && row(T) < 0.02) T++
  while (Bm > (h * 2) / 3 && row(Bm) < 0.02) Bm--
  const nw = R - L + 1
  const nh = Bm - T + 1
  const out = new PNG({ width: nw, height: nh })
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++) {
      const s = ((y + T) * w + (x + L)) * 4
      const d = (y * nw + x) * 4
      out.data[d] = data[s]
      out.data[d + 1] = data[s + 1]
      out.data[d + 2] = data[s + 2]
      out.data[d + 3] = 255
    }
  return out
}

function resize(png, tw, th) {
  const { width: w, height: h, data } = png
  if (w === tw && h === th) return png
  const out = new PNG({ width: tw, height: th })
  for (let y = 0; y < th; y++) {
    const sy = ((y + 0.5) * h) / th - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(h - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < tw; x++) {
      const sx = ((x + 0.5) * w) / tw - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(w - 1, x0 + 1)
      const fx = sx - x0
      const d = (y * tw + x) * 4
      for (let c = 0; c < 3; c++) {
        out.data[d + c] =
          data[(y0 * w + x0) * 4 + c] * (1 - fx) * (1 - fy) +
          data[(y0 * w + x1) * 4 + c] * fx * (1 - fy) +
          data[(y1 * w + x0) * 4 + c] * (1 - fx) * fy +
          data[(y1 * w + x1) * 4 + c] * fx * fy
      }
      out.data[d + 3] = 255
    }
  }
  return out
}

function gray(png) {
  const g = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const j = i * 4
    g[i] = 0.2126 * png.data[j] + 0.7152 * png.data[j + 1] + 0.0722 * png.data[j + 2]
  }
  return g
}
