/**
 * 蒙版上的矩形色块：是稳定的几何，还是重绘/合成产生的瞬时瑕疵？
 *
 * 已知（scripts/perf/dbg-banding.mjs）：藏掉蒙版画布矩形就消失，所以来源是蒙版。
 * 但蒙版在 dpr1 下画布与 CSS 尺寸 1:1（不涉及上采样），频谱纹理是 LINEAR（不会有硬阶梯），
 * 着色器里也全是连续函数 —— 按理画不出直角。
 *
 * 那就只剩"画出来之后"的环节。这里连拍多张同一状态的截图两两相减：
 *   - 差分几乎全黑 → 矩形是稳定几何，得回去查着色器/合成
 *   - 差分里出现矩形块 → 是重绘或呈现层面的问题（脏矩形、交换链局部呈现、
 *     低帧率下上一帧残留），那就和这轮把空闲帧率从 60 降到 12 直接相关
 *
 *   node scripts/perf/dbg-veil-rect.mjs
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { PNG } from "pngjs"

const OUT = "tests/__screenshots__"
const PORT = 9225
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
mkdirSync(OUT, { recursive: true })

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}`)
  process.exit(1)
}
const running = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "@(Get-Process -Name vinyl-player -ErrorAction SilentlyContinue).Count"],
  { encoding: "utf8" },
).trim()
if (running !== "0") {
  console.error(`已有 ${running} 个实例在跑，先手动关掉`)
  process.exit(1)
}

/** 两图相减并放大，返回 {png, changed, maxDiff} */
function diff(a, b, gain = 40) {
  const A = PNG.sync.read(a)
  const B = PNG.sync.read(b)
  const out = new PNG({ width: A.width, height: A.height })
  let changed = 0
  let maxDiff = 0
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.max(
      Math.abs(A.data[i] - B.data[i]),
      Math.abs(A.data[i + 1] - B.data[i + 1]),
      Math.abs(A.data[i + 2] - B.data[i + 2]),
    )
    if (d > 0) changed++
    if (d > maxDiff) maxDiff = d
    const v = Math.min(255, d * gain)
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v
    out.data[i + 3] = 255
  }
  return { png: PNG.sync.write(out), changed: changed / (A.width * A.height), maxDiff }
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
await page.waitForTimeout(5000) // 等过 3 秒的衰减窗口，确保已经降到低帧率档

const veilParams = await page.evaluate(() => {
  const c = document.querySelector("canvas.veil")
  return {
    canvas: c ? `${c.width}x${c.height}` : "无",
    // 从画布上直接读一小块像素，确认 GL 输出本身有没有阶梯
    sample: (() => {
      if (!c) return null
      const g = c.getContext("webgl2", { preserveDrawingBuffer: true })
      return g ? "有 GL 上下文" : "取不到"
    })(),
  }
})
console.log(`蒙版画布 ${veilParams.canvas}\n`)

// 只截蒙版所在的区域，避开会自己动的 UI（进度条、时间）
const shots = []
for (let i = 0; i < 4; i++) {
  shots.push(await page.locator(".stage").screenshot())
  console.log(`  拍第 ${i + 1} 张`)
  if (i < 3) await page.waitForTimeout(4000)
}

console.log()
for (let i = 1; i < shots.length; i++) {
  const d = diff(shots[0], shots[i])
  writeFileSync(`${OUT}/veilrect-diff-0-${i}.png`, d.png)
  console.log(`  第1张 vs 第${i + 1}张：${(d.changed * 100).toFixed(2)}% 像素有变化，最大差 ${d.maxDiff}`)
}

writeFileSync(`${OUT}/veilrect-frame0.png`, shots[0])
console.log(`\n差分图：${OUT}/veilrect-diff-0-*.png`)
console.log(`差分几乎全黑 = 稳定几何；出现矩形块 = 重绘/呈现问题`)

await browser.close().catch(() => {})
stopApp()
