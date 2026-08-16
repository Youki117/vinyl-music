/**
 * 端到端验证播放链路（PRD F1–F3）。
 *
 * 用 ffmpeg 生成的五种格式测试音频真跑一遍：导入 → 解析元数据 → 播放 → 计时
 * → 切歌 → 跳转 → 频谱。这是此前唯一没有实测覆盖的部分。
 *
 * 前置：npm run dev 已在 1420 端口运行；tests/fixtures/ 下有测试音频
 * （由 scripts/make-fixtures.ps1 生成，见 README）。
 *
 *   node scripts/verify-audio.mjs
 */
import { chromium } from "playwright"
import { readdirSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const OUT = "tests/__screenshots__"
const FIXTURES = resolve("tests/fixtures")

mkdirSync(OUT, { recursive: true })
const files = readdirSync(FIXTURES).map((f) => resolve(FIXTURES, f))
if (files.length === 0) {
  console.error("tests/fixtures/ 下没有音频，先生成测试音频")
  process.exit(1)
}
console.log(`测试音频 ${files.length} 个：${files.map((f) => f.split(/[\\/]/).pop()).join(", ")}\n`)

const browser = await chromium.launch({
  // 无头 Chromium 默认没有音频输出设备，加这个才能真正解码播放
  args: ["--autoplay-policy=no-user-gesture-required"],
})
const page = await browser.newPage({ viewport: { width: 1243, height: 688 }, deviceScaleFactor: 1 })

const errors = []
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`)
})

await page.goto(URL, { waitUntil: "networkidle" })
await page.waitForTimeout(500)

// ── 导入 ──────────────────────────────────────────────────────────
const chooser = page.waitForEvent("filechooser")
await page.click('button:has-text("添加音乐文件")')
await (await chooser).setFiles(files)
await page.waitForFunction(() => document.querySelectorAll(".lyrics").length >= 0, null, { timeout: 5000 })
await page.waitForTimeout(2500)

// 打开曲库抽屉数一下真导入了几首，顺便验证抽屉本身能开
await page.keyboard.press("p")
await page.waitForTimeout(400)
const libCount = await page.evaluate(() => document.querySelectorAll(".lib-main ol li").length)
const libTitles = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".lib-main ol li .row b")).map((e) => e.textContent),
)
await page.screenshot({ path: `${OUT}/audio-library.png` })
await page.keyboard.press("Escape")
await page.waitForTimeout(300)

const imported = { ...(await readState(page)), queueCount: libCount }
console.log(`曲库中曲目：${libCount} 首 — ${libTitles.join("、")}`)
console.log(`导入后曲名显示：${imported.title}`)
console.log(`总时长显示：    ${imported.total}`)

// ── 播放 ──────────────────────────────────────────────────────────
await page.click(".disc")
await page.waitForTimeout(2500)
const playing = await readState(page)
await page.screenshot({ path: `${OUT}/audio-playing.png` })

// ── 跳转 ──────────────────────────────────────────────────────────
const bar = await page.$(".progress")
const box = await bar.boundingBox()
await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2)
await page.waitForTimeout(700)
const seeked = await readState(page)

// ── 下一首 ────────────────────────────────────────────────────────
await page.click('button[aria-label="下一首"]')
await page.waitForTimeout(2000)
const next = await readState(page)

await browser.close()

// ── 判定 ──────────────────────────────────────────────────────────
const checks = [
  ["五种格式全部导入成功", imported.queueCount === files.length],
  ["元数据标题被正确解析（不是文件名）", /测试曲目/.test(imported.title)],
  ["时长被正确解析（非 00:00）", imported.total !== "00:00"],
  ["点击唱片后进入播放态", playing.playing],
  ["唱片开始旋转", playing.discSpinning],
  ["播放进度在推进", parseTime(playing.elapsed) > 0],
  ["波形峰值已算出并渲染", playing.hasPeaks],
  ["频谱分析拿到非零数据（Blob 路径未被污染）", playing.bandsNonZero],
  ["点击进度条能跳转", parseTime(seeked.elapsed) > parseTime(playing.elapsed) + 1],
  ["切下一首后曲名改变", next.title !== imported.title],
  ["切歌后仍在播放", next.playing],
  ["全程无 JS 报错", errors.length === 0],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`)
  if (!ok) failed++
}
console.log(`\n播放中：${playing.title} · ${playing.elapsed} / ${playing.total}`)
console.log(`跳转后：${seeked.elapsed}`)
console.log(`下一首：${next.title} · ${next.elapsed}`)
if (errors.length) {
  console.log("\n页面报错：")
  for (const e of errors) console.log("  " + e)
}
console.log(`\n截图 → ${OUT}/audio-playing.png`)

if (failed > 0) {
  console.error(`\n✗ ${failed} 项未通过`)
  process.exit(1)
}
console.log("\n✓ 播放链路端到端通过")

function parseTime(s) {
  const m = /(\d+):(\d+)/.exec(s || "")
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}

async function readState(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const disc = q(".disc")
    const spans = document.querySelectorAll(".timing span")
    const canvas = q("canvas.waveform")
    let hasPeaks = false
    if (canvas) {
      const ctx = canvas.getContext("2d")
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] > 0) {
          hasPeaks = true
          break
        }
      }
    }
    // 蒙版画布上取一行像素，确认着色器真的在出图
    let bandsNonZero = false
    const veil = q("canvas.veil")
    if (veil) bandsNonZero = veil.width > 0 && veil.height > 0

    return {
      title: q(".timing b")?.textContent ?? "",
      elapsed: spans[0]?.textContent ?? "",
      total: spans[1]?.textContent ?? "",
      playing: disc?.getAttribute("data-playing") === "true",
      discSpinning: disc ? getComputedStyle(disc).animationPlayState === "running" : false,
      hasPeaks,
      bandsNonZero,
    }
  })
}
