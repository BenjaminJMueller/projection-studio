// Feinkorrektur (Ersatz für Stoner): Verzerrung pro Projektor aus zwei Teilen.
//  1. Gitter mit cols × rows Stützpunkten (2..WARP_MAX), dazwischen Catmull-Rom.
//  2. Freie Punkte ("Pins") an beliebiger Stelle. Jeder Pin legt fest, wohin der Bildinhalt an seiner
//     Stelle wandert. Dazwischen wirkt er weich (Wendland-Kern mit Reichweite radius), weiter weg gar nicht.
//     Ein neu gesetzter Pin hält das Bild an dieser Stelle fest, bis er gezogen wird.
// Koordinaten: normiert, u nach rechts, v nach unten (0..1). Bildinhalt an Stelle p erscheint bei p + off(p).
// Für die Ausgabe wird umgekehrt gesucht: zu jedem Ausgabepixel q die Quelle p mit p + off(p) = q.

export const WARP_MAX = 33;
export const GRID_SIZES = [2, 3, 4, 5, 7, 9, 13, 17, 25, 33];

export function defaultWarp(cols = 5, rows = 5, aspect = 16 / 9) {
  return { cols, rows, offsets: Array.from({ length: cols * rows }, () => [0, 0]), pins: [], radius: 0.25, aspect };
}

export function isIdentity(w) {
  if (!w) return true;
  const z = ([a, b]) => Math.abs(a) < 1e-6 && Math.abs(b) < 1e-6;
  const t = !w.bezier || !w.tangents || w.tangents.every(([a, b, c, d]) => z([a, b]) && z([c, d]));
  return t && w.offsets.every(z) && (w.pins || []).every((p) => z(p.off));
}

// Hermite-Basis
const h00 = (t) => 2 * t * t * t - 3 * t * t + 1;
const h10 = (t) => t * t * t - 2 * t * t + t;
const h01 = (t) => -2 * t * t * t + 3 * t * t;
const h11 = (t) => t * t * t - t * t;

/** Ableitungen der Gitter-Verschiebung je Knoten (pro Zelle): Catmull-Rom plus optionale Bézier-Anfasser. */
function gridDerivs(w) {
  const { cols, rows, offsets } = w;
  const G = (x, y) => offsets[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
  const n = cols * rows;
  const mx = new Array(n), my = new Array(n), mxy = new Array(n);
  const tan = w.bezier && w.tangents?.length === n ? w.tangents : null;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y * cols + x, a = G(x + 1, y), b = G(x - 1, y), c = G(x, y + 1), d = G(x, y - 1);
    mx[i] = [(a[0] - b[0]) / 2, (a[1] - b[1]) / 2];
    my[i] = [(c[0] - d[0]) / 2, (c[1] - d[1]) / 2];
    if (tan) { mx[i][0] += tan[i][0]; mx[i][1] += tan[i][1]; my[i][0] += tan[i][2]; my[i][1] += tan[i][3]; }
  }
  const M = (arr, x, y) => arr[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const a = M(mx, x, y + 1), b = M(mx, x, y - 1);
    mxy[y * cols + x] = [(a[0] - b[0]) / 2, (a[1] - b[1]) / 2];
  }
  return { mx, my, mxy };
}

/** Versatz nur aus dem Gitter (bikubisch nach Hermite; ohne Anfasser identisch mit Catmull-Rom). */
export function gridOffset(w, u, v, D = gridDerivs(w), out = [0, 0]) {
  const { cols, rows, offsets } = w;
  const gx = Math.min(1, Math.max(0, u)) * (cols - 1), gy = Math.min(1, Math.max(0, v)) * (rows - 1);
  const ix = Math.min(cols - 2, Math.floor(gx)), iy = Math.min(rows - 2, Math.floor(gy));
  const tx = gx - ix, ty = gy - iy;
  const tx2 = tx * tx, tx3 = tx2 * tx, ty2 = ty * ty, ty3 = ty2 * ty;
  const bx0 = 2 * tx3 - 3 * tx2 + 1, bx1 = -2 * tx3 + 3 * tx2, dx0 = tx3 - 2 * tx2 + tx, dx1 = tx3 - tx2;
  const by0 = 2 * ty3 - 3 * ty2 + 1, by1 = -2 * ty3 + 3 * ty2, dy0 = ty3 - 2 * ty2 + ty, dy1 = ty3 - ty2;
  let ou = 0, ov = 0;
  for (let j = 0; j < 2; j++) {
    const by = j ? by1 : by0, dy = j ? dy1 : dy0;
    for (let i = 0; i < 2; i++) {
      const bx = i ? bx1 : bx0, dx = i ? dx1 : dx0;
      const k = (iy + j) * cols + ix + i;
      const P = offsets[k], X = D.mx[k], Y = D.my[k], XY = D.mxy[k];
      const a = bx * by, b = dx * by, c = bx * dy, d = dx * dy;
      ou += a * P[0] + b * X[0] + c * Y[0] + d * XY[0];
      ov += a * P[1] + b * X[1] + c * Y[1] + d * XY[1];
    }
  }
  out[0] = ou; out[1] = ov;
  return out;
}

/** Bézier-Anfasser eines Gitterpunkts in Bildkoordinaten (ohne freie Punkte): rechts, links, unten, oben. */
export function bezierHandles(w, i) {
  const D = gridDerivs(w);
  const [bu, bv] = gridBase(w, i);
  const o = w.offsets[i];
  const pu = bu + o[0], pv = bv + o[1];
  const cw = 1 / (w.cols - 1), ch = 1 / (w.rows - 1);
  const dx = [cw + D.mx[i][0], D.mx[i][1]], dy = [D.my[i][0], ch + D.my[i][1]];
  return { node: [pu, pv], right: [pu + dx[0] / 3, pv + dx[1] / 3], left: [pu - dx[0] / 3, pv - dx[1] / 3], down: [pu + dy[0] / 3, pv + dy[1] / 3], up: [pu - dy[0] / 3, pv - dy[1] / 3] };
}

/** Anfasser auf Position (hu, hv) setzen; der Gegenanfasser spiegelt sich. which: right|left|down|up */
export function setBezierHandle(w, i, which, hu, hv) {
  const n = w.cols * w.rows;
  if (!w.tangents || w.tangents.length !== n) w.tangents = Array.from({ length: n }, () => [0, 0, 0, 0]);
  const saved = w.bezier; w.bezier = false; // Catmull-Rom-Anteil ohne Anfasser
  const D = gridDerivs(w);
  w.bezier = saved;
  const [bu, bv] = gridBase(w, i);
  const o = w.offsets[i];
  const pu = bu + o[0], pv = bv + o[1];
  const s = which === 'left' || which === 'up' ? -3 : 3;
  const d = [(hu - pu) * s, (hv - pv) * s];
  if (which === 'right' || which === 'left') {
    w.tangents[i][0] = d[0] - 1 / (w.cols - 1) - D.mx[i][0];
    w.tangents[i][1] = d[1] - D.mx[i][1];
  } else {
    w.tangents[i][2] = d[0] - D.my[i][0];
    w.tangents[i][3] = d[1] - 1 / (w.rows - 1) - D.my[i][1];
  }
}

/** Wendland-C2-Kern, 1 im Zentrum, 0 ab Abstand 1. */
export const kernel = (t) => (t >= 1 ? 0 : (1 - t) ** 4 * (4 * t + 1));

/** Gewichte der Pins: Gesamtversatz an jedem Pin = sein off. */
export function solvePins(w) {
  const pins = w.pins || [];
  const n = pins.length;
  if (!n) return [];
  const A = w.aspect || 16 / 9, R = w.radius || 0.25;
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * A, a[1] - b[1]) / R;
  const M = pins.map((pi) => pins.map((pj) => kernel(dist(pi.at, pj.at))));
  M.forEach((row, i) => { row[i] += 1e-9; });
  const D = gridDerivs(w);
  const rhs = pins.map((p) => { const g = gridOffset(w, p.at[0], p.at[1], D); return [p.off[0] - g[0], p.off[1] - g[1]]; });
  // Gauß mit Pivotsuche, zwei rechte Seiten
  const a = M.map((row, i) => [...row, rhs[i][0], rhs[i][1]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / d;
      if (f) for (let k = c; k < n + 2; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => [row[n] / row[i], row[n + 1] / row[i]]);
}

/**
 * Auswerter für eine Verzerrung. Einmal erzeugen, dann oft auswerten
 * (die Pin-Gewichte werden dabei nur einmal gelöst).
 */
export function makeWarp(w) {
  if (!w) return { offset: () => [0, 0], forward: (u, v) => [u, v], inverse: (u, v) => [u, v], identity: true };
  const pins = w.pins || [];
  const weights = solvePins(w);
  const A = w.aspect || 16 / 9, R = w.radius || 0.25;
  const D = gridDerivs(w);
  // Pins in Zellen der Größe ihrer Reichweite einsortieren: je Auswertung nur die Nachbarzellen prüfen
  const buckets = new Map();
  pins.forEach((p, i) => {
    const bu = Math.floor((p.at[0] * A) / R), bv = Math.floor(p.at[1] / R);
    const key = bu * 4096 + bv;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  const tmp = [0, 0];
  const offsetInto = (u, v, out) => {
    gridOffset(w, u, v, D, out);
    if (!pins.length) return out;
    const cu = Math.floor((u * A) / R), cv = Math.floor(v / R);
    for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
      const list = buckets.get((cu + du) * 4096 + cv + dv);
      if (!list) continue;
      for (const i of list) {
        const t = Math.hypot((u - pins[i].at[0]) * A, v - pins[i].at[1]) / R;
        if (t < 1) { const k = (1 - t) ** 4 * (4 * t + 1); out[0] += weights[i][0] * k; out[1] += weights[i][1] * k; }
      }
    }
    return out;
  };
  const offset = (u, v) => offsetInto(u, v, [0, 0]);
  const forward = (u, v) => { offsetInto(u, v, tmp); return [u + tmp[0], v + tmp[1]]; };
  // Newton-Verfahren mit numerischer Ableitung: auch bei starken, örtlich begrenzten Korrekturen stabil.
  // start: Schätzung (z. B. Lösung des Nachbarpixels), dann reichen meist 1-2 Schritte.
  const o = [0, 0], ou = [0, 0], ov = [0, 0];
  const inverse = (qu, qv, iterations = 12, start = null) => {
    let u = start ? start[0] : qu, v = start ? start[1] : qv;
    const e = 1e-4;
    for (let i = 0; i < iterations; i++) {
      offsetInto(u, v, o);
      const ru = u + o[0] - qu, rv = v + o[1] - qv;
      if (Math.abs(ru) + Math.abs(rv) < 1e-7) break;
      offsetInto(u + e, v, ou); offsetInto(u, v + e, ov);
      const a = 1 + (ou[0] - o[0]) / e, b = (ov[0] - o[0]) / e, c = (ou[1] - o[1]) / e, d = 1 + (ov[1] - o[1]) / e;
      const det = a * d - b * c;
      if (Math.abs(det) < 1e-6) { u = qu - o[0]; v = qv - o[1]; continue; } // Faltung: einfacher Schritt
      let su = (d * ru - b * rv) / det, sv = (-c * ru + a * rv) / det;
      const len = Math.hypot(su, sv);
      if (len > 0.05) { su *= 0.05 / len; sv *= 0.05 / len; }
      u -= su; v -= sv;
    }
    return [u, v];
  };
  return { offset, offsetInto, forward, inverse, weights, identity: isIdentity(w) };
}

/** Versatz an Stelle (u, v), beide 0..1. */
export const evalOffset = (w, u, v) => makeWarp(w).offset(u, v);
/** Wohin wandert der Bildpunkt (u, v)? */
export const forward = (w, u, v) => makeWarp(w).forward(u, v);
/** Umkehrung per Fixpunkt-Iteration: zu Ausgabestelle q die Quellstelle p. */
export const inverse = (w, qu, qv, iterations) => makeWarp(w).inverse(qu, qv, iterations);

/**
 * Umkehrtabelle für die Ausgabe: für jede Zelle (Mitte) die Verschiebung p - q, als RG-Paare.
 * Die GPU liest sie mit linearer Interpolation, damit gibt es keine Grenze für Gitter und Pins.
 */
export function inverseMap(w, mw = 240, mh = 135) {
  const ev = makeWarp(w);
  const out = new Float32Array(mw * mh * 2);
  for (let j = 0; j < mh; j++) {
    const qv = (j + 0.5) / mh;
    for (let i = 0; i < mw; i++) {
      const qu = (i + 0.5) / mw;
      const k = (j * mw + i) * 2;
      // Startwert: Nachbar links, sonst Zeile darüber
      const start = i ? [qu + out[k - 2], qv + out[k - 1]] : j ? [qu + out[k - mw * 2], qv + out[k - mw * 2 + 1]] : null;
      const [pu, pv] = ev.inverse(qu, qv, 12, start);
      out[k] = pu - qu; out[k + 1] = pv - qv;
    }
  }
  return out;
}

/** Kleinste Flächenverzerrung (Jacobi-Determinante) über das Bild. Unter 0 faltet sich das Bild. */
export function minJacobian(w, nx = 64, ny = 36) {
  const ev = makeWarp(w);
  const e = 1e-4;
  let m = Infinity;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const u = i / nx, v = j / ny, o = ev.offset(u, v), ou = ev.offset(u + e, v), ov = ev.offset(u, v + e);
    const det = (1 + (ou[0] - o[0]) / e) * (1 + (ov[1] - o[1]) / e) - ((ov[0] - o[0]) / e) * ((ou[1] - o[1]) / e);
    if (det < m) m = det;
  }
  return m;
}

/** Gitter auf neue Größe umrechnen, die Form bleibt erhalten. Pins bleiben unverändert. */
export function resizeWarp(w, cols, rows) {
  const n = defaultWarp(cols, rows, w?.aspect);
  if (!w) return n;
  const D = gridDerivs(w);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) n.offsets[y * cols + x] = gridOffset(w, x / (cols - 1), y / (rows - 1), D);
  n.bezier = !!w.bezier; // Anfasser selbst passen nicht auf ein anderes Gitter

  n.pins = (w.pins || []).map((p) => ({ at: [...p.at], off: [...p.off] }));
  n.radius = w.radius ?? 0.25;
  return n;
}

/** Alte Projektdateien (nur Gitter) ergänzen. */
export function migrateWarp(w, aspect) {
  if (!w) return null;
  w.pins ||= [];
  w.radius ??= 0.25;
  w.aspect ??= aspect || 16 / 9;
  return w;
}

/** Basisposition (ohne Versatz) eines Gitterpunkts. */
export const gridBase = (w, i) => [(i % w.cols) / (w.cols - 1), Math.floor(i / w.cols) / (w.rows - 1)];

const f6 = (x) => x.toFixed(6);

/** GLSL (TouchDesigner): Gitter, Pins und Gewichte als Konstanten, dazu vec2 warpSource(vec2 q). */
export function warpGLSL(w) {
  const cols = w?.cols || 2, rows = w?.rows || 2;
  const offs = w?.offsets || [[0, 0], [0, 0], [0, 0], [0, 0]];
  const D = w ? gridDerivs(w) : { mx: offs, my: offs, mxy: offs };
  const pins = w?.pins?.length ? w.pins : [{ at: [0, 0], off: [0, 0] }];
  const weights = w?.pins?.length ? solvePins(w) : [[0, 0]];
  const vec = (a) => `vec2(${f6(a[0])}, ${f6(a[1])})`;
  const arr = (name, a) => `const vec2 ${name}[${a.length}] = vec2[](\n  ${a.map(vec).join(',\n  ')}\n);`;
  return `
const int WARP_COLS = ${cols};
const int WARP_ROWS = ${rows};
// Knotenwerte und Ableitungen (bikubisch nach Hermite)
${arr('WARP_GRID', offs)}
${arr('WARP_DX', D.mx)}
${arr('WARP_DY', D.my)}
${arr('WARP_DXY', D.mxy)}
const int WARP_PINS = ${pins.length};
const vec2 WARP_PIN_AT[${pins.length}] = vec2[](${pins.map((p) => vec(p.at)).join(', ')});
const vec2 WARP_PIN_W[${pins.length}] = vec2[](${weights.map(vec).join(', ')});
const float WARP_RADIUS = ${f6(w?.radius || 0.25)};
const float WARP_ASPECT = ${f6(w?.aspect || 16 / 9)};
const int WARP_ON = ${isIdentity(w) ? 0 : 1};
vec4 warpH(float t) { // h00, h01, h10, h11
  float t2 = t * t, t3 = t2 * t;
  return vec4(2.0 * t3 - 3.0 * t2 + 1.0, -2.0 * t3 + 3.0 * t2, t3 - 2.0 * t2 + t, t3 - t2);
}
vec2 warpOffset(vec2 p) {
  vec2 g = clamp(p, 0.0, 1.0) * vec2(float(WARP_COLS - 1), float(WARP_ROWS - 1));
  ivec2 i = min(ivec2(floor(g)), ivec2(WARP_COLS - 2, WARP_ROWS - 2));
  vec2 t = g - vec2(i);
  vec4 hx = warpH(t.x), hy = warpH(t.y);
  vec2 o = vec2(0.0);
  for (int jy = 0; jy < 2; jy++) for (int jx = 0; jx < 2; jx++) {
    int k = (i.y + jy) * WARP_COLS + i.x + jx;
    float bx = jx == 0 ? hx.x : hx.y, dx = jx == 0 ? hx.z : hx.w;
    float by = jy == 0 ? hy.x : hy.y, dy = jy == 0 ? hy.z : hy.w;
    o += bx * by * WARP_GRID[k] + dx * by * WARP_DX[k] + bx * dy * WARP_DY[k] + dx * dy * WARP_DXY[k];
  }
  for (int k = 0; k < WARP_PINS; k++) {
    float d = length((p - WARP_PIN_AT[k]) * vec2(WARP_ASPECT, 1.0)) / WARP_RADIUS;
    if (d < 1.0) o += WARP_PIN_W[k] * pow(1.0 - d, 4.0) * (4.0 * d + 1.0);
  }
  return o;
}
vec2 warpSource(vec2 q) {
  if (WARP_ON == 0) return q;
  vec2 p = q;
  const float e = 1e-4;
  for (int k = 0; k < 12; k++) {
    vec2 o = warpOffset(p);
    vec2 r = p + o - q;
    if (abs(r.x) + abs(r.y) < 1e-7) break;
    vec2 ou = (warpOffset(p + vec2(e, 0.0)) - o) / e;
    vec2 ov = (warpOffset(p + vec2(0.0, e)) - o) / e;
    mat2 J = mat2(1.0 + ou.x, ou.y, ov.x, 1.0 + ov.y); // Spalten: d/du, d/dv
    float det = determinant(J);
    if (abs(det) < 1e-6) { p = q - o; continue; }
    vec2 s = inverse(J) * r;
    float len = length(s);
    if (len > 0.05) s *= 0.05 / len;
    p -= s;
  }
  return p;
}
`;
}

/** Eigenständiger GLSL-TOP-Shader für TouchDesigner (Eingang 0 = Render, Eingang 1 = Maske optional). */
export function touchDesignerShader(w) {
  return `// Feinkorrektur aus Projection Studio. In einen GLSL TOP kopieren,
// Eingang 0: Render TOP des Projektors. Optional Eingang 1: Maske (wird multipliziert).
out vec4 fragColor;
${warpGLSL(w)}
void main() {
  vec2 q = vec2(vUV.s, 1.0 - vUV.t);          // Bildkoordinaten, v nach unten
  vec2 p = warpSource(q);
  if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, vec2(1.0)))) { fragColor = TDOutputSwizzle(vec4(0.0, 0.0, 0.0, 1.0)); return; }
  vec2 st = vec2(p.x, 1.0 - p.y);
  vec4 c = texture(sTD2DInputs[0], st);
#if TD_NUM_2D_INPUTS > 1
  c.rgb *= texture(sTD2DInputs[1], st).r;
#endif
  fragColor = TDOutputSwizzle(c);
}
`;
}
