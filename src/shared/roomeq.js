// Raumeinmessung ohne Sweetspot: Sweep je Lautsprecher, Messung an mehreren Stellen der Liegefläche,
// daraus je Lautsprecher Laufzeit, Pegel und eine sanfte Klangkorrektur (gemittelt über alle Stellen).
//
// Messprinzip: exponentieller Sinus-Sweep nach Farina (2000). Faltung der Aufnahme mit dem inversen
// Sweep liefert die Impulsantwort; Verzerrungsprodukte landen dabei vor dem linearen Anteil und stören nicht.
// Alle Lautsprecher werden nacheinander in einer einzigen Aufnahme gemessen. Laufzeiten ergeben sich aus
// den Abständen der Impulse zueinander, damit ist keine gemeinsame Uhr zwischen Rechner und Mikrofon nötig
// (wichtig für das Smartphone). Am Ende kommt der erste Lautsprecher noch einmal: aus dem gemessenen Abstand
// ergibt sich die Gangabweichung der beiden Uhren, die herausgerechnet wird.

// ---------------------------------------------------------------- FFT (radix 2, in place)
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const pow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

// ---------------------------------------------------------------- Sweep
export const SWEEP = { f1: 40, f2: 16000, seconds: 2, gap: 1.2, fade: 0.05 };

/** Exponentieller Sweep f1→f2 über T Sekunden mit weichen Rändern. */
export function logSweep(fs, { f1, f2, seconds } = SWEEP, fade = SWEEP.fade) {
  const n = Math.round(seconds * fs), L = seconds / Math.log(f2 / f1);
  const out = new Float32Array(n);
  const nf = Math.round(fade * fs);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let w = 1;
    if (i < nf) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / nf);
    else if (i > n - nf) w = 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / nf);
    out[i] = w * Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
  }
  return out;
}

/** Inverser Filter: zeitgespiegelter Sweep mit −6 dB/Oktave Ausgleich (Farina). */
export function inverseSweep(fs, opt = SWEEP) {
  const s = logSweep(fs, opt);
  const n = s.length, L = opt.seconds / Math.log(opt.f2 / opt.f1);
  const inv = new Float32Array(n);
  for (let i = 0; i < n; i++) inv[i] = s[n - 1 - i] * Math.exp(-(n - 1 - i) / fs / L);
  // Normierung: Sweep ∗ Inverse ergibt einen Impuls der Höhe 1
  const k = convolve(s, inv);
  let m = 0;
  for (const v of k) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < n; i++) inv[i] /= m;
  return inv;
}

/** Lineare Faltung per FFT. */
export function convolve(a, b) {
  const n = pow2(a.length + b.length - 1);
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; }
  fft(ar, ai, true);
  return Float32Array.from(ar.subarray(0, a.length + b.length - 1));
}

// ---------------------------------------------------------------- Ablaufplan einer Messung
/**
 * Startzeiten (Sekunden ab Beginn der Wiedergabe) für n Lautsprecher plus Wiederholung des ersten.
 * lead: Vorlauf, damit die Aufnahme sicher schon läuft.
 */
export function schedule(n, opt = SWEEP, lead = 1) {
  const step = opt.seconds + opt.gap;
  const slots = Array.from({ length: n }, (_, k) => ({ speaker: k, at: lead + k * step }));
  slots.push({ speaker: 0, at: lead + n * step, repeat: true });
  return { slots, total: lead + (n + 1) * step + 0.5 };
}

// ---------------------------------------------------------------- Auswertung einer Aufnahme

/**
 * Aufnahme (Float32, Rate fsRec) auswerten. Rückgabe je Lautsprecher:
 * { arrival (s, relativ zum ersten Lautsprecher, Uhrgang korrigiert), level (dB), mag (dB je Frequenzpunkt), snr (dB) }.
 */
export function analyzeRecording(rec, fsRec, nSpeakers, opt = SWEEP) {
  const inv = inverseSweep(fsRec, opt);
  const n = inv.length;
  // Impulsantwort nur abschnittsweise berechnen (eine Messung mit 32 Lautsprechern dauert ~2 Minuten,
  // eine Faltung am Stück bräuchte Hunderte MB). seg(a, b) liefert h[a..b) mit h = rec ∗ inv.
  const seg = (a, b) => {
    a = Math.max(0, a); b = Math.min(rec.length + n - 1, b);
    const r0 = Math.max(0, a - n + 1);
    const c = convolve(rec.subarray(r0, Math.min(rec.length, b)), inv);
    const off = a - r0;
    const data = c.subarray(off, off + (b - a));
    return { a, data, at: (i) => data[i - a] ?? 0 };
  };
  const sweepLen = Math.round(opt.seconds * fsRec);
  const { slots } = schedule(nSpeakers, opt);
  const step = opt.seconds + opt.gap;
  // Der lineare Impuls erscheint bei (Start + Sweeplänge − 1). Erst den ersten finden (unbekannter
  // Versatz der Aufnahme, bis einige Sekunden), dann jeden Lautsprecher in einem Fenster um seine Stelle.
  const first = seg(sweepLen - 1, Math.round((slots[0].at + opt.seconds + step * 0.5 + 4) * fsRec));
  let gi = first.a, gm = 0;
  first.data.forEach((v, i) => { if (Math.abs(v) > gm) { gm = Math.abs(v); gi = first.a + i; } });
  const origin = gi - (sweepLen - 1) - Math.round(slots[0].at * fsRec); // Index von „Zeit 0“ der Wiedergabe
  const win = Math.round(Math.min(step * 0.45, 0.35) * fsRec);
  const pre = Math.round(0.35 * fsRec), post = Math.round(0.15 * fsRec);
  const found = slots.map((sl) => {
    const expect = origin + Math.round(sl.at * fsRec) + sweepLen - 1;
    const h = seg(expect - win - pre, expect + win + post);
    let mi = -1, mv = 0;
    for (let i = expect - win; i < expect + win; i++) { const v = Math.abs(h.at(i)); if (v > mv) { mv = v; mi = i; } }
    // Laufzeit am Maximum (Direktschall). Ein Schwellwert davor wäre durch das Nachschwingen des
    // bandbegrenzten Impulses ungenauer.
    return { idx: mi, peak: mv, h };
  });
  const peakAtF = (f) => {
    const a = Math.abs(f.h.at(f.idx - 1)), b = Math.abs(f.h.at(f.idx)), c = Math.abs(f.h.at(f.idx + 1));
    const d = a - 2 * b + c;
    return d ? f.idx + (0.5 * (a - c)) / d : f.idx;
  };
  // Uhrgang: Abstand erster Lautsprecher ↔ Wiederholung
  const rep = found[found.length - 1], f0 = found[0];
  const nominal = (slots[slots.length - 1].at - slots[0].at) * fsRec;
  const measured = peakAtF(rep) - peakAtF(f0);
  const drift = Number.isFinite(measured) && Math.abs(measured / nominal - 1) < 0.002 ? measured / nominal : 1;
  const nfft = 8192;
  // Frequenzgang: Fenster ab 5 ms vor dem Impuls (weich eingeblendet), ~85 ms (Direktschall und frühe
  // Reflexionen), Hann-Ausklang. Der ideale Impuls (Sweep ∗ Inverse) im selben Fenster dient als Bezug,
  // so fallen Bandgrenzen und Fensterwirkung heraus.
  const pre5 = Math.round(0.005 * fsRec), len = Math.min(nfft, Math.round(0.085 * fsRec));
  const spectrum = (at, idx) => {
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    let energy = 0;
    for (let i = 0; i < len; i++) {
      const w = i < pre5 ? 0.5 - 0.5 * Math.cos((Math.PI * i) / pre5) : i < len * 0.8 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (i - len * 0.8)) / (len * 0.2));
      const v = at(idx - pre5 + i) * w;
      re[i] = v; energy += v * v;
    }
    fft(re, im);
    const mag = new Float32Array(nfft / 2);
    for (let i = 0; i < nfft / 2; i++) mag[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-20);
    return { mag, energy };
  };
  const ideal = convolve(logSweep(fsRec, opt), inv);
  const ref = spectrum((i) => ideal[i] ?? 0, sweepLen - 1).mag;
  const res = [];
  for (let k = 0; k < nSpeakers; k++) {
    const f = found[k];
    // Ankunft relativ zum ersten Lautsprecher dieser Aufnahme (Versatz der Aufnahme fällt heraus)
    const t = (peakAtF(f) - peakAtF(f0)) / fsRec / drift - (slots[k].at - slots[0].at);
    const { mag, energy } = spectrum(f.h.at, f.idx);
    for (let i = 0; i < mag.length; i++) mag[i] -= ref[i];
    // Störabstand: Bereich vor dem Impuls (Störgeräusch und Verzerrungsreste)
    let noise = 0, nn = 0;
    for (let i = f.idx - Math.round(0.3 * fsRec); i < f.idx - Math.round(0.05 * fsRec); i++) { const v = f.h.at(i); noise += v * v; nn++; }
    const snr = 10 * Math.log10((f.peak * f.peak) / (noise / Math.max(1, nn) + 1e-20));
    res.push({ arrival: t, level: 10 * Math.log10(energy + 1e-20), mag, snr, fs: fsRec, nfft, peak: f.peak });
  }
  return { speakers: res, drift: (drift - 1) * 1e6 };
}

// ---------------------------------------------------------------- Glättung und Frequenzraster
/** Logarithmisches Raster (Hz) für Auswertung und Anzeige. */
export function logGrid(f1 = 20, f2 = 20000, perOct = 12) {
  const out = [];
  for (let f = f1; f <= f2 * 1.0001; f *= 2 ** (1 / perOct)) out.push(f);
  return out;
}
/** Betrag (dB, linearer FFT-Raster) auf log-Raster mit Bandbreite frac Oktave glätten (Leistungsmittel). */
export function smoothToGrid(mag, fs, nfft, grid, frac = 1 / 3) {
  const df = fs / nfft, k = 2 ** (frac / 2);
  return grid.map((f) => {
    const a = Math.max(1, Math.floor(f / k / df)), b = Math.min(mag.length - 1, Math.ceil((f * k) / df));
    let s = 0, n = 0;
    for (let i = a; i <= b; i++) { s += 10 ** (mag[i] / 10); n++; }
    return 10 * Math.log10(s / Math.max(1, n) + 1e-20);
  });
}

// ---------------------------------------------------------------- Biquad (Peaking EQ, RBJ Audio EQ Cookbook)
export function peakingCoeffs(f, gainDb, q, fs) {
  const A = 10 ** (gainDb / 40), w = (2 * Math.PI * f) / fs, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + al / A;
  return { b0: (1 + al * A) / a0, b1: (-2 * c) / a0, b2: (1 - al * A) / a0, a1: (-2 * c) / a0, a2: (1 - al / A) / a0 };
}
/** Betrag eines Peaking-Filters (dB) bei Frequenz x. */
export function peakingResponse(flt, x, fs = 48000) {
  const { b0, b1, b2, a1, a2 } = peakingCoeffs(flt.f, flt.gain, flt.q, fs);
  const w = (2 * Math.PI * x) / fs;
  const cr = Math.cos(w), ci = -Math.sin(w), c2r = Math.cos(2 * w), c2i = -Math.sin(2 * w);
  const nr = b0 + b1 * cr + b2 * c2r, ni = b1 * ci + b2 * c2i;
  const dr = 1 + a1 * cr + a2 * c2r, di = a1 * ci + a2 * c2i;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

// ---------------------------------------------------------------- Korrektur entwerfen
export const EQ_LIMITS = { fLow: 100, fHigh: 10000, maxCut: -10, maxBoost: 3, maxFilters: 8, maxGainTrim: 12 };

/**
 * measurements[pos][speaker] = Ergebnis aus analyzeRecording.
 * Rückgabe je Lautsprecher: { delay (ms), gain (dB), filters: [{f, gain, q}], curve, target, spread }
 * - Laufzeit: Mittel über alle Stellen; alle Lautsprecher kommen im Mittel gleichzeitig an.
 * - Pegel: Mittel über alle Stellen; leisester Lautsprecher bleibt, die anderen werden abgesenkt.
 * - Klang: Leistungsmittel über die Stellen, 1/3 Oktave geglättet. Ziel ist der Median aller Lautsprecher,
 *   stark geglättet (1 Oktave). So bleibt der natürliche Charakter des Raums, Abweichungen einzelner
 *   Lautsprecher werden ausgeglichen. Nur was an allen Stellen ähnlich ist, wird korrigiert (Streuung).
 */
export function designCorrection(measurements, limits = EQ_LIMITS) {
  const P = measurements.length, N = measurements[0].length;
  const grid = logGrid(20, 20000, 24);
  const curves = [], spreads = [], arrivals = [], levels = [];
  for (let k = 0; k < N; k++) {
    const per = measurements.map((m) => smoothToGrid(m[k].mag, m[k].fs, m[k].nfft, grid, 1 / 3));
    const curve = grid.map((_, i) => 10 * Math.log10(per.reduce((s, c) => s + 10 ** (c[i] / 10), 0) / P));
    const spread = grid.map((_, i) => Math.sqrt(per.reduce((s, c) => s + (c[i] - curve[i]) ** 2, 0) / P));
    curves.push(curve); spreads.push(spread);
    arrivals.push(measurements.reduce((s, m) => s + m[k].arrival, 0) / P);
    // Pegel im Korrekturband, über die Stellen gemittelt (Leistung)
    const band = grid.map((f, i) => [f, i]).filter(([f]) => f >= limits.fLow && f <= limits.fHigh).map(([, i]) => curve[i]);
    levels.push(10 * Math.log10(band.reduce((s, v) => s + 10 ** (v / 10), 0) / band.length));
  }
  const latest = Math.max(...arrivals);
  const minLevel = Math.min(...levels);
  // Ziel: Median der (pegelbereinigten) Kurven, 1 Oktave geglättet
  const norm = curves.map((c, k) => c.map((v) => v - levels[k]));
  const median = grid.map((_, i) => { const v = norm.map((c) => c[i]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; });
  const target = grid.map((f, i) => {
    let s = 0, n = 0;
    for (let j = 0; j < grid.length; j++) if (Math.abs(Math.log2(grid[j] / f)) <= 0.5) { s += median[j]; n++; }
    return s / n;
  });
  return curves.map((c, k) => {
    const dev = grid.map((f, i) => {
      if (f < limits.fLow || f > limits.fHigh) return 0;
      const d = norm[k][i] - target[i];
      // was zwischen den Stellen stark streut, ist ortsabhängig und wird nicht korrigiert
      const trust = Math.max(0, Math.min(1, 1 - (spreads[k][i] - 2) / 4));
      return d * trust;
    });
    const filters = fitPeaking(grid, dev, limits);
    return {
      delay: (latest - arrivals[k]) * 1000,
      gain: Math.max(-limits.maxGainTrim, minLevel - levels[k]),
      filters, grid, curve: norm[k], target, spread: spreads[k], arrival: arrivals[k] * 1000,
    };
  });
}

/** Gierige Anpassung: größte Abweichung suchen, Gegenfilter setzen, Rest weiter bearbeiten. */
export function fitPeaking(grid, dev, limits = EQ_LIMITS) {
  const rest = [...dev];
  const filters = [];
  for (let n = 0; n < limits.maxFilters; n++) {
    let bi = -1, bv = 0;
    rest.forEach((v, i) => { if (Math.abs(v) > Math.abs(bv)) { bv = v; bi = i; } });
    if (bi < 0 || Math.abs(bv) < 1.5) break;
    // Breite: wo die Abweichung auf die Hälfte fällt
    let lo = bi, hi = bi;
    while (lo > 0 && Math.sign(rest[lo - 1]) === Math.sign(bv) && Math.abs(rest[lo - 1]) > Math.abs(bv) / 2) lo--;
    while (hi < rest.length - 1 && Math.sign(rest[hi + 1]) === Math.sign(bv) && Math.abs(rest[hi + 1]) > Math.abs(bv) / 2) hi++;
    const bw = Math.max(1 / 6, Math.log2(grid[hi] / grid[lo]));
    const q = Math.min(6, Math.max(0.5, Math.sqrt(2 ** bw) / (2 ** bw - 1)));
    const gain = Math.max(limits.maxCut, Math.min(limits.maxBoost, -bv));
    const flt = { f: grid[bi], gain: Math.round(gain * 10) / 10, q: Math.round(q * 100) / 100 };
    if (Math.abs(flt.gain) < 0.5) break;
    filters.push(flt);
    for (let i = 0; i < rest.length; i++) if (rest[i] !== 0) rest[i] += peakingResponse(flt, grid[i]);
  }
  return filters;
}
