// Vollbild-Ausgabe auf einem Bildschirm (z. B. 4K-HDMI mit 4 Projektor-Quadranten).
// Zeichnet nur bei Änderungen neu (spart GPU, wenn TD parallel läuft).
import * as THREE from 'three';
import { buildModel, applySolutionToCamera, makeUvGridTexture } from '../shared/scene.js';
import { quadrantRect } from '../shared/project.js';
import { renderMaskCanvas } from '../shared/masks.js';
import { PlaylistPlayer } from '../shared/playlistPlayer.js';
import { isIdentity, makeWarp } from '../shared/warp.js';
import { drawWarpOverlay } from '../shared/warpdraw.js';
import { tr, setLang } from '../shared/i18n.js';
import { stripeRuns, focusValue } from '../shared/graycode.js';

// Rohe Farbwerte durchreichen: Video, Masken und Testbilder werden 1:1 ausgegeben.
THREE.ColorManagement.enabled = false;

const api = window.api;
const params = new URLSearchParams(location.search);
let outputId = params.get('name') || 'A';

const glCanvas = document.getElementById('gl');
const maskCanvas = document.getElementById('mask');
const ovCanvas = document.getElementById('overlay');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
renderer.autoClear = false;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
maskCanvas.style.display = 'none';
const ov = ovCanvas.getContext('2d');

const st = { pattern: null, project: null, activeId: null, activePointId: null, modelPath: null, model: null, blend: {}, blendImgs: {}, mouse: null, play: null, warpEdit: false, markers: true, activeHandle: null, activePin: null };

// ---------------- GPU-Zusammensetzung pro Projektor: 3D-Bild -> Feinkorrektur -> Maske
const rts = new Map(); // projectorId -> WebGLRenderTarget
const maskTex = new Map(); // projectorId -> { canvas, tex, key }
const compCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const compMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: {
    tScene: { value: null }, tMask: { value: null }, uMaskOn: { value: 0 },
    tWarp: { value: null }, uWarpOn: { value: 0 },
  },
  vertexShader: 'out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D tScene;
uniform sampler2D tMask;
uniform int uMaskOn;
uniform sampler2D tWarp; // Verschiebung Quelle - Ziel, aus inverseMap()
uniform int uWarpOn;
void main() {
  vec2 q = vec2(vUv.x, 1.0 - vUv.y);
  vec2 p = uWarpOn == 1 ? q + texture(tWarp, q).rg : q;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, vec2(1.0)))) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 s = vec2(p.x, 1.0 - p.y);
  vec4 c = texture(tScene, s);
  if (uMaskOn == 1) c.rgb *= texture(tMask, s).r;
  outColor = vec4(c.rgb, 1.0);
}`,
  depthTest: false, depthWrite: false,
});
const compScene = new THREE.Scene();
compScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compMat));

function rtFor(id, w, h) {
  let rt = rts.get(id);
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (!rt) { rt = new THREE.WebGLRenderTarget(w, h, { samples: 4 }); rts.set(id, rt); }
  else if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
  return rt;
}

/** Maske eines Projektors (Überblendung × eigene Masken) als Textur, nur bei Änderung neu. */
function maskFor(p) {
  const img = st.blendImgs[p.id];
  const key = `${img?.src?.length || 0}|${img?.complete}|${p.masks ? keyOf(p.masks) : ''}`;
  let m = maskTex.get(p.id);
  if (m && m.key === key) return m.tex;
  if (!m) {
    const canvas = document.createElement('canvas');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    m = { canvas, tex, key: '' };
    maskTex.set(p.id, m);
  }
  const W = Math.round(p.resolution[0] / 2), H = Math.round(p.resolution[1] / 2);
  m.canvas.width = W; m.canvas.height = H;
  const g = m.canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  if (img?.complete) g.drawImage(img, 0, 0, W, H);
  if (p.masks?.length) {
    g.globalCompositeOperation = 'multiply';
    g.drawImage(renderMaskCanvas(p.masks, p.resolution[0], p.resolution[1], 0.25), 0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }
  m.key = key;
  m.tex.needsUpdate = true;
  return m.tex;
}
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera();
let mesh, lines, gridTex, planarGeom;
const mats = {
  black: new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }),
  white: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  grid: null,
  video: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
};

// ---------------- Video (Playlist, siehe shared/playlistPlayer.js)
const textures = new Map();
const player = new PlaylistPlayer(() => {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  const tex = new THREE.VideoTexture(v);
  tex.colorSpace = THREE.NoColorSpace;
  textures.set(v, tex);
  v.addEventListener('loadedmetadata', () => { syncVideo(); draw(); });
  v.addEventListener('seeked', () => { if (v === video) draw(false); });
  v.requestVideoFrameCallback(function cb(now, meta) {
    if (v === video) {
      const pb = st.project?.playback;
      if (pb?.precise) player.frameSync(v, meta, pb, st.play, outputDelay());
      onFrame(now);
    }
    v.requestVideoFrameCallback(cb);
  });
  return v;
}, (v) => { video = v; mats.video.map = textures.get(v); mats.video.needsUpdate = true; draw(false); });
let video = player.el;
mats.video.map = textures.get(video);

/** Auf die gemeinsame Uhr abgleichen. Läuft alle 250 ms und bei jeder Zustandsänderung. */
function syncVideo() {
  if (st.project?.view.outputMode !== 'video') return player.stop();
  player.sync(st.project.playback, st.play, 0, outputDelay());
}
/** Verzögerung dieses Ausgangs in ms (Präzise Synchronisierung). */
function outputDelay() {
  const pb = st.project?.playback;
  if (!pb?.precise) return 0;
  return Number(st.project.outputs.find((o) => o.id === outputId)?.delayMs) || 0;
}
setInterval(syncVideo, 250);
// Bildrate begrenzen (Wiedergabe → Bildrate): Videobilder, die zu früh kommen, werden ausgelassen.
let lastVideoDraw = 0;
function onFrame(now) {
  const cap = st.project?.playback?.fps || 0;
  if (!cap || now - lastVideoDraw >= 1000 / cap - 4) { lastVideoDraw = now; draw(false); }
  // Ende des Eintrags: sofort weiter, nicht erst beim nächsten Abgleich
  if (video.duration > 0 && video.currentTime >= video.duration - 0.06 && !video.loop) syncVideo();
}

/** Planare Abbildung von oben (Draufsicht): Norden (−z) oben, Grundriss füllt das Video. */
function planarGeometry() {
  if (planarGeom) return planarGeom;
  const g = st.model.geometry.clone();
  g.computeBoundingBox();
  const b = g.boundingBox, P = g.attributes.position;
  const sx = b.max.x - b.min.x || 1, sz = b.max.z - b.min.z || 1;
  const uv = new Float32Array(P.count * 2);
  for (let i = 0; i < P.count; i++) {
    uv[i * 2] = (P.getX(i) - b.min.x) / sx;
    uv[i * 2 + 1] = 1 - (P.getZ(i) - b.min.z) / sz;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return (planarGeom = g);
}
/** Video drehen (Wiedergabe → Drehen, im Uhrzeigersinn): nur die Texturmatrix, kostet nichts. */
function rotateVideo() {
  const t = mats.video.map;
  const r = -(((Number(st.project.playback?.rotate) || 0) % 360) * Math.PI) / 180;
  if (t && t.rotation !== r) { t.center.set(0.5, 0.5); t.rotation = r; }
}
const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  for (const c of [maskCanvas, ovCanvas]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  draw();
}
window.addEventListener('resize', resize);

async function ensureModel(path) {
  if (!path || path === st.modelPath) return;
  st.modelPath = path;
  const text = await api.readFile(path, 'utf8');
  st.model = buildModel(text);
  planarGeom = null;
  scene.clear();
  mesh = new THREE.Mesh(st.model.geometry, mats.black);
  lines = new THREE.LineSegments(st.model.edges, lineMat);
  scene.add(mesh, lines);
}

function myProjectors() {
  if (!st.project) return [];
  const out = st.project.outputs.find((o) => o.id === outputId);
  // Testausgang: nur der gewählte Projektor, im ganzen Bild
  if (out?.solo) return st.project.projectors.filter((p) => p.id === st.activeId).map((p) => ({ p, rect: { x: 0, y: 0, w: 1, h: 1 } }));
  return st.project.projectors
    .filter((p) => p.output === outputId && p.enabled)
    .map((p) => ({ p, rect: quadrantRect(out, p.quadrant) }));
}

let queued = false, needFull = true;
/** full = false: nur 3D-Ebene (Videobilder). Masken und Overlay werden nur bei Änderungen neu gezeichnet. */
function draw(full = true) {
  needFull ||= full;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; const f = needFull; needFull = false; drawNow(f); });
}

// Leistung: Bilder pro Sekunde und Zeichenzeit, alle 2 s an das Hauptfenster
const perf = { frames: 0, ms: 0, since: performance.now(), dropped0: 0 };
const warpTex = new Map(); // projectorId -> { key, tex, on, fine }
// Vergleichsschlüssel je Objekt nur einmal bilden: Projektdaten kommen pro Nachricht als neue Objekte,
// zwischen zwei Nachrichten (z. B. bei jedem Videobild) bleibt es bei einem Nachschlagen.
const keyCache = new WeakMap();
function keyOf(obj) {
  if (!obj) return '';
  let k = keyCache.get(obj);
  if (k === undefined) { k = JSON.stringify(obj); keyCache.set(obj, k); }
  return k;
}
const WMAP_COARSE = [160, 90], WMAP_FINE = [480, 270];
const warpWorker = new Worker(new URL('./warpWorker.js', import.meta.url), { type: 'module' });
const warpBusy = new Map(); // projectorId -> { key, size } gerade in Arbeit
const warpNext = new Map(); // projectorId -> nächster Auftrag, falls noch einer läuft
const warpTimers = new Map();
/**
 * Umkehrtabelle der Feinkorrektur als Textur (RG, Half Float, linear gefiltert), nur bei Änderung neu
 * und im Hintergrund-Thread. Während des Ziehens grob (schnell), kurz danach fein (Fehler unter 0,2 px).
 * Bis die neue Tabelle da ist, bleibt die vorige sichtbar.
 */
function warpTextureFor(p) {
  const wp = p.warp;
  const key = keyOf(wp);
  let c = warpTex.get(p.id);
  if (c && c.key === key) return c;
  if (c?.pending !== key) {
    const on = !isIdentity(wp);
    c = { ...(c || {}), pending: key, key: on ? c?.key : key, on: on ? !!c?.on : false };
    warpTex.set(p.id, c);
    if (on) {
      requestWarp(p.id, key, wp, WMAP_COARSE);
      clearTimeout(warpTimers.get(p.id));
      warpTimers.set(p.id, setTimeout(() => { if (warpTex.get(p.id)?.pending === key) requestWarp(p.id, key, wp, WMAP_FINE); }, 300));
    }
  }
  return c;
}
function requestWarp(id, key, warp, [mw, mh]) {
  const job = { id, key, warp, mw, mh };
  if (warpBusy.get(id)) { warpNext.set(id, job); return; } // nur der neueste wartende Auftrag zählt
  warpBusy.set(id, true);
  warpWorker.postMessage(job);
}
warpWorker.onmessage = (e) => {
  const { id, key, mw, mh, half } = e.data;
  warpBusy.set(id, false);
  const next = warpNext.get(id);
  if (next) { warpNext.delete(id); requestWarp(next.id, next.key, next.warp, [next.mw, next.mh]); }
  const c = warpTex.get(id);
  if (!c || c.pending !== key) return; // veraltet
  let tex = c.tex;
  if (tex && (tex.image.width !== mw || tex.image.height !== mh)) { tex.dispose(); tex = null; }
  if (!tex) {
    tex = new THREE.DataTexture(half, mw, mh, THREE.RGFormat, THREE.HalfFloatType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
  } else tex.image.data = half;
  tex.needsUpdate = true;
  warpTex.set(id, { ...c, key, tex, on: true });
  draw(false);
};

function reportPerf() {
  const now = performance.now(), dt = (now - perf.since) / 1000;
  if (dt < 2) return;
  const q = video?.getVideoPlaybackQuality?.();
  const dropped = q ? q.droppedVideoFrames - perf.dropped0 : 0;
  const playing = st.project?.view.outputMode === 'video' && !!st.play?.playing;
  api.sendOutputEvent({ type: 'stats', outputId, playing, fps: perf.frames / dt, ms: perf.frames ? perf.ms / perf.frames : 0, dropped: playing ? Math.max(0, dropped) : 0 });
  perf.frames = 0; perf.ms = 0; perf.since = now; perf.dropped0 = q ? q.droppedVideoFrames : 0;
}

function drawNow(full = true) {
  const t0 = performance.now();
  drawFrame(full);
  perf.frames++; perf.ms += performance.now() - t0;
  reportPerf();
}

function drawFrame(full = true) {
  const Wc = glCanvas.width, Hc = glCanvas.height;
  renderer.setScissorTest(false);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  if (full) {
    ov.setTransform(1, 0, 0, 1, 0, 0);
    ov.clearRect(0, 0, ovCanvas.width, ovCanvas.height);
  }
  if (!st.project) return;
  if (st.pattern) { if (full) drawPattern(Wc, Hc); return; }
  const mode = st.project.view.outputMode;
  const showMask = st.project.view.showMask;
  const dpr = renderer.getPixelRatio();
  for (const { p, rect } of myProjectors()) {
    const x = rect.x * Wc, y = rect.y * Hc, w = rect.w * Wc, h = rect.h * Hc;
    const active = p.id === st.activeId;
    // 3D-Inhalt durch die kalibrierte Kamera
    if (p.solution && st.model && mode !== 'black' && mode !== 'ident') {
      applySolutionToCamera(cam, p.solution, st.model.radius / 200, st.model.radius * 20);
      const rt = rtFor(p.id, w, h);
      mesh.geometry = mode === 'video' && st.project.playback?.mapping !== 'uv' ? planarGeometry() : st.model.geometry;
      if (mode === 'video') rotateVideo();
      mesh.material = mode === 'video' ? mats.video : mode === 'white' ? mats.white : mode === 'grid' ? (mats.grid ||= new THREE.MeshBasicMaterial({ map: (gridTex ||= makeUvGridTexture()), side: THREE.DoubleSide })) : mats.black;
      lines.visible = mode === 'edges';
      lineMat.color.set(active ? '#ffffff' : '#bbbbbb');
      // 1) 3D-Bild in eigenes Bild rendern
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      // 2) Feinkorrektur und Maske auf der GPU, in den Quadranten (GL: Ursprung unten links, CSS-Pixel)
      const u = compMat.uniforms;
      u.tScene.value = rt.texture;
      u.uMaskOn.value = showMask ? 1 : 0;
      if (showMask) u.tMask.value = maskFor(p);
      const wt = warpTextureFor(p);
      u.uWarpOn.value = wt.on ? 1 : 0;
      if (wt.on && wt.tex) u.tWarp.value = wt.tex; else u.uWarpOn.value = 0;
      renderer.setViewport(x / dpr, (Hc - y - h) / dpr, w / dpr, h / dpr);
      renderer.setScissor(x / dpr, (Hc - y - h) / dpr, w / dpr, h / dpr);
      renderer.setScissorTest(true);
      renderer.render(compScene, compCam);
      renderer.setScissorTest(false);
    }
    if (!full) continue;
    // Overlay: Rahmen, Kennung, Punkte (nicht während der Videowiedergabe)
    if (mode === 'video') continue;
    const sx = w / p.resolution[0], sy = h / p.resolution[1];
    ov.save();
    ov.translate(x, y);
    ov.beginPath(); ov.rect(0, 0, w, h); ov.clip();
    const lw = Math.max(2, 3 * dpr);
    if (mode !== 'black' || active) {
      ov.strokeStyle = p.color;
      ov.lineWidth = active ? lw * 2 : lw;
      ov.strokeRect(ov.lineWidth / 2, ov.lineWidth / 2, w - ov.lineWidth, h - ov.lineWidth);
    }
    if (mode === 'ident' || !p.solution) {
      ov.fillStyle = p.color;
      ov.font = `bold ${h * 0.28}px -apple-system, Segoe UI, sans-serif`;
      ov.textAlign = 'center'; ov.textBaseline = 'middle';
      ov.fillText(p.name, w / 2, h / 2);
      ov.font = `${h * 0.04}px -apple-system, Segoe UI, sans-serif`;
      ov.fillText(`${outputId} · ${tr(p.ring)}`, w / 2, h * 0.7);
      ov.textAlign = 'left'; ov.textBaseline = 'alphabetic';
    }
    if (active && st.warpEdit && p.warp) {
      drawWarpGrid(p.warp, w, h, dpr);
    } else if (active && st.markers) {
      const wev = makeWarp(p.warp);
      for (const pt of p.points) {
        if (!pt.image) continue;
        const [fu, fv] = wev.forward(pt.image[0] / p.resolution[0], pt.image[1] / p.resolution[1]);
        const u = fu * w, v = fv * h;
        const isA = pt.id === st.activePointId;
        if (isA) {
          // großes Fadenkreuz über das ganze Bild
          ov.strokeStyle = 'rgba(77,163,255,0.9)';
          ov.lineWidth = 2 * dpr;
          ov.beginPath(); ov.moveTo(0, v); ov.lineTo(w, v); ov.moveTo(u, 0); ov.lineTo(u, h); ov.stroke();
          ov.strokeStyle = '#ffffff';
          ov.lineWidth = 3 * dpr;
          ov.beginPath(); ov.arc(u, v, 22 * dpr, 0, Math.PI * 2); ov.stroke();
        }
        ov.strokeStyle = isA ? '#4da3ff' : pt.enabled ? '#ffffff' : '#666';
        ov.lineWidth = 2 * dpr;
        ov.beginPath(); ov.arc(u, v, 9 * dpr, 0, Math.PI * 2); ov.stroke();
        ov.beginPath(); ov.moveTo(u - 4 * dpr, v); ov.lineTo(u + 4 * dpr, v); ov.moveTo(u, v - 4 * dpr); ov.lineTo(u, v + 4 * dpr); ov.stroke();
        ov.fillStyle = ov.strokeStyle;
        ov.font = `bold ${16 * dpr}px -apple-system, Segoe UI, sans-serif`;
        ov.fillText(String(pt.id), u + 12 * dpr, v - 12 * dpr);
      }
    }
    ov.restore();
  }
  // lokales Maus-Fadenkreuz
  if (st.mouse && full && st.project?.view.outputMode !== 'video') {
    const { cx, cy } = st.mouse;
    ov.strokeStyle = '#ffff00';
    ov.lineWidth = 2 * dpr;
    const r = 30 * dpr;
    ov.beginPath(); ov.moveTo(cx - r, cy); ov.lineTo(cx + r, cy); ov.moveTo(cx, cy - r); ov.lineTo(cx, cy + r); ov.stroke();
  }
}

// ---------------- Testmuster für die Kamera-Kalibrierung
// Pixelgenau im Eingangssignal des Projektors, ohne Feinkorrektur und Maske. Alle anderen Projektoren
// bleiben schwarz, damit nur dieser Projektor Licht gibt.
const focusCache = new Map();
function focusImage(W, H, shift) {
  const k = `${W}x${H}/${shift}`;
  let c = focusCache.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const i = (v * W + u) * 4, val = focusValue(u, v, shift) * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = val; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  focusCache.clear();
  focusCache.set(k, c);
  return c;
}
function drawPattern(Wc, Hc) {
  const pt = st.pattern;
  ov.setTransform(1, 0, 0, 1, 0, 0);
  ov.fillStyle = '#000';
  ov.fillRect(0, 0, Wc, Hc);
  const mine = myProjectors().filter(({ p }) => pt.projectors.includes(p.id));
  for (const { p, rect } of mine) {
    const x = rect.x * Wc, y = rect.y * Hc, w = rect.w * Wc, h = rect.h * Hc;
    const [W, H] = p.resolution, sx = w / W, sy = h / H;
    const f = pt.frame, lv = Math.round(pt.level ?? 255);
    ov.fillStyle = `rgb(${lv},${lv},${lv})`;
    if (f.kind === 'focus') {
      ov.imageSmoothingEnabled = false;
      ov.drawImage(focusImage(W, H, pt.shift), x, y, w, h);
    } else if (f.kind !== 'black') {
      for (const [a, b] of stripeRuns(f, f.axis === 'y' ? H : W, pt.shift)) {
        if (f.axis === 'y') { const y0 = Math.round(y + a * sy), y1 = Math.round(y + b * sy); ov.fillRect(Math.round(x), y0, Math.round(w), y1 - y0); }
        else { const x0 = Math.round(x + a * sx), x1 = Math.round(x + b * sx); ov.fillRect(x0, Math.round(y), x1 - x0, Math.round(h)); }
      }
    }
  }
  // Rückmeldung, sobald das Bild auf dem Schirm ist (nächster Bildwechsel)
  requestAnimationFrame(() => api.sendOutputEvent({ type: 'patternShown', seq: pt.seq, outputId, mine: mine.map(({ p }) => p.id) }));
}

/** Feinkorrektur: verzerrte Linien, Gitterpunkte und freie Punkte. */
function drawWarpGrid(wp, w, h, dpr) {
  drawWarpOverlay(ov, wp, w, h, 1.6 * dpr, { handle: st.activeHandle, pin: st.activePin });
}

// ---------------- Eingaben auf dem Projektor
function hitTest(e) {
  const dpr = window.devicePixelRatio || 1;
  const cx = e.clientX * dpr, cy = e.clientY * dpr;
  const Wc = glCanvas.width, Hc = glCanvas.height;
  for (const { p, rect } of myProjectors()) {
    const x = rect.x * Wc, y = rect.y * Hc, w = rect.w * Wc, h = rect.h * Hc;
    if (cx >= x && cx < x + w && cy >= y && cy < y + h) {
      return { projectorId: p.id, u: ((cx - x) / w) * p.resolution[0], v: ((cy - y) / h) * p.resolution[1], cx, cy };
    }
  }
  return { cx, cy };
}
let dragging = false;
window.addEventListener('pointermove', (e) => {
  const h = hitTest(e);
  st.mouse = h;
  if (dragging && h.projectorId) api.sendOutputEvent({ type: 'pointer', phase: 'move', ...h });
  draw();
});
window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const h = hitTest(e);
  if (!h.projectorId) return;
  dragging = true;
  api.sendOutputEvent({ type: 'pointer', phase: 'down', ...h });
});
window.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  const h = hitTest(e);
  if (h.projectorId) api.sendOutputEvent({ type: 'pointer', phase: 'up', ...h });
});
window.addEventListener('pointerleave', () => { st.mouse = null; draw(); });
window.addEventListener('keydown', (e) => {
  e.preventDefault();
  api.sendOutputEvent({ type: 'key', key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, repeat: e.repeat });
});

api.onOutputConfig((cfg) => { if (cfg.outputName) outputId = cfg.outputName; draw(); });
api.onStateUpdate(async (msg) => {
  if (msg.type === 'state') {
    if (msg.lang) setLang(msg.lang);
    st.project = msg.project;
    st.activeId = msg.activeId;
    st.activePointId = msg.activePointId;
    st.play = msg.play || null;
    st.warpEdit = !!msg.warpEdit;
    st.markers = msg.markers ?? true;
    st.activeHandle = msg.activeHandle ?? null;
    st.activePin = msg.activePin ?? null;
    await ensureModel(msg.modelPath);
    syncVideo();
    draw();
  } else if (msg.type === 'pattern') {
    st.pattern = msg.pattern;
    draw(true);
  } else if (msg.type === 'blend') {
    st.blendImgs = {};
    for (const [id, url] of Object.entries(msg.images || {})) {
      const img = new Image();
      img.onload = draw;
      img.src = url;
      st.blendImgs[id] = img;
    }
    draw();
  }
});

window.__out = { get video() { return video; }, player, st };
resize();
api.sendOutputEvent({ type: 'ready', outputId });
