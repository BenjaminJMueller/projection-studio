// Solver im Hintergrund-Thread, damit die Oberfläche flüssig bleibt.
import { solveProjector, suggestNextImageRegion } from '../core/solver.js';
import { getLensPreset } from '../core/lenses.js';

self.onmessage = (e) => {
  const { seq, projectorId, req } = e.data;
  try {
    const lens = req.lens || getLensPreset(req.lensId);
    const res = solveProjector({ ...req, lens });
    const imgs = req.points.filter((p) => p.enabled !== false && p.image).map((p) => p.image);
    res.suggest = suggestNextImageRegion(imgs, req.width, req.height);
    self.postMessage({ seq, projectorId, res });
  } catch (err) {
    self.postMessage({ seq, projectorId, res: { ok: false, message: String(err?.message || err) } });
  }
};
