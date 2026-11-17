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
};
const undoStack = [], redoStack = [];

const active = () => S.project.projectors.find((p) => p.id === S.activeId);
const activePoint = () => active()?.points.find((x) => x.id === S.activePointId);

function snapshot() {
  return JSON.stringify(S.project.projectors.map((p) => ({ id: p.id, points: p.points, masks: p.masks, nextPointId: p.nextPointId, centerHint: p.centerHint || null })));
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
  onHover: (hit) => {
    $('#hoverInfo').textContent = hit ? `${hit.snapped ? '◆ Ecke' : '· Fläche'}  ${hit.point.map((v) => v.toFixed(3)).join(', ')}` : '';
  },
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
  if (S.pickCenter) {
    pushUndo();
    p.centerHint = { world };
    S.pickCenter = false;
    if (p.points.length) scheduleSolve(p);
    markDirty();
    toast(`Bildmitte für ${p.name} gesetzt`);
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
      renderSettings();
      renderOutputs();
      renderMaskTab();
      renderBlendTab();
      renderTdSettings();
    }
    renderPointsTab();
    renderGuide();
    view.update(S.project, S.activeId, S.activePointId, S.pendingRepick, S.results[S.activeId]?.candidates);
    preview.set(active(), S.activePointId, { suggest: S.results[S.activeId]?.suggest, activeMaskId: S.activeMaskId, blendImg: blendImgFor(S.activeId) });
    $('#previewCaption').replaceChildren(el('span', {}, el('b', {}, active().name), `  ${outputLabel(active())}`), el('span', {}, `${active().resolution[0]} × ${active().resolution[1]}`));
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

function outputLabel(p) {
  const o = S.project.outputs.find((x) => x.id === p.output);
  if (!o) return 'Kein Ausgang';
  return o.layout === '2x2' ? `${o.name} · ${QUAD_SHORT[p.quadrant]}` : o.name;
}

function statusOf(p) {
  const n = p.points.filter((x) => x.enabled && x.world && x.image).length;
  const r = S.results[p.id];
  if (!p.solution) return { color: null, text: n ? `${n}/4` : '' };
  const q = r?.quality;
  const color = q === 'sehr gut' || q === 'gut' ? 'var(--ok)' : 'var(--warn)';
  return { color, text: `${nf(p.solution.rms)} px` };
}

function projRow(p, i) {
  const st = statusOf(p);
  return el('div', { class: `proj-row ${p.id === S.activeId ? 'active' : ''} ${p.enabled ? '' : 'disabled'}`, onclick: () => selectProjector(p.id), 'data-tip': `Taste ${i + 1}`, role: 'button', tabindex: 0 },
    el('span', { class: 'dot', style: `background:${p.color}` }),
    el('span', { class: 't' }, el('span', { class: 'name' }, p.name), el('span', { class: 'sub' }, outputLabel(p))),
    el('span', { class: 'val' }, st.text, st.color ? el('i', { style: `background:${st.color}` }) : null));
}

function renderProjList() {
  const ps = S.project.projectors;
  $('#projListInner').replaceChildren(...ps.map((p, i) => [p, i]).filter(([p]) => p.ring !== 'außen').map(([p, i]) => projRow(p, i)));
  $('#projListOuter').replaceChildren(...ps.map((p, i) => [p, i]).filter(([p]) => p.ring === 'außen').map(([p, i]) => projRow(p, i)));
}

function infoBtn(tip) {
  const b = el('button', { class: 'info', 'data-tip': tip, 'aria-label': 'Info', type: 'button' });
  b.innerHTML = icon('info', 14);
  return b;
}
function row(label, control, tip) {
  return el('div', { class: 'row' }, el('label', {}, label, tip ? infoBtn(tip) : null), control);
}
function select(options, value, onchange) {
  return el('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));
}
function input(value, onchange, type = 'text', attrs = {}) {
  return el('input', { type, value, ...attrs, onchange: (e) => onchange(type === 'number' ? Number(e.target.value) : e.target.value) });
}
function rangeCtl(value, min, max, step, fmt, oninput, onchange) {
  const out = el('output', {}, fmt(value));
  const r = el('input', { type: 'range', min, max, step, value, oninput: (e) => { out.textContent = fmt(Number(e.target.value)); oninput?.(Number(e.target.value)); }, onchange: (e) => onchange(Number(e.target.value)) });
  return el('div', { class: 'range' }, r, out);
}
function switchCtl(checked, onchange) {
  return el('input', { type: 'checkbox', class: 'switch', checked, onchange: (e) => onchange(e.target.checked) });
}

function renderSettings() {
  const p = active();
  const lens = getLensPreset(p.lens);
  const o = S.project.outputs.find((x) => x.id === p.output);
  const s = p.solution;
  $('#projSettings').replaceChildren(
    row('Name', input(p.name, (v) => { p.name = v; markDirty(); refresh(); })),
    row('Aktiv', switchCtl(p.enabled, (v) => { p.enabled = v; markDirty(); refresh(); })),
    el('div', { class: 'sep' }),
    row('Ausgang', select([...S.project.outputs.map((x) => [x.id, x.name]), ['', 'Keiner']], p.output, (v) => { p.output = v; markDirty(); refresh(); })),
    o && o.layout !== '1x1' ? row('Bereich', select((o.layout === '2x2' ? QUAD_SHORT : ['links', 'rechts']).map((n, i) => [i, n]), p.quadrant, (v) => { p.quadrant = Number(v); markDirty(); refresh(); })) : null,
    row('Auflösung', select([['1920x1080', '1920 × 1080'], ['1280x800', '1280 × 800'], ['1280x720', '1280 × 720'], ['3840x2160', '3840 × 2160']], p.resolution.join('x'), (v) => {
      pushUndo();
      const [w, h] = v.split('x').map(Number);
      const sx = w / p.resolution[0], sy = h / p.resolution[1];
      for (const pt of p.points) if (pt.image) pt.image = [pt.image[0] * sx, pt.image[1] * sy];
      p.resolution = [w, h];
      p.solution = null;
      scheduleSolve(p);
      markDirty(); refresh();
    }), 'Auflösung des Signals, das der Beamer bekommt, nicht die native Panelauflösung'),
    el('div', { class: 'sep' }),
    row('Objektiv', select(LENS_PRESETS.map((l) => [l.id, l.name]), p.lens, (v) => { p.lens = v; scheduleSolve(p); markDirty(); refresh(); }), lens.note),
    row('Montage', select([['auto', 'Automatisch'], ['normal', 'Achse unter dem Bild'], ['flipped', 'Achse über dem Bild']], p.mountMode, (v) => { p.mountMode = v; scheduleSolve(p); markDirty(); refresh(); }),
      'Kurzdistanz-Beamer projizieren komplett auf eine Seite der Objektivachse. Je nach Menü-Einstellung (Decke/Tisch) liegt sie über oder unter dem Bild. Automatisch prüft beides.'),
    el('div', { class: 'sep' }),
    row('Bildmitte', el('div', { style: 'display:flex;gap:8px;align-items:center' },
      el('button', { class: `btn ${S.pickCenter ? 'on' : ''}`, onclick: () => { S.pickCenter = !S.pickCenter; refresh(); } }, S.pickCenter ? 'Im Modell klicken …' : p.centerHint ? 'Neu wählen' : 'Im Modell wählen'),
      p.centerHint ? el('button', { class: 'link', onclick: () => { pushUndo(); p.centerHint = null; scheduleSolve(p); markDirty(); refresh(); } }, 'Entfernen') : null),
      'Wo ungefähr liegt die Mitte des Beamerbildes an der Decke? Ein Klick ins Modell genügt. Hilft dem Solver bei wenigen oder eng liegenden Punkten.'),
    el('div', { class: 'sep' }),
    row('TD-Kamera', input(p.tdCamera, (v) => { p.tdCamera = v; markDirty(); }), 'Name des Camera COMP in TouchDesigner'),
    row('TD-Render', input(p.tdRender, (v) => { p.tdRender = v; markDirty(); }), 'Name des Render TOP, hinter den die Maske gehängt wird'),
    s ? el('div', { class: 'readout' },
      `Wurfverhältnis ${nf(s.throwRatio, 3)}`, el('br'),
      `Achse bei ${nf((s.cy / p.resolution[1]) * 100, 0)} % Bildhöhe`, el('br'),
      `Position ${s.center.map((v) => nf(v, 2)).join(' / ')}`) : null,
  );
}

function renderOutputs() {
  const opts = [['', 'Kein Bildschirm'], ...S.displays.map((d) => [d.id, `${d.label} (${d.pixelSize.width}×${d.pixelSize.height})`])];
  $('#outputSettings').replaceChildren(...S.project.outputs.map((o) =>
    el('div', { class: 'out-row' },
      el('span', {}, o.name),
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
      }),
      select([['2x2', '2×2'], ['1x2', '1×2'], ['1x1', '1×1']], o.layout, (v) => { o.layout = v; markDirty(); refresh(); }))));
  document.querySelectorAll('#outputMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.project.view.outputMode));
  $('#chkShowMask').checked = S.project.view.showMask;
  const btn = $('#btnOutputs');
  btn.classList.toggle('on', S.openOutputs.size > 0);
  btn.setAttribute('aria-pressed', String(S.openOutputs.size > 0));
}

function errClass(e) { return e < 3 ? 'e-ok' : e < 8 ? 'e-warn' : 'e-bad'; }

function renderPointsTab() {
  const p = active();
  const s = p.solution;
  const r = S.results[p.id] || {};
  const n = p.points.filter((x) => x.enabled && x.world && x.image).length;
  const q = $('#quality');
  if (s) {
    const good = r.quality === 'sehr gut' || r.quality === 'gut';
    q.className = 'summary';
    q.replaceChildren(
      el('div', { class: 'state' }, el('i', { style: `background:${good ? 'var(--ok)' : 'var(--warn)'}` }), `Kalibrierung ${r.quality || ''}`),
      cell(`${nf(s.rms, 2)} px`, 'Mittl. Fehler'),
      cell(`± ${nf(s.sigmaCenter * 100, 1)} cm`, 'Position'),
      cell(String(n), 'Punkte'),
      cell(`${nf(s.coverage * 100, 0)} %`, 'Abdeckung'));
  } else {
    q.className = 'summary empty';
    q.textContent = n < 4 ? `Noch ${4 - n} ${4 - n === 1 ? 'Punkt' : 'Punkte'} bis zur ersten Lösung` : r.message || 'Rechne …';
  }
  $('#warnings').replaceChildren(...(r.warnings || []).filter((w) => !(w.level === 'info' && /Vorläufige/.test(w.text))).map((w) => el('div', { class: w.level }, w.text)));
  const errs = new Map((s?.errors || []).map((e) => [e.id, e.error]));
  $('#pointRows').replaceChildren(...p.points.map((pt) => {
    const e = errs.get(pt.id);
    return el('tr', { class: `${pt.id === S.activePointId ? 'active' : ''} ${pt.enabled ? '' : 'disabled'}`, onclick: () => selectPoint(pt.id) },
      el('td', { class: 'c-id' }, String(pt.id)),
      el('td', { class: 'model', title: pt.world ? pt.world.map((v) => nf(v, 3)).join('  ') : '' }, pt.world ? pt.world.map((v) => nf(v, 2)).join('  ') : '–'),
      el('td', { class: 'num' }, pt.image ? pt.image.map((v) => nf(v, 0)).join('  ') : '–'),
      el('td', { class: `num ${e != null && pt.enabled ? errClass(e) : ''}` }, e != null ? nf(e, 1) : ''),
      el('td', { class: 'c-on' }, el('input', { type: 'checkbox', 'aria-label': 'Punkt verwenden', title: 'Punkt verwenden', checked: pt.enabled, onclick: (ev) => ev.stopPropagation(), onchange: (ev) => { pushUndo(); pt.enabled = ev.target.checked; scheduleSolve(p); markDirty(); refresh(); } })));
  }));
  $('#btnDeletePoint').disabled = !activePoint();
  $('#btnRepick').disabled = !activePoint();
  $('#btnRepick').classList.toggle('on', S.pendingRepick);
  $('#btnClearPoints').classList.toggle('hidden', !p.points.length);
}
const cell = (v, l) => el('div', { class: 'cell' }, el('div', { class: 'v' }, v), el('div', { class: 'l' }, l));

function renderGuide() {
  const g = $('#guide');
  const p = active();
  const n = p.points.filter((x) => x.enabled && x.world && x.image).length;
  let step = '', msg = '';
  if (!S.model) {
    msg = '<b>3D-Modell laden</b> über das Würfel-Symbol oben links';
  } else if (S.pickCenter) {
    step = p.name;
    msg = 'Ungefähre <b>Bildmitte</b> des Beamers im Modell anklicken';
  } else if (S.pendingRepick) {
    step = `Punkt ${S.activePointId}`;
    msg = 'Neue Stelle im Modell anklicken';
  } else if (n === 0 && !activePoint()) {
    step = `${p.name} · 1/4`;
    msg = 'Eine <b>gut erkennbare Ecke</b> im Modell anklicken, weit außen im Bild beginnen';
  } else if (activePoint() && !p.solution) {
    step = `${p.name} · ${Math.min(n, 4)}/4`;
    msg = 'Fadenkreuz auf dem Beamer an <b>dieselbe Stelle der echten Decke</b> bringen, dann den nächsten Punkt anklicken';
  } else if (!p.solution) {
    step = `${p.name} · ${n}/4`;
    msg = 'Nächsten Punkt weit entfernt von den bisherigen wählen';
  } else if (n < 6) {
    step = `${p.name} · ${n}/6`;
    msg = 'Kanten auf der Decke prüfen. Weitere Punkte dort setzen, wo es nicht passt, Vorschläge sind <b>blau</b> markiert';
  } else {
    g.replaceChildren();
    return;
  }
  g.innerHTML = `${step ? `<span class="step">${step}</span>` : ''}<span class="msg">${msg}</span>`;
}

function renderMaskTab() {
  const p = active();
  $('#maskList').replaceChildren(...p.masks.map((m) => el('div', { class: m.id === S.activeMaskId ? 'active' : '', onclick: () => { S.activeMaskId = m.id; refresh(); } },
    el('span', {}, m.name), el('span', { class: 'meta' }, `${m.mode === 'hide' ? 'Ausblenden' : 'Nur hier'} · ${m.closed ? `${m.points.length} Ecken` : 'offen'}`))));
  const m = p.masks.find((x) => x.id === S.activeMaskId);
  $('#btnDeleteMask').disabled = !m;
  $('#maskProps').replaceChildren(...(m ? [
    el('div', { class: 'sep' }),
    row('Name', input(m.name, (v) => { m.name = v; markDirty(); refresh(); })),
    row('Wirkung', select([['hide', 'Bereich ausblenden'], ['show', 'Nur Bereich zeigen']], m.mode, (v) => { pushUndo(); m.mode = v; markDirty(); refresh(); })),
    row('Weiche Kante', rangeCtl(m.feather, 0, 300, 1, (v) => `${v} px`, (v) => { m.feather = v; refresh(true); }, () => { markDirty(); refresh(); })),
    row('Aktiv', switchCtl(m.enabled !== false, (v) => { m.enabled = v; markDirty(); refresh(); })),
  ] : []));
}

function renderBlendTab() {
  const b = S.project.blend;
  const set = (k, v, re = true) => { b[k] = v; markDirty(); if (re) refresh(); };
  $('#blendSettings').replaceChildren(
    row('Überblendung', switchCtl(b.auto, (v) => set('auto', v)), 'Weiche Überblendung, wo sich Projektoren überlappen. Gewichtet nach Abstand zum eigenen Bildrand.'),
    row('Breite', rangeCtl(b.width, 0.05, 1, 0.05, (v) => `${nf(v * 100, 0)} %`, null, (v) => set('width', v))),
    row('Gamma', input(b.gamma, (v) => set('gamma', v), 'number', { step: 0.1, min: 1, max: 3 }), 'Gamma der Beamer, meist 2,2. Verhindert dunkle oder helle Streifen in der Überblendung.'),
    el('div', { class: 'sep' }),
    row('Helligkeit', switchCtl(b.brightness, (v) => set('brightness', v)), 'Weiter entfernte oder schräg getroffene Flächen sind dunkler. Hellere Bereiche werden auf ein gemeinsames Niveau gedimmt.'),
    row('Stärke', rangeCtl(b.brightnessStrength, 0, 1, 0.05, (v) => `${nf(v * 100, 0)} %`, null, (v) => set('brightnessStrength', v)), '100 % gleicht vollständig an und kostet am meisten Gesamthelligkeit'),
  );
}

// ------------------------------------------------------------------ TouchDesigner live (OSC)
const liveTimers = {};
function sendLive(p, immediate = false) {
  const td = S.project.td;
  if (!td.live || !p.solution) return;
  clearTimeout(liveTimers[p.id]);
  liveTimers[p.id] = setTimeout(async () => {
    const ex = exportProjector(p, { modelRadius: S.model?.radius });
    const r = await api.oscSend(td.host, Number(td.port), '/kalibrator/projector', [JSON.stringify(ex)]);
    S.liveStatus = r.ok ? `${p.id} gesendet ${new Date().toLocaleTimeString('de-DE')}` : `Fehler: ${r.error}`;
    const st = document.getElementById('liveStatus');
    if (st) st.textContent = S.liveStatus;
  }, immediate ? 0 : 80);
}
function sendAllLive() {
  for (const p of S.project.projectors) sendLive(p, true);
}

function renderTdSettings() {
  const td = S.project.td;
  $('#tdSettings').replaceChildren(
    el('label', { class: 'switch-row' }, el('span', {}, 'Live senden'), switchCtl(td.live, (v) => { td.live = v; markDirty(); if (v) sendAllLive(); refresh(); })),
    el('div', { class: 'out-row', style: 'grid-template-columns:52px 1fr 64px' },
      el('span', {}, 'Ziel'),
      input(td.host, (v) => { td.host = v; markDirty(); }),
      input(td.port, (v) => { td.port = v; markDirty(); }, 'number')),
    el('div', { class: 'muted small', id: 'liveStatus', style: 'padding:2px 0 0 56px;font-size:11px' }, td.live ? S.liveStatus || 'Bereit' : ''),
  );
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
    toast('Bitte zuerst bei „Ausgänge“ links einen Bildschirm für HDMI A/B wählen.');
    return;
  }
  for (const o of assigned) await api.openOutput(o.displayId, o.id);
  await syncOpenOutputs();
  refresh();
  setTimeout(() => { broadcast(); broadcastBlend(); }, 800);
}

api.onOutputEvent((msg) => {
  if (msg.type === 'ready') { broadcast(); broadcastBlend(); return; }
  if (msg.type === 'key') return handleKey(msg);
  if (msg.type === 'pointer') {
    // Klick/Ziehen auf einem Projektor-Ausgang
    if (msg.projectorId !== S.activeId) {
      if (msg.phase === 'down') selectProjector(msg.projectorId);
      return;
    }
    const p = active();
    let pt = activePoint();
    if (msg.phase === 'down') {
      // nahen Punkt wählen, sonst aktiven Punkt hierher setzen
      const near = p.points.find((x) => x.image && Math.hypot(x.image[0] - msg.u, x.image[1] - msg.v) < 25);
      if (near && near !== pt) { selectPoint(near.id); return; }
      if (!pt) return toast('Erst im Modell einen Punkt anklicken – dann hier auf der Decke platzieren.');
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
  if (e.key === 'Escape') { S.activePointId = null; S.pendingRepick = false; S.pickCenter = false; refresh(); return true; }
  if (/^[1-8]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
    const target = S.project.projectors[Number(e.key) - 1];
    if (target) selectProjector(target.id);
    return true;
  }
  if ((e.key === 'Enter') && $('[data-tab=masks]').classList.contains('on')) {
    const m = p.masks.find((x) => x.id === S.activeMaskId);
    if (m && !m.closed && m.points.length >= 3) { m.closed = true; refresh(); }
    return true;
  }
  return false;
}
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
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
async function loadModelFromPath(path) {
  try {
    const text = await api.readFile(path, 'utf8');
    S.model = buildModel(text);
    S.project.model = { path, name: path.split(/[\\/]/).pop() };
    view.setModel(S.model);
    preview.setModel(S.model);
    S.blendImages = {};
    setStatus(`${S.project.model.name}: ${Math.round(S.model.triangles).toLocaleString('de-DE')} Dreiecke, ${S.model.featureVertices.length / 3} Einrastpunkte`);
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
  return JSON.stringify({ app: 'projektor-kalibrator', ...S.project }, null, 1);
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
  $('#projectName').textContent = S.project.name;
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
  $('#projectName').textContent = S.project.name;
  if (S.project.model.path && (await api.exists(S.project.model.path))) await loadModelFromPath(S.project.model.path);
  for (const p of S.project.projectors) if (p.points.length) scheduleSolve(p);
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
  if (!S.model || !solved.length) return toast('Erst mindestens einen Projektor kalibrieren.');
  $('#blendStatus').textContent = 'Rechnet …';
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const res = computeBlendMasks(S.model, S.project);
  S.blendImages = res;
  const ms = Math.round(performance.now() - t0);
  $('#blendStatus').textContent = `${Object.keys(res).length} Masken · ${ms} ms`;
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
    projectors.push(ex);
  }
  const out = {
    app: 'Projektor-Kalibrator',
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
    const script = await api.readFile(`${td}/apply_calibration.py`, 'utf8');
    await api.writeFile(`${base}/apply_calibration.py`, script);
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
function setStatus(t) { $('#statusText').textContent = t; }

// ------------------------------------------------------------------ Verdrahtung
$('#btnModel').onclick = chooseModel;
$('#btnOpen').onclick = () => openProject();
$('#btnSave').onclick = () => save();
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnOutputs').onclick = () => toggleOutputs();
$('#btnExport').onclick = exportTD;
$('#btnFocus').onclick = () => view.focus();
$('#btnDeletePoint').onclick = deleteActivePoint;
$('#btnRepick').onclick = () => { S.pendingRepick = !S.pendingRepick; refresh(); };
$('#btnClearPoints').onclick = () => {
  const p = active();
  if (!p.points.length) return;
  pushUndo();
  p.points = [];
  p.solution = null;
  S.activePointId = null;
  S.results[p.id] = {};
  markDirty();
  refresh();
  toast('Alle Punkte gelöscht – mit Strg/Cmd+Z rückgängig');
};
$('#btnNewMask').onclick = () => {
  const p = active();
  pushUndo();
  const m = { id: `M${Date.now().toString(36)}`, name: `Maske ${p.masks.length + 1}`, mode: 'hide', feather: 40, points: [], closed: false, enabled: true };
  p.masks.push(m);
  S.activeMaskId = m.id;
  refresh();
};
$('#btnDeleteMask').onclick = () => {
  const p = active();
  const i = p.masks.findIndex((x) => x.id === S.activeMaskId);
  if (i < 0) return;
  pushUndo();
  p.masks.splice(i, 1);
  S.activeMaskId = null;
  markDirty();
  refresh();
};
$('#btnComputeBlend').onclick = computeBlend;
document.querySelectorAll('#rightTabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#rightTabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab-body').forEach((x) => x.classList.toggle('hidden', x.dataset.tab !== b.dataset.tab));
    preview.mode = b.dataset.tab === 'masks' ? 'masks' : b.dataset.tab === 'blend' ? 'blend' : 'points';
    document.querySelectorAll('#rightTabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    refresh();
  };
});
document.querySelectorAll('#viewMode button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#viewMode button').forEach((x) => x.classList.toggle('on', x === b));
    view.setViewMode(b.dataset.view);
  };
});
document.querySelectorAll('#outputMode button').forEach((b) => {
  b.onclick = () => { S.project.view.outputMode = b.dataset.mode; markDirty(); refresh(); };
});
$('#chkShowMask').onchange = (e) => { S.project.view.showMask = e.target.checked; if (e.target.checked && !Object.keys(S.blendImages).length) computeBlend(); markDirty(); refresh(); };
function toolToggle(id, get, set) {
  const b = $(id);
  b.onclick = () => { set(!get()); b.classList.toggle('on', get()); b.setAttribute('aria-pressed', String(get())); refresh(); };
}
toolToggle('#tglCoverage', () => view.showCoverage, (v) => { view.showCoverage = v; });
toolToggle('#tglFrustums', () => view.showFrustums, (v) => { view.showFrustums = v; });
toolToggle('#tglSnap', () => view.snap, (v) => { view.snap = v; });

// Tooltips (ersetzt lange Hilfetexte): erscheinen nach kurzer Verzögerung
(function tooltips() {
  const tip = $('#tooltip');
  let timer, cur;
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t === cur) return;
    cur = t;
    clearTimeout(timer);
    tip.classList.remove('show');
    if (!t) return;
    timer = setTimeout(() => {
      tip.textContent = t.dataset.tip;
      const r = t.getBoundingClientRect();
      tip.style.left = '0px'; tip.style.top = '0px';
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
      let y = r.bottom + 8;
      if (y + h > innerHeight - 8) y = r.top - h - 8;
      tip.style.left = `${x}px`; tip.style.top = `${y}px`;
      tip.classList.add('show');
    }, t.classList.contains('info') ? 150 : 600);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(timer); tip.classList.remove('show'); });
})();
document.body.classList.add(`platform-${api.platform}`);
hydrateIcons();

api.onMenu((cmd) => ({
  new: async () => { await applyProject(newProject()); const { examples } = await api.paths(); loadModelFromPath(`${examples}/Gewoelbedecke_mit_Wandstreifen_16k.obj`); },
  open: () => openProject(),
  save: () => save(),
  saveAs: () => save(true),
  loadModel: chooseModel,
  export: exportTD,
  undo, redo,
  openOutputs: () => toggleOutputs(true),
  closeOutputs: () => toggleOutputs(false),
})[cmd]?.());

// Start: letzte Sitzung wiederherstellen, sonst Beispielmodell laden
(async function start() {
  S.displays = await api.listDisplays();
  // Bildschirme vorbelegen: die beiden größten Nicht-Hauptbildschirme für HDMI A/B
  const ext = S.displays.filter((d) => !d.primary).sort((a, b) => b.pixelSize.width - a.pixelSize.width);
  const { userData, examples } = await api.paths();
  const auto = `${userData}/autosave.kalib.json`;
  let restored = false;
  if (await api.exists(auto)) {
    try {
      await applyProject(JSON.parse(await api.readFile(auto, 'utf8')));
      restored = !!S.model;
      if (restored) toast('Letzte Sitzung wiederhergestellt');
    } catch { /* ignorieren */ }
  }
  if (!restored) {
    await loadModelFromPath(`${examples}/Gewoelbedecke_mit_Wandstreifen_16k.obj`);
  }
  S.project.outputs.forEach((o, i) => {
    if (o.displayId == null || !S.displays.some((d) => d.id === o.displayId)) o.displayId = ext[i]?.id ?? null;
  });
  await syncOpenOutputs();
  refresh();
  window.__app = { S, refresh, scheduleSolve, selectPoint, computeBlend, toggleOutputs, ready: true };
})();
