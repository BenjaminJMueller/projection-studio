// Projekt-Datenmodell (wird als .kalib.json gespeichert).
import { PROJECTOR_COLORS } from './scene.js';

export const PROJECT_VERSION = 1;

export const MAX_PROJECTORS = 16;
export const MAX_VIDEO_OUTPUTS = 4;

/** Ein Projektor mit Standardwerten. i = Position in der Liste (bestimmt Name, Farbe, Ausgang). */
export function makeProjector(i, extra = {}) {
  return {
    id: `P${i + 1}`,
    name: `P${i + 1}`,
    color: PROJECTOR_COLORS[i % PROJECTOR_COLORS.length],
    output: i < 4 ? 'A' : 'B',
    quadrant: i % 4, // Feld im Ausgang (bei 2 × 2: 0 oben links, 1 oben rechts, 2 unten links, 3 unten rechts)
    resolution: [1920, 1080],
    lens: 'epson-eb535w-1080p',
    mountMode: 'auto',
    ring: i < 4 ? 'innen' : 'außen', // Gruppe in der Seitenleiste
    tdCamera: i === 0 ? 'Projektorkamera' : `Kamera_P${i + 1}`,
    tdRender: i === 0 ? 'Projektion' : `Projektion_P${i + 1}`,
    points: [],
    autoPoints: [], // Punktpaare aus der Kamera-Kalibrierung (nicht im Rückgängig-Verlauf, zu groß)
    autoCal: null,
    nextPointId: 1,
    warp: null, // Feinkorrektur-Gitter (siehe shared/warp.js), null = keine
    solution: null,
    masks: [],
    enabled: true,
    ...extra,
  };
}

export function defaultProjectors() {
  // Vorlage aus der TouchDesigner-Datei: P1-P4 auf HDMI A, P5-P8 auf HDMI B (je 2x2 Quadranten)
  return Array.from({ length: 8 }, (_, i) => makeProjector(i));
}

/** Gruppenname für die Anzeige (die Ringe des Gewölbes heißen Innenring/Außenring). */
export const groupLabel = (g) => (g === 'innen' ? 'Innenring' : g === 'außen' ? 'Außenring' : g || 'Projektoren');

/**
 * Projektor anhängen: nächste freie Nummer, gleiche Gruppe und Einstellungen wie der letzte,
 * erstes freies Feld eines Ausgangs. Rückgabe: der neue Projektor oder null (Höchstzahl erreicht).
 */
export function addProjector(project) {
  const ps = project.projectors;
  if (ps.length >= MAX_PROJECTORS) return null;
  let n = ps.length;
  while (ps.some((p) => p.id === `P${n + 1}`)) n++;
  const last = ps[ps.length - 1];
  const used = new Set(ps.map((p) => p.color));
  const color = PROJECTOR_COLORS.find((c) => !used.has(c)) || PROJECTOR_COLORS[n % PROJECTOR_COLORS.length];
  let output = '', quadrant = 0;
  for (const o of project.outputs.filter((x) => !x.solo)) {
    const taken = new Set(ps.filter((p) => p.output === o.id).map((p) => p.quadrant % cellCount(o)));
    const free = Array.from({ length: cellCount(o) }, (_, q) => q).find((q) => !taken.has(q));
    if (free != null) { output = o.id; quadrant = free; break; }
  }
  const p = makeProjector(n, {
    color, output, quadrant,
    ring: last?.ring ?? 'innen',
    resolution: last ? [...last.resolution] : [1920, 1080],
    lens: last?.lens ?? 'epson-eb535w-1080p',
    mountMode: last?.mountMode ?? 'auto',
  });
  ps.push(p);
  return p;
}

/** Weiteren Ausgang für einen Video-Wall-Controller anlegen (HDMI C, D). */
export function addOutput(project) {
  const vids = project.outputs.filter((o) => !o.solo);
  if (vids.length >= MAX_VIDEO_OUTPUTS) return null;
  const id = 'ABCDEFGH'.split('').find((c) => !project.outputs.some((o) => o.id === c));
  const o = { id, name: `HDMI ${id}`, displayId: null, layout: '2x2' };
  project.outputs.splice(project.outputs.indexOf(vids[vids.length - 1]) + 1, 0, o);
  return o;
}

export function newProject() {
  return {
    version: PROJECT_VERSION,
    name: 'Neues Projekt',
    model: { path: null, name: null },
    outputs: [
      { id: 'A', name: 'HDMI A', displayId: null, layout: '2x2' },
      { id: 'B', name: 'HDMI B', displayId: null, layout: '2x2' },
      { id: 'T', name: 'Testausgang', displayId: null, layout: '1x1', solo: true },
    ],
    projectors: defaultProjectors(),
    projectorTypes: [], // eigene Projektor-Typen aus Datenblättern (siehe core/lenses.js)
    blend: {
      auto: true,
      width: 0.3, // Breite der weichen Überblendzone (Anteil der Überlappung)
      gamma: 2.2,
      brightness: true,
      brightnessStrength: 0.6,
      exportScale: 1,
      tiltFilter: true, // steile Flächen (Seiten der Bögen) ausblenden
      maxTilt: 65, // Grad Neigung gegenüber der Waagerechten, ab der ausgeblendet wird
      incFilter: true, // Streiflicht ausblenden
      maxIncidence: 80,
    },
    view: { outputMode: 'edges', showPoints: true, showMask: false, mouseFollow: false },
    td: { live: false, host: '127.0.0.1', port: 7000 },
    playback: { items: [], mapping: 'top', loop: true, fps: 0 },
    audio: { enabled: false, deviceId: '', sampleRate: 0, buffer: 1024, speakers: 2, master: 0, channels: [] },
  };
}

/**
 * Aufteilungen eines Ausgangs (Zeilen × Spalten). 2 × 2 entspricht einem Video-Wall-Controller
 * wie dem LogiLink HD0054, der ein 4K-Bild auf vier Full-HD-Projektoren verteilt.
 */
export const LAYOUTS = {
  '1x1': { rows: 1, cols: 1, label: 'Ganz', hint: 'Projektor direkt angeschlossen' },
  '2x2': { rows: 2, cols: 2, label: '2 × 2', hint: 'Video-Wall-Controller, 4 Projektoren im Quadrat' },
  '1x2': { rows: 1, cols: 2, label: '2 nebeneinander', hint: 'Controller oder Splitter, 2 Projektoren' },
  '2x1': { rows: 2, cols: 1, label: '2 übereinander', hint: 'Controller, 2 Projektoren' },
  '1x3': { rows: 1, cols: 3, label: '3 nebeneinander', hint: 'Controller, 3 Projektoren' },
  '1x4': { rows: 1, cols: 4, label: '4 nebeneinander', hint: 'Controller, 4 Projektoren' },
  '4x1': { rows: 4, cols: 1, label: '4 übereinander', hint: 'Controller, 4 Projektoren' },
  '2x3': { rows: 2, cols: 3, label: '3 × 2', hint: 'Controller, 6 Projektoren' },
  '3x3': { rows: 3, cols: 3, label: '3 × 3', hint: 'Controller, 9 Projektoren' },
};
export const layoutOf = (o) => LAYOUTS[o?.layout] || LAYOUTS['1x1'];
export const cellCount = (o) => (o?.solo ? 1 : layoutOf(o).rows * layoutOf(o).cols);

/** Rechteck eines Projektors im Ausgabebild (normiert 0..1). */
export function quadrantRect(output, quadrant) {
  if (!output || output.solo) return { x: 0, y: 0, w: 1, h: 1 };
  const { rows, cols } = layoutOf(output);
  const q = ((quadrant % (rows * cols)) + rows * cols) % (rows * cols);
  return { x: (q % cols) / cols, y: Math.floor(q / cols) / rows, w: 1 / cols, h: 1 / rows };
}

/** Name eines Felds, z. B. „oben links“ oder „2. von links“. */
export function cellName(output, q) {
  const { rows, cols } = layoutOf(output);
  if (rows === 2 && cols === 2) return QUADRANT_NAMES[q] || '';
  if (rows === 1 && cols === 2) return q ? 'rechts' : 'links';
  if (rows === 2 && cols === 1) return q ? 'unten' : 'oben';
  if (rows === 1) return `${q + 1}. von links`;
  if (cols === 1) return `${q + 1}. von oben`;
  return `Feld ${q + 1}`;
}

/** Projektoren eines Ausgangs der Reihe nach auf die Felder verteilen. Rückgabe: Anzahl, die nicht passt. */
export function arrangeOutput(project, outputId) {
  const o = project.outputs.find((x) => x.id === outputId);
  const n = cellCount(o);
  const ps = project.projectors.filter((p) => p.output === outputId);
  ps.forEach((p, i) => { p.quadrant = i % n; });
  return Math.max(0, ps.length - n);
}

export const QUADRANT_NAMES = ['oben links', 'oben rechts', 'unten links', 'unten rechts'];

export function migrateProject(p) {
  const base = newProject();
  const out = { ...base, ...p };
  out.blend = { ...base.blend, ...(p.blend || {}) };
  out.view = { ...base.view, ...(p.view || {}) };
  out.td = { ...base.td, ...(p.td || {}) };
  out.playback = { ...base.playback, ...(p.playback || {}) };
  // ältere Projekte: ein einzelnes Video unter playback.src
  if (!Array.isArray(p.playback?.items)) out.playback.items = p.playback?.src ? [{ src: p.playback.src, name: p.playback.name || p.playback.src.split(/[\\/]/).pop() }] : [];
  delete out.playback.src; delete out.playback.name;
  out.audio = { ...base.audio, ...(p.audio || {}) };
  out.projectorTypes = Array.isArray(p.projectorTypes) ? p.projectorTypes : [];
  out.outputs = (p.outputs || base.outputs).map((o) => ({ ...o }));
  if (!out.outputs.some((o) => o.solo)) out.outputs.push({ ...base.outputs[2] });
  out.projectors = (p.projectors || base.projectors).slice(0, MAX_PROJECTORS).map((pj, i) => { const d = makeProjector(i); return { ...d, ...pj, color: pj.color || d.color }; });
  return out;
}
