# Projection Studio

Deutsch · [English](README.en.md)

Projection Studio ist ein Werkzeug für 3D-Projection-Mapping auf macOS und Windows. Es bestimmt die Lage und die Optik jedes Projektors anhand weniger Punktkorrespondenzen zwischen einem 3D-Modell (OBJ) und dem realen Projektionsbild. Darauf aufbauend berechnet es Überblendmasken mit Helligkeitsausgleich, erlaubt eine Feinkorrektur über Gitter und frei gesetzte Punkte und gibt das Ergebnis entweder direkt aus oder übergibt es an TouchDesigner.

![Kalibrieren](docs/screenshots/02-kalibriert.png)

> **Beta.** Projection Studio ist an einem konkreten Aufbau entstanden und dort erprobt, auf anderen Systemen aber noch wenig. Fehler und Lücken sind wahrscheinlich, siehe [Funktionsumfang und Grenzen](#funktionsumfang-und-grenzen). Wenn es trotzdem jemandem bei einem eigenen Projekt weiterhilft, freue ich mich.

**Herunterladen:** [macOS (.dmg)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-mac.dmg) · [Windows, Installer (.exe)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-Setup.exe) · [Windows, ohne Installation (.exe)](https://github.com/BenjaminJMueller/projection-studio/releases/latest/download/Projection-Studio-Portable.exe) · [Hinweise zur Installation](#installation)

## Hintergrund

Projection Studio ist im Rahmen der Lehre entstanden. Anlass war eine Installation auf einer Gewölbedecke, die mit TouchDesigner bespielt wird:

- 8 × Epson EB-535W (Kurzdistanz), Projektion über Bodenspiegel, Bild im Projektor gespiegelt
- großer vertikaler Lens Offset, 4 Projektoren im Innenring um eine Mittelsäule, 4 im Außenring
- Zuspielung von einem Rechner über 2 × 4K, jeder Ausgang über einen Video-Wall-Controller (LogiLink HD0054) auf 4 Projektoren verteilt
- Wiedergabe von Videos ab 2K über alle Projektoren

Für die Lehre standen nur diese Projektoren zur Verfügung. Für eine Gewölbedecke sind sie eher ungünstig: Kurzdistanzobjektive mit starker Verzeichnung an den Rändern, ein Lens Offset, durch den das Bild vollständig auf einer Seite der Objektivachse liegt, und der Umweg über Spiegel am Boden. Die Spiegel sind nötig, weil die Geräte nicht gekippt werden dürfen: Laut [Bedienungsanleitung](https://download.epson.com.sg/manuals/EB-535W_User%20Guide.pdf) (Abschnitt *Installing the Projector*) ist der Projektor waagerecht und parallel zur Projektionsfläche aufzustellen, nicht auf der Seite zu betreiben, und die Montage an Wand oder Decke erfordert eine eigene Halterung. Ein schräg nach oben auf die Decke gerichteter Projektor ist nicht vorgesehen. Deshalb stehen die Projektoren waagerecht, und ein Spiegel lenkt das Bild nach oben. Mit Projektoren mit Lens Shift und passender Brennweite wäre vieles einfacher gewesen. Es musste also eine Lösung gefunden werden, die mit dem vorhandenen Material zurechtkommt.

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

Die App unterstützt Video-Wall-Controller (auch Video-Wall-Prozessor genannt), die ein 4K-Signal in 2 × 2 Full-HD-Signale aufteilen. Im Gewölbe ist das ein LogiLink HD0054 je Ausgang. Vergleichbare Geräte gibt es unter anderem von Matrox (QuadHead2Go für 2 × 2 oder 4 nebeneinander, TripleHead2Go für 3 nebeneinander), Datapath, StarTech und Lindy.

Gründe für diesen Weg:

- **Mehr Projektoren an einem Rechner.** Übliche Grafikkarten haben vier Ausgänge, oft weniger. Mit zwei Controllern laufen acht Projektoren an zwei Ausgängen.
- **Gleicher Bildzeitpunkt.** Die vier Projektoren an einem Controller bekommen ihre Bilder aus einem gemeinsamen 4K-Bild.
- **Einfache Software-Seite.** Für das Betriebssystem ist jeder Controller ein einzelner 4K-Bildschirm. Die App öffnet darauf ein Vollbildfenster und setzt die vier Projektorbilder in die Viertel.

Unter *Einrichten* wird je Ausgang der Modus des Controllers gewählt: *2 × 2*, *2 nebeneinander*, *2 übereinander*, *3 nebeneinander*, *4 nebeneinander* oder *4 übereinander*, bzw. *Ganz*, wenn ein Projektor direkt angeschlossen ist. Die Projektoren des Ausgangs werden dann der Reihe nach auf die Felder verteilt. Passt die Auflösung des Bildschirms nicht zum Modus, steht ein Hinweis daneben. Am Controller selbst sollte der reine Modus ohne Rahmenausgleich (Bezel Correction) eingestellt sein. Überlappung und Überblendung übernimmt die App.

Die Bildschirme werden über eine Auswahl zugewiesen. Die Ausgänge öffnen sich randlos im Vollbild auf dem gewählten Bildschirm, unter macOS und Windows. Die Zuordnung bleibt auch nach Abstecken oder Auflösungswechsel erhalten.

Zum Kalibrieren gibt es zusätzlich einen **Testausgang**. Dort lässt sich ein einzelner Projektor ohne Controller direkt anschließen, und der Ausgang zeigt immer den gerade gewählten Projektor im ganzen Bild. Mit der Option *Maus springt mit* wandert der Mauszeiger beim Wechsel des Projektors auf dessen Bild, auf dem Testausgang oder im richtigen Feld des Controllers.

## Arbeitsablauf

1. **Einrichten.** Modell laden, Projektoren aktivieren, Objektiv, Spiegel, Auflösung, Ausgang und Bildviertel festlegen.
2. **Kalibrieren.** Projektor wählen, markante Punkte im Modell anklicken und im Projektionsbild treffen, per Maus am Projektor, in der Vorschau oder mit den Pfeiltasten (1 px, mit ⇧ 10 px). Oder mit Kamera und Testmustern (siehe unten). Restfehler über den Reiter *Feinkorrektur* ausgleichen.
3. **Überblenden.** Masken berechnen, Grenzwinkel und Übergänge anpassen, eigene Masken zeichnen.
4. **Ausgabe.** Testbilder oder Video-Playlist auf den Projektoren, Ton auf die Lautsprecher, Raumeinmessung, Export oder Live-Verbindung zu TouchDesigner.

<p>
  <img src="docs/screenshots/04-blending.png" width="49%" alt="Überblenden">
  <img src="docs/screenshots/09-feinkorrektur.png" width="49%" alt="Feinkorrektur">
</p>

Projekte werden automatisch gesichert, alle Schritte lassen sich rückgängig machen. Eine Einführung führt beim ersten Start durch die Einrichtung und bietet an, mit der Demo zu beginnen. Die Oberfläche ist auf Deutsch, Englisch lässt sich im Menü *Ansicht → Sprache* oder unter *Hilfe* (?) umstellen.

## Funktionsumfang und Grenzen

| | |
|---|---|
| Projektoren | bis zu 16 pro Projekt, einzeln abschaltbar, frei benennbare Gruppen (z. B. Innenring, Außenring) |
| Ausgänge | bis zu 4 Ausgänge für Video-Wall-Controller (HDMI A bis D) und 1 Testausgang für einen direkt angeschlossenen Projektor, alle auf demselben Rechner |
| Controller-Modi | *Ganz*, *2 × 2*, *2 nebeneinander*, *2 übereinander*, *3 nebeneinander*, *4 nebeneinander*, *4 übereinander*, *3 × 2*, *3 × 3*. Alle Felder eines Ausgangs sind gleich groß. |
| Auflösung je Projektor | 1920 × 1080, 1920 × 1200, 1280 × 800, 1280 × 720, 1024 × 768, 3840 × 2160 oder die native des Projektor-Typs (Auflösung des Signals) |
| 3D-Modell | nur OBJ, Materialien und Texturen werden ignoriert. Die Demo hat rund 16 000 Dreiecke, deutlich größere Modelle sind nicht erprobt. |
| Projektor-Typen | Datenbank mit geprüften Datenblattwerten (Epson EB-535W, BenQ MW632ST, Optoma GT1080HDR, Epson EB-L1050U, Panasonic PT-VMZ60), eigene Typen aus dem Datenblatt (native Auflösung, Wurfverhältnis, Zoom, fester Offset oder Lens Shift), dazu allgemeine Voreinstellungen. Keine Modellierung von Objektivverzeichnung, Reste gleicht die Feinkorrektur aus. |
| Kalibrierung | von Hand ab 4 Punktpaaren (6 gut verteilte sind ideal) oder mit Kamera und Testmustern, siehe unten |
| Feinkorrektur | Gitter 2 bis 33 Stützpunkte je Richtung, optional Bézier-Anfasser, bis zu 200 freie Punkte je Projektor |
| Masken | automatische Überblendung, eigene Masken als Vielecke mit weicher Kante |
| Video | Playlist, Start/Pause mit Leertaste, Bildrate einstellbar (frei, 24, 25, 30, 50, 60), Anzeige der aktuellen Bildrate. Formate, die Chromium abspielt: H.264 und AAC in MP4/MOV, VP8, VP9 und AV1 in WebM/MKV. H.265/HEVC nur, wenn das System es in Hardware dekodiert. ProRes, HAP, DXV und Bildsequenzen werden nicht unterstützt. Zwischen zwei Videos der Playlist kann ein Bild hängen bleiben. Die mögliche Auflösung hängt von Decoder und Grafikkarte ab. |
| Ton | Tonspur des Videos auf bis zu 32 Lautsprecher, Zuordnung der Kanäle, Gesamt- und Einzelpegel mit Pegelanzeige, Audiogerät, Sample-Rate und Puffergröße wählbar. Kein ASIO: unter Windows über WASAPI, unter macOS über Core Audio. |
| Raumeinmessung | Sweep über alle Lautsprecher an mehreren Messstellen, gleicht Laufzeit, Pegel und Klang (bis 8 Filter je Lautsprecher) für die ganze Liegefläche an, ein- und ausschaltbar. Mikrofon: Smartphone per QR-Code im selben WLAN oder Messmikrofon an einem Audio-Interface. |
| TouchDesigner | Export (JSON, Masken als PNG, GLSL-Shader, Python-Skript) und Live-Verbindung per OSC |
| Sprachen | Deutsch (Standard), Englisch |
| Systeme | macOS 11 oder neuer (Apple Silicon und Intel), Windows 10/11 64 Bit; Grafikkarte mit WebGL 2 |

Bekannte Grenzen:

- Die Mac-App ist nicht von Apple signiert und beglaubigt, beim ersten Start ist ein Umweg nötig (siehe unten).
- Kein automatisches Update, solange das Repository privat ist.
- Die Leistung mit 8 Projektoren an 2 × 4K (und erst recht mit 16) ist auf dem Zielrechner noch nicht gemessen. Die App zeigt die Bildrate je Ausgang an.
- *Maus springt mit* und der Wechsel zwischen Bildschirmen sind auf echter Hardware unter macOS und Windows noch nicht erprobt.
- Das Zusammenspiel mit TouchDesigner ist mit einem Nachbau der TD-Schnittstelle getestet, an einer echten Installation nur teilweise.
- Kamera-Kalibrierung und Raumeinmessung sind mit simulierten Kamerabildern bzw. Aufnahmen getestet, an der echten Installation noch nicht.
- Raumeinmessung mit dem Smartphone: Handy-Mikrofone sind unter etwa 100 Hz und über 10 kHz ungenau, korrigiert wird deshalb nur dazwischen. Das Handy fragt beim ersten Öffnen einmal nach dem selbst erstellten Zertifikat.
- Auch für flache Leinwände braucht es ein (einfaches) OBJ-Modell.
- Mehrere Rechner im Verbund werden nicht unterstützt.

## Kalibrierung mit Kamera

Statt Punkte von Hand zu setzen, kann eine Webcam (z. B. Logitech StreamCam) einen Projektor vermessen. Pro Projektor zeigt der Assistent *Mit Kamera kalibrieren …* (Schritt *Kalibrieren*):

1. **Ausrichten.** Der Projektor und ein schon kalibrierter Nachbar zeigen ein Schachbrett. Die Kamera wird fest aufgestellt, so dass sie möglichst viel vom Projektor und einen Teil des Nachbarn sieht. Eine Schärfeanzeige mit Bestwert hilft beim Scharfstellen.
2. **Messen.** Belichtung, Fokus und Weißabgleich werden festgestellt, soweit die Kamera das erlaubt. Dann zeigen beide Projektoren nacheinander Streifenmuster (Gray-Code mit Umkehrung, etwa 15 Sekunden je Projektor). Aus dem Nachbarn ergibt sich der Standort der Kamera, aus dem Projektor die Punktpaare für den Solver.
3. **Ergebnis.** Fehler, Abdeckung des Projektorbilds und eine Schärfekarte. Sieht die Kamera nicht alles, kommt ein weiterer Standort dazu; die Punkte aller Standorte werden zusammen verwendet. Die Kamera-Punkte lassen sich mit Punkten von Hand ergänzen.

Unschärfe wird an den Mustern selbst erkannt: Feine Streifen haben nur dann vollen Kontrast, wenn Kamera und Projektor scharf sind, gemessen bei einer Streifenbreite, die zum Kameraabstand passt. Ist das Bild unscharf, stellt die Kamera kurz neu scharf und misst noch einmal. Hilft das nicht, hält der Assistent an, zeigt das Schachbrett und leitet zum Fokusring am Projektor an, mit Live-Anzeige. Bewegt sich die Kamera oder ändert sich das Licht während der Messung, wird das erkannt und wiederholt.

Grenzen: Der erste Projektor wird von Hand kalibriert, die Kamera braucht einen kalibrierten Projektor als Bezug. Fehler des Bezugs wandern in die folgenden Projektoren. Die Verzeichnung des Kameraobjektivs wird nicht modelliert. Wie weit sich Belichtung und Fokus feststellen lassen, hängt von Kamera und System ab (unter macOS oft eingeschränkt); dann den Raum abdunkeln. In der Simulation an der Gewölbedecke lag der Fehler bei etwa 0,5 px mit zwei Kamera-Standorten.

## Installation

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
src/shared/     Projektformat, Masken, Wiedergabe, Verzerrungsgitter, Übersetzung
examples/       Demo-Gewölbe
td/             Skripte für TouchDesigner
test/           Tests und Testvideo
```

## Lizenz

Privat, alle Rechte vorbehalten, siehe [LICENSE](LICENSE). three.js steht unter MIT-Lizenz.
