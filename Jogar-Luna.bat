@echo off
setlocal
chcp 65001 >nul
title Roleplay Isekai - Luna e Mundo Aberto (Gemini via agy)
rem Motor leve: 1 chamada ao LLM por turno via agy (Gemini padrao),
rem personas ricas da Luna e dos NPCs (ex.: Bram na taverna) e estado/relacao slow-burn.
rem
rem Argumentos opcionais:
rem   Jogar-Luna.bat --debug              (mostra o JSON de estado atualizado)
rem   Jogar-Luna.bat --modelo gemini-4-argon  (muda o modelo do Gemini)
rem   Jogar-Luna.bat --motor lmstudio     (usa o LM Studio local)
rem   Jogar-Luna.bat --motor teste        (teste offline sem gastar tokens)
cd /d "%~dp0"
python "%~dp0play.py" %*
echo.
pause
