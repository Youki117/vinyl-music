/**
 * 大曲库基准：导入 N 首要多久、吃多少内存，面板开着导会不会更惨。
 *
 * 起因：外部审查报出两条随曲库规模增长的问题 ——
 *   M1 导入时给每首歌的内嵌封面建 object URL（但全项目只显示当前曲那一张）
 *   H1 曲库面板整店订阅 + 每次渲染重算筛选排序（导入时每文件 set 一次进度 → O(n²)）
 * 报告里"1000 首约 200-500MB"是算术不是实测。上一轮蒙版优化的教训摆在那儿：孤立基准
 * 说省 155MB，真实应用里只省了 11MB。所以这次先量再信。
 *
 * 量的是**打包后的真实应用**（走 Tauri 的 fs 与 IPC），不是 vite dev + 浏览器。
 * 导入通过应用自己的 `player://open-files` 通道触发，端到端跑真实代码路径。
 *
 * 进程纪律：只沿着自己 spawn 的那个 PID 往下走进程树来统计内存，退出时也只结束
 * 自己 spawn 的那个进程。发现已有实例在跑就直接报错退出，不去按映像名杀 ——
 * 那是用户的进程，不是这个脚本该动的东西。
 *
 *   node scripts/perf/gen-library.mjs --count=1000 --out=D:\tmp\synth-lib
 *   node scripts/perf/dbg-library.mjs --lib=D:\tmp\synth-lib
 *   node scripts/perf/dbg-library.mjs --lib=D:\tmp\synth-lib --panel
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const PANEL = process.argv.includes("--panel")
const LIB = arg("lib", join(process.env.TEMP ?? ".", "vinyl-synth-lib"))
const PORT = 9223 // 避开 verify-packaged.mjs 的 9222
const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const APPDATA = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "com.vinylplayer.desktop")
const OUT = "tests/__screenshots__"

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}，先跑 npm run tauri build`)
  process.exit(1)
}
if (!existsSync(LIB)) {
  console.error(`找不到合成曲库 ${LIB}，先跑 scripts/perf/gen-library.mjs`)
  process.exit(1)
}

const FILES = readdirSync(LIB)
  .filter((f) => f.endsWith(".mp3"))
  .map((f) => join(LIB, f))
if (FILES.length === 0) {
  console.error(`${LIB} 里没有 .mp3`)
  process.exit(1)
}

/** 只读地看一眼有没有实例在跑。有的话让用户自己关，脚本不替用户做这个决定。 */
const running = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    "@(Get-Process -Name vinyl-player -ErrorAction SilentlyContinue).Count",
  ],
  { encoding: "utf8" },
).trim()
if (running !== "0") {
  console.error(
    `已经有 ${running} 个 vinyl-player 实例在跑。\n` +
      `单实例逻辑会把新进程的参数转交给旧实例，这次测量连不上自己的调试端口。\n` +
      `请先手动关掉它再重跑。`,
  )
  process.exit(1)
}

/**
 * 沿进程树从自己 spawn 的根 PID 往下收，只统计这棵树。
 *
 * 不按映像名扫：那样会把别的实例算进来，数字不干净；更要紧的是这类脚本一旦养成
 * 按名字找进程的习惯，下一步就是按名字动别人的进程。
 */
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

function mem(rootPid) {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", PS_TREE(rootPid)], {
    encoding: "utf8",
    maxBuffer: 8 << 20,
  })
  const parsed = JSON.parse(raw.trim() || "[]")
  const tree = Array.isArray(parsed) ? parsed : [parsed]
  return {
    total: Math.round(tree.reduce((n, x) => n + x.priv, 0)),
    gpu: Math.round(tree.filter((x) => x.type === "gpu-process").reduce((n, x) => n + x.priv, 0)),
    procs: tree.length,
  }
}

/**
 * 从落盘的 library.json 数导入结果。面板关着时界面上没有可读的完成信号。
 * 每首歌在 JSON 里出现三次（id / ref.id / ref.name），所以要去重再数。
 */
function savedCount() {
  try {
    const hits = readFileSync(join(APPDATA, "library.json"), "utf8").match(/synth-\d{4}\.mp3/g) ?? []
    return new Set(hits).size
  } catch {
    return 0
  }
}

// ── 铺设干净状态 ─────────────────────────────────────────────────
mkdirSync(APPDATA, { recursive: true })
mkdirSync(OUT, { recursive: true })
rmSync(join(APPDATA, "library.json"), { force: true })
rmSync(join(APPDATA, "settings.json"), { force: true })
// 波形缓存要清：命中缓存的话导入路径的解码开销就测不出来了
rmSync(join(APPDATA, "cache"), { recursive: true, force: true })

console.log(`合成曲库 ${FILES.length} 首  ←  ${LIB}`)
console.log(`导入时曲库面板：${PANEL ? "开着（H1 的最坏情况）" : "关着"}\n`)

const app = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    // 与 tauri.conf.json 的 additionalBrowserArgs 保持一致 —— 这个环境变量是**覆盖**
    // 而不是追加，漏了就测的不是用户装机后的行为
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      `--remote-debugging-port=${PORT} ` +
      `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService`,
  },
})
app.unref()

/** 只结束自己 spawn 的那棵树 */
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
  console.error("等不到应用的调试端口")
  stopApp()
  process.exit(1)
}
const page = browser.contexts()[0].pages()[0]
await page.waitForTimeout(4000) // 等前端 init()：读配置、放行路径

if (PANEL) {
  await page.evaluate(() => {
    if (!document.querySelector(".library-drawer")) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }))
    }
  })
  await page.waitForTimeout(600)
}

const before = mem(app.pid)
console.log(`导入前：${before.total}MB（GPU ${before.gpu}MB，${before.procs} 个进程）`)

// ── 导入 ─────────────────────────────────────────────────────────
// 走应用自己的 open-files 通道：platform 层批量放行，App.tsx 解析成 FileRef，
// 再进 library.addFiles。端到端，没有为测试开的后门。
const t0 = Date.now()
const emitted = await page.evaluate(async (paths) => {
  try {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "player://open-files",
      payload: paths,
    })
    return "ok"
  } catch (e) {
    return String(e)
  }
}, FILES)
if (emitted !== "ok") {
  console.error(`发不出 open-files 事件：${emitted}`)
  stopApp()
  process.exit(1)
}

let stall = 0
for (let i = 0; i < 1200; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  if (savedCount() >= FILES.length) break
  const live = await page
    .evaluate(() => document.querySelector(".drawer-progress")?.textContent ?? "")
    .catch(() => "")
  if (live) process.stdout.write(`  ${live.trim().slice(0, 44).padEnd(46)}\r`)
  stall = live ? 0 : stall + 1
  if (stall > 900) break // 十五分钟没有任何动静，认输
}
const elapsed = (Date.now() - t0) / 1000

await page.waitForTimeout(2000)
const after = mem(app.pid)

// 强制回收一次再量。导入要把 563MB 文件字节过一遍，这台机器 32GB 内存，V8 的回收
// 阈值被物理内存拉得很高（上一轮实测堆能涨到 269MB 才回收），所以"导入后"这个数
// 里有多少是真常驻、多少只是还没回收的垃圾，必须分开看，否则会去优化一个假问题。
const cdp = await page.context().newCDPSession(page)
await cdp.send("HeapProfiler.collectGarbage")
await page.waitForTimeout(3000)
const afterGc = mem(app.pid)

// 面板关着时到这里才打开，用来核对真的进库了，顺便量一次打开的代价
const rows = await page.evaluate(async () => {
  if (!document.querySelector(".library-drawer")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true }))
  }
  await new Promise((r) => setTimeout(r, 1500))
  return document.querySelectorAll(".lib-main ol li").length
})
const afterPanel = mem(app.pid)

// ── 旧行为值多少钱 ───────────────────────────────────────────────
// 改之前，导入会给每首歌的内嵌封面建一个 object URL 并一直持有。这里在**同一个真实
// 应用进程里**照样造一遍等量的 blob，量出被删掉的那部分到底是多少 —— 比在玩具页面里
// 测可信，也省得为了对照重新构建一个旧版本。
// 注意这是"等量 blob 的常驻成本"，不含旧路径每首多一次拷贝带来的导入耗时。
const COVER_BYTES = 343 * 1024
await page.evaluate(
  async ({ n, size }) => {
    globalThis.__held = []
    for (let i = 0; i < n; i++) {
      const buf = new Uint8Array(size)
      // 每 4KB 写一个字节，逼实际分配物理页，避免被当成稀疏内存
      for (let j = 0; j < size; j += 4096) buf[j] = i & 0xff
      globalThis.__held.push(URL.createObjectURL(new Blob([buf], { type: "image/png" })))
    }
    await new Promise((r) => setTimeout(r, 2000))
  },
  { n: FILES.length, size: COVER_BYTES },
)
await page.waitForTimeout(1500)
const withOldCovers = mem(app.pid)

// ── 报告 ─────────────────────────────────────────────────────────
const line = (k, v) => console.log(`  ${k.padEnd(36)}${v}`)
console.log(`\n─── ${FILES.length} 首  面板${PANEL ? "开" : "关"} ───`)
line("导入耗时", `${elapsed.toFixed(1)}s（${((elapsed / FILES.length) * 1000).toFixed(0)}ms/首）`)
line("落盘条数", `${savedCount()}`)
line("界面列表条数", `${rows}`)
console.log()
line("导入前", `${before.total}MB`)
line("导入后", `${after.total}MB  (${after.total - before.total >= 0 ? "+" : ""}${after.total - before.total})`)
line("强制回收后", `${afterGc.total}MB  (${afterGc.total - after.total})  ← 差额是垃圾不是常驻`)
line("再打开面板后", `${afterPanel.total}MB  (+${afterPanel.total - afterGc.total})`)
line(
  `模拟旧行为：另持有 ${FILES.length} 张封面`,
  `${withOldCovers.total}MB  (+${withOldCovers.total - afterPanel.total})  ← 这就是 M1 省下的`,
)

const result = { count: FILES.length, panel: PANEL, elapsed, rows, before, after, afterGc, afterPanel, withOldCovers }
writeFileSync(join(OUT, `library-bench-${PANEL ? "panel" : "closed"}.json`), JSON.stringify(result, null, 2))
await page.screenshot({ path: join(OUT, `library-bench-${PANEL ? "panel" : "closed"}.png`) })

await browser.close().catch(() => {})
stopApp()
