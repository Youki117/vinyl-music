/**
 * 暗部出现轴对齐的矩形色块，是哪一层造成的？
 *
 * ⚠ 一定要在**装机版**里测。第一版用 headless Chromium 跑，五种图层组合全是完美平滑的
 * 渐变 —— 因为 headless 默认走 SwiftShader 软件光栅，GPU 合成、分块光栅、纹理量化这些
 * 恰恰是最可能产生矩形的环节，在软件路径下根本不存在。软件渲染下"复现不出来"什么也
 * 说明不了。
 *
 * 手法：逐层关掉看矩形跟着谁走；同时把暗部对比度拉到极限 —— 内置底图那片区域的灰阶
 * 跨度只有 #060606..#111111 十来级，不放大根本看不见结构。另外输出一张横向差分图，
 * 轴对齐的硬边在差分图上是最显眼的。
 *
 *   node scripts/perf/dbg-banding.mjs              # 装机版（默认，有意义的那个）
 *   node scripts/perf/dbg-banding.mjs --dev        # vite dev + headless，只用来对照
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { PNG } from "pngjs"

const DEV = process.argv.includes("--dev")
const OUT = "tests/__screenshots__"
const PORT = 9224
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
mkdirSync(OUT, { recursive: true })

/** 把 [lo, hi] 这段灰阶拉伸到 0..255，暗部结构才看得见 */
function amplify(buf, lo = 0, hi = 40) {
  const png = PNG.sync.read(buf)
  for (let i = 0; i < png.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = png.data[i + c]
      png.data[i + c] = Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)))
    }
  }
  return PNG.sync.write(png)
}

/**
 * 横向 + 纵向差分。平滑渐变的差分接近全黑，任何硬边都会亮起来；
 * 轴对齐的矩形在这张图上会显示成笔直的横线竖线，一眼可辨。
 */
function edges(buf) {
  const src = PNG.sync.read(buf)
  const out = new PNG({ width: src.width, height: src.height })
  const at = (x, y) => src.data[(y * src.width + x) * 4]
  for (let y = 1; y < src.height; y++) {
    for (let x = 1; x < src.width; x++) {
      const d = Math.abs(at(x, y) - at(x - 1, y)) + Math.abs(at(x, y) - at(x, y - 1))
      const v = Math.min(255, d * 60) // 差一级就拉到 60，够亮
      const i = (y * src.width + x) * 4
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v
      out.data[i + 3] = 255
    }
  }
  return PNG.sync.write(out)
}

/** 统计有多少像素与左邻/上邻不同，以及最大单步跳变 */
function stats(buf) {
  const png = PNG.sync.read(buf)
  const at = (x, y) => png.data[(y * png.width + x) * 4]
  let steps = 0
  let maxJump = 0
  for (let y = 1; y < png.height; y++) {
    for (let x = 1; x < png.width; x++) {
      const d = Math.max(Math.abs(at(x, y) - at(x - 1, y)), Math.abs(at(x, y) - at(x, y - 1)))
      if (d > 0) steps++
      if (d > maxJump) maxJump = d
    }
  }
  return { steps, maxJump, px: png.width * png.height }
}

const trials = [
  ["全部图层", () => {}],
  ["关颗粒", () => document.querySelectorAll(".grain").forEach((e) => (e.style.display = "none"))],
  ["关蒙版", () => document.querySelectorAll(".veil,.veil-fallback").forEach((e) => (e.style.display = "none"))],
  [
    "只留底图",
    () =>
      document
        .querySelectorAll(".grain,.veil,.veil-fallback,.content")
        .forEach((e) => (e.style.display = "none")),
  ],
]

async function shoot(page, name, mutate, tag) {
  await page.evaluate(mutate)
  await page.waitForTimeout(500)
  const shot = await page.locator(".stage").screenshot()
  const slug = `${tag}-${name}`
  writeFileSync(`${OUT}/banding-${slug}.png`, shot)
  writeFileSync(`${OUT}/banding-${slug}-amp.png`, amplify(shot))
  writeFileSync(`${OUT}/banding-${slug}-edge.png`, edges(shot))
  const s = stats(shot)
  console.log(
    `  ${name.padEnd(10)} 有跳变的像素 ${((s.steps / s.px) * 100).toFixed(1)}%  最大单步 ${s.maxJump}`,
  )
}

if (DEV) {
  console.log("⚠ dev + headless 模式：软件光栅，只作对照，别拿它下结论\n")
  const browser = await chromium.launch({ headless: true })
  for (const [name, mutate] of trials) {
    const ctx = await browser.newContext({ viewport: { width: 1220, height: 688 }, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    await page.goto("http://localhost:1420/", { waitUntil: "networkidle" })
    await page.waitForTimeout(1500)
    await shoot(page, name, mutate, "dev")
    await ctx.close()
  }
  await browser.close()
  process.exit(0)
}

// ── 装机版 ───────────────────────────────────────────────────────
if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}，先跑 npm run tauri build`)
  process.exit(1)
}
const running = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "@(Get-Process -Name vinyl-player -ErrorAction SilentlyContinue).Count"],
  { encoding: "utf8" },
).trim()
if (running !== "0") {
  console.error(`已有 ${running} 个实例在跑，单实例逻辑会顶掉这次的调试端口。请先手动关掉。`)
  process.exit(1)
}

const app = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${PORT} ` +
      `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService`,
  },
})
app.unref()
const stopApp = () => {
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
  } catch {
    /* 已经退了 */
  }
}

let browser = null
for (let i = 0; i < 30 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 700))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
}
if (!browser) {
  console.error("等不到调试端口")
  stopApp()
  process.exit(1)
}
const page = browser.contexts()[0].pages()[0]
await page.waitForTimeout(4000)

const info = await page.evaluate(() => ({
  dpr: window.devicePixelRatio,
  inner: `${window.innerWidth}x${window.innerHeight}`,
  veil: (() => {
    const c = document.querySelector("canvas.veil")
    return c ? `${c.width}x${c.height} → CSS ${Math.round(c.clientWidth)}x${Math.round(c.clientHeight)}` : "无"
  })(),
  gl: (() => {
    const c = document.createElement("canvas")
    const g = c.getContext("webgl2")
    if (!g) return "无 WebGL2"
    const e = g.getExtension("WEBGL_debug_renderer_info")
    return e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : "渲染器信息不可见"
  })(),
}))
console.log(`装机版  dpr=${info.dpr}  窗口 ${info.inner}`)
console.log(`蒙版画布 ${info.veil}`)
console.log(`GPU ${info.gl}\n`)

for (const [name, mutate] of trials) await shoot(page, name, mutate, "pkg")

console.log(`\n看 ${OUT}/banding-pkg-*-edge.png：平滑渐变应该接近全黑，矩形会显示成笔直的横竖线`)
await browser.close().catch(() => {})
stopApp()
