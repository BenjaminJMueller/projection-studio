// Mehrrechner-Verbund: Ein Hauptrechner mit Oberfläche, weitere Rechner („Ausgaberechner“) zeigen nur
// ihre Ausgänge. Läuft im Hauptprozess, ohne Electron-Abhängigkeit (testbar mit Node).
//
//   Steuerung   TCP 47810, eine JSON-Nachricht pro Zeile (Zustand, Uhrabgleich, Status)
//   Finden      UDP 47811, der Hauptrechner meldet sich alle 2 s per Broadcast
//   Dateien     HTTP 47812, Modell und Videos; Ausgaberechner kopieren sie einmal in ihren Zwischenspeicher
//
// Uhr: Der Hauptrechner gibt Abspielzeiten in seiner Uhr (Date.now) vor. Jeder Ausgaberechner misst den
// Versatz wie NTP (Hin- und Rückweg, die schnellste Messung zählt) und rechnet startedAt in seine Uhr um.
// Ohne Hardware-Genlock bleibt ein Restversatz von bis zu etwa einem Bild.
import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { playlistOf } from '../shared/playback.js';

export const PORTS = { ctrl: 47810, disc: 47811, files: 47812 };
export const PROTO = 1;
const MAGIC = 'projection-studio';
const MAX_QUEUE = 8 * 1024 * 1024; // so viel darf pro Rechner ungesendet warten, sonst wird Zustand übersprungen

/** Zeilenweise JSON lesen. */
export function lineReader(onMsg) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      onMsg(m);
    }
  };
}

/** Uhrabgleich wie NTP: Versatz aus der Messung mit dem kürzesten Hin- und Rückweg. */
export class ClockSync {
  constructor(n = 16) { this.n = n; this.samples = []; }
  add(t0, tm, t1) {
    const rtt = t1 - t0;
    if (!(rtt >= 0)) return;
    this.samples.push({ rtt, off: tm - (t0 + t1) / 2 });
    if (this.samples.length > this.n) this.samples.shift();
  }
  #best() { return this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a), this.samples[0]); }
  get ready() { return this.samples.length >= 3; }
  /** Hauptrechner-Uhr minus eigene Uhr, in ms. */
  get offset() { return this.samples.length ? this.#best().off : 0; }
  /** Unsicherheit (halber Hin- und Rückweg der besten Messung), in ms. */
  get error() { return this.samples.length ? this.#best().rtt / 2 : Infinity; }
}

/** Nur Rechner im eigenen Netz dürfen sich verbinden. */
export function isLocalAddress(a = '') {
  a = a.replace(/^::ffff:/, '');
  if (a === '::1' || /^fe80:/i.test(a) || /^f[cd]/i.test(a)) return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 127 || x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254);
}

/** Broadcast-Adressen aller IPv4-Netze dieses Rechners. */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal) { out.add('127.255.255.255'); continue; }
      const ip = n.address.split('.').map(Number), mask = n.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

/** Dateien, die die Ausgänge brauchen: Modell und Videos (lokale Pfade). */
export function referencedFiles(state) {
  const out = [];
  if (state?.modelPath) out.push(state.modelPath);
  for (const it of playlistOf(state?.project?.playback)) if (it.src) out.push(it.src);
  return [...new Set(out.filter((p) => !/^(https?|data|blob):/i.test(p)))];
}

/**
 * Zustand des Hauptrechners für einen Ausgaberechner umschreiben.
 * local(path, needLocal) → lokaler Pfad, Stream-URL oder null. offset = Hauptrechner-Uhr minus eigene Uhr.
 */
export function rewriteState(msg, local, offset) {
  const out = { ...msg };
  if (msg.modelPath) out.modelPath = local(msg.modelPath, true);
  const pb = msg.project?.playback;
  if (pb) {
    const items = playlistOf(pb).map((it) => ({ ...it, src: (it.src && local(it.src, false)) || it.src }));
    out.project = { ...msg.project, playback: { ...pb, items } };
  }
  if (msg.play && msg.play.startedAt != null) out.play = { ...msg.play, startedAt: msg.play.startedAt - offset };
  return out;
}

const fileId = (p, st) => crypto.createHash('sha1').update(`${p}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
const safeName = (s) => String(s).replace(/[^\w.\-]+/g, '_').slice(-80);

// ======================================================================= Hauptrechner
export function startMaster({ name = os.hostname(), onEvent = () => {}, ports = PORTS, host = '0.0.0.0' } = {}) {
  const clients = new Map(); // id -> { id, name, address, displays, status, sock }
  let files = new Map(); // fid -> { path, name, size }
  let pathsKey = '', filesMsg = null;
  let lastState = null, lastStateStr = '', lastBlendStr = '', lastPatternStr = '';
  let outputsOn = false;
  const servers = [];

  const list = () => [...clients.values()].map(({ sock, ...c }) => c);
  const emitClients = () => onEvent({ type: 'clients', clients: list() });

  function write(c, str) {
    if (c.sock.destroyed) return;
    c.sock.write(`${str}\n`);
  }
  /** Zustand nur senden, wenn die Leitung frei ist; sonst den neuesten merken (kein Stau bei langsamem Netz). */
  function writeState(c, str) {
    if (c.sock.writableLength > MAX_QUEUE) { c.pendingState = str; return; }
    write(c, str);
  }
  const all = (str, state = false) => { for (const c of clients.values()) if (c.ready) (state ? writeState : write)(c, str); };

  function updateFiles(state) {
    const paths = referencedFiles(state);
    const key = paths.join('\n');
    if (key === pathsKey) return false;
    pathsKey = key;
    const next = new Map();
    for (const p of paths) {
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        next.set(fileId(p, st), { path: p, name: path.basename(p), size: st.size });
      } catch { /* fehlt: Ausgaberechner bekommen nichts */ }
    }
    files = next;
    filesMsg = JSON.stringify({ type: 'files', files: [...files].map(([fid, f]) => ({ fid, path: f.path, name: f.name, size: f.size })) });
    return true;
  }

  // ---------------- Steuerung
  const ctrl = net.createServer((sock) => {
    if (!isLocalAddress(sock.remoteAddress)) { sock.destroy(); return; }
    sock.setNoDelay(true);
    sock.setEncoding('utf8');
    let c = null;
    sock.on('drain', () => { if (c?.pendingState) { const s = c.pendingState; c.pendingState = null; writeState(c, s); } });
    sock.on('data', lineReader((m) => {
      if (m.type === 'ping') { sock.write(`${JSON.stringify({ type: 'pong', t0: m.t0, tm: Date.now() })}\n`); return; }
      if (m.type === 'hello') {
        if (m.proto !== PROTO) { sock.end(`${JSON.stringify({ type: 'reject', reason: 'version' })}\n`); return; }
        const old = clients.get(m.id);
        if (old && old.sock !== sock) old.sock.destroy();
        c = { id: String(m.id), name: String(m.name || m.id), address: sock.remoteAddress.replace(/^::ffff:/, ''), displays: m.displays || [], status: null, sock, ready: true };
        clients.set(c.id, c);
        write(c, JSON.stringify({ type: 'welcome', name, proto: PROTO }));
        if (filesMsg) write(c, filesMsg);
        write(c, JSON.stringify({ type: 'outputs', on: outputsOn }));
        if (lastBlendStr) write(c, lastBlendStr);
        if (lastStateStr) write(c, lastStateStr);
        emitClients();
        return;
      }
      if (!c) return;
      if (m.type === 'status') { c.status = m.status || null; if (m.status?.displays) c.displays = m.status.displays; emitClients(); }
      else if (m.type === 'event' && m.msg) onEvent({ type: 'outputEvent', host: c.id, msg: m.msg });
    }));
    const gone = () => { if (c && clients.get(c.id)?.sock === sock) { clients.delete(c.id); emitClients(); } };
    sock.on('close', gone);
    sock.on('error', () => {});
  });
  ctrl.on('error', (e) => onEvent({ type: 'error', where: 'ctrl', error: e.message }));
  ctrl.listen(ports.ctrl, host);
  servers.push(ctrl);

  // ---------------- Dateien (mit Range, damit Videos auch vor dem Kopieren gestreamt werden können)
  const fileSrv = http.createServer((req, res) => {
    if (!isLocalAddress(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return; }
    const fid = (req.url.match(/^\/f\/([0-9a-f]{16})/) || [])[1];
    const f = fid && files.get(fid);
    if (!f) { res.writeHead(404); res.end(); return; }
    const size = f.size;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0, end = size - 1;
    if (range) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Math.min(size - 1, Number(range[2]));
      if (!range[1] && range[2]) { start = Math.max(0, size - Number(range[2])); end = size - 1; }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(f.path, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
  fileSrv.on('error', (e) => onEvent({ type: 'error', where: 'files', error: e.message }));
  fileSrv.listen(ports.files, host);
  servers.push(fileSrv);

  // ---------------- Finden
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('error', () => {});
  udp.bind(() => { try { udp.setBroadcast(true); } catch { /* ohne Broadcast: Adresse von Hand eingeben */ } });
  const announce = () => {
    const msg = Buffer.from(JSON.stringify({ ps: MAGIC, proto: PROTO, name, ctrl: ports.ctrl, files: ports.files }));
    for (const a of broadcastAddresses()) udp.send(msg, ports.disc, a, () => {});
  };
  const annTimer = setInterval(announce, 2000);
  setTimeout(announce, 100);

  return {
    role: 'master',
    clients: list,
    /** Nachricht des Hauptfensters an alle Ausgänge. */
    broadcast(msg) {
      if (msg.type === 'state') {
        lastState = msg;
        if (updateFiles(msg)) all(filesMsg);
        const str = JSON.stringify(msg);
        if (str === lastStateStr) return;
        lastStateStr = str;
        all(str, true);
      } else if (msg.type === 'blend') {
        const str = JSON.stringify(msg);
        if (str === lastBlendStr) return;
        lastBlendStr = str;
        all(str);
      } else if (msg.type === 'pattern') {
        const str = JSON.stringify(msg);
        if (str === lastPatternStr) return;
        lastPatternStr = str;
        all(str);
      }
    },
    setOutputs(on) {
      if (outputsOn === !!on) return;
      outputsOn = !!on;
      all(JSON.stringify({ type: 'outputs', on: outputsOn }));
    },
    get state() { return lastState; },
    stop() {
      clearInterval(annTimer);
      for (const c of clients.values()) c.sock.destroy();
      clients.clear();
      for (const s of servers) s.close();
      try { udp.close(); } catch { /* schon zu */ }
    },
  };
}

// ======================================================================= Ausgaberechner
/**
 * id/name: dieser Rechner. cacheDir: Zwischenspeicher für Modell und Videos.
 * displays(): eigene Bildschirme. openOutputs([{ displayId, outputId }]): genau diese Ausgabefenster öffnen.
 * toOutputs(msg): Nachricht an alle eigenen Ausgabefenster. target: Adresse des Hauptrechners (oder automatisch).
 */
export function startClient({ id, name = os.hostname(), cacheDir, displays = () => [], openOutputs = () => {}, toOutputs = () => {}, onEvent = () => {}, ports = PORTS, target = null, discover = true } = {}) {
  const masters = new Map(); // address -> { address, name, ctrl, files, seen }
  const clock = new ClockSync();
  let files = new Map(); // fid -> { fid, path, name, size, local, ready, got }
  let byPath = new Map();
  let sock = null, connected = false, masterName = '', stopped = false, address = target;
  let lastState = null, lastBlend = null, outputsOn = false, appliedOffset = 0, outputsKey = '';
  let pingTimer = null, retryTimer = null, statusTimer = null, lastStatusStr = '', reject = '';
  let filesPort = ports.files;
  let downloading = false;

  const status = () => {
    const list = [...files.values()];
    return {
      connected, address, masterName, reject,
      offset: clock.ready ? Math.round(clock.offset * 10) / 10 : null,
      error: clock.ready ? Math.round(clock.error * 10) / 10 : null,
      files: { done: list.filter((f) => f.ready).length, total: list.length, bytes: list.reduce((s, f) => s + (f.ready ? f.size : f.got || 0), 0), totalBytes: list.reduce((s, f) => s + f.size, 0) },
      outputs: outputsKey ? outputsKey.split('|').filter(Boolean) : [],
      displays: displays(),
    };
  };
  const emit = () => {
    const st = status();
    onEvent({ type: 'client', status: st, masters: [...masters.values()] });
    const str = JSON.stringify(st);
    if (connected && str !== lastStatusStr) { lastStatusStr = str; send({ type: 'status', status: st }); }
  };
  const send = (m) => { if (sock && connected && !sock.destroyed) sock.write(`${JSON.stringify(m)}\n`); };

  // ---------------- Finden
  let udp = null;
  if (discover) {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', () => {});
    udp.on('message', (buf, rinfo) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.ps !== MAGIC || !isLocalAddress(rinfo.address)) return;
      const known = masters.has(rinfo.address);
      masters.set(rinfo.address, { address: rinfo.address, name: m.name, proto: m.proto, ctrl: m.ctrl || ports.ctrl, files: m.files || ports.files, seen: Date.now() });
      if (!known) emit();
      // genau ein Hauptrechner im Netz und noch keiner gewählt: automatisch verbinden
      if (!address && masters.size === 1) connect(rinfo.address);
    });
    udp.bind(ports.disc);
  }
  const sweep = setInterval(() => {
    let changed = false;
    for (const [a, m] of masters) if (Date.now() - m.seen > 7000) { masters.delete(a); changed = true; }
    if (changed) emit();
  }, 3000);

  // ---------------- Dateien
  const localFor = (p, needLocal) => {
    const f = files.get(byPath.get(p));
    if (!f) return needLocal ? null : p;
    if (f.ready) return f.local;
    return needLocal ? null : `http://${address}:${filesPort}/f/${f.fid}`;
  };
  async function download() {
    if (downloading) return;
    downloading = true;
    try {
      for (const f of files.values()) {
        if (f.ready || stopped) continue;
        await fsp.mkdir(cacheDir, { recursive: true });
        const part = `${f.local}.part`;
        await new Promise((resolve) => {
          const req = http.get({ host: address, port: filesPort, path: `/f/${f.fid}` }, (res) => {
            if (res.statusCode !== 200) { res.resume(); resolve(); return; }
            const out = fs.createWriteStream(part);
            f.got = 0;
            let tick = 0;
            res.on('data', (d) => { f.got += d.length; if (Date.now() - tick > 500) { tick = Date.now(); emit(); } });
            res.pipe(out);
            out.on('finish', resolve);
            out.on('error', resolve);
            res.on('error', resolve);
          });
          req.on('error', resolve);
        });
        try {
          const st = await fsp.stat(part);
          if (st.size === f.size && files.get(f.fid) === f) { await fsp.rename(part, f.local); f.ready = true; apply(); }
        } catch { /* nächster Versuch beim nächsten Dateiabgleich */ }
        emit();
      }
    } finally { downloading = false; }
    if ([...files.values()].some((f) => !f.ready) && connected && !stopped) setTimeout(download, 3000);
  }
  async function setFiles(list) {
    const next = new Map();
    for (const x of list) {
      const prev = files.get(x.fid);
      const local = path.join(cacheDir, `${x.fid}-${safeName(x.name)}`);
      let ready = !!prev?.ready;
      if (!ready) { try { ready = (await fsp.stat(local)).size === x.size; } catch { ready = false; } }
      next.set(x.fid, { fid: x.fid, path: x.path, name: x.name, size: x.size, local, ready, got: 0 });
    }
    files = next;
    byPath = new Map([...files.values()].map((f) => [f.path, f.fid]));
    apply();
    emit();
    download();
  }

  // ---------------- Zustand an die eigenen Ausgänge
  function applyOutputs() {
    const want = outputsOn && lastState?.project
      ? lastState.project.outputs.filter((o) => o.host === id && o.hostDisplay != null).map((o) => ({ displayId: o.hostDisplay, outputId: o.id }))
      : [];
    const key = want.map((w) => `${w.outputId}@${w.displayId}`).join('|');
    if (key === outputsKey) return;
    outputsKey = key;
    openOutputs(want);
    emit();
  }
  function apply() {
    if (!lastState) return;
    appliedOffset = clock.offset;
    applyOutputs();
    toOutputs(rewriteState(lastState, localFor, appliedOffset));
  }

  // ---------------- Verbindung
  function open() {
    if (stopped || !address) return;
    clearTimeout(retryTimer);
    const m = masters.get(address);
    filesPort = m?.files || ports.files;
    const s = net.connect({ host: address, port: m?.ctrl || ports.ctrl });
    sock = s;
    s.setNoDelay(true);
    s.setEncoding('utf8');
    s.on('connect', () => {
      connected = true;
      reject = '';
      s.write(`${JSON.stringify({ type: 'hello', proto: PROTO, id, name, displays: displays() })}\n`);
      clock.samples = [];
      let n = 0;
      const ping = () => { send({ type: 'ping', t0: Date.now() }); };
      clearInterval(pingTimer);
      // erst schnell einige Messungen, dann alle 2 s
      const fast = setInterval(() => { ping(); if (++n >= 8) clearInterval(fast); }, 150);
      pingTimer = setInterval(ping, 2000);
      emit();
    });
    s.on('data', lineReader((msg) => {
      if (msg.type === 'pong') {
        clock.add(msg.t0, msg.tm, Date.now());
        if (lastState && Math.abs(clock.offset - appliedOffset) > 1.5) apply();
        return;
      }
      if (msg.type === 'welcome') { masterName = msg.name; emit(); }
      else if (msg.type === 'reject') { reject = msg.reason; emit(); }
      else if (msg.type === 'files') setFiles(msg.files || []);
      else if (msg.type === 'outputs') { outputsOn = !!msg.on; applyOutputs(); }
      else if (msg.type === 'state') { lastState = msg; apply(); }
      else if (msg.type === 'blend') { lastBlend = msg; toOutputs(msg); }
      else if (msg.type === 'pattern') toOutputs(msg);
    }));
    const down = () => {
      if (sock !== s) return;
      const was = connected;
      connected = false;
      sock = null;
      clearInterval(pingTimer);
      if (was) emit();
      if (!stopped && address) retryTimer = setTimeout(open, 2000);
    };
    s.on('close', down);
    s.on('error', () => {});
  }
  function connect(addr) {
    if (addr === address && (connected || sock)) return;
    address = addr || null;
    masterName = '';
    if (sock) { const s = sock; sock = null; connected = false; s.destroy(); }
    lastState = null; outputsKey = '';
    openOutputs([]);
    onEvent({ type: 'target', address });
    open();
    emit();
  }
  statusTimer = setInterval(emit, 2000);
  if (address) open();

  return {
    role: 'client',
    status,
    masters: () => [...masters.values()],
    connect,
    /** Meldung eines eigenen Ausgabefensters. */
    fromOutput(msg) {
      if (msg.type === 'ready') { apply(); if (lastBlend) toOutputs(lastBlend); return; }
      if (msg.type === 'stats' || msg.type === 'patternShown') send({ type: 'event', msg });
    },
    displaysChanged() { lastStatusStr = ''; emit(); },
    async clearCache() {
      const keep = new Set([...files.values()].map((f) => path.basename(f.local)));
      let n = 0;
      for (const f of await fsp.readdir(cacheDir).catch(() => [])) if (!keep.has(f)) { await fsp.rm(path.join(cacheDir, f), { force: true }); n++; }
      return n;
    },
    stop() {
      stopped = true;
      clearInterval(pingTimer); clearInterval(statusTimer); clearInterval(sweep); clearTimeout(retryTimer);
      if (sock) sock.destroy();
      try { udp?.close(); } catch { /* schon zu */ }
      openOutputs([]);
    },
  };
}
