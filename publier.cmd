@echo off
rem Publie une nouvelle version d'AutoClip sur GitHub (voir README, "Publier une mise a jour").
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publier.ps1" %*
echo.
pause
