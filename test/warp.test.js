import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWarp, evalOffset, forward, inverse, resizeWarp, isIdentity, touchDesignerShader, makeWarp, inverseMap } from '../src/shared/warp.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Nullgitter verschiebt nichts', () => {
  const w = defaultWarp(5, 5);
  assert.ok(isIdentity(w));
  assert.deepEqual(evalOffset(w, 0.37, 0.81), [0, 0]);
});

test('Gitterpunkte werden exakt getroffen, dazwischen glatt', () => {
  const w = defaultWarp(5, 5);
  w.offsets[2 * 5 + 2] = [0.01, -0.02]; // Mitte
  const o = evalOffset(w, 0.5, 0.5);
  near(o[0], 0.01); near(o[1], -0.02);
  const half = evalOffset(w, 0.625, 0.5);
  assert.ok(half[0] > 0 && half[0] < 0.01);
  near(evalOffset(w, 0, 0)[0], 0);
  near(evalOffset(w, 1, 1)[1], 0);
});

test('Umkehrung: inverse(forward(p)) = p bei üblichen Korrekturen', () => {
  const w = defaultWarp(5, 5);
  w.offsets[6] = [0.02, 0.01]; w.offsets[12] = [-0.015, 0.02]; w.offsets[18] = [0.01, -0.01];
  for (const [u, v] of [[0.2, 0.3], [0.5, 0.5], [0.77, 0.61], [0.05, 0.95]]) {
    const [qu, qv] = forward(w, u, v);
    const [pu, pv] = inverse(w, qu, qv);
    near(pu, u, 1e-4); near(pv, v, 1e-4);
  }
});

test('Größe ändern erhält die Form', () => {
  const w = defaultWarp(3, 3);
  w.offsets[4] = [0.02, 0.02];
  const big = resizeWarp(w, 9, 9);
  const a = evalOffset(w, 0.4, 0.55), b = evalOffset(big, 0.4, 0.55);
  near(a[0], b[0], 2e-3); near(a[1], b[1], 2e-3);
});

test('TouchDesigner-Shader enthält Gitterwerte und keine Uniforms', () => {
  const w = defaultWarp(3, 3);
  w.offsets[4] = [0.0125, -0.003];
  const src = touchDesignerShader(w);
  assert.match(src, /vec2\(0\.012500, -0\.003000\)/);
  assert.doesNotMatch(src, /uniform /);
  assert.match(src, /const int WARP_COLS = 3;/);
  assert.match(src, /vec2 warpSource/);
});

test('Große Gitter (33 × 33) werden glatt interpoliert', () => {
  const w = defaultWarp(33, 33);
  w.offsets[16 * 33 + 16] = [0.01, 0];
  near(evalOffset(w, 0.5, 0.5)[0], 0.01);
  near(evalOffset(w, 0.25, 0.5)[0], 0);
  assert.match(touchDesignerShader(w), /WARP_GRID\[1089\]/);
});

test('Freier Punkt: trifft sein Ziel exakt, wirkt nur in seiner Reichweite', () => {
  const w = defaultWarp(5, 5);
  w.pins.push({ at: [0.3, 0.4], off: [0.02, -0.01] });
  w.radius = 0.2;
  const ev = makeWarp(w);
  const o = ev.offset(0.3, 0.4);
  near(o[0], 0.02, 1e-6); near(o[1], -0.01, 1e-6);
  assert.deepEqual(ev.offset(0.9, 0.9), [0, 0]);
  const mid = ev.offset(0.33, 0.4);
  assert.ok(mid[0] > 0 && mid[0] < 0.02);
  assert.ok(!isIdentity(w));
});

test('Freie Punkte halten fest, wenn das Gitter daneben verzogen wird', () => {
  const w = defaultWarp(5, 5);
  w.pins.push({ at: [0.5, 0.5], off: [0, 0] }); // Anker
  w.offsets[2 * 5 + 2] = [0.03, 0.03]; // Gitterpunkt genau dort
  const o = makeWarp(w).offset(0.5, 0.5);
  near(o[0], 0, 1e-6); near(o[1], 0, 1e-6);
  // mehrere Pins dicht beieinander bleiben lösbar
  w.pins.push({ at: [0.501, 0.5], off: [0.01, 0] }, { at: [0.6, 0.55], off: [-0.01, 0.01] });
  const ev = makeWarp(w);
  near(ev.offset(0.6, 0.55)[0], -0.01, 1e-5);
});

test('Umkehrtabelle stimmt mit der Umkehrung überein', () => {
  const w = defaultWarp(5, 5);
  w.offsets[12] = [0.02, -0.01];
  w.pins.push({ at: [0.7, 0.3], off: [-0.01, 0.015] });
  const mw = 40, mh = 30, map = inverseMap(w, mw, mh), ev = makeWarp(w);
  const i = 13, j = 17, qu = (i + 0.5) / mw, qv = (j + 0.5) / mh;
  const [pu, pv] = ev.inverse(qu, qv);
  near(map[(j * mw + i) * 2], pu - qu, 1e-4);
  near(map[(j * mw + i) * 2 + 1], pv - qv, 1e-4);
  const [fu, fv] = ev.forward(pu, pv);
  near(fu, qu, 1e-4); near(fv, qv, 1e-4);
});

test('Bézier-Anfasser biegen die Linie, ohne den Knoten zu verschieben', async () => {
  const { bezierHandles, setBezierHandle } = await import('../src/shared/warp.js');
  const w = defaultWarp(3, 3);
  w.bezier = true;
  const h = bezierHandles(w, 4);
  near(h.right[0], 0.5 + 0.5 / 3); near(h.right[1], 0.5);
  setBezierHandle(w, 4, 'right', h.right[0], h.right[1] + 0.03); // Tangente nach unten kippen
  near(evalOffset(w, 0.5, 0.5)[1], 0); // Knoten bleibt
  assert.ok(evalOffset(w, 0.6, 0.5)[1] > 0.005); // rechts daneben nach unten gebogen
  assert.ok(evalOffset(w, 0.4, 0.5)[1] < -0.005); // links gespiegelt nach oben
  const h2 = bezierHandles(w, 4);
  near(h2.right[1], 0.53, 1e-9); near(h2.left[1], 0.47, 1e-9);
  w.bezier = false;
  near(evalOffset(w, 0.6, 0.5)[1], 0); // ausgeschaltet: wie vorher
});
