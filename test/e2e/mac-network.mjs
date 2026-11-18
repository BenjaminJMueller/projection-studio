// Mehrrechner-Verbund auf echtem macOS (GitHub-macOS-Runner), mit der fertig gebauten App:
// Programm-UUID, Signatur, Firewall-Erkennung und -Freigabe, Verbindung über die LAN-Adresse.
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
const appPath = process.argv[2];
const outDir = process.argv[3] || path.join(root, 'test-output');
fs.mkdirSync(outDir, { recursive: true });
const { startClient } = await import(path.join(root, 'src/main/cluster.js'));

const log = [], fails = [];
const note = (s) => { console.log(s); log.push(`- ${s}`); };
const check = (ok, s) => { note(`${ok ? '✅' : '❌'} ${s}`); if (!ok) fails.push(s); };
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`.trim(); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FW = '/usr/libexec/ApplicationFirewall/socketfilterfw';

note(`macOS ${sh('sw_vers', ['-productVersion'])}, ${os.arch()}`);
// 1. Eigene Programm-UUID (sonst verwechselt macOS die App bei „Lokales Netzwerk“ mit anderen Electron-Apps)
const exe = path.join(appPath, 'Contents/MacOS', fs.readdirSync(path.join(appPath, 'Contents/MacOS'))[0]);
const stock = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const uu = (f) => sh('dwarfdump', ['--uuid', f]).split('\n').map((l) => l.split(' ')[1]).filter(Boolean);
const ours = uu(exe), theirs = uu(stock);
note(`UUID App: ${ours.join(', ')} · Electron: ${theirs.join(', ')}`);
check(ours.length > 0 && ours.every((u) => !theirs.includes(u)), 'App hat eine eigene Mach-O-UUID');
const sig = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
check(/valid on disk/.test(sig) && /satisfies its Designated Requirement/.test(sig), 'Signatur gültig (ad hoc)');
const plist = sh('/usr/libexec/PlistBuddy', ['-c', 'Print :NSLocalNetworkUsageDescription', path.join(appPath, 'Contents/Info.plist')]);
check(plist.length > 10 && !/Does Not Exist/.test(plist), 'NSLocalNetworkUsageDescription im Info.plist');

// 2. Firewall an, App starten, Hauptrechner
sh('sudo', [FW, '--setglobalstate', 'on']);
note(`Firewall: ${sh(FW, ['--getglobalstate'])}`);
const userData = fs.mkdtempSync('/tmp/ps-mac-');
const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`] });
const win = await app.firstWindow();
await win.waitForFunction(() => window.__app?.ready, null, { timeout: 60000 });
await win.evaluate(() => window.__app.closeOnboarding?.(false));
await win.evaluate(() => window.__app.setClusterRole('master'));
await win.evaluate(() => window.__app.setMode('setup'));
await win.waitForTimeout(3000);
const fw1 = await win.evaluate(() => window.__app.S.cluster.firewall);
note(`Firewall laut App vor der Freigabe: ${JSON.stringify(fw1)}`);
check(fw1 && fw1.on === true, 'App erkennt die eingeschaltete Firewall');
check(fw1 && fw1.ok === false, 'App meldet, dass sie noch nicht freigegeben ist');
await win.screenshot({ path: path.join(outDir, 'mac-1-firewall-hinweis.png') });

// 3. Freigabe wie der Knopf „Freigeben …“ (hier mit sudo statt Passwortabfrage)
sh('sudo', [FW, '--add', appPath]);
sh('sudo', [FW, '--unblockapp', appPath]);
note(`Firewall-Eintrag: ${sh(FW, ['--getappblocked', appPath])}`);
await win.evaluate(async () => { const { S } = window.__app; S.cluster.firewall = await window.api.clusterFirewall(); window.__app.refresh(); });
const fw2 = await win.evaluate(() => window.__app.S.cluster.firewall);
note(`Firewall laut App nach der Freigabe: ${JSON.stringify(fw2)}`);
check(fw2 && fw2.ok === true, 'Nach der Freigabe meldet die App „freigegeben“');

// 4. Ausgaberechner (Node) verbindet sich über die LAN-Adresse, nicht über Loopback
const lan = Object.values(os.networkInterfaces()).flat().find((n) => n && (n.family === 'IPv4' || n.family === 4) && !n.internal)?.address;
note(`LAN-Adresse: ${lan}`);
const cache = fs.mkdtempSync('/tmp/ps-mac-cache-');
const client = startClient({ id: 'mac-ci', name: 'CI-Ausgaberechner', cacheDir: cache, target: lan, discover: true, displays: () => [{ id: 9, label: 'Test', pixelSize: { width: 1920, height: 1080 } }] });
let st = null;
for (let i = 0; i < 100; i++) { st = client.status(); if (st.connected && st.offset != null) break; await wait(100); }
note(`Ausgaberechner: ${JSON.stringify({ connected: st.connected, problem: st.problem, offset: st.offset, error: st.error })}`);
check(st.connected, `Verbindung über ${lan} zum Hauptrechner`);
const found = client.masters();
note(`Per Broadcast gefunden: ${JSON.stringify(found.map((m) => `${m.name} ${m.address}`))}`);
await win.waitForFunction(() => window.__app.S.cluster.clients.length > 0, null, { timeout: 10000 }).catch(() => {});
const masterSees = await win.evaluate(() => ({ clients: window.__app.S.cluster.clients.map((c) => c.name), problem: window.__app.S.cluster.problem }));
note(`Hauptrechner sieht: ${JSON.stringify(masterSees)}`);
check(masterSees.clients.includes('CI-Ausgaberechner'), 'Hauptrechner zeigt den Ausgaberechner');
if (masterSees.problem === 'localNetwork') note('ℹ️ Broadcast vom Hauptrechner durch „Lokales Netzwerk“ gesperrt (auf dem Runner kann niemand „Erlauben“ klicken). Die App zeigt dafür den Hinweis mit Knopf.');
await win.screenshot({ path: path.join(outDir, 'mac-2-verbunden.png') });
client.stop();
note(`Netzwerk-Protokoll (Lokales Netzwerk):\n\n\`\`\`\n${sh('log', ['show', '--last', '3m', '--style', 'compact', '--predicate', 'subsystem == "com.apple.networkextension" AND eventMessage CONTAINS "bundle id"']).split('\n').slice(-15).join('\n')}\n\`\`\``);
await app.close();
sh('sudo', [FW, '--setglobalstate', 'off']);

fs.writeFileSync(path.join(outDir, 'mac-network.md'), `# Verbund auf macOS\n\n${log.join('\n')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Verbund auf macOS\n\n${log.join('\n')}\n`);
process.exit(fails.length ? 1 : 0);
