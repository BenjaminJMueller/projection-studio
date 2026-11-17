// Kleine, abhängigkeitsfreie Lineare Algebra für den Solver.
// Matrizen sind Arrays von Zeilen (Array<Array<number>>), 3x3-Rotationen ebenso.

export function zeros(r, c) {
  const m = new Array(r);
  for (let i = 0; i < r; i++) m[i] = new Array(c).fill(0);
  return m;
}

export function identity(n) {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

export const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize3 = (a) => {
  const n = norm3(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

export function matVec3(R, v) {
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  ];
}

export function transpose(A) {
  const r = A.length, c = A[0].length;
  const T = zeros(c, r);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) T[j][i] = A[i][j];
  return T;
}

export function matMul(A, B) {
  const r = A.length, n = B.length, c = B[0].length;
  const M = zeros(r, c);
  for (let i = 0; i < r; i++)
    for (let k = 0; k < n; k++) {
      const a = A[i][k];
      if (a === 0) continue;
      for (let j = 0; j < c; j++) M[i][j] += a * B[k][j];
    }
  return M;
}

/** Rodrigues-Vektor -> Rotationsmatrix */
export function rodrigues(r) {
  const th = norm3(r);
  if (th < 1e-12) {
    // erste Ordnung
    return [
      [1, -r[2], r[1]],
      [r[2], 1, -r[0]],
      [-r[1], r[0], 1],
    ];
  }
  const k = [r[0] / th, r[1] / th, r[2] / th];
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const [x, y, z] = k;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

/** Rotationsmatrix -> Rodrigues-Vektor */
export function rodriguesInv(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  let cos = (tr - 1) / 2;
  cos = Math.min(1, Math.max(-1, cos));
  const th = Math.acos(cos);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // ~180°: Achse aus R + I
    const xx = Math.sqrt(Math.max(0, (R[0][0] + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (R[1][1] + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (R[2][2] + 1) / 2));
    let ax;
    if (xx >= yy && xx >= zz) ax = [xx, (R[0][1] + R[1][0]) / (4 * xx), (R[0][2] + R[2][0]) / (4 * xx)];
    else if (yy >= zz) ax = [(R[0][1] + R[1][0]) / (4 * yy), yy, (R[1][2] + R[2][1]) / (4 * yy)];
    else ax = [(R[0][2] + R[2][0]) / (4 * zz), (R[1][2] + R[2][1]) / (4 * zz), zz];
    return scale3(normalize3(ax), th);
  }
  const s = 2 * Math.sin(th);
  return [
    ((R[2][1] - R[1][2]) / s) * th,
    ((R[0][2] - R[2][0]) / s) * th,
    ((R[1][0] - R[0][1]) / s) * th,
  ];
}

export function quatToMat(q) {
  let [w, x, y, z] = q;
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

/**
 * Jacobi-Eigenzerlegung einer symmetrischen Matrix.
 * Gibt {values, vectors} zurück, vectors[k] ist der k-te Eigenvektor; absteigend sortiert.
 */
export function eigSym(Ain) {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V = identity(n);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const idx = [...Array(n).keys()].sort((a, b) => A[b][b] - A[a][a]);
  return {
    values: idx.map((i) => A[i][i]),
    vectors: idx.map((i) => V.map((row) => row[i])),
  };
}

/** Löst A x = b für symmetrisch positiv definite A (Cholesky). Gibt null bei Fehlschlag. */
export function solveSPD(A, b) {
  const n = A.length;
  const L = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) return null;
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/** Inverse einer symmetrischen Matrix über Eigenzerlegung (pseudo-invers bei Singularität). */
export function invSym(A) {
  const n = A.length;
  const { values, vectors } = eigSym(A);
  const maxv = Math.max(...values.map(Math.abs), 1e-300);
  const M = zeros(n, n);
  for (let k = 0; k < n; k++) {
    const lam = values[k];
    if (Math.abs(lam) < maxv * 1e-14) continue;
    const v = vectors[k];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i][j] += (v[i] * v[j]) / lam;
  }
  return M;
}

/**
 * Optimale Rotation R mit b_i ≈ R d_i (Horn, Quaternionen-Methode).
 * d, b: Arrays von 3-Vektoren, w: optionale Gewichte.
 */
export function absoluteOrientation(d, b, w) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (let i = 0; i < d.length; i++) {
    const wi = w ? w[i] : 1;
    const p = d[i], q = b[i];
    Sxx += wi * p[0] * q[0]; Sxy += wi * p[0] * q[1]; Sxz += wi * p[0] * q[2];
    Syx += wi * p[1] * q[0]; Syy += wi * p[1] * q[1]; Syz += wi * p[1] * q[2];
    Szx += wi * p[2] * q[0]; Szy += wi * p[2] * q[1]; Szz += wi * p[2] * q[2];
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const { vectors } = eigSym(N);
  return quatToMat(vectors[0]);
}
