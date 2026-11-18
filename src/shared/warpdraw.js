// Zeichnet die Feinkorrektur (Gitterlinien, Gitterpunkte, freie Punkte) in einen 2D-Canvas.
// Gemeinsam für die Vorschau im Hauptfenster und das Overlay auf den Projektoren.
import { makeWarp, gridBase, bezierHandles } from './warp.js';

/** Bézier-Anfasser des Gitterpunkts i, so verschoben, dass sie am sichtbaren Punkt hängen (freie Punkte eingerechnet). */
export function visibleBezierHandles(w, i, ev = makeWarp(w)) {
  const h = bezierHandles(w, i);
  const [bu, bv] = gridBase(w, i);
  const f = ev.forward(bu, bv);
  const du = f[0] - h.node[0], dv = f[1] - h.node[1];
  const out = {};
  for (const k of ['node', 'right', 'left', 'down', 'up']) out[k] = [h[k][0] + du, h[k][1] + dv];
  return out;
}

/**
 * g: CanvasRenderingContext2D, W/H: Zeichenfläche in Einheiten von g, px: ein Bildschirmpixel in diesen Einheiten.
 * sel: { handle: Index Gitterpunkt | null, pin: Index freier Punkt | null }
 */
export function drawWarpOverlay(g, w, W, H, px, sel = {}) {
  const ev = makeWarp(w);
  const n = Math.max(3, Math.min(24, Math.round(160 / Math.max(w.cols, w.rows))));
  const line = (fn, steps) => {
    g.beginPath();
    for (let k = 0; k <= steps; k++) { const [u, v] = fn(k / steps); k ? g.lineTo(u * W, v * H) : g.moveTo(u * W, v * H); }
    g.stroke();
  };
  g.lineWidth = 1.2 * px;
  g.strokeStyle = 'rgba(255,255,255,.65)';
  for (let r = 0; r < w.rows; r++) line((t) => ev.forward(t, r / (w.rows - 1)), n * (w.cols - 1));
  for (let c = 0; c < w.cols; c++) line((t) => ev.forward(c / (w.cols - 1), t), n * (w.rows - 1));
  // Gitterpunkte: bei großen Gittern kleiner
  const big = Math.max(w.cols, w.rows) > 9;
  w.offsets.forEach((_, i) => {
    const [bu, bv] = gridBase(w, i);
    const [u, v] = ev.forward(bu, bv);
    const on = i === sel.handle;
    g.beginPath(); g.arc(u * W, v * H, (on ? 7 : big ? 3.5 : 5) * px, 0, Math.PI * 2);
    g.fillStyle = on ? '#0a84ff' : 'rgba(30,30,34,.9)'; g.fill();
    g.lineWidth = (big && !on ? 1 : 1.5) * px; g.strokeStyle = '#fff'; g.stroke();
  });
  // Bézier-Anfasser am gewählten Gitterpunkt
  if (w.bezier && sel.handle != null && w.offsets[sel.handle]) {
    const h = visibleBezierHandles(w, sel.handle, ev);
    g.lineWidth = 1.2 * px; g.strokeStyle = '#0a84ff';
    for (const k of ['right', 'left', 'down', 'up']) {
      g.beginPath(); g.moveTo(h.node[0] * W, h.node[1] * H); g.lineTo(h[k][0] * W, h[k][1] * H); g.stroke();
    }
    for (const k of ['right', 'left', 'down', 'up']) {
      const s = 4.5 * px;
      g.fillStyle = '#fff'; g.fillRect(h[k][0] * W - s, h[k][1] * H - s, 2 * s, 2 * s);
      g.strokeStyle = '#0a84ff'; g.strokeRect(h[k][0] * W - s, h[k][1] * H - s, 2 * s, 2 * s);
    }
  }
  // freie Punkte: Raute, Reichweite als Kreis beim gewählten
  (w.pins || []).forEach((p, i) => {
    const x = (p.at[0] + p.off[0]) * W, y = (p.at[1] + p.off[1]) * H;
    const on = i === sel.pin;
    if (on) {
      g.beginPath(); g.ellipse(x, y, (w.radius * W) / (w.aspect || 16 / 9), w.radius * H, 0, 0, Math.PI * 2);
      g.setLineDash([6 * px, 5 * px]); g.lineWidth = px; g.strokeStyle = 'rgba(10,132,255,.8)'; g.stroke(); g.setLineDash([]);
    }
    const r = (on ? 8 : 6.5) * px;
    g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
    g.fillStyle = on ? '#0a84ff' : '#f0a531'; g.fill();
    g.lineWidth = 1.5 * px; g.strokeStyle = '#fff'; g.stroke();
    // Nummer wie in der Liste im Inspektor
    g.font = `600 ${11 * px}px -apple-system, system-ui, sans-serif`; g.textBaseline = 'middle';
    g.lineWidth = 3 * px; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(String(i + 1), x + r + 3 * px, y);
    g.fillStyle = '#fff'; g.fillText(String(i + 1), x + r + 3 * px, y);
  });
}
