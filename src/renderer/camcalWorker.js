// Rechenteil der Kamera-Kalibrierung im Hintergrund: Strahlen aufs Modell, Kamera-Standort, Projektor-Lösung.
import { buildRaycaster, cameraFromReference, projectorPoints, robustSolve, coverageReport, selfCalibrate } from '../core/autocal.js';

let intersect = null;

self.onmessage = (e) => {
  const { id, kind } = e.data;
  try {
    let result;
    if (kind === 'mesh') { intersect = buildRaycaster(e.data.positions, e.data.index); result = true; }
    else if (!intersect) throw new Error('Kein 3D-Modell geladen.');
    else if (kind === 'pose') result = cameraFromReference(e.data.cells, e.data.ref, intersect, e.data.camW, e.data.camH);
    else if (kind === 'points') result = projectorPoints(e.data.cells, e.data.cam, intersect);
    else if (kind === 'self') {
      const res = selfCalibrate(e.data.opts, intersect);
      result = res.ok ? { ...res, report: coverageReport(res.points.map((p) => p.image), e.data.opts.width, e.data.opts.height) } : res;
    } else if (kind === 'solve') {
      const res = robustSolve(e.data.opts);
      result = { ...res, report: coverageReport((res.points || e.data.opts.points).map((p) => p.image), e.data.opts.width, e.data.opts.height) };
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
