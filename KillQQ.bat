@echo off
REM ============================================================
REM  KillQQ.bat -- stop the QQ.exe process tree without rebooting
REM  the whole launcher flow. Use when you just want the bot off.
REM
REM  After this finishes, double-click quick-start.bat to bring
REM  everything back up (hook injection + WebUI + OneBot wire).
REM ============================================================
echo Stopping QQ.exe and child processes...
taskkill /F /IM QQ.exe /T >nul 2>&1
if errorlevel 1 (
  echo [info] no QQ.exe was running.
) else (
  echo [ok] QQ.exe terminated.
)
