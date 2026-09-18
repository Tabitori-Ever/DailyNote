@echo off
rem ======================================================================
rem  Diary launcher  (launch.cmd)
rem
rem    _tools\launch.cmd            start server, open browser
rem    _tools\launch.cmd 8899       use another port
rem    _tools\launch.cmd --status   show running state
rem    _tools\launch.cmd --stop     stop the server
rem
rem  WHY THIS FILE IS ASCII + CRLF:
rem  cmd.exe reads .cmd in the system ANSI codepage and requires CRLF line
rem  endings. Non-ASCII bytes or LF-only lines desync its parser and the
rem  whole script breaks. Chinese docs live in README.md instead.
rem
rem  Normally you do not run this directly - double-click "start-diary.vbs"
rem  in the project root.
rem ======================================================================
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%"

where node >nul 2>&1
if errorlevel 1 goto nonode

if /i "%~1"=="--stop"   goto stop
if /i "%~1"=="--status" goto status

rem Detach the server so this window can close right away
rem (otherwise the hidden console would sit and wait on the node process).
rem
rem --idle=3 : the server keeps a heartbeat with the page and exits by itself
rem about 3 minutes after the browser is closed. The grace period absorbs
rem page reloads and tab switches. Pressing the quit button in the page
rem stops it immediately.
if "%~1"=="" (
  start "" /b node "_tools\server.mjs" --open --idle=3
) else (
  start "" /b node "_tools\server.mjs" %* --open --idle=3
)
exit /b 0

:stop
node "_tools\server.mjs" --stop
exit /b %errorlevel%

:status
if exist "data\server.json" (
  type "data\server.json"
  echo.
) else (
  echo Not running: data\server.json not found.
)
exit /b 0

:nonode
echo.
echo   [x] Node.js not found.
echo.
echo   Editing, ledger and Git backup need Node.js.
echo   Install the LTS build from https://nodejs.org and try again.
echo.
pause
exit /b 1