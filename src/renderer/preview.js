// Projektorbild-Vorschau: zeigt, was der aktive Projektor gerade ausgibt
// (Modellkanten durch die aktuelle Lösung) + Punkte, Fehlervektoren und Masken.
import * as THREE from 'three';
import { applySolutionToCamera } from '../shared/scene.js';
import { drawMaskShapes } from '../shared/masks.js';
import { forward, gridBase } from '../shared/warp.js';

export class Preview {
  constructor(canvas3d, canvas2d, handlers) {
    this.c3 = canvas3d;
    this.c2 = canvas2d;
    this.h = handlers; // onImagePoint(u,v,phase), onSelectPoint(id), onMaskEdit(...)
    this.renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera();
    this.mode = 'points';
    this.ctx = canvas2d.getContext('2d');
    this.mouse = null;
    new ResizeObserver(() => this._resize()).observe(canvas2d.parentElement);
    this._bind();
    this._resize();
  }

  setModel(model) {
    this.scene.clear();
    this.meshMat = new THREE.MeshBasicMaterial({ color: 0x1d2128, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(model.geometry, this.meshMat);
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    this.lines = new THREE.LineSegments(model.edges, this.lineMat);
    this.scene.add(this.mesh, this.lines);
    this.model = model;
  }

  _resize() {
    const r = this.c2.parentElement.getBoundingClientRect();
    this.cssW = r.width; this.cssH = r.height;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setSize(r.width, r.height, false);
    this.c2.width = Math.round(r.width * dpr);
    this.c2.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    this.draw();
  }

  set(projector, activePointId, extras = {}) {
    this.p = projector;
    this.activePointId = activePointId;
    this.extras = extras;
    this.draw();
  }

  get W() { return this.p?.resolution[0] || 1920; }
  get H() { return this.p?.resolution[1] || 1080; }

  toPx(e) {
    const r = this.c2.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.W, ((e.clientY - r.top) / r.height) * this.H];
  }

  draw() {
    if (!this.p) return;
    const p = this.p;
    // 3D-Teil
    if (p.solution && this.model) {
      applySolutionToCamera(this.cam, p.solution, this.model.radius / 200, this.model.radius * 20);
      this.lineMat.color.set(p.color);
      this.renderer.setClearColor(0x000000);
      this.renderer.render(this.scene, this.cam);
    } else {
      this.renderer.setClearColor(0x050608);
      this.renderer.clear();
    }
    // 2D-Overlay
    const g = this.ctx;
    const sx = (this.c2.width / this.W), sy = (this.c2.height / this.H);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.c2.width, this.c2.height);
    g.setTransform(sx, 0, 0, sy, 0, 0);
    const px = 1 / sx; // ein Bildschirmpixel in Projektorpixeln
    // Raster bei fehlender Lösung
    if (!p.solution) {
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.lineWidth = px;
      for (let x = 0; x <= this.W; x += 120) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, this.H); g.stroke(); }
      for (let y = 0; y <= this.H; y += 120) { g.beginPath(); g.moveTo(0, y); g.lineTo(this.W, y); g.stroke(); }
    }
    // berechnete Blend-Maske (Tab „Blending“)
    if (this.mode === 'blend' && this.extras.blendImg?.complete) {
      g.drawImage(this.extras.blendImg, 0, 0, this.W, this.H);
    }
    // Masken
    if (p.masks?.length) {
      g.save();
      drawMaskShapes(g, p.masks, { outline: true, activeMask: this.extras.activeMaskId, px, editing: this.mode === 'masks' });
      g.restore();
    }
    // Feinkorrektur-Gitter
    if (this.mode === 'warp' && p.warp) {
      const w = p.warp, N = 16;
      g.lineWidth = 1.2 * px;
      g.strokeStyle = 'rgba(255,255,255,.7)';
      const line = (fn, n) => { g.beginPath(); for (let k = 0; k <= n; k++) { const [u, v] = fn(k / n); k ? g.lineTo(u * this.W, v * this.H) : g.moveTo(u * this.W, v * this.H); } g.stroke(); };
      for (let r = 0; r < w.rows; r++) line((t) => forward(w, t, r / (w.rows - 1)), N * (w.cols - 1));
      for (let c = 0; c < w.cols; c++) line((t) => forward(w, c / (w.cols - 1), t), N * (w.rows - 1));
      w.offsets.forEach((o, i) => {
        const [bu, bv] = gridBase(w, i);
        const x = (bu + o[0]) * this.W, y = (bv + o[1]) * this.H, on = i === this.extras.activeHandle;
        g.beginPath(); g.arc(x, y, (on ? 7 : 5) * px, 0, Math.PI * 2);
        g.fillStyle = on ? '#0a84ff' : 'rgba(30,30,34,.9)'; g.fill();
        g.lineWidth = 1.5 * px; g.strokeStyle = '#fff'; g.stroke();
      });
      g.strokeStyle = p.color; g.lineWidth = 2 * px;
      g.strokeRect(0, 0, this.W, this.H);
      return;
    }
    // Vorschlag für nächsten Punkt
    if (this.extras.suggest && this.mode === 'points') {
      const s = this.extras.suggest;
      g.strokeStyle = 'rgba(10,132,255,.8)';
      g.setLineDash([8 * px, 6 * px]);
      g.lineWidth = 2 * px;
      g.beginPath(); g.arc(s.u, s.v, 26 * px, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
    // Punkte
    const errs = new Map((p.solution?.errors || []).map((e) => [e.id, e]));
    for (const pt of p.points) {
      if (!pt.image) continue;
      const active = pt.id === this.activePointId;
      const e = errs.get(pt.id);
      const state = !pt.enabled ? 'off' : active ? 'active' : e && e.error >= 8 ? 'bad' : e && e.error >= 3 ? 'warn' : 'ok';
      const ACC = '#0a84ff';
      const [u, v] = pt.image;
      if (active) {
        g.strokeStyle = 'rgba(10,132,255,.5)';
        g.lineWidth = px;
        g.beginPath(); g.moveTo(0, v); g.lineTo(this.W, v); g.moveTo(u, 0); g.lineTo(u, this.H); g.stroke();
      }
      if (e && pt.enabled && e.error >= 1) {
        // Abweichung: gesetzter Punkt -> wo das Modell landet (dünne Linie, kleiner Endpunkt)
        g.strokeStyle = state === 'bad' ? '#ff5a52' : state === 'warn' ? '#f0a531' : 'rgba(255,255,255,.55)';
        g.lineWidth = 1.2 * px;
        g.beginPath(); g.moveTo(u, v); g.lineTo(e.projected[0], e.projected[1]); g.stroke();
        g.fillStyle = g.strokeStyle;
        g.beginPath(); g.arc(e.projected[0], e.projected[1], 2 * px, 0, Math.PI * 2); g.fill();
      }
      // Fadenkreuz: weiß mit dunkler Kontur, aktiv blau
      const k = (active ? 8 : 6) * px;
      for (const [w, c] of [[3 * px, 'rgba(0,0,0,.55)'], [1.4 * px, active ? ACC : state === 'off' ? 'rgba(255,255,255,.45)' : '#fff']]) {
        g.strokeStyle = c; g.lineWidth = w;
        g.beginPath(); g.moveTo(u - k, v); g.lineTo(u + k, v); g.moveTo(u, v - k); g.lineTo(u, v + k); g.stroke();
      }
      // Nummer als kleine Plakette oben rechts
      const r = 8 * px, bx = u + 11 * px, by = v - 11 * px;
      g.beginPath(); g.arc(bx, by, r, 0, Math.PI * 2);
      g.fillStyle = active ? ACC : state === 'off' ? 'rgba(60,60,64,.8)' : 'rgba(30,30,34,.9)'; g.fill();
      g.lineWidth = (state === 'bad' || state === 'warn' ? 2 : 1.2) * px;
      g.strokeStyle = state === 'bad' ? '#ff5a52' : state === 'warn' ? '#f0a531' : 'rgba(255,255,255,.9)'; g.stroke();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `600 ${10 * px}px -apple-system, "Segoe UI", sans-serif`;
      g.fillText(String(pt.id), bx, by + 0.5 * px);
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    }
    // Projektorrand
    g.strokeStyle = p.color; g.lineWidth = 2 * px;
    g.strokeRect(0, 0, this.W, this.H);
  }

  _bind() {
    let drag = null;
    const hitPoint = (uv) => {
      const r = 14 * (this.W / this.cssW);
      let best = null, bd = r;
      for (const pt of this.p?.points || []) {
        if (!pt.image) continue;
        const d = Math.hypot(pt.image[0] - uv[0], pt.image[1] - uv[1]);
        if (d < bd) { bd = d; best = pt; }
      }
      return best;
    };
    this.c2.addEventListener('pointerdown', (e) => {
      if (!this.p || e.button !== 0) return;
      const uv = this.toPx(e);
      this.c2.setPointerCapture(e.pointerId);
      if (this.mode === 'warp') {
        drag = { kind: 'warp' };
        this.h.onWarpPointer?.(uv, 'down');
        return;
      }
      if (this.mode === 'masks') {
        drag = { kind: 'mask' };
        this.h.onMaskPointer?.(uv, 'down', e);
        return;
      }
      const hp = hitPoint(uv);
      if (hp && hp.id !== this.activePointId) {
        this.h.onSelectPoint(hp.id);
        drag = { kind: 'point', offset: [hp.image[0] - uv[0], hp.image[1] - uv[1]] };
      } else if (this.activePointId != null) {
        const ap = this.p.points.find((x) => x.id === this.activePointId);
        const off = ap?.image && Math.hypot(ap.image[0] - uv[0], ap.image[1] - uv[1]) < 14 * (this.W / this.cssW) ? [ap.image[0] - uv[0], ap.image[1] - uv[1]] : [0, 0];
        drag = { kind: 'point', offset: off };
        this.h.onImagePoint(uv[0] + off[0], uv[1] + off[1], 'start');
      }
    });
    this.c2.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const uv = this.toPx(e);
      if (drag.kind === 'mask') return this.h.onMaskPointer?.(uv, 'move', e);
      if (drag.kind === 'warp') return this.h.onWarpPointer?.(uv, 'move');
      this.h.onImagePoint(uv[0] + drag.offset[0], uv[1] + drag.offset[1], 'move');
    });
    const up = (e) => {
      if (!drag) return;
      const uv = this.toPx(e);
      if (drag.kind === 'warp') this.h.onWarpPointer?.(uv, 'up');
      else if (drag.kind === 'mask') this.h.onMaskPointer?.(uv, 'up', e);
      else this.h.onImagePoint(uv[0] + drag.offset[0], uv[1] + drag.offset[1], 'end');
      drag = null;
    };
    this.c2.addEventListener('pointerup', up);
    this.c2.addEventListener('pointercancel', up);
    this.c2.addEventListener('dblclick', (e) => {
      if (this.mode === 'masks') this.h.onMaskPointer?.(this.toPx(e), 'dblclick', e);
    });
  }
}
