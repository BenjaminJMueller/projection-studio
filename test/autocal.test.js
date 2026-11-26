import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRaycaster, cameraFromReference, projectorPoints, robustSolve, cameraLens, coverageReport, jointSolve, selfCalibrate } from '../src/core/autocal.js';
import { patternPlan, patternValue, GrayDecoder, filterCells, thinCells } from '../src/shared/graycode.js';
import { projectPoint, cameraCenter, pixelRay, solveProjector } from '../src/core/solver.js';
import { getLensPreset } from '../src/core/lenses.js';
import { sub3, norm3, normalize3, cross3, scale3, matVec3 } from '../src/core/linalg.js';

// Gewölbedecke als Dreiecke laden
function loadObj(path) {
  const v = [], f = [];
  for (const l of fs.readFileSync(path, 'utf8').split('\n')) {
    if (l.startsWith('v ')) v.push(l.trim().split(/\s+/).slice(1, 4).map(Number));
    else if (l.startsWith('f ')) {
      const ix = l.trim().split(/\s+/).slice(1).map((s) => Number(s.split('/')[0]) - 1);
      for (let k = 1; k + 1 < ix.length; k++) f.push(ix[0], ix[k], ix[k + 1]);
    }
  }
  return { positions: Float32Array.from(v.flat()), index: Uint32Array.from(f), verts: v };
}
const mesh = loadObj(new URL('../examples/Gewoelbedecke_mit_Wandstreifen_16k.obj', import.meta.url));
const intersect = buildRaycaster(mesh.positions, mesh.index);

function lookAt(C, target, up, f, cx, cy, mirror = false) {
  const z = normalize3(sub3(target, C));
  const x = normalize3(cross3(z, up));
  const y = cross3(z, x);
  const R = [x, y, z];
  return { R, t: scale3(matVec3(R, C), -1), f, cx, cy, mirror };
}

const lens = getLensPreset('epson-eb535w-1080p');
const PW = 1920, PH = 1080;
const proj = (C, T, mirror = false) => lookAt(C, T, [0, 1, 0.1], 0.5 * PW, PW / 2, lens.cyFrac * PH, mirror);
const CW = 480, CH = 270;

// Für jedes Kamerapixel (2×2 Unterabtastung): welches Projektorpixel beleuchtet die gesehene Stelle?
function lightMap(cam, pr) {
  const S = 2, map = new Float32Array(CW * CH * S * S * 2).fill(-1);
  const C = cameraCenter(cam.R, cam.t), Cp = cameraCenter(pr.R, pr.t);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) for (let s = 0; s < S * S; s++) {
    const hit = intersect(C, pixelRay(cam, x + ((s % S) + 0.5) / S, y + (Math.floor(s / S) + 0.5) / S));
    if (!hit) continue;
    const q = projectPoint(pr, hit.point);
    if (q.z <= 0 || q.u < 0 || q.v < 0 || q.u >= PW || q.v >= PH) continue;
    // verdeckt? Der Projektorstrahl muss diese Stelle zuerst treffen.
    const d = sub3(hit.point, Cp), dist = norm3(d);
    const h2 = intersect(Cp, scale3(d, 1 / dist));
    if (!h2 || Math.abs(h2.t - dist) > 1e-3 * dist + 1e-4) continue;
    const k = ((y * CW + x) * S * S + s) * 2;
    map[k] = q.u; map[k + 1] = q.v;
  }
  return map;
}
function capture(map, f, shift, seed) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5);
  const img = new Uint8Array(CW * CH);
  for (let i = 0; i < CW * CH; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) { const u = map[(i * 4 + k) * 2]; if (u >= 0) s += patternValue(f, Math.floor(u), Math.floor(map[(i * 4 + k) * 2 + 1]), shift); }
    img[i] = Math.max(0, Math.min(255, Math.round(15 + 190 * (s / 4) + 1.5 * rnd())));
  }
  return img;
}
function decode(map, shift, seed) {
  const plan = patternPlan(PW, PH, shift);
  const dec = new GrayDecoder(CW, CH, plan);
  plan.frames.forEach((f, i) => dec.add(f, capture(map, f, shift, seed + i)));
  return dec;
}

test('Raycaster trifft das Modell wie die Projektion erwartet', () => {
  const pr = proj([1, -2, -3], [1, 1.8, -2]);
  const C = cameraCenter(pr.R, pr.t);
  let ok = 0, n = 0;
  for (const X of mesh.verts.filter((_, i) => i % 97 === 0)) {
    const q = projectPoint(pr, X);
    if (q.z <= 0 || q.u < 0 || q.u >= PW || q.v < 0 || q.v >= PH) continue;
    n++;
    const h = intersect(C, pixelRay(pr, q.u, q.v));
    if (h && norm3(sub3(h.point, X)) < 0.02) ok++;
  }
  assert.ok(n > 20 && ok / n > 0.8, `${ok}/${n}`);
});

test('Kamera-Kalibrierung: Bezugsprojektor → Kamera → zweiter Projektor (Teilabdeckung)', { timeout: 120000 }, () => {
  const ref = proj([0.5, -2.2, -3.2], [0.8, 1.8, -2.2]);
  const truth = proj([2.6, -2.0, -2.4], [3.0, 1.8, -1.2], true); // über Spiegel: seitenverkehrt
  const fCam = CW / (2 * Math.tan((67 * Math.PI) / 360));
  const cam = lookAt([0.7, -0.3, -3.2], [0.7, 2.0, -4.2], [0, 1, 0.1], fCam, CW / 2 + 3, CH / 2 - 2);

  // 1) Kamera-Standort über den Bezugsprojektor
  const shift = 3;
  const dRef = decode(lightMap(cam, ref), shift, 11);
  const cRef = thinCells(filterCells(dRef.cells(dRef.assess().drop)), PW, PH, 250);
  assert.ok(dRef.assess().sharp > 0.6, `Schärfe ${dRef.assess().sharp}`);
  assert.ok(cRef.length > 40, `Bezug: ${cRef.length} Zellen`);
  const camRes = cameraFromReference(cRef, ref, intersect, CW, CH, { lens: cameraLens(67) });
  assert.ok(camRes.ok, camRes.message);
  const dC = norm3(sub3(camRes.solution.center, cameraCenter(cam.R, cam.t)));
  assert.ok(dC < 0.05, `Kamera-Position um ${dC.toFixed(3)} m daneben`);

  // 2) Zielprojektor: Zellen → 3D-Punkte → Solver
  const dT = decode(lightMap(cam, truth), shift, 99);
  const cT = thinCells(filterCells(dT.cells(dT.assess().drop)), PW, PH, 300);
  const pts = projectorPoints(cT, camRes.solution, intersect);
  assert.ok(pts.length > 40, `Ziel: ${pts.length} Punkte`);
  const rep = coverageReport(pts.map((p) => p.image), PW, PH);
  assert.ok(rep.filled < 1, 'Kamera sieht in diesem Test nicht das ganze Bild');
  const res = robustSolve({ points: pts, width: PW, height: PH, lens, pixelSigma: 1 });
  assert.ok(res.ok, res.message);
  assert.equal(res.solution.mirror, true);
  // Genauigkeit über das ganze Projektorbild (auch Bereiche, die die Kamera nicht sah)
  let se = 0, n = 0, worst = 0;
  for (const X of mesh.verts.filter((_, i) => i % 13 === 0)) {
    const a = projectPoint(truth, X);
    if (a.z <= 0 || a.u < 0 || a.u >= PW || a.v < 0 || a.v >= PH) continue;
    const b = projectPoint(res.solution, X);
    const e = Math.hypot(a.u - b.u, a.v - b.v);
    se += e * e; n++; worst = Math.max(worst, e);
  }
  const rms = Math.sqrt(se / n);
  console.log(`Kamera ${dC.toFixed(3)} m, ${pts.length} Punkte, Abdeckung ${(rep.filled * 100).toFixed(0)} %, Fehler im Bild rms ${rms.toFixed(2)} px, max ${worst.toFixed(1)} px`);
  assert.ok(rms < 4 && worst < 12, `rms ${rms}, max ${worst}`);
});

// Fehler einer Lösung über das ganze Projektorbild (an Modellecken, die der echte Projektor trifft)
function imageError(truth, sol) {
  let se = 0, n = 0, worst = 0;
  for (const X of mesh.verts.filter((_, i) => i % 13 === 0)) {
    const a = projectPoint(truth, X);
    if (a.z <= 0 || a.u < 0 || a.u >= PW || a.v < 0 || a.v >= PH) continue;
    const b = projectPoint(sol, X);
    const e = Math.hypot(a.u - b.u, a.v - b.v);
    se += e * e; n++; worst = Math.max(worst, e);
  }
  return { rms: Math.sqrt(se / n), worst };
}

for (const mirror of [false, true]) test(`Erster Projektor${mirror ? ' (über Spiegel)' : ''}: 4 grobe Punkte + Kamera an 3 Standorten, ohne Bezugsprojektor`, { timeout: 180000 }, () => {
  const truth = proj([0.5, -2.2, -3.2], [0.8, 1.8, -2.2], mirror);
  const fCam = CW / (2 * Math.tan((67 * Math.PI) / 360));
  // Kamera zu schmal für das ganze Bild: drei Standorte, jeder sieht einen Teil
  const cams = [[[0.7, -0.3, -3.2], [0.7, 2.0, -4.2]], [[0.5, -0.3, -3.0], [-1.6, 1.8, -3.4]], [[0.8, -0.3, -3.2], [2.6, 1.6, -5.0]]]
    .map(([C, T]) => lookAt(C, T, [0, 1, 0.1], fCam, CW / 2 + 3, CH / 2 - 2));
  const sessions = cams.map((c, k) => {
    const d = decode(lightMap(c, truth), 3, 11 + 50 * k);
    return { cells: thinCells(filterCells(d.cells(d.assess().drop)), PW, PH, 300), camW: CW, camH: CH };
  });
  // 4 grobe Punkte an Modellecken, bis zu ±30 px daneben geklickt
  let r = 7;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5);
  const vis = mesh.verts.filter((X) => { const q = projectPoint(truth, X); return q.z > 0 && q.u > 0 && q.u < PW && q.v > 0 && q.v < PH; });
  const near = (u, v) => vis.reduce((b, X) => { const q = projectPoint(truth, X); const d = Math.hypot(q.u - u, q.v - v); return d < b.d ? { d, X } : b; }, { d: Infinity }).X;
  const manual = [[200, 150], [1700, 150], [1700, 950], [200, 950]].map(([u, v]) => {
    const X = near(u, v), q = projectPoint(truth, X);
    return { world: X, image: [q.u + 60 * rnd(), q.v + 60 * rnd()] };
  });
  const rough = solveProjector({ points: manual, width: PW, height: PH, lens, pixelSigma: 30 });
  assert.ok(rough.ok);
  const e0 = imageError(truth, rough.solution);
  assert.ok(e0.rms > 10, `grob ${e0.rms}`);

  // nur ein Standort: schon deutlich besser als von Hand
  const one = jointSolve({ start: rough.solution, sessions: sessions.slice(0, 1), width: PW, height: PH, lens, camLens: cameraLens(67), manual }, intersect);
  assert.ok(one.ok, one.message);
  const e1 = imageError(truth, one.projector);

  const all = selfCalibrate({ start: rough.solution, sessions, width: PW, height: PH, lens, camLens: cameraLens(67), manual }, intersect);
  assert.ok(all.ok, all.message);
  const e3 = imageError(truth, all.solution);
  const dC = norm3(sub3(all.solution.center, cameraCenter(truth.R, truth.t)));
  console.log(`grob ${e0.rms.toFixed(1)} px → 1 Standort ${e1.rms.toFixed(2)} px → 3 Standorte ${e3.rms.toFixed(2)} px (max ${e3.worst.toFixed(1)}), Position ${(dC * 100).toFixed(1)} cm, Kamera ${all.joint.camRms.toFixed(2)} px, ${all.joint.ms} ms`);
  assert.ok(e1.rms < e0.rms / 2, `1 Standort ${e1.rms}`);
  assert.ok(e3.rms < 1.5 && e3.worst < 5, `3 Standorte ${e3.rms} / ${e3.worst}`);
  assert.ok(all.joint.camRms < 1);
  assert.equal(all.solution.mirror, mirror);
});
