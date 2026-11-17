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
