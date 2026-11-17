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
await win.waitForFunction(() => window.__app?.ready, null, { timeout: 30000 }).catch((e) => { console.error(errors); throw e; });
// Einführung beim ersten Start
await win.waitForSelector('#onboarding:not(.hidden) .sheet', { timeout: 10000 });
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(outDir, '00-einfuehrung-1.png') });
await win.click('#obNext');
await win.waitForTimeout(300);
if (!(await win.isDisabled('#obNext'))) errors.push('error: Weiter ohne Modell möglich');
await win.click('#obDemo');
await win.waitForFunction(() => window.__app.S.model && !document.querySelector('#obNext').disabled, null, { timeout: 30000 });
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

// Videowiedergabe: Testvideo auf dem Modell, Zeit muss laufen
await win.evaluate((f) => { window.__app.setVideo(f); }, path.join(root, 'test/fixtures/testvideo.mp4'));
await win.waitForFunction(() => window.__app.S.videoInfo?.duration > 0, null, { timeout: 15000 });
await win.evaluate(() => window.__app.setPlay('play'));
await outWin.waitForFunction(() => window.__out.video.currentTime > 0.5, null, { timeout: 15000 });
const t1 = await outWin.evaluate(() => window.__out.video.currentTime);
await outWin.waitForTimeout(1000);
const t2 = await outWin.evaluate(() => window.__out.video.currentTime);
await outWin.screenshot({ path: path.join(outDir, '08-ausgang-A-video.png') });
await win.click('#modes button[data-mode=output]');
await win.waitForTimeout(300);
await win.waitForFunction(() => Object.keys(window.__app.S.outStats).length > 0, null, { timeout: 10000 });
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '08b-wiedergabe.png') });
console.log('Leistung (Werkzeugleiste):', await win.evaluate(() => document.getElementById('fpsBadge')?.textContent));
console.log('Video läuft:', { t1: +t1.toFixed(2), t2: +t2.toFixed(2) });
if (!(t2 > t1 + 0.5 || t2 < t1)) errors.push('error: Video läuft im Ausgabefenster nicht');

// Playlist: zweites Video anhängen, Ausgabe muss nach dem ersten wechseln
await win.evaluate((f) => window.__app.addVideos([f]), path.join(root, 'test/fixtures/testvideo2.mp4'));
await win.waitForFunction(() => window.__app.S.project.playback.items.every((it) => it.duration > 0), null, { timeout: 15000 });
await win.evaluate(() => { const { S, jumpTo } = window.__app; jumpTo(0); S.play = { ...S.play, startedAt: Date.now() - 3200 }; window.__app.refresh(); });
await outWin.waitForFunction(() => /testvideo2/.test(window.__out.video.currentSrc) && window.__out.video.currentTime > 0.3, null, { timeout: 15000 })
  .catch(() => errors.push('error: Playlist wechselt nicht zum zweiten Video'));
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(outDir, '08c-playlist.png') });
// Bildrate begrenzen
await win.evaluate(() => { window.__app.S.project.playback.fps = 12; window.__app.refresh(); });
await win.waitForTimeout(4500);
const capped = await win.evaluate(() => Math.max(...Object.values(window.__app.S.outStats).filter((x) => x.playing).map((x) => x.fps)));
console.log('Bildrate bei 12 fps Grenze:', capped.toFixed(1));
if (!(capped <= 13.5)) errors.push(`error: Bildratengrenze greift nicht (${capped})`);
await win.evaluate(() => { window.__app.S.project.playback.fps = 0; window.__app.refresh(); });
// Ton: einschalten, Pegel muss ankommen (Testvideo 2 hat Stereo-Ton)
await win.evaluate(() => { const { S } = window.__app; S.project.audio.enabled = true; S.project.audio.speakers = 2; S.ui = { ...(S.ui || {}), audioMix: true, audioSetup: true }; window.__app.refresh(); });
await win.waitForTimeout(1500);
const audioInfo = await win.evaluate(() => ({ info: window.__app.audio.info(), levels: window.__app.audio.levels() }));
console.log('Ton:', JSON.stringify(audioInfo));
await win.evaluate(() => document.getElementById('mixer')?.scrollIntoView());
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '08d-ton.png') });
await win.evaluate(() => { window.__app.S.project.audio.enabled = false; window.__app.refresh(); });
// Leertaste: Pause
await win.click('#modes button[data-mode=output]');
await win.keyboard.press('Space');
await win.waitForTimeout(200);
if (await win.evaluate(() => window.__app.S.play.playing)) errors.push('error: Leertaste pausiert nicht');
// Feinkorrektur: Gitter verbiegen, Ausgabe muss sich ändern
await win.evaluate(() => { window.__app.S.project.view.outputMode = 'grid'; window.__app.refresh(); });
await outWin.waitForTimeout(800);
const before = await outWin.screenshot();
await win.click('#modes button[data-mode=calibrate]');
await win.click('[data-cal=warp]');
await win.evaluate(() => {
  const { S, refresh } = window.__app;
  const w = S.project.projectors[0].warp;
  w.offsets[12] = [0.04, -0.05]; // Mitte
  w.offsets[6] = [-0.02, 0.02];
  S.activeHandle = 12;
  refresh();
});
await win.waitForTimeout(800);
await win.screenshot({ path: path.join(outDir, '09-feinkorrektur.png') });
// Freier Punkt per Klick in die Vorschau setzen und ziehen, dann Bézier-Anfasser
{
  const box = await win.locator('#preview2d').boundingBox();
  const x = box.x + box.width * 0.72, y = box.y + box.height * 0.35;
  await win.mouse.move(x, y); await win.mouse.down();
  await win.mouse.move(x + 14, y + 6, { steps: 4 }); await win.mouse.up();
  const pins = await win.evaluate(() => window.__app.S.project.projectors[0].warp.pins.length);
  if (pins !== 1) errors.push(`error: freier Punkt nicht gesetzt (${pins})`);
  await win.evaluate(() => { const { S, refresh } = window.__app; const w = S.project.projectors[0].warp; w.bezier = true; S.activePin = null; S.activeHandle = 12; refresh(); });
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(outDir, '09a-feinkorrektur-punkte.png') });
  await win.evaluate(() => { const w = window.__app.S.project.projectors[0].warp; w.bezier = false; });
}
await outWin.screenshot({ path: path.join(outDir, '09b-ausgang-A-feinkorrektur.png') });
await win.click('#modes button[data-mode=output]');
await outWin.waitForTimeout(800);
const after = await outWin.screenshot({ path: path.join(outDir, '09c-ausgang-A-verzerrt.png') });
if (Buffer.compare(before, after) === 0) errors.push('error: Feinkorrektur wirkt nicht auf die Ausgabe');
// Testausgang auf denselben Bildschirm wie HDMI A legen: die beiden tauschen
{
  const r = await win.evaluate(async () => {
    const { S } = window.__app;
    const d = S.project.outputs[0].displayId;
    await window.__app.assignDisplay(S.project.outputs.find((o) => o.solo), d);
    return S.project.outputs.map((o) => [o.id, o.displayId]);
  });
  if (!(r.find((x) => x[0] === 'T')[1] != null && r.find((x) => x[0] === 'A')[1] == null)) errors.push('error: Bildschirmtausch ' + JSON.stringify(r));
  await win.waitForTimeout(1500);
  const solo = app.windows().find((w) => w !== win && !w.isClosed());
  if (solo) await solo.screenshot({ path: path.join(outDir, '10-testausgang.png') });
}
await win.evaluate(() => window.__app.toggleOutputs(false));

const sol = await win.evaluate(() => window.__app.S.project.projectors.slice(0, 4).map((p) => ({ id: p.id, rms: p.solution.rms, center: p.solution.center, quality: window.__app.S.results[p.id]?.quality })));
console.log(JSON.stringify({ result, sol }, null, 1));
// Mehr Projektoren: neunten anlegen, Ausgang C, Typ aus der Datenbank, eigener Typ
await win.click('#modes button[data-mode=setup]');
await win.click('#btnAddOutput');
await win.click('#btnAddProj');
await win.waitForTimeout(300);
const added = await win.evaluate(() => { const { S } = window.__app; const p = S.project.projectors[8]; return { n: S.project.projectors.length, id: p.id, output: p.output, q: p.quadrant, outputs: S.project.outputs.map((o) => o.id) }; });
console.log('Neuer Projektor:', JSON.stringify(added));
if (!(added.n === 9 && added.output === 'C')) errors.push('error: Projektor hinzufügen ' + JSON.stringify(added));
await win.evaluate(() => { const { S, refresh } = window.__app; const p = S.project.projectors[8]; p.ring = 'Wand Nord'; p.lens = 'db:benq-mw632st'; p.resolution = [1280, 800]; refresh(); });
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(outDir, '11-neunter-projektor.png') });
await win.selectOption('#paneSetup select[aria-label="Projektor-Typ"]', '__new');
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(outDir, '12-eigener-typ.png') });
const custom = await win.evaluate(() => window.__app.S.project.projectors[8].lens);
if (!custom.startsWith('custom:')) errors.push('error: eigener Typ ' + custom);
console.log('Konsolen-Fehler/Warnungen:', errors.length ? errors : 'keine');
await app.close();
if (errors.some((e) => e.startsWith('pageerror') || e.startsWith('error'))) process.exit(1);
