/**
 * 端到端验证皮肤系统（PRD F5，本项目的核心需求）。
 *
 * 真的走一遍用户路径：点「更换底图」→ 选一张图 → 确认底图铺满、唱片贴纸自动
 * 取自同一张图、文字配色随之更新。光看代码对不算数。
 *
 *   node scripts/verify-skin.mjs
 */
import { chromium } from "playwright"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

const URL = process.env.VINYL_URL ?? "http://localhost:1420/"
const OUT = "tests/__screenshots__"
const IMAGE = resolve("design-ref/figma-make/figma-input.png")

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1243, height: 688 }, deviceScaleFactor: 1 })

const errors = []
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`)
})

await page.goto(URL, { waitUntil: "networkidle" })
await page.waitForTimeout(600)

const before = await readState(page)
await page.screenshot({ path: `${OUT}/skin-before.png` })

// 点「更换底图」并喂给它一张图
const chooser = page.waitForEvent("filechooser")
await page.click('button[aria-label="更换底图"]')
await (await chooser).setFiles(IMAGE)
await page.waitForTimeout(1400)

const after = await readState(page)
await page.screenshot({ path: `${OUT}/skin-after.png` })

await browser.close()

// ── 判定 ──────────────────────────────────────────────────────────
const checks = [
  ["导入前没有底图", before.backdropCount === 0],
  ["导入后底图层出现", after.backdropCount > 0],
  ["底图以 cover 铺满整个舞台", after.backdropSize === "cover"],
  ["唱片贴纸拿到了图", after.labelHasImage],
  ["贴纸用的正是底图那张（跟随联动）", after.labelUrl === after.backdropUrl],
  ["贴纸是放大取景而非整图塞进圆里", after.labelScale > 100],
  ["皮肤面板已弹出，可直接调取景", after.skinPanelOpen],
  ["文字配色已重新推导", after.inkPrimary !== "" && after.inkPrimary !== before.inkPrimary],
  ["蒙版画布仍在（WebGL 未挂）", after.hasVeilCanvas],
  ["无 JS 报错", errors.length === 0],
]

console.log(`底图 URL   ${short(after.backdropUrl)}`)
console.log(`贴纸 URL   ${short(after.labelUrl)}`)
console.log(`贴纸缩放   ${after.labelScale?.toFixed(0)}%`)
console.log(`文字主色   ${before.inkPrimary} → ${after.inkPrimary}`)
console.log("")

let failed = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${name}`)
  if (!ok) failed++
}
if (errors.length) {
  console.log("\n页面报错：")
  for (const e of errors) console.log("  " + e)
}
console.log(`\n截图 → ${OUT}/skin-before.png, ${OUT}/skin-after.png`)

if (failed > 0) {
  console.error(`\n✗ ${failed} 项未通过`)
  process.exit(1)
}
console.log("\n✓ 皮肤系统端到端通过")

function short(u) {
  return u ? u.slice(0, 46) + (u.length > 46 ? "…" : "") : "(无)"
}

async function readState(page) {
  return page.evaluate(() => {
    const img = document.querySelector(".backdrop-img")
    const label = document.querySelector(".disc-label")
    const stage = document.querySelector(".stage")
    const grab = (el, prop) => (el ? getComputedStyle(el)[prop] : "")
    const url = (v) => {
      const m = /url\("?([^")]+)"?\)/.exec(v || "")
      return m ? m[1] : ""
    }
    return {
      backdropCount: document.querySelectorAll(".backdrop-img").length,
      backdropSize: grab(img, "backgroundSize"),
      backdropUrl: url(grab(img, "backgroundImage")),
      labelHasImage: url(grab(label, "backgroundImage")) !== "",
      labelUrl: url(grab(label, "backgroundImage")),
      labelScale: Number.parseFloat(grab(label, "backgroundSize")),
      skinPanelOpen: document.querySelector(".skin-editor") !== null,
      inkPrimary: stage ? getComputedStyle(stage).getPropertyValue("--ink-primary").trim() : "",
      hasVeilCanvas: document.querySelector("canvas.veil") !== null,
    }
  })
}
