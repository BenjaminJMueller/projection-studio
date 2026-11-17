import test from 'node:test';
import assert from 'node:assert/strict';
import { solveProjector, projectPoint, cameraCenter } from '../src/core/solver.js';
import { getLensPreset } from '../src/core/lenses.js';
import { absoluteOrientation, rodrigues, matVec3, sub3, norm3, normalize3, cross3, scale3 } from '../src/core/linalg.js';
import { loadObjVertices, rng, gauss } from './helpers.js';

const verts = loadObjVertices(new URL('../examples/Gewoelbedecke_mit_Wandstreifen_16k.obj', import.meta.url));
const lens = getLensPreset('epson-eb535w-1080p');
const W = 1920, H = 1080;

function lookAtCam(C, target, up, f, cx, cy, mirror = false) {
  // OpenCV: z vorwärts, y nach unten
  const z = normalize3(sub3(target, C));
  const x = normalize3(cross3(z, up)); // rechts
  const y = cross3(z, x); // unten
  const R = [x, y, z];
  const t = scale3(matVec3(R, C), -1);
  return { R, t, f, cx, cy, mirror };
}

function visiblePoints(cam) {
  const out = [];
  for (const X of verts) {
    const p = projectPoint(cam, X);
    if (p.z > 0 && p.u > 20 && p.u < W - 20 && p.v > 20 && p.v < H - 20) out.push({ world: X, uv: [p.u, p.v] });
  }
  return out;
}

function makeScenario(seed, { clustered = false, n = 6, noise = 1.5, flipped = false } = {}) {
  const r = rng(seed);
  // virtueller Projektor unterhalb, schräg nach oben auf das Gewölbe
  const C = [-1 + 4 * r(), -1.5 - 1.5 * r(), -4 + 4 * r()];
  const target = [C[0] + (r() - 0.5) * 2, 1.8, C[2] + (r() - 0.5) * 2 + 1.0];
  const cy = flipped ? (1 - lens.cyFrac) * H : lens.cyFrac * H;
  const cam = lookAtCam(C, target, flipped ? [0, -1, 0.1] : [0, 1, 0.1], 0.5 * W, W / 2 + 10, cy);
  const vis = visiblePoints(cam);
  if (vis.length < 50) return null;
  let chosen;
  if (clustered) {
    // alle Punkte in einem Bildausschnitt von ca. 35 % der Breite
    const c0 = vis[Math.floor(r() * vis.length)].uv;
    const near = vis.filter((p) => Math.abs(p.uv[0] - c0[0]) < 0.18 * W && Math.abs(p.uv[1] - c0[1]) < 0.18 * H);
    if (near.length < n) return null;
    chosen = Array.from({ length: n }, () => near[Math.floor(r() * near.length)]);
  } else {
    chosen = Array.from({ length: n }, () => vis[Math.floor(r() * vis.length)]);
  }
  const points = chosen.map((p, i) => ({ id: i + 1, world: p.world, image: [p.uv[0] + noise * gauss(r), p.uv[1] + noise * gauss(r)] }));
  return { cam, center: C, points };
}

test('Horn absolute orientation recovers rotation', () => {
  const R = rodrigues([0.3, -0.5, 1.1]);
  const d = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 2, 3]].map(normalize3);
  const b = d.map((x) => matVec3(R, x));
  const R2 = absoluteOrientation(d, b);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(R[i][j] - R2[i][j]) < 1e-9);
});

function runMany(label, opts, minSuccessRate) {
  test(label, () => {
    let ok = 0, total = 0, worst = 0;
    const times = [];
    const maxes = [];
    for (let seed = 1; total < 30 && seed < 400; seed++) {
      const sc = makeScenario(seed, opts);
      if (!sc) continue;
      total++;
      let centerHint = null;
      if (opts.hint) {
        // Modellpunkt nahe der Bildmitte suchen (so wie ein Nutzer ihn anklicken würde)
        let bd = 1e9;
        for (const X of verts) { const q = projectPoint(sc.cam, X); const d = Math.hypot(q.u - W / 2, q.v - H / 2); if (q.z > 0 && d < bd) { bd = d; centerHint = { world: X }; } }
      }
      const res = solveProjector({ points: sc.points, width: W, height: H, lens, centerHint });
      times.push(res.solution?.solveMs ?? 0);
      if (!res.ok) continue;
      const err = norm3(sub3(res.solution.center, sc.center));
      // Reprojektion eines Bildgitters vergleichen (das, was am Ende zählt)
      let maxPx = 0;
      for (const X of verts.filter((_, i) => i % 50 === 0)) {
        const a = projectPoint(sc.cam, X);
        if (!(a.z > 0 && a.u > 0 && a.u < W && a.v > 0 && a.v < H)) continue;
        const b = projectPoint(res.solution, X);
        maxPx = Math.max(maxPx, Math.hypot(a.u - b.u, a.v - b.v));
      }
      maxes.push(maxPx);
      if (maxPx < 60) ok++; // "kein Kippen": Gesamtbild bleibt nah an der Wahrheit
      worst = Math.max(worst, err);
    }
    const rate = ok / total;
    maxes.sort((a, b) => a - b);
    console.log(`${label}: ${ok}/${total} ok, max-Abweichung im Bild median ${maxes[maxes.length >> 1].toFixed(1)} px, 90% ${maxes[Math.floor(maxes.length * 0.9)].toFixed(1)} px, median solve ${times.sort((a, b) => a - b)[times.length >> 1]} ms`);
    assert.ok(rate >= minSuccessRate, `success rate ${rate}`);
  });
}

runMany('6 verteilte Punkte, 1.5px Rauschen', { n: 6 }, 0.9);
runMany('5 verteilte Punkte', { n: 5 }, 0.85);
runMany('6 eng beieinander liegende Punkte (camSchnappr-Problemfall)', { n: 6, clustered: true }, 0.6);
runMany('6 eng liegende Punkte + Bildmitte im Modell angeklickt', { n: 6, clustered: true, hint: true }, 0.75);
runMany('8 Punkte, Beamer kopfüber montiert', { n: 8, flipped: true }, 0.9);

export function debugScenario(seed, opts) {
  const sc = makeScenario(seed, opts);
  if (!sc) return null;
  const res = solveProjector({ points: sc.points, width: W, height: H, lens });
  return { sc, res };
}
