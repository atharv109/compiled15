@echo off
REM ============================================================
REM  CallCrowd demo launcher - starts all three services
REM  8300 = Google reviews sidecar (scouts read from it)
REM  8000 = FastAPI backend (THE product API)
REM  9000 = static frontend server (the pages you open in a browser)
REM  Close the spawned windows to stop a service. Run as many times as you like.
REM ============================================================
setlocal
set PY=C:\Users\athar\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\python.exe
set ROOT=%~dp0..

echo [1/3] Google Reviews sidecar (port 8300) ...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8300 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  already running' } else { Start-Process cmd -ArgumentList '/k cd /d %ROOT%\services\google-reviews-scraper-pro && set PYTHONUTF8=1&& set PYTHONIOENCODING=utf-8&& %PY% -m uvicorn api_server:app --host 127.0.0.1 --port 8300 --log-level info' }"

echo [2/3] Backend (port 8000) ...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  already running' } else { Start-Process cmd -ArgumentList '/k cd /d %ROOT% && %PY% -X utf8 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level info' }"

echo [3/3] Frontend static server (port 9000) ...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  already running' } else { Start-Process cmd -ArgumentList '/k cd /d %ROOT%\static && %PY% -m http.server 9000 --bind 127.0.0.1' }"

echo.
echo Done. Open the console at:  http://127.0.0.1:9000/console.html
echo (recorded demo:            http://127.0.0.1:9000/console.html?mock=1)
pause