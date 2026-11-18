import { createRequire } from 'node:module';
import fs from 'node:fs';
// Misst die Abweichung zur gemeinsamen Uhr (Median, 10 %, 90 % in ms) ohne und mit präziser
// Synchronisierung, bei leichter Last. Aufruf: xvfb-run -a node test/e2e/sync-measure.mjs [video]
const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(root + '/package.json');
const { _electron: electron } = require('playwright');
const app = await electron.launch({ executablePath: require(root + '/node_modules/electron'), args: [root, '--no-sandbox', `--user-data-dir=${fs.mkdtempSync('/tmp/kalib-m-')}`], cwd: root });
const win = await app.firstWindow();
await win.waitForFunction(() => window.__app?.ready, null, { timeout: 30000 });
await win.evaluate(() => window.__app.closeOnboarding(false));
await win.waitForFunction(() => window.__app.S.model, null, { timeout: 30000 });
await win.evaluate(() => { const { S } = window.__app; S.project.outputs.find((o) => o.id === 'T').displayId = S.displays[0].id; S.project.view.outputMode = 'video'; });
await win.evaluate((f) => window.__app.setVideo(f), process.argv[2] || root + '/test/fixtures/testvideo.mp4');
await win.waitForFunction(() => window.__app.S.videoInfo?.duration > 0, null, { timeout: 15000 });
await win.evaluate(() => window.__app.toggleOutputs(true));
const out = await app.waitForEvent('window', { timeout: 20000 });
await win.evaluate(() => window.__app.setPlay('play'));
await out.waitForFunction(() => window.__out.video.currentTime > 0.5, null, { timeout: 15000 });
const drift = () => out.evaluate(async () => {
  const { st, video } = window.__out; const errs = [];
  for (let i = 0; i < 60; i++) await new Promise((r) => video.requestVideoFrameCallback((now, m) => { const d = video.duration, t = ((Date.now() - performance.now() + m.expectedDisplayTime - st.play.startedAt) / 1000) % d; let e = m.mediaTime - t; if (e > d / 2) e -= d; if (e < -d / 2) e += d; errs.push(e); r(); }));
  errs.sort((a, b) => a - b); return [errs[30], errs[6], errs[54]].map((x) => Math.round(x * 1000));
});
for (const precise of [false, true, false, true]) {
  await win.evaluate((p) => { const { S, refresh } = window.__app; S.project.playback.precise = p; refresh(); }, precise);
  await out.waitForTimeout(3000);
  console.log(precise ? 'präzise' : 'normal ', await drift(), await drift());
}
await win.evaluate(() => { const { S, refresh } = window.__app; S.project.outputs.find((o) => o.id === 'T').delayMs = 100; refresh(); });
await out.waitForTimeout(5000);
console.log('präzise+100ms', await drift(), await drift());
await app.close();
