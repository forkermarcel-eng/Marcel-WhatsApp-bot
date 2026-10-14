@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 oder neuer fehlt. Installieren und erneut starten.
  pause
  exit /b 1
)
echo.
echo Marcel Trading - DEMO mit synthetischen Daten, keine echten Kurse.
echo Im Browser oeffnen: http://127.0.0.1:3090/Trading/
echo Dieses Fenster offen lassen. Beenden mit Strg+C.
echo.
node trading-core/server/standalone.js --demo
pause
