@echo off
chcp 65001 >nul
title LuckyCondo Launcher
echo ============================================
echo   LuckyCondo Bot - launching...
echo ============================================
echo.

REM ---- 1) เปิดบอท (Express + Ollama) ในหน้าต่างของตัวเอง ----
start "LuckyCondo Bot" cmd /k "cd /d C:\luckycondo-bot && npm start"

REM ---- รอให้บอทจับพอร์ต 3000 ก่อน ----
timeout /t 4 /nobreak >nul

REM ---- 2) เปิด ngrok ล็อกโดเมนถาวร ในหน้าต่างของตัวเอง ----
start "ngrok tunnel" cmd /k "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe http --url=https://relish-blasphemy-atop.ngrok-free.dev 3000"

echo.
echo เปิด 2 หน้าต่างแล้ว (บอท + ngrok) - อย่าปิดทั้งสองหน้าต่างนี้
echo Webhook URL: https://relish-blasphemy-atop.ngrok-free.dev/webhook
echo.
echo หน้าต่างนี้ปิดได้เลย
timeout /t 6 >nul
