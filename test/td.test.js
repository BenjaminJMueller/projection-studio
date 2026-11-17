import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportProjector } from '../src/core/export.js';
import { rodrigues } from '../src/core/linalg.js';

for (const mirror of [false, true]) {
  for (const [sx, sy, sc] of [[1, 1, 2], [-1, 1, 2], [1, -1, 1], [-1, -1, 2]]) {
    test(`TD-Skript stellt Kamera exakt ein (mirror=${mirror}, Fenster-Konvention ${sx},${sy},${sc})`, () => {
      const sol = { R: rodrigues([1.9, 0.3, -0.2]), t: [0.4, -1.1, 3.5], f: 930, cx: 972, cy: 1281, mirror, width: 1920, height: 1080, center: [0.5, -2, -3], throwRatio: 0.48, rms: 0.5, pointCount: 7, sigmaCenter: 0.01 };
      const pj = exportProjector({ id: 'P1', name: 'P1', tdCamera: 'Kamera_P1', solution: sol });
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'td-')), 'pj.json');
      fs.writeFileSync(f, JSON.stringify(pj));
      const out = JSON.parse(execFileSync('python3', ['test/td_mock.py', f, String(sx), String(sy), String(sc)]).toString());
      assert.ok(out.perr < 1e-6, `Projektion weicht ab: ${out.perr}`);
      assert.ok(out.terr < 1e-6, `Transform weicht ab: ${out.terr}`);
    });
  }
}
