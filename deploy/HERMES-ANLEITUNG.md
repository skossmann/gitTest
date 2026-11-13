# Auftrag für Hermes: Deal-Radar auf Proxmox installieren

Du installierst die Web-App „Deal-Radar“ in einem neuen LXC-Container auf Saschas Proxmox-Server. Arbeite die Schritte der Reihe nach ab. Nach jedem Schritt steht, woran du Erfolg erkennst. Trifft das nicht zu, **halte an und melde die genaue Fehlermeldung** – rate nicht und probiere keine Alternativen auf dem Proxmox-Host aus.

## Regeln

- Auf dem Proxmox-Host nur die hier genannten Befehle ausführen.
- Keine bestehenden Container, VMs, Storages oder Netzwerkeinstellungen ändern oder löschen.
- Keine Passwörter oder Schlüssel in Chat-Nachrichten, Logs oder Dateien schreiben.
- Die Skripte in diesem Projekt wurden bisher nur auf Shell-Syntax geprüft, nicht auf einem echten Proxmox ausgeführt. Rechne also mit Fehlern und melde sie, statt sie zu umgehen.

## Was du von Sascha brauchst

Frage nach, falls du es nicht sicher weißt:

1. IP-Adresse oder Hostname des Proxmox-Hosts → im Folgenden `PVE`
2. Ob der Mac per SSH als `root` auf den Host kommt (Schlüssel-Login)

## Schritt 1 – SSH-Zugang prüfen

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 root@PVE 'pveversion && hostname'
```

Erfolg: Ausgabe beginnt mit `pve-manager/…`.
Bei `Permission denied` oder Passwortabfrage: anhalten. Sascha muss zuerst einen SSH-Schlüssel hinterlegen (`ssh-copy-id root@PVE`).

## Schritt 2 – Projekt auf den Mac holen

```bash
mkdir -p ~/deal-radar-install && cd ~/deal-radar-install
git clone --branch claude/admiring-hypatia-z1cnth --depth 1 https://github.com/skossmann/gitTest.git src
cd src && ls deploy/proxmox-lxc.sh deploy/install.sh server.js
```

Erfolg: alle drei Dateien werden aufgelistet.
Schlägt der Clone wegen fehlender Berechtigung fehl (privates Repository): anhalten und Sascha bitten, das Projekt als ZIP bereitzustellen oder den GitHub-Zugang auf dem Mac einzurichten.

Falls Node.js ≥ 22.13 auf dem Mac vorhanden ist, zusätzlich prüfen (optional):

```bash
node --test 2>&1 | grep -E '^# (pass|fail)'
```

Erwartet: `# pass 12` und `# fail 0`.

## Schritt 3 – Storage und Netzwerk auf dem Host ansehen

```bash
ssh root@PVE 'pvesm status; echo ---; ip -br link show type bridge; echo ---; pct list'
```

Bestimme daraus:

- `STORAGE`: ein aktiver Storage, der Container-Platten aufnehmen kann (meist `local-lvm` oder `local-zfs`)
- `TEMPLATE_STORAGE`: ein aktiver Storage für Templates (meist `local`)
- `BRIDGE`: die Netzwerkbrücke (meist `vmbr0`)

Prüfe in der `pct list`-Ausgabe, ob schon ein Container mit dem Namen `deal-radar` existiert. Falls ja: **nicht** neu anlegen, sondern zu „Update“ unten springen.

Bist du bei einem der drei Werte unsicher: anhalten und Sascha fragen.

## Schritt 4 – Projekt auf den Host kopieren

```bash
cd ~/deal-radar-install
tar --exclude=.git --exclude=data -czf deal-radar.tgz -C src .
scp deal-radar.tgz root@PVE:/root/
ssh root@PVE 'rm -rf /root/deal-radar-src && mkdir -p /root/deal-radar-src && tar -xzf /root/deal-radar.tgz -C /root/deal-radar-src && ls /root/deal-radar-src/deploy'
```

Erfolg: `install.sh` und `proxmox-lxc.sh` werden aufgelistet.

## Schritt 5 – Container anlegen und App installieren

Setze die Werte aus Schritt 3 ein:

```bash
ssh root@PVE 'cd /root/deal-radar-src && STORAGE=local-lvm TEMPLATE_STORAGE=local BRIDGE=vmbr0 bash deploy/proxmox-lxc.sh' 2>&1 | tee ~/deal-radar-install/install.log
```

Das dauert einige Minuten (Template-Download, Paketinstallation). Das Skript wählt selbst die nächste freie Container-ID.

Erfolg: Gegen Ende erscheinen `Active: active (running)` und eine Zeile `Deal-Radar läuft: http://<IP>:8787`. Notiere die Container-ID (Zeile `Container <ID> fertig`) und die Adresse.

Bricht das Skript ab: anhalten und die letzten 30 Zeilen aus `install.log` melden. Wurde der Container bereits angelegt, **nicht** selbst löschen – Sascha entscheidet.

## Schritt 6 – Funktion prüfen

Ersetze `ADRESSE` durch die Adresse aus Schritt 5:

```bash
curl -s http://ADRESSE:8787/healthz
sleep 120
curl -s http://ADRESSE:8787/api/state | python3 -c "
import json, sys
s = json.load(sys.stdin)
r = s['runs'][0] if s['runs'] else None
print('Profile:', len(s['profiles']), '| Angebote:', len(s['listings']), '| läuft gerade:', s['running'])
print('Letzter Lauf:', json.dumps(r['sources'], ensure_ascii=False) if r else 'noch keiner')
"
```

Erfolg:

- `healthz` liefert `{"ok":true}`
- 13 Profile
- ein Lauf ist eingetragen, bei `ka` steht `"blocked": false` und `"errors": []`

Steht dort `"blocked": true`, hat Kleinanzeigen den Zugriff eingeschränkt. Das ist kein Installationsfehler: nichts weiter unternehmen, nur melden. Der Radar pausiert dort von selbst 12 Stunden.

## Schritt 7 – Abschlussmeldung an Sascha

Melde kurz:

- Adresse der App (`http://ADRESSE:8787`) und Container-ID
- Ergebnis aus Schritt 6 (Anzahl Profile, Angebote, Status des ersten Laufs)
- Was noch offen ist:
  - In Safari öffnen → Teilen → „Zum Home-Bildschirm“
  - Unter *Einstellungen* einen Benachrichtigungskanal eintragen (ntfy-URL oder Telegram) und „Testnachricht senden“ antippen
  - Optional Passwortschutz: im Container in `/etc/default/deal-radar` die Zeile `DEALRADAR_PASSWORD=…` setzen, dann `systemctl restart deal-radar`

## Schritt 8 – Alten Radar abschalten (nur nach Rückfrage)

Solange dein bisheriger Zwei-Stunden-Suchauftrag weiterläuft, fragen zwei Systeme Kleinanzeigen ab. Das verdoppelt die Abrufe und erhöht das Risiko einer Sperre.

Frage Sascha, ob du deinen bisherigen Deal-Radar-Auftrag pausieren sollst. Schalte ihn erst nach einem ausdrücklichen Ja ab.

## Update (wenn der Container schon existiert)

Schritte 2 und 4 ausführen, dann mit der vorhandenen Container-ID:

```bash
ssh root@PVE 'pct exec ID -- rm -rf /root/deal-radar-src && pct exec ID -- mkdir -p /root/deal-radar-src && tar -C /root/deal-radar-src -cf - . | pct exec ID -- tar -C /root/deal-radar-src -xf - && pct exec ID -- bash /root/deal-radar-src/deploy/install.sh'
```

Die Datenbank in `/opt/deal-radar/data` bleibt dabei erhalten. Danach Schritt 6 wiederholen.

## Fehlersuche (nur lesen, nichts ändern)

```bash
ssh root@PVE 'pct exec ID -- systemctl --no-pager status deal-radar'
ssh root@PVE 'pct exec ID -- journalctl -u deal-radar --no-pager -n 50'
```
