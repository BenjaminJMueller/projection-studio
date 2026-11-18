// Mehrrechner-Verbund auf echtem macOS (GitHub-macOS-Runner), mit der fertig gebauten App:
// Programm-UUID, Signatur, Firewall-Erkennung und -Freigabe. Zwei Instanzen der App (Hauptrechner und
// Ausgaberechner) verbinden sich über die LAN-Adresse, wie zwei Rechner im Netz.
// Aufruf: node test/e2e/mac-network.mjs <Pfad zu Projection Studio.app> [ausgabeordner]
// Schreibt ein Protokoll nach <ausgabeordner>/mac-network.md und endet mit 1, wenn etwas Wesentliches fehlt.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const appPath = path.resolve(process.argv[2]);
const outDir = process.argv[3] || path.join(root, 'test-output');
fs.mkdirSync(outDir, { recursive: true });

const log = [], fails = [];
const note = (s) => { console.log(s); log.push(`- ${s}`); };
const check = (ok, s) => { note(`${ok ? '✅' : '❌'} ${s}`); if (!ok) fails.push(s); };
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`.trim(); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FW = '/usr/libexec/ApplicationFirewall/socketfilterfw';

note(`macOS ${sh('sw_vers', ['-productVersion'])}, ${os.arch()}`);
// 1. Eigene Programm-UUID und gültige Signatur (sonst sperrt macOS „Lokales Netzwerk“ still)
const exe = path.join(appPath, 'Contents/MacOS', fs.readdirSync(path.join(appPath, 'Contents/MacOS'))[0]);
const stock = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const uu = (f) => sh('dwarfdump', ['--uuid', f]).split('\n').map((l) => l.split(' ')[1]).filter(Boolean);
const ours = uu(exe), theirs = uu(stock);
note(`UUID App: ${ours.join(', ')} · Electron: ${theirs.join(', ')}`);
check(ours.length > 0 && ours.every((u) => !theirs.includes(u)), 'App hat eine eigene Mach-O-UUID');
const sig = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
note(`codesign: ${sig.split('\n').slice(-2).join(' / ')}`);
check(/valid on disk/.test(sig) && /satisfies its Designated Requirement/.test(sig), 'Signatur des ganzen Bundles gültig (ad hoc)');
const plist = sh('/usr/libexec/PlistBuddy', ['-c', 'Print :NSLocalNetworkUsageDescription', path.join(appPath, 'Contents/Info.plist')]);
check(plist.length > 10 && !/Does Not Exist/.test(plist), 'NSLocalNetworkUsageDescription im Info.plist');

// 2. Firewall an, App noch nicht freigegeben
sh('sudo', [FW, '--setglobalstate', 'on']);
sh('sudo', [FW, '--remove', appPath]);
note(`Firewall: ${sh(FW, ['--getglobalstate'])} · App: ${sh(FW, ['--getappblocked', appPath])}`);

async function launch(name) {
  const userData = fs.mkdtempSync(`/tmp/ps-${name}-`);
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`] });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1500, height: 940 }).catch(() => {});
  await win.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
  await win.evaluate(() => window.__app.closeOnboarding?.(false));
  return { app, win };
}
const M = await launch('haupt');
await M.win.evaluate(() => window.__app.setClusterRole('master'));
await M.win.evaluate(() => window.__app.setMode('setup'));
await M.win.waitForTimeout(3000);
const fw1 = await M.win.evaluate(() => window.__app.S.cluster.firewall);
note(`Firewall laut App: ${JSON.stringify(fw1)}`);
check(fw1 && fw1.on === true, 'App erkennt die eingeschaltete Firewall');

const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && (n.family === 'IPv4' || n.family === 4) && !n.internal)?.address;
note(`LAN-Adresse: ${lan}`);
const C = await launch('ausgabe');
await C.win.evaluate(() => window.__app.setClusterRole('client'));
await C.win.waitForTimeout(4000); // findet der Ausgaberechner den Hauptrechner per Broadcast?
const found = await C.win.evaluate(() => (window.__app.S.cluster.masters || []).map((m) => m.address));
note(`Per Broadcast gefunden: ${JSON.stringify(found)}`);
if (!found.length) await C.win.evaluate((a) => window.api.clusterConnect(a), lan);
const status = () => C.win.evaluate(() => window.__app.S.cluster.status || {});
let st = {};
for (let i = 0; i < 40; i++) { st = await status(); if (st.connected && st.offset != null) break; await wait(250); }
note(`Vor der Freigabe: ${JSON.stringify({ connected: st.connected, problem: st.problem, offset: st.offset })}`);
await C.win.screenshot({ path: path.join(outDir, 'mac-1-ausgaberechner-vorher.png') });
await M.win.screenshot({ path: path.join(outDir, 'mac-1-hauptrechner-vorher.png') });

// 3. Freigabe wie der Knopf „Freigeben …“ (hier mit sudo statt Passwortabfrage)
const fwNow = await M.win.evaluate(async () => window.api.clusterFirewall());
if (fwNow && !fwNow.ok) {
  sh('sudo', [FW, '--add', appPath]);
  sh('sudo', [FW, '--unblockapp', appPath]);
}
note(`Firewall-Eintrag: ${sh(FW, ['--getappblocked', appPath])}`);
const fw2 = await M.win.evaluate(async () => { const { S } = window.__app; S.cluster.firewall = await window.api.clusterFirewall(); window.__app.refresh(); return S.cluster.firewall; });
check(fw2 && fw2.ok === true, 'App meldet die Firewall-Freigabe');

// 4. Ausgaberechner verbunden, Uhr abgeglichen, Ausgang dort geöffnet
for (let i = 0; i < 80; i++) { st = await status(); if (st.connected && st.offset != null) break; await wait(250); }
note(`Ausgaberechner: ${JSON.stringify({ connected: st.connected, problem: st.problem, offset: st.offset, error: st.error, master: st.masterName })}`);
check(st.connected && st.offset != null, `Ausgaberechner verbunden über ${lan}, Uhr abgeglichen`);
await M.win.waitForFunction(() => window.__app.S.cluster.clients.length > 0, null, { timeout: 15000 }).catch(() => {});
const cl = await M.win.evaluate(() => window.__app.S.cluster.clients.map((c) => ({ id: c.id, name: c.name, address: c.address, displays: c.displays.map((d) => d.id) })));
note(`Hauptrechner sieht: ${JSON.stringify(cl)}`);
check(cl.length === 1, 'Hauptrechner zeigt den Ausgaberechner');
if (cl.length) {
  await M.win.evaluate((c) => { const { S, refresh, toggleOutputs } = window.__app; const o = S.project.outputs.find((x) => x.id === 'A'); o.host = c.id; o.hostName = c.name; o.hostDisplay = c.displays[0]; refresh(); return toggleOutputs(true); }, cl[0]);
  let wins = 0;
  for (let i = 0; i < 60; i++) { wins = C.app.windows().length; if (wins > 1) break; await wait(250); }
  check(wins > 1, 'Ausgaberechner öffnet den zugewiesenen Ausgang');
  await wait(4000);
  const files = (await status()).files;
  note(`Dateien auf dem Ausgaberechner: ${JSON.stringify(files)}`);
  check(files && files.total > 0 && files.done === files.total, 'Modell kopiert');
}
const problem = await M.win.evaluate(() => window.__app.S.cluster.problem);
note(`Hauptrechner-Broadcast: ${problem === 'localNetwork' ? 'durch „Lokales Netzwerk“ gesperrt (Hinweis wird angezeigt)' : 'ok'}`);
await M.win.locator('#paneSetup .seg-role').scrollIntoViewIfNeeded().catch(() => {});
await M.win.screenshot({ path: path.join(outDir, 'mac-2-hauptrechner.png') });
await C.win.screenshot({ path: path.join(outDir, 'mac-2-ausgaberechner.png') });
note(`Lokales Netzwerk (Systemprotokoll):\n\n\`\`\`\n${sh('log', ['show', '--last', '5m', '--style', 'compact', '--predicate', 'subsystem == "com.apple.networkextension" AND eventMessage CONTAINS "LocalNetwork"']).split('\n').slice(-12).join('\n')}\n\`\`\``);
await C.app.close();
await M.app.close();
sh('sudo', [FW, '--setglobalstate', 'off']);

fs.writeFileSync(path.join(outDir, 'mac-network.md'), `# Verbund auf macOS\n\n${log.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Verbund auf macOS\n\n${log.join('\n')}\n`);
process.exit(fails.length ? 1 : 0);
