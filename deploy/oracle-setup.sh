#!/usr/bin/env bash
# One-command setup of Stock IQ on a free Oracle Cloud server (Ubuntu 22.04 or 24.04, ARM or AMD).
# Run it again any time to update the app to the latest code.
#
#   curl -fsSL https://raw.githubusercontent.com/sachingavalicoding/Testing-Project-/main/deploy/oracle-setup.sh -o setup.sh
#   sudo bash setup.sh your-name.duckdns.org
#
# The first argument is your web address (a free DuckDNS name that points at this server's public IP).
# See deploy/FREE-HOSTING.md for the full steps.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/sachingavalicoding/Testing-Project-.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/stock-iq
APP_USER=stockiq

if [ "$(id -u)" != "0" ]; then echo "Run with sudo:  sudo bash $0 your-name.duckdns.org"; exit 1; fi
if [ -z "$DOMAIN" ]; then echo "Give your web address:  sudo bash $0 your-name.duckdns.org"; exit 1; fi

echo "==> Small swap file (helps the 1 GB servers during npm install)"
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 3000000 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing Node.js 22, git and Caddy (HTTPS)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https iptables-persistent
node_ok=no
if command -v node >/dev/null; then
  node_ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=13)?"yes":"no")')
fi
if [ "$node_ok" != "yes" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Opening ports 80 and 443 in the server firewall (Oracle blocks them by default)"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport $p -j ACCEPT
done
netfilter-persistent save >/dev/null

echo "==> Getting the app code"
id -u $APP_USER >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin $APP_USER
git config --global --get-all safe.directory | grep -qx $APP_DIR || git config --global --add safe.directory $APP_DIR
if [ -d $APP_DIR/.git ]; then
  git -C $APP_DIR fetch origin $BRANCH && git -C $APP_DIR checkout -q $BRANCH && git -C $APP_DIR reset -q --hard origin/$BRANCH
else
  git clone --branch $BRANCH $REPO $APP_DIR
fi
cd $APP_DIR
npm install -w server --omit=dev --no-audit --no-fund
mkdir -p data

if [ ! -f .env ]; then
  echo "==> Making .env (first time only)"
  cp .env.example .env
  PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
  sed -i "s|^APP_PASSWORD=.*|APP_PASSWORD=$PASS|" .env
  sed -i "s|^DB_PATH=.*|DB_PATH=$APP_DIR/data/stock-iq.db|" .env
  sed -i "s|^UPSTOX_REDIRECT_URI=.*|UPSTOX_REDIRECT_URI=https://$DOMAIN/api/auth/upstox/callback|" .env
  echo
  echo "   App password: $PASS   (write it down; change it with: sudo nano $APP_DIR/.env)"
  echo
fi
chown -R $APP_USER:$APP_USER $APP_DIR
chmod 600 .env

echo "==> Starting the app (restarts by itself if it stops or the server reboots)"
cp deploy/stock-iq.service /etc/systemd/system/stock-iq.service
systemctl daemon-reload
systemctl enable stock-iq >/dev/null
systemctl restart stock-iq

echo "==> HTTPS for $DOMAIN"
sed "s|stock.example.com|$DOMAIN|" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo
echo "Done. Open  https://$DOMAIN  (the first visit can take a minute while the certificate is made)."
echo "Upstox Redirect URL to save in the Upstox developer app:  https://$DOMAIN/api/auth/upstox/callback"
echo "Settings:  sudo nano $APP_DIR/.env   then   sudo systemctl restart stock-iq"
echo "Logs:      sudo journalctl -u stock-iq -f"
