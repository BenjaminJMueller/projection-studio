import fs from 'node:fs';
export function loadObjVertices(path) {
  const v = [];
  for (const l of fs.readFileSync(path, 'utf8').split('\n')) if (l.startsWith('v ')) v.push(l.trim().split(/\s+/).slice(1, 4).map(Number));
  return v;
}
// deterministischer Zufall
export function rng(seed = 1) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function gauss(r) { const u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
