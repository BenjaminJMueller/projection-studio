import test from 'node:test';
import assert from 'node:assert/strict';
import { tr, setLang } from '../src/shared/i18n.js';

test('Deutsch bleibt unverändert, Englisch wird nachgeschlagen', () => {
  setLang('de');
  assert.equal(tr('Kalibrieren'), 'Kalibrieren');
  setLang('en');
  assert.equal(tr('Kalibrieren'), 'Calibrate');
  assert.equal(tr('5 von 8 kalibriert'), '5 of 8 calibrated');
  assert.equal(tr('HDMI A · oben links'), 'HDMI A · top left');
  assert.equal(tr('Bildschirm für HDMI B'), 'Display for HDMI B');
  assert.equal(tr('Unbekannter Text bleibt'), 'Unbekannter Text bleibt');
  setLang('de');
});

import { newProject, setConnection, connectionOf } from '../src/shared/project.js';
test('Anschluss direkt: je Ausgang ein Projektor, höchstens 4 Ausgänge', () => {
  const p = newProject();
  assert.equal(connectionOf(p), 'controller');
  const without = setConnection(p, 'direct');
  assert.equal(without, 4);
  assert.equal(connectionOf(p), 'direct');
  assert.deepEqual(p.outputs.filter((o) => !o.solo).map((o) => o.id), ['A', 'B', 'C', 'D']);
  assert.deepEqual(p.projectors.map((x) => x.output), ['A', 'B', 'C', 'D', '', '', '', '']);
  p.projectors.forEach((x, i) => { x.enabled = i < 3; });
  setConnection(p, 'direct');
  assert.equal(p.outputs.filter((o) => !o.solo).length, 3);
  p.projectors.forEach((x) => { x.enabled = true; });
  assert.equal(setConnection(p, 'controller'), 0);
  assert.deepEqual(p.projectors.map((x) => `${x.output}${x.quadrant}`), ['A0', 'A1', 'A2', 'A3', 'B0', 'B1', 'B2', 'B3']);
  assert.ok(p.outputs.some((o) => o.solo));
});

test('Neue Texte: Zuordnung, Drehen, Maus', () => {
  setLang('en');
  assert.equal(tr('P3 → HDMI A · oben rechts'), 'P3 → HDMI A · top right');
  assert.equal(tr('P3 → HDMI A · oben rechts · P2 tauscht den Platz'), 'P3 → HDMI A · top right · P2 swaps places');
  assert.equal(tr('HDMI B · unten links: frei'), 'HDMI B · bottom left: free');
  assert.equal(tr('90° rechts'), '90° clockwise');
  assert.equal(tr('90° links'), '90° counterclockwise');
  assert.equal(tr('Drehen'), 'Rotate');
  setLang('de');
});

test('Bildmodus-Hinweis mit Zahlen', () => {
  setLang('en');
  assert.match(tr('So wie im Menü des Projektors unter Seitenverhältnis eingestellt. Panel 1280 × 800, Signal 1920 × 1080. Bei Zoom und Nativ schneidet der Projektor einen Teil des Signals ab, das berücksichtigen Kalibrierung und Überblendung. „Voll“ (gestreckt) wird nicht unterstützt.'), /^As set in the projector menu.*Panel 1280 × 800, signal 1920 × 1080/);
  assert.equal(tr('± 25 cm'), '± 25 cm');
  setLang('de');
});

test('Neue Texte: Kamera ohne Bezugsprojektor', () => {
  setLang('en');
  assert.equal(tr('Projektor 2 (kalibriert)'), 'Projector 2 (calibrated)');
  assert.equal(tr('4 grobe Punkte abgewählt'), '4 rough points deselected');
  assert.equal(tr('Kamera und Projektor passen nicht gut zusammen (1,8 px). Stand die Kamera fest? Sonst die groben Punkte prüfen.'), 'Camera and projector do not fit together well (1,8 px). Was the camera fixed? Otherwise check the rough points.');
  assert.equal(tr('Grobe Punkte dieses Projektors'), 'Rough points of this projector');
  setLang('de');
});
