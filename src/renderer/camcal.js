// Assistent „Mit Kamera kalibrieren“: pro Projektor, Kamera-Standort über einen schon kalibrierten
// Nachbarprojektor oder (erster Projektor) über grobe Punkte von Hand, dann werden Projektor und
// Kamera gemeinsam gelöst. Testmuster (Gray-Code), Schärfe- und Bewegungsprüfung, mehrere Standorte.
// Rechnung: shared/graycode.js (Muster, Dekodierung, Schärfe) und core/autocal.js (3D, Solver).
import { patternPlan, GrayDecoder, filterCells, thinCells, focusMeasure, SHARP_LIMIT } from '../shared/graycode.js';
import { Camera, listCameras } from './camera.js';
import { projectPoint } from '../core/solver.js';

const SELF = '__self'; // Standort über die groben Punkte des Projektors selbst

const SHIFT = 3; // feinste Streifen 8 Projektorpixel; zu feine werden je nach Kameraabstand weggelassen
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function createCamcal(h) {
  const { el, ic, tr, nf, api, S, active, displayName, lensFor, markDirty, refresh, toast, scheduleSolve, toggleOutputs } = h;
  const worker = new Worker(new URL('./camcalWorker.js', import.meta.url), { type: 'module' });
  let seq = 0, meshKey = null;
  const pending = new Map();
  worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); e.data.ok ? p?.resolve(e.data.result) : p?.reject(new Error(e.data.error)); };
  const run = (msg) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });

  const W = {
    step: 'setup', targetId: null, refId: '', cameras: [], cameraId: '', cam: null, source: null,
    busy: false, message: '', progress: null, level: 255, settle: 250, live: false, best: 0, focusNow: 0,
    sessions: [], pose: null, result: null, blur: null, controls: {}, locked: null, abort: false,
  };
  const root = () => document.getElementById('camSheet');
  const target = () => S.project.projectors.find((p) => p.id === W.targetId);
  const refs = () => S.project.projectors.filter((p) => p.id !== W.targetId && p.solution && p.enabled !== false);
  const selfMode = () => W.refId === SELF;
  const canSelf = () => !!target()?.solution;

  // ------------------------------------------------------------ Muster auf den Projektoren
  let pseq = 0;
  const shown = new Map();
  function onShown(msg) {
    const w = shown.get(msg.seq);
    if (!w) return;
    for (const id of msg.mine || []) w.missing.delete(id);
    if (!w.missing.size) { shown.delete(msg.seq); w.resolve(true); }
  }
  function show(projectors, frame) {
    const s = ++pseq;
    const pattern = { projectors, frame, shift: SHIFT, level: W.level, seq: s };
    if (W.source) W.source.pattern = pattern; // Simulation: weiß, was gerade zu sehen ist
    api.broadcast({ type: 'pattern', pattern });
    if (!projectors.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      shown.set(s, { missing: new Set(projectors), resolve });
      setTimeout(() => {
        const w = shown.get(s);
        if (!w) return;
        shown.delete(s);
        resolve(false);
        W.missingOut = [...w.missing];
      }, 2000);
    });
  }
  async function showOrFail(projectors, frame) {
    if (await show(projectors, frame)) return;
    const names = (W.missingOut || projectors).map((id) => displayName(S.project.projectors.find((p) => p.id === id))).join(', ');
    throw new Error(tr(`${names} wird gerade nicht ausgegeben. Ausgänge öffnen und Zuordnung unter „Einrichten“ prüfen.`));
  }
  function clearPattern() {
    if (W.source) W.source.pattern = null;
    api.broadcast({ type: 'pattern', pattern: null });
  }

  // ------------------------------------------------------------ Kamera
  async function openCamera(id = W.cameraId) {
    if (W.simulated) return;
    try {
      W.cam?.close();
      W.cam = await new Camera().open(id);
      W.source = W.cam;
      W.cameraId = W.cam.deviceId || id;
      W.cameras = await listCameras(); // Namen sind erst nach der Freigabe sichtbar
      W.controls = W.cam.controls();
      W.locked = null;
      await W.cam.auto();
      W.message = '';
    } catch (e) {
      W.source = null;
      W.message = e.name === 'NotAllowedError' ? tr('Kein Zugriff auf die Kamera. In den Systemeinstellungen unter Datenschutz die Kamera für Projection Studio erlauben.') : tr(`Kamera: ${e.message}`);
    }
    render();
  }
  /** Für Tests: simulierte Kamera statt echter. */
  function useSource(src) { W.simulated = true; W.source = src; W.controls = src.controls?.() || {}; render(); }

  // Live-Vorschau mit Schärfeanzeige (Schritt „Ausrichten“ und bei Unschärfe)
  async function liveLoop() {
    if (W.live) return;
    W.live = true;
    while (W.live && W.source && !root().classList.contains('hidden')) {
      const f = await W.source.frame(true);
      const v = focusMeasure(f.data, f.w, f.h);
      W.focusNow = v; W.best = Math.max(W.best * 0.999, v);
      const cv = document.getElementById('camPreview');
      if (cv && !W.source.video) {
        if (cv.width !== f.w) { cv.width = f.w; cv.height = f.h; }
        const g = cv.getContext('2d'), img = g.createImageData(f.w, f.h);
        for (let i = 0, j = 0; j < f.data.length; i += 4, j++) { img.data[i] = img.data[i + 1] = img.data[i + 2] = f.data[j]; img.data[i + 3] = 255; }
        g.putImageData(img, 0, 0);
      }
      const bar = document.getElementById('camFocus');
      if (bar) {
        const rel = W.best ? v / W.best : 0;
        bar.firstChild.style.clipPath = `inset(0 ${(100 - Math.min(1, rel) * 100).toFixed(1)}% 0 0)`;
        bar.dataset.state = rel > 0.93 ? 'ok' : rel > 0.75 ? 'mid' : 'low';
      }
      if (W.source.video) await wait(60); // echte Kamera: Vorschau läuft im Video-Element, Schärfe ~15×/s reicht
    }
    W.live = false;
  }
  const stopLive = () => { W.live = false; };

  // ------------------------------------------------------------ Ablauf
  async function open(projectorId) {
    W.targetId = projectorId || active().id;
    const r = refs();
    Object.assign(W, { step: 'setup', sessions: [], pose: null, result: null, blur: null, message: '', busy: false, progress: null, level: 255 });
    W.refId = r.some((p) => p.id === W.refId) ? W.refId : nearestRef(r)?.id || SELF;
    W.start = null;
    root().classList.remove('hidden');
    h.setPlay?.('pause');
    if (!W.simulated) {
      W.cameras = await listCameras();
      if (!W.cameraId) W.cameraId = W.cameras.find((c) => /streamcam|logitech|usb/i.test(c.label))?.deviceId || '';
      await openCamera();
    } else render();
    showAim();
  }
  /** Bezug vorschlagen: kalibrierter Projektor mit der nächsten Nummer im selben Ring. */
  function nearestRef(list) {
    const all = S.project.projectors, ti = all.findIndex((p) => p.id === W.targetId), t = all[ti];
    return [...list].sort((a, b) => (a.ring !== t.ring) - (b.ring !== t.ring) || Math.abs(all.indexOf(a) - ti) - Math.abs(all.indexOf(b) - ti))[0];
  }
  async function showAim() {
    // Ziel und Bezug zeigen das Fokusbild: so lässt sich die Kamera ausrichten und scharfstellen
    const ids = [W.targetId, W.pose || selfMode() ? null : W.refId].filter(Boolean);
    await show(ids, { kind: 'focus' });
    W.best = 0;
    liveLoop();
  }
  function close() {
    stopLive();
    W.abort = true;
    clearPattern();
    if (!W.simulated) { W.cam?.close(); W.cam = null; W.source = null; }
    root().classList.add('hidden');
  }

  async function ensureMesh() {
    const g = S.model?.geometry;
    if (!g) throw new Error(tr('Erst ein 3D-Modell laden.'));
    const key = `${S.project.model.path}|${g.attributes.position.count}`;
    if (meshKey === key) return;
    await run({ kind: 'mesh', positions: g.attributes.position.array, index: g.index?.array || null });
    meshKey = key;
  }

  /** Belichtung festlegen (Weiß darf nicht übersteuern) und Verzögerung Projektor → Kamera messen. */
  async function prepare(ids) {
    const src = W.source;
    W.progress = { text: tr('Belichtung wird eingestellt …'), value: 0 }; render();
    await src.auto?.();
    await showOrFail(ids, { kind: 'white' });
    await wait(W.simulated ? 0 : 1500);
    W.locked = await src.lock?.() || null;
    // Weiß darf nicht übersteuern: je Projektor einzeln prüfen (Überlappungen wären sonst doppelt hell)
    await showOrFail(ids, { kind: 'black' }); await wait(W.simulated ? 0 : 400);
    const b = await src.grab(1);
    for (let k = 0; k < 6; k++) {
      let worst = 0;
      for (const id of ids) {
        await showOrFail([id], { kind: 'white' }); await wait(W.simulated ? 0 : 400);
        const w = await src.grab(1);
        let lit = 0, sat = 0;
        for (let i = 0; i < w.length; i += 7) if (w[i] - b[i] > 12) { lit++; if (w[i] >= 250) sat++; }
        if (lit) worst = Math.max(worst, sat / lit);
      }
      if (worst < 0.02) break;
      if (!(await src.darker?.(0.6))) W.level = Math.max(110, Math.round(W.level * 0.75)); // sonst Projektor dunkler
    }
    // Verzögerung: Schwarz → Weiß, bis die Kamera es sieht
    W.progress = { text: tr('Verzögerung wird gemessen …'), value: 0 }; render();
    await showOrFail(ids, { kind: 'black' }); await wait(W.simulated ? 0 : 400);
    const mean = (f) => { let s = 0; for (let i = 0; i < f.data.length; i += 3) s += f.data[i]; return s / (f.data.length / 3); };
    const b0 = mean(await src.frame(true));
    await showOrFail(ids, { kind: 'white' });
    const t0 = performance.now(), samples = [];
    while (performance.now() - t0 < (W.simulated ? 50 : 1200)) samples.push([performance.now() - t0, mean(await src.frame(true))]);
    const top = samples.at(-1)?.[1] ?? b0;
    const hit = samples.find(([, m]) => m >= b0 + 0.9 * (top - b0));
    W.settle = Math.max(W.simulated ? 0 : 100, Math.min(1000, (hit?.[0] ?? 300) + 70));
  }

  /** Musterfolge für einen Projektor aufnehmen und dekodieren. */
  async function capture(p, label) {
    const src = W.source;
    const plan = patternPlan(p.resolution[0], p.resolution[1], SHIFT);
    const dec = new GrayDecoder(src.width, src.height, plan);
    let white0 = null;
    for (let i = 0; i < plan.frames.length; i++) {
      if (W.abort) throw new Error('abort');
      const f = plan.frames[i];
      W.progress = { text: tr(`${label}: Muster ${i + 1} von ${plan.frames.length}`), value: i / plan.frames.length };
      updateProgress();
      await showOrFail([p.id], f);
      await wait(W.settle);
      const img = await src.grab(W.simulated ? 1 : 2);
      if (f.kind === 'white') white0 = img;
      dec.add(f, img);
      if (f.kind === 'black' && dec.litFraction < 0.002) throw new Error(tr(`Die Kamera sieht kein Licht von ${displayName(p)}. Kamera auf die Fläche dieses Projektors richten.`));
    }
    // Bewegt? Weiß am Ende mit Weiß am Anfang vergleichen
    await showOrFail([p.id], { kind: 'white' }); await wait(W.settle);
    const white1 = await src.grab(W.simulated ? 1 : 2);
    let d = 0, r = 0;
    for (let i = 0; i < white1.length; i += 5) { const rg = white0[i] - dec.black[i]; if (rg >= 12) { d += Math.abs(white1[i] - white0[i]); r += rg; } }
    return { dec, moved: r > 0 && d / r > 0.08, white: white0 };
  }

  /** Aufnehmen mit Schärfe-, Bewegungs- und Plausibilitätsprüfung; greift bei Unschärfe selbst ein. */
  async function captureChecked(p, label) {
    let triedAf = false, repeats = 0;
    for (;;) {
      const c = await capture(p, label);
      if (c.moved && repeats++ < 1) { W.message = tr('Kamera oder Licht hat sich während der Messung verändert. Messung wird wiederholt.'); render(); continue; }
      if (c.moved) throw new Error(tr('Kamera oder Licht verändert sich während der Messung. Kamera fest aufstellen, Raum abdunkeln.'));
      const a = c.dec.assess();
      c.assess = a;
      if (a.sharp >= SHARP_LIMIT) return c;
      // Unschärfe: erst die Kamera nachfokussieren lassen, dann neu messen
      if (!triedAf && W.controls.autofocus) {
        triedAf = true;
        W.progress = { text: tr('Bild ist unscharf. Kamera stellt neu scharf …'), value: 0 }; updateProgress();
        await showOrFail([p.id], { kind: 'focus' });
        const fm = async () => { const f = await W.source.frame(true); return focusMeasure(f.data, f.w, f.h); };
        const before = await fm();
        await W.source.autofocus();
        const after = await fm();
        if (after > before * 1.1) continue; // Kamera war unscharf, jetzt neu messen
      }
      // Weiter unscharf: liegt am Projektor (oder Kamera ohne Fokus-Steuerung) → anhalten und anleiten
      const choice = await askBlur(p, a, triedAf);
      if (choice === 'use') return c;
      if (choice === 'cancel') throw new Error('abort');
      triedAf = false;
    }
  }
  function askBlur(p, a, cameraTried) {
    return new Promise((resolve) => {
      W.blur = { projector: p, sharp: a.sharp, cameraTried, resolve: (v) => { W.blur = null; stopLive(); resolve(v); render(); } };
      render();
      show([p.id], { kind: 'focus' }).then(() => { W.best = 0; liveLoop(); });
    });
  }

  async function measure() {
    const p = target();
    const self = selfMode();
    const ref = W.pose || self ? null : S.project.projectors.find((x) => x.id === W.refId);
    if (self && !canSelf()) { W.message = tr('Erst 4 grobe Punkte von Hand setzen.'); return render(); }
    if (!self && !W.pose && !ref) { W.message = tr('Kein kalibrierter Bezugsprojektor gewählt.'); return render(); }
    stopLive();
    Object.assign(W, { busy: true, message: '', abort: false, step: 'measure' });
    render();
    try {
      await ensureMesh();
      await prepare([p.id, ...(ref ? [ref.id] : [])]);
      const src = W.source;
      let pose = W.pose;
      if (!pose && !self) {
        const r = await captureChecked(ref, displayName(ref));
        const cells = thinCells(filterCells(r.dec.cells(r.assess.drop)), ref.resolution[0], ref.resolution[1], 250);
        W.progress = { text: tr('Kamera-Standort wird berechnet …'), value: 1 }; updateProgress();
        const res = await run({ kind: 'pose', cells, ref: ref.solution, camW: src.width, camH: src.height });
        if (!res.ok) throw new Error(tr(`Kamera-Standort: ${res.message} Kamera so drehen, dass sie mehr von ${displayName(ref)} sieht.`));
        pose = { solution: res.solution, rms: res.solution.rms, used: res.used, refId: ref.id };
      }
      const t = await captureChecked(p, displayName(p));
      const cells = thinCells(filterCells(t.dec.cells(t.assess.drop)), p.resolution[0], p.resolution[1], 300);
      if (cells.length < 12) throw new Error(tr(`Die Kamera sieht zu wenig von ${displayName(p)}. Kamera mehr auf diesen Projektor richten.`));
      const map = t.dec.sharpnessMap(t.assess.probe);
      const session = { sharp: t.assess.sharp, map, white: { data: t.white, w: src.width, h: src.height }, scale: t.assess.scale };
      if (self) {
        // Erster Projektor: kein Bezug, Projektor und Kamera werden gemeinsam gelöst.
        // Die Zellen bleiben roh, jeder weitere Standort rechnet alle zusammen neu.
        W.start ||= p.solution; // Startwert bleibt für alle Standorte derselbe
        W.sessions.push({ ...session, cells, camW: src.width, camH: src.height, group: `${W.cameraId}|${src.width}x${src.height}` });
        W.progress = { text: tr('Projektor und Kamera werden gemeinsam berechnet …'), value: 1 }; updateProgress();
        const before = W.result;
        await solve();
        if (!W.result?.ok) {
          const msg = W.result?.message;
          W.sessions.pop(); W.result = before;
          throw new Error(msg || tr('Keine Lösung gefunden.'));
        }
        W.step = 'result';
      } else {
        W.progress = { text: tr('Punkte werden berechnet …'), value: 1 }; updateProgress();
        const points = await run({ kind: 'points', cells, cam: pose.solution });
        W.sessions.push({ ...session, points, poseRms: pose.rms });
        W.pose = pose;
        await solve();
        W.step = 'result';
      }
    } catch (e) {
      W.step = W.sessions.length && W.result?.ok && e.message === 'abort' ? 'result' : 'setup';
      if (e.message !== 'abort') W.message = e.message;
    }
    W.busy = false; W.progress = null;
    if (!root().classList.contains('hidden')) { await show([], { kind: 'black' }); render(); if (W.step === 'setup') showAim(); }
  }

  async function solve() {
    const p = target();
    if (selfMode()) {
      W.result = await run({ kind: 'self', opts: {
        start: W.start, sessions: W.sessions.map(({ cells, camW, camH, group }) => ({ cells, camW, camH, group })),
        manual: p.points, width: p.resolution[0], height: p.resolution[1], lens: lensFor(p, S.project), mountMode: p.mountMode,
      } });
      return;
    }
    const points = W.sessions.flatMap((s) => s.points);
    W.result = await run({ kind: 'solve', opts: { points, width: p.resolution[0], height: p.resolution[1], lens: lensFor(p, S.project), mountMode: p.mountMode, previous: p.solution, pixelSigma: 1 } });
  }

  /** Weiterer Kamera-Standort: Kamera umstellen, Standort neu bestimmen. */
  function another() {
    W.pose = null;
    W.step = 'setup';
    if (!selfMode()) W.refId = nearestRef(refs())?.id || '';
    render();
    showAim();
  }

  function apply() {
    const p = target(), res = W.result;
    if (!res?.ok) return;
    const pts = thinCells(res.points.map((x) => ({ u: x.image[0], v: x.image[1], x: 0, y: 0, pt: x })), p.resolution[0], p.resolution[1], 400).map((c) => c.pt);
    p.autoPoints = pts.map((x) => ({ world: x.world.map((v) => +v.toFixed(5)), image: [+x.image[0].toFixed(2), +x.image[1].toFixed(2)] }));
    p.autoCal = { date: new Date().toISOString(), positions: W.sessions.length, sharp: +Math.min(...W.sessions.map((s) => s.sharp)).toFixed(2), ...(selfMode() ? { self: true } : {}) };
    // Erster Projektor: die groben Startpunkte würden die Kamera-Lösung nur verziehen, sie werden abgewählt
    let off = 0;
    if (selfMode()) {
      const lim = Math.max(4, 3 * res.solution.rms);
      for (const x of p.points) {
        if (!x.enabled || !x.world || !x.image) continue;
        const q = projectPoint(res.solution, x.world);
        if (!(q.z > 0) || Math.hypot(q.u - x.image[0], q.v - x.image[1]) > lim) { x.enabled = false; off++; }
      }
    }
    scheduleSolve(p);
    markDirty();
    close();
    refresh();
    toast(tr(`${displayName(p)}: ${pts.length} Kamera-Punkte übernommen`) + (off ? ` · ${tr(`${off} grobe Punkte abgewählt`)}` : ''));
  }

  // ------------------------------------------------------------ Oberfläche
  function preview() {
    const v = W.source?.video;
    if (v) { v.className = 'cam-video'; return el('div', { class: 'cam-view' }, v); }
    return el('div', { class: 'cam-view' }, el('canvas', { id: 'camPreview', class: 'cam-video' }));
  }
  function focusBar(label = 'Schärfe') {
    return el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, label, el('span', { class: 'sub' }, 'Bestwert der letzten Sekunden = voller Balken'))),
      el('div', { class: 'ctl' }, el('div', { class: 'meter big cam-focus', id: 'camFocus', style: 'width:100%' }, el('i'))));
  }
  const pname = (id) => displayName(S.project.projectors.find((x) => x.id === id));

  function setupStep() {
    const p = target(), r = refs();
    const outputsOk = S.openOutputs?.size > 0;
    const camRow = W.simulated ? null : el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Kamera')),
      el('div', { class: 'ctl' }, el('select', { onchange: (e) => { W.cameraId = e.target.value; openCamera(e.target.value).then(showAim); } },
        ...(W.cameras.length ? W.cameras : [{ deviceId: '', label: 'Standardkamera' }]).map((c) => el('option', { value: c.deviceId, selected: c.deviceId === W.cameraId }, c.label || 'Kamera')))));
    const self = selfMode(), locked = W.sessions.length > 0; // Art des Bezugs bleibt für alle Standorte gleich
    const refRow = W.pose
      ? el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Kamera-Standort')), el('div', { class: 'ctl' }, el('span', { class: 'muted' }, 'bekannt, Kamera nicht bewegen')))
      : el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Standort über'),
        h.infoBtn('Grobe Punkte: 4 oder mehr von Hand gesetzte Punkte dieses Projektors reichen als Startwert, auch wenn sie ungenau sind. Projektor und Kamera werden dann gemeinsam gelöst, jeder weitere Kamera-Standort macht das Ergebnis genauer. Kalibrierter Projektor: Die Kamera bestimmt ihren Standort über einen Nachbarn, den sie mit sieht.')),
        el('div', { class: 'ctl' }, locked && self
          ? el('span', { class: 'muted' }, 'grobe Punkte dieses Projektors')
          : el('select', { id: 'camRef', onchange: (e) => { W.refId = e.target.value; render(); showAim(); } },
            locked ? null : el('option', { value: SELF, selected: self }, 'Grobe Punkte dieses Projektors'),
            ...r.map((x) => el('option', { value: x.id, selected: x.id === W.refId }, tr(`${displayName(x)} (kalibriert)`))))));
    const ctl = W.controls;
    const notes = [];
    if (self && !canSelf()) notes.push('Erst 4 grobe Punkte von Hand setzen. Sie müssen nicht genau sein, die Kamera übernimmt die Feinarbeit.');
    if (!outputsOk) notes.push('Die Ausgänge sind geschlossen. Zum Messen müssen die Projektoren Bild bekommen.');
    if (W.source && !W.simulated && !ctl.exposure) notes.push('Die Belichtung dieser Kamera lässt sich nicht feststellen. Raum abdunkeln, dann ist das Ergebnis trotzdem gut.');
    return [
      el('h1', {}, tr(`${displayName(p)} mit Kamera kalibrieren`)),
      el('p', { class: 'lead' }, self
        ? W.sessions.length
          ? 'Kamera an einen neuen Standort stellen, so dass sie den fehlenden Teil des Projektorbilds sieht. Etwas Überschneidung mit dem vorigen Standort ist gut.'
          : 'Kamera fest aufstellen (Stativ), so dass sie möglichst viel von diesem Projektor sieht. Er zeigt jetzt ein Schachbrett. Sieht die Kamera nicht alles, kommen danach weitere Standorte dazu.'
        : W.sessions.length
          ? 'Kamera an einen neuen Standort stellen, so dass sie den fehlenden Teil des Projektorbilds und einen kalibrierten Projektor sieht.'
          : 'Kamera fest aufstellen (Stativ), so dass sie möglichst viel von diesem Projektor und einen Teil eines kalibrierten Nachbarn sieht. Beide zeigen jetzt ein Schachbrett.'),
      preview(),
      el('div', { class: 'group' }, camRow, refRow, focusBar(),
        ctl.autofocus ? el('div', { class: 'r' }, el('div', { class: 'lbl' }), el('div', { class: 'ctl' }, el('button', { class: 'btn', onclick: async () => { await W.source.autofocus(); W.best = 0; } }, 'Kamera scharfstellen'))) : null),
      notes.length ? el('div', { class: 'notes cam-notes' }, ...notes.map((t) => el('div', {}, ic('alert', 14), el('span', {}, t)))) : null,
      !outputsOk ? el('button', { class: 'btn', onclick: async () => { await toggleOutputs(true); render(); showAim(); } }, 'Ausgänge öffnen') : null,
      W.message ? el('p', { class: 'lead tune-msg bad' }, W.message) : null,
    ];
  }
  function updateProgress() {
    const pr = W.progress, t = document.getElementById('camProgText'), b = document.getElementById('camProg');
    if (t && pr) t.textContent = pr.text;
    if (b && pr) b.firstChild.style.clipPath = `inset(0 ${(100 - pr.value * 100).toFixed(1)}% 0 0)`;
  }
  function measureStep() {
    if (W.blur) return blurStep();
    return [
      el('h1', {}, 'Misst …'),
      el('p', { class: 'lead' }, 'Die Projektoren zeigen nacheinander Streifenmuster. Kamera nicht bewegen, Licht nicht verändern.'),
      el('div', { class: 'meter big cam-prog', id: 'camProg' }, el('i')),
      el('p', { class: 'lead tune-msg', id: 'camProgText' }, W.progress?.text || ''),
      W.message ? el('p', { class: 'lead tune-msg' }, W.message) : null,
    ];
  }
  function blurStep() {
    const b = W.blur, name = displayName(b.projector);
    const cam = W.controls.autofocus && b.cameraTried;
    return [
      el('h1', {}, 'Bild ist unscharf'),
      el('p', { class: 'lead' }, cam
        ? tr(`Die Kamera hat neu scharfgestellt, das hat nicht geholfen. Wahrscheinlich ist ${name} unscharf: Fokusring am Projektor drehen, bis der Balken ganz voll ist.`)
        : W.controls.focus || W.controls.autofocus
          ? tr(`${name} oder die Kamera ist unscharf. Erst den Fokusring am Projektor drehen, bis der Balken voll ist. Hilft das nicht, „Kamera scharfstellen“.`)
          : tr(`${name} oder die Kamera ist unscharf. Fokusring am Projektor drehen, bis der Balken voll ist. Hilft das nicht, die Kamera näher heran oder an ihrem Objektiv scharfstellen.`)),
      preview(),
      el('div', { class: 'group' }, focusBar(),
        el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Gemessen')), el('div', { class: 'ctl' }, el('span', { class: 'muted' }, tr(`Kontrast feiner Streifen ${Math.round(b.sharp * 100)} % (gut ab ${Math.round(SHARP_LIMIT * 100)} %)`)))),
        W.controls.autofocus ? el('div', { class: 'r' }, el('div', { class: 'lbl' }), el('div', { class: 'ctl' }, el('button', { class: 'btn', onclick: async () => { await W.source.autofocus(); W.best = 0; } }, 'Kamera scharfstellen'))) : null),
    ];
  }
  function resultStep() {
    const res = W.result, p = target();
    const last = W.sessions.at(-1);
    const rep = res?.report;
    const tips = [...(rep?.tips || [])];
    const blurTiles = last.map.values.filter((v) => v !== null && v < SHARP_LIMIT).length / Math.max(1, last.map.values.filter((v) => v !== null).length);
    if (blurTiles > 0.25) tips.push('Teile des Bilds sind unscharf (siehe Karte). Auf gewölbten Flächen den Projektorfokus auf die Mitte der Fläche stellen. Unscharfe Stellen werden gröber gemessen.');
    if (selfMode() && res?.ok && res.joint?.camRms > 1.5) tips.push(tr(`Kamera und Projektor passen nicht gut zusammen (${nf(res.joint.camRms, 1)} px). Stand die Kamera fest? Sonst die groben Punkte prüfen.`));
    if (selfMode() && res?.ok && W.sessions.length === 1) tips.push('Ohne kalibrierten Nachbarn wird das Ergebnis mit jedem weiteren Kamera-Standort deutlich genauer, besonders an den Bildrändern.');
    if (W.pose?.rms > 3) tips.push(tr(`Kamera-Standort ungenau (${nf(W.pose.rms, 1)} px). Ist der Bezugsprojektor gut kalibriert und die Kamera fest?`));
    const ok = res?.ok;
    return [
      el('h1', {}, 'Ergebnis'),
      el('div', { class: `status ${ok && res.solution.rms < 3 && !tips.length ? 'ok' : 'warn'}` },
        el('div', { class: 'head' }, el('div', { class: 'ic-wrap' }, ic(ok ? 'check' : 'alert', 16)),
          el('div', {}, el('b', {}, ok ? tr(`Fehler ${nf(res.solution.rms, 2)} px · ${res.used} Punkte`) : 'Keine Lösung'),
            el('span', {}, ok ? tr(`${W.sessions.length} Kamera-Standort(e) · ${res.dropped} Ausreißer verworfen · Bild zu ${Math.round(rep.filled * 100)} % abgedeckt`) : res?.message || '')))),
      el('div', { class: 'cam-maps' },
        el('div', {}, el('b', {}, 'Abdeckung im Projektorbild'), coverageGrid(rep, p)),
        el('div', {}, el('b', {}, 'Schärfe im Kamerabild'), sharpMap(last))),
      tips.length ? el('div', { class: 'notes cam-notes' }, ...tips.map((t) => el('div', {}, ic('alert', 14), el('span', {}, t)))) : null,
    ];
  }
  function coverageGrid(rep, p) {
    const ar = p.resolution[0] / p.resolution[1];
    return el('div', { class: 'cam-cov', style: `aspect-ratio:${ar.toFixed(3)};grid-template-columns:repeat(${rep.gx},1fr)` },
      ...rep.grid.map((v) => el('i', { class: v ? 'on' : '' })));
  }
  function sharpMap(s) {
    const c = el('canvas', { class: 'cam-sharp', width: 320, height: Math.round((320 * s.white.h) / s.white.w) });
    requestAnimationFrame(() => {
      const g = c.getContext('2d'), { w, h, data } = s.white, img = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const v = data[Math.floor((y * h) / c.height) * w + Math.floor((x * w) / c.width)], i = (y * c.width + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v * 0.7; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const { tx, ty, values } = s.map;
      values.forEach((v, t) => {
        if (v === null) return;
        g.fillStyle = v >= 0.6 ? 'rgba(48,161,78,0.45)' : v >= SHARP_LIMIT ? 'rgba(227,163,63,0.5)' : 'rgba(217,75,67,0.55)';
        g.fillRect(((t % tx) * c.width) / tx, (Math.floor(t / tx) * c.height) / ty, c.width / tx - 1, c.height / ty - 1);
      });
    });
    return c;
  }

  function render() {
    const r = root();
    if (!r || r.classList.contains('hidden')) return;
    const body = W.step === 'setup' ? setupStep() : W.step === 'measure' ? measureStep() : resultStep();
    const canMeasure = !!W.source && (W.pose || (selfMode() ? canSelf() : refs().some((x) => x.id === W.refId))) && S.openOutputs?.size > 0;
    const foot = W.blur
      ? [el('button', { class: 'btn', onclick: () => W.blur.resolve('cancel') }, 'Abbrechen'),
        el('button', { class: 'btn', onclick: () => W.blur.resolve('use') }, 'Trotzdem verwenden'),
        el('button', { class: 'btn primary', id: 'btnCamRetry', onclick: () => W.blur.resolve('retry') }, 'Erneut messen')]
      : W.step === 'setup'
        ? [el('button', { class: 'btn', onclick: close }, 'Abbrechen'),
          W.sessions.length ? el('button', { class: 'btn', onclick: () => { W.step = 'result'; render(); } }, 'Zurück zum Ergebnis') : null,
          el('button', { class: 'btn primary', id: 'btnCamMeasure', disabled: !canMeasure || W.busy, onclick: measure }, 'Messen')]
        : W.step === 'measure'
          ? [el('button', { class: 'btn', onclick: () => { W.abort = true; } }, 'Abbrechen')]
          : [el('button', { class: 'btn', onclick: another, id: 'btnCamAnother' }, 'Weiterer Standort'),
            el('button', { class: 'btn primary', onclick: apply, id: 'btnCamApply', disabled: !W.result?.ok }, 'Übernehmen')];
    r.replaceChildren(el('div', { class: 'sheet tune cam' },
      el('div', { class: 'body' }, ...body),
      el('div', { class: 'foot' }, el('div', { class: 'dots' }, ...['setup', 'measure', 'result'].map((s) => el('i', { class: s === W.step ? 'on' : '' }))), ...foot.filter(Boolean))));
    updateProgress();
  }

  return { open, close, render, onShown, useSource, state: W };
}
