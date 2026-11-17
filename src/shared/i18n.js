// Zweisprachigkeit: Deutsch ist Quelltext und Standard, Englisch wird beim Anzeigen übersetzt.
// tr(text) sucht 1. den ganzen Text, 2. Teile getrennt durch " · ", 3. eine Vorlage, in der Zahlen
// durch {0}, {1} … ersetzt sind, 4. ein paar Muster mit Namen. Unbekanntes bleibt Deutsch.

let lang = 'de';
export const LANGS = [['de', 'Deutsch'], ['en', 'English']];
export function setLang(l) { lang = l === 'en' ? 'en' : 'de'; }
export function getLang() { return lang; }
export const locale = () => (lang === 'en' ? 'en-US' : 'de-DE');

const EN = {
  // ---- Werkzeugleiste, Seitenleiste, Bühne
  'Neues Projekt': 'New project', 'Einrichten': 'Set up', 'Kalibrieren': 'Calibrate', 'Überblenden': 'Blend', 'Ausgabe': 'Output',
  'Arbeitsschritt': 'Step', 'Rückgängig': 'Undo', 'Wiederholen': 'Redo', 'Projekt öffnen': 'Open project', 'Projekt speichern': 'Save project',
  'Hilfe': 'Help', 'Projektoren': 'Projectors', 'Bild auf den Projektoren ein- und ausschalten': 'Turn the image on the projectors on or off',
  'Innenring': 'Inner ring', 'Außenring': 'Outer ring', '3D-Ansicht': '3D view', 'Ansicht': 'View', 'Raum': 'Room', 'Aus Projektorsicht': 'Projector view',
  'Frei drehen': 'Orbit freely', 'Durch den gewählten Projektor schauen': 'Look through the selected projector', 'Darstellung': 'Display',
  'Projektionen auf dem Modell': 'Projections on the model', 'Projektorkegel': 'Projector frustums',
  'An Modellecken einrasten. Alt gedrückt halten für freie Wahl.': 'Snap to model corners. Hold Alt to pick freely.',
  'Ansicht zentrieren': 'Center view', 'Inspektor': 'Inspector', 'Projektorbild': 'Projector image',
  'Bearbeitet': 'Edited', 'Automatisch gesichert': 'Saved automatically', 'Gespeichert': 'Saved',
  'Nichts rückgängig zu machen': 'Nothing to undo', '3D-Position aktualisiert': '3D position updated',
  'Sitzt sehr gut': 'Very good fit', 'Sitzt gut': 'Good fit', 'Erste Lösung': 'First solution', 'Noch unsicher': 'Still uncertain',
  'Kein Ausgang': 'No output', 'Info': 'Info', 'Unsicher': 'Uncertain', 'Projektor': 'Projector',
  // ---- Einrichten
  'Kein Bildschirm': 'No display', 'zeigt den gewählten Projektor allein': 'shows the selected projector on its own', 'nicht belegt': 'not assigned',
  'Zum Kalibrieren einen Projektor direkt anschließen, ohne Video-Wall-Controller. Dieser Ausgang zeigt immer den Projektor, der gerade links gewählt ist, im ganzen Bild.':
    'Connect a single projector directly for calibration, without a video wall controller. This output always shows the projector selected on the left, full frame.',
  'Aufteilung': 'Layout',
  'Modus des Video-Wall-Controllers, z. B. 2 × 2 beim LogiLink HD0054. Die Projektoren werden der Reihe nach auf die Felder verteilt.':
    'Mode of the video wall controller, e.g. 2 × 2 on the LogiLink HD0054. Projectors are assigned to the cells in order.',
  'Kein Modell': 'No model', 'OBJ-Datei wählen': 'Choose OBJ file', 'Ändern …': 'Change …', 'Wählen …': 'Choose …', '3D-Modell': '3D model',
  'Bildschirme': 'Displays', 'Jeder Ausgang der Grafikkarte wird in Viertel geteilt, jedes Viertel geht an einen Projektor.':
    'Each graphics output is split into cells, each cell feeds one projector.',
  'Maus springt mit': 'Mouse follows',
  'Beim Wechsel des Projektors springt der Mauszeiger auf dessen Bild am Ausgang. So muss man die Maus auf den Projektionen nicht suchen.':
    'When you switch projectors, the mouse pointer jumps to its image on the output, so you never have to hunt for it on the projections.',
  'Name': 'Name', 'Verwenden': 'Use', 'Ausgang': 'Output', 'Keiner': 'None', 'Bildbereich': 'Image area', 'Auflösung': 'Resolution',
  'Auflösung des Signals, das der Beamer bekommt, nicht die native Panelauflösung.': 'Resolution of the signal the projector receives, not its native panel resolution.',
  'Objektiv': 'Lens', 'Montage': 'Mounting', 'Automatisch': 'Automatic', 'Achse unter dem Bild': 'Axis below image', 'Achse über dem Bild': 'Axis above image',
  'Kurzdistanz-Beamer projizieren komplett auf eine Seite der Objektivachse. Je nach Menü-Einstellung (Decke/Tisch) liegt sie über oder unter dem Bild. Automatisch prüft beides.':
    'Short-throw projectors project entirely to one side of the lens axis. Depending on the menu setting (ceiling/table) it lies above or below the image. Automatic tries both.',
  'TouchDesigner-Namen': 'TouchDesigner names', 'Kamera': 'Camera', 'Render': 'Render',
  'Name des Camera COMP in TouchDesigner': 'Name of the Camera COMP in TouchDesigner', 'Name des Render TOP, hinter den die Maske gehängt wird': 'Name of the Render TOP the mask is attached to',
  'Testausgang': 'Test output', 'Ganz': 'Full', '2 nebeneinander': '2 side by side', '2 übereinander': '2 stacked', '3 nebeneinander': '3 side by side',
  '4 nebeneinander': '4 side by side', '4 übereinander': '4 stacked',
  'oben links': 'top left', 'oben rechts': 'top right', 'unten links': 'bottom left', 'unten rechts': 'bottom right', 'links': 'left', 'rechts': 'right', 'oben': 'top', 'unten': 'bottom',
  'innen': 'inner', 'außen': 'outer',
  // ---- Kalibrieren
  'Berechnet': 'Solved', 'Rechnet …': 'Solving …', 'Noch keine Punkte': 'No points yet', 'Ab 4 Punkten steht die Position, 6 gut verteilte sind ideal.': 'From 4 points the position is fixed, 6 well-spread points are ideal.',
  'Freie Stelle, nicht eingerastet': 'Free spot, not snapped', 'Punkt verwenden': 'Use point', 'Punkte': 'Points', 'Feinkorrektur': 'Fine correction',
  'Gewählten Punkt im Modell neu setzen': 'Re-pick selected point in the model', 'Gewählten Punkt löschen (Entf)': 'Delete selected point (Del)',
  'Klicke im 3D-Modell auf eine Ecke, um den ersten Punkt zu setzen.': 'Click a corner in the 3D model to place the first point.',
  'Alle Punkte löschen': 'Delete all points', 'Details und Hilfen': 'Details and aids', 'Mittlerer Fehler': 'Mean error', 'Positionsgenauigkeit': 'Position accuracy',
  'Bildabdeckung': 'Image coverage', 'Wie weit die Punkte über das Projektorbild verteilt sind. Über 50 % ist gut.': 'How far the points are spread over the projector image. Above 50 % is good.',
  'Wurfverhältnis': 'Throw ratio', 'Objektivachse': 'Lens axis', 'Bildmitte vorgeben': 'Set image center', 'Entfernen': 'Remove', 'Im Modell klicken': 'Click in the model',
  'Neu wählen': 'Pick again', 'Wählen': 'Pick',
  'Wo ungefähr liegt die Mitte des Beamerbildes an der Decke? Ein Klick ins Modell genügt. Hilft bei wenigen oder eng liegenden Punkten.':
    'Roughly where is the center of the projector image on the ceiling? One click in the model is enough. Helps with few or clustered points.',
  'Kein 3D-Modell geladen': 'No 3D model loaded', 'Unter „Einrichten“ eine OBJ-Datei wählen.': 'Choose an OBJ file under “Set up”.',
  'Maske zeichnen': 'Draw mask', 'Im Projektorbild rechts Eckpunkte setzen. Klick auf den ersten Punkt schließt die Form.': 'Place corner points in the projector image on the right. Clicking the first point closes the shape.',
  'Masken berechnen': 'Compute masks', 'Rechts auf „Masken berechnen“ klicken, sobald die Projektoren kalibriert sind.': 'Click “Compute masks” on the right once the projectors are calibrated.',
  'Bildmitte wählen': 'Pick image center', 'Die richtige Stelle im Modell anklicken.': 'Click the correct spot in the model.',
  'Markante Ecke im Modell anklicken': 'Click a distinct corner in the model', 'Fadenkreuz an dieselbe Ecke der Decke schieben': 'Move the crosshair to the same corner on the ceiling',
  'Im Vorschaubild ziehen oder mit den Pfeiltasten. Danach die nächste Ecke anklicken.': 'Drag in the preview or use the arrow keys. Then click the next corner.',
  'Nächste Ecke anklicken': 'Click the next corner', 'Möglichst weit weg von den bisherigen Punkten.': 'As far away from the existing points as possible.',
  'Kanten an der Decke prüfen': 'Check the edges on the ceiling', 'Wo es nicht passt, einen weiteren Punkt setzen. Blaue Kreise mit + sind gute Stellen dafür.': 'Where it does not fit, add another point. Blue circles with + are good spots.',
  // ---- Feinkorrektur
  'Höchstens 200 freie Punkte.': 'At most 200 free points.', 'Keine Feinkorrektur': 'No fine correction', 'Gitterpunkt': 'grid point', 'Gitterpunkte': 'grid points',
  'freier Punkt': 'free point', 'freie Punkte': 'free points', 'Das Bild faltet sich': 'The image folds over',
  'An einer Stelle ist die Korrektur so stark, dass sich das Bild überschlägt. Den Punkt etwas zurücknehmen oder die Reichweite vergrößern.':
    'The correction is so strong in one place that the image folds over. Pull the point back a little or increase the reach.',
  'Gitterpunkte ziehen oder irgendwo ins Bild klicken, um einen freien Punkt zu setzen. Pfeiltasten: 1 Pixel, mit ⇧ 10 Pixel. Entf löscht den freien Punkt.':
    'Drag grid points, or click anywhere in the image to place a free point. Arrow keys: 1 pixel, with ⇧ 10 pixels. Del removes the free point.',
  'Gitter': 'Grid', 'Spalten × Zeilen': 'Columns × rows', 'Spalten': 'Columns', 'Zeilen': 'Rows',
  'Mehr Punkte erlauben feinere, örtlich begrenzte Korrekturen. Beim Wechsel bleibt die Form erhalten. 2 × 2 verschiebt nur die Ecken.':
    'More points allow finer, local corrections. The shape is kept when you change it. 2 × 2 moves only the corners.',
  'Bézier-Anfasser': 'Bézier handles',
  'Zeigt am gewählten Gitterpunkt Anfasser, mit denen sich die Linien zwischen den Punkten biegen lassen. Ausgeschaltet verlaufen sie automatisch weich.':
    'Shows handles at the selected grid point to bend the lines between points. When off, the lines run smoothly by themselves.',
  'Anfasser zurücksetzen': 'Reset handles', 'Freie Punkte': 'Free points', 'Gesetzt': 'Placed', 'keine': 'none', 'keiner': 'none', 'Reichweite': 'Reach',
  'Wie weit ein freier Punkt das Bild um sich herum mitzieht, in Prozent der Bildhöhe. Kleiner Wert: sehr örtlich.':
    'How far a free point pulls the image around it, in percent of the image height. Small value: very local.',
  'Ausgewählt': 'Selected', 'Testbild': 'Test pattern', 'Raster auf Projektoren': 'Grid on projectors', 'Punkt entfernen': 'Remove point', 'Punkt zurücksetzen': 'Reset point',
  'Feinkorrektur zurückgesetzt. Mit Strg/Cmd+Z rückgängig.': 'Fine correction reset. Undo with Ctrl/Cmd+Z.', 'Alles zurücksetzen': 'Reset all',
  'Freier Punkt': 'Free point',
  // ---- Überblenden
  'Blendet aus': 'Hides', 'Zeigt nur diesen Bereich': 'Shows only this area', 'geschlossen': 'closed', 'wird gezeichnet': 'being drawn',
  'Überblendung': 'Blending', 'Weich überblenden': 'Soft blending',
  'Wo sich Projektoren überlappen, wird weich übergeblendet. Gewichtet nach Abstand zum eigenen Bildrand.': 'Where projectors overlap they blend softly, weighted by the distance to their own image edge.',
  'Breite': 'Width', 'Gamma': 'Gamma', 'Gamma der Beamer, meist 2,2. Verhindert dunkle oder helle Streifen in der Überblendung.': 'Projector gamma, usually 2.2. Prevents dark or bright bands in the blend.',
  'Bogenseiten': 'Arch sides', 'Flächen, die nur von unten beleuchtet werden sollen. Gilt für alle Projektoren gleich, damit die Bilder zusammenpassen.':
    'Surfaces that should only be lit from below. Applies to all projectors alike so the images match.',
  'Steile Flächen ausblenden': 'Hide steep surfaces', 'Blendet Flächen aus, die steiler als der Grenzwinkel stehen, z. B. die Seiten der Bögen.': 'Hides surfaces steeper than the limit angle, e.g. the sides of the arches.',
  'ab Neigung': 'from slope', 'Streiflicht ausblenden': 'Hide grazing light', 'Blendet Stellen aus, die ein Projektor nur sehr flach trifft. Dort ist das Bild verzerrt und ungleich hell.':
    'Hides spots a projector hits only at a very flat angle. The image there is distorted and unevenly bright.',
  'ab Winkel': 'from angle', 'Helligkeit': 'Brightness', 'Angleichen': 'Equalize',
  'Weiter entfernte oder schräg getroffene Flächen sind dunkler. Hellere Bereiche werden auf ein gemeinsames Niveau gedimmt.': 'Surfaces further away or hit at an angle are darker. Brighter areas are dimmed to a common level.',
  'Stärke': 'Strength', '100 % gleicht vollständig an und kostet am meisten Gesamthelligkeit.': '100 % equalizes fully and costs the most overall brightness.',
  'Neue Maske zeichnen': 'Draw new mask', 'Gewählte Maske löschen': 'Delete selected mask', 'Mit + eine Maske anlegen und im Projektorbild oben zeichnen.': 'Create a mask with + and draw it in the projector image above.',
  'Wirkung': 'Effect', 'Bereich ausblenden': 'Hide area', 'Nur Bereich zeigen': 'Show only area', 'Weiche Kante': 'Soft edge', 'Aktiv': 'Active', 'Eigene Masken': 'Custom masks', 'Maske': 'Mask',
  // ---- Ausgabe
  'Video': 'Video', 'Gewähltes Video auf dem Modell': 'Selected video on the model', 'Kanten': 'Edges', 'Kanten des Modells': 'Model edges', 'Raster': 'Grid',
  'Gleichmäßiges Raster über das Modell': 'Even grid across the model', 'Weiß': 'White', 'Weiße Fläche, zeigt Überblendung und Helligkeit': 'White surface, shows blending and brightness',
  'Nummer': 'Number', 'Projektornummer groß': 'Large projector number', 'Bild ausgeben': 'Output image', 'Vollbild auf den zugeordneten Bildschirmen': 'Full screen on the assigned displays',
  'Masken anwenden': 'Apply masks', 'Überblendung und eigene Masken': 'Blending and custom masks', 'Wiedergabe': 'Playback',
  'Spielt ein Video auf dem Modell ab, über alle Projektoren mit Überblendung und Masken. Beide HDMI-Ausgänge laufen synchron.':
    'Plays a video on the model across all projectors with blending and masks. Both HDMI outputs run in sync.',
  'Live senden schickt jede Änderung per OSC an TouchDesigner. Dort einen OSC In DAT mit osc_callbacks.py aus dem Export-Ordner anlegen.':
    'Live send pushes every change to TouchDesigner via OSC. Create an OSC In DAT there with osc_callbacks.py from the export folder.',
  'Live senden': 'Live send', 'Bereit': 'Ready', 'Aus': 'Off', 'Ziel': 'Target', 'Adresse': 'Address', 'Port': 'Port',
  'Kameras, Masken und Skript für TouchDesigner': 'Cameras, masks and script for TouchDesigner', 'Exportieren …': 'Export …',
  'Video wählen': 'Choose video', 'Erst ein Video wählen.': 'Choose a video first.', 'Kein Video gewählt': 'No video selected', 'Datei lässt sich nicht abspielen': 'File cannot be played',
  'Lädt …': 'Loading …', 'Pause': 'Pause', 'Abspielen': 'Play', 'Von vorn': 'From the start', 'Abbildung': 'Mapping', 'Draufsicht': 'Top view', 'Modell-UV': 'Model UV',
  'Draufsicht legt das Video wie von oben gesehen über den Grundriss, Norden oben. Modell-UV nutzt die Texturkoordinaten aus dem 3D-Modell.':
    'Top view lays the video over the floor plan as seen from above, north up. Model UV uses the texture coordinates from the 3D model.',
  'Schleife': 'Loop', 'Leistung': 'Performance',
  'Bilder pro Sekunde je HDMI-Ausgang und verworfene Videobilder. Liegt die Bildrate deutlich unter der des Videos, ist die Grafikkarte oder die Videodatei zu schwer.':
    'Frames per second per HDMI output and dropped video frames. If the frame rate is well below the video’s, the graphics card or the video file is too heavy.',
  'Wird gemessen …': 'Measuring …', 'verworfen': 'dropped', 'Video': 'Video',
  'Erst unter „Einrichten“ einen Bildschirm für HDMI A oder B wählen.': 'First choose a display for HDMI A or B under “Set up”.',
  'Erst im Modell einen Punkt anklicken, dann hier auf der Decke platzieren.': 'First click a point in the model, then place it here on the ceiling.',
  'Demo: Gewölbedecke': 'Demo: vaulted ceiling', '3D-Modell laden': 'Load 3D model', 'Kalibrier-Projekt': 'Calibration project', 'Projekt geöffnet': 'Project opened',
  'Erst mindestens einen Projektor kalibrieren.': 'Calibrate at least one projector first.', 'Noch kein Projektor kalibriert.': 'No projector calibrated yet.',
  'Ordner der TouchDesigner-Datei wählen (dort entsteht „kalibrierung“)': 'Choose the folder of the TouchDesigner file (a “kalibrierung” folder is created there)',
  'Alle Punkte gelöscht. Mit Strg/Cmd+Z rückgängig.': 'All points deleted. Undo with Ctrl/Cmd+Z.', 'Letzte Sitzung wiederhergestellt': 'Last session restored',
  // ---- Einführung, Hilfe
  'Willkommen': 'Welcome', 'Richte deine Projektoren am 3D-Modell aus, blende sie weich ineinander und gib das Ergebnis direkt aus.': 'Align your projectors to the 3D model, blend them softly and output the result directly.',
  'Modell laden und festlegen, welcher Bildschirm welche Projektoren speist.': 'Load the model and decide which display feeds which projectors.',
  'Pro Projektor ein paar Ecken im Modell anklicken und auf der echten Decke treffen.': 'For each projector, click a few corners in the model and hit them on the real ceiling.',
  'Überlappungen, Bogenseiten und Helligkeit werden automatisch ausgeglichen.': 'Overlaps, arch sides and brightness are balanced automatically.',
  'Testbilder auf den Projektoren zeigen oder an TouchDesigner übergeben.': 'Show test patterns on the projectors or hand over to TouchDesigner.',
  'Womit möchtest du starten?': 'How would you like to start?',
  'Die Demo ist eine Gewölbedecke mit acht Projektoren, gut zum Ausprobieren. Alles lässt sich später unter „Einrichten“ ändern.': 'The demo is a vaulted ceiling with eight projectors, good for trying things out. Everything can be changed later under “Set up”.',
  'Mit der Demo': 'With the demo', 'Gewölbedecke, 8 Projektoren': 'Vaulted ceiling, 8 projectors', 'Eigenes 3D-Modell': 'Own 3D model', 'OBJ-Datei wählen …': 'Choose OBJ file …',
  'Projektor 1–4 hängen an HDMI A, Projektor 5–8 an HDMI B, jeweils ein Viertel des Bildes.': 'Projectors 1–4 are on HDMI A, projectors 5–8 on HDMI B, one quarter of the image each.',
  'So setzt du einen Punkt': 'How to place a point', 'Vier Punkte pro Projektor reichen für eine erste Lösung. Sechs gut verteilte sind ideal.': 'Four points per projector give a first solution. Six well-spread points are ideal.',
  'Ecke anklicken': 'Click a corner', 'Eine markante Ecke im 3D-Modell anklicken.': 'Click a distinct corner in the 3D model.', 'Fadenkreuz schieben': 'Move the crosshair',
  'Am Projektor dieselbe Ecke an der Decke treffen, mit Maus oder Pfeiltasten.': 'On the projector, hit the same corner on the ceiling with the mouse or arrow keys.',
  'Prüfen': 'Check', 'Ab vier Punkten erscheinen die Kanten. Wo es nicht passt, nachsetzen.': 'From four points the edges appear. Where it does not fit, add more.',
  'Überspringen': 'Skip', 'Zurück': 'Back', 'Weiter': 'Next', 'Klick': 'Click', 'Punkt im Modell setzen': 'Place point in the model', 'Fadenkreuz verschieben': 'Move crosshair',
  'mit Pfeil: 10 Pixel': 'with arrow: 10 pixels', 'Nächster Punkt': 'Next point', 'Entf': 'Del', 'Punkt löschen': 'Delete point', 'Projektor wählen': 'Select projector',
  'Esc': 'Esc', 'Auswahl aufheben': 'Deselect', 'Strg': 'Ctrl', 'Einführung anzeigen': 'Show introduction', '3D-Modell laden …': 'Load 3D model …', 'Tastenkürzel': 'Keyboard shortcuts',
  'Sprache': 'Language',
  // ---- Hauptmenü
  'Datei': 'File', 'Projekt öffnen …': 'Open project …', 'Speichern': 'Save', 'Speichern unter …': 'Save as …', 'Für TouchDesigner exportieren …': 'Export for TouchDesigner …',
  'Beenden': 'Quit', 'Bearbeiten': 'Edit', 'Ausschneiden': 'Cut', 'Kopieren': 'Copy', 'Einfügen': 'Paste', 'Ausgänge öffnen': 'Open outputs', 'Ausgänge schließen': 'Close outputs',
  'Nach Updates suchen …': 'Check for updates …', 'Bildschirm nicht gefunden': 'Display not found',
  // ---- Objektive, Solver
  'Epson EB-535W – 1080p-Signal (16:9 im 16:10-Panel)': 'Epson EB-535W – 1080p signal (16:9 in 16:10 panel)',
  'Epson EB-535W – natives WXGA-Signal (1280x800)': 'Epson EB-535W – native WXGA signal (1280x800)', 'Wurfverhältnis 0,48 (Wide) bis 0,65 (Tele, digitaler Zoom). Offset 9,51:-1 → Achse liegt ca. 12 % der Bildhöhe unter dem Bild.':
    'Throw ratio 0.48 (wide) to 0.65 (tele, digital zoom). Offset 9.51:-1 → the axis lies about 12 % of the image height below the image.',
  'Wenn das Signal exakt 1280x800 ist.': 'If the signal is exactly 1280x800.',
  'Standard-Beamer mit festem Offset (Achse an Bildunterkante)': 'Standard projector with fixed offset (axis at bottom edge)', 'Typische Büro-/Tischbeamer ohne Lens-Shift.': 'Typical office/desk projectors without lens shift.',
  'Beamer mit Lens-Shift, zentriert': 'Projector with lens shift, centered', 'Achse in Bildmitte (Lens-Shift auf 0).': 'Axis at image center (lens shift at 0).',
  'Unbekannt (frei, mind. 6 Punkte empfohlen)': 'Unknown (free, at least 6 points recommended)', 'Nur schwaches Vorwissen. Braucht gut verteilte Punkte.': 'Only weak prior knowledge. Needs well-spread points.',
  'Keine gültige Lösung gefunden – prüfe, ob die Punktpaare richtig zugeordnet sind.': 'No valid solution found – check that the point pairs are matched correctly.',
  'Die Punkte decken nur einen kleinen Teil des Projektorbildes ab. Setze Punkte nahe an die Bildecken.': 'The points cover only a small part of the projector image. Place points near the image corners.',
  'Mehrdeutig: Eine deutlich andere Projektorposition passt fast genauso gut. Setze einen weiteren Punkt in einer leeren Bildregion.': 'Ambiguous: a clearly different projector position fits almost as well. Place another point in an empty image region.',
  'Lösung ist gespiegelt. Falls das Bild auf der Decke seitenverkehrt erscheint, im Beamer-Menü Front/Rück umstellen.': 'Solution is mirrored. If the image appears reversed on the ceiling, switch front/rear in the projector menu.',
  'Keine Flächen im Modell gefunden.': 'No faces found in the model.',
  // ---- Vorlagen mit Zahlen ({0}, {1} …)
  'Projektor {0}': 'Projector {0}', 'Kalibriert, {0} px Abweichung': 'Calibrated, {0} px deviation', '{0} von {1} kalibriert': '{0} of {1} calibrated',
  'Projektor {0} bis {1}': 'Projectors {0} to {1}', 'Bildschirm hat {0} × {1}, erwartet {2} × {3}': 'Display is {0} × {1}, expected {2} × {3}',
  '{0} Dreiecke': '{0} triangles', '{0} Ecken': '{0} corners', 'Abweichung {0} px': 'Deviation {0} px', 'Position ± {0} cm': 'Position ± {0} cm',
  'Noch {0} Punkt': '{0} more point', 'Noch {0} Punkte': '{0} more points', 'Punkt {0}': 'Point {0}', '{0} % Bildhöhe': '{0} % of image height',
  '{0} Gitterpunkt': '{0} grid point', '{0} Gitterpunkte': '{0} grid points', '{0} freier Punkt': '{0} free point', '{0} freie Punkte': '{0} free points',
  'Freier Punkt · {0} / {1} px': 'Free point · {0} / {1} px', 'Gitter · {0} / {1} px': 'Grid · {0} / {1} px',
  'Punkt {0} neu setzen': 'Re-place point {0}', 'Maske {0}': 'Mask {0}', '{0} Masken berechnet in {1} s': '{0} masks computed in {1} s',
  'Export fertig: {0} Projektor(en) → ': 'Export finished: {0} projector(s) → ', 'Bildschirm {0}': 'Display {0}', '{0}. von links': '{0}. from left', '{0}. von oben': '{0}. from top',
  'Feld {0}': 'Cell {0}', 'Noch {0} Punkt(e) bis zur ersten Lösung.': '{0} more point(s) until the first solution.',
  'Vorläufige Lösung aus {0} Punkten – {1} oder mehr gut verteilte Punkte machen sie stabil.': 'Preliminary solution from {0} points – {1} or more well-spread points make it stable.',
  'Wurfverhältnis {0} (Wide) bis {1} (Tele, digitaler Zoom). Offset {2}:{3} → Achse liegt ca. {4} % der Bildhöhe unter dem Bild.':
    'Throw ratio {0} (wide) to {1} (tele, digital zoom). Offset {2}:{3} → axis is about {4} % of the image height below the image.',
  'Controller, {0} Projektoren': 'Controller, {0} projectors', 'Controller oder Splitter, {0} Projektoren': 'Controller or splitter, {0} projectors',
  'Video-Wall-Controller, {0} Projektoren im Quadrat': 'Video wall controller, {0} projectors in a square',
  'Projektor direkt angeschlossen': 'Projector connected directly', '{0} fps': '{0} fps', '{0} verworfen': '{0} dropped',
  'Position noch unsicher (±{0} Einheiten). Mehr Punkte mit unterschiedlicher Höhe/Tiefe helfen.': 'Position still uncertain (±{0} units). More points at different heights/depths help.',
  'Wurfverhältnis {0} liegt außerhalb des Objektivbereichs – Punkte prüfen oder Objektiv-Preset ändern.': 'Throw ratio {0} is outside the lens range – check the points or change the lens preset.',
  'Videos hinzufügen': 'Add videos',
  'Hinzufügen …': 'Add …',
  'Keine Videos': 'No videos',
  'Mehrere Videos laufen nacheinander.': 'Several videos play one after another.',
  '{0} Videos': '{0} videos',
  'Aus der Liste entfernen': 'Remove from list',
  'Lässt sich nicht abspielen': 'Cannot be played',
  'Vorheriges Video': 'Previous video',
  'Nächstes Video': 'Next video',
  'Liste wiederholen': 'Repeat list',
  'Bildrate': 'Frame rate',
  'Wie Video': 'As video',
  'Höchstens so viele Bilder pro Sekunde ausgeben. „Wie Video“ zeichnet jedes Videobild. Eine niedrigere Rate entlastet die Grafikkarte, z. B. 25 fps für Material mit 50 fps.': 'Output at most this many frames per second. “As video” draws every video frame. A lower rate relieves the graphics card, e.g. 25 fps for 50 fps footage.',
  'Pause (Leertaste)': 'Pause (Space)',
  'Abspielen (Leertaste)': 'Play (Space)',
  'Standbild': 'Still',
  'Die Ausgänge zeichnen nur bei Änderungen neu.': 'Outputs only redraw when something changes.',
  'Spielt Videos auf dem Modell ab, über alle Projektoren mit Überblendung und Masken. Mehrere Videos laufen nacheinander, die Reihenfolge lässt sich durch Ziehen ändern. Alle Ausgänge laufen synchron.': 'Plays videos on the model across all projectors with blending and masks. Several videos play one after another; drag to reorder. All outputs run in sync.',
  'Ton': 'Audio',
  'Gibt den Ton der Videos über ein Audiogerät aus, mit bis zu 32 Kanälen. Zuordnung und Einzelpegel stehen unter „Kanäle und Pegel“.': 'Plays the audio of the videos through an audio device with up to 32 channels. Routing and individual levels are under “Channels and levels”.',
  'Ton ausgeben': 'Audio output',
  'Gesamtpegel': 'Master level',
  'Audiogerät': 'Audio device',
  'Gerät': 'Device',
  'Standardgerät des Systems': 'System default device',
  'Standardgerät': 'Default device',
  'Ausgabegerät, z. B. ein Mehrkanal-Interface. Unter Windows erscheinen hier die WDM/WASAPI-Geräte des Treibers, ASIO wird nicht unterstützt.': 'Output device, e.g. a multichannel interface. On Windows the driver’s WDM/WASAPI devices appear here; ASIO is not supported.',
  'Sample-Rate': 'Sample rate',
  'Wie Gerät': 'As device',
  'Rate der Verarbeitung. Weicht sie vom Gerät ab, rechnet das System um. „Wie Gerät“ vermeidet das.': 'Processing rate. If it differs from the device, the system resamples. “As device” avoids that.',
  'Puffergröße': 'Buffer size',
  '{0} Samples': '{0} samples',
  'Wunschwert für das System. Größer ist stabiler, kleiner reagiert schneller. Bild und Ton werden um die tatsächliche Latenz ausgeglichen.': 'Requested value for the system. Larger is more stable, smaller responds faster. Picture and sound are aligned by the actual latency.',
  'Lautsprecher': 'Speakers',
  'Anzahl der Ausgangskanäle. Das Gerät bietet {0} Kanäle, die App nutzt bis zu {1}.': 'Number of output channels. The device offers {0} channels; the app uses up to {1}.',
  'Tatsächlich': 'Actual',
  '{0} kHz · {1} ms Latenz': '{0} kHz · {1} ms latency',
  'Kanäle und Pegel': 'Channels and levels',
  'Quelle': 'Source',
  'Pegel': 'Level',
  'Quelle {0}': 'Source {0}',
  'Quelle {0} (L)': 'Source {0} (L)',
  'Quelle {0} (R)': 'Source {0} (R)',
  'Summe (Mono)': 'Sum (mono)',
  'Ton an': 'Unmute',
  'Stumm': 'Mute',
  'Pegelanzeige nach Gesamt- und Einzelpegel': 'Meters show the level after master and channel gain',
  'Zurücksetzen': 'Reset',
  'Startet …': 'Starting …',
  '{0} Kanäle': '{0} channels',
  'Nr.': 'No.', 'Ausgangskanal am Audiogerät': 'Output channel on the audio device', 'Kanal des Videos. Mono mischt alle Kanäle.': 'Channel of the video. Mono mixes all channels.', 'Mono': 'Mono',
  'Quelle für Ausgang {0}': 'Source for output {0}',
};

// Muster mit Namen statt Zahlen
const PATTERNS = [
  [/^Bildmitte für (.+) gesetzt$/, (m) => `Image center set for ${tr(m[1])}`],
  [/^(.+) und (.+) haben die Bildschirme getauscht\.$/, (m) => `${m[1]} and ${m[2]} swapped displays.`],
  [/^Bildschirm für (.+)$/, (m) => `Display for ${m[1]}`],
  [/^(.+): nur (\d+) Felder für (\d+) Projektoren\. Überzählige teilen sich ein Feld\.$/, (m) => `${tr(m[1])}: only ${m[2]} cells for ${m[3]} projectors. Extra ones share a cell.`],
  [/^(.+): Projektoren auf (.+) verteilt\.$/, (m) => `${m[1]}: projectors arranged as ${tr(m[2])}.`],
  [/^Ungefähr dorthin klicken, wo die Mitte des Bildes von (.+) liegt\.$/, (m) => `Click roughly where the center of the image of ${tr(m[1])} is.`],
  [/^Am besten weit außen im Bild von (.+) beginnen\.$/, (m) => `Best start far out in the image of ${tr(m[1])}.`],
  [/^Mit (.+) beginnen$/, (m) => `Start with ${tr(m[1])}`],
  [/^Zuletzt (.+) um (.+)$/, (m) => `Last: ${tr(m[1])} at ${m[2]}`],
  [/^Fehler: (.+)$/, (m) => `Error: ${m[1]}`],
  [/^Modell konnte nicht geladen werden: (.+)$/, (m) => `Model could not be loaded: ${m[1]}`],
  [/^Export fertig: (\d+) Projektor\(en\) → (.+)$/, (m) => `Export finished: ${m[1]} projector(s) → ${m[2]}`],
  [/^Punkt (\S+) passt schlecht \((.+) px\) – evtl\. falsch zugeordnet\?$/, (m) => `Point ${m[1]} fits poorly (${m[2]} px) – possibly mismatched?`],
  [/^Bildrate je Ausgang: (.+)$/, (m) => `Frame rate per output: ${tr(m[1])}`],
  [/^(.+) · (\d+) Kanäle · (.+) kHz · (\d+) ms$/, (m) => `${tr(m[1])} · ${m[2]} channels · ${m[3]} kHz · ${m[4]} ms`],
  [/^Ausgang (.+)$/, (m) => `Output ${m[1]}`],
];

const NUM = /\d+(?:[.,]\d+)?/g;

/** Text in der eingestellten Sprache. */
export function tr(s) {
  if (lang === 'de' || typeof s !== 'string' || !s) return s;
  const hit = EN[s];
  if (hit !== undefined) return hit;
  if (s.includes(' · ')) return s.split(' · ').map(tr).join(' · ');
  const nums = [];
  const key = s.replace(NUM, (n) => `{${nums.push(n) - 1}}`);
  if (nums.length && EN[key] !== undefined) return EN[key].replace(/\{(\d+)\}/g, (_, i) => nums[i]);
  for (const [re, fn] of PATTERNS) { const m = s.match(re); if (m) return fn(m); }
  return s;
}

/**
 * Statisches HTML übersetzen (Texte und Attribute). Der erste Aufruf merkt sich die Knoten mit ihrem
 * deutschen Original; spätere Aufrufe übersetzen nur diese. Dynamisch erzeugte Teile baut die App neu.
 */
const registry = new WeakMap();
export function translateDom(root) {
  let reg = registry.get(root);
  if (!reg) {
    reg = { texts: [], attrs: [] };
    const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim()) reg.texts.push([n, n.nodeValue]);
    for (const e of root.querySelectorAll('[data-tip],[aria-label],[title],[placeholder]'))
      for (const a of ['data-tip', 'aria-label', 'title', 'placeholder']) if (e.hasAttribute(a)) reg.attrs.push([e, a, e.getAttribute(a)]);
    registry.set(root, reg);
  }
  for (const [n, orig] of reg.texts) {
    if (!n.isConnected) continue;
    const lead = orig.match(/^\s*/)[0], trail = orig.match(/\s*$/)[0];
    n.nodeValue = lead + tr(orig.trim()) + trail;
  }
  for (const [e, a, orig] of reg.attrs) if (e.isConnected) e.setAttribute(a, tr(orig));
}
