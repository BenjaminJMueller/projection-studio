// Feinkorrektur (Ersatz für Stoner): Verzerrungsgitter pro Projektor.
// Jeder Gitterpunkt hat einen Versatz in normierten Bildkoordinaten (u nach rechts, v nach unten, 0..1).
// Zwischen den Punkten wird glatt (Catmull-Rom) interpoliert. Bildinhalt an Stelle p erscheint bei p + off(p).
// Für die Ausgabe wird umgekehrt gesucht: zu jedem Ausgabepixel q die Quelle p mit p + off(p) = q.

export const WARP_MAX = 9; // maximal 9 × 9 Punkte (Uniform-Array im Shader)

export function defaultWarp(cols = 5, rows = 5) {
  return { cols, rows, offsets: Array.from({ length: cols * rows }, () => [0, 0]) };
}

export function isIdentity(w) {
  return !w || w.offsets.every(([a, b]) => Math.abs(a) < 1e-6 && Math.abs(b) < 1e-6);
}

const cr = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);

/** Versatz an Stelle (u, v), beide 0..1. */
export function evalOffset(w, u, v) {
  if (!w) return [0, 0];
  const { cols, rows, offsets } = w;
  const G = (x, y) => offsets[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))];
  const gx = Math.min(1, Math.max(0, u)) * (cols - 1), gy = Math.min(1, Math.max(0, v)) * (rows - 1);
  const ix = Math.min(cols - 2, Math.floor(gx)), iy = Math.min(rows - 2, Math.floor(gy));
  const tx = gx - ix, ty = gy - iy;
  const out = [0, 0];
  for (let c = 0; c < 2; c++) {
    const r = [0, 1, 2, 3].map((k) => {
      const y = iy - 1 + k;
      return cr(G(ix - 1, y)[c], G(ix, y)[c], G(ix + 1, y)[c], G(ix + 2, y)[c], tx);
    });
    out[c] = cr(r[0], r[1], r[2], r[3], ty);
  }
  return out;
}

/** Wohin wandert der Bildpunkt (u, v)? */
export function forward(w, u, v) {
  const [du, dv] = evalOffset(w, u, v);
  return [u + du, v + dv];
}

/** Umkehrung per Fixpunkt-Iteration: zu Ausgabestelle q die Quellstelle p. */
export function inverse(w, qu, qv, iterations = 6) {
  let u = qu, v = qv;
  for (let i = 0; i < iterations; i++) {
    const [du, dv] = evalOffset(w, u, v);
    u = qu - du; v = qv - dv;
  }
  return [u, v];
}

/** Gitter auf neue Größe umrechnen, die Form bleibt erhalten. */
export function resizeWarp(w, cols, rows) {
  const n = defaultWarp(cols, rows);
  if (!w) return n;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) n.offsets[y * cols + x] = evalOffset(w, x / (cols - 1), y / (rows - 1));
  return n;
}

/** Basisposition (ohne Versatz) eines Gitterpunkts. */
export const gridBase = (w, i) => [(i % w.cols) / (w.cols - 1), Math.floor(i / w.cols) / (w.rows - 1)];

/** GLSL-Funktionen (GLSL ES 3.0 / TouchDesigner): vec2 warpSource(vec2 q) in Bildkoordinaten (v nach unten). */
export const WARP_GLSL = /* glsl */ `
uniform vec2 uWarp[${WARP_MAX * WARP_MAX}];
uniform int uWarpCols;
uniform int uWarpRows;
uniform int uWarpOn;
vec2 warpG(int x, int y) {
  x = clamp(x, 0, uWarpCols - 1);
  y = clamp(y, 0, uWarpRows - 1);
  return uWarp[y * uWarpCols + x];
}
vec2 warpCR(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
  return 0.5 * (2.0 * b + (-a + c) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t * t + (-a + 3.0 * b - 3.0 * c + d) * t * t * t);
}
vec2 warpOffset(vec2 p) {
  vec2 g = clamp(p, 0.0, 1.0) * vec2(float(uWarpCols - 1), float(uWarpRows - 1));
  ivec2 i = min(ivec2(floor(g)), ivec2(uWarpCols - 2, uWarpRows - 2));
  vec2 t = g - vec2(i);
  vec2 r0 = warpCR(warpG(i.x - 1, i.y - 1), warpG(i.x, i.y - 1), warpG(i.x + 1, i.y - 1), warpG(i.x + 2, i.y - 1), t.x);
  vec2 r1 = warpCR(warpG(i.x - 1, i.y), warpG(i.x, i.y), warpG(i.x + 1, i.y), warpG(i.x + 2, i.y), t.x);
  vec2 r2 = warpCR(warpG(i.x - 1, i.y + 1), warpG(i.x, i.y + 1), warpG(i.x + 1, i.y + 1), warpG(i.x + 2, i.y + 1), t.x);
  vec2 r3 = warpCR(warpG(i.x - 1, i.y + 2), warpG(i.x, i.y + 2), warpG(i.x + 1, i.y + 2), warpG(i.x + 2, i.y + 2), t.x);
  return warpCR(r0, r1, r2, r3, t.y);
}
vec2 warpSource(vec2 q) {
  if (uWarpOn == 0) return q;
  vec2 p = q;
  for (int k = 0; k < 6; k++) p = q - warpOffset(p);
  return p;
}
`;

/** Uniform-Werte für three.js / TD: flaches Array mit WARP_MAX² vec2. */
export function warpUniformArray(w) {
  const a = new Float32Array(WARP_MAX * WARP_MAX * 2);
  if (w) w.offsets.forEach(([du, dv], i) => { a[i * 2] = du; a[i * 2 + 1] = dv; });
  return a;
}

/** Eigenständiger GLSL-TOP-Shader für TouchDesigner (Eingang 0 = Render, Eingang 1 = Maske optional). */
export function touchDesignerShader(w) {
  const vals = [];
  for (let i = 0; i < WARP_MAX * WARP_MAX; i++) {
    const o = w?.offsets[i] || [0, 0];
    vals.push(`vec2(${o[0].toFixed(6)}, ${o[1].toFixed(6)})`);
  }
  const body = WARP_GLSL
    .replace(`uniform vec2 uWarp[${WARP_MAX * WARP_MAX}];`, `const vec2 uWarp[${WARP_MAX * WARP_MAX}] = vec2[](\n  ${vals.join(',\n  ')}\n);`)
    .replace('uniform int uWarpCols;', `const int uWarpCols = ${w?.cols || 2};`)
    .replace('uniform int uWarpRows;', `const int uWarpRows = ${w?.rows || 2};`)
    .replace('uniform int uWarpOn;', `const int uWarpOn = ${isIdentity(w) ? 0 : 1};`);
  return `// Feinkorrektur aus dem Projection Studio. In einen GLSL TOP kopieren,
// Eingang 0: Render TOP des Projektors. Optional Eingang 1: Maske (wird multipliziert).
out vec4 fragColor;
${body}
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
