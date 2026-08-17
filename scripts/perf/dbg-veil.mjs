/**
 * 那 115MB 是"画布太大"还是"开了 WebGL 上下文"？
 *
 * 这两个结论指向完全不同的做法：
 *  - 画布太大 → 降分辨率就行，蒙版是柔和的雾，肉眼看不出
 *  - 上下文固定开销 → 降分辨率白费力气，只能在"要不要 WebGL"之间二选一
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { resolve } from "node:path"

const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const BASE = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService"
const PORT = 9227

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
  return {
    total: Math.round(tree.reduce((n, x) => n + x.priv, 0)),
    gpu: Math.round(tree.filter((x) => x.type === "gpu-process").reduce((n, x) => n + x.priv, 0)),
  }
}

async function trial(name, extra, shrinkTo) {
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
  await p.waitForTimeout(4000)

  // 直接把画布缩到指定尺寸，看 GPU 内存跟不跟着降
  if (shrinkTo) {
    await p.evaluate((n) => {
      const c = document.querySelector("canvas.veil")
      if (c) {
        c.width = n
        c.height = n
      }
    }, shrinkTo)
    await p.waitForTimeout(4000)
  }

  const info = await p.evaluate(() => {
    const c = document.querySelector("canvas.veil")
    return {
      w: c?.width ?? 0,
      h: c?.height ?? 0,
      dpr: window.devicePixelRatio,
      bufMB: c ? Math.round((c.width * c.height * 4) / 1024 / 1024) : 0,
    }
  })
  const m = mem()
  console.log(
    `${name.padEnd(30)} 画布 ${String(info.w).padStart(4)}×${String(info.h).padStart(4)} (dpr ${info.dpr}, 缓冲 ${info.bufMB}MB)` +
      `  →  合计 ${String(m.total).padStart(4)}MB  gpu ${String(m.gpu).padStart(3)}MB`,
  )
  await b.close()
}

await trial("① 现状", "")
await trial("② 画布缩到 64×64", "", 64)
await trial("③ 设备像素比 0.5", "--force-device-scale-factor=0.5")
await trial("④ 禁 WebGL（对照）", "--disable-webgl --disable-webgl2")

try {
  execFileSync("taskkill", ["/IM", "vinyl-player.exe", "/F"], { stdio: "ignore" })
} catch {}
