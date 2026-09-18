# ======================================================================
#  setup-desktop.ps1 - 在桌面创建「日记」快捷方式
#
#  运行方式（二选一）：
#     powershell -ExecutionPolicy Bypass -File _tools\setup-desktop.ps1
#     资源管理器里右键本文件 -> 使用 PowerShell 运行
#
#  只创建一个快捷方式：
#     「日记 · 桑榆下」  一键启动并打开浏览器（无黑框窗口）
#
#  不需要「停止服务」快捷方式：服务会跟浏览器一起结束 ——
#  关掉页面约 3 分钟后自动退出，页面右上角的退出按钮则立即停止。
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

$Icon = Join-Path $Root 'assets\icons\diary.ico'
if (-not (Test-Path $Icon)) {
  Write-Host "[!] 找不到图标 $Icon" -ForegroundColor Yellow
  Write-Host "    先运行 python _tools\make-icon.py 生成，或改用系统图标。"
  $Icon = "$env:SystemRoot\System32\shell32.dll,43"
}

$Desktop = [Environment]::GetFolderPath('Desktop')
$Shell = New-Object -ComObject WScript.Shell
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# 用隐藏窗口的 powershell 去调启动器：服务在后台，浏览器自动打开，全程无窗口
function New-DiaryLnk {
  param([string]$LnkPath, [string]$Inner, [string]$Desc)

  $argLine = @(
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $Inner
  ) -join ' '

  $lnk = $Shell.CreateShortcut($LnkPath)
  $lnk.TargetPath       = $PsExe
  $lnk.Arguments        = $argLine
  $lnk.WorkingDirectory = $Root
  $lnk.Description      = $Desc
  $lnk.WindowStyle      = 7
  $lnk.IconLocation     = $Icon
  $lnk.Save()
}

$startLnk = Join-Path $Desktop '日记 · 桑榆下.lnk'
New-DiaryLnk -LnkPath $startLnk -Desc '启动日记并打开浏览器' `
             -Inner ("& '" + $Launcher + "'")

# 清掉早期版本留下的「停止服务」快捷方式
$oldStop = Join-Path $Desktop '日记 · 停止服务.lnk'
if (Test-Path $oldStop) {
  Remove-Item $oldStop -Force
  Write-Host "[i] 已删除旧的「日记 · 停止服务」快捷方式" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "[OK] 桌面快捷方式：" -ForegroundColor Green
Write-Host "     $startLnk"
Write-Host "     图标: $Icon"
Write-Host ""
Write-Host "服务怎么结束：" -ForegroundColor Cyan
Write-Host "  · 关掉浏览器页面，约 3 分钟后服务自动退出"
Write-Host "  · 或在页面右上角点退出按钮，立即停止"
Write-Host ""
Write-Host "接下来（可选）：" -ForegroundColor Cyan
Write-Host "  · 把快捷方式拖到任务栏，即可固定成任务栏按钮"
Write-Host "  · 开机自启：Win+R 输入 shell:startup，把快捷方式复制进去"
Write-Host ""