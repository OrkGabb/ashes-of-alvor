@echo off
setlocal
chcp 65001 >nul
title Isekai Roleplay - Luna and the Open World (Gemini via agy)
rem Lightweight engine: 1 LLM call per turn through agy (Gemini by default),
rem rich personas for Luna and the NPCs (e.g. Bram at the tavern) and slow-burn state/relationship.
rem
rem Optional arguments:
rem   Play-Luna.bat --debug                  (shows the updated state JSON)
rem   Play-Luna.bat --modelo gemini-4-argon  (changes the Gemini model)
rem   Play-Luna.bat --motor lmstudio         (uses local LM Studio)
rem   Play-Luna.bat --motor teste            (offline test, spends no tokens)
cd /d "%~dp0"
python "%~dp0play.py" %*
echo.
pause
