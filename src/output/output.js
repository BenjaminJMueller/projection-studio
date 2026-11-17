// Vollbild-Ausgabe auf einem Bildschirm (z. B. 4K-HDMI mit 4 Projektor-Quadranten).
// Zeichnet nur bei Änderungen neu (spart GPU, wenn TD parallel läuft).
import * as THREE from 'three';
import { buildModel, applySolutionToCamera, makeUvGridTexture } from '../shared/scene.js';
import { quadrantRect } from '../shared/project.js';
import { renderMaskCanvas } from '../shared/masks.js';
import { fileUrl, targetTime, syncCorrection } from '../shared/playback.js';

const api = window.api;
const params = new URLSearchParams(location.search);
let outputId = params.get('name') || 'A';

const glCanvas = document.getElementById('gl');
const maskCanvas = document.getElementById('mask');
const ovCanvas = document.getElementById('overlay');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
renderer.autoClear = false;
const ov = ovCanvas.getContext('2d');
const mk = maskCanvas.getContext('2d');

const st = { project: null, activeId: null, activePointId: null, modelPath: null, model: null, blend: {}, blendImgs: {}, mouse: null, play: null };
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera();
let mesh, lines, gridTex, planarGeom;
const mats = {
  black: new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }),
  white: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  grid: null,
  video: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
};

// ---------------- Video
const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
video.preload = 'auto';
video.crossOrigin = 'anonymous';
const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.SRGBColorSpace;
mats.video.map = videoTex;
let videoSrc = '';

function ensureVideo(src) {
  const url = fileUrl(src);
  if (url === videoSrc) return;
  videoSrc = url;
  if (!url) { video.removeAttribute('src'); video.load(); return; }
  video.src = url;
  video.load();
}

/** Auf die gemeinsame Uhr abgleichen. Läuft alle 250 ms und bei jeder Zustandsänderung. */
function syncVideo() {
  const pb = st.project?.playback;
  const want = st.project?.view.outputMode === 'video' && pb?.src;
  if (!want || !st.play || !(video.duration > 0)) { if (!video.paused) video.pause(); return; }
  video.loop = !!st.play.loop;
  const target = targetTime(st.play, video.duration);
  if (!st.play.playing) {
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - target) > 0.04) video.currentTime = target;
    return;
  }
  const c = syncCorrection(video.currentTime, target, video.duration, st.play.loop);
  if (c.seek != null) video.currentTime = c.seek;
  video.playbackRate = c.rate;
  if (video.paused) video.play().catch(() => {});
}
setInterval(syncVideo, 250);
video.addEventListener('loadedmetadata', () => { syncVideo(); draw(); });
video.addEventListener('seeked', () => draw(false));
// jedes neue Videobild: nur die 3D-Ebene neu zeichnen, Masken und Overlay bleiben
function onFrame() { draw(false); video.requestVideoFrameCallback(onFrame); }
video.requestVideoFrameCallback(onFrame);

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

function drawNow(full = true) {
  const Wc = glCanvas.width, Hc = glCanvas.height;
  renderer.setScissorTest(false);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  if (full) {
    ov.setTransform(1, 0, 0, 1, 0, 0);
    ov.clearRect(0, 0, ovCanvas.width, ovCanvas.height);
    mk.setTransform(1, 0, 0, 1, 0, 0);
    mk.fillStyle = '#fff';
    mk.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  }
  if (!st.project) return;
  const mode = st.project.view.outputMode;
  const showMask = st.project.view.showMask;
  const dpr = renderer.getPixelRatio();
  for (const { p, rect } of myProjectors()) {
    const x = rect.x * Wc, y = rect.y * Hc, w = rect.w * Wc, h = rect.h * Hc;
    const active = p.id === st.activeId;
    // 3D-Inhalt durch die kalibrierte Kamera
    if (p.solution && st.model && mode !== 'black' && mode !== 'ident') {
      applySolutionToCamera(cam, p.solution, st.model.radius / 200, st.model.radius * 20);
      mesh.geometry = mode === 'video' && st.project.playback?.mapping !== 'uv' ? planarGeometry() : st.model.geometry;
      mesh.material = mode === 'video' ? mats.video : mode === 'white' ? mats.white : mode === 'grid' ? (mats.grid ||= new THREE.MeshBasicMaterial({ map: (gridTex ||= makeUvGridTexture()), side: THREE.DoubleSide })) : mats.black;
      lines.visible = mode === 'edges';
      lineMat.color.set(active ? '#ffffff' : '#bbbbbb');
      // GL-Viewport: Ursprung unten links, in CSS-Pixeln
      renderer.setViewport(x / dpr, (Hc - y - h) / dpr, w / dpr, h / dpr);
      renderer.setScissor(x / dpr, (Hc - y - h) / dpr, w / dpr, h / dpr);
      renderer.setScissorTest(true);
      renderer.render(scene, cam);
      renderer.setScissorTest(false);
    }
    if (!full) continue;
    // Masken (Multiply-Ebene)
    if (showMask) {
      const img = st.blendImgs[p.id];
      if (img?.complete) mk.drawImage(img, x, y, w, h);
      else if (p.solution) { mk.fillStyle = '#fff'; mk.fillRect(x, y, w, h); }
      if (p.masks?.length) {
        const mc = renderMaskCanvas(p.masks, p.resolution[0], p.resolution[1], 0.25);
        mk.globalCompositeOperation = 'multiply';
        mk.drawImage(mc, x, y, w, h);
        mk.globalCompositeOperation = 'source-over';
      }
    }
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
      ov.fillText(`${outputId} · ${p.ring}`, w / 2, h * 0.7);
      ov.textAlign = 'left'; ov.textBaseline = 'alphabetic';
    }
    if (active) {
      for (const pt of p.points) {
        if (!pt.image) continue;
        const u = pt.image[0] * sx, v = pt.image[1] * sy;
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
    st.project = msg.project;
    st.activeId = msg.activeId;
    st.activePointId = msg.activePointId;
    st.play = msg.play || null;
    await ensureModel(msg.modelPath);
    ensureVideo(st.project.view.outputMode === 'video' ? st.project.playback?.src : '');
    syncVideo();
    draw();
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

window.__out = { video, st };
resize();
api.sendOutputEvent({ type: 'ready', outputId });
