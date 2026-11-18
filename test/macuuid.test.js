import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { patchFile } = createRequire(import.meta.url)('../scripts/mac-afterpack.cjs');

/** Kleines 64-Bit-Mach-O: Kopf, ein Segment-Befehl als Füller, LC_UUID. */
function thin(cputype, uuidByte) {
  const b = Buffer.alloc(32 + 24 + 24);
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cputype, 4); b.writeUInt32LE(2, 16); b.writeUInt32LE(48, 20);
  b.writeUInt32LE(0x19, 32); b.writeUInt32LE(24, 36); // Füller
  b.writeUInt32LE(0x1b, 56); b.writeUInt32LE(24, 60); b.fill(uuidByte, 64, 80);
  return b;
}

test('Mach-O-UUID wird ersetzt, schlank und universal, bei jedem Bau gleich', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uuid-'));
  const a = thin(0x0100000c, 0xaa), x = thin(0x01000007, 0xaa);
  // universal: Kopf + 2 Einträge, Teile ab 4096 und 8192
  const fat = Buffer.alloc(8192 + x.length);
  fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4);
  [[0x01000007, 4096, x], [0x0100000c, 8192, a]].forEach(([cpu, off, s], i) => { const e = 8 + i * 20; fat.writeUInt32BE(cpu, e); fat.writeUInt32BE(off, e + 8); fat.writeUInt32BE(s.length, e + 12); s.copy(fat, off); });
  const f1 = path.join(dir, 'thin'), f2 = path.join(dir, 'fat');
  fs.writeFileSync(f1, a); fs.writeFileSync(f2, fat);
  const r1 = patchFile(f1, 'de.app|Prog');
  assert.equal(r1.length, 1);
  assert.notEqual(r1[0][1].toString('hex'), 'aa'.repeat(16));
  assert.equal(r1[0][1][6] >> 4, 8);
  const r2 = patchFile(f2, 'de.app|Prog');
  assert.equal(r2.length, 2);
  assert.notEqual(r2[0][1].toString('hex'), r2[1][1].toString('hex')); // je CPU eine eigene
  assert.equal(r2[1][1].toString('hex'), r1[0][1].toString('hex')); // gleiche CPU, gleicher Name: gleiche UUID
  // nochmal: gleiches Ergebnis (idempotent)
  const again = patchFile(f2, 'de.app|Prog');
  assert.equal(again[0][0].toString('hex'), again[0][1].toString('hex'));
  // anderer Programmname: andere UUID
  fs.writeFileSync(f1, a);
  assert.notEqual(patchFile(f1, 'de.app|Helper')[0][1].toString('hex'), r1[0][1].toString('hex'));
  fs.rmSync(dir, { recursive: true, force: true });
});
