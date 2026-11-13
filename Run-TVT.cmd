@echo off
setlocal
cd /d "%~dp0_internal"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Ask the TVT maintainer to complete the one-time setup.
  pause
  exit /b 1
)
if not exist "%~dp0_internal\node_modules\tsx\package.json" (
  echo TVT dependencies are missing. Ask the maintainer to complete the one-time setup.
  pause
  exit /b 1
)
node --import tsx "%~dp0_internal\src\operator.ts" --data-directory "%~dp0."
set "TVT_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %TVT_EXIT%