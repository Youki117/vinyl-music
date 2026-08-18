/**
 * 窗口缩放的两条硬要求：**跟手**、**任何尺寸都不露黑边**。
 *
 * 黑边是这样来的：舞台尺寸以前由 React state 驱动，链路是
 * 窗口 → 布局 → resize 事件 → setState → 渲染 → 提交 → 绘制，至少落后两帧，
 * 那两帧里舞台还是旧尺寸，视口底色就从边缘露出来。所以这里既要测终态没有黑边，
 * 也要测**缩放过程中**没有。
 *
 *   node scripts/verify-resize.mjs
 */
import { chromium } from "playwright"
import { PNG } from "pngjs"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const DESIGN_W = 1243
const DESIGN_H = 688

const checks = []
const check = (name, ok, detail) => checks.push([name, !!ok, detail])

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 708 }, deviceScaleFactor: 1 })
const errors = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text()))

await page.goto(URL, { waitUntil: "networkidle" })
// 见 edgeScan 的注释：把视口底色换成品红，漏底就无所遁形
await page.addStyleTag({ content: ".viewport { background: #ff00ff !important; }" })
await page.waitForTimeout(600)

/**
 * 沿四条边逐点扫描，找**露出来的视口底色**。
 *
 * 不能按"够不够黑"判：内置底纹的边缘本来就是 #060606，实测扫出 rgb(11,11,11)，
 * 和漏出来的底色 #101010 几乎一样，按亮度阈值分不开 —— 第一版就是这么误报 337 处的。
 *
 * 所以把视口底色临时改成品红。舞台盖住时一个品红像素都不该出现；只要漏一条缝，
 * 哪怕一像素宽也立刻现形。这是个只在测试里成立的假设，但它把"漏底"和"画面很暗"
 * 这两件事彻底分开了。
 */
async function edgeScan() {
  const png = PNG.sync.read(await page.screenshot({ type: "png" }))
  const { width: W, height: H, data } = png
  const at = (x, y) => {
    const i = (y * W + x) << 2
    return { rgb: [data[i], data[i + 1], data[i + 2]], lum: (data[i] + data[i + 1] + data[i + 2]) / 3 }
  }
  // 品红：r 高、g 低、b 高。画面里不可能自然出现
  const isLeak = (c) => c[0] > 180 && c[1] < 70 && c[2] > 180
  const bad = []
  for (let x = 0; x < W; x++) {
    for (const [name, y] of [["上边", 0], ["下边", H - 1]]) {
      const p = at(x, y)
      if (isLeak(p.rgb)) bad.push(`${name} x=${x}`)
    }
  }
  for (let y = 0; y < H; y++) {
    for (const [name, x] of [["左边", 0], ["右边", W - 1]]) {
      const p = at(x, y)
      if (isLeak(p.rgb)) bad.push(`${name} y=${y}`)
    }
  }
  return bad
}

/** 舞台是否真的盖住了整个视口，且内容缩放与舞台一致 */
async function geometry() {
  return page.evaluate(({ DW, DH }) => {
    const stage = document.querySelector(".stage")
    const content = document.querySelector(".content")
    const s = stage.getBoundingClientRect()
    const scaleVar = parseFloat(getComputedStyle(stage).getPropertyValue("--stage-scale"))
    const m = new DOMMatrix(getComputedStyle(content).transform)
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      sw: s.width, sh: s.height, sx: s.left, sy: s.top,
      scaleVar, appliedScale: m.a,
      aspect: s.width / s.height, designAspect: DW / DH,
      contentW: content.getBoundingClientRect().width,
    }
  }, { DW: DESIGN_W, DH: DESIGN_H })
}

// ── 一、多种比例下的终态 ────────────────────────────────────
// 1280x708 ≈ 设计比例（Rust 锁定后的常态）；其余模拟最大化/全屏/异形屏
const sizes = [
  [1280, 708, "锁定比例（常态）"],
  [1920, 1080, "16:9 最大化"],
  [1920, 1200, "16:10 最大化 —— 旧实现在这里露 92px 黑边"],
  [2560, 1080, "21:9 带鱼屏"],
  [1000, 900, "接近正方，窗口偏高"],
  [780, 432, "最小尺寸"],
]

for (const [w, h, label] of sizes) {
  await page.setViewportSize({ width: w, height: h })
  await page.waitForTimeout(250)
  const g = await geometry()

  check(`${label} 舞台覆盖整个视口`,
    g.sw >= g.vw - 0.5 && g.sh >= g.vh - 0.5,
    `视口 ${g.vw}x${g.vh}，舞台 ${g.sw.toFixed(1)}x${g.sh.toFixed(1)}`)

  check(`${label} 保持设计比例`,
    Math.abs(g.aspect - g.designAspect) < 0.005,
    `${g.aspect.toFixed(4)} vs ${g.designAspect.toFixed(4)}`)

  check(`${label} 内容缩放与舞台一致`,
    Math.abs(g.appliedScale - g.sw / DESIGN_W) < 0.002,
    `应用 ${g.appliedScale.toFixed(4)}，应为 ${(g.sw / DESIGN_W).toFixed(4)}`)

  const black = await edgeScan()
  check(`${label} 四边逐点扫描无漏底`, black.length === 0,
    black.length ? `漏 ${black.length} 点：${black.slice(0, 4).join(" ")}` : "四条边逐点全覆盖")
}

// ── 二、缩放过程中（不是终态）────────────────────────────────
// 连续改尺寸，每一步立刻取几何，不给它"追上"的时间。React 驱动时这里必挂。
await page.setViewportSize({ width: 1280, height: 708 })
await page.waitForTimeout(300)
let worstGap = 0
let worstScale = 0
let framesWithBlack = 0
for (let i = 0; i < 24; i++) {
  const w = 1000 + i * 40
  await page.setViewportSize({ width: w, height: Math.round((w * DESIGN_H) / DESIGN_W) })
  const g = await geometry() // 故意不等待，不给它"追上"的机会
  worstGap = Math.max(worstGap, g.vw - g.sw, g.vh - g.sh)
  worstScale = Math.max(worstScale, Math.abs(g.appliedScale - g.sw / DESIGN_W))
  // 截图会强制走一次真实绘制，这一步测的才是用户看到的那一帧
  if (i % 4 === 0 && (await edgeScan()).length > 0) framesWithBlack++
}
check("连续缩放过程中舞台始终不小于视口（不露底）", worstGap <= 0.5, `最差缺口 ${worstGap.toFixed(2)}px`)
check("连续缩放过程中内容缩放不掉队", worstScale < 0.002, `最差偏差 ${worstScale.toFixed(4)}`)
check("连续缩放的中间帧也没有漏底", framesWithBlack === 0, `6 帧抽检中 ${framesWithBlack} 帧漏底`)

// ── 三、缩放时不应触发 React 重渲染 ──────────────────────────
// 用 MutationObserver 数舞台上 style 属性以外的 DOM 变动：React 重渲染会改属性/结构
await page.setViewportSize({ width: 1280, height: 708 })
await page.waitForTimeout(300)
await page.evaluate(() => {
  window.__mut = 0
  const t = document.querySelector(".stage")
  window.__mo = new MutationObserver((rs) => { window.__mut += rs.length })
  window.__mo.observe(t, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] })
})
for (let i = 0; i < 20; i++) {
  const w = 1100 + i * 30
  await page.setViewportSize({ width: w, height: Math.round((w * DESIGN_H) / DESIGN_W) })
}
await page.waitForTimeout(400)
const mutations = await page.evaluate(() => { window.__mo.disconnect(); return window.__mut })
// 只应有 --stage-scale 一处 style 写入（每次缩放 1 次），不应有成片的属性/结构变动
check("缩放不触发内容层重渲染", mutations <= 40, `20 次缩放共 ${mutations} 处 DOM 变动（只写 --stage-scale 应 ≈20）`)

check("全程无 JS 报错", errors.length === 0, errors.slice(0, 3).join(" | "))

await browser.close()

let bad = 0
for (const [n, ok, d] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${n}${d ? `  —— ${d}` : ""}`)
  if (!ok) bad++
}
console.log(bad ? `\n✗ ${bad} / ${checks.length} 项未通过` : `\n✓ 缩放检查全部通过（${checks.length} 项）`)
process.exit(bad ? 1 : 0)
