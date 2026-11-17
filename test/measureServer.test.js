import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMeasureServer, stopMeasureServer, phoneRecord, lanAddresses } from '../src/main/measureServer.js';

const req = (url, method = 'GET', body = null, type = 'application/json') => new Promise((resolve, reject) => {
  const r = https.request(url, { method, rejectUnauthorized: false, headers: { 'Content-Type': type } }, (res) => {
    const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
  });
  r.on('error', reject);
  if (body) r.write(body);
  r.end();
});

test('Handy-Messserver: Seite, Verbindung, Aufnahme hochladen', { skip: !lanAddresses().length && 'kein Netzwerk' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
  const events = [];
  const info = await startMeasureServer(dir, (e) => events.push(e));
  try {
    assert.match(info.url, /^https:\/\/[\d.]+:\d+\/m\//);
    assert.match(info.qr, /^data:image\/png;base64,/);
    const page = await req(info.url);
    assert.equal(page.status, 200);
    assert.match(page.body, /getUserMedia/);
    assert.equal((await req(info.url.replace(/\/m\/[^/]+/, '/m/falsch'))).status, 404);
    await req(`${info.url}/poll`, 'POST', JSON.stringify({ level: 0.01, fs: 48000, ready: true }));
    assert.ok(events.some((e) => e.type === 'phone'));
    let started = false;
    const p = phoneRecord(1, () => { started = true; });
    const poll = JSON.parse((await req(`${info.url}/poll`, 'POST', '{}')).body);
    assert.equal(poll.cmd.cmd, 'record');
    await req(`${info.url}/started?id=${poll.cmd.id}`, 'POST', '{}');
    const data = new Float32Array([0.1, -0.2, 0.3]);
    await req(`${info.url}/upload?id=${poll.cmd.id}&fs=44100`, 'POST', Buffer.from(data.buffer), 'application/octet-stream');
    const r = await p;
    assert.ok(started);
    assert.equal(r.fs, 44100);
    assert.deepEqual([...r.samples].map((v) => +v.toFixed(3)), [0.1, -0.2, 0.3]);
  } finally { stopMeasureServer(); }
});
