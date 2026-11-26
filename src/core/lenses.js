// Objektiv-Vorwissen (Priors) für den Solver.
// Alle Werte beziehen sich auf das EINGANGSSIGNAL des Projektors (z. B. 1920x1080),
// nicht auf das native Panel. throw = Abstand / Bildbreite.
//
// cyFrac: Lage der optischen Achse in Bildhöhen, gemessen von OBEN (0 = Oberkante, 1 = Unterkante).
//         Werte > 1 bedeuten: Achse liegt unterhalb des Bildes (typisch für Kurzdistanz-Beamer).
// cyFlip: true = je nach Menü-Modus (Decke/Tisch, Spiegel) kann das Bild auf dem Kopf stehen,
//         dann liegt die Achse oberhalb (1 - cyFrac). Der Solver testet dann beide Varianten.

export const LENS_PRESETS = [
  {
    id: 'epson-eb535w-1080p',
    name: 'Epson EB-535W – 1080p-Signal (16:9 im 16:10-Panel)',
    note: 'Wurfverhältnis 0,48 (Wide) bis 0,65 (Tele, digitaler Zoom). Offset 9,51:-1 → Achse liegt ca. 12 % der Bildhöhe unter dem Bild.',
    throwMin: 0.44,
    throwMax: 0.7,
    throwNominal: 0.48,
    throwSigma: 0.06,
    cxFrac: 0.5,
    cxSigmaFrac: 0.03,
    // Panel 1280x800 ≙ 1920x1200 bei Signal-Skalierung 1,5; 1080p liegt mittig (60 px Rand).
    // Achse: 1200 * (1 + 1/8.51) = 1341 → im Signal 1341 - 60 = 1281 → 1281/1080
    cyFrac: 1.186,
    cySigmaFrac: 0.06,
    cyFlip: true,
  },
  {
    id: 'epson-eb535w-wxga',
    name: 'Epson EB-535W – natives WXGA-Signal (1280x800)',
    note: 'Wenn das Signal exakt 1280x800 ist.',
    throwMin: 0.44,
    throwMax: 0.7,
    throwNominal: 0.48,
    throwSigma: 0.06,
    cxFrac: 0.5,
    cxSigmaFrac: 0.03,
    cyFrac: 1.1175,
    cySigmaFrac: 0.06,
    cyFlip: true,
  },
  {
    id: 'standard-offset',
    name: 'Standard-Beamer mit festem Offset (Achse an Bildunterkante)',
    note: 'Typische Büro-/Tischbeamer ohne Lens-Shift.',
    throwMin: 0.8,
    throwMax: 2.5,
    throwNominal: 1.4,
    throwSigma: 0.5,
    cxFrac: 0.5,
    cxSigmaFrac: 0.04,
    cyFrac: 1.0,
    cySigmaFrac: 0.12,
    cyFlip: true,
  },
  {
    id: 'lens-shift-centered',
    name: 'Beamer mit Lens-Shift, zentriert',
    note: 'Achse in Bildmitte (Lens-Shift auf 0).',
    throwMin: 0.3,
    throwMax: 4,
    throwNominal: 1.5,
    throwSigma: 0.8,
    cxFrac: 0.5,
    cxSigmaFrac: 0.05,
    cyFrac: 0.5,
    cySigmaFrac: 0.1,
    cyFlip: false,
  },
  {
    id: 'unknown',
    name: 'Unbekannt (frei, mind. 6 Punkte empfohlen)',
    note: 'Nur schwaches Vorwissen. Braucht gut verteilte Punkte.',
    throwMin: 0.2,
    throwMax: 5,
    throwNominal: 1.0,
    throwSigma: 2,
    cxFrac: 0.5,
    cxSigmaFrac: 0.2,
    cyFrac: 0.5,
    cySigmaFrac: 0.6,
    cyFlip: false,
  },
];

export function getLensPreset(id) {
  return LENS_PRESETS.find((p) => p.id === id) || LENS_PRESETS[LENS_PRESETS.length - 1];
}

// ---------------------------------------------------------------- Projektor-Typen aus dem Datenblatt
// spec = { id, maker, model, native: [w, h], throw: [min, max], zoom: 'optisch'|'digital'|'fest',
//          axis: { kind: 'fixed', below } | { kind: 'shift', v: [min, max], h: [min, max] }, source }
// below: Abstand der Objektivachse unter der Bildunterkante in Bildhöhen (negativ = Achse im Bild).
// shift v/h: Verschiebung der Bildmitte gegenüber der Achse in Bildhöhen/-breiten (+ = nach oben/rechts).

/** Offset-Angaben der Hersteller in „Achse unter dem Bild“ umrechnen. */
export const OFFSET_FORMATS = [
  ['half', 'Prozent, halbe Bildhöhe (z. B. Optoma 116 %)'],
  ['full', 'Prozent, volle Bildhöhe (z. B. BenQ 105 %)'],
  ['ratio', 'Verhältnis oben:unten (z. B. Epson 9,51:-1)'],
];
export function offsetToBelow(format, value) {
  if (format === 'half') return Number(value) / 200 - 0.5;
  if (format === 'full') return Number(value) / 100 - 1;
  const [a, b] = String(value).replace(/,/g, '.').split(':').map(Number);
  if (!(a + b)) return NaN;
  return -b / (a + b);
}

/** Verifizierte Datenblattwerte (Quelle je Eintrag). Werte beziehen sich auf das native Panel. */
export const PROJECTOR_DB = [
  { id: 'epson-eb-535w', maker: 'Epson', model: 'EB-535W', native: [1280, 800], throw: [0.48, 0.65], zoom: 'digital',
    axis: { kind: 'fixed', below: 1 / 8.51 }, source: 'Epson, Offset 9,51:-1' },
  { id: 'benq-mw632st', maker: 'BenQ', model: 'MW632ST', native: [1280, 800], throw: [0.72, 0.87], zoom: 'optisch',
    axis: { kind: 'fixed', below: 0.05 }, source: 'https://www.benq.eu/en-uk/projector/business/mw632st/spec.html (Projection Offset Full-Height 105 %)' },
  { id: 'optoma-gt1080hdr', maker: 'Optoma', model: 'GT1080HDR', native: [1920, 1080], throw: [0.49, 0.49], zoom: 'fest',
    axis: { kind: 'fixed', below: 0.08 }, source: 'https://region-resource.optoma.com/datasheets/4/gt1080hdr.pdf (Native offset 116 %)' },
  { id: 'epson-eb-l1050u', maker: 'Epson', model: 'EB-L1050U (Standardobjektiv)', native: [1920, 1200], throw: [1.44, 2.33], zoom: 'optisch',
    axis: { kind: 'shift', v: [-0.67, 0.67], h: [-0.3, 0.3] }, source: 'Epson Datenblatt V11H942940 (Lens Shift V ±67 %, H ±30 %)' },
  { id: 'panasonic-pt-vmz60', maker: 'Panasonic', model: 'PT-VMZ60', native: [1920, 1200], throw: [1.09, 1.77], zoom: 'optisch',
    axis: { kind: 'shift', v: [0, 0.44], h: [-0.2, 0.2] }, source: 'Panasonic PT-VMZ60 Leaflet (Lens Shift V +44 %/0 %, H ±20 %)' },
];

/**
 * Bildmodus am Projektor (Menü „Seitenverhältnis“): wie das Signal aufs Panel kommt, wenn sein
 * Seitenverhältnis oder seine Auflösung vom Panel abweicht.
 *  fit:    ganzes Signal sichtbar, Ränder oben/unten oder seitlich (Epson: Normal, 16:9)
 *  fill:   füllt das Panel, Überstand wird abgeschnitten (Epson: Zoom)
 *  native: Pixel 1:1, nur die Mitte des Signals ist sichtbar (Epson: Nativ)
 * Gestrecktes Bild (Epson: Voll) hat nicht-quadratische Pixel und wird nicht unterstützt.
 */
export const IMAGE_MODES = [
  ['fit', 'Normal / 16:9 (ganzes Bild)'],
  ['fill', 'Zoom (füllt das Panel, schneidet ab)'],
  ['native', 'Nativ (1:1, schneidet ab)'],
];

/** Vorwissen für den Solver aus einem Datenblatt, bezogen auf das Eingangssignal. */
export function lensFromSpec(spec, signal = spec.native, mode = 'fit') {
  const [pw, ph] = spec.native, [sw, sh] = signal;
  // Signal -> Panel: eingepasst (Ränder), füllend (abgeschnitten) oder 1:1
  const s = mode === 'native' ? 1 : mode === 'fill' ? Math.max(pw / sw, ph / sh) : Math.min(pw / sw, ph / sh);
  const iw = sw * s, ih = sh * s, top = (ph - ih) / 2;
  const k = pw / iw; // Wurfverhältnis bezieht sich im Datenblatt auf die volle Panelbreite
  const [t0, t1] = spec.throw;
  const mid = (t0 + t1) / 2;
  const lens = {
    id: spec.id,
    name: `${spec.maker} ${spec.model}`.trim(),
    note: `Wurfverhältnis ${t0 === t1 ? t0 : `${t0} bis ${t1}`}${spec.zoom === 'digital' ? ' (digitaler Zoom)' : ''}. ${spec.source || ''}`.trim(),
    throwMin: t0 * 0.93 * k,
    throwMax: t1 * 1.07 * k,
    throwNominal: (t0 === t1 ? t0 : spec.zoom === 'digital' ? t0 : mid) * k,
    throwSigma: (Math.max(0.03, (t1 - t0) / 2) + 0.03 * mid) * k,
    cxFrac: 0.5,
    cxSigmaFrac: 0.03,
    cySigmaFrac: 0.06,
    cyFlip: true,
    // sichtbarer Anteil des Signals (zentriert), 1 = alles
    visible: [Math.min(1, pw / iw), Math.min(1, ph / ih)],
  };
  const ax = spec.axis || { kind: 'fixed', below: 0 };
  if (ax.kind === 'shift') {
    const [v0, v1] = ax.v || [0, 0], [h0, h1] = ax.h || [0, 0];
    // Bildmitte um v nach oben → Achse liegt v Bildhöhen unter der Mitte
    const axisMid = ph / 2 + ((v0 + v1) / 2) * ph;
    lens.cyFrac = (axisMid - top) / ih;
    lens.cySigmaFrac = Math.max(0.06, (((v1 - v0) / 2) * ph) / ih);
    lens.cyFlip = Math.abs(v0 + v1) > 0.02; // einseitiger Shift: Deckenmontage spiegelt den Bereich
    lens.cxFrac = 0.5 - ((h0 + h1) / 2) * (pw / iw);
    lens.cxSigmaFrac = Math.max(0.03, ((h1 - h0) / 2) * (pw / iw));
  } else {
    lens.cyFrac = (ph * (1 + ax.below) - top) / ih;
  }
  return lens;
}

/** Objektiv-Vorwissen für einen Projektor: Voreinstellung, Datenbank oder eigener Typ des Projekts. */
export function lensFor(p, project) {
  const id = p.lens || '';
  const mode = p.imageMode || 'fit';
  if (id.startsWith('db:') || id.startsWith('custom:')) {
    const key = id.slice(id.indexOf(':') + 1);
    const spec = id.startsWith('db:') ? PROJECTOR_DB.find((x) => x.id === key) : project?.projectorTypes?.find((x) => x.id === key);
    if (spec) return lensFromSpec(spec, p.resolution, mode);
  }
  // Epson-Voreinstellungen mit anderem Bildmodus: aus dem Datenblatt rechnen
  if (mode !== 'fit' && id.startsWith('epson-eb535w')) return { ...lensFromSpec(PROJECTOR_DB.find((x) => x.id === 'epson-eb-535w'), p.resolution, mode), id };
  return getLensPreset(id);
}

/** Native Panelauflösung eines Projektor-Typs, falls bekannt (für den Bildmodus). */
export function nativeOf(p, project) {
  const id = p.lens || '';
  if (id.startsWith('epson-eb535w')) return [1280, 800];
  const key = id.slice(id.indexOf(':') + 1);
  const spec = id.startsWith('db:') ? PROJECTOR_DB.find((x) => x.id === key) : id.startsWith('custom:') ? project?.projectorTypes?.find((x) => x.id === key) : null;
  return spec?.native || null;
}
