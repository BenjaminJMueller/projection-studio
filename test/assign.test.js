import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, assignCell, imageToScreen, quadrantRect } from '../src/shared/project.js';

const at = (p) => p.projectors.map((x) => `${x.output}${x.quadrant}`);

test('Feld zuordnen: freies Feld und Tausch mit dem bisherigen Projektor', () => {
  const p = newProject();
  // P1 (A0) auf B3: P8 bekommt A0
  const other = assignCell(p, 'P1', 'B', 3);
  assert.equal(other.id, 'P8');
  assert.deepEqual(at(p), ['B3', 'A1', 'A2', 'A3', 'B0', 'B1', 'B2', 'A0']);
  // gleiches Feld: nichts passiert
  assert.equal(assignCell(p, 'P1', 'B', 3), null);
  assert.deepEqual(at(p), ['B3', 'A1', 'A2', 'A3', 'B0', 'B1', 'B2', 'A0']);
  // Projektor ohne Ausgang verdrängt: der andere ist danach ohne Ausgang
  p.projectors[1].output = '';
  const o2 = assignCell(p, 'P2', 'A', 2);
  assert.equal(o2.id, 'P3');
  assert.equal(p.projectors[2].output, '');
  // Testausgang und unbekannte Ausgänge werden ignoriert
  assert.equal(assignCell(p, 'P1', 'T', 0), null);
  assert.equal(p.projectors[0].output, 'B');
});

test('Bildpunkt -> Bildschirmposition im richtigen Quadranten', () => {
  const p = newProject();
  const o = p.outputs[0]; // 2 x 2
  const bounds = { x: 1920, y: 0, width: 3840, height: 2160 };
  // Mitte von "unten rechts"
  assert.deepEqual(imageToScreen(bounds, quadrantRect(o, 3), 960, 540, 1920, 1080), { x: 1920 + 2880, y: 1620 });
  // Ecke oben links von "oben rechts", Werte außerhalb werden begrenzt
  assert.deepEqual(imageToScreen(bounds, quadrantRect(o, 1), -50, -50, 1920, 1080), { x: 1920 + 1920, y: 0 });
  // Bildschirm mit Skalierung (Punkte statt Pixel)
  assert.deepEqual(imageToScreen({ x: 0, y: 0, width: 1920, height: 1080 }, quadrantRect(o, 0), 1920, 1080, 1920, 1080), { x: 960, y: 540 });
});
