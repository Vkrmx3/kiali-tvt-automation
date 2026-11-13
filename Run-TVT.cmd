@echo off
setlocal
set "TVT_ROOT=%~dp0"
cd /d "%TVT_ROOT%_internal"
if errorlevel 1 (
  echo The TVT folder is incomplete. Ask for the complete folder including _internal.
  pause
  exit /b 1
)
if not exist "%TVT_ROOT%_internal\setup.mjs" (
  echo TVT setup files are missing. Ask for the complete TVT folder.
  pause
  exit /b 1
)
set "TVT_NODE=%TVT_ROOT%_internal\runtime\node.exe"
if exist "%TVT_NODE%" goto run_tvt
where node.exe >nul 2>nul
if errorlevel 1 (
  echo The portable runtime is missing. Ask for the complete TVT folder; no system installation is needed.
  pause
  exit /b 1
)
node.exe "%TVT_ROOT%_internal\setup.mjs" --prepare-runtime
if errorlevel 1 (
  echo Runtime setup did not complete. Check the message above and try again.
  pause
  exit /b 1
)
:run_tvt
if /i "%~1"=="--setup-only" goto setup_only
"%TVT_NODE%" "%TVT_ROOT%_internal\setup.mjs" --data-directory "%TVT_ROOT%."
set "TVT_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %TVT_EXIT%
:setup_only
"%TVT_NODE%" "%TVT_ROOT%_internal\setup.mjs" --setup-only --data-directory "%TVT_ROOT%."
exit /b %ERRORLEVEL%