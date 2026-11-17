// Hauptfenster: Zustand, Bedienlogik, Solver-Anbindung, Export.
import { buildModel } from '../shared/scene.js';
import { newProject, migrateProject, QUADRANT_NAMES } from '../shared/project.js';
import { LENS_PRESETS, getLensPreset } from '../core/lenses.js';
import { projectPoint, suggestNextImageRegion } from '../core/solver.js';
import { exportProjector } from '../core/export.js';
import { View3D } from './view3d.js';
import { Preview } from './preview.js';
import { computeBlendMasks } from './blend.js';
import { makeBrowserStub } from './stub.js';
import { icon, hydrateIcons } from './icons.js';
import { fileUrl, targetTime, playState } from '../shared/playback.js';
import { defaultWarp, resizeWarp, isIdentity, inverse, gridBase, touchDesignerShader } from '../shared/warp.js';

const api = window.api || makeBrowserStub();
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};

// ------------------------------------------------------------------ Zustand
const S = {
  project: newProject(),
  projectPath: null,
  model: null,
  activeId: 'P1',
  activePointId: null,
  pendingRepick: false,
  activeMaskId: null,
  results: {}, // projectorId -> { warnings, quality, suggest, message }
  displays: [],
  openOutputs: new Set(),
  blendImages: {}, // projectorId -> { url, canvas }
  dirty: false,
  mode: 'calibrate',
  ui: {},
  blendStatus: '',
  play: { playing: false, startedAt: 0, pausedAt: 0, loop: true },
  videoInfo: null,
  calTab: 'points', // 'points' | 'warp'
  outStats: {},
  activeHandle: null,
};
const undoStack = [], redoStack = [];

const active = () => S.project.projectors.find((p) => p.id === S.activeId);
const activePoint = () => active()?.points.find((x) => x.id === S.activePointId);

function snapshot() {
  return JSON.stringify(S.project.projectors.map((p) => ({ id: p.id, points: p.points, masks: p.masks, nextPointId: p.nextPointId, centerHint: p.centerHint || null, warp: p.warp || null })));
}
function pushUndo() {
  undoStack.push({ snap: snapshot(), activeId: S.activeId, activePointId: S.activePointId });
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
}
function restore(entry) {
  const data = JSON.parse(entry.snap);
  for (const d of data) {
    const p = S.project.projectors.find((x) => x.id === d.id);
    if (!p) continue;
    const changed = JSON.stringify(p.points) !== JSON.stringify(d.points);
    Object.assign(p, d);
    if (changed) scheduleSolve(p);
  }
  S.activeId = entry.activeId;
  S.activePointId = entry.activePointId;
  refresh();
}
function undo() {
  if (!undoStack.length) return toast('Nichts rückgängig zu machen');
  redoStack.push({ snap: snapshot(), activeId: S.activeId, activePointId: S.activePointId });
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push({ snap: snapshot(), activeId: S.activeId, activePointId: S.activePointId });
  restore(redoStack.pop());
}

// ------------------------------------------------------------------ Solver
const worker = new Worker(new URL('./solverWorker.js', import.meta.url), { type: 'module' });
let solveSeq = 0;
const latestSeq = {};
const solveTimers = {};
function scheduleSolve(p, delay = 0) {
  clearTimeout(solveTimers[p.id]);
  solveTimers[p.id] = setTimeout(() => runSolve(p), delay);
}
function runSolve(p) {
  const seq = ++solveSeq;
  latestSeq[p.id] = seq;
  worker.postMessage({
    seq,
    projectorId: p.id,
    req: {
      points: p.points.filter((x) => x.world && x.image).map((x) => ({ id: x.id, world: x.world, image: x.image, enabled: x.enabled })),
      width: p.resolution[0],
      height: p.resolution[1],
      lensId: p.lens,
      mountMode: p.mountMode,
      previous: p.solution,
      positionPrior: p.positionPrior || null,
      centerHint: p.centerHint || null,
    },
  });
}
worker.onmessage = (e) => {
  const { seq, projectorId, res } = e.data;
  if (latestSeq[projectorId] !== seq) return; // veraltet
  const p = S.project.projectors.find((x) => x.id === projectorId);
  if (!p) return;
  S.results[p.id] = { warnings: res.warnings || [], quality: res.quality, suggest: res.suggest, message: res.message };
  if (res.ok) { p.solution = res.solution; sendLive(p); }
  else if (p.points.filter((x) => x.enabled && x.world && x.image).length < 4) p.solution = null;
  S.results[p.id].candidates = res.ok ? suggestModelCandidates(p, res.suggest) : [];
  markDirty();
  refresh();
};

// ------------------------------------------------------------------ Ansichten
const view = new View3D($('#view3d'), {
  onPick: (world, snapped) => onModelPick(world, snapped),
  onHover: () => {},
});
const preview = new Preview($('#preview3d'), $('#preview2d'), {
  onImagePoint: (u, v, phase) => {
    const pt = activePoint();
    if (!pt) return;
    if (phase === 'start') pushUndo();
    setImage(pt, u, v, phase === 'end' ? 0 : 30);
  },
  onSelectPoint: (id) => selectPoint(id),
  onMaskPointer: (uv, phase, e) => onMaskPointer(uv, phase, e),
  onWarpPointer: (uv, phase) => onWarpPointer(uv, phase),
});

function setImage(pt, u, v, solveDelay = 0) {
  const p = active();
  pt.image = [clamp(u, 0, p.resolution[0]), clamp(v, 0, p.resolution[1])];
  scheduleSolve(p, solveDelay);
  refresh(true);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function onModelPick(world, snapped) {
  if (!S.model) return;
  const p = active();
  if (S.mode !== 'calibrate' && !S.pickCenter) return;
  if (S.pickCenter) {
    pushUndo();
    p.centerHint = { world };
    S.pickCenter = false;
    if (p.points.length) scheduleSolve(p);
    markDirty();
    toast(`Bildmitte für ${displayName(p)} gesetzt`);
    return refresh();
  }
  if (S.pendingRepick && activePoint()) {
    pushUndo();
    activePoint().world = world;
    S.pendingRepick = false;
    scheduleSolve(p);
    toast('3D-Position aktualisiert');
    return refresh();
  }
  pushUndo();
  let image;
  if (p.solution) {
    const pr = projectPoint(p.solution, world);
    image = pr.z > 0 && pr.u > -50 && pr.u < p.resolution[0] + 50 && pr.v > -50 && pr.v < p.resolution[1] + 50 ? [clamp(pr.u, 0, p.resolution[0]), clamp(pr.v, 0, p.resolution[1])] : null;
  }
  if (!image) {
    const s = suggestNextImageRegion(p.points.filter((x) => x.image).map((x) => x.image), p.resolution[0], p.resolution[1]);
    image = [s.u, s.v];
  }
  const pt = { id: p.nextPointId++, world, image, enabled: true, snapped };
  p.points.push(pt);
  S.activePointId = pt.id;
  scheduleSolve(p);
  markDirty();
  refresh();
}

/** Modell-Ecken, die in der leeren Bildregion landen würden: werden im 3D-Modell blau markiert. */
function suggestModelCandidates(p, suggest) {
  if (!S.model || !p.solution || !suggest) return [];
  const V = S.model.featureVertices;
  const [W, H] = p.resolution;
  const out = [];
  for (let i = 0; i < V.length; i += 3) {
    const X = [V[i], V[i + 1], V[i + 2]];
    const q = projectPoint(p.solution, X);
    if (q.z <= 0 || q.u < 30 || q.v < 30 || q.u > W - 30 || q.v > H - 30) continue;
    const d = Math.hypot(q.u - suggest.u, q.v - suggest.v);
    if (d < 0.18 * W) out.push({ world: X, d });
  }
  out.sort((a, b) => a.d - b.d);
  // räumlich ausdünnen
  const pick = [];
  for (const c of out) {
    if (pick.every((k) => Math.hypot(...k.world.map((v, j) => v - c.world[j])) > S.model.radius * 0.05)) pick.push(c);
    if (pick.length >= 3) break;
  }
  return pick.map((c) => c.world);
}

function selectPoint(id) {
  S.activePointId = id;
  S.pendingRepick = false;
  refresh();
}

function selectProjector(id) {
  if (S.activeId === id) return;
  S.activeId = id;
  S.activePointId = null;
  S.pendingRepick = false;
  S.activeMaskId = null;
  refresh();
}

// ------------------------------------------------------------------ Masken-Editor
function onMaskPointer(uv, phase, e) {
  const p = active();
  let m = p.masks.find((x) => x.id === S.activeMaskId);
  const tol = 12 * (p.resolution[0] / preview.cssW);
  if (phase === 'down') {
    // Eckpunkt greifen?
    if (m) {
      const i = m.points.findIndex(([u, v]) => Math.hypot(u - uv[0], v - uv[1]) < tol);
      if (i >= 0) {
        pushUndo();
        S.maskDrag = { mask: m, index: i };
        return;
      }
    }
    if (!m || m.closed) {
      // neue Maske beginnen
      pushUndo();
      m = { id: `M${Date.now().toString(36)}`, name: `Maske ${p.masks.length + 1}`, mode: 'hide', feather: 40, points: [], closed: false, enabled: true };
      p.masks.push(m);
      S.activeMaskId = m.id;
    }
    if (m.points.length >= 3 && Math.hypot(m.points[0][0] - uv[0], m.points[0][1] - uv[1]) < tol) {
      m.closed = true;
    } else m.points.push(uv);
    markDirty();
    refresh(true);
  } else if (phase === 'move' && S.maskDrag) {
    S.maskDrag.mask.points[S.maskDrag.index] = uv;
    refresh(true);
  } else if (phase === 'up') {
    S.maskDrag = null;
    markDirty();
  } else if (phase === 'dblclick' && m && !m.closed && m.points.length >= 3) {
    m.closed = true;
    refresh();
  }
}

// ------------------------------------------------------------------ Arbeitsschritte
const MODES = ['setup', 'calibrate', 'blend', 'output'];
function setMode(m) {
  if (!MODES.includes(m)) m = 'calibrate';
  S.mode = m;
  try { localStorage.setItem('kalib.mode', m); } catch { /* egal */ }
  for (const x of MODES) document.body.classList.toggle(`mode-${x}`, x === m);
  document.querySelectorAll('#modes button').forEach((b) => { b.classList.toggle('on', b.dataset.mode === m); b.setAttribute('aria-selected', String(b.dataset.mode === m)); });
  if (m !== 'calibrate') { S.pendingRepick = false; S.pickCenter = false; }
  if (m !== 'blend') S.activeMaskId = null;
  refresh();
}
/** Vorschläge nur zeigen, solange noch Punkte fehlen oder die Lösung unsicher ist (die Anleitung erklärt sie dann). */
function showSuggest() {
  const p = active();
  return S.mode === 'calibrate' && (enabledPoints(p) < 6 || !isGood(S.results[p.id]?.quality));
}
function previewMode() {
  if (warpEditing()) return 'warp';
  if (S.mode === 'blend') return S.activeMaskId ? 'masks' : 'blend';
  if (S.mode === 'output') return Object.keys(S.blendImages).length ? 'blend' : 'points';
  return 'points';
}

// ------------------------------------------------------------------ UI-Rendering
let refreshQueued = false, lightOnly = true;
function refresh(light = false) {
  lightOnly = lightOnly && light;
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    const l = lightOnly;
    lightOnly = true;
    if (!l) {
      renderProjList();
      renderSetup();
      renderBlend();
      renderOutput();
      renderModes();
    }
    renderCalibrate();
    renderGuide();
    renderDocState();
    view.update(S.project, S.activeId, S.activePointId, S.pendingRepick, showSuggest() ? S.results[S.activeId]?.candidates : null);
    preview.mode = previewMode();
    preview.set(active(), S.activePointId, { activeHandle: S.activeHandle, suggest: showSuggest() ? S.results[S.activeId]?.suggest : null, activeMaskId: S.activeMaskId, blendImg: blendImgFor(S.activeId) });
    $('#previewCaption').replaceChildren(el('span', {}, el('b', {}, displayName(active())), outputLabel(active())), el('span', {}, `${active().resolution[0]} × ${active().resolution[1]}`));
    $('#btnUndo').disabled = !undoStack.length;
    $('#btnRedo').disabled = !redoStack.length;
    broadcast();
  });
}

const blendImgCache = new Map();
function blendImgFor(id) {
  const b = S.blendImages[id];
  if (!b) return null;
  let img = blendImgCache.get(b.previewUrl);
  if (!img) {
    img = new Image();
    img.onload = () => refresh(true);
    img.src = b.previewUrl;
    blendImgCache.set(b.previewUrl, img);
  }
  return img;
}

const nf = (n, d = 1, group = false) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: group });
const QUAD_SHORT = ['oben links', 'oben rechts', 'unten links', 'unten rechts'];
const indexOf = (p) => S.project.projectors.indexOf(p);
const displayName = (p) => (/^P\d+$/.test(p.name) ? `Projektor ${p.name.slice(1)}` : p.name);
const enabledPoints = (p) => p.points.filter((x) => x.enabled && x.world && x.image).length;
const QUALITY_TEXT = { 'sehr gut': 'Sitzt sehr gut', gut: 'Sitzt gut', 'vorläufig': 'Erste Lösung', unsicher: 'Noch unsicher' };
const isGood = (q) => q === 'sehr gut' || q === 'gut';

function outputLabel(p) {
  const o = S.project.outputs.find((x) => x.id === p.output);
  if (!o) return 'Kein Ausgang';
  return o.layout === '2x2' ? `${o.name} · ${QUAD_SHORT[p.quadrant]}` : o.layout === '1x2' ? `${o.name} · ${p.quadrant % 2 ? 'rechts' : 'links'}` : o.name;
}

// kleine Bausteine
const put = (sel, ...kids) => $(sel).replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
function infoBtn(tip) {
  const b = el('button', { class: 'info', 'data-tip': tip, 'aria-label': 'Info', type: 'button' });
  b.innerHTML = icon('info', 14);
  return b;
}
const ic = (name, size = 16) => el('span', { html: icon(name, size), style: 'display:contents' });
/** Zeile in einer Gruppe: Beschriftung links, Bedienelement rechts. */
function r(label, control, { sub, tip, cls = '' } = {}) {
  const sw = control?.classList?.contains('switch');
  return el('div', { class: `r ${sw ? 'sw' : ''} ${cls}` },
    el('div', { class: 'lbl' }, el('span', {}, label, sub ? el('span', { class: 'sub' }, sub) : null), tip ? infoBtn(tip) : null),
    el('div', { class: 'ctl' }, control));
}
const group = (...rows) => el('div', { class: 'group' }, ...rows.flat().filter(Boolean));
const gtitle = (text, ...actions) => el('div', { class: 'g-title' }, el('span', {}, text), actions.length ? el('div', { class: 'actions' }, ...actions) : null);
function iconBtn(name, tip, onclick, { disabled = false, on = false, id } = {}) {
  return el('button', { class: `icon-btn ${on ? 'on' : ''}`, 'data-tip': tip, 'aria-label': tip, onclick, disabled, id, html: icon(name) });
}
function select(options, value, onchange, attrs = {}) {
  return el('select', { ...attrs, onchange: (e) => onchange(e.target.value) }, ...options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));
}
function input(value, onchange, type = 'text', attrs = {}) {
  return el('input', { type, value, ...attrs, onchange: (e) => onchange(type === 'number' ? Number(e.target.value) : e.target.value) });
}
/** Schieberegler im macOS-Stil: dünne Spur mit Füllung, runder Knopf, Wert rechts, optional Teilstriche. */
function rangeCtl(value, min, max, step, fmt, oninput, onchange, ticks = 0) {
  const out = el('output', {}, fmt(value));
  const pct = (v) => `${((v - min) / (max - min)) * 100}%`;
  const rg = el('input', { type: 'range', min, max, step, value, style: `--p:${pct(value)}`,
    oninput: (e) => { const v = Number(e.target.value); e.target.style.setProperty('--p', pct(v)); out.textContent = fmt(v); oninput?.(v); },
    onchange: (e) => onchange(Number(e.target.value)) });
  const track = el('div', { class: 'slider' }, rg, ticks > 1 ? el('div', { class: 'ticks', 'aria-hidden': 'true' }, ...Array.from({ length: ticks }, () => el('i'))) : null);
  return el('div', { class: `range ${ticks > 1 ? 'has-ticks' : ''}` }, track, out);
}
function switchCtl(checked, onchange, attrs = {}) {
  return el('input', { type: 'checkbox', class: 'switch', checked, ...attrs, onchange: (e) => onchange(e.target.checked) });
}
/** Aufklappbereich, merkt sich offen/zu. */
function more(key, label, ...content) {
  S.ui ||= {};
  const d = el('details', { class: 'more', open: !!S.ui[key] },
    el('summary', {}, ic('chevron', 14), label), ...content);
  d.addEventListener('toggle', () => { S.ui[key] = d.open; });
  return d;
}

// ---------- Seitenleiste
function statusOf(p) {
  const n = enabledPoints(p);
  const q = S.results[p.id]?.quality;
  if (!p.enabled) return { cls: '', node: 'aus' };
  if (p.solution && isGood(q)) return { cls: 'ok', node: ic('checkCircle', 16), tip: `Kalibriert, ${nf(p.solution.rms)} px Abweichung` };
  if (p.solution) return { cls: 'warn', node: ic('alert', 16), tip: QUALITY_TEXT[q] || 'Unsicher' };
  return { cls: '', node: n ? `${n} / 4` : '' };
}

function projRow(p) {
  const i = indexOf(p);
  const st = statusOf(p);
  return el('div', { class: `proj-row ${p.id === S.activeId ? 'active' : ''} ${p.enabled ? '' : 'disabled'}`, onclick: () => selectProjector(p.id), role: 'button', tabindex: 0, 'aria-label': displayName(p) },
    el('span', { class: 'badge', style: `background:${p.color}` }, String(i + 1)),
    el('span', { class: 't' }, el('span', { class: 'name' }, displayName(p)), el('span', { class: 'sub' }, outputLabel(p))),
    el('span', { class: `st ${st.cls}`, 'data-tip': st.tip }, st.node));
}

function renderProjList() {
  const ps = S.project.projectors;
  $('#projListInner').replaceChildren(...ps.filter((p) => p.ring !== 'außen').map(projRow));
  $('#projListOuter').replaceChildren(...ps.filter((p) => p.ring === 'außen').map(projRow));
  const on = ps.filter((p) => p.enabled);
  const done = on.filter((p) => p.solution && isGood(S.results[p.id]?.quality)).length;
  $('#overall').replaceChildren(el('div', {}, `${done} von ${on.length} kalibriert`), el('div', { class: 'progress' }, el('i', { style: `width:${on.length ? (100 * done) / on.length : 0}%` })));
}

function renderModes() {
  const ps = S.project.projectors.filter((p) => p.enabled);
  const done = {
    setup: !!S.model && S.project.outputs.some((o) => o.displayId != null),
    calibrate: ps.length > 0 && ps.every((p) => p.solution && isGood(S.results[p.id]?.quality)),
    blend: Object.keys(S.blendImages).length > 0,
    output: false,
  };
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('done', done[b.dataset.mode] && !b.classList.contains('on')));
}

function renderDocState() {
  $('#projectName').textContent = S.project.name;
  $('#docState').textContent = S.dirty ? (S.projectPath ? 'Bearbeitet' : 'Automatisch gesichert') : S.projectPath ? 'Gespeichert' : '';
}

// ---------- 1 Einrichten
function quadDiagram(o) {
  const ps = S.project.projectors.filter((p) => p.output === o.id);
  const n = o.layout === '2x2' ? 4 : o.layout === '1x2' ? 2 : 1;
  const cells = Array.from({ length: n }, (_, q) => {
    const p = ps.find((x) => (n === 1 ? true : x.quadrant % n === q));
    return el('span', { style: p ? `background:${p.color}` : 'background:var(--bg-select)' }, p ? String(indexOf(p) + 1) : '');
  });
  return el('div', { class: `quad l${o.layout}` }, ...cells);
}

function outputRows() {
  const opts = [['', 'Kein Bildschirm'], ...S.displays.map((d) => [d.id, `${d.label} · ${d.pixelSize.width} × ${d.pixelSize.height}`])];
  return S.project.outputs.map((o) => {
    const ps = S.project.projectors.filter((p) => p.output === o.id).map((p) => indexOf(p) + 1);
    return el('div', { class: 'r stack' },
      el('div', { class: 'lbl', style: 'gap:10px' }, quadDiagram(o), el('span', {}, o.name, el('span', { class: 'sub' }, ps.length ? `Projektor ${ps[0]} bis ${ps[ps.length - 1]}` : 'nicht belegt'))),
      el('div', { class: 'ctl' },
        select(opts, o.displayId ?? '', async (v) => {
          const old = o.displayId;
          o.displayId = v ? Number(v) : null;
          markDirty();
          if (S.openOutputs.size) {
            if (old != null) await api.closeOutput(old);
            if (o.displayId != null) await api.openOutput(o.displayId, o.id);
            await syncOpenOutputs();
          }
          refresh();
        }, { 'aria-label': `Bildschirm für ${o.name}` }),
        select([['2x2', '2 × 2'], ['1x2', '1 × 2'], ['1x1', 'Ganz']], o.layout, (v) => { o.layout = v; markDirty(); refresh(); }, { style: 'width:76px;flex:none', 'aria-label': 'Aufteilung', 'data-tip': 'Aufteilung des Bildschirms auf Projektoren' })));
  });
}

function modelRow() {
  const m = S.model;
  return el('div', { class: 'r sw' },
    el('div', { class: 'lbl', style: 'gap:10px' }, ic('model', 20),
      el('span', { style: 'overflow:hidden' }, el('span', { style: 'display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', 'data-tip': S.project.model.name || '' }, S.project.model.name || 'Kein Modell'), el('span', { class: 'sub' }, m ? `${nf(m.triangles, 0, true)} Dreiecke · ${nf(m.featureVertices.length / 3, 0, true)} Ecken` : 'OBJ-Datei wählen'))),
    el('div', { class: 'ctl' }, el('button', { class: 'btn', onclick: chooseModel }, m ? 'Ändern …' : 'Wählen …')));
}

function renderSetup() {
  const p = active();
  const lens = getLensPreset(p.lens);
  const o = S.project.outputs.find((x) => x.id === p.output);
  const set = (fn, solve = false) => { fn(); if (solve) scheduleSolve(p); markDirty(); refresh(); };
  put('#paneSetup', 
    gtitle('3D-Modell'),
    group(modelRow()),
    gtitle('Bildschirme', infoBtn('Jeder Ausgang der Grafikkarte wird in Viertel geteilt, jedes Viertel geht an einen Projektor.')),
    group(outputRows()),
    gtitle(displayName(p)),
    group(
      r('Name', input(displayName(p), (v) => set(() => { p.name = v.trim() || `P${indexOf(p) + 1}`; }))),
      r('Verwenden', switchCtl(p.enabled, (v) => set(() => { p.enabled = v; }))),
      r('Ausgang', select([...S.project.outputs.map((x) => [x.id, x.name]), ['', 'Keiner']], p.output, (v) => set(() => { p.output = v; }))),
      o && o.layout !== '1x1' ? r('Bildbereich', select((o.layout === '2x2' ? QUAD_SHORT : ['links', 'rechts']).map((n, i) => [i, n]), p.quadrant, (v) => set(() => { p.quadrant = Number(v); }))) : null,
      r('Auflösung', select([['1920x1080', '1920 × 1080'], ['1280x800', '1280 × 800'], ['1280x720', '1280 × 720'], ['3840x2160', '3840 × 2160']], p.resolution.join('x'), (v) => {
        pushUndo();
        const [w, h] = v.split('x').map(Number);
        const sx = w / p.resolution[0], sy = h / p.resolution[1];
        for (const pt of p.points) if (pt.image) pt.image = [pt.image[0] * sx, pt.image[1] * sy];
        p.resolution = [w, h];
        p.solution = null;
        set(() => {}, true);
      }), { tip: 'Auflösung des Signals, das der Beamer bekommt, nicht die native Panelauflösung.' }),
    ),
    group(
      r('Objektiv', select(LENS_PRESETS.map((l) => [l.id, l.name]), p.lens, (v) => set(() => { p.lens = v; }, true)), { tip: lens.note }),
      r('Montage', select([['auto', 'Automatisch'], ['normal', 'Achse unter dem Bild'], ['flipped', 'Achse über dem Bild']], p.mountMode, (v) => set(() => { p.mountMode = v; }, true)),
        { tip: 'Kurzdistanz-Beamer projizieren komplett auf eine Seite der Objektivachse. Je nach Menü-Einstellung (Decke/Tisch) liegt sie über oder unter dem Bild. Automatisch prüft beides.' }),
    ),
    more('setupAdv', 'TouchDesigner-Namen',
      group(
        r('Kamera', input(p.tdCamera, (v) => { p.tdCamera = v; markDirty(); }), { tip: 'Name des Camera COMP in TouchDesigner' }),
        r('Render', input(p.tdRender, (v) => { p.tdRender = v; markDirty(); }), { tip: 'Name des Render TOP, hinter den die Maske gehängt wird' }),
      )),
  );
}

// ---------- 2 Kalibrieren
function errClass(e) { return e < 3 ? 'e-ok' : e < 8 ? 'e-warn' : 'e-bad'; }

function statusCard(p) {
  const s = p.solution;
  const res = S.results[p.id] || {};
  const n = enabledPoints(p);
  let cls = '', head, sub, mark;
  if (s) {
    const good = isGood(res.quality);
    cls = good ? 'ok' : 'warn';
    mark = ic(good ? 'check' : 'alert', 16);
    head = QUALITY_TEXT[res.quality] || 'Berechnet';
    sub = `Abweichung ${nf(s.rms)} px · Position ± ${nf(s.sigmaCenter * 100, 0)} cm`;
  } else if (n >= 4) {
    mark = String(n); head = 'Rechnet …'; sub = res.message || '';
  } else {
    mark = String(n);
    head = n ? `Noch ${4 - n} ${4 - n === 1 ? 'Punkt' : 'Punkte'}` : 'Noch keine Punkte';
    sub = 'Ab 4 Punkten steht die Position, 6 gut verteilte sind ideal.';
  }
  const notes = (res.warnings || []).filter((w) => !(w.level === 'info' && /Vorläufige/.test(w.text)));
  return el('div', { class: `status ${cls}` },
    el('div', { class: 'head' }, el('div', { class: 'ic-wrap' }, mark), el('div', {}, el('b', {}, head), el('span', {}, sub))),
    el('div', { class: 'steps', 'aria-hidden': 'true' }, ...Array.from({ length: 6 }, (_, i) => el('i', { class: i < n ? 'done' : '' }))),
    notes.length ? el('div', { class: 'notes' }, ...notes.map((w) => el('div', {}, w.level === 'warn' ? ic('alert', 14) : null, el('span', {}, w.text)))) : null);
}

function renderCalibrate() {
  const p = active();
  const s = p.solution;
  const errs = new Map((s?.errors || []).map((e) => [e.id, e.error]));
  const rows = p.points.map((pt) => {
    const e = errs.get(pt.id);
    return el('div', { class: `r ${pt.id === S.activePointId ? 'active' : ''} ${pt.enabled ? '' : 'off'}`, onclick: () => selectPoint(pt.id) },
      el('span', { class: 'pid' }, String(pt.id)),
      el('span', { class: 'nm' }, `Punkt ${pt.id}`, pt.snapped ? null : el('span', { class: 'sub' }, 'Freie Stelle, nicht eingerastet')),
      el('span', { class: 'err' }, e != null && pt.enabled ? [e >= 3 ? el('i', { class: errClass(e) }) : null, `${nf(e)} px`] : ''),
      el('input', { type: 'checkbox', 'aria-label': 'Punkt verwenden', 'data-tip': 'Punkt verwenden', checked: pt.enabled, onclick: (ev) => ev.stopPropagation(), onchange: (ev) => { pushUndo(); pt.enabled = ev.target.checked; scheduleSolve(p); markDirty(); refresh(); } }));
  });
  const tabs = el('div', { class: 'seg fill', role: 'tablist', style: 'margin:4px 0 8px' },
    ...[['points', 'Punkte'], ['warp', 'Feinkorrektur']].map(([k, l]) => el('button', { class: S.calTab === k ? 'on' : '', role: 'tab', 'data-cal': k, onclick: () => { S.calTab = k; if (k === 'warp') { p.warp ||= defaultWarp(5, 5); } refresh(); } }, l)));
  if (S.calTab === 'warp') return put('#paneCalibrate', tabs, warpPane(p));
  put('#paneCalibrate', tabs,
    statusCard(p),
    gtitle('Punkte',
      iconBtn('target', 'Gewählten Punkt im Modell neu setzen', () => { S.pendingRepick = !S.pendingRepick; refresh(); }, { disabled: !activePoint(), on: S.pendingRepick, id: 'btnRepick' }),
      iconBtn('trash', 'Gewählten Punkt löschen (Entf)', deleteActivePoint, { disabled: !activePoint(), id: 'btnDeletePoint' })),
    rows.length ? el('div', { class: 'group plist' }, ...rows) : group(el('div', { class: 'empty-note' }, 'Klicke im 3D-Modell auf eine Ecke, um den ersten Punkt zu setzen.')),
    p.points.length ? el('div', { style: 'padding:6px 4px 0' }, el('button', { class: 'link danger', id: 'btnClearPoints', onclick: clearPoints }, 'Alle Punkte löschen')) : null,
    more('calDetails', 'Details und Hilfen',
      s ? group(
        r('Mittlerer Fehler', el('span', { class: 'muted' }, `${nf(s.rms, 2)} px`)),
        r('Positionsgenauigkeit', el('span', { class: 'muted' }, `± ${nf(s.sigmaCenter * 100, 1)} cm`)),
        r('Bildabdeckung', el('span', { class: 'muted' }, `${nf(s.coverage * 100, 0)} %`), { tip: 'Wie weit die Punkte über das Projektorbild verteilt sind. Über 50 % ist gut.' }),
        r('Wurfverhältnis', el('span', { class: 'muted' }, nf(s.throwRatio, 3))),
        r('Objektivachse', el('span', { class: 'muted' }, `${nf((s.cy / p.resolution[1]) * 100, 0)} % Bildhöhe`)),
      ) : null,
      el('div', { style: 'height:8px' }),
      group(r('Bildmitte vorgeben',
        el('div', { style: 'display:flex;gap:10px;align-items:center' },
          p.centerHint ? el('button', { class: 'link quiet', onclick: () => { pushUndo(); p.centerHint = null; scheduleSolve(p); markDirty(); refresh(); } }, 'Entfernen') : null,
          el('button', { class: `btn ${S.pickCenter ? 'on' : ''}`, onclick: () => { S.pickCenter = !S.pickCenter; refresh(); } }, S.pickCenter ? 'Im Modell klicken' : p.centerHint ? 'Neu wählen' : 'Wählen')),
        { tip: 'Wo ungefähr liegt die Mitte des Beamerbildes an der Decke? Ein Klick ins Modell genügt. Hilft bei wenigen oder eng liegenden Punkten.' })),
    ),
  );
}

// ---------- Feinkorrektur (Verzerrungsgitter)
const warpEditing = () => S.mode === 'calibrate' && S.calTab === 'warp';

function onWarpPointer(uv, phase) {
  const p = active();
  p.warp ||= defaultWarp(5, 5);
  const w = p.warp;
  const [W, H] = p.resolution;
  const nu = uv[0] / W, nv = uv[1] / H;
  if (phase === 'down') {
    let best = null, bd = 0.04;
    w.offsets.forEach((o, i) => {
      const [bu, bv] = gridBase(w, i);
      const d = Math.hypot((bu + o[0] - nu) * W / H, bv + o[1] - nv);
      if (d < bd) { bd = d; best = i; }
    });
    S.activeHandle = best;
    S.warpDrag = best != null ? (() => { const [bu, bv] = gridBase(w, best); const o = w.offsets[best]; return { grab: [bu + o[0] - nu, bv + o[1] - nv] }; })() : null;
    if (best != null) pushUndo();
    return refresh(true);
  }
  if (S.warpDrag && S.activeHandle != null && (phase === 'move' || phase === 'up')) {
    const [bu, bv] = gridBase(w, S.activeHandle);
    w.offsets[S.activeHandle] = [nu + S.warpDrag.grab[0] - bu, nv + S.warpDrag.grab[1] - bv];
    if (phase === 'up') { S.warpDrag = null; markDirty(); }
    refresh(true);
  }
}

function warpPane(p) {
  const w = p.warp;
  const n = w ? `${w.cols} × ${w.rows}` : '5 × 5';
  const o = w && S.activeHandle != null ? w.offsets[S.activeHandle] : null;
  const changed = w ? w.offsets.filter(([a, b]) => Math.hypot(a, b) > 1e-6).length : 0;
  return [
    el('div', { class: `status ${changed ? 'ok' : ''}` },
      el('div', { class: 'head' }, el('div', { class: 'ic-wrap', html: icon('target', 16) }),
        el('div', {}, el('b', {}, changed ? `${changed} ${changed === 1 ? 'Punkt' : 'Punkte'} korrigiert` : 'Keine Feinkorrektur'),
          el('span', {}, 'Punkte im Projektorbild oben oder direkt auf dem Projektor ziehen. Pfeiltasten: 1 Pixel, mit ⇧ 10 Pixel.')))),
    gtitle('Gitter'),
    group(
      r('Punkte', select([['3', '3 × 3'], ['5', '5 × 5'], ['7', '7 × 7'], ['9', '9 × 9']], String(w?.cols || 5), (v) => { pushUndo(); p.warp = resizeWarp(p.warp, Number(v), Number(v)); S.activeHandle = null; markDirty(); refresh(); }),
        { tip: 'Mehr Punkte erlauben feinere, örtlich begrenzte Korrekturen. Beim Wechsel bleibt die Form erhalten.' }),
      r('Gewählter Punkt', el('span', { class: 'muted' }, o ? `${nf(o[0] * p.resolution[0], 1)} / ${nf(o[1] * p.resolution[1], 1)} px` : 'keiner')),
      r('Testbild', el('button', { class: 'btn', onclick: () => { S.project.view.outputMode = 'grid'; markDirty(); if (!S.openOutputs.size) toggleOutputs(true); refresh(); } }, 'Raster auf Projektoren')),
    ),
    el('div', { class: 'act' },
      el('button', { class: 'link danger', disabled: !o, onclick: () => { pushUndo(); p.warp.offsets[S.activeHandle] = [0, 0]; markDirty(); refresh(); } }, 'Punkt zurücksetzen'),
      el('button', { class: 'link danger', disabled: !changed, onclick: () => { pushUndo(); p.warp = defaultWarp(w.cols, w.rows); markDirty(); refresh(); toast('Feinkorrektur zurückgesetzt. Mit Strg/Cmd+Z rückgängig.'); } }, 'Alles zurücksetzen')),
  ];
}

function coach(num, title, text, ok = false) {
  $('#guide').replaceChildren(el('span', { class: `num ${ok ? 'ok' : ''}` }, num), el('span', { class: 't' }, el('b', {}, title), text ? el('span', {}, text) : null));
}

function renderGuide() {
  const g = $('#guide');
  const p = active();
  const n = enabledPoints(p);
  const name = displayName(p);
  if (!S.model) return coach('!', 'Kein 3D-Modell geladen', 'Unter „Einrichten“ eine OBJ-Datei wählen.');
  if (S.mode === 'blend') {
    const m = p.masks.find((x) => x.id === S.activeMaskId);
    if (m && !m.closed) return coach(String(m.points.length), 'Maske zeichnen', 'Im Projektorbild rechts Eckpunkte setzen. Klick auf den ersten Punkt schließt die Form.');
    if (!Object.keys(S.blendImages).length) return coach('3', 'Masken berechnen', 'Rechts auf „Masken berechnen“ klicken, sobald die Projektoren kalibriert sind.');
    return g.replaceChildren();
  }
  if (S.mode !== 'calibrate' || warpEditing()) return g.replaceChildren();
  if (S.pickCenter) return coach(ic('focus', 16), 'Bildmitte wählen', `Ungefähr dorthin klicken, wo die Mitte des Bildes von ${name} liegt.`);
  if (S.pendingRepick) return coach(String(S.activePointId), `Punkt ${S.activePointId} neu setzen`, 'Die richtige Stelle im Modell anklicken.');
  if (n === 0 && !activePoint()) return coach('1', 'Markante Ecke im Modell anklicken', `Am besten weit außen im Bild von ${name} beginnen.`);
  if (activePoint() && !p.solution) return coach(String(Math.max(n, 1)), 'Fadenkreuz an dieselbe Ecke der Decke schieben', 'Im Vorschaubild ziehen oder mit den Pfeiltasten. Danach die nächste Ecke anklicken.');
  if (!p.solution) return coach(String(n + 1), 'Nächste Ecke anklicken', 'Möglichst weit weg von den bisherigen Punkten.');
  if (n < 6 || !isGood(S.results[p.id]?.quality)) return coach(String(n + 1), 'Kanten an der Decke prüfen', 'Wo es nicht passt, einen weiteren Punkt setzen. Blaue Kreise mit + sind gute Stellen dafür.');
  g.replaceChildren();
}

// ---------- 3 Überblenden
function renderBlend() {
  const b = S.project.blend;
  const p = active();
  const set = (k, v) => { b[k] = v; markDirty(); refresh(); };
  const m = p.masks.find((x) => x.id === S.activeMaskId);
  const maskRows = p.masks.map((x) => el('div', { class: `r ${x.id === S.activeMaskId ? 'active' : ''} ${x.enabled === false ? 'off' : ''}`, onclick: () => { S.activeMaskId = x.id === S.activeMaskId ? null : x.id; refresh(); } },
    el('span', { class: 'pid' }, ic('blend', 13)),
    el('span', { class: 'nm' }, x.name, el('span', { class: 'sub' }, `${x.mode === 'hide' ? 'Blendet aus' : 'Zeigt nur diesen Bereich'} · ${x.closed ? `${x.points.length} Ecken` : 'wird gezeichnet'}`)),
    el('span', {}), el('span', {})));
  put('#paneBlend', 
    gtitle('Überblendung'),
    group(
      r('Weich überblenden', switchCtl(b.auto, (v) => set('auto', v)), { tip: 'Wo sich Projektoren überlappen, wird weich übergeblendet. Gewichtet nach Abstand zum eigenen Bildrand.' }),
      r('Breite', rangeCtl(b.width, 0.05, 1, 0.05, (v) => `${nf(v * 100, 0)} %`, null, (v) => set('width', v), 5), { cls: b.auto ? '' : 'dim' }),
      r('Gamma', input(b.gamma, (v) => set('gamma', v), 'number', { step: 0.1, min: 1, max: 3, style: 'width:72px' }), { tip: 'Gamma der Beamer, meist 2,2. Verhindert dunkle oder helle Streifen in der Überblendung.' }),
    ),
    gtitle('Bogenseiten', infoBtn('Flächen, die nur von unten beleuchtet werden sollen. Gilt für alle Projektoren gleich, damit die Bilder zusammenpassen.')),
    group(
      r('Steile Flächen ausblenden', switchCtl(b.tiltFilter, (v) => set('tiltFilter', v)), { tip: 'Blendet Flächen aus, die steiler als der Grenzwinkel stehen, z. B. die Seiten der Bögen.' }),
      r('ab Neigung', rangeCtl(b.maxTilt, 30, 89, 1, (v) => `${v}°`, null, (v) => set('maxTilt', v), 0), { cls: b.tiltFilter ? 'indent' : 'indent dim' }),
      r('Streiflicht ausblenden', switchCtl(b.incFilter, (v) => set('incFilter', v)), { tip: 'Blendet Stellen aus, die ein Projektor nur sehr flach trifft. Dort ist das Bild verzerrt und ungleich hell.' }),
      r('ab Winkel', rangeCtl(b.maxIncidence, 50, 89, 1, (v) => `${v}°`, null, (v) => set('maxIncidence', v)), { cls: b.incFilter ? 'indent' : 'indent dim' }),
    ),
    gtitle('Helligkeit'),
    group(
      r('Angleichen', switchCtl(b.brightness, (v) => set('brightness', v)), { tip: 'Weiter entfernte oder schräg getroffene Flächen sind dunkler. Hellere Bereiche werden auf ein gemeinsames Niveau gedimmt.' }),
      r('Stärke', rangeCtl(b.brightnessStrength, 0, 1, 0.05, (v) => `${nf(v * 100, 0)} %`, null, (v) => set('brightnessStrength', v), 5), { cls: b.brightness ? '' : 'dim', tip: '100 % gleicht vollständig an und kostet am meisten Gesamthelligkeit.' }),
    ),
    el('div', { class: 'act' }, el('span', { class: 'hint', id: 'blendStatus' }, S.blendStatus || ''), el('button', { class: 'btn primary', id: 'btnComputeBlend', onclick: computeBlend }, 'Masken berechnen')),
    gtitle(`Eigene Masken · ${displayName(p)}`,
      iconBtn('plus', 'Neue Maske zeichnen', newMask, { id: 'btnNewMask' }),
      iconBtn('trash', 'Gewählte Maske löschen', deleteMask, { disabled: !m, id: 'btnDeleteMask' })),
    maskRows.length ? el('div', { class: 'group plist' }, ...maskRows) : group(el('div', { class: 'empty-note' }, 'Mit + eine Maske anlegen und im Projektorbild oben zeichnen.')),
    m ? el('div', { style: 'height:8px' }) : null,
    m ? group(
      r('Name', input(m.name, (v) => { m.name = v; markDirty(); refresh(); })),
      r('Wirkung', select([['hide', 'Bereich ausblenden'], ['show', 'Nur Bereich zeigen']], m.mode, (v) => { pushUndo(); m.mode = v; markDirty(); refresh(); })),
      r('Weiche Kante', rangeCtl(m.feather, 0, 300, 1, (v) => `${v} px`, (v) => { m.feather = v; refresh(true); }, () => { markDirty(); refresh(); })),
      r('Aktiv', switchCtl(m.enabled !== false, (v) => { m.enabled = v; markDirty(); refresh(); })),
    ) : null,
  );
}

function newMask() {
  const p = active();
  pushUndo();
  const m = { id: `M${Date.now().toString(36)}`, name: `Maske ${p.masks.length + 1}`, mode: 'hide', feather: 40, points: [], closed: false, enabled: true };
  p.masks.push(m);
  S.activeMaskId = m.id;
  refresh();
}
function deleteMask() {
  const p = active();
  const i = p.masks.findIndex((x) => x.id === S.activeMaskId);
  if (i < 0) return;
  pushUndo();
  p.masks.splice(i, 1);
  S.activeMaskId = null;
  markDirty();
  refresh();
}

// ---------- 4 Ausgabe
const TEST_MODES = [['video', 'Video', 'Gewähltes Video auf dem Modell'], ['edges', 'Kanten', 'Kanten des Modells'], ['grid', 'Raster', 'Gleichmäßiges Raster über das Modell'], ['white', 'Weiß', 'Weiße Fläche, zeigt Überblendung und Helligkeit'], ['ident', 'Nummer', 'Projektornummer groß']];
function renderOutput() {
  const v = S.project.view;
  const td = S.project.td;
  const isOpen = S.openOutputs.size > 0;
  put('#paneOutput', 
    gtitle('Projektoren'),
    group(
      r('Bild ausgeben', switchCtl(isOpen, (on) => toggleOutputs(on), { id: 'swOutputs' }), { sub: 'Vollbild auf den zugeordneten Bildschirmen' }),
      el('div', { class: 'r wide' }, el('div', { class: 'seg fill', role: 'radiogroup', 'aria-label': 'Testbild' },
        ...TEST_MODES.map(([k, l, tip]) => el('button', { class: v.outputMode === k ? 'on' : '', 'data-tip': tip, 'data-mode': k, onclick: () => { v.outputMode = k; markDirty(); refresh(); } }, l)))),
      r('Masken anwenden', switchCtl(v.showMask, (on) => { v.showMask = on; if (on && !Object.keys(S.blendImages).length) computeBlend(); markDirty(); refresh(); }, { id: 'chkShowMask' }), { sub: 'Überblendung und eigene Masken' }),
    ),
    gtitle('Wiedergabe', infoBtn('Spielt ein Video auf dem Modell ab, über alle Projektoren mit Überblendung und Masken. Beide HDMI-Ausgänge laufen synchron.')),
    playbackGroup(),
    gtitle('TouchDesigner', infoBtn('Live senden schickt jede Änderung per OSC an TouchDesigner. Dort einen OSC In DAT mit osc_callbacks.py aus dem Export-Ordner anlegen.')),
    group(
      r('Live senden', switchCtl(td.live, (on) => { td.live = on; markDirty(); if (on) sendAllLive(); refresh(); }), { sub: td.live ? S.liveStatus || 'Bereit' : 'Aus' }),
      r('Ziel', el('div', { style: 'display:flex;gap:6px;width:100%' }, input(td.host, (x) => { td.host = x; markDirty(); }, 'text', { 'aria-label': 'Adresse' }), input(td.port, (x) => { td.port = x; markDirty(); }, 'number', { style: 'width:72px;flex:none', 'aria-label': 'Port' }))),
    ),
    el('div', { class: 'act' }, el('span', { class: 'hint' }, 'Kameras, Masken und Skript für TouchDesigner'), el('button', { class: 'btn', onclick: exportTD, id: 'btnExport' }, 'Exportieren …')),
  );
  const btn = $('#btnOutputs');
  btn.classList.toggle('on', isOpen);
  btn.setAttribute('aria-pressed', String(isOpen));
}

// ---------- Wiedergabe
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const metaVideo = document.createElement('video');
metaVideo.muted = true;
metaVideo.preload = 'metadata';
metaVideo.addEventListener('loadedmetadata', () => {
  S.videoInfo = { duration: metaVideo.duration, width: metaVideo.videoWidth, height: metaVideo.videoHeight };
  refresh();
});
metaVideo.addEventListener('error', () => { S.videoInfo = { error: true }; refresh(); });
function loadVideoMeta() {
  const src = S.project.playback.src;
  S.videoInfo = null;
  if (src) { metaVideo.src = fileUrl(src); metaVideo.load(); } else metaVideo.removeAttribute('src');
}

async function chooseVideo() {
  const files = await api.openDialog({ title: 'Video wählen', filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] }], properties: ['openFile'] });
  if (files?.[0]) setVideo(files[0]);
}
function setVideo(file) {
  const pb = S.project.playback;
  pb.src = file;
  pb.name = file.split(/[\\/]/).pop();
  S.play = { playing: false, startedAt: Date.now(), pausedAt: 0, loop: pb.loop };
  S.project.view.outputMode = 'video';
  loadVideoMeta();
  markDirty();
  refresh();
}

function setPlay(action) {
  const pb = S.project.playback;
  if (!pb.src) return toast('Erst ein Video wählen.');
  S.play = playState({ ...S.play, loop: pb.loop }, action, S.videoInfo?.duration || 0);
  if (action === 'play') S.project.view.outputMode = 'video';
  if (action === 'play' && !S.openOutputs.size) toggleOutputs(true);
  refresh();
}

let playTicker = null;
function playbackGroup() {
  const pb = S.project.playback;
  const info = S.videoInfo;
  const dur = info?.duration || 0;
  clearInterval(playTicker);
  if (S.play.playing && S.mode === 'output') playTicker = setInterval(() => { const o = document.getElementById('playPos'); if (o) o.textContent = `${fmtTime(targetTime(S.play, dur))} / ${fmtTime(dur)}`; }, 250);
  const sub = !pb.src ? 'Kein Video gewählt' : info?.error ? 'Datei lässt sich nicht abspielen' : info ? `${info.width} × ${info.height} · ${fmtTime(dur)}` : 'Lädt …';
  return group(
    el('div', { class: 'r sw' },
      el('div', { class: 'lbl', style: 'gap:10px' }, ic('play', 18),
        el('span', { style: 'overflow:hidden' }, el('span', { style: 'display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', 'data-tip': pb.src || '' }, pb.name || 'Video'), el('span', { class: 'sub' }, sub))),
      el('div', { class: 'ctl' }, el('button', { class: 'btn', onclick: chooseVideo, id: 'btnVideo' }, pb.src ? 'Ändern …' : 'Wählen …'))),
    pb.src ? el('div', { class: 'r sw' },
      el('div', { class: 'lbl', style: 'gap:8px' },
        el('button', { class: 'btn primary', id: 'btnPlay', style: 'min-width:92px', onclick: () => setPlay(S.play.playing ? 'pause' : 'play') }, ic(S.play.playing ? 'pause' : 'play', 14), S.play.playing ? 'Pause' : 'Abspielen'),
        el('button', { class: 'icon-btn', 'data-tip': 'Von vorn', 'aria-label': 'Von vorn', onclick: () => setPlay('restart'), html: icon('restart') })),
      el('div', { class: 'ctl' }, el('span', { class: 'muted', id: 'playPos' }, `${fmtTime(targetTime(S.play, dur))} / ${fmtTime(dur)}`))) : null,
    r('Abbildung', select([['top', 'Draufsicht'], ['uv', 'Modell-UV']], pb.mapping, (v) => { pb.mapping = v; markDirty(); refresh(); }),
      { tip: 'Draufsicht legt das Video wie von oben gesehen über den Grundriss, Norden oben. Modell-UV nutzt die Texturkoordinaten aus dem 3D-Modell.' }),
    r('Schleife', switchCtl(pb.loop, (v) => { pb.loop = v; S.play = { ...S.play, loop: v }; markDirty(); refresh(); })),
    pb.src && S.play.playing && S.openOutputs.size ? r('Leistung', el('span', { class: 'muted', id: 'outStats' }, outStatsText()),
      { tip: 'Bilder pro Sekunde je HDMI-Ausgang und verworfene Videobilder. Liegt die Bildrate deutlich unter der des Videos, ist die Grafikkarte oder die Videodatei zu schwer.' }) : null,
  );
}

function outStatsText() {
  const now = Date.now();
  const list = Object.values(S.outStats).filter((x) => now - x.at < 5000).sort((a, b) => String(a.outputId).localeCompare(String(b.outputId)));
  if (!list.length) return 'Wird gemessen …';
  return list.map((x) => `${x.outputId}: ${Math.round(x.fps)} fps${x.dropped ? ` · ${x.dropped} verworfen` : ''}`).join('   ');
}
function showOutStats() {
  const o = document.getElementById('outStats');
  if (o) o.textContent = outStatsText();
}

// ------------------------------------------------------------------ TouchDesigner live (OSC)
const liveTimers = {};
function sendLive(p, immediate = false) {
  const td = S.project.td;
  if (!td.live || !p.solution) return;
  clearTimeout(liveTimers[p.id]);
  liveTimers[p.id] = setTimeout(async () => {
    const ex = exportProjector(p, { modelRadius: S.model?.radius });
    const res = await api.oscSend(td.host, Number(td.port), '/kalibrator/projector', [JSON.stringify(ex)]);
    S.liveStatus = res.ok ? `Zuletzt ${displayName(p)} um ${new Date().toLocaleTimeString('de-DE')}` : `Fehler: ${res.error}`;
    if (S.mode === 'output') refresh();
  }, immediate ? 0 : 80);
}
function sendAllLive() {
  for (const p of S.project.projectors) sendLive(p, true);
}

// ------------------------------------------------------------------ Ausgänge
let bcQueued = false;
function broadcast() {
  if (!S.openOutputs.size || bcQueued) return;
  bcQueued = true;
  requestAnimationFrame(() => {
    bcQueued = false;
    api.broadcast({
      type: 'state',
      project: S.project,
      activeId: S.activeId,
      activePointId: S.activePointId,
      play: S.play,
      warpEdit: warpEditing(),
      markers: S.mode === 'calibrate',
      activeHandle: S.activeHandle,
      modelPath: S.project.model.path,
    });
  });
}
function broadcastBlend() {
  if (!S.openOutputs.size) return;
  const images = {};
  for (const [id, b] of Object.entries(S.blendImages)) images[id] = b.autoPreviewUrl;
  api.broadcast({ type: 'blend', images });
}

async function syncOpenOutputs() {
  S.openOutputs = new Set(await api.openOutputIds());
}

async function toggleOutputs(force) {
  const open = force ?? !S.openOutputs.size;
  if (!open) {
    await api.closeAllOutputs();
    S.openOutputs.clear();
    return refresh();
  }
  const assigned = S.project.outputs.filter((o) => o.displayId != null && S.displays.some((d) => d.id === o.displayId));
  if (!assigned.length) {
    toast('Erst unter „Einrichten“ einen Bildschirm für HDMI A oder B wählen.');
    return refresh();
  }
  for (const o of assigned) await api.openOutput(o.displayId, o.id);
  await syncOpenOutputs();
  refresh();
  setTimeout(() => { broadcast(); broadcastBlend(); }, 800);
}

api.onOutputEvent((msg) => {
  if (msg.type === 'ready') { broadcast(); broadcastBlend(); return; }
  if (msg.type === 'key') return handleKey(msg);
  if (msg.type === 'stats') { S.outStats[msg.outputId] = { ...msg, at: Date.now() }; return showOutStats(); }
  if (msg.type === 'pointer') {
    // Klick/Ziehen auf einem Projektor-Ausgang
    if (msg.projectorId !== S.activeId) {
      if (msg.phase === 'down') selectProjector(msg.projectorId);
      return;
    }
    const p = active();
    if (warpEditing()) return onWarpPointer([msg.u, msg.v], msg.phase === 'down' ? 'down' : msg.phase === 'up' ? 'up' : 'move');
    // Klickposition auf dem Projektor -> Bildkoordinate vor der Feinkorrektur
    if (!isIdentity(p.warp)) {
      const [su, sv] = inverse(p.warp, msg.u / p.resolution[0], msg.v / p.resolution[1]);
      msg = { ...msg, u: su * p.resolution[0], v: sv * p.resolution[1] };
    }
    let pt = activePoint();
    if (msg.phase === 'down') {
      // nahen Punkt wählen, sonst aktiven Punkt hierher setzen
      const near = p.points.find((x) => x.image && Math.hypot(x.image[0] - msg.u, x.image[1] - msg.v) < 25);
      if (near && near !== pt) { selectPoint(near.id); return; }
      if (!pt) return toast('Erst im Modell einen Punkt anklicken, dann hier auf der Decke platzieren.');
      pushUndo();
    }
    if (pt) setImage(pt, msg.u, msg.v, msg.phase === 'up' ? 0 : 30);
  }
});
api.onOutputClosed(async () => { await syncOpenOutputs(); refresh(); });
api.onDisplaysChanged(async () => { S.displays = await api.listDisplays(); refresh(); });

// ------------------------------------------------------------------ Tastatur
function handleKey(e) {
  const p = active();
  const pt = activePoint();
  const step = e.shiftKey ? 10 : e.altKey ? 0.25 : 1;
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (warpEditing() && p.warp) {
    const n = p.warp.offsets.length;
    if (mv && S.activeHandle != null) {
      if (!e.repeat) pushUndo();
      const o = p.warp.offsets[S.activeHandle];
      o[0] += mv[0] / p.resolution[0]; o[1] += mv[1] / p.resolution[1];
      markDirty(); refresh(true);
      return true;
    }
    if (e.key === 'Tab') { S.activeHandle = ((S.activeHandle ?? -1) + (e.shiftKey ? -1 : 1) + n) % n; refresh(true); return true; }
  }
  if (mv && pt?.image) {
    if (!e.repeat) pushUndo();
    setImage(pt, pt.image[0] + mv[0], pt.image[1] + mv[1], e.repeat ? 60 : 0);
    return true;
  }
  if (e.key === 'Tab' && p.points.length) {
    const i = p.points.findIndex((x) => x.id === S.activePointId);
    const n = p.points.length;
    selectPoint(p.points[(i + (e.shiftKey ? -1 : 1) + n) % n].id);
    return true;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && pt) { deleteActivePoint(); return true; }
  if (e.key === 'Escape') { S.activePointId = null; S.pendingRepick = false; S.pickCenter = false; S.activeMaskId = null; $('#helpMenu').classList.add('hidden'); refresh(); return true; }
  if (/^[1-8]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    const target = S.project.projectors[Number(e.key) - 1];
    if (target) selectProjector(target.id);
    return true;
  }
  if (e.key === 'Enter' && S.mode === 'blend') {
    const m = p.masks.find((x) => x.id === S.activeMaskId);
    if (m && !m.closed && m.points.length >= 3) { m.closed = true; refresh(); }
    return true;
  }
  return false;
}
window.addEventListener('keydown', (e) => {
  if (!$('#onboarding').classList.contains('hidden')) {
    if (e.key === 'Escape') closeOnboarding(false);
    return;
  }
  const ae = document.activeElement;
  const tag = ae?.tagName;
  if ((tag === 'INPUT' && ae.type !== 'checkbox') || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
  if (mod) return;
  if (handleKey(e)) e.preventDefault();
});

function deleteActivePoint() {
  const p = active();
  const i = p.points.findIndex((x) => x.id === S.activePointId);
  if (i < 0) return;
  pushUndo();
  p.points.splice(i, 1);
  S.activePointId = p.points[Math.min(i, p.points.length - 1)]?.id ?? null;
  scheduleSolve(p);
  markDirty();
  refresh();
}

// ------------------------------------------------------------------ Datei / Projekt
const DEMO_FILE = 'Gewoelbedecke_mit_Wandstreifen_16k.obj';
const isDemo = () => (S.project.model.path || '').replace(/\\/g, '/').endsWith(`examples/${DEMO_FILE}`);
async function loadDemo() {
  const { examples } = await api.paths();
  const ok = await loadModelFromPath(`${examples}/${DEMO_FILE}`);
  if (ok) { S.project.model.name = 'Demo: Gewölbedecke'; refresh(); }
  return ok;
}

async function loadModelFromPath(path) {
  try {
    const text = await api.readFile(path, 'utf8');
    S.model = buildModel(text);
    S.project.model = { path, name: path.split(/[\\/]/).pop() };
    view.setModel(S.model);
    preview.setModel(S.model);
    S.blendImages = {};
    refresh();
    return true;
  } catch (err) {
    toast(`Modell konnte nicht geladen werden: ${err.message}`);
    return false;
  }
}

async function chooseModel() {
  const files = await api.openDialog({ title: '3D-Modell laden', filters: [{ name: 'OBJ', extensions: ['obj'] }], properties: ['openFile'] });
  if (files?.[0]) { await loadModelFromPath(files[0]); markDirty(); }
}

function serialize() {
  return JSON.stringify({ app: 'projection-studio', ...S.project }, null, 1);
}

async function save(as = false) {
  let path = S.projectPath;
  if (!path || as) {
    path = await api.saveDialog({ title: 'Projekt speichern', defaultPath: 'Mapping.kalib.json', filters: [{ name: 'Kalibrier-Projekt', extensions: ['json'] }] });
    if (!path) return;
  }
  await api.writeFile(path, serialize());
  S.projectPath = path;
  S.dirty = false;
  S.project.name = path.split(/[\\/]/).pop().replace(/\.kalib\.json$|\.json$/, '');
  refresh();
  toast('Gespeichert');
}

async function openProject(path) {
  if (!path) {
    const files = await api.openDialog({ title: 'Projekt öffnen', filters: [{ name: 'Kalibrier-Projekt', extensions: ['json'] }], properties: ['openFile'] });
    if (!files?.[0]) return;
    path = files[0];
  }
  const data = JSON.parse(await api.readFile(path, 'utf8'));
  await applyProject(data);
  S.projectPath = path;
  toast('Projekt geöffnet');
}

async function applyProject(data) {
  S.project = migrateProject(data);
  S.activeId = S.project.projectors[0].id;
  S.activePointId = null;
  S.results = {};
  undoStack.length = redoStack.length = 0;
  if (S.project.model.path && (await api.exists(S.project.model.path))) await loadModelFromPath(S.project.model.path);
  for (const p of S.project.projectors) if (p.points.length) scheduleSolve(p);
  S.play = { playing: false, startedAt: Date.now(), pausedAt: 0, loop: S.project.playback.loop };
  loadVideoMeta();
  refresh();
}

let autosaveTimer;
function markDirty() {
  S.dirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    const { userData } = await api.paths();
    api.writeFile(`${userData}/autosave.kalib.json`, serialize());
  }, 1500);
}

// ------------------------------------------------------------------ Blending + Export
async function computeBlend() {
  const solved = S.project.projectors.filter((p) => p.solution && p.enabled);
  if (!S.model || !solved.length) { toast('Erst mindestens einen Projektor kalibrieren.'); return null; }
  S.blendStatus = 'Rechnet …';
  refresh();
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const res = computeBlendMasks(S.model, S.project);
  S.blendImages = res;
  const ms = Math.round(performance.now() - t0);
  S.blendStatus = `${Object.keys(res).length} Masken berechnet in ${nf(ms / 1000, 1)} s`;
  broadcastBlend();
  refresh();
  return res;
}

async function exportTD() {
  const solved = S.project.projectors.filter((p) => p.solution);
  if (!solved.length) return toast('Noch kein Projektor kalibriert.');
  const dirs = await api.openDialog({ title: 'Ordner der TouchDesigner-Datei wählen (dort entsteht „kalibrierung“)', properties: ['openDirectory', 'createDirectory'] });
  if (!dirs?.[0]) return;
  const base = `${dirs[0]}/kalibrierung`;
  const blend = await computeBlend();
  const projectors = [];
  for (const p of solved) {
    const ex = exportProjector(p, { modelRadius: S.model?.radius });
    const b = blend?.[p.id];
    if (b) {
      ex.maskFile = `masken/${p.id}.png`;
      const blob = await new Promise((r) => b.canvas.toBlob(r, 'image/png'));
      await api.writeFile(`${base}/${ex.maskFile}`, new Uint8Array(await blob.arrayBuffer()));
    }
    if (!isIdentity(p.warp)) {
      ex.warp = p.warp;
      ex.warpShader = `feinkorrektur/${p.id}.frag`;
      await api.writeFile(`${base}/${ex.warpShader}`, touchDesignerShader(p.warp));
    }
    projectors.push(ex);
  }
  const out = {
    app: 'Projection Studio',
    version: 1,
    created: new Date().toISOString(),
    model: S.project.model,
    conventions: {
      world: 'Koordinaten des OBJ-Modells (Y oben)',
      matrices: 'row-major, Spaltenvektoren (p\' = M p)',
      touchdesigner: 'Transform-Reihenfolge srt, Rotation xyz, FOV horizontal, winx/winy = Lens Shift',
    },
    blend: S.project.blend,
    projectors,
  };
  await api.writeFile(`${base}/kalibrierung.json`, JSON.stringify(out, null, 2));
  const { td } = await api.paths();
  try {
    for (const n of ['apply_calibration.py', 'osc_callbacks.py']) await api.writeFile(`${base}/${n}`, await api.readFile(`${td}/${n}`, 'utf8'));
  } catch { /* im Browser-Modus nicht vorhanden */ }
  toast(`Export fertig: ${projectors.length} Projektor(en) → ${base}`);
  api.showItem(`${base}/kalibrierung.json`);
}

// ------------------------------------------------------------------ Kleinkram
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function clearPoints() {
  const p = active();
  if (!p.points.length) return;
  pushUndo();
  p.points = [];
  p.solution = null;
  S.activePointId = null;
  S.results[p.id] = {};
  markDirty();
  refresh();
  toast('Alle Punkte gelöscht. Mit Strg/Cmd+Z rückgängig.');
}

// ------------------------------------------------------------------ Einführung
const ACC = 'var(--accent)';
const ART = {
  welcome: `<svg width="220" height="120" viewBox="0 0 220 120" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 70 Q60 6 110 30 Q160 6 206 70" stroke="currentColor" stroke-width="2" opacity=".55"/>
    <path d="M40 70 Q75 34 110 46 Q145 34 180 70" stroke="currentColor" stroke-width="1.5" opacity=".35"/>
    <path d="M110 30 V46" stroke="currentColor" stroke-width="1.5" opacity=".35"/>
    <path d="M62 112 L30 56 M62 112 L96 40" stroke="#e5645c" stroke-width="1.5"/><path d="M30 56 Q60 30 96 40" stroke="#e5645c" stroke-width="2" opacity=".6"/>
    <path d="M158 112 L124 40 M158 112 L190 56" stroke="#4b9ddb" stroke-width="1.5"/><path d="M124 40 Q160 30 190 56" stroke="#4b9ddb" stroke-width="2" opacity=".6"/>
    <path d="M110 112 L86 44 M110 112 L134 44" stroke="#5bb37b" stroke-width="1.5" opacity=".9"/>
    <circle cx="62" cy="112" r="5" fill="#e5645c"/><circle cx="110" cy="112" r="5" fill="#5bb37b"/><circle cx="158" cy="112" r="5" fill="#4b9ddb"/>
  </svg>`,
  pick: `<svg viewBox="0 0 160 120" width="100%" height="100%" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 98 Q80 10 142 98" stroke="#8e8e93" stroke-width="2"/><path d="M48 98 Q80 50 112 98" stroke="#8e8e93" stroke-width="1.5" opacity=".6"/>
    <path d="M18 98 H142" stroke="#8e8e93" stroke-width="1.5" opacity=".5"/>
    <circle cx="80" cy="54" r="11" stroke="${ACC}" stroke-width="1.5" opacity=".45"/><circle cx="80" cy="54" r="4.5" fill="${ACC}"/>
    <path d="M88 61 l16 6.5 -6.1 1.6 -1.6 6.1z" fill="#fff" stroke="#111" stroke-width="1.2"/>
  </svg>`,
  move: `<svg viewBox="0 0 160 120" width="100%" height="100%" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <rect x="16" y="18" width="128" height="80" rx="3" stroke="#8e8e93" stroke-width="1.5" opacity=".6"/>
    <path d="M30 98 Q80 30 130 98" stroke="#8e8e93" stroke-width="1.5" opacity=".45"/>
    <g opacity=".45" stroke="${ACC}" stroke-width="1.5"><circle cx="50" cy="44" r="7"/><path d="M50 32v6M50 50v6M38 44h6M56 44h6"/></g>
    <path d="M60 50 Q70 58 74 60" stroke="${ACC}" stroke-width="1.5" stroke-dasharray="3 3"/><path d="M70 63 l5 -2 -1 -5" stroke="${ACC}" stroke-width="1.5"/>
    <g stroke="${ACC}" stroke-width="2"><circle cx="80" cy="64" r="7"/><path d="M80 52v6M80 70v6M68 64h6M86 64h6"/></g>
  </svg>`,
  check: `<svg viewBox="0 0 160 120" width="100%" height="100%" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 70 Q80 4 142 70" stroke="#8e8e93" stroke-width="2"/>
    <path d="M80 112 L30 52 M80 112 L130 52" stroke="#e5645c" stroke-width="1.5"/><path d="M30 52 Q80 8 130 52" stroke="#e5645c" stroke-width="2.5" opacity=".7"/>
    <circle cx="80" cy="112" r="5" fill="#e5645c"/>
    <circle cx="128" cy="96" r="12" fill="#32c766"/><path d="M122 96 l4 4 8 -8" stroke="#fff" stroke-width="2"/>
  </svg>`,
};

let obPage = 0;
const OB_PAGES = 3;
function onboardingSeen() { try { return localStorage.getItem('kalib.onboarded') === '1'; } catch { return false; } }
function showOnboarding(page = 0) {
  obPage = page;
  $('#onboarding').classList.remove('hidden');
  renderOnboarding();
}
function closeOnboarding(start = false) {
  $('#onboarding').classList.add('hidden');
  if (!S.model) loadDemo();
  try { localStorage.setItem('kalib.onboarded', '1'); } catch { /* egal */ }
  if (start) { S.activeId = S.project.projectors[0].id; S.activePointId = null; setMode('calibrate'); }
}
function feat(iconName, title, text) {
  return el('div', { class: 'feat' }, el('div', { class: 'fi', html: icon(iconName, 20) }), el('b', {}, title), el('span', {}, text));
}
function renderOnboarding() {
  const pages = [
    () => [
      el('div', { class: 'hero', html: ART.welcome }),
      el('h1', { id: 'obTitle' }, 'Willkommen'),
      el('p', { class: 'lead' }, 'Richte deine Projektoren am 3D-Modell aus, blende sie weich ineinander und gib das Ergebnis direkt aus.'),
      feat('monitor', 'Einrichten', 'Modell laden und festlegen, welcher Bildschirm welche Projektoren speist.'),
      feat('target', 'Kalibrieren', 'Pro Projektor ein paar Ecken im Modell anklicken und auf der echten Decke treffen.'),
      feat('blend', 'Überblenden', 'Überlappungen, Bogenseiten und Helligkeit werden automatisch ausgeglichen.'),
      feat('projector', 'Ausgabe', 'Testbilder auf den Projektoren zeigen oder an TouchDesigner übergeben.'),
    ],
    () => [
      el('h1', { id: 'obTitle', style: 'margin-top:8px' }, 'Womit möchtest du starten?'),
      el('p', { class: 'lead' }, 'Die Demo ist eine Gewölbedecke mit acht Projektoren, gut zum Ausprobieren. Alles lässt sich später unter „Einrichten“ ändern.'),
      el('div', { class: 'choices' },
        el('button', { class: `choice ${S.model && isDemo() ? 'on' : ''}`, id: 'obDemo', onclick: async () => { if (!(S.model && isDemo())) await loadDemo(); renderOnboarding(); } },
          el('div', { class: 'ci', html: icon('model', 26) }), el('b', {}, 'Mit der Demo'), el('span', {}, 'Gewölbedecke, 8 Projektoren')),
        el('button', { class: `choice ${S.model && !isDemo() ? 'on' : ''}`, id: 'obOwn', onclick: async () => { await chooseModel(); renderOnboarding(); } },
          el('div', { class: 'ci', html: icon('file', 26) }), el('b', {}, 'Eigenes 3D-Modell'), el('span', {}, S.model && !isDemo() ? S.project.model.name : 'OBJ-Datei wählen …'))),
      el('div', { style: 'height:14px' }),
      el('div', { class: 'group' }, ...outputRows()),
      el('p', { class: 'hint', style: 'text-align:center;margin-top:8px' }, 'Projektor 1–4 hängen an HDMI A, Projektor 5–8 an HDMI B, jeweils ein Viertel des Bildes.'),
    ],
    () => [
      el('h1', { id: 'obTitle', style: 'margin-top:8px' }, 'So setzt du einen Punkt'),
      el('p', { class: 'lead' }, 'Vier Punkte pro Projektor reichen für eine erste Lösung. Sechs gut verteilte sind ideal.'),
      el('div', { class: 'how' },
        el('div', {}, el('div', { class: 'pic', html: ART.pick }), el('b', {}, el('span', { class: 'n' }, '1'), 'Ecke anklicken'), el('span', {}, 'Eine markante Ecke im 3D-Modell anklicken.')),
        el('div', {}, el('div', { class: 'pic', html: ART.move }), el('b', {}, el('span', { class: 'n' }, '2'), 'Fadenkreuz schieben'), el('span', {}, 'Am Projektor dieselbe Ecke an der Decke treffen, mit Maus oder Pfeiltasten.')),
        el('div', {}, el('div', { class: 'pic', html: ART.check }), el('b', {}, el('span', { class: 'n' }, '3'), 'Prüfen'), el('span', {}, 'Ab vier Punkten erscheinen die Kanten. Wo es nicht passt, nachsetzen.'))),
    ],
  ];
  const last = obPage === OB_PAGES - 1;
  $('#onboarding').replaceChildren(el('div', { class: 'sheet' },
    el('div', { class: 'body' }, ...pages[obPage]()),
    el('div', { class: 'foot' },
      el('div', { class: 'dots' }, ...Array.from({ length: OB_PAGES }, (_, i) => el('i', { class: i === obPage ? 'on' : '' }))),
      !last ? el('button', { class: 'btn', style: 'background:none;box-shadow:none', onclick: () => closeOnboarding(false), id: 'obSkip' }, 'Überspringen') : null,
      obPage > 0 ? el('button', { class: 'btn', onclick: () => { obPage--; renderOnboarding(); } }, 'Zurück') : null,
      el('button', { class: 'btn primary', id: 'obNext', disabled: obPage === 1 && !S.model, onclick: () => { if (last) closeOnboarding(true); else { obPage++; renderOnboarding(); } } }, last ? `Mit ${displayName(S.project.projectors[0])} beginnen` : 'Weiter'))));
  $('#obNext').focus();
}

// ------------------------------------------------------------------ Hilfe-Menü
function toggleHelp() {
  const m = $('#helpMenu');
  if (!m.classList.contains('hidden')) return m.classList.add('hidden');
  const keys = [[['Klick'], 'Punkt im Modell setzen'], [['←', '→', '↑', '↓'], 'Fadenkreuz verschieben'], [['⇧'], 'mit Pfeil: 10 Pixel'], [['Tab'], 'Nächster Punkt'], [['Entf'], 'Punkt löschen'], [['1', '–', '8'], 'Projektor wählen'], [['Esc'], 'Auswahl aufheben'], [[api.platform === 'darwin' ? '⌘' : 'Strg', 'Z'], 'Rückgängig']];
  m.replaceChildren(
    el('button', { role: 'menuitem', onclick: () => { m.classList.add('hidden'); showOnboarding(0); } }, ic('book'), 'Einführung anzeigen'),
    el('button', { role: 'menuitem', onclick: () => { m.classList.add('hidden'); chooseModel(); } }, ic('model'), '3D-Modell laden …'),
    el('hr'),
    el('div', { class: 'ttl' }, 'Tastenkürzel'),
    el('div', { class: 'keys' }, ...keys.flatMap(([k, t]) => [el('span', { class: 'k' }, ...k.map((x) => (x === '–' ? el('span', {}, '–') : el('kbd', {}, x)))), el('span', {}, t)])));
  m.classList.remove('hidden');
  const b = $('#btnHelp').getBoundingClientRect();
  m.style.top = `${b.bottom + 6}px`;
  m.style.left = `${Math.min(b.left, innerWidth - m.offsetWidth - 8)}px`;
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#helpMenu, #btnHelp')) $('#helpMenu').classList.add('hidden');
});

// ------------------------------------------------------------------ Verdrahtung
$('#btnOpen').onclick = () => openProject();
$('#btnSave').onclick = () => save();
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnHelp').onclick = toggleHelp;
$('#btnOutputs').onclick = () => toggleOutputs();
$('#btnFocus').onclick = () => view.focus();
document.querySelectorAll('#modes button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
document.querySelectorAll('#viewMode button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#viewMode button').forEach((x) => x.classList.toggle('on', x === b));
    view.setViewMode(b.dataset.view);
  };
});
function toolToggle(id, get, set) {
  const b = $(id);
  b.onclick = () => { set(!get()); b.classList.toggle('on', get()); b.setAttribute('aria-pressed', String(get())); refresh(); };
}
toolToggle('#tglCoverage', () => view.showCoverage, (v) => { view.showCoverage = v; });
toolToggle('#tglFrustums', () => view.showFrustums, (v) => { view.showFrustums = v; });
toolToggle('#tglSnap', () => view.snap, (v) => { view.snap = v; });

// Tooltips (ersetzen lange Hilfetexte): erscheinen nach kurzer Verzögerung
(function tooltips() {
  const tip = $('#tooltip');
  let timer, cur;
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t === cur) return;
    cur = t;
    clearTimeout(timer);
    tip.classList.remove('show');
    if (!t || !t.dataset.tip) return;
    timer = setTimeout(() => {
      tip.textContent = t.dataset.tip;
      const rc = t.getBoundingClientRect();
      tip.style.left = '0px'; tip.style.top = '0px';
      const w = tip.offsetWidth, h = tip.offsetHeight;
      const x = Math.min(Math.max(8, rc.left + rc.width / 2 - w / 2), innerWidth - w - 8);
      let y = rc.bottom + 8;
      if (y + h > innerHeight - 8) y = rc.top - h - 8;
      tip.style.left = `${x}px`; tip.style.top = `${y}px`;
      tip.classList.add('show');
    }, t.classList.contains('info') ? 150 : 600);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(timer); tip.classList.remove('show'); });
})();
document.body.classList.add(`platform-${api.platform}`);
try { const k = localStorage.getItem('kalib.knob'); if (k) document.documentElement.dataset.knob = k; } catch { /* egal */ }
hydrateIcons();

api.onMenu((cmd) => ({
  new: async () => { await applyProject(newProject()); loadDemo(); },
  open: () => openProject(),
  save: () => save(),
  saveAs: () => save(true),
  loadModel: chooseModel,
  export: exportTD,
  undo, redo,
  openOutputs: () => toggleOutputs(true),
  closeOutputs: () => toggleOutputs(false),
  onboarding: () => showOnboarding(0),
})[cmd]?.());

// Start: letzte Sitzung wiederherstellen, sonst Beispielmodell laden
(async function start() {
  let mode = 'calibrate';
  try { mode = localStorage.getItem('kalib.mode') || mode; } catch { /* egal */ }
  setMode(mode);
  S.displays = await api.listDisplays();
  // Bildschirme vorbelegen: die beiden größten Nicht-Hauptbildschirme für HDMI A/B
  const ext = S.displays.filter((d) => !d.primary).sort((a, b) => b.pixelSize.width - a.pixelSize.width);
  const { userData } = await api.paths();
  const auto = `${userData}/autosave.kalib.json`;
  let restored = false;
  if (await api.exists(auto)) {
    try {
      await applyProject(JSON.parse(await api.readFile(auto, 'utf8')));
      restored = !!S.model;
      if (restored) toast('Letzte Sitzung wiederhergestellt');
    } catch { /* ignorieren */ }
  }
  // Beim allerersten Start entscheidet die Einführung, ob mit der Demo begonnen wird.
  if (!restored && onboardingSeen()) await loadDemo();
  S.project.outputs.forEach((o, i) => {
    if (o.displayId == null || !S.displays.some((d) => d.id === o.displayId)) o.displayId = ext[i]?.id ?? null;
  });
  await syncOpenOutputs();
  refresh();
  if (!onboardingSeen()) showOnboarding(0);
  window.__app = { S, view, refresh, setVideo, setPlay, scheduleSolve, selectPoint, computeBlend, toggleOutputs, setMode, showOnboarding, closeOnboarding, ready: true };
})();
