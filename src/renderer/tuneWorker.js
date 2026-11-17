// Auswertung der Raumeinmessung im Hintergrund (Faltung und FFT dauern bei 32 Lautsprechern einige Sekunden).
import { analyzeRecording, designCorrection } from '../shared/roomeq.js';

self.onmessage = (e) => {
  const { id, kind } = e.data;
  try {
    if (kind === 'analyze') {
      const { samples, fs, n } = e.data;
      let clip = 0;
      for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 0.98) clip++;
      const r = analyzeRecording(samples, fs, n);
      self.postMessage({ id, ok: true, result: { ...r, clipped: clip > 8 } });
    } else if (kind === 'design') {
      self.postMessage({ id, ok: true, result: designCorrection(e.data.measurements) });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
