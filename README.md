# Projection Studio

Projection Studio ist ein Werkzeug für 3D-Projection-Mapping auf macOS und Windows. Es bestimmt die Lage und die Optik jedes Projektors anhand weniger Punktkorrespondenzen zwischen einem 3D-Modell (OBJ) und dem realen Projektionsbild. Darauf aufbauend berechnet es Überblendmasken mit Helligkeitsausgleich, erlaubt eine gitterbasierte Feinkorrektur und gibt das Ergebnis entweder direkt aus oder übergibt es an TouchDesigner.

![Kalibrieren](docs/screenshots/02-kalibriert.png)

## Ausgangslage

Entwickelt wurde die App für eine Installation auf einer Gewölbedecke:

- 8 × Epson EB-535W (Kurzdistanz), Projektion über Bodenspiegel, Bild im Projektor gespiegelt
- großer vertikaler Lens Offset, 4 Projektoren im Innenring um eine Mittelsäule, 4 im Außenring
- Zuspielung von einem Rechner über 2 × 4K, jeder Ausgang in 2 × 2 Projektorbilder geteilt
- Inhalte in TouchDesigner, Wiedergabe von Videos ab 2K über alle Projektoren

Die Software ist nicht auf diesen Aufbau beschränkt. Jede Geometrie, die als OBJ vorliegt, lässt sich verwenden. Das Gewölbe liegt als Demo bei.

## Bestehende Lösungen und Abgrenzung

Für die Kalibrierung von Projektoren auf 3D-Geometrie gibt es etablierte Werkzeuge. In diesem Projekt kamen sie an Grenzen:

| Lösung | Ansatz | Erfahrung in diesem Aufbau |
| --- | --- | --- |
| **camSchnappr** (TouchDesigner) | Kamerabestimmung aus Punktpaaren ohne Vorwissen über die Optik | Bei wenigen oder eng beieinander liegenden Punkten instabil, das Modell kippte oder verschwand oft beim sechsten Punkt. Keine unabhängige Ansicht, um die Lösung zu beurteilen. Das Ergebnis hing stark von der Punktwahl ab. |
| **Stoner** (TouchDesigner) | 2D-Verzerrung des fertigen Bildes | Gut für Restfehler, kennt aber die Geometrie nicht und ersetzt keine Kalibrierung. |
| **MadMapper** | Flächen- und 2D-Mapping, einfache 3D-Szenen | Mit Spiegel, Lens Offset und Gewölbe nicht zu einem brauchbaren Ergebnis gekommen. |
| **Medienserver** wie disguise oder Pixera | Vollständige 3D-Kalibrierung und Wiedergabe | Technisch passend, aber an eigene Hardware und Lizenzen gebunden und für eine feste Installation mit TouchDesigner überdimensioniert. |

Projection Studio verbindet diese Schritte in einer Anwendung und setzt vor allem an der Stabilität der Kalibrierung an:

- **Kalibrierung mit Vorwissen.** Objektiv, Projektionsverhältnis, Lens Offset und eine ungefähre Position fließen als Annahmen mit Unsicherheit in die Lösung ein. Dadurch reichen vier Punkte für eine erste und sechs für eine stabile Lösung, auch wenn die Punkte ungünstig liegen.
- **Sofortige Rückmeldung.** Jede Änderung wird im Hintergrund neu gelöst. Eine 3D-Ansicht zeigt Projektorposition und Projektionskegel, die Projektoren zeigen das Ergebnis live. Pro Punkt wird der Restfehler in Pixeln angezeigt, dazu Vorschläge, wo ein weiterer Punkt die Lösung am meisten verbessert.
- **Überblendung aus der Geometrie.** Die Masken ergeben sich aus der Kalibrierung und berücksichtigen Abstand und Einfallswinkel. Steile Flächen lassen sich automatisch ausblenden.
- **Ein Werkzeug für alles.** Kalibrierung, Überblendung, Feinkorrektur, Testbilder und Videowiedergabe laufen in einer App, die Übergabe an TouchDesigner geht per Export oder live per OSC.
- **Keine Spezialhardware.** Läuft auf einem normalen Rechner mit macOS oder Windows, die Ausgänge sind einfache Vollbildfenster.

## Technischer Ansatz

**Kalibrierung.** Jeder Projektor wird als Lochkamera mit 9 Parametern modelliert (Rotation, Position, Brennweite, Bildhauptpunkt). Die Lösung ist eine MAP-Schätzung: Reprojektionsfehler in Pixeln plus gewichtete Abweichungen von den Objektiv- und Positionsannahmen, minimiert mit Levenberg-Marquardt aus mehreren Startlagen. Gespiegelte Projektion wird berücksichtigt. Der Solver läuft in einem Web Worker, die Oberfläche bleibt dabei bedienbar. Als Gütemaß dienen RMS-Fehler, die Unsicherheit der Position und die Verteilung der Punkte im Bild.

**Überblendung.** Für jeden Projektor wird auf der GPU berechnet, welche anderen Projektoren dieselbe Oberfläche treffen. Der Anteil jedes Projektors folgt der Bestrahlungsstärke E ∝ cos(Einfallswinkel) / (Abstand² · cos³(Achsenwinkel)), weich ausgeblendet zu den Bildrändern und mit einstellbarem Gamma. Flächen jenseits eines Grenzwinkels können ausgeschlossen werden. Eigene Masken mit weicher Kante werden multipliziert.

**Feinkorrektur.** Ein Gitter mit 3 × 3 bis 9 × 9 Stützpunkten pro Projektor, dazwischen Catmull-Rom-Interpolation. Die Ausgabe sucht pro Pixel per Fixpunktiteration die Quellposition, im Shader und identisch in TouchDesigner.

**Ausgabe und Wiedergabe.** Pro Ausgang ein Vollbildfenster. Jeder Projektor wird in ein eigenes Renderziel mit Multisampling gerendert und anschließend in einem Durchgang mit Feinkorrektur und Maske in sein Bildviertel gesetzt. Videos werden auf das Modell gelegt (Draufsicht oder Modell-UV). Alle Fenster folgen einer gemeinsamen Uhr und gleichen kleine Abweichungen über die Abspielgeschwindigkeit aus, größere durch Springen.

## Arbeitsablauf

1. **Einrichten.** Modell laden, Projektoren aktivieren, Objektiv, Spiegel, Auflösung, Ausgang und Bildviertel festlegen.
2. **Kalibrieren.** Projektor wählen, markante Punkte im Modell anklicken und im Projektionsbild treffen, per Maus am Projektor, in der Vorschau oder mit den Pfeiltasten (1 px, mit ⇧ 10 px). Restfehler über den Reiter *Feinkorrektur* ausgleichen.
3. **Überblenden.** Masken berechnen, Grenzwinkel und Übergänge anpassen, eigene Masken zeichnen.
4. **Ausgabe.** Testbilder oder Video auf den Projektoren, Export oder Live-Verbindung zu TouchDesigner.

<p>
  <img src="docs/screenshots/04-blending.png" width="49%" alt="Überblenden">
  <img src="docs/screenshots/09-feinkorrektur.png" width="49%" alt="Feinkorrektur">
</p>

Projekte werden automatisch gesichert, alle Schritte lassen sich rückgängig machen. Eine Einführung führt beim ersten Start durch die Einrichtung und bietet an, mit der Demo zu beginnen.

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
