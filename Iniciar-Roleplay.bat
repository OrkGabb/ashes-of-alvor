@echo off
setlocal
chcp 65001 >nul
title Roleplay local - LM Studio
rem As configuracoes aparecem num menu ao abrir e ficam salvas em config.ini.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0roleplay.ps1"
echo.
pause
