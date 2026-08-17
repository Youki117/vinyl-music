/**
 * 实测装机版的内存构成。
 *
 * 为什么要单独写：Tauri/Electron 这类应用的内存在**多个进程**里，主进程往往
 * 只占一成，其余全在 WebView2 的一串子进程里。只看主进程会得出一个好看但没用的
 * 数字（PRD 里那个"实测 40MB"就是这么来的）。
 *
 * 两个口径都给：
 *  - WorkingSet 求和会把 Chromium 各进程共享的 DLL 页重复计入，偏大
 *  - Private 合计更接近任务管理器给应用分组显示的数，是更公道的口径
 *
 * 关键手法是**分阶段测 + 强制 GC 后再测**：能把"真占着"和"垃圾还没回收"分开。
 * 只测一次稳态数字，分不出这两者，也就无从判断该优化什么。
 *
 *   node scripts/measure-memory.mjs
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { resolve, join } from "node:path"

const PORT = 9222
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const REAL = resolve("tests/real")

if (!existsSync(EXE)) {
  console.error("先跑 npm run tauri build")
  process.exit(1)
}
const audio = readdirSync(REAL)
  .filter((f) => /\.(mp3|ogg)$/i.test(f))
  .map((f) => join(REAL, f))

/** 沿父子关系把整棵进程树的内存加起来 —— 机器上别的程序也在用 WebView2 */
const PS_TREE = `
$root = Get-Process -Name vinyl-player -ErrorAction SilentlyContinue
if (-not $root) { '[]' ; exit }
$all = Get-CimInstance Win32_Process
$ids = New-Object System.Collections.Generic.HashSet[int]
foreach ($r in $root) { [void]$ids.Add($r.Id) }
for ($i = 0; $i -lt 6; $i++) {
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) }
  }
}
$out = foreach ($id in $ids) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $ci = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
  $type = 'main'
  if ($ci.CommandLine -match '--type=([a-z-]+)') { $type = $Matches[1] }
  [pscustomobject]@{
    name = $p.ProcessName
    type = $type
    ws   = [math]::Round($p.WorkingSet64 / 1MB, 1)
    priv = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`

function processTree() {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", PS_TREE], {
      encoding: "utf8",
      timeout: 30000,
    })
    const parsed = JSON.parse(out.trim() || "[]")
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (e) {
    console.error("进程树读取失败：", String(e).slice(0, 120))
    return []
  }
}

const rows = []

async function sample(page, cdp, label, { gc = false } = {}) {
  if (gc) {
    await cdp.send("HeapProfiler.collectGarbage").catch(() => {})
    // GC 之后给一点时间让空闲页真的还回去
    await page.waitForTimeout(2500)
  }
  const tree = processTree()
  const ws = tree.reduce((n, p) => n + p.ws, 0)
  const priv = tree.reduce((n, p) => n + p.priv, 0)

  let metrics = {}
  try {
    const m = await cdp.send("Performance.getMetrics")
    for (const { name, value } of m.metrics) metrics[name] = value
  } catch {
    /* 拿不到就算了 */
  }
  const dom = await cdp.send("Memory.getDOMCounters").catch(() => ({}))
  const page_ = await page.evaluate(() => ({
    audios: document.querySelectorAll("audio").length,
    canvases: document.querySelectorAll("canvas").length,
    blobImgs: Array.from(document.querySelectorAll("*")).filter((el) =>
      /blob:/.test(getComputedStyle(el).backgroundImage ?? ""),
    ).length,
  }))

  const row = {
    label,
    ws: Math.round(ws),
    priv: Math.round(priv),
    gpu: Math.round(tree.filter((p) => p.type === "gpu-process").reduce((n, p) => n + p.priv, 0)),
    renderer: Math.round(tree.filter((p) => p.type === "renderer").reduce((n, p) => n + p.priv, 0)),
    jsHeap: Math.round((metrics.JSHeapUsedSize ?? 0) / 1024 / 1024),
    nodes: dom.nodes ?? 0,
    ...page_,
  }
  rows.push(row)
  console.log(
    `${label.padEnd(26)} WS ${String(row.ws).padStart(4)}MB  Priv ${String(row.priv).padStart(4)}MB` +
      `  (gpu ${String(row.gpu).padStart(3)} / renderer ${String(row.renderer).padStart(3)})` +
      `  JS堆 ${String(row.jsHeap).padStart(3)}MB  audio×${row.audios}`,
  )
  return row
}

// ── 冷启动 ───────────────────────────────────────────────────────
try {
  execFileSync("taskkill", ["/IM", "vinyl-player.exe", "/F"], { stdio: "ignore" })
} catch {
  /* 本来就没在跑 */
}
await new Promise((r) => setTimeout(r, 1500))

// 装机版的"加文件"弹的是 Windows 原生对话框，Playwright 驱动不了 ——
// filechooser 事件只对 HTML <input type=file> 有效。改成预先铺好 library.json，
// 让曲库在启动时就载入，测的仍然是真实的播放路径。
const APPDATA = join(process.env.APPDATA ?? "", "com.vinylplayer.desktop")
const seeded = audio.map((p, i) => ({
  id: p,
  ref: { id: p, name: p.split(/[\\/]/).pop(), size: 0, mtime: 0 },
  title: (p.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, ""),
  artist: "测试",
  album: "",
  duration: 0,
  playCount: 0,
  liked: false,
  lastPlayed: 0,
  addedAt: i,
}))
const { writeFileSync, mkdirSync } = await import("node:fs")
mkdirSync(APPDATA, { recursive: true })
writeFileSync(
  join(APPDATA, "library.json"),
  JSON.stringify(
    { schemaVersion: 2, tracks: seeded, playlists: [], activeView: "all", sort: "added", sortDesc: false },
    null,
    2,
  ),
  "utf8",
)

const t0 = Date.now()
const app = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService`,
  },
})
app.unref()

let browser = null
for (let i = 0; i < 40 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 400))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
}
if (!browser) {
  console.error("等不到调试端口")
  process.exit(1)
}
const page = browser.contexts()[0].pages()[0]
await page.waitForSelector(".stage", { timeout: 15000 })
const coldMs = Date.now() - t0

const cdp = await page.context().newCDPSession(page)
await cdp.send("Performance.enable").catch(() => {})

console.log(`\n冷启动到界面可见：${(coldMs / 1000).toFixed(2)}s\n`)
await page.waitForTimeout(3000)

await sample(page, cdp, `A 冷启动 曲库 ${audio.length} 首`)

// ── 播放第一首 ───────────────────────────────────────────────────
// 这一步会：读整个文件进内存 → 建 Blob → decodeAudioData 算波形峰值
await page.click(".disc")
await page.waitForTimeout(9000)
await sample(page, cdp, "B 播放第 1 首")

// ── 逐首播过去 ───────────────────────────────────────────────────
// 每换一首都要再走一遍上面那套，看看会不会累加
for (let i = 0; i < audio.length; i++) {
  await page.click('.controls button[aria-label="下一首"]')
  await page.waitForTimeout(7000)
}
await sample(page, cdp, `C 依次播完 ${audio.length} 首`)

// 再来一轮，确认是"到顶了"还是"还在涨"
for (let i = 0; i < audio.length; i++) {
  await page.click('.controls button[aria-label="下一首"]')
  await page.waitForTimeout(7000)
}
await sample(page, cdp, "D 第二轮播完")

// ── 强制 GC ──────────────────────────────────────────────────────
// 这一步是关键：掉得多说明是"垃圾还没回收"，掉得少说明是真占着
await sample(page, cdp, "E 强制 GC 之后", { gc: true })

await browser.close()
try {
  execFileSync("taskkill", ["/IM", "vinyl-player.exe", "/F"], { stdio: "ignore" })
} catch {
  /* 已退 */
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log("\n阶段对比（Private，MB）")
console.log("阶段".padEnd(26) + "合计   gpu  renderer  JS堆")
for (const r of rows) {
  console.log(
    r.label.padEnd(26) +
      String(r.priv).padStart(4) +
      String(r.gpu).padStart(6) +
      String(r.renderer).padStart(9) +
      String(r.jsHeap).padStart(6),
  )
}

const base = rows[0]
const peak = rows.reduce((a, b) => (b.priv > a.priv ? b : a))
console.log(`\n冷启动 ${base.priv}MB → 峰值 ${peak.priv}MB（${peak.label}）`)
const afterGc = rows.find((r) => r.label.startsWith("E"))
if (afterGc) {
  const before = rows.find((r) => r.label.startsWith("D"))
  console.log(
    `强制 GC：${before.priv}MB → ${afterGc.priv}MB（回收 ${before.priv - afterGc.priv}MB，` +
      `其中 JS 堆 ${before.jsHeap - afterGc.jsHeap}MB）`,
  )
}
