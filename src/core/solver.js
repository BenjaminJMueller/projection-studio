// Robuster Projektor-Solver ("Kamera-Resektion") für Projection Mapping.
//
// Modell (OpenCV-Konvention, Pixel-Ursprung oben links, y nach unten):
//   Xc = R * X + t
//   u  = m * f * Xc.x / Xc.z + cx      (m = +1 normal, -1 gespiegelt)
//   v  =     f * Xc.y / Xc.z + cy
// Quadratische Pixel, keine Scherung, keine Linsenverzeichnung (Beamer-Optiken sind
// praktisch verzeichnungsfrei; das stabilisiert die Lösung enorm).
//
// Warum das robuster ist als ein klassisches 6-Punkte-DLT / calibrateCamera:
//  * Nur 9 statt 11 Unbekannte, dazu Vorwissen (Priors) über das Objektiv
//    (Wurfverhältnis, Lage der optischen Achse = Offset/Lens-Shift).
//  * Multi-Start: viele Startpositionen rund um die Punkte, Rotation jeweils
//    in geschlossener Form (Horn), danach Levenberg-Marquardt. Die beste Lösung gewinnt.
//    Dadurch kann die Lösung nicht in ein falsches lokales Minimum "kippen".
//  * Punkte müssen VOR dem Projektor liegen (Cheiralität), gespiegelte Varianten
//    und auf dem Kopf stehende Montage werden mitgeprüft.
//  * Kontinuität: Ist eine frühere Lösung fast gleich gut, wird sie bevorzugt (kein Springen).
//  * Ausgabe von Fehler pro Punkt, Unsicherheit der Position (Kovarianz) und Mehrdeutigkeits-Warnung.

import {
  rodrigues, rodriguesInv, matVec3, transpose, sub3, add3, scale3, norm3, normalize3,
  dot3, eigSym, solveSPD, invSym, absoluteOrientation, zeros,
} from './linalg.js';

const NP = 9; // r(3), t(3), f, cx, cy

function unpack(p) {
  return { R: rodrigues([p[0], p[1], p[2]]), t: [p[3], p[4], p[5]], f: p[6], cx: p[7], cy: p[8] };
}

export function projectPoint(cam, X) {
  const Xc = add3(matVec3(cam.R, X), cam.t);
  const z = Xc[2];
  const zz = Math.abs(z) < 1e-9 ? 1e-9 : z;
  const m = cam.mirror ? -1 : 1;
  return { u: (m * cam.f * Xc[0]) / zz + cam.cx, v: (cam.f * Xc[1]) / zz + cam.cy, z };
}

export function cameraCenter(R, t) {
  // C = -R^T t
  return scale3(matVec3(transpose(R), t), -1);
}

/** Rückprojektion: Pixel -> Strahlrichtung in Weltkoordinaten */
export function pixelRay(cam, u, v) {
  const m = cam.mirror ? -1 : 1;
  const dc = [(m * (u - cam.cx)) / cam.f, (v - cam.cy) / cam.f, 1];
  return normalize3(matVec3(transpose(cam.R), dc));
}

function buildResidualFn(ctx) {
  const { pts, mirror, prior, pixelSigma, minDepth, centerHint, W, H } = ctx;
  return (p) => {
    const cam = unpack(p);
    cam.mirror = mirror;
    const res = [];
    for (const P of pts) {
      const pr = projectPoint(cam, P.world);
      const w = P.weight;
      if (pr.z <= minDepth) {
        // hinter dem Projektor: große, glatte Strafe
        res.push(w * (1e3 + 1e4 * (minDepth - pr.z)), w * (1e3 + 1e4 * (minDepth - pr.z)));
      } else {
        res.push(w * (pr.u - P.image[0]), w * (pr.v - P.image[1]));
      }
    }
    // Vorgabe "Bildmitte liegt ungefähr hier im Modell"
    if (centerHint) {
      const pr = projectPoint(cam, centerHint.world);
      const k = pixelSigma / (centerHint.sigma * W);
      if (pr.z <= minDepth) res.push(1e3, 1e3);
      else res.push(k * (pr.u - W / 2), k * (pr.v - H / 2));
    }
    // Priors (MAP): (wert - erwartet)/sigma * pixelSigma, damit vergleichbar mit Pixelresiduen
    const s = pixelSigma;
    if (prior.f) {
      res.push((s * (p[6] - prior.f.mu)) / prior.f.sigma);
      // weiche Grenzen für das Wurfverhältnis
      const lo = prior.f.min, hi = prior.f.max;
      res.push(p[6] < lo ? (s * 20 * (lo - p[6])) / prior.f.sigma : 0);
      res.push(p[6] > hi ? (s * 20 * (p[6] - hi)) / prior.f.sigma : 0);
    }
    if (p[6] <= 1) res.push(1e6);
    else res.push(0);
    if (prior.cx) res.push((s * (p[7] - prior.cx.mu)) / prior.cx.sigma);
    if (prior.cy) res.push((s * (p[8] - prior.cy.mu)) / prior.cy.sigma);
    if (prior.center) {
      const C = cameraCenter(cam.R, cam.t);
      for (let k = 0; k < 3; k++) res.push((s * (C[k] - prior.center.mu[k])) / prior.center.sigma);
    }
    return res;
  };
}

function sumSq(r) {
  let s = 0;
  for (const x of r) s += x * x;
  return s;
}

function numericJacobian(fn, p, r0, free) {
  const J = r0.map(() => new Array(NP).fill(0));
  for (const j of free) {
    const h = 1e-6 * Math.max(1, Math.abs(p[j]));
    const pp = p.slice();
    pp[j] += h;
    const r1 = fn(pp);
    for (let i = 0; i < r0.length; i++) J[i][j] = (r1[i] - r0[i]) / h;
  }
  return J;
}

/** Levenberg-Marquardt über die freien Parameter. */
export function levenbergMarquardt(fn, p0, free, maxIter = 100) {
  let p = p0.slice();
  let r = fn(p);
  let cost = sumSq(r);
  let lambda = 1e-3;
  const nf = free.length;
  for (let it = 0; it < maxIter; it++) {
    const J = numericJacobian(fn, p, r, free);
    const A = zeros(nf, nf);
    const g = new Array(nf).fill(0);
    for (let i = 0; i < r.length; i++) {
      const Ji = J[i];
      for (let a = 0; a < nf; a++) {
        const ja = Ji[free[a]];
        if (ja === 0) continue;
        g[a] += ja * r[i];
        for (let b = a; b < nf; b++) A[a][b] += ja * Ji[free[b]];
      }
    }
    for (let a = 0; a < nf; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const M = A.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (v + 1e-9) : v)));
      const delta = solveSPD(M, g.map((x) => -x));
      if (!delta) { lambda *= 10; continue; }
      const pn = p.slice();
      for (let a = 0; a < nf; a++) pn[free[a]] += delta[a];
      const rn = fn(pn);
      const cn = sumSq(rn);
      if (cn < cost) {
        const rel = (cost - cn) / Math.max(cost, 1e-30);
        p = pn; r = rn; cost = cn;
        lambda = Math.max(lambda / 3, 1e-12);
        improved = true;
        if (rel < 1e-12) return { p, cost, r };
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  return { p, cost, r };
}

function pca(points) {
  const n = points.length;
  const c = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) c[k] += p[k] / n;
  const C = zeros(3, 3);
  for (const p of points) {
    const d = sub3(p, c);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += (d[a] * d[b]) / n;
  }
  const e = eigSym(C);
  return { centroid: c, values: e.values, axes: e.vectors };
}

/** Startrichtungen: 26 Richtungen eines Würfelgitters + PCA-Normalen */
function seedDirections(normal) {
  const dirs = [];
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (let k = -1; k <= 1; k++) if (i || j || k) dirs.push(normalize3([i, j, k]));
  dirs.push(normal, scale3(normal, -1));
  return dirs;
}

function initialPoseFromCenter(C, pts, intr, mirror) {
  const m = mirror ? -1 : 1;
  const d = [], b = [];
  for (const P of pts) {
    d.push(normalize3(sub3(P.world, C)));
    b.push(normalize3([(m * (P.image[0] - intr.cx)) / intr.f, (P.image[1] - intr.cy) / intr.f, 1]));
  }
  const R = absoluteOrientation(d, b);
  const t = scale3(matVec3(R, C), -1);
  return { R, t };
}

function rotationAngleDeg(R1, R2) {
  // Winkel von R1^T R2
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += R1[k][i] * R2[k][i];
  return (Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180) / Math.PI;
}

/**
 * Hauptfunktion.
 * @param {object} o
 *  points: [{world:[x,y,z], image:[u,v], enabled?:bool, weight?:number}]
 *  width, height: Signalauflösung des Projektors (z. B. 1920, 1080)
 *  lens: Preset aus lenses.js
 *  fixFocal / fixPrincipal: Werte festhalten (nutzt Prior-Mittelwert oder 'focal'/'cx'/'cy')
 *  positionPrior: {center:[x,y,z], sigma:number} (optional, Modelleinheiten)
 *  previous: frühere Lösung (für Kontinuität und als zusätzlicher Start)
 *  pixelSigma: angenommene Klickgenauigkeit in Pixel (Standard 2)
 *  allowMirror: gespiegelte Variante zulassen (Standard: true, aber mit Strafe)
 *  mountMode: 'auto' | 'normal' | 'flipped'  (Achse unter / über dem Bild)
 *  centerHint: {world:[x,y,z], sigma?:number} – Modellpunkt, der ungefähr in der Bildmitte liegt
 */
export function solveProjector(o) {
  const W = o.width, H = o.height;
  const lens = o.lens;
  const pixelSigma = o.pixelSigma ?? 2;
  const pts = o.points
    .filter((p) => p.enabled !== false && p.world && p.image)
    .map((p) => ({ world: p.world, image: p.image, weight: p.weight ?? 1, id: p.id }));
  const n = pts.length;
  const minPoints = o.minPoints ?? 4;
  if (n < minPoints) {
    return { ok: false, message: `Noch ${minPoints - n} Punkt(e) bis zur ersten Lösung.`, needed: minPoints - n };
  }

  const geo = pca(pts.map((p) => p.world));
  let extent = 0;
  for (const p of pts) extent = Math.max(extent, norm3(sub3(p.world, geo.centroid)));
  extent = Math.max(extent, 1e-3);
  const minDepth = extent * 1e-3;

  // Priors
  const fMu = lens.throwNominal * W;
  const priorBase = {
    f: { mu: fMu, sigma: lens.throwSigma * W, min: lens.throwMin * W, max: lens.throwMax * W },
    cx: { mu: lens.cxFrac * W, sigma: lens.cxSigmaFrac * W },
  };
  if (o.positionPrior && o.positionPrior.center) {
    priorBase.center = { mu: o.positionPrior.center, sigma: o.positionPrior.sigma || extent };
  }

  // Hypothesen: Spiegelung × Montage (Achse unter/über dem Bild)
  const mountMode = o.mountMode || 'auto';
  const cyOptions = [];
  if (mountMode !== 'flipped') cyOptions.push({ mode: 'normal', cy: lens.cyFrac * H });
  if (lens.cyFlip && mountMode !== 'normal') cyOptions.push({ mode: 'flipped', cy: (1 - lens.cyFrac) * H });
  if (!cyOptions.length) cyOptions.push({ mode: 'normal', cy: lens.cyFrac * H });
  const mirrorOptions = o.allowMirror === false ? [false] : [false, true];

  const free = [0, 1, 2, 3, 4, 5];
  if (!o.fixFocal) free.push(6);
  if (!o.fixPrincipal) free.push(7, 8);

  const fFixed = o.focal ?? fMu;

  const candidates = [];
  const tStart = Date.now();

  for (const mirror of mirrorOptions) {
    for (const cyo of cyOptions) {
      const prior = { ...priorBase, cy: { mu: cyo.cy, sigma: lens.cySigmaFrac * H } };
      const centerHint = o.centerHint?.world ? { world: o.centerHint.world, sigma: o.centerHint.sigma || 0.2 } : null;
      const ctx = { pts, mirror, prior, pixelSigma, minDepth, centerHint, W, H };
      const fn = buildResidualFn(ctx);
      const intr = { f: o.fixFocal ? fFixed : fMu, cx: o.fixPrincipal ? (o.cx ?? prior.cx.mu) : prior.cx.mu, cy: o.fixPrincipal ? (o.cy ?? cyo.cy) : cyo.cy };

      // 1) Startpositionen erzeugen und grob bewerten
      const seeds = [];
      const normal = geo.axes[2];
      const dirs = seedDirections(normal);
      // typischer Abstand aus Wurfverhältnis: Bildbreite ~ Ausdehnung der Punkte
      const dists = [0.6, 1.2, 2.5, 5].map((k) => k * extent * Math.max(0.3, lens.throwNominal) * 1.5);
      for (const d of dirs) for (const dist of dists) seeds.push(add3(geo.centroid, scale3(d, dist)));
      if (priorBase.center) seeds.push(priorBase.center.mu);
      if (o.previous && !!o.previous.mirror === mirror) seeds.push(o.previous.center);

      const scored = [];
      for (const C of seeds) {
        const { R, t } = initialPoseFromCenter(C, pts, intr, mirror);
        const p = [...rodriguesInv(R), ...t, intr.f, intr.cx, intr.cy];
        scored.push({ p, cost: sumSq(fn(p)) });
      }
      if (o.previous && !!o.previous.mirror === mirror) {
        const pv = o.previous;
        scored.push({ p: [...rodriguesInv(pv.R), ...pv.t, pv.f, pv.cx, pv.cy], cost: -1, fromPrevious: true });
      }
      scored.sort((a, b) => a.cost - b.cost);

      // 2) Die besten Starts verfeinern: erst nur Pose, dann alles
      const top = scored.slice(0, 14);
      for (const s of top) {
        let res = levenbergMarquardt(fn, s.p, [0, 1, 2, 3, 4, 5], 40);
        res = levenbergMarquardt(fn, res.p, free, 150);
        const cam = unpack(res.p);
        cam.mirror = mirror;
        // alle Punkte vor dem Projektor?
        let front = true;
        for (const P of pts) if (projectPoint(cam, P.world).z <= minDepth) front = false;
        if (!front) continue;
        candidates.push({ p: res.p, cost: res.cost, mirror, mount: cyo.mode, fn, fromPrevious: !!s.fromPrevious, prior });
      }
    }
  }

  if (!candidates.length) {
    return { ok: false, message: 'Keine gültige Lösung gefunden – prüfe, ob die Punktpaare richtig zugeordnet sind.' };
  }

  // Gespiegelte Lösungen nur nehmen, wenn sie deutlich besser sind
  for (const c of candidates) c.score = c.cost * (c.mirror ? 1.5 : 1) + (c.mirror ? n * pixelSigma * pixelSigma : 0);
  candidates.sort((a, b) => a.score - b.score);
  let best = candidates[0];

  // Kontinuität: frühere Lösung bevorzugen, wenn fast gleich gut
  if (o.previous) {
    const prevBased = candidates.filter((c) => c.fromPrevious && c.mirror === !!o.previous.mirror);
    if (prevBased.length) {
      const pb = prevBased.sort((a, b) => a.score - b.score)[0];
      if (pb !== best && pb.score <= best.score * 1.05 + 1) best = pb;
    }
  }

  const cam = unpack(best.p);
  cam.mirror = best.mirror;
  const center = cameraCenter(cam.R, cam.t);

  // Fehler pro Punkt (nur Datenterm)
  const errors = [];
  let se = 0;
  for (const P of pts) {
    const pr = projectPoint(cam, P.world);
    const e = Math.hypot(pr.u - P.image[0], pr.v - P.image[1]);
    errors.push({ id: P.id, error: e, projected: [pr.u, pr.v] });
    se += e * e;
  }
  const rms = Math.sqrt(se / n);

  // Unsicherheit über Kovarianz (Gauss-Newton-Näherung)
  const r0 = best.fn(best.p);
  const J = numericJacobian(best.fn, best.p, r0, free);
  const nf = free.length;
  const A = zeros(nf, nf);
  for (let i = 0; i < r0.length; i++)
    for (let a = 0; a < nf; a++) for (let b = 0; b < nf; b++) A[a][b] += J[i][free[a]] * J[i][free[b]];
  const sigma2 = pixelSigma * pixelSigma; // Residuen sind in Pixel
  const Cov = invSym(A).map((row) => row.map((v) => v * sigma2));
  // Jacobi der Kameraposition nach den freien Parametern
  const JC = [[], [], []];
  for (let a = 0; a < nf; a++) {
    const j = free[a];
    const h = 1e-6 * Math.max(1, Math.abs(best.p[j]));
    const pp = best.p.slice();
    pp[j] += h;
    const c2 = unpack(pp);
    const C2 = cameraCenter(c2.R, c2.t);
    for (let k = 0; k < 3; k++) JC[k][a] = (C2[k] - center[k]) / h;
  }
  let varC = 0;
  for (let k = 0; k < 3; k++)
    for (let a = 0; a < nf; a++) for (let b = 0; b < nf; b++) varC += JC[k][a] * Cov[a][b] * JC[k][b];
  const sigmaCenter = Math.sqrt(Math.max(0, varC));
  const fIdx = free.indexOf(6);
  const sigmaF = fIdx >= 0 ? Math.sqrt(Math.max(0, Cov[fIdx][fIdx])) : 0;

  // Mehrdeutigkeit: zweitbeste, deutlich andere Lösung
  let ambiguous = false;
  let alternative = null;
  for (const c of candidates) {
    if (c === best) continue;
    const ca = unpack(c.p);
    const Ca = cameraCenter(ca.R, ca.t);
    const dist = norm3(sub3(Ca, center));
    const ang = rotationAngleDeg(ca.R, cam.R);
    if (dist > 0.1 * extent || ang > 5 || c.mirror !== best.mirror) {
      alternative = { cost: c.cost, centerDistance: dist, angle: ang, mirror: c.mirror };
      if (c.score < best.score * 1.6 + n * 0.5) ambiguous = true;
      break;
    }
  }

  // Geometrie- und Verteilungs-Diagnose
  const warnings = [];
  const planarity = geo.values[2] / Math.max(geo.values[0], 1e-30);
  const coverage = imageCoverage(pts.map((p) => p.image), W, H);
  if (n < 6) warnings.push({ level: 'info', text: `Vorläufig, ${n} Punkte`, detail: '6 oder mehr gut verteilte Punkte machen die Lösung stabil.' });
  if (coverage < 0.15) warnings.push({ level: 'warn', text: 'Punkte zu eng beieinander', detail: 'Die Punkte decken nur einen kleinen Teil des Projektorbilds ab. Punkte nahe an die Bildecken setzen.' });
  if (ambiguous) warnings.push({ level: 'warn', text: 'Mehrdeutig', detail: 'Eine deutlich andere Projektorposition passt fast genauso gut. Einen Punkt in einer leeren Bildregion setzen.' });
  const worst = errors.reduce((a, b) => (b.error > a.error ? b : a), errors[0]);
  if (n >= 5 && worst.error > Math.max(8, 3 * rms)) {
    warnings.push({ level: 'warn', text: `Punkt ${worst.id ?? ''} passt nicht (${worst.error.toFixed(1)} px)`, detail: 'Wahrscheinlich falsch zugeordnet: im Modell oder im Bild neu setzen, oder abwählen.', pointId: worst.id });
  }
  if (best.mirror) warnings.push({ level: 'info', text: 'Gespiegelt', detail: 'Bei Projektion über einen Spiegel ist das richtig. Sonst im Beamer-Menü Front/Rück umstellen.' });
  if (sigmaCenter > 0.15 * extent) warnings.push({ level: 'warn', text: 'Position noch unsicher', detail: `±${sigmaCenter.toFixed(2)} Einheiten. Mehr Punkte in unterschiedlicher Höhe und Tiefe helfen.` });
  const throwRatio = cam.f / W;
  if (throwRatio < lens.throwMin * 0.98 || throwRatio > lens.throwMax * 1.02) {
    warnings.push({ level: 'warn', text: 'Wurfverhältnis passt nicht', detail: `${throwRatio.toFixed(2)} liegt außerhalb des Objektivbereichs. Punkte oder Projektor-Typ prüfen.` });
  }

  const solution = {
    R: cam.R, t: cam.t, f: cam.f, cx: cam.cx, cy: cam.cy, mirror: cam.mirror,
    width: W, height: H, center, mount: best.mount,
    throwRatio, rms, errors, sigmaCenter, sigmaF, extent, planarity, coverage,
    ambiguous, alternative, pointCount: n,
    solveMs: Date.now() - tStart,
  };
  return { ok: true, solution, warnings, quality: qualityGrade(solution) };
}

function qualityGrade(s) {
  if (s.pointCount < 5 || s.ambiguous) return 'vorläufig';
  if (s.rms < 2 && s.sigmaCenter < 0.03 * s.extent) return 'sehr gut';
  if (s.rms < 4 && s.sigmaCenter < 0.08 * s.extent) return 'gut';
  return 'unsicher';
}

/** Anteil der Bildfläche, den die konvexe Hülle der Punkte abdeckt (0..1). */
export function imageCoverage(img, W, H) {
  if (img.length < 3) return 0;
  const pts = img.map((p) => [p[0] / W, p[1] / H]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let a = 0;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/**
 * Vorschlag, wo der nächste Punkt hin sollte: Bildregion (normiert 0..1),
 * die am weitesten von allen bisherigen Punkten entfernt ist.
 */
export function suggestNextImageRegion(img, W, H) {
  const cand = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) cand.push([0.08 + (0.84 * i) / 4, 0.1 + (0.8 * j) / 3]);
  let best = cand[0], bestD = -1;
  for (const c of cand) {
    let d = Infinity;
    for (const p of img) d = Math.min(d, Math.hypot(c[0] - p[0] / W, (c[1] - p[1] / H) * (H / W)));
    if (!img.length) d = Math.hypot(c[0] - 0.08, c[1] - 0.1) === 0 ? 1 : 1 - Math.hypot(c[0] - 0.08, c[1] - 0.1);
    if (d > bestD) { bestD = d; best = c; }
  }
  return { u: best[0] * W, v: best[1] * H, distance: bestD };
}

export { dot3 };
