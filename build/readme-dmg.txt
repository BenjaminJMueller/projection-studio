PROJECTION STUDIO – ERSTER START AUF DEM MAC
============================================

Die App ist nicht bei Apple beglaubigt (das kostet eine kostenpflichtige
Entwickler-Mitgliedschaft). macOS blockiert sie deshalb beim ersten Start.
Sie ist trotzdem unverändert und sicher, wenn sie von der GitHub-Seite des
Projekts stammt.

1. „Projection Studio“ auf den Ordner „Programme“ ziehen.
2. Die App im Ordner „Programme“ per Doppelklick öffnen.
   macOS meldet, dass die App nicht geöffnet werden kann. „Fertig“ klicken.
3. macOS 15 (Sequoia) und neuer:
   Apfel-Menü → Systemeinstellungen → Datenschutz & Sicherheit,
   ganz nach unten scrollen, bei „Projection Studio“ auf „Dennoch öffnen“
   klicken, mit dem Passwort bestätigen und noch einmal „Öffnen“.
   macOS 14 und älter:
   Rechtsklick (oder ctrl-Klick) auf die App → „Öffnen“ → „Öffnen“.

Das ist nur beim ersten Start nötig.

Alternative per Terminal (Programme → Dienstprogramme → Terminal),
diese Zeile einfügen und Return drücken:

  xattr -dr com.apple.quarantine "/Applications/Projection Studio.app"

Danach startet die App normal per Doppelklick.

Warum kein Skript zum Doppelklicken? Ein Skript aus dieser Datei würde von
macOS genauso blockiert wie die App selbst. Die Terminal-Zeile oben ist der
zuverlässige Weg.


PROJECTION STUDIO – FIRST LAUNCH ON A MAC
=========================================

The app is not notarised by Apple (that requires a paid developer
membership), so macOS blocks it on first launch. It is unchanged and safe
when downloaded from the project's GitHub page.

1. Drag "Projection Studio" onto the "Applications" folder.
2. Double-click the app in "Applications".
   macOS says the app cannot be opened. Click "Done".
3. macOS 15 (Sequoia) and later:
   Apple menu → System Settings → Privacy & Security, scroll to the
   bottom, click "Open Anyway" next to "Projection Studio", confirm with
   your password and click "Open" again.
   macOS 14 and earlier:
   right-click (or control-click) the app → "Open" → "Open".

This is only needed on first launch.

Terminal alternative (Applications → Utilities → Terminal), paste this
line and press Return:

  xattr -dr com.apple.quarantine "/Applications/Projection Studio.app"

After that the app starts normally with a double-click.

Why no double-click script? A script from this disk image would be blocked
by macOS just like the app itself. The Terminal line above is the reliable
way.
