// Simulierte Kamera für den Gesamttest: sieht das Modell von unten und „fotografiert“ das Licht der
// Projektoren mit ihren wahren Lösungen. Wird im Hauptfenster per import() geladen.
import { buildRaycaster } from '../../src/core/autocal.js';
import { patternValue, focusValue } from '../../src/shared/graycode.js';
import { projectPoint, cameraCenter, pixelRay } from '../../src/core/solver.js';
import { sub3, norm3, normalize3, cross3, scale3, matVec3, add3 } from '../../src/core/linalg.js';

function lookAt(C, target, up, f, cx, cy) {
  const z = normalize3(sub3(target, C));
  const x = normalize3(cross3(z, up));
  const y = cross3(z, x);
  const R = [x, y, z];
  return { R, t: scale3(matVec3(R, C), -1), f, cx, cy, mirror: false };
}

/** truths: { [projectorId]: { solution, resolution } } — so beleuchten die Projektoren wirklich. */
export function makeSimSource(model, truths, { w = 480, h = 270, hfov = 67, below = 2.4 } = {}) {
  const g = model.geometry;
  const intersect = buildRaycaster(g.attributes.position.array, g.index?.array || null);
  const ids = Object.keys(truths);
  // Blickziel: Stelle, an der sich die Bilder der ersten beiden Projektoren am nächsten kommen
  const surf = (t, step) => {
    const out = [], [W, H] = t.resolution, C = cameraCenter(t.solution.R, t.solution.t);
    for (let v = step / 2; v < H; v += step) for (let u = step / 2; u < W; u += step) {
      const hit = intersect(C, pixelRay(t.solution, u, v));
      if (hit) out.push(hit.point);
    }
    return out;
  };
  const f = w / (2 * Math.tan((hfov * Math.PI) / 360));
  const S = 2, n = w * h * S * S;
  let pts = null, cam = null;
  const maps = new Map();
  /** Kamera so aufstellen, dass sie die Bilder von idA und idB (wo sie sich am nächsten kommen) sieht. */
  function aimAt(idA, idB) {
    const a = surf(truths[idA], 120), b = surf(truths[idB], 120);
    let best = Infinity, aim = a[0];
    for (const p of a) for (const q of b) { const d = norm3(sub3(p, q)); if (d < best) { best = d; aim = scale3(add3(p, q), 0.5); } }
    cam = lookAt(sub3(aim, [0.3, below, 0.2]), aim, [0, 0, 1], f, w / 2 + 2, h / 2 - 1);
    const Cc = cameraCenter(cam.R, cam.t);
    pts = new Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let s = 0; s < S * S; s++) {
      const hit = intersect(Cc, pixelRay(cam, x + ((s % S) + 0.5) / S, y + (Math.floor(s / S) + 0.5) / S));
      pts[(y * w + x) * S * S + s] = hit ? hit.point : null;
    }
    maps.clear();
  }
  aimAt(ids[0], ids[1] || ids[0]);
  const lightMap = (id) => {
    if (maps.has(id)) return maps.get(id);
    const t = truths[id], pr = t.solution, [W, H] = t.resolution, Cp = cameraCenter(pr.R, pr.t);
    const m = new Float32Array(n * 2).fill(-1);
    for (let i = 0; i < n; i++) {
      const X = pts[i];
      if (!X) continue;
      const q = projectPoint(pr, X);
      if (q.z <= 0 || q.u < 0 || q.v < 0 || q.u >= W || q.v >= H) continue;
      const d = sub3(X, Cp), dist = norm3(d);
      const h2 = intersect(Cp, scale3(d, 1 / dist));
      if (!h2 || Math.abs(h2.t - dist) > 1e-3 * dist + 1e-4) continue;
      m[i * 2] = q.u; m[i * 2 + 1] = q.v;
    }
    maps.set(id, m);
    return m;
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const src = {
    width: w, height: h, video: null, pattern: null, aimAt,
    controls: () => ({}),
    auto: async () => {}, lock: async () => null, darker: async () => false, autofocus: async () => false,
    render() {
      const pt = src.pattern, out = new Uint8Array(w * h);
      const acc = new Float32Array(w * h);
      if (pt && pt.frame.kind !== 'black') {
        for (const id of pt.projectors) {
          if (!truths[id]) continue;
          const m = lightMap(id), lv = (pt.level ?? 255) / 255;
          for (let i = 0; i < w * h; i++) {
            let s = 0;
            for (let k = 0; k < S * S; k++) {
              const j = (i * S * S + k) * 2, u = m[j];
              if (u < 0) continue;
              const uu = Math.floor(u), vv = Math.floor(m[j + 1]);
              s += pt.frame.kind === 'focus' ? focusValue(uu, vv, pt.shift) : patternValue(pt.frame, uu, vv, pt.shift);
            }
            acc[i] += (lv * s) / (S * S);
          }
        }
      }
      for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(14 + 200 * acc[i] + 1.5 * rnd())));
      return out;
    },
    async frame() { await new Promise((r) => setTimeout(r, 5)); return { data: src.render(), w, h }; },
    async grab() { return src.render(); },
  };
  return src;
}
