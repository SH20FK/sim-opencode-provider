@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sim -> OpenCode provider
set SIM_CLI_SPLASH=1
cls
echo.
echo    ===========================================================================
echo    ####  ###  #   #      ###   ####   #####  #   #   ####   ###   ####   #####
echo    #      #   ## ##     #   #  #   #  #      ##  #  #      #   #  #   #  #
echo    ###    #   # # #     #   #  ####   ###    # # #  #      #   #  #   #  ###
echo       #   #   #   #     #   #  #      #      #  ##  #      #   #  #   #  #
echo    ####  ###  #   #      ###   #      #####  #   #   ####   ###   ####   #####
echo    ===========================================================================
echo              free hosted models  ^|  tool-calling emulation  ^|  local proxy
echo.
node src\cli.mjs
if errorlevel 1 pause
