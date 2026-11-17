import test from 'node:test';
import assert from 'node:assert/strict';
import { SWEEP, schedule, analyzeRecording, designCorrection, fitPeaking, logGrid, peakingResponse } from '../src/shared/roomeq.js';

// Aufnahme simulieren: unbekannter Versatz, Uhrgang, Laufzeit, Pegel, eine Reflexion je Lautsprecher, Rauschen
function simulate({ fs = 48000, n, delays, gains, refl = 0.3, reflDelay = 0.007, offset = 0.37, ppm = 40, noise = 1e-3, seed = 1 }) {
  const { slots, total } = schedule(n);
  const len = Math.round((total + offset + 0.5) * fs);
  const rec = new Float32Array(len);
  const { f1, f2, seconds } = SWEEP, L = seconds / Math.log(f2 / f1);
  const sweep = (t) => (t < 0 || t >= seconds ? 0 : Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1)) * Math.min(1, t / SWEEP.fade, (seconds - t) / SWEEP.fade));
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < len; i++) {
    const t = (i / fs) * (1 + ppm * 1e-6) - offset; // Zeit der Wiedergabeuhr
    let v = 0;
    for (const sl of slots) {
      const k = sl.speaker, tt = t - sl.at - delays[k];
      if (tt < -0.01 || tt > seconds + 0.05) continue;
      v += gains[k] * (sweep(tt) + refl * sweep(tt - reflDelay));
    }
    rec[i] = v + noise * rnd();
  }
  return rec;
}

test('Raumeinmessung: Laufzeiten und Pegel aus einer Aufnahme (mit Uhrgang)', () => {
  const delays = [0.0102, 0.0151, 0.0123, 0.0199];
  const gains = [0.5, 0.25, 0.4, 0.5];
  const rec = simulate({ n: 4, delays, gains });
  const { speakers, drift } = analyzeRecording(rec, 48000, 4);
  assert.ok(Math.abs(Math.abs(drift) - 40) < 5, `Uhrgang ${drift}`);
  const rel = speakers.map((s) => s.arrival - speakers[0].arrival);
  delays.forEach((d, k) => assert.ok(Math.abs(rel[k] - (d - delays[0])) < 1e-4, `Laufzeit ${k}: ${rel[k]} statt ${d - delays[0]}`));
  const dl = speakers.map((s) => s.level - speakers[0].level);
  gains.forEach((g, k) => assert.ok(Math.abs(dl[k] - 20 * Math.log10(g / gains[0])) < 0.5, `Pegel ${k}: ${dl[k]}`));
  for (const s of speakers) assert.ok(s.snr > 30, `SNR ${s.snr}`);
});

test('Raumeinmessung: Korrektur gleicht Laufzeit und Pegel über mehrere Stellen aus', () => {
  const pos = [
    { delays: [0.010, 0.015, 0.012], gains: [0.5, 0.25, 0.4] },
    { delays: [0.012, 0.013, 0.014], gains: [0.45, 0.3, 0.35] },
  ];
  const meas = pos.map((p, i) => analyzeRecording(simulate({ n: 3, ...p, offset: 0.2 + i * 0.3, seed: i + 3 }), 48000, 3).speakers);
  const c = designCorrection(meas);
  // mittlere Ankunft: 11, 14, 13 ms → Verzögerung 3, 0, 1 ms
  assert.ok(Math.abs(c[0].delay - 3) < 0.15 && Math.abs(c[1].delay) < 0.15 && Math.abs(c[2].delay - 1) < 0.15, JSON.stringify(c.map((x) => x.delay)));
  // lautester wird abgesenkt, leisester bleibt
  assert.ok(Math.abs(c[1].gain) < 0.3 && c[0].gain < -3, JSON.stringify(c.map((x) => x.gain)));
  for (const x of c) for (const f of x.filters) assert.ok(f.gain <= 3 && f.gain >= -10 && f.f >= 100 && f.f <= 10000);
});

test('EQ-Anpassung: Senke und Überhöhung werden mit begrenzten Filtern ausgeglichen', () => {
  const grid = logGrid(20, 20000, 24);
  const dev = grid.map((f) => (f > 100 && f < 10000 ? peakingResponse({ f: 800, gain: 7, q: 2 }, f) + peakingResponse({ f: 3000, gain: -6, q: 1.5 }, f) : 0));
  const flt = fitPeaking(grid, dev);
  assert.ok(flt.length >= 2 && flt.length <= 8);
  const cut = flt.find((x) => Math.abs(Math.log2(x.f / 800)) < 0.2);
  assert.ok(cut && cut.gain < -5, JSON.stringify(flt));
  const boost = flt.find((x) => Math.abs(Math.log2(x.f / 3000)) < 0.3);
  assert.ok(boost && boost.gain <= 3 && boost.gain > 1.5, JSON.stringify(flt));
});

test('Raumeinmessung: ein linearer, flacher Weg ergibt keine EQ-Filter', () => {
  const meas = [0.2, 0.5].map((offset, i) => analyzeRecording(simulate({ n: 2, delays: [0, 0.003], gains: [0.5, 0.25], refl: 0, noise: 1e-5, offset, seed: i + 7 }), 48000, 2).speakers);
  const c = designCorrection(meas);
  for (const x of c) assert.equal(x.filters.length, 0, JSON.stringify(x.filters));
  assert.ok(Math.abs(c[0].delay - 3) < 0.1 && Math.abs(c[0].gain + 6.02) < 0.2);
});
