@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Cinzas de Alvor 3D - Capital da Marca de Alvor (Three.js + Gemini SSE)

cd /d "%~dp0"

set "CITY_FILE=%~dp0public\assets\city\city.json"

rem 1. Monta a cidade a partir dos kits CC0 (so Python + numpy; nao precisa de Blender)
if not exist "%CITY_FILE%" (
    echo [1/3] Montando a cidade a partir dos kits CC0 ^(tools\build_city.py^)...
    python "%~dp0tools\build_city.py"
    if errorlevel 1 (
        echo [ERRO] Falha ao montar a cidade. Confira se o numpy esta instalado: python -m pip install numpy pillow
        pause
        exit /b 1
    )
) else (
    echo [1/3] Cidade encontrada: public\assets\city\city.json
)

rem 2. Abre o navegador em http://localhost:8000 apos 2 segundos
echo [2/3] Abrindo http://localhost:8000 no navegador...
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8000"

rem 3. Inicia o servidor backend HTTP + SSE (server.py)
echo [3/3] Iniciando servidor de Cinzas de Alvor na porta 8000...
python "%~dp0server.py" %*

echo.
pause
