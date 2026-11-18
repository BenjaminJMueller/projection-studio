// Hauptfenster: Zustand, Bedienlogik, Solver-Anbindung, Export.
import { buildModel } from '../shared/scene.js';
import { newProject, migrateProject, groupLabel, groupsOf, addProjector, addOutput, MAX_PROJECTORS, MAX_VIDEO_OUTPUTS, QUADRANT_NAMES, LAYOUTS, layoutOf, cellCount, cellName, arrangeOutput, quadrantRect } from '../shared/project.js';
import { LENS_PRESETS, PROJECTOR_DB, OFFSET_FORMATS, offsetToBelow, lensFor } from '../core/lenses.js';
import { projectPoint, suggestNextImageRegion } from '../core/solver.js';
import { exportProjector } from '../core/export.js';
import { View3D } from './view3d.js';
import { Preview } from './preview.js';
import { computeBlendMasks } from './blend.js';
import { makeBrowserStub } from './stub.js';
import { icon, hydrateIcons } from './icons.js';
import { fileUrl, targetTime, playState, totalDuration, locate, startOf, seekState } from '../shared/playback.js';
import { createTuning } from './tuning.js';
import { createCamcal } from './camcal.js';
import { peakingResponse } from '../shared/roomeq.js';
import { AudioEngine, MAX_SPEAKERS, SOURCE_CHANNELS, SAMPLE_RATES, BUFFER_SIZES, speakerAt } from './audio.js';
import { defaultWarp, resizeWarp, isIdentity, inverse, gridBase, touchDesignerShader, makeWarp, GRID_SIZES, minJacobian, setBezierHandle } from '../shared/warp.js';
import { visibleBezierHandles } from '../shared/warpdraw.js';
import { tr, setLang, getLang, locale, LANGS, translateDom } from '../shared/i18n.js';

const api = window.api || makeBrowserStub();
const $ = (s) => document.querySelector(s);
// Texte und diese Attribute laufen durch tr(): Deutsch bleibt unverändert, Englisch wird nachgeschlagen.
const TR_ATTRS = new Set(['data-tip', 'aria-label', 'title', 'placeholder']);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : TR_ATTRS.has(k) ? tr(v) : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(typeof k === 'string' ? tr(k) : String(k)));
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
  activePin: null,
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
      points: [
        ...p.points.filter((x) => x.world && x.image).map((x) => ({ id: x.id, world: x.world, image: x.image, enabled: x.enabled })),
        ...(p.autoPoints || []).map((x, i) => ({ id: `K${i + 1}`, world: x.world, image: x.image, enabled: true })),
      ],
      width: p.resolution[0],
      height: p.resolution[1],
      lensId: p.lens,
      lens: lensFor(p, S.project),
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
  mouseToProjector();
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
    renderLegend();
    renderDocState();
    renderTransport();
    if (A().enabled) syncAudio();
    view.update(S.project, S.activeId, S.activePointId, S.pendingRepick, showSuggest() ? S.results[S.activeId]?.candidates : null);
    preview.mode = previewMode();
    preview.set(active(), S.activePointId, { activeHandle: S.activeHandle, activePin: S.activePin, suggest: showSuggest() ? S.results[S.activeId]?.suggest : null, activeMaskId: S.activeMaskId, blendImg: blendImgFor(S.activeId) });
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

const nf = (n, d = 1, group = false) => Number(n).toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: group });
const QUAD_SHORT = ['oben links', 'oben rechts', 'unten links', 'unten rechts'];
const indexOf = (p) => S.project.projectors.indexOf(p);
const displayName = (p) => (/^P\d+$/.test(p.name) ? tr(`Projektor ${p.name.slice(1)}`) : p.name);
const enabledPoints = (p) => p.points.filter((x) => x.enabled && x.world && x.image).length + (p.autoPoints?.length || 0);
const QUALITY_TEXT = { 'sehr gut': 'Sitzt sehr gut', gut: 'Sitzt gut', 'vorläufig': 'Erste Lösung', unsicher: 'Noch unsicher' };
const isGood = (q) => q === 'sehr gut' || q === 'gut';

function outputLabel(p) {
  const o = S.project.outputs.find((x) => x.id === p.output);
  if (!o) return 'Kein Ausgang';
  return cellCount(o) > 1 ? `${o.name} · ${cellName(o, p.quadrant % cellCount(o))}` : o.name;
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
  return el('div', { class: `proj-row ${p.id === S.activeId ? 'active' : ''} ${p.enabled ? '' : 'disabled'}`, onclick: () => selectProjector(p.id), role: 'button', tabindex: 0, 'aria-label': displayName(p),
    draggable: 'true', ondragstart: (e) => { S.dragProj = p.id; e.dataTransfer.setData('text/x-projector', p.id); e.dataTransfer.effectAllowed = 'move'; }, ondragend: () => { S.dragProj = null; document.querySelectorAll('.proj-group.drop').forEach((x) => x.classList.remove('drop')); } },
    el('span', { class: 'badge', style: `background:${p.color}` }, String(i + 1)),
    el('span', { class: 't' }, el('span', { class: 'name' }, displayName(p)), el('span', { class: 'sub' }, outputLabel(p))),
    el('span', { class: `st ${st.cls}`, 'data-tip': st.tip }, st.node));
}

function renderProjList() {
  const ps = S.project.projectors;
  S.project.groups = groupsOf(S.project);
  $('#projLists').replaceChildren(...S.project.groups.map((g) => {
    const members = ps.filter((p) => (p.ring || '') === g);
    const editing = S.editGroup === g;
    const label = editing
      ? el('input', { class: 'side-label-edit', value: groupLabel(g), 'aria-label': 'Gruppenname',
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { S.editGroup = null; refresh(); } e.stopPropagation(); },
        onblur: (e) => renameGroup(g, e.target.value) })
      : el('div', { class: 'side-label', ondblclick: () => { S.editGroup = g; refresh(); } },
        el('span', {}, groupLabel(g)),
        el('span', { class: 'acts' },
          iconBtn('edit', 'Gruppe umbenennen', () => { S.editGroup = g; refresh(); }),
          members.length ? null : iconBtn('close', 'Leere Gruppe entfernen', () => { S.project.groups = S.project.groups.filter((x) => x !== g); markDirty(); refresh(); })));
    return el('div', { class: 'proj-group', 'data-group': g,
      ondragover: (e) => { if (!S.dragProj) return; e.preventDefault(); e.currentTarget.classList.add('drop'); },
      ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop'); },
      ondrop: (e) => {
        e.preventDefault(); e.currentTarget.classList.remove('drop');
        const p = ps.find((x) => x.id === S.dragProj);
        S.dragProj = null;
        if (!p || (p.ring || '') === g) return;
        pushUndo(); p.ring = g; markDirty(); refresh();
        toast(`${displayName(p)} → ${groupLabel(g)}`);
      } },
      label,
      members.length ? el('div', { class: 'proj-list' }, ...members.map(projRow)) : el('div', { class: 'proj-empty' }, 'Projektoren hierher ziehen'));
  }));
  if (S.editGroup != null) requestAnimationFrame(() => { const i = document.querySelector('.side-label-edit'); if (i && document.activeElement !== i) { i.focus(); i.select(); } });
  const add = $('#btnAddProj');
  add.hidden = ps.length >= MAX_PROJECTORS;
  const on = ps.filter((p) => p.enabled);
  const done = on.filter((p) => p.solution && isGood(S.results[p.id]?.quality)).length;
  $('#overall').replaceChildren(el('div', {}, `${done} von ${on.length} kalibriert`), el('div', { class: 'progress' }, el('i', { style: `width:${on.length ? (100 * done) / on.length : 0}%` })));
}

function renderGroupKey(t) {
  const v = t.trim();
  return v === tr('Innenring') || v === 'Innenring' ? 'innen' : v === tr('Außenring') || v === 'Außenring' ? 'außen' : v;
}
function renameGroup(g, text) {
  S.editGroup = null;
  const k = renderGroupKey(text);
  if (!k || k === g) return refresh();
  if (S.project.groups.includes(k)) { toast('Diese Gruppe gibt es schon.'); return refresh(); }
  pushUndo();
  for (const p of S.project.projectors) if ((p.ring || '') === g) p.ring = k;
  S.project.groups = S.project.groups.map((x) => (x === g ? k : x));
  markDirty(); refresh();
}
function addGroup() {
  let n = 1;
  while (S.project.groups.includes(`${tr('Gruppe')} ${n}`)) n++;
  const g = `${tr('Gruppe')} ${n}`;
  S.project.groups.push(g);
  S.editGroup = g;
  markDirty(); refresh();
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
  $('#projectName').textContent = tr(S.project.name);
  $('#docState').textContent = tr(S.dirty ? (S.projectPath ? 'Bearbeitet' : 'Automatisch gesichert') : S.projectPath ? 'Gespeichert' : '');
}

// ---------- 1 Einrichten
function quadDiagram(o) {
  if (o.solo) {
    const p = active();
    return el('div', { class: 'quad', style: 'grid-template-columns:1fr' }, el('span', { style: `background:${p.color}` }, String(indexOf(p) + 1)));
  }
  const { rows, cols } = layoutOf(o);
  const ps = S.project.projectors.filter((p) => p.output === o.id);
  const n = rows * cols;
  const cells = Array.from({ length: n }, (_, q) => {
    const p = ps.find((x) => (n === 1 ? true : x.quadrant % n === q));
    return el('span', { style: p ? `background:${p.color}` : 'background:var(--bg-select)' }, p ? String(indexOf(p) + 1) : '');
  });
  return el('div', { class: 'quad', style: `grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)` }, ...cells);
}

/** Merkmal eines Bildschirms, das auch nach Neustart oder Umstecken gleich bleibt. */
const displayKey = (d) => d && `${d.label}|${d.pixelSize.width}x${d.pixelSize.height}`;

/** Bildschirm für einen Ausgang setzen. Hat ihn schon ein anderer Ausgang, werden die beiden getauscht. */
async function assignDisplay(o, displayId) {
  const old = o.displayId;
  const other = displayId != null ? S.project.outputs.find((x) => x !== o && x.displayId === displayId) : null;
  const wasOpen = S.openOutputs.size > 0;
  if (wasOpen) {
    if (old != null) await api.closeOutput(old);
    if (other && displayId != null) await api.closeOutput(displayId);
  }
  o.displayId = displayId;
  o.displayKey = displayKey(S.displays.find((d) => d.id === displayId)) || null;
  if (other) { other.displayId = old; other.displayKey = displayKey(S.displays.find((d) => d.id === old)) || null; }
  if (wasOpen) {
    if (o.displayId != null) await api.openOutput(o.displayId, o.id);
    if (other?.displayId != null) await api.openOutput(other.displayId, other.id);
    await syncOpenOutputs();
  }
  if (other) toast(`${o.name} und ${other.name} haben die Bildschirme getauscht.`);
  markDirty();
  refresh();
}

/** Nach dem An- oder Abstecken: Ausgänge über ihr Merkmal wiederfinden, fehlende schließen, zurückgekehrte öffnen. */
async function displaysChanged() {
  S.displays = await api.listDisplays();
  for (const o of S.project.outputs) {
    if (o.displayId != null && S.displays.some((d) => d.id === o.displayId)) continue;
    const again = o.displayKey && S.displays.find((d) => displayKey(d) === o.displayKey && !S.project.outputs.some((x) => x !== o && x.displayId === d.id));
    if (o.displayId != null && S.openOutputs.has(o.displayId)) await api.closeOutput(o.displayId);
    if (again) o.displayId = again.id;
  }
  if (S.outputsWanted) {
    for (const o of S.project.outputs) {
      if (o.displayId != null && S.displays.some((d) => d.id === o.displayId)) await api.openOutput(o.displayId, o.id);
    }
  }
  await syncOpenOutputs();
  refresh();
}

/** Maus auf die Mitte des gewählten Projektors setzen (Testausgang bevorzugt). */
function mouseToProjector() {
  if (!S.project.view.mouseFollow || !S.openOutputs.size) return;
  const p = active();
  const solo = S.project.outputs.find((o) => o.solo && o.displayId != null && S.openOutputs.has(o.displayId));
  const o = solo || S.project.outputs.find((x) => x.id === p.output && x.displayId != null && S.openOutputs.has(x.displayId));
  const d = o && S.displays.find((x) => x.id === o.displayId);
  if (!d) return;
  const rc = quadrantRect(o, p.quadrant);
  api.moveCursor(Math.round(d.bounds.x + (rc.x + rc.w / 2) * d.bounds.width), Math.round(d.bounds.y + (rc.y + rc.h / 2) * d.bounds.height));
}

/** „Projektor 1 bis 4“ bei durchgehender Folge, sonst „Projektoren 1, 3, 9“. */
function numberList(ns) {
  if (ns.length === 1) return `Projektor ${ns[0]}`;
  const contiguous = ns.every((n, i) => !i || n === ns[i - 1] + 1);
  return contiguous ? `Projektor ${ns[0]} bis ${ns[ns.length - 1]}` : `Projektoren ${ns.join(', ')}`;
}
function outputRows() {
  const opts = [['', 'Kein Bildschirm'], ...S.displays.map((d) => [d.id, `${d.label} · ${d.pixelSize.width} × ${d.pixelSize.height}`])];
  return S.project.outputs.map((o) => {
    const ps = S.project.projectors.filter((p) => p.output === o.id).map((p) => indexOf(p) + 1);
    const d = S.displays.find((x) => x.id === o.displayId);
    const L = layoutOf(o);
    // passt die Auflösung zur Aufteilung? (je Feld eine Projektorauflösung)
    const first = S.project.projectors.find((p) => p.output === o.id);
    const want = !o.solo && first ? [L.cols * first.resolution[0], L.rows * first.resolution[1]] : null;
    const mismatch = d && want && (d.pixelSize.width !== want[0] || d.pixelSize.height !== want[1]);
    const sub = o.solo ? 'zeigt den gewählten Projektor allein' : ps.length ? numberList(ps) : 'nicht belegt';
    return el('div', { class: 'r stack' },
      el('div', { class: 'lbl', style: 'gap:10px' }, quadDiagram(o),
        el('span', {}, o.name, el('span', { class: 'sub' }, sub),
          mismatch ? el('span', { class: 'sub', style: 'color:var(--warn)' }, `Bildschirm hat ${d.pixelSize.width} × ${d.pixelSize.height}, erwartet ${want[0]} × ${want[1]}`) : null),
        o.solo ? infoBtn('Zum Kalibrieren einen Projektor direkt anschließen, ohne Video-Wall-Controller. Dieser Ausgang zeigt immer den Projektor, der gerade links gewählt ist, im ganzen Bild.') : null),
      el('div', { class: 'ctl' },
        select(opts, o.displayId ?? '', (v) => assignDisplay(o, v ? Number(v) : null), { 'aria-label': `Bildschirm für ${o.name}` }),
        o.solo ? null : select(Object.entries(LAYOUTS).map(([k, x]) => [k, x.label]), o.layout, (v) => {
          pushUndo();
          o.layout = v;
          const over = arrangeOutput(S.project, o.id);
          markDirty(); refresh();
          toast(over ? `${LAYOUTS[v].label}: nur ${cellCount(o)} Felder für ${ps.length} Projektoren. Überzählige teilen sich ein Feld.` : `${o.name}: Projektoren auf ${LAYOUTS[v].label} verteilt.`);
        }, { style: 'width:132px;flex:none', 'aria-label': 'Aufteilung', 'data-tip': 'Modus des Video-Wall-Controllers, z. B. 2 × 2 beim LogiLink HD0054. Die Projektoren werden der Reihe nach auf die Felder verteilt.' })));
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
  const lens = lensFor(p, S.project);
  const o = S.project.outputs.find((x) => x.id === p.output);
  const set = (fn, solve = false) => { fn(); if (solve) scheduleSolve(p); markDirty(); refresh(); };
  put('#paneSetup', 
    gtitle('3D-Modell'),
    group(modelRow()),
    gtitle('Bildschirme', infoBtn('Jeder Ausgang der Grafikkarte wird in Viertel geteilt, jedes Viertel geht an einen Projektor.')),
    group(...outputRows(),
      S.project.outputs.filter((x) => !x.solo).length < MAX_VIDEO_OUTPUTS ? el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', { class: 'sub' }, 'Weiterer Grafikkarten-Ausgang')),
        el('div', { class: 'ctl' }, el('button', { class: 'btn', id: 'btnAddOutput', onclick: () => { const o = addOutput(S.project); if (o) { markDirty(); refresh(); toast(`${o.name} angelegt`); } } }, ic('plus', 14), 'Ausgang hinzufügen'))) : null,
      r('Maus springt mit', switchCtl(!!S.project.view.mouseFollow, (v) => { S.project.view.mouseFollow = v; markDirty(); refresh(); if (v) mouseToProjector(); }),
        { tip: 'Beim Wechsel des Projektors springt der Mauszeiger auf dessen Bild am Ausgang. So muss man die Maus auf den Projektionen nicht suchen.' })),
    gtitle(displayName(p)),
    group(
      r('Name', input(displayName(p), (v) => set(() => { p.name = v.trim() || `P${indexOf(p) + 1}`; }))),
      r('Verwenden', switchCtl(p.enabled, (v) => set(() => { p.enabled = v; }))),
      r('Gruppe', groupCtl(p, set), { tip: 'Überschrift in der Liste links, z. B. Innenring oder Wand Nord. Projektoren mit gleicher Gruppe stehen zusammen.' }),
      r('Ausgang', select([...S.project.outputs.filter((x) => !x.solo).map((x) => [x.id, x.name]), ['', 'Keiner']], p.output, (v) => set(() => { p.output = v; }))),
      o && cellCount(o) > 1 ? r('Bildbereich', select(Array.from({ length: cellCount(o) }, (_, i) => [i, cellName(o, i)]), p.quadrant % cellCount(o), (v) => set(() => { p.quadrant = Number(v); }))) : null,
      r('Auflösung', select(resolutionOptions(p), p.resolution.join('x'), (v) => {
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
      r('Projektor-Typ', typeSelect(p, (v) => {
        if (v === '__new') return newProjectorType(p);
        set(() => { p.lens = v; }, true);
      }), { tip: lens.note }),
      p.lens.startsWith('custom:') ? typeEditor(p) : null,
      r('Montage', select([['auto', 'Automatisch'], ['normal', 'Achse unter dem Bild'], ['flipped', 'Achse über dem Bild']], p.mountMode, (v) => set(() => { p.mountMode = v; }, true)),
        { tip: 'Kurzdistanz-Beamer projizieren komplett auf eine Seite der Objektivachse. Je nach Menü-Einstellung (Decke/Tisch) liegt sie über oder unter dem Bild. Automatisch prüft beides.' }),
    ),
    S.project.projectors.length > 1 ? el('div', { class: 'act' }, el('span', { class: 'hint' }, S.confirmRemove === p.id ? 'Punkte, Warp und Masken gehen verloren.' : ''),
      el('button', { class: `btn ${S.confirmRemove === p.id ? 'danger' : ''}`, id: 'btnRemoveProj', onclick: () => removeProjector(p) }, S.confirmRemove === p.id ? 'Wirklich entfernen' : 'Projektor entfernen …')) : null,
    more('setupAdv', 'TouchDesigner-Namen',
      group(
        r('Kamera', input(p.tdCamera, (v) => { p.tdCamera = v; markDirty(); }), { tip: 'Name des Camera COMP in TouchDesigner' }),
        r('Render', input(p.tdRender, (v) => { p.tdRender = v; markDirty(); }), { tip: 'Name des Render TOP, hinter den die Maske gehängt wird' }),
      )),
  );
}

const RESOLUTIONS = [[1920, 1080], [1920, 1200], [1280, 800], [1280, 720], [1024, 768], [3840, 2160]];
function resolutionOptions(p) {
  const list = RESOLUTIONS.map((r) => r.join('x'));
  const spec = specOf(p);
  if (spec && !list.includes(spec.native.join('x'))) list.unshift(spec.native.join('x'));
  if (!list.includes(p.resolution.join('x'))) list.unshift(p.resolution.join('x'));
  return list.map((k) => [k, `${k.replace('x', ' × ')}${spec && k === spec.native.join('x') ? ' (nativ)' : ''}`]);
}
function specOf(p) {
  if (p.lens.startsWith('db:')) return PROJECTOR_DB.find((x) => x.id === p.lens.slice(3));
  if (p.lens.startsWith('custom:')) return S.project.projectorTypes.find((x) => x.id === p.lens.slice(7));
  return null;
}
/** Auswahl: allgemeine Voreinstellungen, Datenbank nach Hersteller, eigene Typen. */
function typeSelect(p, onchange) {
  const og = (label, opts) => el('optgroup', { label: tr(label) }, ...opts.map(([v, l]) => el('option', { value: v, selected: v === p.lens }, l)));
  const makers = [...new Set(PROJECTOR_DB.map((x) => x.maker))];
  return el('select', { onchange: (e) => onchange(e.target.value), 'aria-label': 'Projektor-Typ' },
    og('Allgemein', LENS_PRESETS.map((l) => [l.id, l.name])),
    ...makers.map((m) => og(m, PROJECTOR_DB.filter((x) => x.maker === m).map((x) => [`db:${x.id}`, `${x.maker} ${x.model}`]))),
    og('Eigene', [...S.project.projectorTypes.map((x) => [`custom:${x.id}`, x.model || 'Eigener Typ']), ['__new', 'Neu aus Datenblatt …']]));
}
function newProjectorType(p) {
  const base = specOf(p);
  const t = {
    id: `t${Date.now().toString(36)}`, maker: '', model: 'Eigener Projektor',
    native: base ? [...base.native] : [...p.resolution], throw: base ? [...base.throw] : [1.2, 1.6], zoom: 'optisch',
    axis: { kind: 'fixed', below: 0 }, offsetFormat: 'full', offsetValue: '100', source: '',
  };
  S.project.projectorTypes.push(t);
  p.lens = `custom:${t.id}`;
  S.ui = { ...(S.ui || {}), typeEdit: true };
  scheduleSolve(p); markDirty(); refresh();
}
/** Datenblattwerte eines eigenen Typs. Gilt für alle Projektoren mit diesem Typ. */
function typeEditor(p) {
  const t = specOf(p);
  if (!t) return null;
  const users = S.project.projectors.filter((x) => x.lens === p.lens);
  const changed = () => { for (const x of users) scheduleSolve(x); markDirty(); refresh(); };
  const num = (v, fn, attrs = {}) => input(v, (x) => { if (Number.isFinite(x) && x > 0) { fn(x); changed(); } }, 'number', { step: 'any', ...attrs });
  const shift = t.axis.kind === 'shift';
  const pct = (x) => Math.round(x * 1000) / 10;
  return more('typeEdit', 'Datenblatt', group(
    r('Name', input(t.model, (v) => { t.model = v.trim() || 'Eigener Projektor'; markDirty(); refresh(); })),
    r('Native Auflösung', el('div', { class: 'pair' }, num(t.native[0], (x) => { t.native[0] = Math.round(x); }, { 'aria-label': 'Breite' }), el('span', {}, '×'), num(t.native[1], (x) => { t.native[1] = Math.round(x); }, { 'aria-label': 'Höhe' }))),
    r('Wurfverhältnis', el('div', { class: 'pair' }, num(t.throw[0], (x) => { t.throw[0] = x; t.throw[1] = Math.max(t.throw[1], x); }, { 'aria-label': 'von' }), el('span', {}, 'bis'), num(t.throw[1], (x) => { t.throw[1] = Math.max(x, t.throw[0]); }, { 'aria-label': 'bis' })),
      { tip: 'Abstand geteilt durch Bildbreite, wie im Datenblatt (Wide bis Tele). Bei festem Objektiv beide Werte gleich.' }),
    r('Zoom', select([['optisch', 'Optisch'], ['digital', 'Digital'], ['fest', 'Kein Zoom']], t.zoom, (v) => { t.zoom = v; changed(); })),
    r('Objektivachse', select([['fixed', 'Fester Offset'], ['shift', 'Lens Shift']], t.axis.kind, (v) => {
      t.axis = v === 'shift' ? { kind: 'shift', v: [-0.5, 0.5], h: [-0.1, 0.1] } : { kind: 'fixed', below: offsetToBelow(t.offsetFormat || 'full', t.offsetValue || '100') || 0 };
      changed();
    }), { tip: 'Fester Offset: Beamer ohne Lens Shift, das Bild liegt immer gleich zur Objektivachse. Lens Shift: Bild lässt sich verschieben, dann den Bereich aus dem Datenblatt eintragen.' }),
    shift ? [
      r('Shift vertikal', el('div', { class: 'pair' }, num(pct(t.axis.v[0]) || 0.0001, (x) => { t.axis.v[0] = -Math.abs(x) / 100; }, { 'aria-label': 'nach unten, Prozent' }), el('span', {}, '% bis +'),
        num(pct(t.axis.v[1]) || 0.0001, (x) => { t.axis.v[1] = x / 100; }, { 'aria-label': 'nach oben, Prozent' }), el('span', {}, '%')),
        { tip: 'Verschiebung der Bildmitte in Prozent der Bildhöhe, nach unten und nach oben. Bei ±50 % beide Felder 50.' }),
      r('Shift horizontal', el('div', { class: 'pair' }, el('span', {}, '±'), num(pct(t.axis.h[1]) || 0.0001, (x) => { t.axis.h = [-x / 100, x / 100]; }, { 'aria-label': 'Prozent' }), el('span', {}, '%'))),
    ] : [
      r('Offset-Angabe', select(OFFSET_FORMATS, t.offsetFormat || 'full', (v) => { t.offsetFormat = v; t.offsetValue = v === 'ratio' ? '10:-1' : v === 'half' ? '100' : '100'; t.axis.below = offsetToBelow(v, t.offsetValue); changed(); }),
        { tip: 'Hersteller geben den Offset unterschiedlich an. 100 % volle Bildhöhe bzw. 0 % halbe Bildhöhe heißt: Achse an der Bildunterkante.' }),
      r('Offset', input(t.offsetValue ?? '100', (v) => { const b = offsetToBelow(t.offsetFormat || 'full', v); if (Number.isFinite(b)) { t.offsetValue = v; t.axis.below = b; changed(); } else toast('Offset nicht lesbar'); }, 'text', { 'aria-label': 'Offset' }),
        { sub: `Achse ${t.axis.below >= 0 ? `${nf(t.axis.below * 100, 0)} % der Bildhöhe unter dem Bild` : `${nf(-t.axis.below * 100, 0)} % über der Bildunterkante`}` }),
    ],
    r('Quelle', input(t.source || '', (v) => { t.source = v; markDirty(); }, 'text', { placeholder: 'z. B. Link zum Datenblatt' })),
  ));
}

/** Gruppe wählen oder neu benennen: Liste der vorhandenen plus freie Eingabe. */
function groupCtl(p, set) {
  const groups = [...new Set(S.project.projectors.map((x) => x.ring || ''))];
  const id = 'groupNames';
  return el('span', { style: 'display:contents' },
    input(groupLabel(p.ring), (v) => set(() => {
      const t = v.trim();
      p.ring = t === tr('Innenring') || t === 'Innenring' ? 'innen' : t === tr('Außenring') || t === 'Außenring' ? 'außen' : t;
    }), 'text', { list: id, 'aria-label': 'Gruppe' }),
    el('datalist', { id }, ...groups.map((g) => el('option', { value: groupLabel(g) }))));
}

function removeProjector(p) {
  if (S.confirmRemove !== p.id) {
    S.confirmRemove = p.id;
    refresh();
    setTimeout(() => { if (S.confirmRemove === p.id) { S.confirmRemove = null; refresh(); } }, 4000);
    return;
  }
  S.confirmRemove = null;
  const ps = S.project.projectors;
  const i = ps.indexOf(p);
  ps.splice(i, 1);
  delete S.results[p.id];
  delete S.blendImages[p.id];
  undoStack.length = redoStack.length = 0; // Schnappschüsse beziehen sich auf die alte Liste
  S.activeId = ps[Math.min(i, ps.length - 1)].id;
  S.activePointId = null;
  markDirty();
  refresh();
  toast(`${displayName(p)} entfernt`);
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
    sub = 'Ab 4 Punkten gibt es eine Lösung.';
  }
  const notes = (res.warnings || []).filter((w) => !(w.level === 'info' && /^Vorläufig/.test(w.text)));
  return el('div', { class: `status ${cls}` },
    el('div', { class: 'head' }, el('div', { class: 'ic-wrap' }, mark), el('div', {}, el('b', {}, head), el('span', {}, sub))),
    el('div', { class: 'steps', 'aria-hidden': 'true' }, ...Array.from({ length: 6 }, (_, i) => el('i', { class: i < n ? 'done' : '' }))),
    notes.length ? el('div', { class: 'notes' }, ...notes.map((w) => el('div', {}, w.level === 'warn' ? ic('alert', 14) : null, el('span', {}, w.text), w.detail ? infoBtn(w.detail) : null))) : null);
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
    ...[['points', 'Punkte'], ['warp', 'Feinkorrektur']].map(([k, l]) => el('button', { class: S.calTab === k ? 'on' : '', role: 'tab', 'data-cal': k, onclick: () => { S.calTab = k; if (k === 'warp') ensureWarp(p); refresh(); } }, l)));
  if (S.calTab === 'warp') return put('#paneCalibrate', tabs, warpPane(p));
  put('#paneCalibrate', tabs,
    statusCard(p),
    gtitle('Punkte',
      iconBtn('target', 'Gewählten Punkt im Modell neu setzen', () => { S.pendingRepick = !S.pendingRepick; refresh(); }, { disabled: !activePoint(), on: S.pendingRepick, id: 'btnRepick' }),
      iconBtn('trash', 'Gewählten Punkt löschen (Entf)', deleteActivePoint, { disabled: !activePoint(), id: 'btnDeletePoint' })),
    rows.length ? el('div', { class: 'group plist' }, ...rows) : group(el('div', { class: 'empty-note' }, p.autoPoints?.length ? 'Die Kamera-Punkte werden verwendet. Punkte von Hand sind optional.' : 'Klicke im 3D-Modell auf eine Ecke, um den ersten Punkt zu setzen.')),
    p.points.length ? el('div', { style: 'padding:6px 4px 0' }, el('button', { class: 'link danger', id: 'btnClearPoints', onclick: clearPoints }, 'Alle Punkte löschen')) : null,
    ...cameraGroup(p),
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

function ensureWarp(p) {
  p.warp ||= defaultWarp(5, 5, p.resolution[0] / p.resolution[1]);
  p.warp.pins ||= [];
  p.warp.radius ??= 0.25;
  p.warp.aspect ??= p.resolution[0] / p.resolution[1];
  return p.warp;
}
const selectWarp = (handle, pin) => { S.activeHandle = handle; S.activePin = pin; };

/** Gitterpunkt i so verschieben, dass er sichtbar bei (tu, tv) liegt (freie Punkte wirken mit). */
function placeHandle(w, i, tu, tv) {
  const [bu, bv] = gridBase(w, i);
  for (let k = 0; k < 3; k++) {
    const [fu, fv] = makeWarp(w).forward(bu, bv);
    w.offsets[i] = [w.offsets[i][0] + tu - fu, w.offsets[i][1] + tv - fv];
  }
}

function onWarpPointer(uv, phase) {
  const p = active();
  const w = ensureWarp(p);
  const [W, H] = p.resolution;
  const nu = uv[0] / W, nv = uv[1] / H;
  if (phase === 'context') {
    // Rechtsklick: freien Punkt löschen bzw. Gitterpunkt zurücksetzen
    const ev = makeWarp(w);
    const reach = Math.min(0.035, 0.45 / (Math.max(w.cols, w.rows) - 1));
    const dist = (u, v) => Math.hypot((u - nu) * W / H, v - nv);
    let pin = -1, grid = -1, bd = reach;
    w.pins.forEach((q, i) => { const d = dist(q.at[0] + q.off[0], q.at[1] + q.off[1]); if (d < bd) { bd = d; pin = i; } });
    if (pin < 0) w.offsets.forEach((o, i) => { if (Math.hypot(o[0], o[1]) < 1e-6) return; const [bu, bv] = gridBase(w, i); const f = ev.forward(bu, bv); const d = dist(f[0], f[1]); if (d < bd) { bd = d; grid = i; } });
    if (pin >= 0) { S.activePin = pin; removeActivePin(p); toast('Punkt entfernt'); }
    else if (grid >= 0) { pushUndo(); w.offsets[grid] = [0, 0]; selectWarp(null, null); markDirty(); refresh(); toast('Gitterpunkt zurückgesetzt'); }
    return;
  }
  if (phase === 'down') {
    const ev = makeWarp(w);
    const reach = Math.min(0.035, 0.45 / (Math.max(w.cols, w.rows) - 1));
    const dist = (u, v) => Math.hypot((u - nu) * W / H, v - nv);
    let hit = null, bd = reach;
    if (w.bezier && S.activeHandle != null && w.offsets[S.activeHandle]) {
      const h = visibleBezierHandles(w, S.activeHandle, ev);
      for (const k of ['right', 'left', 'down', 'up']) { const d = dist(h[k][0], h[k][1]); if (d < bd) { bd = d; hit = { kind: 'tan', i: S.activeHandle, which: k, pos: h[k], shift: [h.node[0] - w.offsets[S.activeHandle][0] - gridBase(w, S.activeHandle)[0], h.node[1] - w.offsets[S.activeHandle][1] - gridBase(w, S.activeHandle)[1]] }; } }
    }
    if (!hit) w.pins.forEach((pin, i) => { const d = dist(pin.at[0] + pin.off[0], pin.at[1] + pin.off[1]); if (d < bd) { bd = d; hit = { kind: 'pin', i, pos: [pin.at[0] + pin.off[0], pin.at[1] + pin.off[1]] }; } });
    if (!hit) {
      w.offsets.forEach((_, i) => { const [bu, bv] = gridBase(w, i); const f = ev.forward(bu, bv); const d = dist(f[0], f[1]); if (d < bd) { bd = d; hit = { kind: 'grid', i, pos: f }; } });
    }
    pushUndo();
    if (!hit) {
      // freier Punkt: hält den Bildinhalt an dieser Stelle fest, bis er gezogen wird
      if (w.pins.length >= 200) { toast('Höchstens 200 freie Punkte.'); return; }
      const at = ev.inverse(nu, nv);
      w.pins.push({ at, off: [nu - at[0], nv - at[1]] });
      hit = { kind: 'pin', i: w.pins.length - 1, pos: [nu, nv] };
      markDirty();
    }
    if (hit.kind === 'pin') selectWarp(null, hit.i); else selectWarp(hit.i, null);
    S.warpDrag = { kind: hit.kind, i: hit.i, which: hit.which, shift: hit.shift, grab: [hit.pos[0] - nu, hit.pos[1] - nv] };
    return refresh(true);
  }
  const d = S.warpDrag;
  if (d && (phase === 'move' || phase === 'up')) {
    const tu = nu + d.grab[0], tv = nv + d.grab[1];
    if (d.kind === 'pin') { const pin = w.pins[d.i]; pin.off = [tu - pin.at[0], tv - pin.at[1]]; }
    else if (d.kind === 'tan') setBezierHandle(w, d.i, d.which, tu - d.shift[0], tv - d.shift[1]);
    else placeHandle(w, d.i, tu, tv);
    if (phase === 'up') { S.warpDrag = null; markDirty(); }
    refresh(true);
  }
}

function moveWarpSelection(p, dx, dy) {
  const w = ensureWarp(p);
  if (S.activePin != null && w.pins[S.activePin]) { const o = w.pins[S.activePin].off; o[0] += dx; o[1] += dy; return true; }
  if (S.activeHandle != null) {
    const [bu, bv] = gridBase(w, S.activeHandle);
    const [fu, fv] = makeWarp(w).forward(bu, bv);
    placeHandle(w, S.activeHandle, fu + dx, fv + dy);
    return true;
  }
  return false;
}

function removeActivePin(p) {
  const w = p.warp;
  if (!w || S.activePin == null || !w.pins[S.activePin]) return false;
  pushUndo();
  w.pins.splice(S.activePin, 1);
  selectWarp(null, null);
  markDirty(); refresh();
  return true;
}

function warpPane(p) {
  const w = ensureWarp(p);
  const [W, H] = p.resolution;
  const ev = makeWarp(w);
  const gridChanged = w.offsets.filter(([a, b]) => Math.hypot(a, b) > 1e-6).length;
  const pinCount = w.pins.length;
  let selText = 'keiner';
  if (S.activePin != null && w.pins[S.activePin]) { const o = w.pins[S.activePin].off; selText = `Freier Punkt · ${nf(o[0] * W, 1)} / ${nf(o[1] * H, 1)} px`; }
  else if (S.activeHandle != null && w.offsets[S.activeHandle]) {
    const [bu, bv] = gridBase(w, S.activeHandle); const [fu, fv] = ev.forward(bu, bv);
    selText = `Gitter · ${nf((fu - bu) * W, 1)} / ${nf((fv - bv) * H, 1)} px`;
  }
  const sizes = GRID_SIZES.map((n) => [String(n), String(n)]);
  const resize = (c, r) => { pushUndo(); p.warp = resizeWarp(w, c, r); selectWarp(null, null); markDirty(); refresh(); };
  const head = !gridChanged && !pinCount ? 'Keine Feinkorrektur'
    : [gridChanged ? `${gridChanged} ${gridChanged === 1 ? 'Gitterpunkt' : 'Gitterpunkte'}` : null, pinCount ? `${pinCount} ${pinCount === 1 ? 'freier Punkt' : 'freie Punkte'}` : null].filter(Boolean).join(', ');
  const folds = (gridChanged || pinCount) && minJacobian(w) < 0.05;
  return [
    folds ? el('div', { class: 'status bad' }, el('div', { class: 'head' }, el('div', { class: 'ic-wrap', html: icon('alert', 16) }),
      el('div', {}, el('b', {}, 'Das Bild faltet sich'), el('span', {}, 'Punkt zurücknehmen oder Reichweite erhöhen.')),
      infoBtn('An einer Stelle ist die Korrektur so stark, dass sich das Bild überschlägt.'))) : null,
    el('div', { class: `status ${gridChanged || pinCount ? 'ok' : ''}` },
      el('div', { class: 'head' }, el('div', { class: 'ic-wrap', html: icon('target', 16) }),
        el('div', {}, el('b', {}, head),
          el('span', {}, 'Ziehen oder ins Bild klicken. Rechtsklick entfernt.')),
        infoBtn('Gitterpunkte ziehen oder irgendwo ins Bild klicken, um einen freien Punkt zu setzen. Pfeiltasten: 1 Pixel, mit ⇧ 10 Pixel. Rechtsklick oder Entf entfernt einen freien Punkt bzw. setzt einen Gitterpunkt zurück.'))),
    gtitle('Gitter'),
    group(
      r('Spalten × Zeilen', el('div', { style: 'display:flex;gap:6px;align-items:center' },
        select(sizes, String(w.cols), (v) => resize(Number(v), w.rows), { style: 'width:64px', 'aria-label': 'Spalten' }),
        el('span', { class: 'muted' }, '×'),
        select(sizes, String(w.rows), (v) => resize(w.cols, Number(v)), { style: 'width:64px', 'aria-label': 'Zeilen' })),
        { tip: 'Mehr Punkte erlauben feinere, örtlich begrenzte Korrekturen. Beim Wechsel bleibt die Form erhalten. 2 × 2 verschiebt nur die Ecken.' }),
      r('Bézier-Anfasser', switchCtl(!!w.bezier, (v) => { pushUndo(); w.bezier = v; markDirty(); refresh(); }),
        { tip: 'Zeigt am gewählten Gitterpunkt Anfasser, mit denen sich die Linien zwischen den Punkten biegen lassen. Ausgeschaltet verlaufen sie automatisch weich.' }),
      w.bezier && S.activeHandle != null ? el('div', { class: 'act', style: 'padding:6px 12px' },
        el('button', { class: 'link', onclick: () => { pushUndo(); if (w.tangents?.[S.activeHandle]) w.tangents[S.activeHandle] = [0, 0, 0, 0]; markDirty(); refresh(); } }, 'Anfasser zurücksetzen')) : null,
    ),
    gtitle('Freie Punkte'),
    group(
      pinCount ? el('div', { class: 'pin-list' }, w.pins.map((pin, i) => el('div', { class: `pin-row ${S.activePin === i ? 'on' : ''}` },
        el('button', { class: 'pin-sel', onclick: () => { selectWarp(null, i); refresh(); } },
          el('span', { class: 'pin-dot' }), `Punkt ${i + 1}`,
          el('span', { class: 'muted' }, `${nf(pin.off[0] * W, 0)} / ${nf(pin.off[1] * H, 0)} px`)),
        iconBtn('close', 'Punkt entfernen', () => { S.activePin = i; removeActivePin(p); })))) 
        : r('Gesetzt', el('span', { class: 'muted' }, 'keine'), { sub: 'Ins Bild klicken, um einen zu setzen.' }),
      r('Reichweite', rangeCtl(Math.round(w.radius * 100), 5, 80, 1, (v) => `${v} %`, null, (v) => { pushUndo(); w.radius = v / 100; markDirty(); refresh(); }),
        { tip: 'Wie weit ein freier Punkt das Bild um sich herum mitzieht, in Prozent der Bildhöhe. Kleiner Wert: sehr örtlich.' }),
    ),
    group(
      r('Ausgewählt', el('span', { class: 'muted' }, selText)),
      r('Testbild', el('button', { class: 'btn', onclick: () => { S.project.view.outputMode = 'grid'; markDirty(); if (!S.openOutputs.size) toggleOutputs(true); refresh(); } }, 'Raster auf Projektoren')),
    ),
    el('div', { class: 'act' },
      S.activePin != null
        ? el('button', { class: 'link danger', onclick: () => removeActivePin(p) }, 'Punkt entfernen')
        : el('button', { class: 'link danger', disabled: S.activeHandle == null, onclick: () => { pushUndo(); w.offsets[S.activeHandle] = [0, 0]; markDirty(); refresh(); } }, 'Punkt zurücksetzen'),
      el('button', { class: 'link danger', disabled: !gridChanged && !pinCount, onclick: () => { pushUndo(); p.warp = defaultWarp(w.cols, w.rows, w.aspect); selectWarp(null, null); markDirty(); refresh(); toast('Feinkorrektur zurückgesetzt. Mit Strg/Cmd+Z rückgängig.'); } }, 'Alles zurücksetzen')),
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
  if (!S.model) return coach('!', 'Kein 3D-Modell', 'Unter „Einrichten“ laden.');
  if (S.mode === 'blend') {
    const m = p.masks.find((x) => x.id === S.activeMaskId);
    if (m && !m.closed) return coach(String(m.points.length), 'Maske zeichnen', 'Rechts Ecken setzen, ersten Punkt anklicken zum Schließen.');
    if (!Object.keys(S.blendImages).length) return coach('3', 'Masken berechnen', 'Rechts, sobald alles kalibriert ist.');
    return g.replaceChildren();
  }
  if (S.mode !== 'calibrate' || warpEditing()) return g.replaceChildren();
  if (S.pickCenter) return coach(ic('focus', 16), 'Bildmitte wählen', `Ungefähr die Bildmitte von ${name} anklicken.`);
  if (S.pendingRepick) return coach(String(S.activePointId), `Punkt ${S.activePointId} neu setzen`, 'Die richtige Stelle im Modell anklicken.');
  if (n === 0 && !activePoint()) return coach('1', 'Ecke im Modell anklicken', `Weit außen im Bild von ${name}.`);
  if (activePoint() && !p.solution) return coach(String(Math.max(n, 1)), 'Fadenkreuz auf dieselbe Ecke schieben', 'Ziehen oder Pfeiltasten.');
  if (!p.solution) return coach(String(n + 1), 'Nächste Ecke anklicken', 'Weit weg von den bisherigen.');
  if (n < 6 || !isGood(S.results[p.id]?.quality)) return coach(String(n + 1), 'Kanten an der Decke prüfen', 'Passt es nicht: Punkt an einem blauen + setzen.');
  g.replaceChildren();
}

/** Legende im 3D-Bild: was die Farben bedeuten (nur wenn etwas davon zu sehen ist). */
function renderLegend() {
  const g = $('#legend3d'), p = active();
  if (!S.model || S.mode !== 'calibrate' || warpEditing()) return g.replaceChildren();
  const errs = (p.solution?.errors || []).filter((e) => typeof e.id === 'number' && p.points.find((x) => x.id === e.id)?.enabled);
  const bad = errs.some((e) => e.error >= 8), warn = errs.some((e) => e.error >= 3 && e.error < 8);
  const items = [];
  if (p.solution) items.push(el('span', {}, el('i', { class: 'sw', style: `background:${p.color}` }), tr(`Bild von ${displayName(p)}`)));
  if (bad) items.push(el('span', {}, el('i', { class: 'ring bad' }), 'Punkt passt nicht (ab 8 px)'));
  if (warn) items.push(el('span', {}, el('i', { class: 'ring warn' }), 'Punkt ungenau (3–8 px)'));
  if (p.solution && (enabledPoints(p) < 6 || !isGood(S.results[p.id]?.quality))) items.push(el('span', {}, el('i', { class: 'ring hint-ring' }), 'Vorschlag für weiteren Punkt'));
  if (bad || warn) items.push(el('span', { class: 'hint' }, 'Punkt neu setzen oder abwählen'));
  g.replaceChildren(...items);
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
    maskRows.length ? el('div', { class: 'group plist' }, ...maskRows) : group(el('div', { class: 'empty-note' }, 'Mit + eine Maske anlegen.')),
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
    gtitle('Wiedergabe', infoBtn('Spielt Videos auf dem Modell ab, über alle Projektoren mit Überblendung und Masken. Mehrere Videos laufen nacheinander, die Reihenfolge lässt sich durch Ziehen ändern. Alle Ausgänge laufen synchron.')),
    playbackGroup(),
    gtitle('Ton', infoBtn('Gibt den Ton der Videos über ein Audiogerät aus, mit bis zu 32 Kanälen. Zuordnung und Einzelpegel stehen unter „Kanäle und Pegel“.')),
    audioGroup(),
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

// ---------- Wiedergabe: Playlist, Transport, Bildrate, Ton
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
const items = () => S.project.playback.items;
const total = () => totalDuration(items());
const audio = new AudioEngine();

// Länge und Größe der Einträge nacheinander bestimmen (ein Element, nur Metadaten)
const metaVideo = document.createElement('video');
metaVideo.muted = true;
metaVideo.preload = 'metadata';
let probing = null;
function probeNext() {
  if (probing) return;
  probing = items().find((it) => it.duration == null && !it.error) || null;
  if (!probing) { metaVideo.removeAttribute('src'); return; }
  metaVideo.src = fileUrl(probing.src);
  metaVideo.load();
}
function probeDone(info) {
  const it = probing;
  probing = null;
  if (it) Object.assign(it, info);
  updateVideoInfo();
  broadcast();
  refresh();
  probeNext();
}
metaVideo.addEventListener('loadedmetadata', () => probeDone({ duration: metaVideo.duration, width: metaVideo.videoWidth, height: metaVideo.videoHeight }));
metaVideo.addEventListener('error', () => probeDone({ error: true }));
function updateVideoInfo() {
  const t = total();
  S.videoInfo = items().length ? (t > 0 ? { duration: t } : items().every((it) => it.error) ? { error: true } : null) : null;
}
function loadVideoMeta() { updateVideoInfo(); probing = null; probeNext(); }

async function chooseVideo() {
  const files = await api.openDialog({ title: 'Videos hinzufügen', filters: [{ name: 'Video', extensions: VIDEO_EXT }], properties: ['openFile', 'multiSelections'] });
  if (files?.length) addVideos(files);
}
const itemOf = (file) => ({ src: file, name: file.split(/[\\/]/).pop() });
function addVideos(files) {
  const wasEmpty = !items().length;
  items().push(...files.map(itemOf));
  if (wasEmpty) S.play = { playing: false, startedAt: Date.now(), pausedAt: 0, loop: S.project.playback.loop };
  S.project.view.outputMode = 'video';
  loadVideoMeta();
  markDirty();
  refresh();
}
/** Ein einzelnes Video setzen (ersetzt die Liste). */
function setVideo(file) {
  S.project.playback.items = [itemOf(file)];
  S.play = { playing: false, startedAt: Date.now(), pausedAt: 0, loop: S.project.playback.loop };
  S.project.view.outputMode = 'video';
  loadVideoMeta();
  markDirty();
  refresh();
}
/** Position halten, wenn sich die Liste ändert (Eintrag bleibt derselbe). */
function editPlaylist(fn) {
  const before = items(), cur = before.length ? before[locate(before, targetTime(S.play, total())).index] : null;
  const local = cur ? locate(before, targetTime(S.play, total())).local : 0;
  fn();
  const i = cur ? items().indexOf(cur) : -1;
  S.play = seekState(S.play, i >= 0 ? startOf(items(), i) + local : 0);
  updateVideoInfo();
  markDirty();
  refresh();
}
function removeVideo(i) { editPlaylist(() => items().splice(i, 1)); }
function moveVideo(from, to) { if (from !== to) editPlaylist(() => items().splice(to, 0, items().splice(from, 1)[0])); }

function currentIndex() { return items().length ? locate(items(), targetTime(S.play, total())).index : -1; }
function jumpTo(i) {
  if (!items()[i]) return;
  S.play = seekState(S.play, startOf(items(), i));
  if (!S.play.playing) setPlay('play'); else refresh();
}
function step(d) {
  const n = items().length;
  if (!n) return;
  const loc = locate(items(), targetTime(S.play, total()));
  // „Zurück“ springt erst an den Anfang des Eintrags, nach 2 s an den vorigen
  if (d < 0 && loc.local > 2) return jumpTo(loc.index);
  jumpTo((loc.index + d + n) % n);
}

function setPlay(action) {
  const pb = S.project.playback;
  if (!items().length) return toast('Erst ein Video wählen.');
  S.play = playState({ ...S.play, loop: pb.loop }, action, total());
  if (action === 'play') S.project.view.outputMode = 'video';
  if (action === 'play' && !S.openOutputs.size) toggleOutputs(true);
  refresh();
}
const togglePlay = () => setPlay(S.play.playing ? 'pause' : 'play');

// Werkzeugleiste: Start/Pause und aktuelle Bildrate, immer sichtbar
function renderTransport() {
  const has = items().length > 0;
  const b = $('#btnPlayTb');
  b.disabled = !has;
  b.classList.toggle('on', S.play.playing);
  b.innerHTML = icon(S.play.playing ? 'pause' : 'play', 15);
  const tip = tr(S.play.playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)');
  b.dataset.tip = tip; b.setAttribute('aria-label', tip);
  showOutStats();
}

let playTicker = null;
function tickPlayPos() {
  const o = document.getElementById('playPos');
  if (o) o.textContent = posText();
  const ci = currentIndex();
  document.querySelectorAll('#playlist .pl-row').forEach((r, i) => r.classList.toggle('cur', i === ci));
}
const posText = () => `${fmtTime(targetTime(S.play, total()))} / ${fmtTime(total())}`;

function playlistRow(it, i, ci) {
  const sub = it.error ? 'Lässt sich nicht abspielen' : it.duration == null ? 'Lädt …' : `${it.width} × ${it.height} · ${fmtTime(it.duration)}`;
  const row = el('div', { class: `pl-row ${i === ci ? 'cur' : ''} ${it.error ? 'bad' : ''}`, draggable: 'true', 'data-i': i },
    el('span', { class: 'grip', 'aria-hidden': 'true', html: icon('grip', 14) }),
    el('span', { class: 'pl-n' }, String(i + 1)),
    el('button', { class: 'pl-name', 'data-tip': it.src, onclick: () => jumpTo(i) }, el('b', {}, it.name), el('span', { class: 'sub' }, sub)),
    el('button', { class: 'icon-btn', 'data-tip': 'Aus der Liste entfernen', 'aria-label': 'Aus der Liste entfernen', onclick: () => removeVideo(i), html: icon('close', 14) }));
  row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-pl', String(i)); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('text/x-pl')) return;
    e.preventDefault();
    const below = e.offsetY > row.offsetHeight / 2;
    row.classList.toggle('drop-above', !below); row.classList.toggle('drop-below', below);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
  row.addEventListener('drop', (e) => {
    const from = Number(e.dataTransfer.getData('text/x-pl'));
    if (Number.isNaN(from)) return;
    e.preventDefault();
    let to = i + (e.offsetY > row.offsetHeight / 2 ? 1 : 0);
    if (from < to) to--;
    moveVideo(from, to);
  });
  return row;
}

function playbackGroup() {
  const pb = S.project.playback;
  const list = items();
  clearInterval(playTicker);
  if (S.play.playing && S.mode === 'output') playTicker = setInterval(tickPlayPos, 250);
  const ci = currentIndex();
  const pl = el('div', { id: 'playlist', class: 'playlist' }, ...list.map((it, i) => playlistRow(it, i, ci)));
  // Dateien aus dem Finder/Explorer in die Liste ziehen
  pl.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  pl.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile?.(f) || f.path).filter((f) => f && VIDEO_EXT.includes(f.split('.').pop().toLowerCase()));
    if (files.length) { e.preventDefault(); addVideos(files); }
  });
  return [
    group(
      list.length ? pl : el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Keine Videos', el('span', { class: 'sub' }, 'Mehrere Videos laufen nacheinander.')))),
      el('div', { class: 'r' }, el('div', { class: 'lbl' }, list.length > 1 ? el('span', { class: 'sub' }, `${list.length} Videos · ${fmtTime(total())}`) : null),
        el('div', { class: 'ctl' }, el('button', { class: 'btn', onclick: chooseVideo, id: 'btnVideo' }, ic('plus', 14), 'Hinzufügen …'))),
    ),
    list.length ? group(
      el('div', { class: 'r sw' },
        el('div', { class: 'lbl', style: 'gap:6px' },
          el('button', { class: 'btn primary', id: 'btnPlay', style: 'min-width:92px', onclick: togglePlay }, ic(S.play.playing ? 'pause' : 'play', 14), S.play.playing ? 'Pause' : 'Abspielen'),
          list.length > 1 ? iconBtn('prev', 'Vorheriges Video', () => step(-1)) : null,
          list.length > 1 ? iconBtn('next', 'Nächstes Video', () => step(1)) : null,
          iconBtn('restart', 'Von vorn', () => setPlay('restart'))),
        el('div', { class: 'ctl' }, el('span', { class: 'muted', id: 'playPos' }, posText()))),
      r('Abbildung', select([['top', 'Draufsicht'], ['uv', 'Modell-UV']], pb.mapping, (v) => { pb.mapping = v; markDirty(); refresh(); }),
        { tip: 'Draufsicht legt das Video wie von oben gesehen über den Grundriss, Norden oben. Modell-UV nutzt die Texturkoordinaten aus dem 3D-Modell.' }),
      r(list.length > 1 ? 'Liste wiederholen' : 'Schleife', switchCtl(pb.loop, (v) => { pb.loop = v; S.play = { ...S.play, loop: v }; markDirty(); refresh(); })),
      r('Bildrate', select(FPS_CHOICES.map((f) => [f, f ? `${f} fps` : 'Wie Video']), pb.fps || 0, (v) => { pb.fps = Number(v); markDirty(); refresh(); }),
        { tip: 'Höchstens so viele Bilder pro Sekunde ausgeben. „Wie Video“ zeichnet jedes Videobild. Eine niedrigere Rate entlastet die Grafikkarte, z. B. 25 fps für Material mit 50 fps.' }),
    ) : null,
  ];
}
const FPS_CHOICES = [0, 24, 25, 30, 50, 60];

function outStatsText() {
  const now = Date.now();
  const list = Object.values(S.outStats).filter((x) => now - x.at < 5000).sort((a, b) => String(a.outputId).localeCompare(String(b.outputId)));
  if (!list.length) return '';
  return list.map((x) => `${x.outputId}: ${Math.round(x.fps)} fps${x.dropped ? ` · ${x.dropped} verworfen` : ''}`).join('   ');
}
/** Anzeige in der Werkzeugleiste: niedrigste Bildrate aller Ausgänge, Details im Tooltip. */
function showOutStats() {
  const b = $('#fpsBadge');
  const now = Date.now();
  const list = Object.values(S.outStats).filter((x) => now - x.at < 5000 && S.openOutputs.size);
  if (!list.length) { b.hidden = true; return; }
  b.hidden = false;
  const playing = list.some((x) => x.playing);
  const min = Math.min(...list.map((x) => x.fps));
  const target = S.project.playback.fps || 60;
  b.textContent = playing ? `${Math.round(min)} fps` : tr('Standbild');
  b.classList.toggle('warn', playing && min < target * 0.8 && min < 23);
  b.dataset.tip = tr(playing ? `Bildrate je Ausgang: ${outStatsText()}` : 'Die Ausgänge zeichnen nur bei Änderungen neu.');
}
setInterval(showOutStats, 2000);

// ---------- Ton
const A = () => S.project.audio;
let audioDevices = [];
async function refreshAudioDevices() { audioDevices = await audio.devices(); }
navigator.mediaDevices?.addEventListener?.('devicechange', async () => { await refreshAudioDevices(); if (S.mode === 'output') refresh(); });
function syncAudio() { return audio.sync(S.project.playback, S.play, A()).catch((e) => console.warn('Ton:', e.message)); }
setInterval(() => { if (A().enabled) syncAudio(); }, 250);

const dbText = (db) => (db <= -60 ? '−∞' : `${db > 0 ? '+' : ''}${nf(db, 1)} dB`);
function setSpeaker(k, patch, rebuild = true) {
  const a = A();
  for (let i = a.channels.length; i <= k; i++) a.channels[i] = speakerAt(a, i);
  Object.assign(a.channels[k], patch);
  markDirty();
  syncAudio();
  if (rebuild) refresh();
}
const ROUTES = () => [['off', 'Aus'], ...Array.from({ length: SOURCE_CHANNELS }, (_, i) => [String(i), `${i + 1}${i === 0 ? ' · L' : i === 1 ? ' · R' : ''}`]), ['sum', 'Mono']];

function audioGroup() {
  const a = A();
  const info = audio.info();
  const maxCh = Math.min(MAX_SPEAKERS, info?.maxChannels || MAX_SPEAKERS);
  const dev = audioDevices.find((d) => d.deviceId === (a.deviceId || 'default')) || audioDevices.find((d) => d.deviceId === 'default');
  const sub = !a.enabled ? 'Aus' : info ? `${dev?.label || 'Standardgerät'} · ${a.speakers} Kanäle · ${nf(info.sampleRate / 1000, 1)} kHz · ${nf(info.latency * 1000, 0)} ms` : 'Startet …';
  const speakers = Array.from({ length: Math.min(a.speakers, maxCh) }, (_, k) => speakerAt(a, k));
  return [
    group(
      r('Ton ausgeben', switchCtl(a.enabled, async (on) => { a.enabled = on; markDirty(); refresh(); if (on) await refreshAudioDevices(); await syncAudio(); refresh(); }, { id: 'swAudio' }), { sub }),
      r('Gesamtpegel', rangeCtl(a.master, -60, 6, 0.5, dbText, (v) => { a.master = v; syncAudio(); }, () => markDirty())),
    ),
    a.enabled ? tuningGroup() : null,
    more('audioSetup', 'Audiogerät',
      group(
        r('Gerät', select([['', 'Standardgerät des Systems'], ...audioDevices.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => [d.deviceId, d.label || 'Gerät'])], a.deviceId,
          async (v) => { a.deviceId = v; markDirty(); syncAudio().then(() => refresh()); }), { tip: 'Ausgabegerät, z. B. ein Mehrkanal-Interface. Unter Windows erscheinen hier die WDM/WASAPI-Geräte des Treibers, ASIO wird nicht unterstützt.' }),
        r('Sample-Rate', select(SAMPLE_RATES.map((s) => [s, s ? `${nf(s / 1000, 1)} kHz` : 'Wie Gerät']), a.sampleRate, async (v) => { a.sampleRate = Number(v); markDirty(); syncAudio().then(() => refresh()); }),
          { tip: 'Rate der Verarbeitung. Weicht sie vom Gerät ab, rechnet das System um. „Wie Gerät“ vermeidet das.' }),
        r('Puffergröße', select(BUFFER_SIZES.map((b) => [b, `${b} Samples`]), a.buffer, async (v) => { a.buffer = Number(v); markDirty(); syncAudio().then(() => refresh()); }),
          { tip: 'Wunschwert für das System. Größer ist stabiler, kleiner reagiert schneller. Bild und Ton werden um die tatsächliche Latenz ausgeglichen.' }),
        r('Lautsprecher', select(Array.from({ length: maxCh }, (_, i) => [i + 1, String(i + 1)]), Math.min(a.speakers, maxCh), (v) => { a.speakers = Number(v); markDirty(); syncAudio(); refresh(); }),
          { tip: `Anzahl der Ausgangskanäle. Das Gerät bietet ${info?.maxChannels ?? '?'} Kanäle, die App nutzt bis zu ${MAX_SPEAKERS}.` }),
        info ? r('Tatsächlich', el('span', { class: 'muted' }, `${nf(info.sampleRate / 1000, 1)} kHz · ${nf(info.latency * 1000, 0)} ms Latenz`)) : null,
      )),
    more('audioMix', 'Kanäle und Pegel',
      el('div', { class: 'group mixer', id: 'mixer' },
        el('div', { class: 'mx-head' }, el('span', { 'data-tip': 'Ausgangskanal am Audiogerät' }, 'Nr.'), el('span', { 'data-tip': 'Kanal des Videos. Mono mischt alle Kanäle.' }, 'Quelle'), el('span', {}, 'Pegel'), el('span', {})),
        ...speakers.map((c, k) => el('div', { class: `mx-row ${c.mute ? 'muted-ch' : ''}` },
          el('span', { class: 'mx-n' }, String(k + 1)),
          select(ROUTES(), String(c.route), (v) => setSpeaker(k, { route: v === 'off' || v === 'sum' ? v : Number(v) }), { 'aria-label': `Quelle für Ausgang ${k + 1}` }),
          el('div', { class: 'mx-level' },
            el('div', { class: 'meter', 'data-k': k }, el('i')),
            rangeCtl(c.gain, -60, 6, 0.5, dbText, (v) => setSpeaker(k, { gain: v }, false), () => {})),
          el('button', { class: `icon-btn ${c.mute ? 'on' : ''}`, 'data-tip': c.mute ? 'Ton an' : 'Stumm', 'aria-label': c.mute ? 'Ton an' : 'Stumm', html: icon(c.mute ? 'volumeOff' : 'volume', 14), onclick: () => setSpeaker(k, { mute: !c.mute }) }))),
        el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', { class: 'sub' }, 'Pegelanzeige nach Gesamt- und Einzelpegel')),
          el('div', { class: 'ctl' }, el('button', { class: 'btn', onclick: () => { A().channels = []; markDirty(); syncAudio(); refresh(); } }, 'Zurücksetzen'))))),
  ];
}

// Raumeinmessung (Assistent in tuning.js)
const tuning = createTuning({ el, ic, icon, tr, nf, api, audio, A, markDirty, refresh, toast, peakingResponse });
const camcal = createCamcal({ el, ic, tr, nf, api, S, active, displayName, lensFor, markDirty, refresh, toast, scheduleSolve, toggleOutputs: (v) => toggleOutputs(v), setPlay: (v) => setPlay(v) });
function cameraGroup(p) {
  const n = p.autoPoints?.length || 0;
  return [
    gtitle('Kamera'),
    group(
      n ? r('Kamera-Punkte', el('div', { style: 'display:flex;gap:10px;align-items:center' },
        el('span', { class: 'muted' }, String(n)),
        el('button', { class: 'link quiet', id: 'btnCamClear', onclick: () => { p.autoPoints = []; p.autoCal = null; scheduleSolve(p); markDirty(); refresh(); } }, 'Entfernen')),
      { sub: tr(`${p.autoCal?.positions || 1} Standort(e) · ${new Date(p.autoCal?.date || Date.now()).toLocaleDateString(locale())}`), tip: 'Punkte aus der Kamera-Kalibrierung. Sie werden zusammen mit den Punkten von Hand verwendet.' }) : null,
      el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, n ? 'Neu messen' : 'Automatisch', el('span', { class: 'sub' }, 'mit Webcam und Testmustern'))),
        el('div', { class: 'ctl' }, el('button', { class: 'btn', id: 'btnCamcal', disabled: !S.model, onclick: () => camcal.open(p.id) }, ic('camera', 14), 'Mit Kamera kalibrieren …')))),
  ];
}
function tuningGroup() {
  const t = A().tuning;
  const when = t?.date ? new Date(t.date).toLocaleDateString(locale()) : '';
  return group(
    t ? r('Einmessung', switchCtl(!!t.enabled, (on) => { t.enabled = on; markDirty(); syncAudio(); refresh(); }, { id: 'swTuning' }),
      { sub: `${t.enabled ? 'An' : 'Aus'} · ${t.positions} Messstellen · ${when}`, tip: 'Gleicht Laufzeit, Pegel und Klang der Lautsprecher an, gemittelt über die Liegefläche. Zum Vergleichen aus- und einschalten.' })
      : r('Einmessung', el('span', { class: 'muted' }, 'Noch nicht gemessen'), { tip: 'Misst alle Lautsprecher an mehreren Stellen mit dem Handy oder einem Messmikrofon und gleicht Laufzeit, Pegel und Klang an.' }),
    el('div', { class: 'r' }, el('div', { class: 'lbl' }), el('div', { class: 'ctl' }, el('button', { class: 'btn', id: 'btnTune', onclick: () => tuning.open() }, ic('mic', 14), t ? 'Neu einmessen …' : 'Einmessen …'))),
  );
}

// Pegelanzeige nur, solange das Mischpult sichtbar ist und Ton läuft
(function meterLoop() {
  requestAnimationFrame(meterLoop);
  const mx = document.getElementById('mixer');
  if (!mx || !mx.offsetParent || !A().enabled || !S.play.playing) return;
  const lv = audio.levels();
  for (const m of mx.querySelectorAll('.meter')) {
    const db = lv[Number(m.dataset.k)] ?? -90;
    const f = Math.max(0, Math.min(1, (db + 60) / 60));
    m.firstChild.style.clipPath = `inset(0 ${(100 - f * 100).toFixed(1)}% 0 0)`;
    m.classList.toggle('clip', db > -0.5);
  }
})();

// ------------------------------------------------------------------ TouchDesigner live (OSC)
const liveTimers = {};
function sendLive(p, immediate = false) {
  const td = S.project.td;
  if (!td.live || !p.solution) return;
  clearTimeout(liveTimers[p.id]);
  liveTimers[p.id] = setTimeout(async () => {
    const ex = exportProjector(p, { modelRadius: S.model?.radius });
    const res = await api.oscSend(td.host, Number(td.port), '/kalibrator/projector', [JSON.stringify(ex)]);
    S.liveStatus = res.ok ? `Zuletzt ${displayName(p)} um ${new Date().toLocaleTimeString(locale())}` : `Fehler: ${res.error}`;
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
      // Kamera-Punkte braucht die Ausgabe nicht (spart Kopieren bei jeder Änderung)
      project: { ...S.project, projectors: S.project.projectors.map(({ autoPoints, ...rest }) => rest) },
      activeId: S.activeId,
      activePointId: S.activePointId,
      play: S.play,
      warpEdit: warpEditing(),
      markers: S.mode === 'calibrate',
      activeHandle: S.activeHandle,
      activePin: S.activePin,
      lang: getLang(),
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
  S.outputsWanted = open;
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
  if (msg.type === 'patternShown') return camcal.onShown(msg);
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
api.onDisplaysChanged(() => displaysChanged());

// ------------------------------------------------------------------ Tastatur
function handleKey(e) {
  const p = active();
  const pt = activePoint();
  const step = e.shiftKey ? 10 : e.altKey ? 0.25 : 1;
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (warpEditing() && p.warp) {
    const n = p.warp.offsets.length;
    if (mv && (S.activeHandle != null || S.activePin != null)) {
      if (!e.repeat) pushUndo();
      moveWarpSelection(p, mv[0] / p.resolution[0], mv[1] / p.resolution[1]);
      markDirty(); refresh(true);
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && removeActivePin(p)) return true;
    if (e.key === 'Escape' && (S.activeHandle != null || S.activePin != null)) { selectWarp(null, null); refresh(true); return true; }
    if (e.key === 'Tab') { selectWarp(((S.activeHandle ?? -1) + (e.shiftKey ? -1 : 1) + n) % n, null); refresh(true); return true; }
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
  if (e.key === ' ' && items().length) { togglePlay(); return true; }
  if (e.key === 'Escape') { S.activePointId = null; S.pendingRepick = false; S.pickCenter = false; S.activeMaskId = null; $('#helpMenu').classList.add('hidden'); refresh(); return true; }
  if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
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
// ------------------------------------------------------------------ Projektorbild groß über der 3D-Ansicht
function layoutPreviewBig() {
  const pb = $('.preview-block');
  if (!S.previewBig) { pb.style.cssText = ''; return; }
  const r = $('.stage').getBoundingClientRect(), pad = 16, cap = 34;
  const w = Math.min(r.width - 2 * pad, ((r.height - 2 * pad - cap) * 16) / 9);
  Object.assign(pb.style, { left: `${r.left + (r.width - w) / 2}px`, top: `${r.top + pad}px`, width: `${w}px` });
}
function setPreviewBig(on) {
  S.previewBig = on;
  document.body.classList.toggle('preview-big', on);
  const b = $('#btnPreviewBig');
  b.setAttribute('aria-pressed', String(on));
  b.dataset.tip = on ? 'Wieder klein (Esc)' : 'Groß anzeigen (Esc schließt)';
  b.innerHTML = icon(on ? 'shrink' : 'expand', 16);
  layoutPreviewBig();
}
$('#btnPreviewBig').onclick = () => setPreviewBig(!S.previewBig);
window.addEventListener('resize', () => { if (S.previewBig) layoutPreviewBig(); });

window.addEventListener('keydown', (e) => {
  if (!$('#tuneSheet').classList.contains('hidden')) { if (e.key === 'Escape') tuning.close(); return; }
  if (!$('#camSheet').classList.contains('hidden')) { if (e.key === 'Escape') camcal.close(); return; }
  if (!$('#onboarding').classList.contains('hidden')) {
    if (e.key === 'Escape') closeOnboarding(false);
    return;
  }
  if (e.key === 'Escape' && S.previewBig && S.activeHandle == null && S.activePin == null && !document.querySelector('.side-label-edit')) { setPreviewBig(false); return; }
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
  t.textContent = tr(text);
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
const OB_PAGES = 4;
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
      el('h1', { id: 'obTitle' }, 'Womit möchtest du starten?'),
      el('p', { class: 'lead' }, 'Die Demo ist eine Gewölbedecke mit acht Projektoren.'),
      el('div', { class: 'choices' },
        el('button', { class: `choice ${S.model && isDemo() ? 'on' : ''}`, id: 'obDemo', onclick: async () => { if (!(S.model && isDemo())) await loadDemo(); renderOnboarding(); } },
          el('div', { class: 'ci', html: icon('model', 26) }), el('b', {}, 'Mit der Demo'), el('span', {}, 'Gewölbedecke, 8 Projektoren')),
        el('button', { class: `choice ${S.model && !isDemo() ? 'on' : ''}`, id: 'obOwn', onclick: async () => { await chooseModel(); renderOnboarding(); } },
          el('div', { class: 'ci', html: icon('file', 26) }), el('b', {}, 'Eigenes 3D-Modell'), el('span', {}, S.model && !isDemo() ? S.project.model.name : 'OBJ-Datei wählen …'))),
    ],
    () => [
      el('h1', { id: 'obTitle' }, 'Bildschirme zuordnen'),
      el('p', { class: 'lead' }, 'Welcher Grafikkarten-Ausgang speist welche Projektoren? Geht auch später unter „Einrichten“.'),
      el('div', { class: 'group' }, ...outputRows()),
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
      !last ? el('button', { class: 'btn ghost', onclick: () => closeOnboarding(false), id: 'obSkip' }, 'Überspringen') : null,
      obPage > 0 ? el('button', { class: 'btn', onclick: () => { obPage--; renderOnboarding(); } }, 'Zurück') : null,
      el('button', { class: 'btn primary', id: 'obNext', disabled: obPage === 1 && !S.model, onclick: () => { if (last) closeOnboarding(true); else { obPage++; renderOnboarding(); } } }, last ? `Mit ${displayName(S.project.projectors[0])} beginnen` : 'Weiter'))));
  $('#obNext').focus();
}

// ------------------------------------------------------------------ Hilfe-Menü
function toggleHelp() {
  const m = $('#helpMenu');
  if (!m.classList.contains('hidden')) return m.classList.add('hidden');
  const keys = [[['Klick'], 'Punkt im Modell setzen'], [['←', '→', '↑', '↓'], 'Fadenkreuz verschieben'], [['⇧'], 'mit Pfeil: 10 Pixel'], [['Tab'], 'Nächster Punkt'], [['Entf'], 'Punkt löschen'], [['1', '–', '9'], 'Projektor wählen'], [['Esc'], 'Auswahl aufheben'], [[api.platform === 'darwin' ? '⌘' : 'Strg', 'Z'], 'Rückgängig']];
  m.replaceChildren(
    el('button', { role: 'menuitem', onclick: () => { m.classList.add('hidden'); showOnboarding(0); } }, ic('book'), 'Einführung anzeigen'),
    el('button', { role: 'menuitem', onclick: () => { m.classList.add('hidden'); chooseModel(); } }, ic('model'), '3D-Modell laden …'),
    el('hr'),
    el('div', { class: 'ttl' }, 'Sprache'),
    el('div', { class: 'seg lang' }, ...LANGS.map(([id, name]) => el('button', { class: getLang() === id ? 'on' : '', onclick: () => api.setLang(id) }, name))),
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
$('#btnAddGroup').onclick = () => addGroup();
$('#btnAddProj').onclick = () => {
  const p = addProjector(S.project);
  if (!p) return toast(`Höchstens ${MAX_PROJECTORS} Projektoren.`);
  S.activeId = p.id;
  markDirty();
  setMode('setup');
  refresh();
  toast(p.output ? `${displayName(p)} hinzugefügt, ${outputLabel(p)}` : `${displayName(p)} hinzugefügt. Alle Felder sind belegt, bitte einen Ausgang wählen.`);
};
$('#btnPlayTb').onclick = () => togglePlay();
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

// Sprache wechseln: statisches HTML neu übersetzen, alles Dynamische neu aufbauen
function applyLang(l) {
  setLang(l);
  document.documentElement.lang = getLang();
  translateDom(document.body);
  if (!$('#helpMenu').classList.contains('hidden')) { $('#helpMenu').classList.add('hidden'); toggleHelp(); }
  if (!$('#onboarding').classList.contains('hidden')) renderOnboarding();
  renderDocState();
  refresh();
  broadcast();
}
api.onLangChanged((l) => applyLang(l));

// Start: letzte Sitzung wiederherstellen, sonst Beispielmodell laden
(async function start() {
  setLang(await api.getLang());
  document.documentElement.lang = getLang();
  translateDom(document.body);
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
    if (o.displayId != null && S.displays.some((d) => d.id === o.displayId)) return;
    const byKey = o.displayKey && S.displays.find((d) => displayKey(d) === o.displayKey);
    o.displayId = byKey ? byKey.id : o.solo ? null : ext[i]?.id ?? null;
  });
  await syncOpenOutputs();
  refresh();
  if (!onboardingSeen()) showOnboarding(0);
  window.__app = { S, tuning, camcal, view, refresh, assignDisplay, setVideo, addVideos, jumpTo, audio, setPlay, scheduleSolve, selectPoint, computeBlend, toggleOutputs, setMode, showOnboarding, closeOnboarding, ready: true };
})();
