# ======================================================================
#  setup-desktop.ps1 - 在桌面创建「启动 / 停止」快捷方式
#
#  运行方式（二选一）：
#     powershell -ExecutionPolicy Bypass -File _tools\setup-desktop.ps1
#     资源管理器里右键本文件 -> 使用 PowerShell 运行
#
#  生成：
#     「日记 · 桑榆下」    一键启动服务并打开浏览器（无黑框窗口）
#     「日记 · 停止服务」  停掉后台服务
# ======================================================================

$ErrorActionPreference = 'Stop'

# 本脚本位于 _tools\ 下，项目根目录是其上一级
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'index.html'))) {
  Write-Host "[x] 找不到 index.html，请确认脚本仍在 _tools 目录内。" -ForegroundColor Red
  exit 1
}

$Launcher = Join-Path $Root '_tools\launch.cmd'
if (-not (Test-Path $Launcher)) {
  Write-Host "[x] 缺少 $Launcher" -ForegroundColor Red
  exit 1
}

$Desktop = [Environment]::GetFolderPath('Desktop')
$Shell = New-Object -ComObject WScript.Shell
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# 用隐藏窗口的 powershell 去调启动器：服务常驻后台，浏览器自动打开，全程无窗口
function New-DiaryLnk {
  param([string]$LnkPath, [string]$Inner, [string]$Desc)

  $args = @(
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $Inner
  ) -join ' '

  $lnk = $Shell.CreateShortcut($LnkPath)
  $lnk.TargetPath       = $PsExe
  $lnk.Arguments        = $args
  $lnk.WorkingDirectory = $Root
  $lnk.Description      = $Desc
  $lnk.WindowStyle      = 7
  $lnk.IconLocation     = "$env:SystemRoot\System32\shell32.dll,43"
  $lnk.Save()
}

$startLnk = Join-Path $Desktop '日记 · 桑榆下.lnk'
New-DiaryLnk -LnkPath $startLnk -Desc '启动日记本地服务并打开浏览器' `
             -Inner ("& '" + $Launcher + "'")

$stopLnk = Join-Path $Desktop '日记 · 停止服务.lnk'
New-DiaryLnk -LnkPath $stopLnk -Desc '停止日记本地服务' `
             -Inner ("& '" + $Launcher + "' --stop; Start-Sleep -Milliseconds 800")

Write-Host ""
Write-Host "[OK] 已在桌面创建：" -ForegroundColor Green
Write-Host "     $startLnk"
Write-Host "     $stopLnk"
Write-Host ""
Write-Host "接下来（可选）：" -ForegroundColor Cyan
Write-Host "  · 把「日记 · 桑榆下」拖到任务栏，即可固定成任务栏按钮"
Write-Host "  · 右键 -> 属性 -> 更改图标，可换成自己的图标"
Write-Host "  · 开机自启：Win+R 输入 shell:startup，把启动快捷方式复制进去"
Write-Host ""