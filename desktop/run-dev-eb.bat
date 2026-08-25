@echo off
rem Dev runner: locate the repo from this script's own path so it works
rem from any checkout location (no machine-specific paths).
set SCRIPT_DIR=%~dp0
set REPO_DIR=%SCRIPT_DIR%..
cd /d "%REPO_DIR%\desktop"
set FREEAPI_REPO=%REPO_DIR%
bunx electrobun dev