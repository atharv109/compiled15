@echo off
REM ============================================================
REM  CallCrowd demo launcher — portable (no hardcoded paths).
REM  Starts: 1) review sidecar :8300  2) backend :8000  3) frontend :9000
REM  Skips anything already running; safe to double-click any time.
REM
REM  PREREQUISITES (one-time, see README "Setup"):
REM    1) Python 3.10+ on PATH (or the py launcher)
REM    2) repo venv built:   python -m venv venv
REM                          venv\Scripts\python -m pip install -r requirements.txt
REM    3) .env present (copy .env.example, fill keys)
REM    4) sidecar venv:      services\google-reviews-scraper-pro  (venv + config.yaml;
REM                          clone it separately — it is git-ignored)
REM ============================================================
setlocal EnableDelayedExpansion
set ROOT=%~dp0..

REM --- resolve python: repo venv first, else py/python from PATH ---
set PY=%ROOT%\venv\Scripts\python.exe
if not exist "%PY%" (
  for %%P in ("py" "python" "python3") do (
    %%~P -c "" >nul 2>&1 && set PY=%%~P && goto :havePy
  )
  echo ERROR: no Python found ^(need 3.10+^). See README "Setup".
  pause & exit /b 1
)
:havePy
echo python = %PY%

REM --- 1) sidecar :8300 (needs its OWN venv + UTF-8 for console output) ---
set SC=%ROOT%\services\google-reviews-scraper-pro
if exist "%SC%\venv\Scripts\python.exe" (
  echo [1/3] review sidecar :8300 ...
  powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8300 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  already running' } else { Start-Process cmd -ArgumentList '/k cd /d ""%SC%"" && set PYTHONUTF8=1&& set PYTHONIOENCODING=utf-8&& venv\Scripts\python.exe -m uvicorn api_server:app --host 127.0.0.1 --port 8300 --log-level info' }"
) else (
  echo [1/3] review sidecar SKIPPED — services\google-reviews-scraper-pro not set up; backend will fall back to pasted/manual reviews.
)

REM --- 2) backend :8000 ---
echo [2/3] backend :8000 ...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  already running' } else { Start-Process cmd -ArgumentList '/k cd /d ""%ROOT%"" && set PYTHONUTF8=1&& ""%PY%"" -X utf8 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level info' }"

REM --- 3) frontend :9000 ---
echo [3/3] frontend :9000 ...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  already running' } else { Start-Process cmd -ArgumentList '/k cd /d ""%ROOT%\static"" && ""%PY%"" -m http.server 9000 --bind 127.0.0.1' }"

echo.
echo When green: console = http://127.0.0.1:9000/console.html   API = http://127.0.0.1:8000/docs
pause
