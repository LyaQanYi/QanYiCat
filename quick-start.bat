@echo off
setlocal EnableDelayedExpansion
title QanYiCat - quick start

REM ============================================================
REM  QanYiCat quick-start
REM    - Kill running QQ.exe
REM    - Clear hook / loader logs
REM    - Launch QQ via launcher.exe + hook.dll
REM    - Inside QQ.exe: OneBot (5700/5710/5720) + WebUI (5800)
REM    - Open WebUI in browser once OneBot is reachable
REM    - Tail loader log live (Ctrl-C exits tail; QQ keeps running)
REM ============================================================

set "PROJECT_DIR=%~dp0"
set "LAUNCHER=%PROJECT_DIR%tools\qanyicat-injector\target\release\qanyicat-launcher.exe"
set "HOOK=%PROJECT_DIR%tools\qanyicat-injector\target\release\qanyicat_hook.dll"
set "QQ_FALLBACK=C:\Program Files\Tencent\QQNT\QQ.exe"

set "ONEBOT_PORT=5700"
set "WEBUI_PORT=5800"

REM -- WebUI credentials ---------------------------------------
REM    Password is now persisted to %PROJECT_DIR%qanyicat.webui.passkey.json
REM    (bridge auto-generates one on first boot, reuses on subsequent boots).
REM    Set QANYICAT_WEBUI_PASSWORD here to override the persisted value for
REM    this one launch (env always wins). Leave commented to use the file.
set "QANYICAT_WEBUI_ENABLE=1"
set "QANYICAT_WEBUI_PORT=%WEBUI_PORT%"
set "QANYICAT_WEBUI_PASSKEY_PATH=%PROJECT_DIR%qanyicat.webui.passkey.json"
REM set "QANYICAT_WEBUI_PASSWORD=qanyicat"

REM -- MediaIndex persistence ----------------------------------
REM    Survives QQ relaunch so get_video / get_file work for previously-seen
REM    media without re-priming via get_*_msg_history. Comment out for
REM    in-memory-only behavior.
set "QANYICAT_MEDIA_INDEX_PATH=%PROJECT_DIR%qanyicat.media-index.json"

REM -- UidUinCache persistence ---------------------------------
REM    Survives QQ relaunch so the friend/group uid↔uin (+ nick) map doesn't
REM    have to re-prime from scratch on every boot — speeds up first
REM    get_friend_list / get_group_member_list calls after a restart.
set "QANYICAT_UID_UIN_CACHE_PATH=%PROJECT_DIR%qanyicat.uid-uin-cache.json"

REM -- Resolve QQ.exe via launcher --resolve-qq, fall back to hard-coded ----
REM    The launcher binary reads HKLM\...\Uninstall\QQ /v UninstallString
REM    itself (KEY_WOW64_32KEY) and prints the resolved QQ.exe path on stdout.
REM    Exit 0 = ok, 3 = registry miss, anything else = bad usage.
REM    Keeping a one-call surface in the bat means future resolution tweaks
REM    happen in one place (the launcher) instead of duplicated batch logic.
set "QQ_EXE="
if exist "%LAUNCHER%" (
  "%LAUNCHER%" --resolve-qq > "%TEMP%\qanyicat-qq-path.txt" 2>nul
  if "!ERRORLEVEL!"=="0" (
    set /p QQ_EXE=<"%TEMP%\qanyicat-qq-path.txt"
  )
  del /F "%TEMP%\qanyicat-qq-path.txt" >nul 2>&1
)
if defined QQ_EXE (
  if not exist "!QQ_EXE!" set "QQ_EXE="
)
if not defined QQ_EXE (
  if exist "%QQ_FALLBACK%" (
    set "QQ_EXE=%QQ_FALLBACK%"
  )
)

echo.
echo ============================================================
echo   QanYiCat quick start
echo ------------------------------------------------------------
echo   QQ.exe      : %QQ_EXE%
echo   OneBot HTTP : http://127.0.0.1:%ONEBOT_PORT%
echo   OneBot WS   : ws://127.0.0.1:5710
echo   OneBot v12  : http://127.0.0.1:5720
echo   WebUI       : http://127.0.0.1:%WEBUI_PORT%
if defined QANYICAT_WEBUI_PASSWORD (
  echo   WebUI pass  : %QANYICAT_WEBUI_PASSWORD% ^(from env^)
) else (
  echo   WebUI pass  : ^(persisted in qanyicat.webui.passkey.json; see loader log on first boot^)
)
echo ============================================================
echo.

REM -- Sanity checks -------------------------------------------
if not exist "%LAUNCHER%" (
  echo [X] launcher not found: %LAUNCHER%
  echo     build it first: cargo build --release in tools\qanyicat-injector
  goto :err
)
if not exist "%HOOK%" (
  echo [X] hook DLL not found: %HOOK%
  goto :err
)
if not defined QQ_EXE (
  echo [X] QQ.exe not located. Tried:
  echo       1. launcher --resolve-qq (registry HKLM\...\Uninstall\QQ)
  echo       2. Fallback: %QQ_FALLBACK%
  echo     Edit QQ_FALLBACK at the top of this script if QQ is elsewhere.
  goto :err
)

REM -- Kill running QQ -----------------------------------------
echo [1/4] killing existing QQ processes...
taskkill /F /IM QQ.exe >nul 2>&1
timeout /t 1 /nobreak >nul

REM -- Clear logs ----------------------------------------------
echo [2/4] clearing hook / loader logs...
if exist "%TEMP%\qanyicat-hook.log" del /F "%TEMP%\qanyicat-hook.log"
if exist "%TEMP%\qanyicat-loader-in-qq.log" del /F "%TEMP%\qanyicat-loader-in-qq.log"

REM -- Inject + launch -----------------------------------------
echo [3/4] launching QQ with hook DLL...
start "" "%LAUNCHER%" "%QQ_EXE%" "%HOOK%"

REM -- Wait for OneBot -----------------------------------------
echo [4/4] waiting for OneBot HTTP %ONEBOT_PORT% (up to 120s, QR scan may be needed)...
set /a "WAIT_SEC=0"
:waitloop
timeout /t 2 /nobreak >nul
set /a "WAIT_SEC+=2"
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:%ONEBOT_PORT%/get_status' -Method POST -TimeoutSec 1 -UseBasicParsing).StatusCode } catch { 0 }" > "%TEMP%\qanyicat-probe.txt" 2>nul
set /p PROBE=<"%TEMP%\qanyicat-probe.txt"
if "!PROBE!"=="200" goto :ready
if !WAIT_SEC! GEQ 120 (
  echo.
  echo [!] still not ready after %WAIT_SEC%s. check:
  echo     - QQ login window: scanned QR?
  echo     - %TEMP%\qanyicat-loader-in-qq.log : look for 'OneBotManager started'
  goto :stay
)
<nul set /p ="."
goto :waitloop

:ready
del /F "%TEMP%\qanyicat-probe.txt" >nul 2>&1
echo.
echo [OK] OneBot is up (%WAIT_SEC%s). opening WebUI...
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:%WEBUI_PORT%"

:stay
echo.
echo ------------------------------------------------------------
echo  QanYiCat is running inside QQ.exe.
echo  Tailing loader log below (Ctrl-C to stop tail; bot keeps running).
echo  To stop the bot: quit QQ.
echo ------------------------------------------------------------
echo.

REM -- Live log tail in the same window. Ctrl-C only kills the tail
REM    powershell process, not QQ.exe (the bot lives inside QQ).
REM    -Wait keeps streaming; -Tail 50 backfills recent context.
if exist "%TEMP%\qanyicat-loader-in-qq.log" (
  powershell -NoProfile -Command "Get-Content -Wait -Tail 50 -LiteralPath '%TEMP%\qanyicat-loader-in-qq.log'"
) else (
  echo [!] loader log not present yet: %TEMP%\qanyicat-loader-in-qq.log
  pause
)
goto :eof

:err
echo.
pause
exit /b 1
