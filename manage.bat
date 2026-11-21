@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sim - OpenCode provider
node src\cli.mjs
if errorlevel 1 pause
