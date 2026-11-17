// App starten, Konsole prüfen, Demo-Kalibrierung einspielen, Screenshots machen.
// Aufruf: xvfb-run -a node test/e2e/smoke.mjs [ausgabeordner]
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const outDir = process.argv[2] || path.join(root, 'test-output');
fs.mkdirSync(outDir, { recursive: true });

const userData = fs.mkdtempSync('/tmp/kalib-');
const app = await electron.launch({
  // APP_EXEC = fertig gebaute App testen, sonst aus dem Quellcode starten
  executablePath: process.env.APP_EXEC || require(path.join(root, 'node_modules/electron')),
  args: [...(process.env.APP_EXEC ? [] : [root]), '--no-sandbox', `--user-data-dir=${userData}`],
  cwd: root,
});
const errors = [];
const win = await app.firstWindow();
win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await win.setViewportSize({ width: 1600, height: 960 }).catch(() => {});
if (process.env.THEME) await win.emulateMedia({ colorScheme: process.env.THEME });
await win.waitForFunction(() => window.__app?.ready && window.__app.S.model, null, { timeout: 30000 }).catch((e) => { console.error(errors); throw e; });
// Einführung beim ersten Start
await win.waitForSelector('#onboarding:not(.hidden) .sheet', { timeout: 10000 });
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(outDir, '00-einfuehrung-1.png') });
await win.click('#obNext');
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '00-einfuehrung-2.png') });
await win.click('#obNext');
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '00-einfuehrung-3.png') });
await win.click('#obNext');
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '01-start.png') });

// Demo: synthetische Kalibrierung für P1 und P2 (aus bekannten Kameras erzeugt)
const result = await win.evaluate(async () => {
  const { S, scheduleSolve, refresh } = window.__app;
  const { projectPoint } = await import('../core/solver.js');
  const V = S.model.featureVertices;
  const mk = (C, target, up) => {
    const sub = (a, b) => a.map((x, i) => x - b[i]);
    const nrm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const z = nrm(sub(target, C)), x = nrm(cross(z, up)), y = cross(z, x);
    const R = [x, y, z];
    const t = R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2]));
    return { R, t, f: 0.5 * 1920, cx: 965, cy: 1.186 * 1080, mirror: false };
  };
  // Innenring wie im echten Aufbau: jeder Beamer steht an der Säule und schaut frontal auf eine Wand
  // (nicht in eine Ecke) und trifft unten fast die ganze Wandbreite.
  const col = [2.0, 0, -1.8];
  const inner = (dir, off, h, ty) => mk([col[0] + dir[0] * off, h, col[2] + dir[2] * off], [col[0] + dir[0] * 4, ty, col[2] + dir[2] * 4], dir.map((x) => -x));
  const cams = {
    // Bildunterkante liegt auf der oberen Kante der gegenüberliegenden Wand (Ecke Wand/Decke, im Modell y ≈ 1,3),
    // darüber nur Wölbung. Die Wände selbst werden nicht bespielt.
    P1: inner([0, 0, -1], 1.0, -2.0, 0.65),
    P2: inner([1, 0, 0], 1.0, -1.6, 0.4),
    P3: inner([-1, 0, 0], 1.0, -1.6, 0.4),
    P4: inner([0, 0, 1], 1.0, -2.0, 0.65),
  };
  const out = {};
  for (const [id, cam] of Object.entries(cams)) {
    const p = S.project.projectors.find((x) => x.id === id);
    const vis = [];
    for (let i = 0; i < V.length; i += 3) {
      const X = [V[i], V[i + 1], V[i + 2]];
      const q = projectPoint(cam, X);
      if (q.z > 0 && q.u > 60 && q.u < 1860 && q.v > 60 && q.v < 1020) vis.push({ X, q });
    }
    // 7 gut verteilte Punkte: nächstgelegene zu einem 3x3-Raster
    const targets = [[0.12, 0.15], [0.5, 0.12], [0.88, 0.15], [0.15, 0.5], [0.85, 0.55], [0.2, 0.88], [0.8, 0.85]];
    p.points = targets.map(([a, b], k) => {
      let best = vis[0], bd = 1e9;
      for (const v of vis) { const d = Math.hypot(v.q.u - a * 1920, v.q.v - b * 1080); if (d < bd) { bd = d; best = v; } }
      return { id: k + 1, world: best.X, image: [best.q.u + (Math.random() - 0.5) * 2, best.q.v + (Math.random() - 0.5) * 2], enabled: true, snapped: true };
    });
    p.nextPointId = 8;
    out[id] = { visible: vis.length };
    scheduleSolve(p);
  }
  S.activePointId = 3;
  refresh();
  return out;
});
await win.waitForFunction(() => window.__app.S.project.projectors.slice(0, 4).every((p) => p.solution), null, { timeout: 30000 });
await win.waitForTimeout(800);
await win.screenshot({ path: path.join(outDir, '02-kalibriert.png') });

// Nur 4 Punkte aktiv: Anleitung und Vorschläge für den nächsten Punkt erscheinen
await win.evaluate(() => { const { S, scheduleSolve, refresh } = window.__app; const p = S.project.projectors[0]; p.points.forEach((x, i) => { x.enabled = i < 4; }); scheduleSolve(p); refresh(); });
await win.waitForTimeout(1500);
await win.screenshot({ path: path.join(outDir, '02b-vorschlaege.png') });
await win.evaluate(() => { const { S, scheduleSolve, refresh } = window.__app; const p = S.project.projectors[0]; p.points.forEach((x) => { x.enabled = true; }); scheduleSolve(p); refresh(); });
await win.waitForTimeout(1000);

// Projektor-Sicht
await win.click('#viewMode button[data-view=projector]');
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(outDir, '03-projektorsicht.png') });
await win.click('#viewMode button[data-view=orbit]');

// Einrichten
await win.click('#modes button[data-mode=setup]');
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '03b-einrichten.png') });

// Blending berechnen
await win.click('#modes button[data-mode=blend]');
await win.click('#btnComputeBlend');
await win.waitForFunction(() => Object.keys(window.__app.S.blendImages).length >= 4, null, { timeout: 60000 });
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '04-blending.png') });
await win.click('#modes button[data-mode=output]');
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '04b-ausgabe.png') });
await win.click('#modes button[data-mode=calibrate]');
await win.click('#btnHelp');
await win.waitForTimeout(250);
await win.screenshot({ path: path.join(outDir, '04c-hilfe.png') });
await win.click('#btnHelp');
const blendUrl = await win.evaluate(() => window.__app.S.blendImages.P1.previewUrl);
fs.writeFileSync(path.join(outDir, '05-maske-P1.png'), Buffer.from(blendUrl.split(',')[1], 'base64'));

// Ausgabefenster (HDMI A) auf dem einzigen Bildschirm öffnen
await win.evaluate(async () => {
  const { S, toggleOutputs } = window.__app;
  S.project.outputs[0].displayId = S.displays[0].id;
  S.project.view.showMask = true;
  await toggleOutputs(true);
});
const outWin = await app.waitForEvent('window', { timeout: 20000 });
outWin.on('pageerror', (e) => errors.push(`pageerror(output): ${e.message}`));
outWin.on('console', (m) => { if (m.type() === 'error') errors.push(`error(output): ${m.text()}`); });
await outWin.waitForTimeout(2500);
await outWin.screenshot({ path: path.join(outDir, '06-ausgang-A.png') });
await win.evaluate(() => { window.__app.S.project.view.outputMode = 'grid'; window.__app.refresh(); });
await outWin.waitForTimeout(1500);
await outWin.screenshot({ path: path.join(outDir, '07-ausgang-A-raster.png') });
await win.evaluate(() => window.__app.toggleOutputs(false));

const sol = await win.evaluate(() => window.__app.S.project.projectors.slice(0, 4).map((p) => ({ id: p.id, rms: p.solution.rms, center: p.solution.center, quality: window.__app.S.results[p.id]?.quality })));
console.log(JSON.stringify({ result, sol }, null, 1));
console.log('Konsolen-Fehler/Warnungen:', errors.length ? errors : 'keine');
await app.close();
if (errors.some((e) => e.startsWith('pageerror') || e.startsWith('error'))) process.exit(1);
