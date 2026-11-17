import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, pickFile } from '../src/shared/version.js';

test('Versionsvergleich', () => {
  assert.ok(isNewer('1.0.12', '1.0.9'));
  assert.ok(isNewer('v1.1.0', '1.0.99'));
  assert.ok(!isNewer('1.0.9', '1.0.9'));
  assert.ok(!isNewer('1.0.8', '1.0.9'));
  assert.ok(isNewer('2.0.0', '1.9.9-beta'));
});

test('Update-Datei wird nur mit gültigem Namen und Prüfsumme angenommen', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(pickFile({ files: { mac: { name: 'Projection-Studio-mac.zip', sha256: sha } } }, 'mac'), { name: 'Projection-Studio-mac.zip', sha256: sha });
  assert.equal(pickFile({ files: { mac: { name: '../evil.zip', sha256: sha } } }, 'mac'), null);
  assert.equal(pickFile({ files: { mac: { name: 'x.zip', sha256: 'kurz' } } }, 'mac'), null);
  assert.equal(pickFile({ files: {} }, 'win'), null);
});
