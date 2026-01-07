@echo off
echo Creating SSL certificates for HTTPS...

mkdir certs 2>nul

echo.
echo Generating self-signed certificate...
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Warehouse/CN=localhost"

echo.
echo Done! Certificates created in /certs folder
echo.
echo Now run: npm run dev
echo.
echo You'll access the site at: https://YOUR_IP:3000
echo (Your browser will warn about self-signed cert - click "Advanced" and "Proceed")
echo.
pause
