# AllergenCheck

Allergenkennzeichnung für die Gastronomie: Rezept eingeben, die 14 EU-Allergene (LMIV Anhang II) herausbekommen. Die App ist eine PWA und liegt auf **https://allergencheck.vaydena.de**.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `index.html` | Landingpage (SEO) |
| `app.html`, `assets/ac-app.js`, `assets/ac.css` | App: Gerichte/Komponenten, Etikett-Scan (OCR), Gäste-Filter, PDFs, Einstellungen, Lizenz |
| `assets/ac-engine.js` | Erkennungs-Engine (Browser + Node) |
| `assets/data/zutaten.json` | Zutaten-Datenbank: `[Name, sichere Codes, zu prüfende Codes, "synonym1\|synonym2", Hinweis?]` |
| `kaufen.html`, `zahlung.html` | Bestellung (nur B2B) und Rechnung mit GiroCode |
| `betreiber.html` | Betreiber-Bereich: Zahlungen bestätigen, Verlängerungen, Sperren, CSV |
| `supabase/` | Migration (Schema `allergencheck`) und Edge Functions `ac-order`, `ac-invoice`, `ac-check-token`, `ac-admin` |
| `tools/make-icons.js` | Erzeugt die PWA-Icons |

## Datenhaltung und Lizenz

- Alle Rezepturen bleiben lokal im Browser (`localStorage`). Sicherung und Wiederherstellung laufen über eine JSON-Datei.
- Beim ersten Start beginnt eine 14-tägige Testphase. Danach braucht die App einen Lizenzcode `AC-XXXXX-XXXXX-XXXXX`.
- Die App prüft den Code höchstens einmal täglich über `ac-check-token`.
- Nach Ablauf gibt es 3 Tage Kulanz; danach läuft die App nur noch lesend.
- Abo: 12 €/Monat oder 119 €/Jahr, per Rechnung. Es gibt keine automatische Abbuchung; das Abo verlängert sich nur, wenn der Kunde die nächste Rechnung bezahlt.

## Betrieb

- **Zahlungseingang:** In `betreiber.html` bei der Rechnung auf „Bezahlt ✓“ klicken.
  - Bei der ersten Zahlung erzeugt das System den Lizenzcode und schickt ihn per Mail.
  - Bei jeder weiteren Zahlung verlängert sich `valid_until`.
- **Verlängerungen:** In `betreiber.html` „Verlängerungsrechnungen erzeugen“ klicken, am besten wöchentlich. Das erzeugt Rechnungen für alle Abos, die in den nächsten 14 Tagen ablaufen.
- **Betreiber-Schlüssel:** Standardmäßig gilt der MediScan-Schlüssel (`mediscan.admin_auth`). Ein eigener Schlüssel lässt sich anlegen mit:
  `insert into allergencheck.admin_auth (id, secret_sha256) values (1, encode(digest('<schlüssel>','sha256'),'hex'));`

## Entwicklung

```
node test/engine-smoke.js        # Engine-Test
node tools/make-icons.js         # Icons neu erzeugen
python3 -m http.server 8765      # lokal testen: http://localhost:8765/app.html
```

Wenn sich die App ändert, `VERSION` in `sw.js` und `deploy-version.txt` erhöhen.

## Deploy

Ein Push auf `main` startet den GitHub-Actions-Workflow. Er lädt die Dateien per FTPS nach `/allergencheck/` auf Hostinger. Dafür muss im Repo das Secret `FTP_PASSWORD` gesetzt sein.
