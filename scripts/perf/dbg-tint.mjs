/**
 * 定位"三个主色几乎一样"到底出在哪一步。
 *
 * 链路是 采样区域 → dominantColors → veilTintFrom → 面板色块。
 * 单色单元测试全绿、端到端却是三个相邻色阶，说明问题不在 veilTintFrom 的单色行为上。
 * 这里把每一步的中间结果都打出来，顺便对比"只取左 40%"和"整张图"的差别 ——
 * extractTints 只采左边（蒙版压在左半边），如果那半边本来就是一面素墙，
 * 那就不是算法的问题，是采样区域的问题。
 *
 *   node scripts/perf/dbg-tint.mjs
 */
import { chromium } from "playwright"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// 不给参数就跑 tests/real/ 的素材；给了就跑指定的图（用来诊断用户实际在用的底图）
const args = process.argv.slice(2)
const REAL = resolve("tests/real")
const images =
  args.length > 0
    ? args.map((a) => resolve(a))
    : readdirSync(REAL)
        .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        .map((f) => resolve(REAL, f))
if (images.length === 0) {
  console.error("tests/real/ 里没有图片")
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage()
// 直接从 dev server 拿源码，省得在 node 里重实现一遍量化逻辑
await page.goto(process.env.VINYL_URL ?? "http://localhost:1420/", { waitUntil: "networkidle" })

const gap = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

for (const path of images) {
  const name = path.split(/[\\/]/).pop()
  const b64 = readFileSync(path).toString("base64")
  const ext = name.split(".").pop().toLowerCase()
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg"

  const out = await page.evaluate(
    async ({ dataUrl }) => {
      const { dominantColors, veilTintsFrom } = await import("/src/skin/palette.ts")
      const img = new Image()
      await new Promise((res, rej) => {
        img.onload = res
        img.onerror = rej
        img.src = dataUrl
      })
      const W = 96
      const H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W))
      const c = document.createElement("canvas")
      c.width = W
      c.height = H
      const ctx = c.getContext("2d", { willReadFrequently: true })
      ctx.drawImage(img, 0, 0, W, H)

      const left = Math.max(1, Math.round(W * 0.4))
      const grab = (w) => Array.from(ctx.getImageData(0, 0, w, H).data)

      // 换个分辨率再采一遍：小面积的高饱和强调色（发光的火星）在低分辨率下会被
      // 周围的暗背景平均掉，采样宽度本身就可能是"取不到那个红"的原因
      const hi = 320
      const hiH = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * hi))
      const c2 = document.createElement("canvas")
      c2.width = hi
      c2.height = hiH
      const ctx2 = c2.getContext("2d", { willReadFrequently: true })
      ctx2.drawImage(img, 0, 0, hi, hiH)
      const rawHi = dominantColors(Array.from(ctx2.getImageData(0, 0, hi, hiH).data), 3)

      // 把候选簇直接列出来。"为什么没取到那个红"只有两种可能：它压根不在候选里
      // （面积太小 / 被合并掉了），还是在候选里但没被最远点选中。列出来才分得清。
      const px = grab(W)
      const buckets = new Map()
      for (let i = 0; i + 3 < px.length; i += 4) {
        if (px[i + 3] < 128) continue
        const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4)
        const e = buckets.get(key)
        if (e) {
          e.n++
          e.r += px[i]
          e.g += px[i + 1]
          e.b += px[i + 2]
        } else buckets.set(key, { n: 1, r: px[i], g: px[i + 1], b: px[i + 2] })
      }
      const rk = [...buckets.values()].sort((a, b) => b.n - a.n)
      const tot = rk.reduce((n, e) => n + e.n, 0)
      const gp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
      const cl = []
      for (const e of rk) {
        const c = [e.r / e.n, e.g / e.n, e.b / e.n]
        const hit = cl.find((k) => gp(k.rgb, c) < 40)
        if (hit) hit.n += e.n
        else cl.push({ rgb: c, n: e.n })
      }
      cl.sort((a, b) => b.n - a.n)
      const dump = cl.slice(0, 12).map((k) => {
        const [r, g, b] = k.rgb.map(Math.round)
        const mx = Math.max(r, g, b)
        const mn = Math.min(r, g, b)
        return {
          hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
          share: ((k.n / tot) * 100).toFixed(2),
          sat: mx === 0 ? "0.00" : ((mx - mn) / mx).toFixed(2),
        }
      })

      const rawLeft = dominantColors(grab(left), 3)
      const rawFull = dominantColors(grab(W), 3)
      return {
        dims: `${img.naturalWidth}x${img.naturalHeight}`,
        rawLeft,
        tintLeft: veilTintsFrom(rawLeft),
        rawFull,
        tintFull: veilTintsFrom(rawFull),
        rawHi,
        tintHi: veilTintsFrom(rawHi),
        dump,
      }
    },
    { dataUrl: `data:${mime};base64,${b64}` },
  )

  const line = (label, hexes) => {
    const rgb = hexes.map(toRgb)
    const gaps = []
    for (let i = 0; i < rgb.length; i++) for (let j = i + 1; j < rgb.length; j++) gaps.push(gap(rgb[i], rgb[j]))
    const min = gaps.length ? Math.min(...gaps) : 0
    console.log(`  ${label.padEnd(18)} ${hexes.join("  ")}   最近两色距离 ${min}`)
  }

  console.log(`\n${name}  (${out.dims})`)
  line("左40% 原始主色", out.rawLeft)
  line("左40% 过滤后", out.tintLeft)
  line("整张96 原始主色", out.rawFull)
  line("整张96 过滤后", out.tintFull)
  line("整张320 原始主色", out.rawHi)
  line("整张320 过滤后", out.tintHi)
  console.log(`  候选簇（整张96，按面积降序）`)
  for (const d of out.dump) console.log(`    ${d.hex}  占比 ${d.share.padStart(5)}%  饱和 ${d.sat}`)
}

await browser.close()
