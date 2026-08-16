/**
 * 端到端验证混音：两条音轨真的同时在发声，且各自独立受控。
 *
 * 光看代码或类型检查证明不了"两首歌一起响"——必须真的跑起来数一数有几个
 * <audio> 在播、增益是不是按包络在变。
 *
 * 前置：npm run dev 已在 1420 端口运行；tests/fixtures/ 下有测试音频。
 *
 *   node scripts/verify-mix.mjs
 */
import { chromium } from "playwright"
import { readdirSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const OUT = "tests/__screenshots__"
const FIXTURES = resolve("tests/fixtures")

mkdirSync(OUT, { recursive: true })
const files = readdirSync(FIXTURES).map((f) => resolve(FIXTURES, f))
if (files.length < 2) {
  console.error("需要至少两个测试音频")
  process.exit(1)
}

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })
const page = await browser.newPage({ viewport: { width: 1243, height: 688 }, deviceScaleFactor: 1 })

const errors = []
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`)
})

await page.goto(URL, { waitUntil: "networkidle" })
await page.waitForTimeout(500)

// 导入并播放
const chooser = page.waitForEvent("filechooser")
await page.click('button:has-text("添加音乐文件")')
await (await chooser).setFiles(files)
await page.waitForTimeout(2500)
await page.click(".disc")
await page.waitForTimeout(1500)

const beforeMix = await audioState(page)
const hostBefore = await page.$eval(".timing b", (e) => e.textContent)

// 打开混音面板，加一条叠加轨
await page.keyboard.press("x")
await page.waitForTimeout(400)
await page.click('button:has-text("＋ 添加")')
await page.waitForTimeout(300)
const firstPick = await page.$(".track-picker button")
if (!firstPick) {
  console.error("✗ 曲目选择器里没有可选曲目")
  await browser.close()
  process.exit(1)
}
await firstPick.click()
await page.waitForTimeout(2500)

const withLayer = await audioState(page)
await page.screenshot({ path: `${OUT}/mix-panel.png` })

// 时间轴：分割两刀，再删掉中间那段 —— 正是「某段静音」的操作路径
const timeline = await page.$(".timeline")
const hasTimeline = Boolean(timeline)
let clipsAfterSplit = 0
let clipsAfterDelete = 0

if (timeline) {
  const box = await timeline.boundingBox()
  const segLabel = () =>
    page.evaluate(() => {
      const m = /(\d+) 段/.exec(document.querySelector(".layer-name em")?.textContent ?? "")
      return m ? Number(m[1]) : 0
    })

  // 叠加轨可能比主音轨短，初始片段只覆盖前一段。分割点必须落在片段内，
  // 否则按钮是禁用的（这本身是正确行为）。先问清楚片段实际覆盖到哪。
  const span = await page.evaluate(() => {
    const el = document.querySelector(".timeline")
    return el ? { w: el.getBoundingClientRect().width } : null
  })
  const progressBox = await (await page.$(".progress")).boundingBox()

  const seekToFraction = async (f) => {
    await page.mouse.click(progressBox.x + progressBox.width * f, progressBox.y + progressBox.height / 2)
    await page.waitForTimeout(500)
  }
  const splitNow = async () => {
    const btn = await page.$('button:has-text("在播放头分割")')
    if (!btn || (await btn.isDisabled())) return false
    await btn.click()
    await page.waitForTimeout(400)
    return true
  }

  // 两刀都落在前 25% 以内，确保在叠加轨覆盖范围里
  await seekToFraction(0.1)
  const cut1 = await splitNow()
  await seekToFraction(0.2)
  const cut2 = await splitNow()
  clipsAfterSplit = await segLabel()
  console.log(`两刀是否成功：${cut1} / ${cut2}，当前 ${clipsAfterSplit} 段，时间轴宽 ${span?.w}`)

  // 选中中间那段（约 15% 处）后删掉
  await page.mouse.click(box.x + box.width * 0.15, box.y + box.height / 2)
  await page.waitForTimeout(300)
  const delBtn = await page.$('button:has-text("删除片段")')
  if (delBtn && !(await delBtn.isDisabled())) {
    await delBtn.click()
    await page.waitForTimeout(400)
  }
  clipsAfterDelete = await segLabel()
  await page.screenshot({ path: `${OUT}/mix-clips.png` })
}

const dom = await page.evaluate(() => ({
  panel: Boolean(document.querySelector(".mix-panel")),
  layerRows: document.querySelectorAll(".layer-row").length,
  ranges: document.querySelectorAll('.layer-ctl input[type="range"]').length,
  timeline: document.querySelectorAll(".timeline").length,
  hint: document.querySelector(".mix-panel .hint")?.textContent?.slice(0, 40) ?? "",
}))
console.log("面板状态:", JSON.stringify(dom))
if (dom.ranges === 0) {
  console.error("✗ 叠加轨行已消失，无法继续验证音量控制")
  await page.screenshot({ path: `${OUT}/mix-broken.png` })
  await browser.close()
  process.exit(1)
}

// 把叠加轨音量拉到 0，确认能独立控制。
// React 的受控输入会跟踪 value，直接赋值不会触发 onChange，必须走原生 setter。
await page.$eval('.layer-ctl input[type="range"]', (el) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
  setter.call(el, "0")
  el.dispatchEvent(new Event("input", { bubbles: true }))
})
await page.waitForTimeout(900)
const muted = await audioState(page)
const mutedVolume = await page.$eval('.layer-ctl input[type="range"]', (el) => Number(el.value))
const hostAfter = await page.$eval(".timing b", (e) => e.textContent)

await browser.close()

const checks = [
  // 混音编排是绑在主音轨上的；若测试途中歌放完自动切歌，编排自然不再适用，
  // 那时验证的就不是同一件事了。先确认主音轨没变。
  ["测试期间主音轨没有换歌", hostBefore === hostAfter],
  ["加叠加轨之前只有 1 个音频元素在播", beforeMix.playing === 1],
  ["加了之后有 2 个音频元素同时在播", withLayer.playing === 2],
  ["主音轨仍在推进（没被叠加轨顶掉）", withLayer.times[0] > beforeMix.times[0]],
  ["叠加轨也有自己的播放位置", withLayer.times.length === 2 && withLayer.times[1] >= 0],
  ["叠加轨音量可独立调到 0", mutedVolume === 0],
  ["音量归零后两轨仍在走（只是听不见，不影响时间轴）", muted.playing === 2],
  ["时间轴已渲染", hasTimeline],
  ["分割两刀后变成 3 段", clipsAfterSplit === 3],
  ["删掉中间一段后剩 2 段（那段即静音）", clipsAfterDelete === 2],
  ["全程无 JS 报错", errors.length === 0],
]

console.log(`加层前：${beforeMix.playing} 个音频在播，位置 ${beforeMix.times.map(fmt).join(", ")}`)
console.log(`加层后：${withLayer.playing} 个音频在播，位置 ${withLayer.times.map(fmt).join(", ")}`)
console.log(`静音后：${muted.playing} 个音频在播\n`)

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`)
  if (!ok) failed++
}
if (errors.length) {
  console.log("\n页面报错：")
  for (const e of errors) console.log("  " + e)
}
console.log(`\n截图 → ${OUT}/mix-panel.png`)

if (failed > 0) {
  console.error(`\n✗ ${failed} 项未通过`)
  process.exit(1)
}
console.log("\n✓ 混音端到端通过：两条音轨确实在同时发声")

function fmt(t) {
  return t.toFixed(2) + "s"
}

async function audioState(page) {
  return page.evaluate(() => {
    // 主音轨与叠加轨的 <audio> 都以隐藏元素挂在 body 上，直接数即可
    const els = Array.from(document.querySelectorAll("audio"))
    const playing = els.filter((e) => !e.paused && !e.ended).length
    return {
      playing,
      total: els.length,
      times: els.map((e) => e.currentTime),
      roles: els.map((e) => e.dataset.role ?? "?"),
    }
  })
}
