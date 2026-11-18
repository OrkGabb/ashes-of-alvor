@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Ashes of Alvor 3D - Capital of the March of Alvor (Three.js + Gemini SSE)

cd /d "%~dp0"

set "CITY_FILE=%~dp0public\assets\city\city.json"

rem 1. Build the city from the CC0 kits (Python + numpy only; Blender is not needed)
if not exist "%CITY_FILE%" (
    echo [1/3] Building the city from the CC0 kits ^(tools\build_city.py^)...
    python "%~dp0tools\build_city.py"
    if errorlevel 1 (
        echo [ERROR] Could not build the city. Check that numpy is installed: python -m pip install numpy pillow
        pause
        exit /b 1
    )
) else (
    echo [1/3] City found: public\assets\city\city.json
)

rem 2. Open the browser at http://localhost:8000 after 2 seconds
echo [2/3] Opening http://localhost:8000 in the browser...
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8000"

rem 3. Start the HTTP + SSE backend (server.py)
echo [3/3] Starting the Ashes of Alvor server on port 8000...
python "%~dp0server.py" %*

echo.
pause
