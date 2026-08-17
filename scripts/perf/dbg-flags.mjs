/**
 * 两个候选开关能压下多少，以及会不会把画面弄坏。
 *  A 限制 V8 老生代上限 → 逼 GC 早点动手，直接压住堆峰值
 *  B GPU 进程内联      → 省掉一个独立进程的运行时副本
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { resolve } from "node:path"

const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const BASE = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService"
const PORT = 9226

const PS = `
$root = Get-Process -Name vinyl-player -ErrorAction SilentlyContinue
if (-not $root) { '[]'; exit }
$all = Get-CimInstance Win32_Process
$ids = New-Object System.Collections.Generic.HashSet[int]
foreach ($r in $root) { [void]$ids.Add($r.Id) }
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

function mem() {
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", PS], { encoding: "utf8" })
  const parsed = JSON.parse(raw.trim() || "[]")
  const tree = Array.isArray(parsed) ? parsed : [parsed]
  return Math.round(tree.reduce((n, x) => n + x.priv, 0))
}

async function trial(name, extra, shot) {
  try {
    execFileSync("taskkill", ["/IM", "vinyl-player.exe", "/F"], { stdio: "ignore" })
  } catch {}
  await new Promise((r) => setTimeout(r, 1500))

  const app = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} ${BASE} ${extra}` },
  })
  app.unref()

  let b = null
  for (let i = 0; i < 40 && !b; i++) {
    await new Promise((r) => setTimeout(r, 400))
    b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
  }
  if (!b) return console.log(`${name}: 起不来`)
  const p = b.contexts()[0].pages()[0]
  await p.waitForSelector(".stage", { timeout: 15000 })
  await p.waitForTimeout(3000)
  const idle = mem()

  // 播两轮，制造堆压力
  await p.click(".disc")
  await p.waitForTimeout(7000)
  for (let r = 0; r < 8; r++) {
    await p.click('.controls button[aria-label="下一首"]')
    await p.waitForTimeout(5000)
  }
  const peak = mem()
  const heap = await p.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1024 / 1024))

  // 画面有没有坏：蒙版画布 + 唱片在不在，再截一张
  const ui = await p.evaluate(() => {
    const c = document.querySelector("canvas.veil")
    return {
      veil: !!c && c.width > 0,
      gl: !!(c && c.getContext("webgl2")),
      disc: !!document.querySelector(".disc"),
      spinning: document.querySelector(".disc")
        ? getComputedStyle(document.querySelector(".disc")).animationPlayState
        : "?",
    }
  })
  if (shot) await p.screenshot({ path: `tests/__screenshots__/${shot}` })

  console.log(
    `${name.padEnd(30)} 空闲 ${String(idle).padStart(4)}MB → 播完 ${String(peak).padStart(4)}MB` +
      `  JS堆 ${String(heap).padStart(3)}MB  蒙版:${ui.gl ? "WebGL" : "无"} 唱片:${ui.spinning}`,
  )
  await b.close()
}

await trial("① 现状", "", "flag-base.png")
await trial("② V8 老生代上限 192MB", '--js-flags="--max-old-space-size=192"', "flag-v8.png")
await trial("③ GPU 内联", "--in-process-gpu", "flag-gpu.png")
await trial("④ 两个都开", '--in-process-gpu --js-flags="--max-old-space-size=192"', "flag-both.png")

try {
  execFileSync("taskkill", ["/IM", "vinyl-player.exe", "/F"], { stdio: "ignore" })
} catch {}
