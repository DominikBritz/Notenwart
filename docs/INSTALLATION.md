# Installation

Die App ist nicht signiert (kein Apple-Developer-Account, kein Windows-Zertifikat). Deshalb warnen macOS und Windows beim ersten Start. Das ist einmalig.

## macOS (Apple Silicon)

1. `Notenwart-<Version>-arm64.dmg` öffnen und die App in den Ordner *Programme* ziehen.
2. Beim ersten Start meldet macOS, dass Apple nicht überprüfen konnte, ob die App frei von Schadsoftware ist. Das liegt nur an der fehlenden Apple-Signatur. Dialog mit **Fertig** schließen.
3. *Systemeinstellungen > Datenschutz & Sicherheit* öffnen, nach unten scrollen und bei „Notenwart wurde blockiert“ auf **Trotzdem öffnen** klicken, dann bestätigen.
4. Danach startet die App normal per Doppelklick.

Alternative per Terminal (auch für Versionen bis 0.3.0, bei denen macOS „Notenwart ist beschädigt“ meldet und kein „Trotzdem öffnen“ anbietet):

```bash
xattr -cr "/Applications/Notenwart.app"
```

## Windows (64 Bit)

Zwei Varianten liegen bei:

- `Notenwart-Setup-<Version>.exe`: Installer, legt Startmenü-Eintrag an.
- `Notenwart-Portable-<Version>.exe`: portable Version, läuft direkt ohne Installation (z.B. vom USB-Stick).

Beim ersten Start zeigt Windows SmartScreen „Der Computer wurde durch Windows geschützt“. Auf **Weitere Informationen** klicken, dann **Trotzdem ausführen**.

## Voraussetzungen

Keine. Texterkennung, PDF-Verarbeitung und Sprachdaten sind in der App enthalten. Internet wird nur gebraucht, wenn in den Einstellungen die optionale KI-Erkennung eingeschaltet ist.

## Speicherorte

- Einstellungen und Erkennungs-Cache: macOS `~/Library/Application Support/Notenwart/`, Windows `%APPDATA%\Notenwart\`.
- Der Cache kann jederzeit in den Einstellungen geleert werden; er wird beim nächsten Lauf neu aufgebaut.
