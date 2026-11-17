// Umrechnung der Solver-Lösung in OpenGL-/three.js- und TouchDesigner-Konventionen.
// Alle 4x4-Matrizen als Zeilen-Array (row-major) für Spaltenvektoren: p' = M * p.

import { transpose, matVec3 } from './linalg.js';

/** View-Matrix (Welt -> Kamera, OpenGL: x rechts, y oben, Blick entlang -z). */
export function viewMatrixGL(sol) {
  const m = sol.mirror ? -1 : 1;
  const S = [m, -1, -1];
  const R = sol.R, t = sol.t;
  return [
    [S[0] * R[0][0], S[0] * R[0][1], S[0] * R[0][2], S[0] * t[0]],
    [S[1] * R[1][0], S[1] * R[1][1], S[1] * R[1][2], S[1] * t[1]],
    [S[2] * R[2][0], S[2] * R[2][1], S[2] * R[2][2], S[2] * t[2]],
    [0, 0, 0, 1],
  ];
}

/** Kamera-Weltmatrix (Kamera -> Welt) = Inverse der View-Matrix. */
export function cameraWorldMatrix(sol) {
  const V = viewMatrixGL(sol);
  const A = [V[0].slice(0, 3), V[1].slice(0, 3), V[2].slice(0, 3)];
  const At = transpose(A); // A ist orthogonal (ggf. mit Spiegelung)
  const tt = matVec3(At, [V[0][3], V[1][3], V[2][3]]);
  return [
    [At[0][0], At[0][1], At[0][2], -tt[0]],
    [At[1][0], At[1][1], At[1][2], -tt[1]],
    [At[2][0], At[2][1], At[2][2], -tt[2]],
    [0, 0, 0, 1],
  ];
}

/** OpenGL-Projektionsmatrix aus den Intrinsiken (Pixel oben links, y nach unten). */
export function projectionMatrixGL(sol, near, far) {
  const W = sol.width, H = sol.height, f = sol.f;
  return [
    [(2 * f) / W, 0, 1 - (2 * sol.cx) / W, 0],
    [0, (2 * f) / H, (2 * sol.cy) / H - 1, 0],
    [0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near)],
    [0, 0, -1, 0],
  ];
}

const deg = (r) => (r * 180) / Math.PI;

/**
 * Euler-Winkel für TouchDesigner (Rotationsreihenfolge "xyz": erst X, dann Y, dann Z,
 * also R = Rz * Ry * Rx), in Grad.
 */
export function eulerXYZ(R) {
  const sy = -R[2][0];
  const ry = Math.asin(Math.max(-1, Math.min(1, sy)));
  let rx, rz;
  if (Math.abs(sy) < 0.999999) {
    rx = Math.atan2(R[2][1], R[2][2]);
    rz = Math.atan2(R[1][0], R[0][0]);
  } else {
    // Gimbal-Lock
    rx = Math.atan2(-R[1][2], R[1][1]);
    rz = 0;
  }
  return [deg(rx), deg(ry), deg(rz)];
}

/** Sinnvolle Clipping-Ebenen aus der Modellgröße. */
export function nearFarFor(sol, modelRadius = 10) {
  const d = Math.hypot(...sol.center);
  return { near: 0.05, far: Math.max(50, (d + modelRadius) * 3) };
}

/**
 * Alle Werte, die TouchDesigner braucht.
 * - Transform: tx..rz (Rotationsreihenfolge xyz, Transformreihenfolge srt), sx = -1 bei Spiegelung
 * - FOV horizontal (Viewing Angle Method = Horizontal)
 * - winx/winy: Fenster-Verschiebung (Lens Shift) als Anteil der Bildbreite/-höhe
 * - Matrizen zur Kontrolle (das Apply-Skript prüft damit selbst nach)
 */
export function toTouchDesigner(sol, opts = {}) {
  const { near, far } = opts.near ? opts : nearFarFor(sol, opts.modelRadius);
  const M = cameraWorldMatrix(sol);
  const m = sol.mirror ? -1 : 1;
  // Eigentliche Rotation (ohne Spiegelung): M3 * diag(m,1,1)
  const Rp = [
    [M[0][0] * m, M[0][1], M[0][2]],
    [M[1][0] * m, M[1][1], M[1][2]],
    [M[2][0] * m, M[2][1], M[2][2]],
  ];
  const [rx, ry, rz] = eulerXYZ(Rp);
  const P = projectionMatrixGL(sol, near, far);
  return {
    tx: M[0][3], ty: M[1][3], tz: M[2][3],
    rx, ry, rz,
    sx: m, sy: 1, sz: 1,
    xord: 'srt', rord: 'xyz',
    fov: deg(2 * Math.atan(sol.width / (2 * sol.f))),
    fovVertical: deg(2 * Math.atan(sol.height / (2 * sol.f))),
    viewanglemethod: 'horizontal',
    winx: P[0][2] / 2,
    winy: P[1][2] / 2,
    near, far,
    resx: sol.width, resy: sol.height,
    worldMatrix: M.flat(),
    projectionMatrix: P.flat(),
    targetP02: P[0][2],
    targetP12: P[1][2],
  };
}

/** Kompakter Export eines Projektors (auch für andere Programme gedacht). */
export function exportProjector(proj, opts = {}) {
  const s = proj.solution;
  if (!s) return null;
  return {
    id: proj.id,
    name: proj.name,
    tdCamera: proj.tdCamera,
    resolution: [s.width, s.height],
    intrinsics: { fx: s.mirror ? -s.f : s.f, fy: s.f, cx: s.cx, cy: s.cy, throwRatio: s.throwRatio },
    opencv: { R: s.R, t: s.t, mirror: s.mirror },
    center: s.center,
    quality: { rmsPx: s.rms, points: s.pointCount, sigmaCenter: s.sigmaCenter },
    touchdesigner: toTouchDesigner(s, opts),
    viewMatrixGL: viewMatrixGL(s).flat(),
  };
}
