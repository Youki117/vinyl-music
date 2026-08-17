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

const REAL = resolve("tests/real")
const images = readdirSync(REAL).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
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

for (const name of images) {
  const b64 = readFileSync(resolve(REAL, name)).toString("base64")
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

      const rawLeft = dominantColors(grab(left), 3)
      const rawFull = dominantColors(grab(W), 3)
      return {
        dims: `${img.naturalWidth}x${img.naturalHeight}`,
        rawLeft,
        tintLeft: veilTintsFrom(rawLeft),
        rawFull,
        tintFull: veilTintsFrom(rawFull),
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
  line("整张 原始主色", out.rawFull)
  line("整张 过滤后", out.tintFull)
}

await browser.close()
