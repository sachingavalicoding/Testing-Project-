#!/data/data/com.termux/files/usr/bin/bash
# Runs Stock IQ on the phone and restarts it if it stops. Keeps the phone awake while it runs.
cd "$(dirname "$0")/.."
mkdir -p data
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock   # stops Android from freezing Termux when the screen is off

echo "Stock IQ starting. Open http://localhost:$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | grep . || echo 8080) in Chrome."
echo "Stop with Ctrl+C. Log: data/server.log"

while true; do
  node --no-warnings node_modules/.bin/tsx --env-file-if-exists=.env server/src/index.ts 2>&1 | tee -a data/server.log
  echo "Server stopped. Restarting in 5 seconds (Ctrl+C to quit)..."
  sleep 5
done
