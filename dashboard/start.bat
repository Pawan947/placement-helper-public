@echo off
cd /d "%~dp0"
echo Installing dependencies...
call npm install
echo.
echo Starting Placement Helper Dashboard...
call npx electron .
