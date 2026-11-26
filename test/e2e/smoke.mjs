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
// Direkt angeschlossen: je Ausgang ein Projektor, höchstens 4 HDMI-Ausgänge
await win.click('#onboarding .seg-conn [data-conn=direct]');
await win.waitForTimeout(300);
{
  const c = await win.evaluate(() => ({ outs: window.__app.S.project.outputs.filter((o) => !o.solo).map((o) => o.layout), first: window.__app.S.project.projectors.slice(0, 5).map((p) => p.output) }));
  if (c.outs.join() !== '1x1,1x1,1x1,1x1' || c.first.join() !== 'A,B,C,D,') errors.push('error: Anschluss direkt ' + JSON.stringify(c));
}
await win.screenshot({ path: path.join(outDir, '00-einfuehrung-3b-direkt.png') });
await win.click('#onboarding .seg-conn [data-conn=controller]');
await win.waitForTimeout(300);
await win.click('#obNext');
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '00-einfuehrung-4.png') });
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

// Legende: ein falsch gesetzter Punkt wird rot markiert und erklärt
{
  const orig = await win.evaluate(() => { const { S, scheduleSolve, refresh } = window.__app; const p = S.project.projectors[0]; const pt = p.points[1]; const o = [...pt.image]; pt.image = [o[0] + 40, o[1] - 30]; scheduleSolve(p); refresh(); return o; });
  await win.waitForTimeout(1500);
  const leg = await win.locator('#legend3d').innerText();
  if (!/passt nicht/.test(leg)) errors.push(`error: Legende erklärt rote Markierung nicht (${leg})`);
  await win.screenshot({ path: path.join(outDir, '02c-legende.png') });
  await win.evaluate((o) => { const { S, scheduleSolve, refresh } = window.__app; const p = S.project.projectors[0]; p.points[1].image = o; scheduleSolve(p); refresh(); }, orig);
  await win.waitForTimeout(1000);
}

// Gruppen: neue Gruppe anlegen, benennen, Projektor hineinziehen
{
  await win.click('#btnAddGroup');
  await win.fill('.side-label-edit', 'Empore');
  await win.press('.side-label-edit', 'Enter');
  await win.locator('.proj-group[data-group="außen"] .proj-row').last().dragTo(win.locator('.proj-group[data-group="Empore"]'));
  await win.waitForTimeout(300);
  const ring = await win.evaluate(() => window.__app.S.project.projectors.filter((p) => p.ring === 'Empore').length);
  if (ring !== 1) errors.push(`error: Projektor nicht in neue Gruppe verschoben (${ring})`);
  await win.locator('.proj-row').first().hover();
  await win.screenshot({ path: path.join(outDir, '02d-gruppen.png') });
  await win.evaluate(() => { const { S, refresh } = window.__app; S.project.projectors.forEach((p) => { if (p.ring === 'Empore') p.ring = 'außen'; }); S.project.groups = S.project.groups.filter((g) => g !== 'Empore'); refresh(); });
}

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

// Maus springt mit: Klick auf eine Modellecke setzt Punkt, Maus landet auf dessen Stelle am Ausgang
{
  await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('cursor:move'); globalThis.__cur = []; ipcMain.handle('cursor:move', (_e, p) => { globalThis.__cur.push(p); return true; }); });
  await win.click('#modes button[data-mode=calibrate]');
  const target = await win.evaluate(() => {
    const { S, view, refresh } = window.__app;
    S.activeId = 'P1'; S.activePointId = null; S.project.view.mouseFollow = true; S.project.view.showVertices = true;
    refresh();
    const V = S.model.featureVertices, r = view.canvas.getBoundingClientRect(), cam = view.camera;
    const used = new Set(S.project.projectors[0].points.map((p) => p.world.join()));
    // eine sichtbare, freie Ecke nahe der Bildmitte
    let best = null;
    for (let i = 0; i < V.length; i += 3) {
      const X = [V[i], V[i + 1], V[i + 2]];
      if (used.has(X.join())) continue;
      const v = new cam.position.constructor(...X).project(cam);
      if (Math.abs(v.x) > 0.5 || Math.abs(v.y) > 0.5 || v.z > 1) continue;
      const sx = r.left + ((v.x + 1) / 2) * r.width, sy = r.top + ((1 - v.y) / 2) * r.height;
      const hit = view.pick({ clientX: sx, clientY: sy }, true);
      if (hit?.snapped && hit.point.every((c, k) => Math.abs(c - X[k]) < 1e-6)) { best = { x: sx, y: sy }; break; }
    }
    return best;
  });
  if (!target) errors.push('error: keine anklickbare Modellecke gefunden');
  else {
    const n0 = await win.evaluate(() => window.__app.S.project.projectors[0].points.length);
    await win.mouse.click(target.x, target.y);
    await win.waitForTimeout(900);
    const r = await win.evaluate(() => { const { S } = window.__app; const p = S.project.projectors[0]; const pt = p.points.find((x) => x.id === S.activePointId); const d = S.displays.find((x) => x.id === S.project.outputs[0].displayId); return { n: p.points.length, image: pt?.image, bounds: d.bounds, q: p.quadrant }; });
    const cur = await app.evaluate(() => globalThis.__cur);
    const exp = { x: Math.round(r.bounds.x + (0.5 * (r.q % 2) + 0.5 * r.image[0] / 1920) * r.bounds.width), y: Math.round(r.bounds.y + (0.5 * Math.floor(r.q / 2) + 0.5 * r.image[1] / 1080) * r.bounds.height) };
    if (r.n !== n0 + 1) errors.push(`error: Klick ins Modell setzt keinen Punkt (${n0} -> ${r.n})`);
    else if (!cur.length || Math.abs(cur.at(-1).x - exp.x) > 1 || Math.abs(cur.at(-1).y - exp.y) > 1) errors.push(`error: Maus springt nicht zum Punkt ${JSON.stringify(cur)} erwartet ${JSON.stringify(exp)}`);
    await win.screenshot({ path: path.join(outDir, '02e-kalibrierpunkte.png') });
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  }
}
// Standort vorgeben: übernimmt die gelöste Position, 3D zeigt die Toleranzkugel
{
  await win.evaluate(() => { const { S, refresh } = window.__app; S.activeId = 'P1'; refresh(); });
  await win.waitForTimeout(300);
  await win.click('#swPrior');
  await win.waitForTimeout(300);
  await win.click('#btnPriorTake');
  await win.waitForTimeout(1500);
  const r = await win.evaluate(() => { const p = window.__app.S.project.projectors[0]; return { prior: p.positionPrior, ok: !!p.solution, c: p.solution?.center }; });
  if (!r.prior || !r.ok || Math.hypot(...r.prior.center.map((v, i) => v - r.c[i])) > 0.1) errors.push('error: Standort vorgeben ' + JSON.stringify(r));
  await win.screenshot({ path: path.join(outDir, '02f-standort.png') });
  await win.click('#swPrior');
}
// Schnelle Zuordnung: P1 in HDMI B unten rechts, P8 tauscht, danach ist P2 gewählt
{
  await win.click('#modes button[data-mode=setup]');
  await win.evaluate(() => { const { S, refresh } = window.__app; S.activeId = 'P1'; refresh(); });
  await win.waitForTimeout(300);
  await win.locator('.quad.pick').nth(1).locator('button').nth(3).click();
  await win.waitForTimeout(300);
  const r = await win.evaluate(() => { const { S } = window.__app; return { p1: S.project.projectors[0].output + S.project.projectors[0].quadrant, p8: S.project.projectors[7].output + S.project.projectors[7].quadrant, active: S.activeId }; });
  if (r.p1 !== 'B3' || r.p8 !== 'A0' || r.active !== 'P2') errors.push('error: Schnelle Zuordnung ' + JSON.stringify(r));
  await win.screenshot({ path: path.join(outDir, '03c-zuordnung.png') });
  if (!(await win.locator('#selImageMode').count())) errors.push('error: Bildmodus fehlt beim EB-535W mit 1080p');
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await win.waitForTimeout(200);
  const back = await win.evaluate(() => window.__app.S.project.projectors[0].output + window.__app.S.project.projectors[0].quadrant);
  if (back !== 'A0') errors.push('error: Zuordnung nicht rückgängig ' + back);
}

// Kamera-Kalibrierung mit simulierter Kamera: P2 vergessen, über P1 als Bezug neu bestimmen
await win.click('#modes button[data-mode=calibrate]');
await win.evaluate(async (simUrl) => {
  const { makeSimSource } = await import(simUrl);
  const { S, camcal, refresh } = window.__app;
  const [ref, tgt, , p4] = S.project.projectors;
  window.__truth = JSON.parse(JSON.stringify(tgt.solution));
  const src = makeSimSource(S.model, { [ref.id]: { solution: ref.solution, resolution: ref.resolution }, [tgt.id]: { solution: window.__truth, resolution: tgt.resolution }, [p4.id]: { solution: p4.solution, resolution: p4.resolution } });
  window.__sim = src;
  camcal.useSource(src);
  tgt.points = []; tgt.solution = null;
  S.activeId = 'P2';
  refresh();
}, new URL('./simCamera.js', import.meta.url).href);
await win.evaluate(() => window.__app.camcal.open('P2'));
await win.waitForSelector('#camSheet:not(.hidden) #btnCamMeasure:not([disabled])', { timeout: 20000 });
await win.waitForTimeout(500);
await win.screenshot({ path: path.join(outDir, '14-kamera-1.png') });
await outWin.screenshot({ path: path.join(outDir, '14-kamera-fokusbild.png') });
const tCam = Date.now();
await win.click('#btnCamMeasure');
await win.waitForTimeout(1500);
await outWin.screenshot({ path: path.join(outDir, '14-kamera-muster.png') });
await win.waitForSelector('#btnCamApply:not([disabled])', { timeout: 180000 });
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(outDir, '14-kamera-2.png') });
const first = await win.evaluate(() => window.__app.camcal.state.result.report.filled);
// zweiter Kamera-Standort: zwischen P2 und P4, Bezug P4
await win.evaluate(() => window.__sim.aimAt('P2', 'P4'));
await win.click('#btnCamAnother');
await win.selectOption('#camSheet select', 'P4');
await win.waitForSelector('#btnCamMeasure:not([disabled])');
await win.click('#btnCamMeasure');
await win.waitForSelector('#btnCamApply:not([disabled])', { timeout: 180000 });
await win.waitForTimeout(400);
await win.screenshot({ path: path.join(outDir, '14-kamera-2b.png') });
const second = await win.evaluate(() => ({ filled: window.__app.camcal.state.result.report.filled, sessions: window.__app.camcal.state.sessions.length, msg: window.__app.camcal.state.message }));
console.log('Abdeckung:', first, '→', JSON.stringify(second));
if (!(second.sessions === 2 && second.filled > first)) errors.push('error: zweiter Kamera-Standort ' + JSON.stringify(second));
await win.click('#btnCamApply');
await win.waitForFunction(() => window.__app.S.project.projectors[1].solution, null, { timeout: 30000 });
const camRes = await win.evaluate(async () => {
  const { projectPoint } = await import('../core/solver.js');
  const { S } = window.__app;
  const p = S.project.projectors[1], pos = S.model.geometry.attributes.position.array;
  let se = 0, n = 0, worst = 0;
  for (let i = 0; i < pos.length; i += 3 * 29) {
    const X = [pos[i], pos[i + 1], pos[i + 2]];
    const a = projectPoint(window.__truth, X);
    if (a.z <= 0 || a.u < 0 || a.v < 0 || a.u >= p.resolution[0] || a.v >= p.resolution[1]) continue;
    const b = projectPoint(p.solution, X);
    const e = Math.hypot(a.u - b.u, a.v - b.v);
    se += e * e; n++; worst = Math.max(worst, e);
  }
  return { points: p.autoPoints.length, rms: Math.sqrt(se / n), worst, fit: p.solution.rms, mirror: p.solution.mirror, truthMirror: window.__truth.mirror };
});
console.log('Kamera-Kalibrierung:', JSON.stringify(camRes), `${((Date.now() - tCam) / 1000).toFixed(1)} s`);
if (!(camRes.points > 30 && camRes.rms < 3 && camRes.mirror === camRes.truthMirror)) errors.push('error: Kamera-Kalibrierung ' + JSON.stringify(camRes));
await win.screenshot({ path: path.join(outDir, '14-kamera-3.png') });
await win.evaluate(() => { const a = window.__app; a.S.activeId = 'P1'; a.S.project.view.outputMode = 'grid'; a.refresh(); });

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
// Präzise Synchronisierung: Abweichung zur gemeinsamen Uhr messen, dann 100 ms Verzögerung für HDMI A
{
  const drift = () => outWin.evaluate(async () => {
    const { st, video } = window.__out;
    const errs = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => video.requestVideoFrameCallback((now, m) => {
        const d = video.duration, t = ((Date.now() - performance.now() + m.expectedDisplayTime - st.play.startedAt) / 1000) % d;
        let e = m.mediaTime - t; if (e > d / 2) e -= d; if (e < -d / 2) e += d;
        errs.push(e); r();
      }));
    }
    errs.sort((a, b) => a - b);
    return errs[10];
  });
  const active = () => outWin.evaluate(() => performance.now() - (window.__out.player.precise || 0) < 500);
  const eOld = await drift();
  await win.click('#swPrecise');
  await win.waitForFunction(() => window.__app.S.project.playback.precise === true);
  await outWin.waitForTimeout(3000);
  const e0 = await drift();
  const on0 = await active();
  await win.evaluate(() => { const { S, refresh } = window.__app; S.project.outputs.find((o) => o.id === 'A').delayMs = 100; refresh(); });
  await outWin.waitForTimeout(5000);
  const e1 = await drift();
  const delayArrived = await outWin.evaluate(() => window.__out.st.project.outputs.find((o) => o.id === 'A').delayMs === 100);
  console.log('Präzise Synchronisierung:', { ohne_ms: Math.round(eOld * 1000), abweichung_ms: Math.round(e0 * 1000), mit_100ms_verzoegerung_ms: Math.round(e1 * 1000) });
  // Die Genauigkeit selbst ist hier nicht messbar: die Test-VM rendert in Software mit ~6 fps, die Werte
  // streuen um ±100 ms. Gemessen wird sie mit leichter Last getrennt (test/e2e/sync-measure.mjs); hier nur, dass der
  // bildgenaue Abgleich läuft und die Verzögerung beim Ausgang ankommt. Rechnung: test/precise.test.js.
  if (!on0) errors.push('error: präzise Synchronisierung läuft im Ausgang nicht');
  if (!delayArrived) errors.push('error: Verzögerung kommt beim Ausgang nicht an');
  await win.locator('#swPrecise').scrollIntoViewIfNeeded();
  await win.screenshot({ path: path.join(outDir, '08e-praezise-sync.png') });
  await win.evaluate(() => { const { S, refresh } = window.__app; S.project.outputs.find((o) => o.id === 'A').delayMs = 0; S.project.playback.precise = false; refresh(); });
}
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
// Raumeinmessung im Kreis: Ausgang des Audiographen mit künstlicher Laufzeit (Lautsprecher 2: +3 ms, −6 dB)
// als „Mikrofon“ zurückführen. Prüft Ablauf, Auswertung und Übernahme ohne echte Hardware.
await win.evaluate(() => { window.__app.setPlay('pause'); });
await win.evaluate(() => {
  const { audio } = window.__app;
  audio.recordInput = async () => {
    const ctx = audio.ctx;
    await ctx.audioWorklet.addModule(new URL('./recorderWorklet.js', location.href));
    const split = ctx.createChannelSplitter(2);
    const sum = ctx.createGain();
    const d = ctx.createDelay(0.1); d.delayTime.value = Math.round(0.003 * ctx.sampleRate) / ctx.sampleRate; // ganze Samples, sonst filtert die Interpolation
    const g2 = ctx.createGain(); g2.gain.value = 0.5;
    audio.nodes.merger.connect(split);
    split.connect(sum, 0); split.connect(d, 1); d.connect(g2); g2.connect(sum);
    const node = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
    const chunks = [];
    node.port.onmessage = (e) => chunks.push(e.data);
    sum.connect(node);
    return { fs: ctx.sampleRate, level: () => 0, stop: async () => {
      split.disconnect(); sum.disconnect(); node.disconnect();
      const n = chunks.reduce((a, c) => a + c.length, 0), samples = new Float32Array(n);
      let o = 0; for (const c of chunks) { samples.set(c, o); o += c.length; }
      return { samples, fs: ctx.sampleRate };
    } };
  };
  audio.inputDevices = async () => [];
});
await win.evaluate(() => window.__app.tuning.open());
await win.waitForSelector('#tuneSheet:not(.hidden) .sheet');
await win.click('#tuneSheet .choice:nth-child(2)');
await win.waitForTimeout(300);
await win.selectOption('#tuneSheet select >> nth=1', '2');
await win.screenshot({ path: path.join(outDir, '13-einmessen-1.png') });
await win.click('#tuneSheet .btn.primary');
for (let i = 0; i < 2; i++) {
  await win.click('#btnMeasure');
  await win.waitForSelector('#tuneSheet .status', { timeout: 60000 });
  if (i === 0) await win.screenshot({ path: path.join(outDir, '13-einmessen-2.png') });
  await win.click('#tuneSheet .btn.primary');
}
await win.waitForSelector('#btnTuneApply', { timeout: 30000 });
await win.waitForTimeout(300);
await win.screenshot({ path: path.join(outDir, '13-einmessen-3.png') });
await win.click('#btnTuneApply');
const tune = await win.evaluate(() => window.__app.S.project.audio.tuning);
console.log('Einmessung:', JSON.stringify(tune.speakers.map((x) => ({ d: x.delay, g: x.gain, f: x.filters.length }))));
if (tune.speakers.some((x) => x.filters.length)) errors.push('error: Einmessung setzt EQ-Filter bei flachem Weg');
if (!(Math.abs(tune.speakers[0].delay - 3) < 0.05 && Math.abs(tune.speakers[1].delay) < 0.2 && Math.abs(tune.speakers[0].gain + 6) < 1)) errors.push('error: Einmessung ' + JSON.stringify(tune.speakers));
await win.evaluate(() => { window.__app.S.project.audio.enabled = false; window.__app.refresh(); });
// Leertaste: Pause
await win.click('#modes button[data-mode=output]');
const playBefore = await win.evaluate(() => window.__app.S.play.playing);
await win.keyboard.press('Space');
await win.waitForTimeout(200);
if ((await win.evaluate(() => window.__app.S.play.playing)) === playBefore) errors.push('error: Leertaste schaltet Wiedergabe nicht um');
await win.keyboard.press('Space');
await win.waitForTimeout(200);
if ((await win.evaluate(() => window.__app.S.play.playing)) !== playBefore) errors.push('error: Leertaste schaltet nicht zurück');
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
  // zweiter freier Punkt, Liste zeigt beide; Rechtsklick entfernt ihn wieder
  const x2 = box.x + box.width * 0.3, y2 = box.y + box.height * 0.7;
  await win.mouse.click(x2, y2);
  await win.waitForTimeout(300);
  const rows = await win.locator('.pin-row').count();
  if (rows !== 2) errors.push(`error: Liste der freien Punkte zeigt ${rows} statt 2`);
  await win.screenshot({ path: path.join(outDir, '09d-freie-punkte-liste.png') });
  await win.mouse.click(x2, y2, { button: 'right' });
  await win.waitForTimeout(300);
  const left = await win.evaluate(() => window.__app.S.project.projectors[0].warp.pins.length);
  if (left !== 1) errors.push(`error: Rechtsklick hat den freien Punkt nicht entfernt (${left})`);
  // Projektorbild groß über der 3D-Ansicht
  await win.click('#btnPreviewBig');
  await win.waitForTimeout(500);
  const bigW = (await win.locator('#preview2d').boundingBox()).width;
  if (bigW < box.width * 1.5) errors.push(`error: Vorschau wird nicht groß (${bigW} px)`);
  await win.screenshot({ path: path.join(outDir, '09e-feinkorrektur-gross.png') });
  await win.evaluate(() => { const { S, refresh } = window.__app; S.activeHandle = null; S.activePin = null; refresh(); });
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  if (await win.evaluate(() => document.body.classList.contains('preview-big'))) errors.push('error: Esc schließt die große Vorschau nicht');
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

// ---------------- Mehrere Rechner: dieser Rechner als Hauptrechner, ein Ausgaberechner per Node über Loopback
{
  const { startClient, startMaster } = await import(path.join(root, 'src/main/cluster.js'));
  await win.click('#modes button[data-mode=setup]');
  await win.click('#paneSetup .seg-role [data-role=master]');
  await win.waitForFunction(() => window.__app.S.cluster.role === 'master');
  const opened = [], toOut = [];
  const cacheDir = fs.mkdtempSync('/tmp/kalib-cache-');
  const client = startClient({
    id: 'e2e', name: 'Rechner 2', cacheDir, target: '127.0.0.1', discover: false,
    displays: () => [{ id: 77, label: 'Beamer-Ausgang', pixelSize: { width: 3840, height: 2160 } }],
    openOutputs: (w) => opened.push(w), toOutputs: (m) => toOut.push(m),
  });
  await win.waitForFunction(() => window.__app.S.cluster.clients.length === 1, null, { timeout: 10000 });
  await win.selectOption('#paneSetup select[aria-label="Rechner für HDMI B"]', 'e2e');
  await win.waitForTimeout(300);
  await win.evaluate(() => window.__app.toggleOutputs(true));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !(opened.at(-1)?.some((w) => w.outputId === 'B' && w.displayId === 77) && client.status().files.total && client.status().files.done === client.status().files.total)) await new Promise((r) => setTimeout(r, 100));
  if (!opened.at(-1)?.some((w) => w.outputId === 'B' && w.displayId === 77)) errors.push('error: Ausgaberechner öffnet HDMI B nicht ' + JSON.stringify(opened.at(-1)));
  const st = client.status();
  if (!(st.files.total >= 1 && st.files.done === st.files.total)) errors.push('error: Dateien nicht übertragen ' + JSON.stringify(st.files));
  const lastState = toOut.filter((m) => m.type === 'state').at(-1);
  if (!lastState?.modelPath?.startsWith(cacheDir)) errors.push('error: Modell zeigt nicht auf die Kopie ' + lastState?.modelPath);
  if (!(st.offset != null && Math.abs(st.offset) < 50)) errors.push('error: Uhrabgleich ' + st.offset);
  client.fromOutput({ type: 'stats', outputId: 'B', playing: false, fps: 0, ms: 1, dropped: 0 });
  await win.waitForFunction(() => window.__app.S.outStats.B?.host === 'e2e', null, { timeout: 5000 }).catch(() => errors.push('error: Meldung vom Ausgaberechner kommt nicht an'));
  await win.waitForTimeout(2500);
  await win.locator('#paneSetup select[aria-label="Rechner für HDMI B"]').scrollIntoViewIfNeeded();
  await win.screenshot({ path: path.join(outDir, '15-verbund-hauptrechner.png') });
  console.log('Verbund:', JSON.stringify({ offset: st.offset, error: st.error, files: st.files, outputs: opened.at(-1) }));
  await win.evaluate(() => window.__app.toggleOutputs(false));
  await win.selectOption('#paneSetup select[aria-label="Rechner für HDMI B"]', '');
  client.stop();

  // dieser Rechner als Ausgaberechner, ein Hauptrechner per Node
  const clientId = await win.evaluate(() => window.__app.S.cluster.id);
  await win.click('#paneSetup .seg-role [data-role=client]');
  await win.waitForSelector('#clusterSheet:not(.hidden)');
  const proj = await win.evaluate(() => { const { S } = window.__app; const p = JSON.parse(JSON.stringify(S.project)); const o = p.outputs.find((x) => x.id === 'A'); o.host = S.cluster.id; o.hostDisplay = S.displays[0].id; return { project: p, modelPath: p.model.path }; });
  // noch kein Hauptrechner: Hinweis „Verbindung abgelehnt“
  await win.evaluate(() => window.api.clusterConnect('127.0.0.1'));
  await win.waitForSelector('#clusterSheet .cl-hint[data-hint=refused]', { timeout: 10000 }).catch(() => errors.push('error: kein Hinweis bei abgelehnter Verbindung'));
  await win.screenshot({ path: path.join(outDir, '15-verbund-hinweis.png') });
  const master = startMaster({ name: 'Regiepult', host: '127.0.0.1' });
  master.broadcast({ type: 'state', project: proj.project, modelPath: proj.modelPath, play: { playing: false, startedAt: Date.now(), pausedAt: 0, loop: true }, activeId: 'P1', lang: 'de', markers: false });
  master.setOutputs(true);
  await win.evaluate(() => window.api.clusterConnect('127.0.0.1'));
  const n0 = app.windows().length;
  await win.waitForFunction(() => window.__app.S.cluster.status?.connected && window.__app.S.cluster.status?.outputs?.length === 1, null, { timeout: 15000 }).catch(() => errors.push('error: Ausgaberechner verbindet nicht oder öffnet keinen Ausgang'));
  await win.waitForTimeout(2500);
  if (app.windows().length < n0) errors.push('error: kein Ausgabefenster auf dem Ausgaberechner');
  await win.screenshot({ path: path.join(outDir, '15-verbund-ausgaberechner.png') });
  if (!master.clients().some((c) => c.id === clientId)) errors.push('error: Hauptrechner kennt den Ausgaberechner nicht');
  await win.click('#clLeave');
  await win.waitForFunction(() => window.__app.S.cluster.role === 'solo');
  master.stop();
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

console.log('Konsolen-Fehler/Warnungen:', errors.length ? errors : 'keine');
await app.close();
if (errors.some((e) => e.startsWith('pageerror') || e.startsWith('error'))) process.exit(1);
