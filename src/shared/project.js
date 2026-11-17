// Projekt-Datenmodell (wird als .kalib.json gespeichert).
import { PROJECTOR_COLORS } from './scene.js';

export const PROJECT_VERSION = 1;

export function defaultProjectors() {
  // Vorlage aus der TouchDesigner-Datei: P1-P4 auf HDMI A, P5-P8 auf HDMI B (je 2x2 Quadranten)
  return Array.from({ length: 8 }, (_, i) => ({
    id: `P${i + 1}`,
    name: `P${i + 1}`,
    color: PROJECTOR_COLORS[i],
    output: i < 4 ? 'A' : 'B',
    quadrant: i % 4, // 0 oben links, 1 oben rechts, 2 unten links, 3 unten rechts
    resolution: [1920, 1080],
    lens: 'epson-eb535w-1080p',
    mountMode: 'auto',
    ring: i < 4 ? 'innen' : 'außen',
    tdCamera: i === 0 ? 'Projektorkamera' : `Kamera_P${i + 1}`,
    tdRender: i === 0 ? 'Projektion' : `Projektion_P${i + 1}`,
    points: [],
    nextPointId: 1,
    solution: null,
    masks: [],
    enabled: true,
  }));
}

export function newProject() {
  return {
    version: PROJECT_VERSION,
    name: 'Neues Projekt',
    model: { path: null, name: null },
    outputs: [
      { id: 'A', name: 'HDMI A', displayId: null, layout: '2x2' },
      { id: 'B', name: 'HDMI B', displayId: null, layout: '2x2' },
    ],
    projectors: defaultProjectors(),
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
    view: { outputMode: 'edges', showPoints: true, showMask: false },
    td: { live: false, host: '127.0.0.1', port: 7000 },
  };
}

/** Rechteck eines Projektors im Ausgabebild (normiert 0..1). */
export function quadrantRect(output, quadrant) {
  if (!output || output.layout === '1x1') return { x: 0, y: 0, w: 1, h: 1 };
  if (output.layout === '1x2') return { x: (quadrant % 2) * 0.5, y: 0, w: 0.5, h: 1 };
  return { x: (quadrant % 2) * 0.5, y: Math.floor(quadrant / 2) * 0.5, w: 0.5, h: 0.5 };
}

export const QUADRANT_NAMES = ['oben links', 'oben rechts', 'unten links', 'unten rechts'];

export function migrateProject(p) {
  const base = newProject();
  const out = { ...base, ...p };
  out.blend = { ...base.blend, ...(p.blend || {}) };
  out.view = { ...base.view, ...(p.view || {}) };
  out.td = { ...base.td, ...(p.td || {}) };
  out.projectors = (p.projectors || base.projectors).map((pj, i) => ({ ...base.projectors[i % 8], ...pj, color: base.projectors[i % 8].color }));
  return out;
}
