# Projection Studio

Projection Studio ist ein Werkzeug für 3D-Projection-Mapping auf macOS und Windows. Es bestimmt die Lage und die Optik jedes Projektors anhand weniger Punktkorrespondenzen zwischen einem 3D-Modell (OBJ) und dem realen Projektionsbild. Darauf aufbauend berechnet es Überblendmasken mit Helligkeitsausgleich, erlaubt eine Feinkorrektur über Gitter und frei gesetzte Punkte und gibt das Ergebnis entweder direkt aus oder übergibt es an TouchDesigner.

![Kalibrieren](docs/screenshots/02-kalibriert.png)

## Hintergrund

Projection Studio ist im Rahmen der Lehre entstanden. Anlass war eine Installation auf einer Gewölbedecke, die mit TouchDesigner bespielt wird:

- 8 × Epson EB-535W (Kurzdistanz), Projektion über Bodenspiegel, Bild im Projektor gespiegelt
- großer vertikaler Lens Offset, 4 Projektoren im Innenring um eine Mittelsäule, 4 im Außenring
- Zuspielung von einem Rechner über 2 × 4K, jeder Ausgang über einen Video-Wall-Controller (LogiLink HD0054) auf 4 Projektoren verteilt
- Wiedergabe von Videos ab 2K über alle Projektoren

Die Software ist nicht auf diesen Aufbau beschränkt. Jede Geometrie, die als OBJ vorliegt, lässt sich verwenden. Das Gewölbe liegt als Demo bei.

## Bestehende Werkzeuge

Für Projection Mapping gibt es eine Reihe etablierter Werkzeuge, unter anderem:

- **camSchnappr** und **Stoner** als Komponenten für TouchDesigner (Kamerakalibrierung aus Punktpaaren bzw. 2D-Verzerrung)
- **Kantan Mapper** in TouchDesigner für flächiges Mapping
- **MadMapper**, **Resolume Arena**, **HeavyM** und **Millumin** für Mapping und Wiedergabe, überwiegend auf Flächen und einfacher Geometrie
- Medienserver wie **disguise**, **Pixera** und **Watchout**, die 3D-Kalibrierung, Überblendung und Wiedergabe für große Produktionen abdecken
- Kamerabasierte Autokalibrierung, etwa von **VIOSO** oder **scalable display technologies**

## Warum ein eigenes Werkzeug

Für den Aufbau oben passte keine dieser Lösungen gut. Mit camSchnappr war die Kalibrierung zeitaufwendig und schwer reproduzierbar. Die markanten Punkte im Gewölbe liegen eng beieinander, und ohne Annahmen über die Optik wurde die Lösung bei solchen Punkten instabil. Eine unabhängige Ansicht, an der sich das Ergebnis beurteilen lässt, gab es nicht. MadMapper kam mit Spiegel, Lens Offset und Gewölbe nicht zu einem brauchbaren Ergebnis. Medienserver und kamerabasierte Systeme können das, sind aber an eigene Hardware und Lizenzen gebunden und für eine Lehrinstallation mit TouchDesigner nicht angemessen.

Daraus ergaben sich die Anforderungen an dieses Werkzeug:

- eine Kalibrierung, die auch mit wenigen, ungünstig liegenden Punkten stabil bleibt, weil Objektiv, Lens Offset und ungefähre Position als Vorwissen einfließen
- direkte Rückmeldung in einer 3D-Ansicht und auf den Projektoren, damit nachvollziehbar ist, was die Lösung tut
- Überblendung, Feinkorrektur und Testbilder an einem Ort, ohne zusätzliche Komponenten
- eine Übergabe an TouchDesigner, die sich in bestehende Netzwerke einfügt
- eine eigene Wiedergabe, damit die Installation auch ohne TouchDesigner bespielt werden kann
- lauffähig auf einem normalen Rechner unter macOS und Windows, verständlich auch für Studierende ohne Vorerfahrung

## Technischer Ansatz

**Kalibrierung.** Jeder Projektor wird als Lochkamera mit 9 Parametern modelliert (Rotation, Position, Brennweite, Bildhauptpunkt). Die Lösung ist eine MAP-Schätzung: Reprojektionsfehler in Pixeln plus gewichtete Abweichungen von den Objektiv- und Positionsannahmen, minimiert mit Levenberg-Marquardt aus mehreren Startlagen. Gespiegelte Projektion wird berücksichtigt. Der Solver läuft in einem Web Worker, die Oberfläche bleibt dabei bedienbar. Als Gütemaß dienen RMS-Fehler, die Unsicherheit der Position und die Verteilung der Punkte im Bild.

**Überblendung.** Für jeden Projektor wird auf der GPU berechnet, welche anderen Projektoren dieselbe Oberfläche treffen. Der Anteil jedes Projektors folgt der Bestrahlungsstärke E ∝ cos(Einfallswinkel) / (Abstand² · cos³(Achsenwinkel)), weich ausgeblendet zu den Bildrändern und mit einstellbarem Gamma. Flächen jenseits eines Grenzwinkels können ausgeschlossen werden. Eigene Masken mit weicher Kante werden multipliziert.

**Feinkorrektur.** Zwei Ebenen pro Projektor. Ein Gitter mit 2 × 2 bis 33 × 33 Stützpunkten, Spalten und Zeilen getrennt wählbar, bikubisch nach Hermite interpoliert. Ohne weitere Eingriffe entspricht das Catmull-Rom, optional lassen sich an jedem Gitterpunkt Bézier-Anfasser ziehen, die den Verlauf der Linien biegen. Dazu kommen frei gesetzte Punkte an beliebiger Stelle. Jeder wirkt mit einem Wendland-Kern begrenzter Reichweite, und die Gewichte werden so gelöst, dass jeder Punkt sein Ziel exakt trifft. Ein neu gesetzter Punkt hält das Bild an seiner Stelle fest, bis er gezogen wird. Faltet sich das Bild durch zu starke Korrekturen, weist die App darauf hin.

Für die Ausgabe wird die Abbildung umgekehrt: zu jedem Ausgabepixel die Quellposition, per Newton-Verfahren. In der App geschieht das in einem Hintergrund-Thread als Tabelle (während des Ziehens grob, danach mit 480 × 270 Stützstellen, Fehler unter 0,2 px), die die GPU linear interpoliert. Der Aufwand pro Bild hängt damit nicht von der Zahl der Punkte ab. Für TouchDesigner entsteht ein GLSL-Shader mit denselben Werten als Konstanten, der die Umkehrung direkt rechnet. Er stimmt mit der App auf etwa 0,001 px überein.

**Ausgabe und Wiedergabe.** Pro Ausgang ein Vollbildfenster. Jeder Projektor wird in ein eigenes Renderziel mit Multisampling gerendert und anschließend in einem Durchgang mit Feinkorrektur und Maske in sein Bildviertel gesetzt. Videos werden auf das Modell gelegt (Draufsicht oder Modell-UV). Alle Fenster folgen einer gemeinsamen Uhr und gleichen kleine Abweichungen über die Abspielgeschwindigkeit aus, größere durch Springen.

## Ausgänge und Video-Wall-Controller

Die App unterstützt Video-Wall-Controller (auch Video-Wall-Prozessor genannt), die ein 4K-Signal in 2 × 2 Full-HD-Signale aufteilen. Im Gewölbe ist das ein LogiLink HD0054 je Ausgang. Vergleichbare Geräte gibt es unter anderem von StarTech, Lindy oder Datapath.

Gründe für diesen Weg:

- **Mehr Projektoren an einem Rechner.** Übliche Grafikkarten haben vier Ausgänge, oft weniger. Mit zwei Controllern laufen acht Projektoren an zwei Ausgängen.
- **Gleicher Bildzeitpunkt.** Die vier Projektoren an einem Controller bekommen ihre Bilder aus einem gemeinsamen 4K-Bild. Sie wechseln deshalb immer gleichzeitig, auch in den Überlappungen.
- **Einfache Software-Seite.** Für das Betriebssystem ist jeder Controller ein einzelner 4K-Bildschirm. Die App öffnet darauf ein Vollbildfenster und setzt die vier Projektorbilder in die Viertel.

Unter *Einrichten* wird je Ausgang der Modus des Controllers gewählt: *2 × 2*, *2 nebeneinander*, *2 übereinander*, *3 nebeneinander*, *4 nebeneinander* oder *4 übereinander*, bzw. *Ganz*, wenn ein Projektor direkt angeschlossen ist. Die Projektoren des Ausgangs werden dann der Reihe nach auf die Felder verteilt. Passt die Auflösung des Bildschirms nicht zum Modus, steht ein Hinweis daneben. Am Controller selbst sollte der reine Modus ohne Rahmenausgleich (Bezel Correction) eingestellt sein. Überlappung und Überblendung übernimmt die App.

Die Bildschirme werden über eine Auswahl zugewiesen. Die Ausgänge öffnen sich randlos im Vollbild auf dem gewählten Bildschirm, unter macOS und Windows. Wählt man für einen Ausgang den Bildschirm eines anderen, tauschen die beiden. Wird ein Bildschirm abgesteckt, schließt sein Ausgang. Kommt er wieder, öffnet sich der Ausgang dort erneut, auch wenn das System dem Bildschirm eine neue Kennung gegeben hat. Ändert sich die Auflösung, passt sich das Vollbild an.

Zum Kalibrieren gibt es zusätzlich einen **Testausgang**. Dort lässt sich ein einzelner Projektor ohne Controller direkt anschließen, und der Ausgang zeigt immer den gerade gewählten Projektor im ganzen Bild. Mit der Option *Maus springt mit* wandert der Mauszeiger beim Wechsel des Projektors auf dessen Bild, auf dem Testausgang oder im richtigen Feld des Controllers.

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
