@echo off
REM One-click: publish the grouping-tool exports from Downloads to the field catalog.
chcp 65001 >nul
cd /d "%~dp0"
py tools\publish-from-downloads.py %*
echo.
pause
