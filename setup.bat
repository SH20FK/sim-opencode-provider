@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Sim - OpenCode provider - setup
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
echo                           setup wizard  ^|  first run
echo.
node src\cli.mjs setup
echo.
pause
