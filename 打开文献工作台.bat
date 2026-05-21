@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM Find Python: try PATH first, then common install locations.
REM Uses :found goto-jump pattern instead of chained ifs --
REM chained "if not defined X if exist Y set Z" silently fails
REM on some cmd builds when there are many such lines back-to-back.
REM Pure ASCII to avoid GBK/UTF-8 decode glitches in cmd.
REM ============================================================
set "PYEXE="

REM Try python / py on PATH (skip the Microsoft Store stub)
for /f "delims=" %%X in ('where python 2^>nul') do (
    if not defined PYEXE set "PYEXE=%%X"
)
if defined PYEXE (
    if /i "%PYEXE:WindowsApps=%" neq "%PYEXE%" set "PYEXE="
)
if defined PYEXE goto :found

for /f "delims=" %%X in ('where py 2^>nul') do (
    if not defined PYEXE set "PYEXE=%%X"
)
if defined PYEXE goto :found

REM Common install paths
set "TRY=D:\Anaconda\python.exe"
if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
set "TRY=C:\Anaconda3\python.exe"
if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
set "TRY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
set "TRY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
set "TRY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
set "TRY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
set "TRY=%USERPROFILE%\anaconda3\python.exe"
if exist "%TRY%" set "PYEXE=%TRY%" & goto :found
set "TRY=%USERPROFILE%\miniconda3\python.exe"
if exist "%TRY%" set "PYEXE=%TRY%" & goto :found

echo.
echo [Startup Failed] Python not found. Install Python 3.10+ and retry:
echo   Official: https://www.python.org/downloads/  (check "Add to PATH")
echo   Anaconda: https://www.anaconda.com/download
echo.
pause
exit /b 1

:found
echo [Python] %PYEXE%

REM First-run / post git-pull: auto-install missing deps (~70ms when warm)
"%PYEXE%" scripts\check_deps.py
if errorlevel 1 (
    echo.
    echo [Startup Failed] Dependencies not ready. See above for details.
    pause
    exit /b 1
)

"%PYEXE%" scripts\server.py
pause
