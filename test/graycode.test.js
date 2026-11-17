import test from 'node:test';
import assert from 'node:assert/strict';
import { toGray, fromGray, patternPlan, patternValue, stripeRuns, GrayDecoder, filterCells, thinCells, focusValue, focusMeasure, SHARP_LIMIT } from '../src/shared/graycode.js';

// Simulierte Kamera: sieht das Projektorbild über eine Homographie (Projektor → Kamera),
// mit Fremdlicht, ungleicher Oberfläche, Unschärfe, Rauschen und Gamma.
export function makeCamera({ w = 320, h = 240, H, blur = 0, ambient = 20, noise = 2, seed = 1, gain = 200 }) {
  const Hi = inv3(H);
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5);
  return (valueAt) => {
    const lin = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      // 3×3 Überabtastung je Kamerapixel
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const X = x + (sx + 0.5) / 3, Y = y + (sy + 0.5) / 3;
        const q = mul3(Hi, [X, Y, 1]);
        const u = q[0] / q[2], v = q[1] / q[2];
        s += valueAt(u, v);
      }
      const albedo = 0.6 + 0.4 * Math.cos(x / 37) * Math.cos(y / 53);
      lin[y * w + x] = (s / 9) * albedo;
    }
    const img = blur ? boxBlur(lin, w, h, blur) : lin;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(255 * ((ambient + gain * img[i]) / 255) ** (1 / 1.2) + noise * rnd())));
    return out;
  };
}
function boxBlur(a, w, h, r) {
  let cur = a;
  for (let pass = 0; pass < 2; pass++) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += cur[y * w + xx]; n++; } } t[y * w + x] = s / n; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += t[yy * w + x]; n++; } } o[y * w + x] = s / n; }
    cur = o;
  }
  return cur;
}
const mul3 = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2], M[3] * p[0] + M[4] * p[1] + M[5] * p[2], M[6] * p[0] + M[7] * p[1] + M[8] * p[2]];
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
const project = (H, u, v) => { const q = mul3(H, [u, v, 1]); return [q[0] / q[2], q[1] / q[2]]; };

function run(cam, W, Hh, shift, opt) {
  const plan = patternPlan(W, Hh, shift);
  const dec = new GrayDecoder(opt.w, opt.h, plan);
  for (const f of plan.frames) {
    dec.add(f, cam((u, v) => (u < 0 || v < 0 || u >= W || v >= Hh ? 0 : patternValue(f, Math.floor(u), Math.floor(v), shift))));
  }
  return dec;
}

test('Gray-Code: Umrechnung und Streifen', () => {
  for (let n = 0; n < 2048; n++) assert.equal(fromGray(toGray(n)), n);
  for (let n = 1; n < 2048; n++) { const x = toGray(n) ^ toGray(n - 1); assert.equal(x & (x - 1), 0); } // genau ein Bit ändert sich
  const plan = patternPlan(1920, 1080, 3);
  assert.deepEqual(plan.bits, [8, 8]);
  assert.equal(plan.frames.length, 2 + 2 * 16);
  const f = plan.frames[5];
  const runs = stripeRuns(f, 1920, 3);
  for (let u = 0; u < 1920; u += 7) assert.equal(runs.some(([a, b]) => u >= a && u < b) ? 1 : 0, patternValue(f, u, 0, 3));
  assert.ok(focusValue(0, 0, 3) !== focusValue(8, 0, 3));
});

// Kamera schräg auf einen Teil des Projektorbilds (Teilabdeckung)
const HOM = [0.22, 0.03, -40, -0.02, 0.24, -20, 0.00002, 0.00004, 1];

test('Gray-Code: Zellen werden genau gefunden, auch wenn die Kamera nur einen Teil sieht', () => {
  const opt = { w: 320, h: 240, H: HOM };
  const dec = run(makeCamera(opt), 1280, 800, 3, opt);
  const a = dec.assess();
  // Kamera ist weit weg (0,22 Kamerapixel je Projektorpixel): feinste Streifen sind zu fein, das ist keine Unschärfe
  assert.ok(Math.abs(a.scale - 0.23) < 0.04, `Maßstab ${a.scale}`);
  assert.ok(a.sharp > SHARP_LIMIT && a.drop >= 1, JSON.stringify(a));
  const cells = filterCells(dec.cells(dec.assess().drop));
  assert.ok(cells.length > 100, `nur ${cells.length} Zellen`);
  let se = 0, worst = 0;
  for (const c of cells) {
    const [x, y] = project(HOM, c.u, c.v);
    const e = Math.hypot(x - c.x, y - c.y);
    se += e * e; worst = Math.max(worst, e);
  }
  const rms = Math.sqrt(se / cells.length);
  assert.ok(rms < 0.25 && worst < 1, `rms ${rms}, max ${worst}`);
  // Teilabdeckung: nur der sichtbare Bereich des Projektorbilds hat Zellen
  const us = cells.map((c) => c.u);
  assert.ok(Math.min(...us) > 50 && cells.length < 80 * 50 * 0.8, `${Math.min(...us)} ${cells.length}`);
  assert.ok(thinCells(cells, 1280, 800, 50).length <= 60);
});

test('Gray-Code: Unschärfe wird erkannt und örtlich angezeigt', () => {
  const sharp = run(makeCamera({ w: 320, h: 240, H: HOM }), 1280, 800, 3, { w: 320, h: 240 }).sharpness().value;
  const blurred = run(makeCamera({ w: 320, h: 240, H: HOM, blur: 3 }), 1280, 800, 3, { w: 320, h: 240 });
  const b = blurred.sharpness().value;
  assert.ok(sharp > 0.5 && b < SHARP_LIMIT && sharp > SHARP_LIMIT + 0.15, `scharf ${sharp}, unscharf ${b}`);
  const map = blurred.sharpnessMap();
  assert.equal(map.values.length, map.tx * map.ty);
  assert.ok(map.values.some((v) => v === null) && map.values.some((v) => v !== null));
  // gröbere Zellen funktionieren trotz Unschärfe noch
  assert.ok(filterCells(blurred.cells(blurred.assess().drop + 1)).length > 20);
});

test('Fokusmaß: scharfes Schachbrett hat höheren Wert als unscharfes', () => {
  const val = (u, v) => (u < 0 || v < 0 || u >= 1280 || v >= 800 ? 0 : focusValue(Math.floor(u), Math.floor(v), 3));
  const a = focusMeasure(makeCamera({ w: 320, h: 240, H: HOM })(val), 320, 240);
  const b = focusMeasure(makeCamera({ w: 320, h: 240, H: HOM, blur: 2 })(val), 320, 240);
  assert.ok(a > 1.6 * b, `${a} vs ${b}`);
});
