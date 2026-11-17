@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM Karpathy-Wiki one-click publish
REM Build SPA, deploy to live, restart production server
REM Pure ASCII entry on purpose: publish-wiki.ps1 sets UTF-8 console output,
REM and GBK/UTF-8 comment mismatch in .bat can break cmd parsing.
REM Preflight (modeled after AirMirror\scripts\one-click publish.bat):
REM   0) Load GH_TOKEN/GITHUB_TOKEN from repo-root .env (env vars win)
REM   1) git + git --version, PowerShell, gh CLI (optional), python (optional)
REM ============================================================
cd /d "%~dp0.."
set "ENV_FILE=%CD%\.env"

REM --- 0. Load GitHub token from .env (existing environment wins) ---
if not defined GH_TOKEN (
    for /f "tokens=1,* delims==" %%a in ('findstr /i "^GH_TOKEN=" "%ENV_FILE%" 2^>nul') do set "GH_TOKEN=%%b"
)
if not defined GITHUB_TOKEN (
    for /f "tokens=1,* delims==" %%a in ('findstr /i "^GITHUB_TOKEN=" "%ENV_FILE%" 2^>nul') do set "GITHUB_TOKEN=%%b"
)
if defined GH_TOKEN set "GH_TOKEN=!GH_TOKEN:"=!"
if defined GITHUB_TOKEN set "GITHUB_TOKEN=!GITHUB_TOKEN:"=!"
if defined GH_TOKEN (
    echo [OK]   GitHub token available ^(GH_TOKEN from environment or .env^)
) else if defined GITHUB_TOKEN (
    echo [OK]   GitHub token available ^(GITHUB_TOKEN from environment or .env^)
) else (
    echo [WARN] No GH_TOKEN/GITHUB_TOKEN in environment or .env; Release step may fail.
    echo [INFO] publish-release.py also falls back to git credential store for github.com.
)

REM --- 1. Environment checks ---
where git >nul 2>nul
if errorlevel 1 (
    echo [FAIL] git not found in PATH. Install Git for Windows and retry.
    goto :preflight_fail
)
for /f "tokens=*" %%v in ('git --version 2^>nul') do echo [OK]   %%v

where powershell >nul 2>nul
if errorlevel 1 (
    echo [FAIL] powershell not found in PATH. Cannot start publish-wiki.ps1.
    goto :preflight_fail
)
echo [OK]   PowerShell available

where gh >nul 2>nul
if not errorlevel 1 (
    echo [OK]   gh CLI available
) else (
    echo [INFO] gh CLI not found; publishing via GitHub REST with token or git credentials.
)

where python >nul 2>nul
if not errorlevel 1 (
    echo [OK]   python available for publish-release.py
) else (
    echo [WARN] python not found; Release step needs it unless -SkipPublish is used.
)

REM Resolve configured node.exe dir and prepend to PATH
set "NODE_DIR="
for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepend-node-path.ps1"') do set "NODE_DIR=%%i"
if defined NODE_DIR (
    set "PATH=!NODE_DIR!;%PATH%"
    echo Using node from: !NODE_DIR!
) else (
    echo No configured node path, falling back to PATH
)

echo ============================================================
echo   Karpathy-Wiki One-Click Publish
echo ============================================================
echo   Builds the SPA, deploys it, restarts prod server,
echo   and publishes a GitHub Release by default.
echo   Auto-builds the installer ^(build-exe^) when the
echo   version-matched package is missing.
echo   Options: -SkipInstall -SkipBuild -SkipGate
echo            -SkipDeploy -SkipRestart -SkipPublish -DryRun
echo            -ReleaseNotesFile ^<path^>  (formal release notes, T02743)
echo            -NoAutoBuild   (block instead of auto-building)
echo            -RebuildPackage (force rebuild even if package exists)
echo            -StrictNotes   (block on missing release notes)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "chcp 65001 > $null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-wiki.ps1" %*
if errorlevel 1 (
    echo.
    echo [ERROR] Publish failed, see red ERROR logs above
    if not "%KARPATHY_AUTOMATION%"=="1" pause
    exit /b 1
)

echo.
if not "%KARPATHY_AUTOMATION%"=="1" pause
exit /b 0

:preflight_fail
echo.
echo [ERROR] Preflight check failed; publish-wiki.ps1 was not started.
if not "%KARPATHY_AUTOMATION%"=="1" pause
exit /b 1
