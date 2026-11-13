#!/usr/bin/env bash
# Auf dem Proxmox-HOST (als root) aus dem ausgecheckten Projekt ausführen:
#   bash deploy/proxmox-lxc.sh
# Legt einen kleinen Debian-12-Container an und installiert Deal-Radar darin.
# Anpassbar: CTID=123 STORAGE=local-lvm TEMPLATE_STORAGE=local BRIDGE=vmbr0 bash deploy/proxmox-lxc.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"

pveam update
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | tail -1)"
[ -n "$TEMPLATE" ] || { echo "Kein Debian-12-Template gefunden"; exit 1; }
pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE" || pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"

pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname deal-radar --memory 512 --swap 256 --cores 1 \
  --rootfs "$STORAGE:4" --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 --onboot 1 --start 1
echo "Warte auf Netzwerk im Container …"
for i in $(seq 1 30); do pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null' && break; sleep 2; done

pct exec "$CTID" -- mkdir -p /root/deal-radar-src
tar -C "$SRC" --exclude=./data --exclude=./.git -cf - . | pct exec "$CTID" -- tar -C /root/deal-radar-src -xf -
pct exec "$CTID" -- bash /root/deal-radar-src/deploy/install.sh
echo "Container $CTID fertig. Adresse siehe oben."
