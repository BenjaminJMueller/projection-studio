import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClockSync, lineReader, rewriteState, referencedFiles, isLocalAddress, startMaster, startClient } from '../src/main/cluster.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await wait(20); }
  throw new Error('Zeitüberschreitung');
}

test('Uhrabgleich nimmt die Messung mit dem kürzesten Weg', () => {
  const c = new ClockSync();
  // wahrer Versatz 500 ms; langsame Messungen sind asymmetrisch verfälscht
  c.add(1000, 1530, 1040); // rtt 40, Schätzung 510
  c.add(2000, 2502, 2004); // rtt 4, Schätzung 500
  c.add(3000, 3560, 3080); // rtt 80, Schätzung 520
  assert.equal(c.ready, true);
  assert.equal(c.offset, 500);
  assert.equal(c.error, 2);
});

test('Zeilen werden auch über Paketgrenzen zusammengesetzt', () => {
  const got = [];
  const r = lineReader((m) => got.push(m));
  r('{"a":1}\n{"b"');
  r(':2}\n\n{kaputt}\n{"c":3}\n');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('Zustand: Dateien und Abspielzeit werden für den Ausgaberechner umgeschrieben', () => {
  const msg = { type: 'state', modelPath: '/m/decke.obj', play: { playing: true, startedAt: 10000 }, project: { playback: { items: [{ src: '/v/a.mp4' }, { src: '/v/b.mp4' }] } } };
  assert.deepEqual(referencedFiles(msg), ['/m/decke.obj', '/v/a.mp4', '/v/b.mp4']);
  const local = (p, need) => (p === '/v/a.mp4' ? '/cache/a.mp4' : need ? null : `http://m/${p}`);
  const out = rewriteState(msg, local, 250);
  assert.equal(out.modelPath, null); // Modell erst, wenn es kopiert ist
  assert.deepEqual(out.project.playback.items.map((x) => x.src), ['/cache/a.mp4', 'http://m//v/b.mp4']);
  assert.equal(out.play.startedAt, 9750);
  assert.equal(msg.play.startedAt, 10000); // Original unverändert
});

test('nur Adressen im eigenen Netz', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.1.1', '::ffff:192.168.1.2', '169.254.3.4', '::1']) assert.equal(isLocalAddress(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '::ffff:1.2.3.4', '']) assert.equal(isLocalAddress(a), false, a);
});

test('Hauptrechner und Ausgaberechner über Loopback: Verbinden, Datei kopieren, Ausgänge öffnen', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ps-cluster-'));
  const video = path.join(dir, 'film.mp4');
  await fs.writeFile(video, Buffer.alloc(300000, 7));
  const model = path.join(dir, 'decke.obj');
  await fs.writeFile(model, 'v 0 0 0\n');
  const ports = { ctrl: 47910, disc: 47911, files: 47912 };
  const events = [];
  const master = startMaster({ name: 'Haupt', ports, host: '127.0.0.1', onEvent: (e) => events.push(e) });
  const opened = [], toOut = [];
  const client = startClient({
    id: 'c1', name: 'Rechner 2', cacheDir: path.join(dir, 'cache'), ports, target: '127.0.0.1', discover: false,
    displays: () => [{ id: 5, label: 'Beamer', pixelSize: { width: 1920, height: 1080 } }],
    openOutputs: (w) => opened.push(w), toOutputs: (m) => toOut.push(m),
  });
  try {
    await until(() => master.clients().length === 1);
    assert.equal(master.clients()[0].name, 'Rechner 2');
    assert.equal(master.clients()[0].displays[0].id, 5);
    const project = { outputs: [{ id: 'A', displayId: 1 }, { id: 'C', host: 'c1', hostDisplay: 5 }], playback: { items: [{ src: video }] } };
    master.broadcast({ type: 'state', project, modelPath: model, play: { playing: true, startedAt: Date.now() } });
    master.setOutputs(true);
    // Modell und Video werden kopiert; danach zeigen die Ausgänge auf die lokalen Kopien
    const last = await until(() => { const m = toOut.filter((x) => x.type === 'state').at(-1); return m && m.modelPath && !m.project.playback.items[0].src.startsWith('http') && m; });
    assert.equal((await fs.readFile(last.project.playback.items[0].src)).length, 300000);
    assert.equal(await fs.readFile(last.modelPath, 'utf8'), 'v 0 0 0\n');
    assert.deepEqual(opened.at(-1), [{ displayId: 5, outputId: 'C' }]);
    // Uhrabgleich über Loopback: Versatz nahe 0
    await until(() => client.status().offset != null);
    assert.ok(Math.abs(client.status().offset) < 20);
    // Status kommt beim Hauptrechner an
    await until(() => master.clients()[0].status?.files?.done === 2);
    // Ausgang schließen
    master.setOutputs(false);
    await until(() => opened.at(-1)?.length === 0);
    // Meldungen der Ausgabefenster gehen an den Hauptrechner
    client.fromOutput({ type: 'stats', outputId: 'C', fps: 60 });
    await until(() => events.some((e) => e.type === 'outputEvent' && e.msg.outputId === 'C' && e.host === 'c1'));
  } finally {
    client.stop();
    master.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Ausgaberechner meldet, wenn am Hauptrechner nichts lauscht', async () => {
  const client = startClient({ id: 'c2', cacheDir: os.tmpdir(), ports: { ctrl: 47920, disc: 47921, files: 47922 }, target: '127.0.0.1', discover: false });
  try { await until(() => client.status().problem === 'refused'); } finally { client.stop(); }
});
