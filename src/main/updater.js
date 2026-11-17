// Automatische Updates ohne Apple-Entwicklerkonto.
// Ablauf: latest.json aus dem neuesten GitHub-Release lesen -> neuere Version? -> nachfragen ->
// Datei laden und per SHA-256 prüfen -> macOS: App-Bundle nach dem Beenden austauschen und neu starten,
// Windows: Installer starten. Die Update-Datei entsteht im Build (siehe .github/workflows/build.yml).
import { app, dialog, net, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isNewer, pickFile } from '../shared/version.js';

let busy = false;

async function feedUrl() {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    return pkg.updateFeed || null;
  } catch { return null; }
}

/** Lädt url nach file, meldet Fortschritt 0..1 und liefert den SHA-256 (hex). */
async function download(url, file, onProgress) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { hash.update(c); done += c.length; if (total) onProgress(done / total); });
  await pipeline(body, fs.createWriteStream(file));
  return hash.digest('hex');
}

/** Pfad des laufenden .app-Bundles (…/Projection Studio.app). */
function macBundle() {
  const p = process.execPath.split('/Contents/MacOS/')[0];
  return p.endsWith('.app') ? p : null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'ignore' });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} endete mit ${code}`))));
  });
}

async function installMac(zipFile, tmp) {
  const bundle = macBundle();
  if (!bundle) throw new Error('App-Bundle nicht gefunden');
  const out = path.join(tmp, 'neu');
  await run('/usr/bin/ditto', ['-x', '-k', zipFile, out]);
  const name = (await fsp.readdir(out)).find((n) => n.endsWith('.app'));
  if (!name) throw new Error('Update enthält keine App');
  const fresh = path.join(out, name);
  // Nach dem Beenden: altes Bundle zur Seite, neues hinein, bei Fehler zurück, dann neu starten.
  const script = path.join(tmp, 'update.sh');
  await fsp.writeFile(script, `#!/bin/sh
APP="$1"; NEW="$2"; PID="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
rm -rf "$APP.alt"
if mv "$APP" "$APP.alt" && /usr/bin/ditto "$NEW" "$APP"; then
  rm -rf "$APP.alt"
else
  rm -rf "$APP"; mv "$APP.alt" "$APP"
fi
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
/usr/bin/open "$APP"
rm -rf "${tmp}"
`, { mode: 0o755 });
  spawn('/bin/sh', [script, bundle, fresh, String(process.pid)], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

function installWin(exe) {
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

/**
 * Nach Updates suchen.
 * manual = true: auch "keine neue Version" und Fehler melden (Menüpunkt).
 */
export async function checkForUpdates(win, manual = false) {
  if (busy) return;
  const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : null;
  const feed = await feedUrl();
  if (!platform || !feed || (!app.isPackaged && !process.env.UPDATE_TEST)) {
    if (manual) dialog.showMessageBox(win, { type: 'info', message: 'Updates sind in dieser Version nicht verfügbar.' });
    return;
  }
  busy = true;
  const tmp = path.join(os.tmpdir(), `projection-studio-update-${Date.now()}`);
  try {
    const res = await net.fetch(feed, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'Keine Update-Informationen gefunden. Ist das Repository öffentlich?' : `Server antwortet mit ${res.status}`);
    const info = await res.json();
    const current = app.getVersion();
    if (!isNewer(info.version, current)) {
      if (manual) await dialog.showMessageBox(win, { type: 'info', message: 'Projection Studio ist auf dem neuesten Stand.', detail: `Version ${current}` });
      return;
    }
    const file = pickFile(info, platform);
    if (!file) throw new Error('Für dieses System gibt es keine Update-Datei.');
    const ask = await dialog.showMessageBox(win, {
      type: 'info',
      message: `Projection Studio ${info.version} ist verfügbar.`,
      detail: `Installiert ist ${current}.${info.notes ? `\n\n${info.notes}` : ''}\n\nDas Update wird im Hintergrund geladen. Danach startet die App neu, das Projekt ist gesichert.`,
      buttons: ['Jetzt aktualisieren', 'Später'],
      defaultId: 0,
      cancelId: 1,
    });
    if (ask.response !== 0) return;
    await fsp.mkdir(tmp, { recursive: true });
    const target = path.join(tmp, file.name);
    const url = new URL(file.name, feed).href;
    const sha = await download(url, target, (f) => win?.setProgressBar(f));
    win?.setProgressBar(-1);
    if (sha !== file.sha256) throw new Error('Die geladene Datei ist beschädigt (Prüfsumme stimmt nicht). Bitte später erneut versuchen.');
    if (platform === 'mac') await installMac(target, tmp);
    else installWin(target);
  } catch (e) {
    win?.setProgressBar(-1);
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (manual) {
      const r = await dialog.showMessageBox(win, { type: 'warning', message: 'Update nicht möglich', detail: String(e.message || e), buttons: ['OK', 'Download-Seite öffnen'], cancelId: 0 });
      if (r.response === 1 && feed) shell.openExternal(feed.replace(/\/download\/[^/]+$/, ''));
    } else {
      console.warn('Update-Prüfung:', e.message || e);
    }
  } finally {
    busy = false;
  }
}
