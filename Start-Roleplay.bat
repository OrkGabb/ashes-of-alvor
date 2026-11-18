@echo off
setlocal
chcp 65001 >nul
title Local roleplay - LM Studio
rem The settings appear in a menu on start-up and are saved to config.ini.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0roleplay.ps1"
echo.
pause
