# Deal-Radar

Schnäppchen-Tracker als Web-App (für den iPhone-Home-Bildschirm gedacht): beobachtet Kleinanzeigen-Suchen und Deal-Feeds, bewertet jedes Angebot mit einem Score, sortiert das Beste nach oben, prüft, ob Angebote noch existieren, und schickt bei Top-Deals eine Nachricht.

Benötigt Node.js ≥ 22.13 (eingebautes SQLite). Einzige npm-Abhängigkeit ist das Anthropic-SDK für den optionalen KI-Assistenten; ohne `npm install` läuft alles außer den KI-Vorschlägen.

## Start

```bash
npm install --omit=dev    # nur für den KI-Assistenten nötig
node server.js            # http://localhost:8787
npm test
```

Umgebungsvariablen: `PORT` (8787), `DEALRADAR_DB` (Pfad zur Datenbank, Standard `data/dealradar.db`), `DEALRADAR_PASSWORD` (optionaler Passwortschutz per Basic-Auth, Benutzername beliebig).

## Installation auf Proxmox

Projekt auf den Proxmox-Host kopieren (z. B. `git clone` oder ZIP), dann als root:

```bash
bash deploy/proxmox-lxc.sh
```

Das legt einen Debian-12-Container (512 MB RAM, 4 GB Platte, DHCP) an und richtet darin den Dienst `deal-radar` ein. Die Adresse wird am Ende ausgegeben. Optionen: `CTID=… STORAGE=… TEMPLATE_STORAGE=… BRIDGE=…`.

In einem bestehenden Debian/Ubuntu-Container oder einer VM: `bash deploy/install.sh` (auch für Updates – die Datenbank in `/opt/deal-radar/data` bleibt erhalten). Alternativ: `docker compose up -d`.

Auf dem iPhone: Adresse in Safari öffnen → Teilen → „Zum Home-Bildschirm“.

## Suchen anlegen

Unter *Suchen → + Neue Suche* gibt es drei Wege:

- **Einfach**: Suchbegriff, optional Wunschpreis und Ausschlusswörter. Ohne Wunschpreis lernt der Radar den Marktpreis.
- **Erweitert**: das vollständige Formular (mehrere Suchen, Preisstufen, Pluspunkte, Warnungen). Bestehende Suchen öffnen sich immer hier.
- **Mit KI ausfüllen**: Aus einer freien Beschreibung erstellt Claude einen Vorschlag, der das erweiterte Formular füllt. Gespeichert wird erst nach Prüfung. Im erweiterten Formular kann die KI einen Stand auch überarbeiten.

Für die KI unter *Einstellungen → KI-Assistent* einen Claude-API-Schlüssel eintragen (oder `ANTHROPIC_API_KEY` setzen). Modell: `claude-opus-5-5`, änderbar über `DEALRADAR_AI_MODEL`. Jeder Vorschlag verbraucht API-Guthaben; die Suchläufe selbst nutzen keine KI. Lehnt das Modell eine Anfrage ab, übernimmt ein serverseitiges Ausweichmodell.

## KI-Bewertung eines Angebots

In der Detailansicht jedes Angebots gibt es (mit hinterlegtem API-Schlüssel) den Knopf **KI fragen**. Der Radar lädt dafür einmal die vollständige Anzeige nach (Beschreibung, Detailangaben, Alter des Verkäuferkontos – kein Name) und lässt Claude das Angebot fachlich einordnen: Produkt und Technik, Passung zur Suche, Preis, Stärken, Risiken, Fragen an den Verkäufer, Verhandlungsspielraum und was sich nicht beurteilen lässt. Das Ergebnis bleibt am Angebot gespeichert. Ist die Anzeige inzwischen gelöscht, wird sie als „weg" markiert und nichts an die KI geschickt.

## Benachrichtigungen

Unter *Einstellungen* eintragen und mit „Testnachricht senden“ prüfen:

- **ntfy**: ntfy-App installieren, ein schwer zu erratendes Topic abonnieren, `https://ntfy.sh/<topic>` eintragen.
- **Telegram**: Bot-Token + Chat-ID.
- **Webhook**: beliebige URL, bekommt `{title, body, url, priority}` als JSON.

Gemeldet werden nur Top-Deals (Score ≥ 85), höchstens 7 pro Lauf, jedes Angebot nur einmal – erneut nur bei Preisverfall ab 10 %. Doppelanzeigen (gleicher Titel) werden nicht erneut gemeldet.

## Wie bewertet wird

1. **Filter**: Gesuche/Tausch/Miete, Zubehör, Angebote ohne Preis oder unter Mindestpreis fallen raus.
2. **Preisstufe**: Die erste passende Stufe eines Suchprofils gilt (Stichwörter und/oder Merkmal wie RAM, Einschübe, Kapazität). Passt keine Stufe, wird die Anzeige nicht aufgenommen.
3. **Schwellen**: Feste Zielpreise sind Obergrenzen. Sobald mindestens 8 Vergleichsanzeigen einer Stufe vorliegen, gilt zusätzlich der beobachtete Median (Deal ab −10 %, Top-Deal ab −20 %). Stufen ohne Zielpreis arbeiten nur mit dem Median (Standard: Deal ab 75 %, Top ab 60 % des Medians) und sind bis dahin in der „Lernphase“.
4. **Score 0–100**: ab 60 Deal, ab 85 Top-Deal. Pluspunkte und Warnungen (z. B. Defekt, Atom-C2000-NAS) verschieben den Score. Preise weit unter der Top-Grenze werden als „verdächtig billig“ markiert.

Deal-Feeds (mydealz) werden nach Temperatur bewertet.

## Umgang mit Kleinanzeigen

- Festes Abruf-Budget pro Lauf (Standard 18 inkl. Verfügbarkeitsprüfungen), Suchen laufen reihum, zufällige Pausen zwischen den Abrufen.
- Bei HTTP 403/429 oder Captcha pausiert der Radar dort (Standard 12 h) und zeigt das deutlich an. Es wird nichts umgangen.
- Verfügbarkeit: Deals und gemerkte Angebote, die nicht mehr in der Suche auftauchen, werden einzeln geprüft (gelöschte Anzeigen leiten auf eine Kategorieseite um). Nicht-Deals gelten nach 10 Tagen ohne Sichtung als weg (ungeprüft).
- Automatisierte Abrufe können gegen die Nutzungsbedingungen von Kleinanzeigen verstoßen; Nutzung auf eigenes Risiko und mit kleinem Budget.

## Aufbau

- `server.js` – HTTP-API + statische Dateien + Scheduler
- `src/runner.js` – Suchlauf; `src/score.js` – Filter & Bewertung; `src/extract.js` – Text-/Merkmal-Erkennung
- `src/sources/` – Kleinanzeigen-Parser, RSS-Parser; `src/notify.js` – Benachrichtigungen
- `src/ai.js` – KI-Vorschläge für Suchprofile (Claude API)
- `src/defaults.js` – Start-Suchprofile (danach in der App änderbar)
- `public/` – Oberfläche (PWA, ohne Build-Schritt)
