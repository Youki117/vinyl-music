/**
 * 从参考图上实测蒙版边缘剖面。
 *
 * 三张参考图画幅各不相同（录屏的不同裁切），Figma 版本的 CSS 坐标又是被压扁过
 * 的，都不能直接采信。这里直接量像素，产出着色器参数的初值。
 *
 * 两个必须先处理掉的干扰：录屏留下的信箱黑边，以及左侧的 UI 元素（黑胶、文字）。
 *
 *   node scripts/analyze-ref.mjs design-ref/target/ref-ui-dark.png
 */
import { readFileSync } from "node:fs"
import { PNG } from "pngjs"

const file = process.argv[2] ?? "design-ref/target/ref-ui-dark.png"
const png = PNG.sync.read(readFileSync(file))
const { width: W0, height: H0, data } = png

const rawLum = (x, y) => {
  const i = (y * W0 + x) * 4
  return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
}

// ── 剥掉信箱黑边 ──────────────────────────────────────────────────
const colDark = (x) => {
  let s = 0
  for (let y = 0; y < H0; y += 3) s += rawLum(x, y)
  return s / Math.ceil(H0 / 3)
}
const rowDark = (y) => {
  let s = 0
  for (let x = 0; x < W0; x += 3) s += rawLum(x, y)
  return s / Math.ceil(W0 / 3)
}
let L = 0,
  R = W0 - 1,
  T = 0,
  B = H0 - 1
while (L < W0 / 3 && colDark(L) < 0.02) L++
while (R > (W0 * 2) / 3 && colDark(R) < 0.02) R--
while (T < H0 / 3 && rowDark(T) < 0.02) T++
while (B > (H0 * 2) / 3 && rowDark(B) < 0.02) B--

const W = R - L + 1
const H = B - T + 1
const lum = (u, v) => rawLum(L + u, T + v)

console.log(`图像 ${file}`)
console.log(`原始 ${W0}×${H0}  剥黑边后 ${W}×${H} (比例 ${(W / H).toFixed(3)})  裁切 L=${L} R=${W0 - 1 - R} T=${T} B=${H0 - 1 - B}`)

// ── 亮度剖面 ──────────────────────────────────────────────────────
// 只取右半区（x > 0.55W）：黑胶与歌词都在左边，会污染测量。
// 蒙版的过渡带落在这个区间内，正是要量的东西。
const SAMPLE_ROWS = [0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.92]
console.log("\n── 水平亮度剖面（列 = x/W，行 = y/H）──")
const cols = []
for (let f = 0.3; f <= 0.96; f += 0.04) cols.push(f)
process.stdout.write("  y\\x  ")
for (const c of cols) process.stdout.write(c.toFixed(2).slice(1).padStart(5))
process.stdout.write("\n")
for (const ry of SAMPLE_ROWS) {
  const y = Math.round(ry * (H - 1))
  process.stdout.write(` ${ry.toFixed(2)}  `)
  for (const c of cols) {
    const x = Math.round(c * (W - 1))
    // 纵向取 5 个像素中位数，压掉噪点
    const v = [-2, -1, 0, 1, 2].map((d) => lum(x, Math.min(H - 1, Math.max(0, y + d)))).sort((a, b) => a - b)[2]
    process.stdout.write(v.toFixed(2).padStart(5))
  }
  process.stdout.write("\n")
}

// ── 拟合边缘：亮度降到 (max+min)/2 的位置 ──────────────────────────
const mids = []
const widths = []
for (let y = 0; y < H; y += 2) {
  const prof = []
  for (let x = Math.floor(W * 0.3); x < W; x++) prof.push(lum(x, y))
  const hi = Math.max(...prof.slice(0, Math.floor(prof.length * 0.15)))
  const lo = Math.min(...prof.slice(Math.floor(prof.length * 0.8)))
  if (hi - lo < 0.12) continue // 该行没有明显过渡
  const at = (frac) => {
    const target = lo + (hi - lo) * frac
    for (let i = 0; i < prof.length; i++) if (prof[i] <= target) return (Math.floor(W * 0.3) + i) / W
    return null
  }
  const p90 = at(0.9),
    p50 = at(0.5),
    p10 = at(0.1)
  if (p50 !== null && p90 !== null && p10 !== null && p10 > p90) {
    mids.push(p50)
    widths.push(p10 - p90)
  }
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)]

if (mids.length > 10) {
  console.log("\n── 边缘拟合（10%~90% 判定过渡带）──")
  console.log(`有效行 ${mids.length}`)
  console.log(`边缘中点 uEdgeX  中位 ${pct(mids, 0.5).toFixed(3)}  平均 ${avg(mids).toFixed(3)}  P10 ${pct(mids, 0.1).toFixed(3)}  P90 ${pct(mids, 0.9).toFixed(3)}`)
  console.log(`过渡带全宽        中位 ${pct(widths, 0.5).toFixed(3)}  P10 ${pct(widths, 0.1).toFixed(3)}  P90 ${pct(widths, 0.9).toFixed(3)}`)
  console.log(`→ uSoftness ≈ ${(pct(widths, 0.5) / 2).toFixed(3)}`)
  console.log(`边缘位置沿 y 的起伏幅度 ${(pct(mids, 0.9) - pct(mids, 0.1)).toFixed(3)}  （PRD A1/A2：不该是 0）`)
} else {
  console.log("\n边缘拟合样本不足")
}

// ── 白区峰值亮度 → uOpacity / uTint ──────────────────────────────
let bright = 0
const px = []
for (let y = Math.floor(H * 0.1); y < H * 0.9; y += 3)
  for (let x = Math.floor(W * 0.01); x < W * 0.1; x += 3) {
    const v = lum(x, y)
    px.push(v)
    bright = Math.max(bright, v)
  }
console.log(`\n白区亮度 峰值 ${bright.toFixed(3)}  P90 ${pct(px, 0.9).toFixed(3)}`)
