// 3D-Arbeitsansicht: Modell, Projektionen aller Projektoren auf dem Modell, Frustums, Punkte.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeCoverageMaterial, frustumLines, viewProjMatrix, applySolutionToCamera } from '../shared/scene.js';

export class View3D {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.h = handlers; // { onPick(world, snapped), onHover(info) }
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#101217');
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
    this.camera.position.set(6, -6, 10);
    this.projCam = new THREE.PerspectiveCamera();
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.viewMode = 'orbit';
    this.snap = true;
    this.showCoverage = true;
    this.showFrustums = true;
    this.material = makeCoverageMaterial(8);
    this.groups = {
      frustums: new THREE.Group(),
      points: new THREE.Group(),
      hover: new THREE.Group(),
    };
    Object.values(this.groups).forEach((g) => this.scene.add(g));
    this.scene.add(new THREE.AxesHelper(0.5));
    this.raycaster = new THREE.Raycaster();
    this.labelCache = new Map();
    this._needs = true;
    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
    const loop = () => {
      requestAnimationFrame(loop);
      const moving = this.controls.update();
      if (this._needs || moving) {
        this._needs = false;
        this._render();
      }
    };
    loop();
  }

  requestRender() { this._needs = true; }

  _resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  setModel(model) {
    if (this.mesh) {
      this.scene.remove(this.mesh, this.edges);
    }
    this.model = model;
    this.mesh = new THREE.Mesh(model.geometry, this.material);
    this.edges = new THREE.LineSegments(model.edges, new THREE.LineBasicMaterial({ color: 0x1b1e25, transparent: true, opacity: 0.85 }));
    this.scene.add(this.mesh, this.edges);
    this.featurePts = model.featureVertices;
    this.markerSize = model.radius * 0.012;
    this.focus();
  }

  focus() {
    if (!this.model) return;
    const c = this.model.center, r = this.model.radius;
    this.controls.target.copy(c);
    // Blick von schräg unten (wie man im Raum zur Decke schaut)
    this.camera.position.set(c.x + r * 0.9, c.y - r * 1.3, c.z + r * 1.1);
    this.camera.near = r / 500;
    this.camera.far = r * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** Projektoren + aktive Auswahl übernehmen. */
  update(project, activeId, activePointId, pendingRepick, candidates = []) {
    this.candidates = candidates || [];
    this.project = project;
    this.activeId = activeId;
    this.activePointId = activePointId;
    this.pendingRepick = pendingRepick;
    const u = this.material.uniforms;
    let k = 0, activeIdx = -1;
    for (const p of project.projectors) {
      if (!p.solution || !p.enabled) continue;
      if (k >= 8) break;
      u.uViewProj.value[k].copy(viewProjMatrix(p.solution));
      u.uColor.value[k].set(p.color);
      u.uRes.value[k].set(p.solution.width, p.solution.height);
      if (p.id === activeId) activeIdx = k;
      k++;
    }
    u.uCount.value = this.showCoverage ? k : 0;
    u.uActive.value = activeIdx;
    this._buildFrustums();
    this._buildPoints();
    this.requestRender();
  }

  _buildFrustums() {
    const g = this.groups.frustums;
    g.clear();
    if (!this.showFrustums || !this.model) return;
    for (const p of this.project.projectors) {
      const s = p.solution;
      if (!s) continue;
      const dist = Math.hypot(...s.center.map((c, i) => c - this.model.center.getComponent(i)));
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(frustumLines(s, dist * 1.05), 3));
      const active = p.id === this.activeId;
      const line = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: active ? 1 : 0.45 }));
      g.add(line);
      const body = new THREE.Mesh(new THREE.SphereGeometry(this.model.radius * (active ? 0.025 : 0.018), 16, 12), new THREE.MeshBasicMaterial({ color: p.color }));
      body.position.set(...s.center);
      g.add(body);
      g.add(this._label(p.name, p.color, s.center, active ? 1.2 : 0.9));
    }
  }

  _buildPoints() {
    const g = this.groups.points;
    g.clear();
    const p = this.project.projectors.find((x) => x.id === this.activeId);
    if (!p || !this.model) return;
    const r = this.markerSize;
    // vorgegebene Bildmitte
    if (p.centerHint?.world) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * 3.5, r * 4.2, 40), new THREE.MeshBasicMaterial({ color: p.color, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 }));
      ring.position.set(...p.centerHint.world);
      ring.lookAt(this.camera.position);
      ring.renderOrder = 8;
      g.add(ring);
    }
    // Vorschläge für den nächsten Punkt (blaue Rauten)
    for (const c of this.candidates) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(r * 1.8), new THREE.MeshBasicMaterial({ color: 0x4da3ff, wireframe: true, depthTest: false }));
      m.position.set(...c);
      m.renderOrder = 9;
      g.add(m);
    }
    const errs = new Map((p.solution?.errors || []).map((e) => [e.id, e.error]));
    for (const pt of p.points) {
      if (!pt.world) continue;
      const active = pt.id === this.activePointId;
      const e = errs.get(pt.id);
      const col = !pt.enabled ? 0x666666 : e == null ? 0xffffff : e < 3 ? 0x34c759 : e < 8 ? 0xffb400 : 0xff5a5f;
      const m = new THREE.Mesh(new THREE.SphereGeometry(active ? r * 1.6 : r, 16, 12), new THREE.MeshBasicMaterial({ color: col, depthTest: false }));
      m.renderOrder = 10;
      m.position.set(...pt.world);
      g.add(m);
      if (active) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(r * 2.4, r * 3, 32), new THREE.MeshBasicMaterial({ color: 0x4da3ff, side: THREE.DoubleSide, depthTest: false }));
        ring.position.copy(m.position);
        ring.lookAt(this.camera.position);
        ring.renderOrder = 11;
        g.add(ring);
      }
      g.add(this._label(String(pt.id), active ? '#4da3ff' : '#ffffff', pt.world.map((v, i) => v + (i === 1 ? -r * 3 : 0)), 0.7));
      // Strahl vom Projektor durch den gesetzten Bildpunkt (zeigt Abweichung im Raum)
      if (p.solution && pt.image) {
        const s = p.solution;
        const m2 = s.mirror ? -1 : 1;
        const dc = [(m2 * (pt.image[0] - s.cx)) / s.f, (pt.image[1] - s.cy) / s.f, 1];
        const R = s.R;
        const d = [0, 1, 2].map((i) => R[0][i] * dc[0] + R[1][i] * dc[1] + R[2][i] * dc[2]);
        const C = s.center;
        const depth = Math.hypot(...pt.world.map((v, i) => v - C[i])) / Math.hypot(...d);
        const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...C), new THREE.Vector3(C[0] + d[0] * depth, C[1] + d[1] * depth, C[2] + d[2] * depth)]);
        const ln = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: active ? 0.9 : 0.25 }));
        g.add(ln);
      }
    }
  }

  _label(text, color, pos, scale = 1) {
    const key = `${text}|${color}`;
    let tex = this.labelCache.get(key);
    if (!tex) {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 64;
      const g = c.getContext('2d');
      g.font = 'bold 40px -apple-system, Segoe UI, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.85)';
      g.strokeText(text, 64, 32);
      g.fillStyle = color; g.fillText(text, 64, 32);
      tex = new THREE.CanvasTexture(c);
      this.labelCache.set(key, tex);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    const s = (this.model?.radius || 5) * 0.06 * scale;
    sp.scale.set(s * 2, s, 1);
    sp.position.set(...pos);
    sp.renderOrder = 20;
    return sp;
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.controls.enabled = mode === 'orbit';
    this.requestRender();
  }

  _activeCamera() {
    if (this.viewMode === 'projector') {
      const p = this.project?.projectors.find((x) => x.id === this.activeId);
      if (p?.solution) {
        applySolutionToCamera(this.projCam, p.solution, this.model.radius / 200, this.model.radius * 20);
        return this.projCam;
      }
    }
    return this.camera;
  }

  _render() {
    const cam = this._activeCamera();
    if (cam === this.projCam) {
      // Seitenverhältnis des Projektors beibehalten (Letterbox)
      const r = this.canvas.parentElement.getBoundingClientRect();
      const p = this.project.projectors.find((x) => x.id === this.activeId);
      const ar = p.solution.width / p.solution.height;
      let w = r.width, h = r.width / ar;
      if (h > r.height) { h = r.height; w = h * ar; }
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, r.width, r.height);
      this.renderer.clear();
      this.renderer.setViewport((r.width - w) / 2, (r.height - h) / 2, w, h);
      this.renderer.render(this.scene, cam);
      this.renderer.setViewport(0, 0, r.width, r.height);
    } else {
      this.renderer.render(this.scene, cam);
    }
  }

  // ---------- Picking ----------
  _bindEvents() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      down = null;
      if (e.button !== 0 || moved > 5 || dt > 600) return;
      const hit = this.pick(e, !e.altKey && this.snap);
      if (hit) this.h.onPick(hit.point, hit.snapped);
    });
    let raf = 0;
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this._hover(e));
    });
    this.canvas.addEventListener('pointerleave', () => { this.groups.hover.clear(); this.requestRender(); this.h.onHover?.(null); });
  }

  _ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  pick(e, snap) {
    if (!this.mesh) return null;
    const cam = this._activeCamera();
    if (cam === this.projCam) return null; // in Projektor-Sicht nicht picken
    this.raycaster.setFromCamera(this._ndc(e), cam);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    if (!hits.length) return null;
    const hp = hits[0].point;
    if (!snap) return { point: [hp.x, hp.y, hp.z], snapped: false };
    // nächste Merkmalsecke in Bildschirm-Nähe suchen (14 px)
    const r = this.canvas.getBoundingClientRect();
    const mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    const v = new THREE.Vector3();
    let best = null, bestD = 14;
    const fp = this.featurePts;
    const maxWorld = hits[0].distance * 0.08;
    for (let i = 0; i < fp.length; i += 3) {
      const dx = fp[i] - hp.x, dy = fp[i + 1] - hp.y, dz = fp[i + 2] - hp.z;
      if (Math.abs(dx) > maxWorld || Math.abs(dy) > maxWorld || Math.abs(dz) > maxWorld) continue;
      v.set(fp[i], fp[i + 1], fp[i + 2]).project(cam);
      const sx = ((v.x + 1) / 2) * r.width, sy = ((1 - v.y) / 2) * r.height;
      const d = Math.hypot(sx - mouse.x, sy - mouse.y);
      if (d < bestD) { bestD = d; best = [fp[i], fp[i + 1], fp[i + 2]]; }
    }
    if (best) return { point: best, snapped: true };
    return { point: [hp.x, hp.y, hp.z], snapped: false };
  }

  _hover(e) {
    const g = this.groups.hover;
    g.clear();
    const hit = this.pick(e, !e.altKey && this.snap);
    if (hit) {
      const r = this.markerSize * (hit.snapped ? 1.3 : 0.8);
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: hit.snapped ? 0x4da3ff : 0xaaaaaa, depthTest: false, transparent: true, opacity: 0.85 }));
      m.position.set(...hit.point);
      m.renderOrder = 30;
      g.add(m);
      this.h.onHover?.(hit);
    } else this.h.onHover?.(null);
    this.requestRender();
  }
}
