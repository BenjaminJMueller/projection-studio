// Kamera-Kalibrierung: aus Gray-Code-Zellen (Kamerapixel ↔ Projektorpixel) werden Punktpaare
// (3D-Punkt ↔ Projektorpixel) für den bestehenden Solver.
//
// 1. Kamera-Standort bestimmen: entweder über einen schon kalibrierten Projektor, den die Kamera
//    mit sieht (dessen Pixel werden auf das Modell zurückgeworfen), oder über Punkte, die man im
//    Kamerabild anklickt. Die Kamera wird dabei wie ein Projektor gelöst (Lochkamera, Vorwissen).
// 2. Für den zu kalibrierenden Projektor: Kamerastrahl je Zelle aufs Modell → 3D-Punkt.
// 3. Robuste Lösung: Ausreißer (z. B. Reflexionen, Kanten des Modells) werden verworfen.
//
// Erster Projektor (noch kein Bezug): Projektor und Kamera(s) werden gemeinsam gelöst (jointSolve).
// Ein Projektorpixel trifft das Modell an genau einer Stelle; die Kamera muss diese Stelle an dem
// Kamerapixel sehen, das die Streifenmuster ergeben haben. Auf einer gekrümmten Fläche mit Kanten
// (Gewölbe, Wand-Decken-Ecke) passt dazu nur eine Lage beider Geräte. Ein paar grobe Punkte von Hand
// liefern nur den Startwert, mehrere Kamera-Standorte machen die Lösung genau.

import { solveProjector, pixelRay, cameraCenter, projectPoint, imageCoverage } from './solver.js';
import { sub3, cross3, dot3, add3, scale3, rodrigues, rodriguesInv, solveSPD } from './linalg.js';

// ---------------------------------------------------------------- Strahl ↔ Modell (BVH)
/**
 * Schnitt von Strahlen mit dem Modell. positions: Float32Array (x,y,z je Ecke, je 3 Ecken ein Dreieck),
 * optional index. Einmal aufbauen, dann beliebig viele Abfragen (je ~log n).
 */
export function buildRaycaster(positions, index = null) {
  const nt = index ? index.length / 3 : positions.length / 9;
  const tri = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = index ? index[t * 3 + k] : t * 3 + k;
      tri[t * 9 + k * 3] = positions[vi * 3]; tri[t * 9 + k * 3 + 1] = positions[vi * 3 + 1]; tri[t * 9 + k * 3 + 2] = positions[vi * 3 + 2];
    }
  }
  const ids = new Uint32Array(nt).map((_, i) => i);
  const cen = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) for (let a = 0; a < 3; a++) cen[t * 3 + a] = (tri[t * 9 + a] + tri[t * 9 + 3 + a] + tri[t * 9 + 6 + a]) / 3;
  const nodes = []; // { min, max, left, right, start, count }
  const build = (start, end) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = ids[i];
      for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) {
        const v = tri[t * 9 + k * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    const node = { min, max, left: -1, right: -1, start, count: end - start };
    const id = nodes.length;
    nodes.push(node);
    if (end - start <= 8) return id;
    const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const axis = ext[0] > ext[1] ? (ext[0] > ext[2] ? 0 : 2) : ext[1] > ext[2] ? 1 : 2;
    const part = ids.subarray(start, end);
    part.sort((a, b) => cen[a * 3 + axis] - cen[b * 3 + axis]);
    const mid = (start + end) >> 1;
    node.left = build(start, mid);
    node.right = build(mid, end);
    node.count = 0;
    return id;
  };
  if (nt) build(0, nt);

  const hitBox = (n, o, inv, tmax) => {
    let t0 = 0, t1 = tmax;
    for (let a = 0; a < 3; a++) {
      let ta = (n.min[a] - o[a]) * inv[a], tb = (n.max[a] - o[a]) * inv[a];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    return true;
  };
  /** Nächster Schnittpunkt (Möller-Trumbore) oder null. */
  return function intersect(o, d) {
    if (!nodes.length) return null;
    const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
    let best = Infinity, bestT = -1;
    const stack = [0];
    while (stack.length) {
      const n = nodes[stack.pop()];
      if (!hitBox(n, o, inv, best)) continue;
      if (n.left >= 0) { stack.push(n.left, n.right); continue; }
      for (let i = n.start; i < n.start + n.count; i++) {
        const t = ids[i], b = t * 9;
        const e1x = tri[b + 3] - tri[b], e1y = tri[b + 4] - tri[b + 1], e1z = tri[b + 5] - tri[b + 2];
        const e2x = tri[b + 6] - tri[b], e2y = tri[b + 7] - tri[b + 1], e2z = tri[b + 8] - tri[b + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det;
        const sx = o[0] - tri[b], sy = o[1] - tri[b + 1], sz = o[2] - tri[b + 2];
        const u = (sx * px + sy * py + sz * pz) * id;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * id;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * id;
        if (tt > 1e-6 && tt < best) { best = tt; bestT = t; }
      }
    }
    if (bestT < 0) return null;
    // Normale für Streiflicht-Prüfung
    const b = bestT * 9;
    const n = cross3([tri[b + 3] - tri[b], tri[b + 4] - tri[b + 1], tri[b + 5] - tri[b + 2]], [tri[b + 6] - tri[b], tri[b + 7] - tri[b + 1], tri[b + 8] - tri[b + 2]]);
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    return { t: best, point: add3(o, scale3(d, best)), cos: Math.abs(dot3(d, n)) / nl };
  };
}

// ---------------------------------------------------------------- Kamera-Vorwissen
/**
 * Vorwissen für eine Webcam: optische Achse nahe der Bildmitte, Brennweite aus dem horizontalen
 * Bildwinkel (Logitech StreamCam ≈ 67°, viele Webcams 60–80°). Weite Grenzen, damit auch andere passen.
 */
export function cameraLens(hfovDeg = 67) {
  const nominal = 1 / (2 * Math.tan((hfovDeg * Math.PI) / 360));
  return {
    id: 'camera', name: 'Kamera',
    throwMin: 0.3, throwMax: 2.5, throwNominal: nominal, throwSigma: 0.25,
    cxFrac: 0.5, cxSigmaFrac: 0.03, cyFrac: 0.5, cySigmaFrac: 0.03, cyFlip: false,
  };
}

/** Weltpunkt, den ein Projektor/eine Kamera am Pixel (u, v) auf dem Modell trifft. */
export function surfacePoint(sol, u, v, intersect, minCos = 0.12) {
  const o = cameraCenter(sol.R, sol.t);
  const d = pixelRay(sol, u, v);
  const hit = intersect(o, d);
  if (!hit || hit.cos < minCos) return null; // streifender Einfall: zu ungenau
  return hit.point;
}

/**
 * Solver mit Ausreißer-Entfernung: lösen, Punkte mit großem Fehler weglassen, neu lösen.
 * opts wie solveProjector. Rückgabe zusätzlich { used, dropped }.
 */
export function robustSolve(opts, { maxIter = 3, minErr = 3 } = {}) {
  let pts = opts.points;
  let res = null;
  for (let it = 0; it < maxIter; it++) {
    res = solveProjector({ ...opts, points: pts });
    if (!res.ok) return { ...res, used: pts.length, dropped: opts.points.length - pts.length };
    const errs = pts.map((p) => {
      const pr = projectPoint(res.solution, p.world);
      return pr.z > 0 ? Math.hypot(pr.u - p.image[0], pr.v - p.image[1]) : Infinity;
    });
    const sorted = [...errs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const lim = Math.max(minErr, 3.5 * med);
    const keep = pts.filter((_, i) => errs[i] <= lim);
    if (keep.length === pts.length || keep.length < 6) break;
    pts = keep;
    opts = { ...opts, previous: res.solution };
  }
  return { ...res, used: pts.length, dropped: opts.points.length - pts.length, points: pts };
}

/**
 * Kamera-Standort über einen kalibrierten Projektor: dessen Zellen (u,v ↔ x,y) aufs Modell werfen.
 * Rückgabe wie solveProjector (Lösung = Kamera) oder { ok: false, message }.
 */
export function cameraFromReference(cells, refSolution, intersect, camW, camH, opt = {}) {
  const points = [];
  for (const c of cells) {
    const X = surfacePoint(refSolution, c.u, c.v, intersect);
    if (X) points.push({ world: X, image: [c.x, c.y] });
  }
  if (points.length < 12) return { ok: false, message: 'Die Kamera sieht zu wenig vom Bezugsprojektor.' };
  return robustSolve({
    points, width: camW, height: camH, lens: opt.lens || cameraLens(), mountMode: 'normal', allowMirror: false,
    pixelSigma: 1, previous: opt.previous || null,
  });
}

/** Kamera-Standort aus angeklickten Punkten (3D-Punkt ↔ Kamerapixel). */
export function cameraFromClicks(points, camW, camH, opt = {}) {
  if (points.length < 6) return { ok: false, message: `Noch ${6 - points.length} Punkt(e) im Kamerabild anklicken.` };
  return solveProjector({ points, width: camW, height: camH, lens: opt.lens || cameraLens(), mountMode: 'normal', allowMirror: false, pixelSigma: 2 });
}

/** Punktpaare (3D ↔ Projektorpixel) aus Zellen des zu kalibrierenden Projektors. */
export function projectorPoints(cells, camSolution, intersect) {
  const out = [];
  for (const c of cells) {
    const X = surfacePoint(camSolution, c.x, c.y, intersect);
    if (X) out.push({ world: X, image: [c.u, c.v] });
  }
  return out;
}

/**
 * Bewertung der Abdeckung im Projektorbild (0..1) und Hinweise.
 * points: Projektorpixel; W, H: Auflösung.
 */
export function coverageReport(images, W, H) {
  const cov = imageCoverage(images, W, H);
  const gx = 8, gy = 5;
  const grid = new Uint8Array(gx * gy);
  for (const [u, v] of images) grid[Math.min(gy - 1, Math.floor((v / H) * gy)) * gx + Math.min(gx - 1, Math.floor((u / W) * gx))] = 1;
  const filled = grid.reduce((s, x) => s + x, 0) / grid.length;
  const tips = [];
  if (filled < 0.35) tips.push('Die Kamera sieht nur einen kleinen Teil dieses Projektors. Weitere Kamera-Standorte hinzufügen.');
  else if (filled < 0.7) tips.push('Teile des Projektorbilds fehlen noch. Für die Ränder einen weiteren Kamera-Standort hinzufügen.');
  return { coverage: cov, filled, grid: Array.from(grid), gx, gy, tips };
}

// ---------------------------------------------------------------- Projektor + Kamera gemeinsam
const HUBER = 3; // Kamerapixel: größere Abweichungen zählen nur noch linear (Reflexionen, Kanten)

/**
 * Projektor und Kamera-Standorte gemeinsam lösen, ohne kalibrierten Bezug.
 * o.start: grobe Projektor-Lösung (z. B. aus 4 Punkten von Hand), gibt Spiegelung und Startwert vor.
 * o.sessions: [{ cells: [{u,v,x,y}], camW, camH, group? }] je Kamera-Standort. Standorte mit gleicher
 *   group (gleiche Kamera, gleiche Auflösung) teilen sich Brennweite und Bildmitte.
 * o.width/height/lens: Projektor wie bei solveProjector; o.camLens: Vorwissen Kamera.
 * Rückgabe { ok, projector, cameras, camRms, used, dropped, ms } oder { ok: false, message }.
 */
export function jointSolve(o, intersect) {
  const t0 = Date.now();
  const W = o.width, H = o.height, lens = o.lens, cl = o.camLens || cameraLens();
  const start = o.start;
  if (!start) return { ok: false, message: 'Erst grobe Punkte von Hand setzen.' };
  const mirror = !!start.mirror;
  // Startwerte der Kameras über die grobe Projektor-Lösung
  const groups = [], gIndex = new Map(), cams = [];
  for (const s of o.sessions) {
    const key = s.group ?? `${s.camW}x${s.camH}`;
    if (!gIndex.has(key)) { gIndex.set(key, groups.length); groups.push({ w: s.camW, h: s.camH }); }
    const c = cameraFromReference(s.cells, start, intersect, s.camW, s.camH, { lens: cl });
    if (!c.ok) return { ok: false, message: c.message };
    cams.push(c.solution);
  }
  const NG = groups.length, K = o.sessions.length;
  const oG = 9, oC = 9 + 3 * NG, N = oC + 6 * K;
  const x = new Float64Array(N);
  x.set([...rodriguesInv(start.R), ...start.t, start.f, start.cx, start.cy], 0);
  const gFirst = new Array(NG).fill(-1);
  o.sessions.forEach((s, k) => {
    const g = gIndex.get(s.group ?? `${s.camW}x${s.camH}`);
    if (gFirst[g] < 0) { gFirst[g] = k; x.set([cams[k].f, cams[k].cx, cams[k].cy], oG + 3 * g); }
    x.set([...rodriguesInv(cams[k].R), ...cams[k].t], oC + 6 * k);
  });
  const sessG = o.sessions.map((s) => gIndex.get(s.group ?? `${s.camW}x${s.camH}`));
  // Vorwissen Projektor: Achslage wie im Solver (Montage normal/über Kopf nach Startwert)
  const cyMu = lens.cyFlip && Math.abs(start.cy - (1 - lens.cyFrac) * H) < Math.abs(start.cy - lens.cyFrac * H) ? (1 - lens.cyFrac) * H : lens.cyFrac * H;
  const priors = [
    [6, lens.throwNominal * W, lens.throwSigma * W], [7, lens.cxFrac * W, lens.cxSigmaFrac * W], [8, cyMu, lens.cySigmaFrac * H],
  ];
  groups.forEach((g, i) => priors.push([oG + 3 * i, cl.throwNominal * g.w, cl.throwSigma * g.w], [oG + 3 * i + 1, cl.cxFrac * g.w, cl.cxSigmaFrac * g.w], [oG + 3 * i + 2, cl.cyFrac * g.h, cl.cySigmaFrac * g.h]));
  // Grobe Punkte: nur schwach (sie sind absichtlich ungenau), verhindern Abdriften bei wenig Kameradaten
  const manual = (o.manual || []).filter((m) => m.world && m.image && m.enabled !== false);
  const mw = 1 / (o.manualSigma || 80);

  let cells = o.sessions.map((s) => s.cells);
  const proj = (x) => ({ R: rodrigues([x[0], x[1], x[2]]), t: [x[3], x[4], x[5]], f: x[6], cx: x[7], cy: x[8], mirror });
  const cam = (x, k) => {
    const g = oG + 3 * sessG[k], c = oC + 6 * k;
    return { R: rodrigues([x[c], x[c + 1], x[c + 2]]), t: [x[c + 3], x[c + 4], x[c + 5]], f: x[g], cx: x[g + 1], cy: x[g + 2], mirror: false };
  };
  // Treffer der Projektorstrahlen hängen nur vom Projektor ab: für Kamera-Ableitungen wiederverwenden
  const hitsFor = (P) => {
    const C = cameraCenter(P.R, P.t);
    return cells.map((cs) => cs.map((c) => intersect(C, pixelRay(P, c.u, c.v))?.point || null));
  };
  const nRes = () => cells.reduce((s, cs) => s + 2 * cs.length, 0) + 2 * manual.length + priors.length;
  const residuals = (x, hits, out) => {
    let i = 0;
    for (let k = 0; k < K; k++) {
      const C = cam(x, k), hs = hits[k], cs = cells[k];
      for (let j = 0; j < cs.length; j++) {
        const X = hs[j];
        if (!X) { out[i++] = 0; out[i++] = 0; continue; } // verfehlt das Modell: zählt nicht
        const q = projectPoint(C, X);
        if (q.z <= 0) { out[i++] = 50; out[i++] = 50; continue; }
        const ex = q.u - cs[j].x, ey = q.v - cs[j].y, e = Math.hypot(ex, ey), w = e > HUBER ? Math.sqrt(HUBER / e) : 1;
        out[i++] = ex * w; out[i++] = ey * w;
      }
    }
    const P = proj(x);
    for (const m of manual) { const q = projectPoint(P, m.world); out[i++] = (q.u - m.image[0]) * mw; out[i++] = (q.v - m.image[1]) * mw; }
    for (const [j, mu, sg] of priors) out[i++] = (x[j] - mu) / sg;
    return out;
  };
  const ss = (r) => { let s = 0; for (let i = 0; i < r.length; i++) s += r[i] * r[i]; return s; };

  const lm = (x, maxIter) => {
    let hits = hitsFor(proj(x));
    let M = nRes(), r = residuals(x, hits, new Float64Array(M)), cost = ss(r), lambda = 1e-3;
    const J = new Float64Array(N * M), r1 = new Float64Array(M);
    for (let it = 0; it < maxIter; it++) {
      for (let j = 0; j < N; j++) {
        const h = 1e-6 * Math.max(1, Math.abs(x[j])), keep = x[j];
        x[j] = keep + h;
        residuals(x, j < 9 ? hitsFor(proj(x)) : hits, r1);
        x[j] = keep;
        for (let i = 0; i < M; i++) J[j * M + i] = (r1[i] - r[i]) / h;
      }
      const A = Array.from({ length: N }, () => new Array(N).fill(0)), g = new Array(N).fill(0);
      for (let a = 0; a < N; a++) {
        const ja = a * M;
        let s = 0;
        for (let i = 0; i < M; i++) s += J[ja + i] * r[i];
        g[a] = -s;
        for (let b = a; b < N; b++) {
          const jb = b * M;
          let t = 0;
          for (let i = 0; i < M; i++) t += J[ja + i] * J[jb + i];
          A[a][b] = A[b][a] = t;
        }
      }
      let improved = false;
      for (let tries = 0; tries < 10; tries++) {
        const Ad = A.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)));
        const d = solveSPD(Ad, g);
        if (!d) { lambda *= 10; continue; }
        const xn = x.map((v, i) => v + d[i]);
        const hn = hitsFor(proj(xn)), rn = residuals(xn, hn, new Float64Array(M)), cn = ss(rn);
        if (cn < cost) {
          const rel = (cost - cn) / Math.max(cost, 1e-30);
          x.set(xn); hits = hn; r = rn; cost = cn; lambda = Math.max(lambda / 3, 1e-12); improved = true;
          if (rel < 1e-7) it = maxIter;
          break;
        }
        lambda *= 4;
      }
      if (!improved) break;
    }
    return hits;
  };

  // Lösen, Ausreißer weglassen, nachlösen
  const total = cells.reduce((s, cs) => s + cs.length, 0);
  let hits = lm(x, 40);
  for (let round = 0; round < 2; round++) {
    const errs = cells.map((cs, k) => { const C = cam(x, k); return cs.map((c, j) => { const X = hits[k][j]; if (!X) return Infinity; const q = projectPoint(C, X); return q.z > 0 ? Math.hypot(q.u - c.x, q.v - c.y) : Infinity; }); });
    const all = errs.flat().filter(Number.isFinite).sort((a, b) => a - b);
    if (all.length < 12) return { ok: false, message: 'Die Kamera sieht zu wenig vom Projektorbild auf dem Modell. Grobe Punkte prüfen.' };
    const lim = Math.max(1.5, 3.5 * all[Math.floor(all.length / 2)]);
    const next = cells.map((cs, k) => cs.filter((_, j) => errs[k][j] <= lim));
    if (next.every((cs, k) => cs.length === cells[k].length)) break;
    cells = next;
    hits = lm(x, 30);
  }
  let se = 0, n = 0;
  const cameras = o.sessions.map((s, k) => {
    const C = cam(x, k);
    let sk = 0, nk = 0;
    cells[k].forEach((c, j) => { const X = hits[k][j]; if (!X) return; const q = projectPoint(C, X); const e2 = (q.u - c.x) ** 2 + (q.v - c.y) ** 2; sk += e2; nk++; });
    se += sk; n += nk;
    return { ...C, width: s.camW, height: s.camH, center: cameraCenter(C.R, C.t), rms: Math.sqrt(sk / Math.max(1, nk)), used: nk };
  });
  const P = proj(x);
  return {
    ok: true, projector: { ...P, width: W, height: H, center: cameraCenter(P.R, P.t) }, cameras,
    camRms: Math.sqrt(se / Math.max(1, n)), used: n, dropped: total - n, cells, ms: Date.now() - t0,
  };
}

/**
 * Erster Projektor: gemeinsam lösen, dann wie gewohnt Punktpaare (3D ↔ Projektorpixel) über die
 * gefundenen Kamera-Standorte erzeugen und mit dem normalen Solver abschließen.
 */
export function selfCalibrate(o, intersect) {
  const j = jointSolve(o, intersect);
  if (!j.ok) return j;
  const points = j.cells.flatMap((cs, k) => projectorPoints(cs, j.cameras[k], intersect));
  const res = robustSolve({ points, width: o.width, height: o.height, lens: o.lens, mountMode: o.mountMode, previous: j.projector, pixelSigma: 1, allowMirror: o.allowMirror });
  return { ...res, joint: { camRms: j.camRms, cameras: j.cameras.map((c) => ({ rms: c.rms, used: c.used, center: c.center })), ms: j.ms } };
}

export { sub3 };
