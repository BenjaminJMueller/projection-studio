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
