/**
 * 第一性原理：一个 Chromium 壳子在这台机器上，什么都不干要多少内存？
 *
 * 拿别人自报的"360MB"和我实测的"830MB"直接比是错的 —— 机器不同、统计口径不同、
 * V8 堆上限还随物理内存变化。要比就得先量出这台机器上的"地板"：
 *   ① 空白页        → 纯运行时地板
 *   ② 一个全屏 div   → 加上合成器/光栅化
 *   ③ 一个全屏 WebGL2 画布 → 加上 ANGLE/D3D11 上下文
 * 我们自己的 318MB（禁 WebGL 时）里，有多少是这地板，有多少才是"我们写的代码"。
 *
 * 用 Playwright 自带的 Chromium：跟 WebView2 是同一套 content 架构、同一套进程模型。
 * 版本号不完全一致，但地板量级是一回事。整棵树只包含我自己 spawn 出来的进程。
 */
import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** 只认命令行里带我这次专属 user-data-dir 的进程，绝不碰用户自己开的浏览器 */
const PS = (tag) => `
$all = Get-CimInstance Win32_Process
$ids = New-Object System.Collections.Generic.HashSet[int]
foreach ($p in $all) { if ($p.CommandLine -like '*${tag}*') { [void]$ids.Add([int]$p.ProcessId) } }
for ($i = 0; $i -lt 6; $i++) {
  foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } }
}
$out = foreach ($id in $ids) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $ci = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
  $type = 'main'
  if ($ci.CommandLine -match '--type=([a-z-]+)') { $type = $Matches[1] }
  [pscustomobject]@{ type = $type; priv = [math]::Round($p.PrivateMemorySize64 / 1MB, 1) }
}
ConvertTo-Json -InputObject @($out) -Compress
`

function mem(tag) {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", PS(tag)], { encoding: "utf8" })
  const parsed = JSON.parse(raw.trim() || "[]")
  const tree = Array.isArray(parsed) ? parsed : [parsed]
  const by = (t) => Math.round(tree.filter((x) => x.type === t).reduce((n, x) => n + x.priv, 0))
  return {
    total: Math.round(tree.reduce((n, x) => n + x.priv, 0)),
    gpu: by("gpu-process"),
    renderer: by("renderer"),
    procs: tree.length,
  }
}

// data: URL 里的 `#version 300 es` 会被当成 URL 片段截断，必须走真实文件
const HERE = "file:///C:/Users/mstanjw/AppData/Local/Temp/claude/C--Users-mstanjw/486c2642-e0bf-400d-8bc1-e5da29ade85d/scratchpad/floor"
const BLANK = `${HERE}/blank.html`
const CSS_LAYER = `${HERE}/css.html`
const GL_LAYER = `${HERE}/gl.html`
/** 我们蒙版当前的实际后备缓冲：2440×1351 ≈ 13MB */
const GL_VEIL = `${HERE}/gl.html?w=2440&h=1351`

async function trial(name, url) {
  const tag = `vp-floor-${Date.now()}`
  const dir = join(tmpdir(), tag)
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: null,
    args: ["--window-size=1280,760"],
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto(url)
  await page.waitForTimeout(4500)

  const info = await page.evaluate(() => {
    const c = document.querySelector("canvas")
    return {
      dpr: devicePixelRatio,
      w: c?.width ?? 0,
      h: c?.height ?? 0,
      bufMB: c ? Math.round((c.width * c.height * 4) / 1024 / 1024) : 0,
    }
  })
  const m = mem(tag)
  console.log(
    `${name.padEnd(26)} 合计 ${String(m.total).padStart(4)}MB  ` +
      `gpu ${String(m.gpu).padStart(3)}  渲染器 ${String(m.renderer).padStart(3)}  ` +
      `进程 ${m.procs}` +
      (info.w ? `  画布 ${info.w}×${info.h}(${info.bufMB}MB)` : ""),
  )
  await ctx.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  return m
}

console.log(`每项都是"只属于这次 spawn"的整棵进程树的 Private Bytes\n`)
const a = await trial("① 空白页", BLANK)
const b = await trial("② 全屏 CSS 模糊层", CSS_LAYER)
const c = await trial("③ WebGL2 视口尺寸", GL_LAYER)
const d = await trial("④ WebGL2 2440×1351", GL_VEIL)

console.log(`\n差值（相对空白页）：`)
console.log(`  CSS 模糊层        +${b.total - a.total}MB（gpu +${b.gpu - a.gpu}）`)
console.log(`  WebGL 视口尺寸     +${c.total - a.total}MB（gpu +${c.gpu - a.gpu}）`)
console.log(`  WebGL 2440×1351   +${d.total - a.total}MB（gpu +${d.gpu - a.gpu}）`)
console.log(`\n画布从视口尺寸放大到 2440×1351 的代价：+${d.total - c.total}MB（gpu +${d.gpu - c.gpu}）`)
