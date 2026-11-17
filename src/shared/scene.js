// Gemeinsame 3D-Bausteine für Hauptfenster und Ausgabefenster.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { viewMatrixGL, projectionMatrixGL, cameraWorldMatrix } from '../core/export.js';

export const PROJECTOR_COLORS = ['#ff5a5f', '#ffb400', '#34c759', '#2fb7f5', '#a970ff', '#ff7ac6', '#00d1b2', '#c7d34a'];

/** OBJ-Text -> Geometrien. Alle Meshes werden zu einer Geometrie zusammengeführt. */
export function buildModel(objText, featureAngle = 28) {
  const group = new OBJLoader().parse(objText);
  const geos = [];
  group.traverse((o) => {
    if (o.isMesh) {
      o.updateMatrixWorld(true);
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      if (!g.attributes.uv) {
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      geos.push(g);
    }
  });
  if (!geos.length) throw new Error('Keine Flächen im Modell gefunden.');
  const geometry = geos.length === 1 ? geos[0] : mergeGeos(geos);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // Kanten für Linien-Darstellung (Grate, Ränder): ideal zum Wiedererkennen auf der Decke
  const posOnly = new THREE.BufferGeometry();
  posOnly.setAttribute('position', geometry.attributes.position);
  const welded = mergeVertices(posOnly, 1e-5);
  const edges = new THREE.EdgesGeometry(welded, featureAngle);
  // Snap-Kandidaten: Endpunkte der Merkmalskanten (Ecken, Grate) + alle Vertices als Rückfall
  const fv = dedupe(edges.attributes.position.array);
  return {
    geometry,
    edges,
    welded,
    featureVertices: fv,
    allVertices: welded.attributes.position.array,
    box: geometry.boundingBox.clone(),
    radius: geometry.boundingSphere.radius,
    center: geometry.boundingSphere.center.clone(),
    triangles: geometry.attributes.position.count / 3,
  };
}

function mergeGeos(geos) {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of geos) {
    const gg = g.index ? g.toNonIndexed() : g;
    pos.set(gg.attributes.position.array, o * 3);
    nor.set(gg.attributes.normal.array, o * 3);
    uv.set(gg.attributes.uv.array, o * 2);
    o += gg.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i += 3) {
    const k = `${arr[i].toFixed(4)},${arr[i + 1].toFixed(4)},${arr[i + 2].toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(arr[i], arr[i + 1], arr[i + 2]);
  }
  return new Float32Array(out);
}

const toM4 = (rows) => new THREE.Matrix4().set(...rows.flat());

/** Setzt eine three.js-Kamera exakt auf die kalibrierte Projektor-Kamera. */
export function applySolutionToCamera(cam, sol, near = 0.05, far = 200) {
  cam.matrixAutoUpdate = false;
  cam.matrixWorldAutoUpdate = false;
  cam.matrixWorld.copy(toM4(cameraWorldMatrix(sol)));
  cam.matrixWorldInverse.copy(toM4(viewMatrixGL(sol)));
  cam.projectionMatrix.copy(toM4(projectionMatrixGL(sol, near, far)));
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  cam.matrix.copy(cam.matrixWorld);
  cam.userData.calibrated = true;
  return cam;
}

/** Test-/Rasterbild über die UV-Koordinaten des Modells. */
export function makeUvGridTexture(size = 2048, label = '') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#0b0b0b';
  g.fillRect(0, 0, size, size);
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const p = (i / n) * size;
    g.strokeStyle = i % 4 === 0 ? '#ffffff' : '#7a7a7a';
    g.lineWidth = i % 4 === 0 ? 6 : 2;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  g.fillStyle = '#ffffff';
  g.font = `${size / 40}px sans-serif`;
  for (let i = 0; i < n; i += 2)
    for (let j = 0; j < n; j += 2) g.fillText(`${String.fromCharCode(65 + i)}${j + 1}`, (i / n) * size + 10, (j / n) * size + size / 32);
  if (label) {
    g.font = `bold ${size / 10}px sans-serif`;
    g.fillText(label, size * 0.4, size * 0.55);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Shader-Material für die Arbeitsansicht: Modell grau schattiert, darüber die
 * Abdeckung aller kalibrierten Projektoren (farbig) und das Pixelraster des aktiven.
 * So sieht man sofort, wie das Bild gerade auf dem Modell liegt und wo es sich überlappt.
 */
export function makeCoverageMaterial(maxProjectors = 8) {
  const uniforms = {
    uCount: { value: 0 },
    uActive: { value: -1 },
    uViewProj: { value: Array.from({ length: maxProjectors }, () => new THREE.Matrix4()) },
    uColor: { value: Array.from({ length: maxProjectors }, () => new THREE.Color()) },
    uRes: { value: Array.from({ length: maxProjectors }, () => new THREE.Vector2(1920, 1080)) },
    uOpacity: { value: 0.35 },
    uLightDir: { value: new THREE.Vector3(0.3, -1, 0.2).normalize() },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld; varying vec3 vNormal;
      void main(){
        vec4 w = modelMatrix * vec4(position,1.0);
        vWorld = w.xyz; vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      #define MAXP ${maxProjectors}
      uniform int uCount; uniform int uActive;
      uniform mat4 uViewProj[MAXP]; uniform vec3 uColor[MAXP]; uniform vec2 uRes[MAXP];
      uniform float uOpacity; uniform vec3 uLightDir;
      varying vec3 vWorld; varying vec3 vNormal;
      void main(){
        vec3 n = normalize(vNormal);
        float shade = 0.35 + 0.5 * abs(dot(n, uLightDir));
        vec3 col = vec3(0.62) * shade;
        vec3 cover = vec3(0.0); float k = 0.0;
        for (int i = 0; i < MAXP; i++) {
          if (i >= uCount) break;
          vec4 c = uViewProj[i] * vec4(vWorld, 1.0);
          if (c.w <= 0.0) continue;
          vec2 ndc = c.xy / c.w;
          if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) continue;
          float a = (i == uActive) ? 1.0 : 0.6;
          cover += uColor[i] * a; k += 1.0;
          if (i == uActive) {
            vec2 px = (ndc * 0.5 + 0.5) * uRes[i];
            vec2 g = abs(fract(px / 120.0 - 0.5) - 0.5) * 120.0;
            vec2 fw = fwidth(px) * 1.2;
            float line = 1.0 - min(min(g.x / fw.x, g.y / fw.y), 1.0);
            float border = step(0.985, max(abs(ndc.x), abs(ndc.y)));
            cover += uColor[i] * (line * 1.5 + border * 2.0);
          }
        }
        if (k > 0.0) col = mix(col, cover / max(k, 1.0) + col * 0.3, uOpacity + (k > 1.0 ? 0.15 : 0.0));
        if (k > 1.0) col += vec3(0.08);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  return mat;
}

/** Linien eines Projektor-Frustums (Pyramide bis zur Tiefe depth) in Weltkoordinaten. */
export function frustumLines(sol, depth) {
  const { width: W, height: H } = sol;
  const corners = [[0, 0], [W, 0], [W, H], [0, H]];
  const m = sol.mirror ? -1 : 1;
  const Rt = [
    [sol.R[0][0], sol.R[1][0], sol.R[2][0]],
    [sol.R[0][1], sol.R[1][1], sol.R[2][1]],
    [sol.R[0][2], sol.R[1][2], sol.R[2][2]],
  ];
  const C = sol.center;
  const pts = corners.map(([u, v]) => {
    const dc = [(m * (u - sol.cx)) / sol.f, (v - sol.cy) / sol.f, 1];
    const d = [
      Rt[0][0] * dc[0] + Rt[0][1] * dc[1] + Rt[0][2] * dc[2],
      Rt[1][0] * dc[0] + Rt[1][1] * dc[1] + Rt[1][2] * dc[2],
      Rt[2][0] * dc[0] + Rt[2][1] * dc[1] + Rt[2][2] * dc[2],
    ];
    return [C[0] + d[0] * depth, C[1] + d[1] * depth, C[2] + d[2] * depth];
  });
  const seg = [];
  for (let i = 0; i < 4; i++) {
    seg.push(...C, ...pts[i]);
    seg.push(...pts[i], ...pts[(i + 1) % 4]);
  }
  // optische Achse
  const ax = [Rt[0][2], Rt[1][2], Rt[2][2]];
  seg.push(...C, C[0] + ax[0] * depth * 0.5, C[1] + ax[1] * depth * 0.5, C[2] + ax[2] * depth * 0.5);
  return new Float32Array(seg);
}

export function viewProjMatrix(sol, near = 0.05, far = 200) {
  const V = toM4(viewMatrixGL(sol));
  const P = toM4(projectionMatrixGL(sol, near, far));
  return P.multiply(V);
}
