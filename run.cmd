@echo off
rem Brain map: read-only viewer for the tiered memory stores.
rem Extra args go to server.py, e.g.  run.cmd --snapshot C:\path\to\claude-env@murr2
setlocal
set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo No project venv at %~dp0.venv
  echo Setup:  py -3 -m venv "%~dp0.venv"
  echo It is stdlib only; nothing to pip install.
  pause
  exit /b 1
)
"%PY%" "%~dp0brainmap\server.py" --open %*
if errorlevel 1 (
  echo.
  echo server.py exited with an error. Is port 8770 already in use?
  echo   Get-NetTCPConnection -State Listen -LocalPort 8770
  pause
)
