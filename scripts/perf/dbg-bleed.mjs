/**
 * 带底图时到底吃多少内存？黑边填充那层全屏模糊值不值这个价？
 *
 * ⚠ 这个脚本的存在本身就是一次教训：dbg-breakdown.mjs 是在**没有设底图**的状态下跑的，
 * 而 `.viewport-bleed`（Stage.tsx 里给黑边垫的那层）只在设了底图时才渲染 ——
 * 于是那次测量对它完全免疫，报出来的"蒙版 25MB / CPU 0.2%"漏掉了真实使用时最贵的一层。
 * 默认状态和用户的实际状态不一样时，测默认状态等于没测。
 *
 * 做法：把一张真实底图复制进 AppData/skins（那个目录一定在 fs 能力域里），
 * 写好 skins.json 指过去，冷启动量整棵进程树。
 *
 *   node scripts/perf/dbg-bleed.mjs
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const APPDATA = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "com.vinylplayer.desktop")
const SRC_IMG = resolve("tests/real/backdrop-2.jpg")
const BG = join(APPDATA, "skins", "bench-bg.jpg")

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}`)
  process.exit(1)
}
if (!existsSync(SRC_IMG)) {
  console.error(`找不到底图素材 ${SRC_IMG}`)
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

const PS_TREE = (rootPid) => `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add(${rootPid})
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      [void]$ids.Add([int]$p.ProcessId); $changed = $true
    }
  }
}
$out = foreach ($id in $ids) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $ci = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
  $type = 'main'
  if ($ci.CommandLine -match '--type=([a-z-]+)') { $type = $Matches[1] }
  [pscustomobject]@{ type = $type; priv = [math]::Round($proc.PrivateMemorySize64 / 1MB, 1) }
}
ConvertTo-Json -InputObject @($out) -Compress
`

function mem(pid) {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", PS_TREE(pid)], {
    encoding: "utf8",
    maxBuffer: 8 << 20,
  })
  const t = JSON.parse(raw.trim() || "[]")
  const tree = Array.isArray(t) ? t : [t]
  return {
    total: Math.round(tree.reduce((n, x) => n + x.priv, 0)),
    gpu: Math.round(tree.filter((x) => x.type === "gpu-process").reduce((n, x) => n + x.priv, 0)),
  }
}

function seed(withBackdrop) {
  mkdirSync(join(APPDATA, "skins"), { recursive: true })
  if (withBackdrop) copyFileSync(SRC_IMG, BG)
  writeFileSync(
    join(APPDATA, "skins.json"),
    JSON.stringify({
      schemaVersion: 2,
      activeId: "bench",
      skins: [
        {
          id: "bench",
          name: "bench",
          backdrop: withBackdrop ? BG : null,
          backdropFocus: { x: 0.5, y: 0.5 },
          label: { source: "backdrop", focus: { x: 0.5, y: 0.32, zoom: 2.2 } },
          veil: { edgeX: 0.42, softness: 0.092, opacity: 0.89, tint: "#f7f5f0", ripple: 1, wander: 0.12 },
          ink: { auto: true, primary: "#3a3a37", secondary: "#7b7975", accent: "#b2845f" },
          text: { title: "FASHION", subtitle: "SELP-PORTRAIT", year: "1901", byline: "bench" },
        },
      ],
    }),
    "utf8",
  )
}

/** @param mutate 在页面里执行的改动，用来关掉某一层再量 */
async function trial(name, withBackdrop, port, mutate) {
  seed(withBackdrop)
  const app = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-port=${port} ` +
        `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService`,
    },
  })
  app.unref()

  let browser = null
  for (let i = 0; i < 30 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 700))
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null)
  }
  if (!browser) throw new Error(`${name}：连不上调试端口`)
  const page = browser.contexts()[0].pages()[0]
  await page.waitForTimeout(2000)

  // 关层要赶在它第一次被合成之前 —— GPU 的纹理池冲上高水位之后不会缩回来，
  // 晚一步关掉，量到的还是高水位（上一轮就栽在这个坑上）
  if (mutate) await page.evaluate(mutate)
  await page.waitForTimeout(5000)

  const info = await page.evaluate(() => {
    const b = document.querySelector(".viewport-bleed")
    return {
      win: `${window.innerWidth}×${window.innerHeight}`,
      bleed: b ? getComputedStyle(b).display : "无",
      filter: b ? getComputedStyle(b).filter.slice(0, 40) : "-",
    }
  })
  const m = mem(app.pid)

  await browser.close().catch(() => {})
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
  } catch {
    /* 已退出 */
  }
  await new Promise((r) => setTimeout(r, 1500))
  return { name, ...m, ...info }
}

const rows = []
rows.push(await trial("① 无底图（我上次测的就是这个）", false, 9260))
rows.push(await trial("② 有底图 + 全屏模糊填黑边（现状）", true, 9261))
rows.push(
  await trial("③ 有底图，但去掉模糊只留压暗", true, 9262, () => {
    const b = document.querySelector(".viewport-bleed")
    if (b) b.style.filter = "brightness(0.42) saturate(0.85)"
  }),
)
rows.push(
  await trial("④ 有底图，整个不要黑边填充层", true, 9263, () => {
    document.querySelector(".viewport-bleed")?.remove()
  }),
)

console.log()
for (const r of rows) {
  console.log(`${r.name.padEnd(34)} 合计 ${String(r.total).padStart(4)}MB  GPU ${String(r.gpu).padStart(4)}MB   窗口 ${r.win}`)
}
const [, full, noBlur, none] = rows
console.log(`\n全屏模糊这一层：${full.total - noBlur.total}MB（GPU ${full.gpu - noBlur.gpu}MB）`)
console.log(`整个黑边填充层：${full.total - none.total}MB（GPU ${full.gpu - none.gpu}MB）`)
