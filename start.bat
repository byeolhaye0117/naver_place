@echo off
chcp 65001 >nul
rem 윈도우에서 더블클릭으로 실행하는 파일입니다.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 가 설치되어 있지 않습니다.
  echo   https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=5173

rem 서버가 뜰 시간을 준 뒤 브라우저를 연다
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"

node server.js
pause
