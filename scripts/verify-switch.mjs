/**
 * 切歌延迟（PRD F1.6：曲目结束自动进入下一首，切换间隔 < 200ms）。
 *
 * 量的是**从调用 next() 到状态变成 playing** 的墙钟时间，并且同时证明预取真的省掉了
 * 那次读文件 —— 只报一个毫秒数说明不了是预取起了作用还是这台机器碰巧快。
 *
 * 前置：npm run dev 已在 1420 端口运行；tests/real/ 下有真实音频。
 *
 *   node scripts/verify-switch.mjs
 */
import { chromium } from "playwright"
import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const REAL = resolve("tests/real")

if (!existsSync(REAL)) {
  console.error("tests/real/ 不存在，先跑 node scripts/fetch-real-assets.mjs")
  process.exit(1)
}
const files = readdirSync(REAL)
  .filter((f) => /\.(mp3|ogg|flac|wav|m4a)$/i.test(f))
  .map((f) => resolve(REAL, f))
if (files.length < 3) {
  console.error(`tests/real/ 下只有 ${files.length} 个音频，至少要 3 个才能测切歌`)
  process.exit(1)
}

const checks = []
const check = (name, ok, detail = "") => checks.push([name, !!ok, detail])

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage()
const errors = []
page.on("pageerror", (e) => errors.push(e.message))

await page.goto(URL, { waitUntil: "domcontentloaded" })
await page.waitForFunction(() => !!window.__player, null, { timeout: 15000 })

const chooser = page.waitForEvent("filechooser")
await page.click('button:has-text("添加音乐文件")')
await (await chooser).setFiles(files)
await page.waitForFunction((n) => window.__lib.getState().tracks.length >= n, files.length, {
  timeout: 30000,
})

/*
 * 数一数切歌那一刻还读不读文件。
 *
 * platform 是个普通对象字面量，dev server 下 `import('/src/platform/index.ts')` 拿到的
 * 就是应用正在用的那一份实例（vite 按 URL 去重），所以直接包一层就能计数。
 */
await page.evaluate(async () => {
  const m = await import("/src/platform/index.ts")
  window.__reads = 0
  const orig = m.platform.readFile.bind(m.platform)
  m.platform.readFile = (ref) => {
    window.__reads++
    return orig(ref)
  }
})

const result = await page.evaluate(async () => {
  const player = window.__player
  const tracks = window.__lib.getState().tracks

  const waitPlaying = async () => {
    for (let i = 0; i < 200; i++) {
      if (player.getState().status === "playing") return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  }

  await player.getState().playFrom(tracks, 0)
  const started = await waitPlaying()

  // 预取有 1.5 秒的延后（别和刚起播时的封面歌词抢），等它做完
  await new Promise((r) => setTimeout(r, 4000))

  // ── 预取命中：直接切下一首 ──
  const readsBefore = window.__reads
  const t0 = performance.now()
  await player.getState().next()
  const warmMs = performance.now() - t0
  const warmReads = window.__reads - readsBefore
  const warmOk = player.getState().status === "playing"

  // ── 没有预取：跳到再下一首（预取的是 index+1，这里跳 index+2）──
  await new Promise((r) => setTimeout(r, 300))
  const idx = player.getState().index
  const coldTarget = (idx + 2) % tracks.length
  const readsBefore2 = window.__reads
  const t1 = performance.now()
  await player.getState().playAt(coldTarget)
  const coldMs = performance.now() - t1
  const coldReads = window.__reads - readsBefore2

  return {
    started,
    count: tracks.length,
    warmMs,
    warmReads,
    warmOk,
    coldMs,
    coldReads,
    status: player.getState().status,
  }
})

await browser.close()

console.log(`曲目 ${result.count} 首`)
console.log(`预取命中切歌：${result.warmMs.toFixed(0)}ms（期间读文件 ${result.warmReads} 次）`)
console.log(`未预取切歌：  ${result.coldMs.toFixed(0)}ms（期间读文件 ${result.coldReads} 次）\n`)

check("首曲能播起来", result.started)
check("切歌后仍在播放", result.warmOk && result.status === "playing")
check(
  "F1.6：切换间隔 < 200ms",
  result.warmMs < 200,
  `${result.warmMs.toFixed(0)}ms`,
)
// 这一条才证明是预取起的作用：命中时切歌路径上一次文件都没读
check("预取命中时切歌不再读文件", result.warmReads === 0, `${result.warmReads} 次`)
check("未预取时确实要读一次文件（对照组成立）", result.coldReads === 1, `${result.coldReads} 次`)
check("预取不比不预取慢", result.warmMs <= result.coldMs + 5, `${result.warmMs.toFixed(0)} vs ${result.coldMs.toFixed(0)}ms`)
check("全程无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "))

let bad = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  —— ${detail}` : ""}`)
  if (!ok) bad++
}
console.log(bad ? `\n✗ ${bad} / ${checks.length} 项未通过` : `\n✓ 切歌检查全部通过（${checks.length} 项）`)
process.exit(bad ? 1 : 0)
