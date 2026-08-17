/**
 * 黑边填充层（.viewport-bleed）的全屏模糊值多少内存？
 *
 * 装机版测不了的时候用这个：dev 服务器 + **headed** Chromium（真显卡）。
 * 不能用 headless —— 那是 SwiftShader 软件光栅，GPU 侧的开销一概测不出来，
 * 这个坑这个会话已经踩过一次。
 *
 * 每档冷启动一个干净浏览器，设好底图，改完样式再等一会儿量整棵进程树。
 * 顺序很重要：GPU 纹理池冲上高水位不会缩回来，所以"关掉某层"必须在它第一次
 * 被合成之前做，否则量到的还是高水位。这里的做法是每档都重开浏览器。
 *
 *   node scripts/perf/dbg-bleed-dev.mjs
 */
import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const IMG = resolve("tests/real/backdrop-2.jpg")
if (!existsSync(IMG)) {
  console.error(`找不到底图素材 ${IMG}`)
  process.exit(1)
}

/** 只认命令行里带这次专属 user-data-dir 的进程，绝不碰用户自己开的浏览器 */
const PS = (tag) => `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine
$ids = New-Object System.Collections.Generic.HashSet[int]
foreach ($p in $all) { if ($p.CommandLine -like '*${tag}*') { [void]$ids.Add([int]$p.ProcessId) } }
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

function mem(tag) {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", PS(tag)], {
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

async function trial(name, mutate) {
  const tag = `vp-bleed-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const dir = join(tmpdir(), tag)
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: null,
    args: ["--window-size=1900,1040"],
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto("http://localhost:1420/", { waitUntil: "networkidle" })
  await page.waitForTimeout(1200)

  // 样式改动要赶在底图铺上去之前 —— 之后再关，GPU 高水位已经上去了
  if (mutate) await page.addStyleTag({ content: mutate })

  const chooser = page.waitForEvent("filechooser")
  await page.click('button[aria-label="更换底图"]')
  await (await chooser).setFiles(IMG)
  await page.waitForTimeout(5000)

  const info = await page.evaluate(() => {
    const b = document.querySelector(".viewport-bleed")
    return {
      win: `${window.innerWidth}×${window.innerHeight}`,
      bleed: b ? getComputedStyle(b).filter.slice(0, 34) : "无此层",
    }
  })
  const m = mem(tag)
  await ctx.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  return { name, ...m, ...info }
}

const rows = []
rows.push(await trial("① 现状：全屏 blur(34px)", null))
rows.push(await trial("② 去掉模糊，只留压暗", ".viewport-bleed{filter:brightness(.42) saturate(.85)!important}"))
rows.push(await trial("③ 整层不要（回到纯黑边）", ".viewport-bleed{display:none!important}"))
rows.push(
  await trial(
    "④ 再关掉侧栏/按钮的 backdrop-filter",
    ".viewport-bleed{display:none!important}.sb-tool,.skin-quick{backdrop-filter:none!important}",
  ),
)

console.log()
for (const r of rows) {
  console.log(`${r.name.padEnd(30)} 合计 ${String(r.total).padStart(4)}MB  GPU ${String(r.gpu).padStart(4)}MB   ${r.win}  filter=${r.bleed}`)
}
const [a, b, c, d] = rows
console.log(`\n全屏模糊       ${a.total - b.total}MB（GPU ${a.gpu - b.gpu}MB）`)
console.log(`整个黑边填充层  ${a.total - c.total}MB（GPU ${a.gpu - c.gpu}MB）`)
console.log(`小控件的 backdrop-filter  ${c.total - d.total}MB`)
