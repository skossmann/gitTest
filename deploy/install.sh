#!/usr/bin/env bash
# Installiert Deal-Radar als systemd-Dienst in einem Debian/Ubuntu-System (LXC oder VM).
# Aufruf als root aus dem ausgecheckten Projekt:  bash deploy/install.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/deal-radar
PORT="${PORT:-8787}"

apt-get update
apt-get install -y curl ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

id dealradar >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin dealradar
mkdir -p "$APP"
if [ "$SRC" != "$APP" ]; then
  # data/ (Datenbank) bleibt bei Updates erhalten
  tar -C "$SRC" --exclude=./data --exclude=./.git -cf - . | tar -C "$APP" -xf -
fi
mkdir -p "$APP/data"
chown -R dealradar:dealradar "$APP"
[ -f /etc/default/deal-radar ] || printf 'PORT=%s\n# DEALRADAR_PASSWORD=geheim   # optional: Passwortschutz (Benutzername beliebig)\n' "$PORT" > /etc/default/deal-radar

cat > /etc/systemd/system/deal-radar.service <<UNIT
[Unit]
Description=Deal-Radar
After=network-online.target
Wants=network-online.target

[Service]
User=dealradar
WorkingDirectory=$APP
EnvironmentFile=/etc/default/deal-radar
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now deal-radar
sleep 2
systemctl --no-pager --lines=5 status deal-radar || true
echo
echo "Deal-Radar läuft: http://$(hostname -I | awk '{print $1}'):$(. /etc/default/deal-radar; echo "$PORT")"
