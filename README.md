# Projection Studio

Projection Studio bringt Projektoren und ein 3D-Modell des Raums zur Deckung. Man klickt ein paar markante Ecken im Modell an, sucht dieselben Stellen mit dem Projektor im Raum, und die App rechnet daraus aus, wo der Projektor steht und wohin er zeigt. Danach kümmert sie sich um die Überblendung zwischen den Projektoren, kleine Restfehler und die Ausgabe, entweder direkt aus der App oder über TouchDesigner.

![Kalibrieren](docs/screenshots/02-kalibriert.png)

## Wie es dazu kam

Angefangen hat alles mit einer Gewölbedecke: acht Epson-Kurzdistanzprojektoren, die über Spiegel am Boden nach oben strahlen, vier im Innenring um eine Mittelsäule, vier außen herum. Dazu zwei 4K-Ausgänge, die je vier Projektoren versorgen. Bisher lief das in TouchDesigner mit camSchnappr und Stoner. Das hat funktioniert, war aber mühsam. Mit wenigen oder eng beieinander liegenden Punkten ist die Lösung oft gekippt, und man hat nicht gesehen, wo der Projektor gerade steht.

Daraus ist diese App entstanden. Nichts darin ist auf das Gewölbe festgelegt. Jedes OBJ-Modell funktioniert, ob Fassade, Bühnenbild, Kuppel oder Objekt. Es gibt Platz für bis zu acht Projektoren auf zwei Ausgängen, nicht gebrauchte schaltet man unter *Einrichten* ab. Auflösung, Objektiv und Aufteilung auf die Ausgänge lassen sich frei einstellen. Das Gewölbe liegt als Demo bei, und die Einführung beim ersten Start fragt, ob du damit oder mit einem eigenen Modell anfangen willst.

## Ablauf

Die App ist in vier Schritte gegliedert, die oben in der Werkzeugleiste stehen.

**Einrichten.** Modell laden, Projektoren anlegen und jedem einen Ausgang und ein Bildviertel zuweisen. Hier stehen auch Auflösung, Objektiv und Spiegel.

**Kalibrieren.** Projektor links auswählen, eine gut erkennbare Stelle im Modell anklicken (Kante, Ecke, Bogenscheitel) und dieselbe Stelle im Raum treffen. Das geht direkt am Projektorbild mit der Maus oder in der Vorschau rechts, mit den Pfeiltasten pixelgenau. Ab vier Punkten gibt es eine erste Lösung, mit sechs gut verteilten ist sie stabil. Die App zeigt, wie gut die Punkte zusammenpassen, und schlägt vor, wo ein weiterer Punkt am meisten bringt.

Bleiben kleine Abweichungen, etwa weil der Raum nicht ganz dem Modell entspricht, hilft der Reiter *Feinkorrektur*. Dort liegt pro Projektor ein Gitter mit 3 × 3 bis 9 × 9 Punkten, an dem man das Bild zurechtzieht. Das ersetzt Stoner.

**Überblenden.** Ein Klick berechnet weiche Übergänge überall, wo sich Projektoren überlappen, und gleicht die Helligkeit aus. Steile Flächen wie Wände oder Bogenseiten bleiben auf Wunsch dunkel. Eigene Masken mit weicher Kante lassen sich pro Projektor dazuzeichnen.

**Ausgabe.** Die Projektorbilder gehen im Vollbild auf die Ausgänge. Zum Prüfen gibt es Kanten, Raster, Weiß und Projektornummern. Die App kann auch selbst ein Video auf das Modell spielen, über alle Projektoren mit Überblendung und Feinkorrektur. Beide Ausgänge laufen dabei synchron, und die Bildrate wird angezeigt. Für alles Weitere geht die Kalibrierung an TouchDesigner (siehe unten).

<p>
  <img src="docs/screenshots/04-blending.png" width="49%" alt="Überblenden">
  <img src="docs/screenshots/09-feinkorrektur.png" width="49%" alt="Feinkorrektur">
</p>

Das Projekt wird laufend gesichert. Rückgängig geht mit Strg/Cmd+Z. Die Einführung lässt sich unter *Hilfe → Einführung anzeigen* jederzeit wieder öffnen.

## Herunterladen

Die aktuelle Version wird bei jeder Änderung automatisch gebaut:

- [macOS (.dmg)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-mac.dmg)
- [Windows, Installer (.exe)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-Setup.exe)
- [Windows, ohne Installation (.exe)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-Portable.exe)

Ältere Stände liegen unter [Releases](https://github.com/BenjaminJMueller/projection-studio/releases). Die Versionsnummer steht im Menü *Hilfe*.

Die Mac-App ist nicht bei Apple signiert. Beim ersten Start deshalb im Finder per Rechtsklick auf *Öffnen* gehen oder im Terminal einmal das hier ausführen:

```sh
xattr -dr com.apple.quarantine "/Applications/Projection Studio.app"
```

Unter Windows meldet sich eventuell SmartScreen. Dann auf *Weitere Informationen* und *Trotzdem ausführen* klicken.

Ein Auto-Update ist eingebaut, aber ausgeschaltet, weil die App die Releases eines privaten Repos nicht ohne Anmeldung lesen kann. Wer es nutzen will, trägt in `package.json` unter `updateFeed` die Adresse einer öffentlich erreichbaren `latest.json` ein. Die Datei erzeugt der Build schon mit.

## TouchDesigner

Unter *Ausgabe → TouchDesigner → Exportieren …* wählt man den Ordner der `.toe`-Datei. Dort entsteht ein Ordner `kalibrierung/`:

```
kalibrierung/
  kalibrierung.json        Kameras aller Projektoren (Position, Rotation, FOV, Lens Shift)
  masken/Px.png            Überblendung und eigene Masken
  feinkorrektur/Px.frag    Shader für einen GLSL TOP, falls eine Feinkorrektur gesetzt ist
  apply_calibration.py     Skript zum Übernehmen
  osc_callbacks.py         Gegenstück für die Live-Verbindung
```

`apply_calibration.py` kommt in einen Text DAT im selben Netzwerk wie die Kameras, dann *Run Script*. Das Skript stellt jede Kamera ein (der Name steht pro Projektor unter *Einrichten*, Standard ist `Kamera_Px`) und prüft danach selbst, ob die Projektion stimmt. Steht oben im Skript `SETUP_MASKS = True`, baut es hinter jedem Render TOP noch Maske und Feinkorrektur ein:

```
Projektion_Px → Blend_Px (× Maske_Px) → Fein_Px (GLSL TOP) → …
```

Läuft das Skript ein zweites Mal, aktualisiert es nur, was schon da ist.

Für die Live-Verbindung braucht es in TouchDesigner einen OSC In DAT auf Port 7000 mit `osc_callbacks.py` als Callbacks DAT. Wie genau, steht oben in der Datei. In der App dann unter *Ausgabe* „Live senden“ einschalten. Ab da landet jede Änderung sofort auf den Kameras.

## Entwickeln

Mit Node.js 22:

```sh
npm install
npm start          # App starten
npm test           # Unit-Tests: Solver, Export, TD-Skript, OSC, Wiedergabe, Feinkorrektur
npm run test:e2e   # einmal komplett durch die App klicken, Screenshots landen in test-output/
npm run dist       # Installer für das eigene System bauen
```

Auf Linux ohne Bildschirm läuft der E2E-Test mit `xvfb-run -a npm run test:e2e`.

Die wichtigsten Ordner:

```
src/main/       Hauptprozess: Fenster, Bildschirme, Dateien, OSC, Updates
src/renderer/   Oberfläche, 3D-Ansicht, Vorschau, Überblendung, Solver im Worker
src/output/     Vollbildfenster je Ausgang (Szene, Feinkorrektur und Maske auf der GPU)
src/core/       Solver, Export, OSC
src/shared/     Projektformat, Masken, Wiedergabe, Verzerrungsgitter
examples/       Demo-Gewölbe
td/             Skripte für TouchDesigner
test/           Tests und Testvideo
```

## Lizenz

Privat, alle Rechte vorbehalten, siehe [LICENSE](LICENSE). three.js steht unter MIT-Lizenz.
