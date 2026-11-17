import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPoint } from '../src/core/solver.js';
import { viewMatrixGL, projectionMatrixGL, cameraWorldMatrix, toTouchDesigner } from '../src/core/export.js';
import { rodrigues } from '../src/core/linalg.js';

const mul = (A, v) => A.map((r) => r.reduce((s, x, i) => s + x * v[i], 0));
const mm = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, x, k) => s + x * B[k][j], 0)));
const rad = (d) => (d * Math.PI) / 180;
function rotXYZ(rx, ry, rz) {
  const [a, b, c] = [rad(rx), rad(ry), rad(rz)];
  const Rx = [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = [[Math.cos(b), 0, Math.sin(b)], [0, 1, 0], [-Math.sin(b), 0, Math.cos(b)]];
  const Rz = [[Math.cos(c), -Math.sin(c), 0], [Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  return mm(Rz, mm(Ry, Rx));
}

for (const mirror of [false, true]) {
  test(`GL-Matrizen und TD-Parameter stimmen mit dem Solver-Modell überein (mirror=${mirror})`, () => {
    const sol = { R: rodrigues([0.4, -1.2, 0.3]), t: [0.3, -1, 4], f: 930, cx: 975, cy: 1281, mirror, width: 1920, height: 1080, center: [0, 0, 0] };
    const V = viewMatrixGL(sol), P = projectionMatrixGL(sol, 0.1, 100);
    for (const X of [[0.2, 0.5, 1], [-1, 2, 0.5], [1.5, -0.3, 2]]) {
      const pr = projectPoint(sol, X);
      const clip = mul(P, mul(V, [...X, 1]));
      const u = ((clip[0] / clip[3] + 1) / 2) * 1920;
      const v = ((1 - clip[1] / clip[3]) / 2) * 1080;
      assert.ok(Math.abs(u - pr.u) < 1e-6 && Math.abs(v - pr.v) < 1e-6, `${u},${v} vs ${pr.u},${pr.v}`);
    }
    // TD-Transform aus Euler + Skalierung rekonstruieren: M = T * R * S
    const td = toTouchDesigner(sol);
    const R = rotXYZ(td.rx, td.ry, td.rz);
    const M = cameraWorldMatrix(sol);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) assert.ok(Math.abs(R[i][j] * (j === 0 ? td.sx : 1) - M[i][j]) < 1e-9);
    }
    assert.ok(Math.abs(td.tx - M[0][3]) < 1e-12);
  });
}
