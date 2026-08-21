/**
 * 画布尺寸到底值多少钱？
 *
 * 之前那次是把活着的画布 `c.width = 64` 改小再量，ANGLE 不一定马上归还旧资源，
 * 数字不可信。这次每个尺寸都冷启动一个干净的浏览器，同一份页面只换 ?w=&h=。
 * 每档跑两遍，因为上一轮已经看到同尺寸两次测量能差 9MB。
 */
import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PS = (tag) => `
$all = Get-CimInstance Win32_Process
$ids = New-Object System.Collections.Generic.HashSet[int]
foreach ($p in $all) { if ($p.CommandLine -like '*${tag}*') { [void]$ids.Add([int]$p.ProcessId) } }
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
  return {
    total: Math.round(tree.reduce((n, x) => n + x.priv, 0)),
    gpu: Math.round(tree.filter((x) => x.type === "gpu-process").reduce((n, x) => n + x.priv, 0)),
  }
}

/** 测量页在 scripts/perf/floor/，路径现算不写死，理由见 dbg-floor.mjs 同一处 */
const HERE = new URL("./floor", import.meta.url).href

async function once(url) {
  const tag = `vp-size-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const dir = join(tmpdir(), tag)
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: null,
    args: ["--window-size=1280,760"],
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto(url)
  await page.waitForTimeout(4500)
  const m = mem(tag)
  await ctx.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  return m
}

async function trial(name, url) {
  const runs = [await once(url), await once(url)]
  const avg = (k) => Math.round((runs[0][k] + runs[1][k]) / 2)
  console.log(
    `${name.padEnd(28)} 合计 ${String(avg("total")).padStart(4)}MB  gpu ${String(avg("gpu")).padStart(3)}MB` +
      `   (两次: ${runs[0].total}/${runs[1].total})`,
  )
  return { total: avg("total"), gpu: avg("gpu") }
}

const SIZES = [
  ["蒙版现状 2440×1351 (13MB)", 2440, 1351],
  ["一半    1220×676  (3.3MB)", 1220, 676],
  ["四分之一 610×338   (0.8MB)", 610, 338],
  ["八分之一 305×169   (0.2MB)", 305, 169],
]

console.log("每档冷启动两次取平均\n")
const blank = await trial("① 空白页（地板）", `${HERE}/blank.html`)
const css = await trial("② CSS blur(40px) 全屏", `${HERE}/css.html`)
const out = []
for (const [name, w, h] of SIZES) {
  out.push([name, await trial(`③ WebGL ${name}`, `${HERE}/gl.html?w=${w}&h=${h}`)])
}

console.log(`\n地板 = ${blank.total}MB。往上加：`)
console.log(`  纯 CSS 模糊层            +${css.total - blank.total}MB`)
for (const [name, m] of out) {
  console.log(`  WebGL ${name.padEnd(24)} +${m.total - blank.total}MB`)
}
const big = out[0][1]
const small = out[out.length - 1][1]
console.log(`\n把画布从 13MB 缩到 0.2MB，只省 ${big.total - small.total}MB`)
console.log(`→ WebGL 的钱主要花在"有没有上下文"，不在"画布多大"`)
