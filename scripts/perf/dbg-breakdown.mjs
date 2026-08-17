/**
 * 资源都花在哪儿了？蒙版占多少？
 *
 * 上一轮踩过的坑：在一个只有一张画布的空页面里测，"把蒙版画布从 2440 宽压到 1220 宽"
 * 显示能省 155MB；搬进真实应用只省了 11MB。**孤立基准会严重高估单个图层的份额**，
 * 因为应用里还有底图、颗粒、内容好几个全屏合成层在抢同一批 GPU 资源。
 *
 * 所以这次不搭玩具页面，直接冷启动装机版，靠启动参数切换配置：
 *
 *   ① 空白页          Playwright Chromium 开 about:blank —— Chromium 多进程模型的地板
 *   ② 装机版·正常      WebGL 蒙版
 *   ③ 装机版·禁 WebGL  --disable-webgl 让 VeilRenderer.create 拿不到上下文，
 *                     应用自己走 CSS 降级路径（src/stage/Veil.tsx 的 fallback）
 *
 * ②−③ 就是"选用 WebGL 画蒙版"在真实应用里的实际代价（含 ANGLE/D3D 那套基础设施 ——
 * 不用 WebGL 就不用付，所以算进去是公道的）。
 *
 * 内存按进程类型拆开，因为 Chromium 的开销分布很不均匀，只看总数看不出结构。
 * 同时采一段 CPU：蒙版是每帧重画的，光看内存会漏掉它真正的大头。
 *
 * 进程纪律：只统计自己 spawn 的那棵进程树，只结束自己 spawn 的进程；发现已有实例
 * 在跑就报错退出，不去按映像名动别人的进程。
 *
 *   node scripts/perf/dbg-breakdown.mjs
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const OUT = "tests/__screenshots__"
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const CPU_WINDOW_MS = 8000
mkdirSync(OUT, { recursive: true })

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
  console.error(`已有 ${running} 个实例在跑，先手动关掉再测`)
  process.exit(1)
}

/** 沿进程树从根 PID 往下收，按类型给出 Private Bytes 与累计 CPU 秒数 */
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
  [pscustomobject]@{
    type = $type
    priv = [math]::Round($proc.PrivateMemorySize64 / 1MB, 1)
    cpu  = $proc.TotalProcessorTime.TotalSeconds
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`

function sample(rootPid) {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", PS_TREE(rootPid)], {
    encoding: "utf8",
    maxBuffer: 8 << 20,
  })
  const parsed = JSON.parse(raw.trim() || "[]")
  const tree = Array.isArray(parsed) ? parsed : [parsed]
  const byType = {}
  for (const p of tree) {
    byType[p.type] ??= { priv: 0, cpu: 0, n: 0 }
    byType[p.type].priv += p.priv
    byType[p.type].cpu += p.cpu
    byType[p.type].n++
  }
  return {
    byType,
    total: Math.round(tree.reduce((n, x) => n + x.priv, 0)),
    cpu: tree.reduce((n, x) => n + x.cpu, 0),
    procs: tree.length,
  }
}

/** 采一段时间的 CPU，返回平均占用的核心数 */
async function measure(rootPid) {
  const a = sample(rootPid)
  await new Promise((r) => setTimeout(r, CPU_WINDOW_MS))
  const b = sample(rootPid)
  const cores = {}
  for (const t of Object.keys(b.byType)) {
    cores[t] = ((b.byType[t].cpu - (a.byType[t]?.cpu ?? 0)) / (CPU_WINDOW_MS / 1000)) * 100
  }
  return { ...b, cores, coresTotal: ((b.cpu - a.cpu) / (CPU_WINDOW_MS / 1000)) * 100 }
}

const results = {}

// ── ① 空白页地板 ─────────────────────────────────────────────────
{
  const tag = `vp-floor-${Date.now()}`
  const dir = join(tmpdir(), tag)
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: null,
    args: ["--window-size=1052,710"],
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto("about:blank")
  await page.waitForTimeout(4000)
  // Playwright 的浏览器进程就是这棵树的根
  const pid = Number(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1).ProcessId`,
      ],
      { encoding: "utf8" },
    ).trim(),
  )
  results["① 空白页（Chromium 地板）"] = await measure(pid)
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
}

// ── ②③ 装机版 ───────────────────────────────────────────────────
for (const [name, extra] of [
  ["② 装机版·正常（WebGL 蒙版）", ""],
  ["③ 装机版·禁 WebGL（CSS 降级蒙版）", "--disable-webgl --disable-webgl2"],
]) {
  const port = 9230 + Object.keys(results).length
  const app = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        `--remote-debugging-port=${port} ` +
        `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService ` +
        extra,
    },
  })
  app.unref()

  let browser = null
  for (let i = 0; i < 30 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 700))
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null)
  }
  if (!browser) {
    console.error(`${name}：等不到调试端口`)
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      /* 已经退了 */
    }
    process.exit(1)
  }
  const page = browser.contexts()[0].pages()[0]
  await page.waitForTimeout(5000)

  // 核实这一档真的走了预期的渲染路径
  const which = await page.evaluate(() => ({
    webgl: !!document.createElement("canvas").getContext("webgl2"),
    veil: document.querySelector("canvas.veil") ? "WebGL 画布" : "无",
    fallback: document.querySelector(".veil-fallback") ? "CSS 降级层" : "无",
  }))
  results[name] = await measure(app.pid)
  results[name].which = which
  await page.screenshot({ path: join(OUT, `breakdown-${Object.keys(results).length}.png`) })

  await browser.close().catch(() => {})
  try {
    execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
  } catch {
    /* 已经退了 */
  }
  await new Promise((r) => setTimeout(r, 1500))
}

// ── 报告 ─────────────────────────────────────────────────────────
const TYPES = ["main", "gpu-process", "renderer", "utility", "network", "crashpad-handler"]
const label = { "gpu-process": "GPU", renderer: "渲染器", utility: "工具", network: "网络", main: "主进程" }

console.log()
for (const [name, r] of Object.entries(results)) {
  console.log(`${name}`)
  if (r.which) console.log(`   路径核实：${r.which.veil} / ${r.which.fallback}（WebGL2 ${r.which.webgl ? "可用" : "已禁用"}）`)
  console.log(`   合计 ${r.total}MB，${r.procs} 个进程，空闲 CPU ${r.coresTotal.toFixed(1)}%`)
  for (const t of TYPES) {
    const v = r.byType[t]
    if (!v) continue
    const pct = ((v.priv / r.total) * 100).toFixed(0)
    console.log(
      `     ${(label[t] ?? t).padEnd(8)} ${String(Math.round(v.priv)).padStart(4)}MB (${pct.padStart(2)}%)  ×${v.n}  CPU ${(r.cores[t] ?? 0).toFixed(1)}%`,
    )
  }
  console.log()
}

const a = results["② 装机版·正常（WebGL 蒙版）"]
const b = results["③ 装机版·禁 WebGL（CSS 降级蒙版）"]
const floor = results["① 空白页（Chromium 地板）"]
if (a && b && floor) {
  console.log("──────────────────────────────")
  console.log(`Chromium 地板          ${floor.total}MB  ← 谁的代码都省不掉`)
  console.log(`我们的页面（不含蒙版）    ${b.total - floor.total}MB`)
  console.log(`WebGL 蒙版             ${a.total - b.total}MB  (${(((a.total - b.total) / a.total) * 100).toFixed(0)}% of ${a.total}MB)`)
  console.log(`  其中 GPU 进程        ${Math.round((a.byType["gpu-process"]?.priv ?? 0) - (b.byType["gpu-process"]?.priv ?? 0))}MB`)
  console.log(`蒙版的空闲 CPU 增量      ${(a.coresTotal - b.coresTotal).toFixed(1)}%`)
}

writeFileSync(join(OUT, "breakdown.json"), JSON.stringify(results, null, 2))
