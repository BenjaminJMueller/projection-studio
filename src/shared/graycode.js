// Strukturiertes Licht (Gray-Code) für die Kamera-Kalibrierung.
//
// Jeder Projektor zeigt nacheinander Weiß, Schwarz und je Bit ein Streifenmuster samt Umkehrung,
// getrennt für Spalten und Zeilen. Die Kamera vergleicht je Pixel Muster und Umkehrung (robust
// gegen Fremdlicht, Oberflächenfarbe und Helligkeitsabfall) und erhält so, welches Projektorpixel
// sie dort sieht. Die Streifen werden nur bis zu einer Breite verfeinert, die die Kamera noch
// auflöst (2^shift Projektorpixel); daraus entstehen Zellen, deren Schwerpunkt im Kamerabild sehr
// genau bestimmt werden kann.
//
// Der Kontrast der Muster dient zugleich als Schärfemaß: Grobe Streifen haben immer vollen
// Kontrast, feine nur, wenn Kamera und Projektor scharf gestellt sind. Das Verhältnis ist
// unabhängig von Helligkeit, Belichtung und Oberfläche.

/** Unterhalb dieses Kontrasts (Streifen ~3,5 Kamerapixel breit) gilt das Bild als unscharf. */
export const SHARP_LIMIT = 0.45;

export const toGray = (n) => n ^ (n >> 1);
export function fromGray(g) {
  let n = g;
  for (let s = g >> 1; s; s >>= 1) n ^= s;
  return n;
}

/**
 * Ablauf der Muster für einen Projektor mit W×H Pixeln und Streifenbreite 2^shift.
 * Rückgabe: { shift, bits: [bx, by], frames: [{ kind: 'white'|'black'|'gray', axis, bit, inv }] }
 */
export function patternPlan(W, H, shift = 3) {
  const bx = Math.max(1, Math.ceil(Math.log2(Math.ceil(W / 2 ** shift))));
  const by = Math.max(1, Math.ceil(Math.log2(Math.ceil(H / 2 ** shift))));
  const frames = [{ kind: 'white' }, { kind: 'black' }];
  for (const [axis, n] of [['x', bx], ['y', by]]) {
    for (let bit = n - 1; bit >= 0; bit--) {
      frames.push({ kind: 'gray', axis, bit, inv: false }, { kind: 'gray', axis, bit, inv: true });
    }
  }
  return { W, H, shift, bits: [bx, by], frames };
}

/** Wert (0/1) eines Musters am Projektorpixel (u, v). */
export function patternValue(f, u, v, shift) {
  if (f.kind === 'white' || f.kind === 'focus') return 1;
  if (f.kind === 'black') return 0;
  const c = (f.axis === 'x' ? u : v) >> shift;
  const b = (toGray(c) >> f.bit) & 1;
  return f.inv ? 1 - b : b;
}

/** Helle Abschnitte [von, bis) entlang der Musterachse, zum Zeichnen als Rechtecke. */
export function stripeRuns(f, len, shift) {
  if (f.kind === 'white') return [[0, len]];
  if (f.kind === 'black') return [];
  const runs = [];
  const step = 2 ** shift;
  let start = -1;
  for (let c = 0; c * step < len; c++) {
    const on = patternValue(f, c * step, c * step, shift) === 1;
    if (on && start < 0) start = c * step;
    if (!on && start >= 0) { runs.push([start, c * step]); start = -1; }
  }
  if (start >= 0) runs.push([start, len]);
  return runs;
}

/**
 * Schachbrett als Fokus-Hilfe: feine Felder (2^shift Pixel) in einem gröberen Raster, damit man
 * auch bei starker Unschärfe noch etwas erkennt und die Kamera nachfokussieren kann.
 */
export function focusValue(u, v, shift) {
  const s = 2 ** shift;
  const coarse = (Math.floor(u / (s * 16)) + Math.floor(v / (s * 16))) & 1;
  const fine = (Math.floor(u / s) + Math.floor(v / s)) & 1;
  return coarse ? fine : 1 - fine;
}

/**
 * Dekodiert die Kamerabilder Schritt für Schritt (es wird nie die ganze Bildserie gehalten).
 * Bilder sind Helligkeitswerte (Uint8Array, w×h, Zeile für Zeile).
 */
export class GrayDecoder {
  constructor(w, h, plan, opt = {}) {
    this.w = w; this.h = h; this.plan = plan;
    this.minShadow = opt.minShadow ?? 12; // Weiß − Schwarz in Graustufen, darunter: kein Licht vom Projektor
    this.minBitAbs = opt.minBitAbs ?? 4;
    this.minBitRel = opt.minBitRel ?? 0.12; // |Muster − Umkehrung| relativ zu Weiß − Schwarz
    const n = w * h;
    this.white = null; this.black = null;
    this.code = [new Uint16Array(n), new Uint16Array(n)];
    // je Pixel und Achse: Anzahl verlässlicher Bits von grob nach fein (bricht beim ersten unsicheren ab)
    this.depth = [new Uint8Array(n), new Uint8Array(n)];
    this.pending = null;
    // Kontrast je Bit (Summe |d| / Summe Weiß−Schwarz über beleuchtete Pixel)
    this.contrast = [new Float64Array(plan.bits[0]), new Float64Array(plan.bits[1])];
    this.tiles = null;
    this.lit = 0;
    this.litSum = 0;
  }

  /** Ein Bild zum Muster frames[i] hinzufügen. */
  add(f, img) {
    if (f.kind === 'white') { this.white = img; return; }
    if (f.kind === 'black') { this.black = img; this.#mask(); return; }
    if (!f.inv) { this.pending = { f, img }; return; }
    const pos = this.pending.img, neg = img;
    this.pending = null;
    const a = f.axis === 'x' ? 0 : 1;
    const nb = this.plan.bits[a];
    const level = nb - 1 - f.bit; // 0 = gröbstes Bit
    const code = this.code[a], depth = this.depth[a], W = this.white, B = this.black;
    let sd = 0;
    const tSum = this.tiles?.bit[a][f.bit];
    for (let i = 0; i < pos.length; i++) {
      const range = W[i] - B[i];
      if (range < this.minShadow) continue;
      const d = pos[i] - neg[i];
      const ad = d < 0 ? -d : d;
      sd += ad;
      if (tSum) tSum[this.tiles.of[i]] += ad;
      if (depth[i] !== level) continue; // ein gröberes Bit war schon unsicher
      if (ad < this.minBitAbs || ad < this.minBitRel * range) continue;
      if (d > 0) code[i] |= 1 << f.bit;
      depth[i] = level + 1;
    }
    this.contrast[a][f.bit] = this.litSum ? sd / this.litSum : 0;
  }

  #mask() {
    const { white: W, black: B, w, h } = this;
    // Kacheln für die örtliche Schärfekarte (16 × 9)
    const tx = 16, ty = 9;
    const of = new Uint16Array(w * h);
    const range = new Float64Array(tx * ty);
    let lit = 0, sum = 0;
    for (let y = 0; y < h; y++) {
      const ry = Math.min(ty - 1, Math.floor((y * ty) / h));
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = ry * tx + Math.min(tx - 1, Math.floor((x * tx) / w));
        of[i] = t;
        const r = W[i] - B[i];
        if (r >= this.minShadow) { lit++; sum += r; range[t] += r; }
      }
    }
    this.lit = lit; this.litSum = sum;
    const bit = this.plan.bits.map((n) => Array.from({ length: n }, () => new Float64Array(tx * ty)));
    this.tiles = { tx, ty, of, range, bit };
  }

  /** Anteil der Kamerapixel, die Licht von diesem Projektor sehen. */
  get litFraction() { return this.lit / (this.w * this.h); }

  /** Kontrast je Bit relativ zu den gröbsten Bits (1 = voller Kontrast). */
  curve(a) {
    const c = this.contrast[a], n = c.length;
    let ref = 0;
    for (let b = Math.max(0, n - 3); b < n; b++) ref = Math.max(ref, c[b]);
    return Array.from(c, (v) => (ref ? v / ref : 0));
  }

  /**
   * Maßstab: Kamerapixel je Projektorpixel, aus groben Zellen (Median der Nachbarabstände).
   */
  scale() {
    const drop = Math.max(0, Math.min(this.plan.bits[0], this.plan.bits[1]) - 4);
    const cells = this.cells(drop);
    const size = 2 ** (this.plan.shift + drop);
    const map = new Map(cells.map((c) => [`${c.u},${c.v}`, c]));
    const d = [];
    for (const c of cells) {
      const r = map.get(`${c.u + size},${c.v}`), b = map.get(`${c.u},${c.v + size}`);
      if (r) d.push(Math.hypot(r.x - c.x, r.y - c.y) / size);
      if (b) d.push(Math.hypot(b.x - c.x, b.y - c.y) / size);
    }
    if (!d.length) return 0;
    d.sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
  }

  /**
   * Bewertung nach einer Messung:
   *  scale: Kamerapixel je Projektorpixel
   *  sharp: Kontrast der Streifen mit ~3,5 Kamerapixeln Breite (scharf ≳ 0,6, unscharf < 0,45).
   *         So hängt das Urteil nicht davon ab, wie weit die Kamera weg ist.
   *  drop:  wie viele feinste Bits für die Zellen weggelassen werden (zu fein oder zu kontrastarm)
   */
  assess() {
    const scale = this.scale();
    const { shift, bits } = this.plan;
    const curves = [this.curve(0), this.curve(1)];
    const width = (b) => 2 ** (shift + b) * scale; // Streifenbreite in Kamerapixeln
    let probe = 0;
    if (scale > 0) {
      let best = Infinity;
      for (let b = 0; b < Math.min(bits[0], bits[1]); b++) { const e = Math.abs(Math.log2(width(b) / 3.5)); if (e < best) { best = e; probe = b; } }
    }
    const sharp = Math.min(curves[0][probe] ?? 0, curves[1][probe] ?? 0);
    let drop = 0;
    while (drop < Math.min(bits[0], bits[1]) - 3 && (width(drop) < 2.5 || Math.min(curves[0][drop], curves[1][drop]) < 0.5)) drop++;
    return { scale, sharp, probe, probeWidth: width(probe), drop, curves };
  }

  /** Schärfe als Zahl (siehe assess). */
  sharpness() { return { value: this.assess().sharp }; }

  /** Örtliche Schärfekarte (Kacheln, null = kein Projektorlicht) für das Bit `probe`. */
  sharpnessMap(probe = this.assess().probe) {
    const { tx, ty, range, bit } = this.tiles;
    const out = [];
    for (let t = 0; t < tx * ty; t++) {
      if (range[t] < 1e-9 || range[t] < (this.litSum / (tx * ty)) * 0.05) { out.push(null); continue; }
      let v = Infinity;
      for (let a = 0; a < 2; a++) {
        const n = bit[a].length;
        let ref = 0;
        for (let b = Math.max(0, n - 3); b < n; b++) ref = Math.max(ref, bit[a][b][t]);
        v = Math.min(v, ref ? bit[a][Math.min(probe, n - 1)][t] / ref : 0);
      }
      out.push(v);
    }
    return { tx, ty, values: out };
  }

  /**
   * Zellen bilden: Kamerapixel mit gleichem (auf `drop` feinste Bits gekürztem) Code zusammenfassen.
   * Rückgabe: [{ u, v, x, y, n }] in Projektor- und Kamerapixeln (stetige Koordinaten, Pixelmitte = +0,5).
   */
  cells(drop = 0) {
    const { w, h, plan } = this;
    const [bx, by] = plan.bits;
    const need = [bx - drop, by - drop];
    const size = 2 ** (plan.shift + drop);
    const nx = Math.ceil(plan.W / size), ny = Math.ceil(plan.H / size);
    const acc = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (this.depth[0][i] < need[0] || this.depth[1][i] < need[1]) continue;
        const cx = fromGray(this.code[0][i] >> drop), cy = fromGray(this.code[1][i] >> drop);
        if (cx >= nx || cy >= ny) continue;
        const k = cy * nx + cx;
        let c = acc.get(k);
        if (!c) { c = { cx, cy, sx: 0, sy: 0, sxx: 0, syy: 0, n: 0 }; acc.set(k, c); }
        const px = x + 0.5, py = y + 0.5;
        c.sx += px; c.sy += py; c.sxx += px * px; c.syy += py * py; c.n++;
      }
    }
    const list = [...acc.values()];
    if (!list.length) return [];
    const ns = list.map((c) => c.n).sort((a, b) => a - b);
    const typical = ns[Math.floor(ns.length * 0.75)];
    const out = [];
    for (const c of list) {
      // angeschnittene Zellen (Rand, Schatten) verschieben den Schwerpunkt: weglassen
      if (c.n < Math.max(3, typical * 0.6)) continue;
      const x = c.sx / c.n, y = c.sy / c.n;
      const sd = Math.sqrt(Math.max(0, c.sxx / c.n - x * x + c.syy / c.n - y * y));
      // zerstreute Pixel = Fehldekodierung (Reflexion, Rauschen)
      if (sd > 2 * Math.sqrt(typical) + 2) continue;
      out.push({ u: (c.cx + 0.5) * size, v: (c.cy + 0.5) * size, x, y, n: c.n });
    }
    return out;
  }
}

/**
 * Ausreißer entfernen: Jede Zelle muss zu ihren Nachbarn passen (örtlich affine Abbildung
 * Projektor → Kamera). Funktioniert auch auf gewölbten Flächen, wo eine globale Homographie nicht gilt.
 */
export function filterCells(cells, maxErr = 2.5) {
  if (cells.length < 8) return cells;
  const key = (c) => `${c.u},${c.v}`;
  const map = new Map(cells.map((c) => [key(c), c]));
  const us = [...new Set(cells.map((c) => c.u))].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < us.length; i++) step = Math.min(step, us[i] - us[i - 1]);
  const out = [];
  for (const c of cells) {
    const nb = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dy) continue;
      const o = map.get(`${c.u + dx * step},${c.v + dy * step}`);
      if (o) nb.push(o);
    }
    if (nb.length < 4) { if (nb.length >= 2) out.push(c); continue; }
    const A = fitAffine(nb);
    if (!A) continue;
    const px = A[0] * c.u + A[1] * c.v + A[2], py = A[3] * c.u + A[4] * c.v + A[5];
    if (Math.hypot(px - c.x, py - c.y) <= maxErr) out.push(c);
  }
  return out;
}

function fitAffine(pts) {
  // kleinste Quadrate für x = a u + b v + c (und y entsprechend), Mittelwert-zentriert
  let mu = 0, mv = 0, mx = 0, my = 0;
  for (const p of pts) { mu += p.u; mv += p.v; mx += p.x; my += p.y; }
  const n = pts.length;
  mu /= n; mv /= n; mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, sux = 0, svx = 0, suy = 0, svy = 0;
  for (const p of pts) {
    const u = p.u - mu, v = p.v - mv, x = p.x - mx, y = p.y - my;
    suu += u * u; suv += u * v; svv += v * v; sux += u * x; svx += v * x; suy += u * y; svy += v * y;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const a = (sux * svv - svx * suv) / det, b = (svx * suu - sux * suv) / det;
  const d = (suy * svv - svy * suv) / det, e = (svy * suu - suy * suv) / det;
  return [a, b, mx - a * mu - b * mv, d, e, my - d * mu - e * mv];
}

/** Gleichmäßig verteilte Auswahl (Raster im Projektorbild), höchstens etwa `max` Zellen. */
export function thinCells(cells, W, H, max = 300) {
  if (cells.length <= max) return cells;
  const ar = W / H;
  const gy = Math.max(1, Math.round(Math.sqrt(max / ar))), gx = Math.max(1, Math.round(max / gy));
  const best = new Map();
  for (const c of cells) {
    const ix = Math.min(gx - 1, Math.floor((c.u / W) * gx)), iy = Math.min(gy - 1, Math.floor((c.v / H) * gy));
    const k = iy * gx + ix;
    const cxm = ((ix + 0.5) * W) / gx, cym = ((iy + 0.5) * H) / gy;
    const d = Math.hypot(c.u - cxm, c.v - cym);
    const o = best.get(k);
    if (!o || d < o.d) best.set(k, { c, d });
  }
  return [...best.values()].map((o) => o.c);
}

/**
 * Live-Schärfe eines Kamerabilds mit projiziertem Fokus-Schachbrett: mittlerer Betrag des
 * Laplace-Operators relativ zur mittleren Helligkeit, nur wo Projektorlicht ist.
 * Schnell genug für jedes Kamerabild (auf ~640 px verkleinert).
 */
export function focusMeasure(img, w, h, mask = null) {
  let s = 0, b = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask && !mask[i]) continue;
      const c = img[i];
      const l = 4 * c - img[i - 1] - img[i + 1] - img[i - w] - img[i + w];
      s += l < 0 ? -l : l; b += c; n++;
    }
  }
  return n && b ? s / b : 0;
}
