import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWarp, evalOffset, forward, inverse, resizeWarp, isIdentity, touchDesignerShader, WARP_GLSL } from '../src/shared/warp.js';

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
  assert.match(src, /const int uWarpCols = 3;/);
  assert.match(WARP_GLSL, /vec2 warpSource/);
});
