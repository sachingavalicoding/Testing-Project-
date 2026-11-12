#!/data/data/com.termux/files/usr/bin/bash
# One-time setup of Stock IQ on an Android phone with Termux.
#   1. Install Termux from F-Droid (the Play Store version is outdated).
#   2. In Termux:   pkg install -y git   then   git clone <your repo url> stock-iq   then   cd stock-iq   then   bash termux/setup.sh
set -e
cd "$(dirname "$0")/.."

echo "==> Installing Node.js (needs 22.13 or newer)"
pkg update -y
pkg install -y nodejs git

node_ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=13)?"yes":"no")')
if [ "$node_ok" != "yes" ]; then
  echo "Node $(node -v) is too old. Run: pkg upgrade -y   then try again."
  exit 1
fi

echo "==> Installing the server (this takes a few minutes the first time)"
npm install -w server --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env (fake prices, paper money). Edit it with:  nano .env"
fi

if [ ! -f app-build/index.html ] && [ ! -f client/dist/index.html ]; then
  echo "The web app is not in this download (app-build/ is missing)."
  echo "On a computer run  npm run build:mobile  and commit app-build/, then git pull here."
  exit 1
fi

mkdir -p ~/.termux/boot
cp termux/boot-stock-iq.sh ~/.termux/boot/stock-iq.sh
chmod +x termux/start.sh ~/.termux/boot/stock-iq.sh

echo
echo "Done. Start it with:   bash termux/start.sh"
echo "Then open  http://localhost:8080  in Chrome on this phone and use the menu > 'Add to Home screen'."
echo "Optional: install the Termux:Boot app (F-Droid) so it also starts when the phone restarts."
