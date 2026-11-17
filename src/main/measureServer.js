// Smartphone als Messmikrofon: kleiner HTTPS-Server im lokalen Netz.
// Das Handy öffnet per QR-Code eine Seite, gibt das Mikrofon frei und nimmt auf Anweisung auf.
// HTTPS ist Pflicht, weil Browser das Mikrofon nur in sicheren Verbindungen freigeben. Das Zertifikat
// ist selbst erstellt, deshalb fragt das Handy beim ersten Öffnen einmal nach.
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { PHONE_PAGE } from './phonePage.js';

const require = createRequire(import.meta.url);

let server = null;
let state = null; // { token, url, phone: { seen, ua, level }, cmd, waiters }

/** IPv4-Adressen im lokalen Netz, private Bereiche zuerst. */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

async function certificate(dir, ips) {
  const file = path.join(dir, 'measure-cert.json');
  try {
    const c = JSON.parse(await fs.readFile(file, 'utf8'));
    if (ips.every((ip) => c.ips.includes(ip))) return c;
  } catch { /* neu erzeugen */ }
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Projection Studio' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: ips.map((ip) => ({ type: 7, ip })) }],
  });
  const c = { key: pems.private, cert: pems.cert, ips };
  await fs.writeFile(file, JSON.stringify(c)).catch(() => {});
  return c;
}

/**
 * Server starten (oder laufenden zurückgeben). notify(event) meldet Zustandsänderungen an das Hauptfenster.
 * Rückgabe: { url, qr (Data-URL), addresses }
 */
export async function startMeasureServer(userData, notify, address) {
  const addrs = lanAddresses();
  if (!addrs.length) throw new Error('Kein lokales Netzwerk gefunden. Rechner und Handy müssen im selben WLAN sein.');
  const ip = address && addrs.some((a) => a.address === address) ? address : addrs[0].address;
  if (server && state.ip === ip) return info();
  stopMeasureServer();
  const { key, cert } = await certificate(userData, addrs.map((a) => a.address));
  state = { token: randomBytes(9).toString('base64url'), ip, phone: null, cmd: null, waiters: new Map(), notify };
  server = https.createServer({ key, cert }, handle);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  state.url = `https://${ip}:${server.address().port}/m/${state.token}`;
  const QR = require('qrcode');
  state.qr = await QR.toDataURL(state.url, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
  return info();
}

function info() {
  return { url: state.url, qr: state.qr, addresses: lanAddresses(), ip: state.ip, phone: state.phone };
}

export function stopMeasureServer() {
  if (server) server.close();
  server = null;
  if (state) for (const w of state.waiters.values()) w.reject(new Error('Messung abgebrochen'));
  state = null;
}

/**
 * Aufnahme auf dem Handy auslösen. Löst `started` aus, sobald das Handy aufnimmt, und liefert am Ende
 * { samples: Float32Array, fs }.
 */
export function phoneRecord(seconds, onStarted) {
  if (!state?.phone) return Promise.reject(new Error('Kein Handy verbunden'));
  const id = randomBytes(6).toString('hex');
  state.cmd = { id, cmd: 'record', seconds };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state?.waiters.delete(id); reject(new Error('Das Handy antwortet nicht. Ist die Seite noch geöffnet und das Display an?')); }, (seconds + 25) * 1000);
    state.waiters.set(id, {
      started: onStarted,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}

export function phoneMessage(text) { if (state) state.message = text; }

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function handle(req, res) {
  const u = new URL(req.url, 'https://x');
  const parts = u.pathname.split('/').filter(Boolean); // ['m', token, ...]
  if (parts[0] !== 'm' || !state || parts[1] !== state.token) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
  const action = parts[2] || '';
  if (!action) return send(res, 200, PHONE_PAGE, 'text/html; charset=utf-8');
  if (action === 'poll' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body || '{}'); } catch { /* leer */ }
      const first = !state.phone;
      state.phone = { seen: Date.now(), ua: req.headers['user-agent'] || '', level: msg.level ?? null, fs: msg.fs ?? null, ready: !!msg.ready, settings: msg.settings || null };
      if (first || msg.ready) state.notify({ type: 'phone', phone: state.phone });
      else state.notify({ type: 'level', level: msg.level });
      send(res, 200, { cmd: state.cmd, message: state.message || '' });
    });
    return;
  }
  if (action === 'started' && req.method === 'POST') {
    const id = u.searchParams.get('id');
    const w = state.waiters.get(id);
    if (state.cmd?.id === id) state.cmd = null;
    w?.started?.();
    return send(res, 200, { ok: true });
  }
  if (action === 'upload' && req.method === 'POST') {
    const id = u.searchParams.get('id'), fsRate = Number(u.searchParams.get('fs')) || 48000;
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length - (buf.length % 4))));
      const w = state.waiters.get(id);
      state.waiters.delete(id);
      w?.resolve({ samples, fs: fsRate });
      send(res, 200, { ok: true });
    });
    return;
  }
  if (action === 'error' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const id = u.searchParams.get('id');
      const w = state.waiters.get(id);
      state.waiters.delete(id);
      w?.reject(new Error(`Handy: ${body.slice(0, 300)}`));
      send(res, 200, { ok: true });
    });
    return;
  }
  send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
}
