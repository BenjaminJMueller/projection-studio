# Änderungen

## 1.0.0 – 2026-11-17

Erste vollständige Version.

- **Kalibrieren**: Lochkamera-Solver mit 9 Parametern, Plausibilitätsannahmen und mehreren Startlagen, laufende Neuberechnung, Gütewert je Projektor, Vorschläge für die nächsten Punkte, Punkte direkt am Projektor setzen.
- **Feinkorrektur**: Verzerrungsgitter pro Projektor (3×3 bis 9×9, weich interpoliert), Bearbeitung in der Vorschau, am Projektor oder per Pfeiltasten.
- **Überblenden**: automatische weiche Masken auf der GPU mit Helligkeitsausgleich, Filter für steile Flächen (Wände, Bogenseiten), eigene weiche Masken.
- **Ausgabe**: Vollbildfenster je HDMI-Ausgang mit 2×2 Bildvierteln, Testbilder (Kanten, Raster, Weiß, Nummer), Masken und Feinkorrektur auf der GPU.
- **Videowiedergabe**: Video auf dem Modell (Draufsicht oder Modell-UV) über alle Projektoren, gemeinsame Uhr mit Gleichlaufregelung, Bildratenanzeige je Ausgang.
- **TouchDesigner**: Export (Kameras, Masken, Feinkorrektur-Shader), Skript zum Übernehmen inkl. automatischem Einfügen von Maske und GLSL TOP, Live-Verbindung per OSC.
- **Oberfläche**: vier Schritte, Einführung beim ersten Start, Hilfe mit Tastenkürzeln, helles und dunkles Erscheinungsbild, macOS und Windows.
- **Tests**: Unit-Tests und ein E2E-Klickpfad durch die ganze App.
