@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "PYEXE="
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

echo [Startup Failed] Python not found. Install Python 3.10+ and retry.
pause
exit /b 1

:found
"%PYEXE%" scripts\check_deps.py
if errorlevel 1 (
    echo [Startup Failed] Dependencies not ready.
    pause
    exit /b 1
)

"%PYEXE%" scripts\organize.py %*
echo.
echo Done. Press any key to close.
pause >nul
