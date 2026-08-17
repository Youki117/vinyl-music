/**
 * 黑边到底有多少？舞台在窗口里实际占多大？
 * 默认窗口 → 最大化，各量一次。
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { resolve } from "node:path"

const PORT = 9240
const EXE = resolve("D:/Project/Projects-Unzip/vinyl-player/src-tauri/target/release/vinyl-player.exe")

const running = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "@(Get-Process -Name vinyl-player -ErrorAction SilentlyContinue).Count"],
  { encoding: "utf8" },
).trim()
if (running !== "0") {
  console.error(`已有 ${running} 个实例在跑，先关掉`)
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

let browser = null
for (let i = 0; i < 30 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 700))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
}
if (!browser) {
  console.error("连不上调试端口")
  process.exit(1)
}
const page = browser.contexts()[0].pages()[0]
await page.waitForTimeout(4000)

const probe = () =>
  page.evaluate(() => {
    const stage = document.querySelector(".stage")
    const vp = document.querySelector(".viewport")
    const s = stage?.getBoundingClientRect()
    const v = vp?.getBoundingClientRect()
    return {
      dpr: window.devicePixelRatio,
      win: `${window.innerWidth}×${window.innerHeight}`,
      screen: `${screen.width}×${screen.height}`,
      viewport: v ? `${Math.round(v.width)}×${Math.round(v.height)}` : "?",
      stage: s ? `${Math.round(s.width)}×${Math.round(s.height)}` : "?",
      barX: v && s ? Math.round(v.width - s.width) : 0,
      barY: v && s ? Math.round(v.height - s.height) : 0,
      fill: v && s ? ((s.width * s.height) / (v.width * v.height)) * 100 : 0,
    }
  })

const show = (label, r) => {
  console.log(`${label}`)
  console.log(`   窗口 ${r.win}  dpr ${r.dpr}  屏幕 ${r.screen}`)
  console.log(`   舞台 ${r.stage}  左右黑边合计 ${r.barX}px  上下黑边合计 ${r.barY}px`)
  console.log(`   画面填充率 ${r.fill.toFixed(1)}%\n`)
}

show("默认窗口", await probe())

await page.evaluate(() => {
  document.querySelector('.titlebar button[aria-label="最大化"]')?.click()
})
await page.waitForTimeout(1500)
show("最大化后", await probe())

await browser.close().catch(() => {})
try {
  execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
} catch {
  /* 已退出 */
}
