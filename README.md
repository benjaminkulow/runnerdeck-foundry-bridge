# RunnerDeck Bridge

Foundry-VTT-Modul, das Foundry mit **RunnerDeck** verbindet, einem Windows-Programm für Shadowrun 6 mit Pixels-Würfeln.

- Würfe aus RunnerDeck erscheinen als Chatkarte in Foundry (Erfolge, Würfel, Patzer, Schwellenwert, eingesetztes Edge). Wird nachträglich Edge eingesetzt, aktualisiert sich dieselbe Karte.
- Schaden (Körperlich, Geistig, Überzählig), Edge, Initiative und Overwatch werden **in beide Richtungen** abgeglichen.
- Kampfrunden und „du bist dran“ aus dem Kampftracker werden in RunnerDeck angezeigt.
- „An Foundry senden“ in RunnerDeck vergleicht Attribute, Fertigkeiten, Metatyp und Klasse mit dem Akteur, zeigt die Unterschiede und überträgt nur, was du anhakst. Fehlende Gegenstände können angelegt werden; gelöscht wird nichts.

Getestet für Foundry 14 mit dem System **Shadowrun 6 (shadowrun6-eden)** 4.0.x, auch auf The Forge.

## Wie die Verbindung funktioniert

Das Modul läuft in **deinem** Browser (Firefox, Chrome oder Edge) und baut von dort eine Verbindung zu RunnerDeck auf demselben PC auf: `ws://127.0.0.1:8765/foundry`. Die Verbindung geht nur nach außen zu deinem eigenen PC. Es braucht keine Portfreigabe, keinen Server und keinen Router-Umbau, auch wenn Foundry bei The Forge oder woanders gehostet ist.

Sicherheit:

- Einmalige Kopplung mit einem 6-stelligen Code, der in RunnerDeck angezeigt wird und 10 Minuten gilt. Danach nutzt das Modul ein zufälliges Token.
- RunnerDeck merkt sich die Foundry-Adresse der Kopplung und lehnt andere Webseiten ab.
- RunnerDeck lauscht nur auf `127.0.0.1`, also nur auf dem eigenen PC.
- Übertragen werden nur Spielzustände und die Zahlenwerte deines Charakters, keine Regeltexte.

## Installation

1. In Foundry: **Setup → Add-on-Module → Modul installieren**, unten diese Manifest-URL eintragen:

   ```
   https://github.com/benjaminkulow/runnerdeck-foundry-bridge/releases/latest/download/module.json
   ```

   Auf **The Forge**: Bazaar → „Install via Manifest“ mit derselben URL.
2. Das Modul in der Welt aktivieren (Spielleitung: Module verwalten).
3. In RunnerDeck: **Einstellungen → Foundry VTT** → „Foundry-Brücke einschalten“ → „Kopplungscode erzeugen“.
4. In Foundry: **Spieleinstellungen → Moduleinstellungen → RunnerDeck Bridge → Verbindung** (oder `/rd` in den Chat tippen), den Code eintragen und **Verbinden** drücken.
5. In RunnerDeck links in der Übersicht des Charakters den Foundry-Akteur auswählen. Heißt der Akteur genauso wie der Charakter, wird er automatisch verknüpft.

Jede Person, die RunnerDeck nutzt, koppelt ihren eigenen Browser. Die Spielleitung braucht RunnerDeck nicht.

## Wenn es nicht klappt

„Verbindung testen“ im Modul sagt, woran es liegt:

| Meldung | Lösung |
|---|---|
| RunnerDeck ist nicht erreichbar | RunnerDeck starten. Foundry muss im Browser auf demselben PC laufen. Port prüfen (Standard 8765). |
| Brücke ist aus | In RunnerDeck unter Einstellungen → Foundry VTT einschalten. |
| Mit einer anderen Foundry-Adresse gekoppelt | In RunnerDeck „Kopplung aufheben“ und neu koppeln. |
| Kopplungscode falsch oder abgelaufen | In RunnerDeck einen neuen Code erzeugen. |

Hinweise:

- **Firefox** erlaubt Verbindungen von einer https-Seite zu `127.0.0.1` ohne weitere Einstellung.
- **Chrome/Edge** fragen eventuell einmal nach dem Zugriff auf Geräte im lokalen Netzwerk. Das bitte erlauben.
- Werbe- oder Script-Blocker können Verbindungen zu `127.0.0.1` sperren. Dann eine Ausnahme für die Foundry-Seite eintragen.

## Für Entwickler

Nachrichten sind JSON über WebSocket. Nach `hello` (mit `code` oder `token`) antwortet RunnerDeck mit `welcome`.

- RunnerDeck → Modul: `roll`, `state`, `getActors`, `getActor`, `pushActor`.
- Modul → RunnerDeck: `actors`, `actorState`, `ini`, `combat`, `actorData`, `pushResult`.

Ein Release entsteht durch einen Tag `vX.Y.Z`. Der Workflow setzt Version und Download-Link in `module.json` und lädt `module.json` und `module.zip` hoch.

Lizenz: MIT. Shadowrun ist eine Marke von The Topps Company, Inc. Dieses Modul ist ein inoffizielles Fanprojekt und enthält keine Inhalte aus den Regelwerken.
