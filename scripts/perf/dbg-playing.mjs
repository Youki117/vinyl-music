/**
 * 让打包应用真正播起来，然后挂住，方便外部量内存/CPU。
 *
 * 用 CDP 而不是发按键：能**确认播放真的开始了**（进度在推进），不是假设。
 * 代价是多一个 --remote-debugging-port，开销很小，但对比时要记得两边条件一致。
 *
 *   node scripts/perf/dbg-playing.mjs
 */
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { resolve } from "node:path"

const EXE = resolve("src-tauri/target/release/vinyl-player.exe")
const PORT = 9223
const HOLD_SEC = Number(process.env.HOLD_SEC ?? 180)

const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
  detached: false,
})
console.log(`根 PID ${app.pid}`)

let browser = null
for (let i = 0; i < 40 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null)
}
if (!browser) { console.error("连不上 CDP"); app.kill(); process.exit(1) }

const ctx = browser.contexts()[0]
const page = ctx.pages()[0] ?? (await ctx.waitForEvent("page"))
await page.waitForTimeout(3000)

const lib = await page.evaluate(() => document.querySelectorAll(".drawer li").length)
// 打开曲库、双击第一首起播
await page.keyboard.press("p")
await page.waitForTimeout(800)
const rows = await page.locator(".drawer li").count()
if (rows > 0) {
  await page.locator(".drawer li").first().dblclick()
  await page.waitForTimeout(1500)
}
await page.keyboard.press("Escape")
await page.waitForTimeout(500)

// 确认真的在播：采两次进度看有没有推进
const read = () => page.evaluate(() => {
  const a = document.querySelector("audio")
  return { t: a?.currentTime ?? -1, paused: a?.paused ?? true, src: (a?.src ?? "").slice(-40) }
})
const s1 = await read()
await page.waitForTimeout(3000)
const s2 = await read()

console.log(`曲库条目 ${rows}（初始 ${lib}）`)
console.log(`音频: paused=${s2.paused}  ${s1.t.toFixed(2)}s → ${s2.t.toFixed(2)}s  src…${s2.src}`)
console.log(s2.t > s1.t && !s2.paused ? "✓ 确认正在播放" : "✗ 没有播起来")
// 自己量，不依赖外部工具的时序。按进程树归属，与洛雪/Spotube 同一套口径。
const ps = String.raw`
$rootId = ${app.pid}
$all = Get-CimInstance Win32_Process
$byParent=@{}; foreach($p in $all){$pp=[int]$p.ParentProcessId; if(-not $byParent.ContainsKey($pp)){$byParent[$pp]=New-Object System.Collections.ArrayList}; [void]$byParent[$pp].Add([int]$p.ProcessId)}
$ids=New-Object System.Collections.ArrayList; $q=New-Object System.Collections.Queue; $q.Enqueue($rootId); $seen=@{}
while($q.Count -gt 0){$id=$q.Dequeue(); if($seen[$id]){continue}; $seen[$id]=$true; [void]$ids.Add($id); if($byParent.ContainsKey($id)){foreach($c in $byParent[$id]){$q.Enqueue($c)}}}
$rows = $ids | ForEach-Object { $pr=Get-Process -Id $_ -EA SilentlyContinue; $ci=$all|Where-Object{[int]$_.ProcessId -eq $_}
  if($pr){ $cl=($all|Where-Object{[int]$_.ProcessId -eq $pr.Id}).CommandLine; $t='browser/app'
    if($cl -match '--type=([a-zA-Z\-]+)'){$t=$Matches[1]}
    if($cl -match '--utility-sub-type=([^\s]+)'){$t+=':'+($Matches[1] -replace '.*\.','')}
    [pscustomobject]@{Role=$t;PrivMB=[math]::Round($pr.PrivateMemorySize64/1MB,1);WsMB=[math]::Round($pr.WorkingSet64/1MB,1)} } }
$rows | Sort-Object WsMB -Descending | Format-Table -AutoSize | Out-String
"合计: Private {0} MB   WorkingSet {1} MB   ({2} 进程)" -f ($rows|Measure-Object PrivMB -Sum).Sum,($rows|Measure-Object WsMB -Sum).Sum,$rows.Count
$c0=0.0; foreach($i in $ids){$pr=Get-Process -Id $i -EA SilentlyContinue; if($pr){$c0+=$pr.TotalProcessorTime.TotalSeconds}}
$t0=Get-Date; Start-Sleep -Seconds 25
$c1=0.0; foreach($i in $ids){$pr=Get-Process -Id $i -EA SilentlyContinue; if($pr){$c1+=$pr.TotalProcessorTime.TotalSeconds}}
$el=((Get-Date)-$t0).TotalSeconds
"播放中 CPU: {0}%  ({1} 核 / 采样 {2}s)" -f [math]::Round((($c1-$c0)/$el/[Environment]::ProcessorCount)*100,2),[Environment]::ProcessorCount,[math]::Round($el,1)
`
console.log("")
console.log("===== 我们 Vinyl Player · 播放中 =====")
console.log(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", maxBuffer: 1 << 22 }))

await browser.close().catch(() => {})
app.kill()
