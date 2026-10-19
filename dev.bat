@echo off
setlocal
REM enable WebView2 remote debugging for headless scripts (no mouse hijack)
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cd /d "%~dp0"
if /i "%1"=="build" goto build
if /i "%1"=="check" goto check
npm run app:dev
goto :eof

:build
npm run app:build
goto :eof

:check
cargo build --manifest-path src-tauri\Cargo.toml
goto :eof