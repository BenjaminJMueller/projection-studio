// Berechnung der Projektor-Masken auf der GPU:
//  * Auto-Edge-Blending: In Überlappungen wird jedes Pixel nach Abstand zum eigenen
//    Bildrand gewichtet (w / Σw), mit Sichtbarkeitstest (Shadow-Map je Projektor).
//  * Helligkeitsausgleich: Bestrahlungsstärke E ~ cos(Einfall) / (Abstand² · cos³(Achsenwinkel)).
//    Helle Bereiche werden auf ein gemeinsames Referenzniveau gedimmt (einstellbare Stärke).
//  * Außerhalb des Modells schwarz (kein Streulicht).
//  * Gamma-Korrektur + Dithering gegen Banding.
// Ergebnis pro Projektor: Graustufenbild in Projektorauflösung, multipliziert mit den eigenen Masken.
import * as THREE from 'three';
import { applySolutionToCamera, viewProjMatrix } from '../shared/scene.js';
import { renderMaskCanvas } from '../shared/masks.js';

let renderer = null;
function getRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
  }
  return renderer;
}

function buildShader(n) {
  let decl = '';
  let body = '';
  for (let i = 0; i < n; i++) {
    decl += `uniform mat4 uVP${i}; uniform sampler2D uDepth${i}; uniform vec3 uC${i}; uniform vec3 uAx${i};\n`;
    body += `
    {
      vec4 c = uVP${i} * vec4(vWorld, 1.0);
      float wq = 0.0; float eq = 0.0;
      if (c.w > 0.0) {
        vec3 ndc = c.xyz / c.w;
        if (abs(ndc.x) < 1.0 && abs(ndc.y) < 1.0) {
          float d = texture2D(uDepth${i}, ndc.xy * 0.5 + 0.5).r;
          float zf = linZ(ndc.z * 0.5 + 0.5), zd = linZ(d);
          if (zf <= zd * 1.01 + uBias) {
            float e = min(1.0 - abs(ndc.x), 1.0 - abs(ndc.y));
            wq = smoothstep(0.0, uWidth, e) + 1e-6;
            vec3 toP = uC${i} - vWorld; float dist = length(toP); vec3 dir = toP / dist;
            float cosT = max(abs(dot(n, dir)), 0.05);
            float cosA = max(dot(uAx${i}, -dir), 0.05);
            eq = cosT / (dist * dist * cosA * cosA * cosA);
          }
        }
      }
      if (${i} == uSelf) { wSelf = wq; eSelf = eq; }
      wSum += wq;
    }`;
  }
  return {
    vertexShader: /* glsl */ `
      varying vec3 vWorld; varying vec3 vNormal;
      void main(){ vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz; vNormal = mat3(modelMatrix) * normal;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld; varying vec3 vNormal;
      uniform int uSelf; uniform float uWidth; uniform float uBias; uniform float uNear; uniform float uFar;
      uniform float uAuto; uniform float uBright; uniform float uStrength; uniform float uEref; uniform float uGamma;
      uniform int uMode; // 0 = Maske, 1 = log(E) kodiert
      ${decl}
      float linZ(float z){ float zn = z * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - zn * (uFar - uNear)); }
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        vec3 n = normalize(vNormal);
        float wSelf = 0.0, eSelf = 0.0, wSum = 0.0;
        ${body}
        if (uMode == 1) {
          float v = clamp((log(max(eSelf, 1e-12)) + 12.0) / 24.0, 0.0, 1.0);
          if (eSelf <= 0.0) { gl_FragColor = vec4(0.0); return; }
          float hi = floor(v * 255.0) / 255.0; float lo = fract(v * 255.0);
          gl_FragColor = vec4(hi, lo, 0.0, 1.0); return;
        }
        float a = 1.0;
        if (uAuto > 0.5) a = wSum > 1e-5 ? wSelf / wSum : 1.0;
        if (wSelf <= 0.0 && eSelf <= 0.0) a = 1.0; // verdeckter Teil: eigener Projektor sieht ihn trotzdem
        float g = 1.0;
        if (uBright > 0.5 && eSelf > 0.0) g = mix(1.0, min(1.0, uEref / eSelf), uStrength);
        float o = pow(clamp(a * g, 0.0, 1.0), 1.0 / uGamma);
        o += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(vec3(o), 1.0);
      }`,
  };
}

export function computeBlendMasks(model, project, { previewWidth = 480 } = {}) {
  const r = getRenderer();
  const projs = project.projectors.filter((p) => p.solution && p.enabled);
  const n = projs.length;
  if (!n) return {};
  const near = model.radius / 200, far = model.radius * 20;
  const b = project.blend;

  // 1) Tiefenbilder je Projektor (halbe Auflösung reicht)
  const depthScene = new THREE.Scene();
  depthScene.add(new THREE.Mesh(model.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false })));
  const depthRTs = projs.map((p) => {
    const w = Math.round(p.solution.width / 2), h = Math.round(p.solution.height / 2);
    const rt = new THREE.WebGLRenderTarget(w, h, { depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType) });
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
    const cam = applySolutionToCamera(new THREE.PerspectiveCamera(), p.solution, near, far);
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(depthScene, cam);
    return rt;
  });

  // 2) Maskenshader
  const sh = buildShader(n);
  const uniforms = {
    uSelf: { value: 0 }, uWidth: { value: b.width }, uBias: { value: model.radius * 0.01 },
    uNear: { value: near }, uFar: { value: far },
    uAuto: { value: b.auto ? 1 : 0 }, uBright: { value: b.brightness ? 1 : 0 }, uStrength: { value: b.brightnessStrength },
    uEref: { value: 1 }, uGamma: { value: b.gamma || 2.2 }, uMode: { value: 0 },
  };
  projs.forEach((p, i) => {
    const s = p.solution;
    uniforms[`uVP${i}`] = { value: viewProjMatrix(s, near, far) };
    uniforms[`uDepth${i}`] = { value: depthRTs[i].depthTexture };
    uniforms[`uC${i}`] = { value: new THREE.Vector3(...s.center) };
    // optische Achse in Welt = 3. Zeile von R
    uniforms[`uAx${i}`] = { value: new THREE.Vector3(s.R[2][0], s.R[2][1], s.R[2][2]).normalize() };
  });
  const mat = new THREE.ShaderMaterial({ ...sh, uniforms, side: THREE.DoubleSide });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(model.geometry, mat));

  // 3) Referenzhelligkeit: 5 %-Perzentil der Bestrahlungsstärke über alle Projektoren
  if (b.brightness) {
    uniforms.uMode.value = 1;
    const vals = [];
    projs.forEach((p, i) => {
      uniforms.uSelf.value = i;
      const w = 240, h = Math.round((240 * p.solution.height) / p.solution.width);
      const rt = new THREE.WebGLRenderTarget(w, h);
      const cam = applySolutionToCamera(new THREE.PerspectiveCamera(), p.solution, near, far);
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(scene, cam);
      const buf = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      for (let k = 0; k < buf.length; k += 4) {
        if (buf[k + 3] === 0) continue;
        const v = buf[k] / 255 + buf[k + 1] / 255 / 255;
        vals.push(v * 24 - 12);
      }
      rt.dispose();
    });
    vals.sort((a, c) => a - c);
    uniforms.uEref.value = vals.length ? Math.exp(vals[Math.floor(vals.length * 0.05)]) : 1;
    uniforms.uMode.value = 0;
  }

  // 4) Masken in voller Auflösung rendern und auslesen
  const out = {};
  projs.forEach((p, i) => {
    uniforms.uSelf.value = i;
    const W = p.solution.width, H = p.solution.height;
    const rt = new THREE.WebGLRenderTarget(W, H);
    const cam = applySolutionToCamera(new THREE.PerspectiveCamera(), p.solution, near, far);
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, cam);
    const buf = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    rt.dispose();
    // vertikal spiegeln (GL-Ursprung unten links)
    const img = new ImageData(W, H);
    const row = W * 4;
    for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.putImageData(img, 0, 0);
    const auto = document.createElement('canvas');
    auto.width = previewWidth; auto.height = Math.round((previewWidth * H) / W);
    auto.getContext('2d').drawImage(c, 0, 0, auto.width, auto.height);
    if (p.masks?.length) {
      g.globalCompositeOperation = 'multiply';
      g.drawImage(renderMaskCanvas(p.masks, W, H), 0, 0);
      g.globalCompositeOperation = 'source-over';
    }
    const pv = document.createElement('canvas');
    pv.width = previewWidth; pv.height = Math.round((previewWidth * H) / W);
    pv.getContext('2d').drawImage(c, 0, 0, pv.width, pv.height);
    out[p.id] = { canvas: c, previewUrl: pv.toDataURL('image/png'), autoPreviewUrl: auto.toDataURL('image/png') };
  });
  r.setRenderTarget(null);
  depthRTs.forEach((rt) => { rt.depthTexture.dispose(); rt.dispose(); });
  mat.dispose();
  return out;
}
