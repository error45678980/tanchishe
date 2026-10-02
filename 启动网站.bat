@echo off
cd /d "%~dp0"
cd my-app
if not exist ".next" (npm run build)
start "Next.js Server" cmd /k "npm start"
timeout /t 6 /nobreak >nul
start "Cloudflare Tunnel" cmd /k "cloudflared tunnel --url http://localhost:3000"
echo.
echo ======================================
echo  All started! Keep both windows open.
echo  Public URL: check the Cloudflare Tunnel window
echo  Local: http://localhost:3000
echo ======================================
pause
