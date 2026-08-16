# 从系统侧查 Windows 全局媒体会话，确认应用真的注册上了 SMTC。
#
# 这件事没法在 WebView 里验证 —— 会话由操作系统管理，只能从外面问系统。
# 用的是任务栏那个音乐控件背后的同一份数据。
#
# 必须用 Windows PowerShell 5.1 跑：PowerShell 7 去掉了 WinRT 类型投影，
# [Windows.Media.Control...] 这种写法在 pwsh 里解析不出来。
#
#   powershell.exe -NoProfile -File scripts/smtc-probe.ps1
#   powershell.exe -NoProfile -File scripts/smtc-probe.ps1 -Action next
#
# 带 -Action 时会从系统侧按下对应按钮，用来验证事件真的回得到应用里 ——
# 「按钮是亮的」和「按下去有反应」是两回事。

param([string]$Action = "")

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# WinRT 的异步操作在 PowerShell 里要手动转成 Task 再等
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(5000) | Out-Null
    $task.Result
}

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

$mgr = Await ($mgrType::RequestAsync()) $mgrType
$sessions = @($mgr.GetSessions())

Write-Output "SESSIONS=$($sessions.Count)"
foreach ($s in $sessions) { Write-Output "SESSION=$($s.SourceAppUserModelId)" }

$found = $sessions | Where-Object { $_.SourceAppUserModelId -match 'vinyl' } | Select-Object -First 1
if (-not $found) {
    Write-Output "SMTC_FOUND=0"
    exit 1
}

if ($Action) {
    $boolType = [bool]
    switch ($Action) {
        "next"  { $op = $found.TrySkipNextAsync() }
        "prev"  { $op = $found.TrySkipPreviousAsync() }
        "pause" { $op = $found.TryPauseAsync() }
        "play"  { $op = $found.TryPlayAsync() }
        default { throw "未知动作：$Action" }
    }
    $ok = Await $op $boolType
    Write-Output "ACTION=$Action"
    Write-Output "ACTION_OK=$ok"
    Start-Sleep -Milliseconds 500
}

$props = Await ($found.TryGetMediaPropertiesAsync()) $propType
$info = $found.GetPlaybackInfo()

Write-Output "SMTC_FOUND=1"
Write-Output "TITLE=$($props.Title)"
Write-Output "ARTIST=$($props.Artist)"
Write-Output "ALBUM=$($props.AlbumTitle)"
Write-Output "STATUS=$($info.PlaybackStatus)"
Write-Output "CAN_NEXT=$($info.Controls.IsNextEnabled)"
Write-Output "CAN_PREV=$($info.Controls.IsPreviousEnabled)"
Write-Output "CAN_PAUSE=$($info.Controls.IsPauseEnabled)"
Write-Output "HAS_THUMB=$(if ($props.Thumbnail) { 'True' } else { 'False' })"
