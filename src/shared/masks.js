// Eigene Masken (Polygone mit weicher Kante) pro Projektor.
// mask = { id, name, mode: 'hide' | 'show', feather: px, points: [[u,v],...], closed: bool, enabled: bool }

function polyPath(g, pts) {
  g.beginPath();
  pts.forEach(([u, v], i) => (i ? g.lineTo(u, v) : g.moveTo(u, v)));
  g.closePath();
}

/** Masken-Umrisse für den Editor (in Projektorpixeln, Transform muss gesetzt sein). */
export function drawMaskShapes(g, masks, { activeMask, px = 1, editing = false } = {}) {
  for (const m of masks) {
    if (!m.points.length) continue;
    const active = m.id === activeMask;
    if (m.closed && m.enabled !== false) {
      g.fillStyle = m.mode === 'hide' ? 'rgba(255,90,95,0.18)' : 'rgba(52,199,89,0.12)';
      polyPath(g, m.points);
      g.fill();
    }
    g.strokeStyle = active ? '#4da3ff' : m.mode === 'hide' ? 'rgba(255,90,95,.8)' : 'rgba(52,199,89,.8)';
    g.lineWidth = (active ? 2 : 1) * px;
    g.setLineDash(m.closed ? [] : [6 * px, 4 * px]);
    g.beginPath();
    m.points.forEach(([u, v], i) => (i ? g.lineTo(u, v) : g.moveTo(u, v)));
    if (m.closed) g.closePath();
    g.stroke();
    g.setLineDash([]);
    // Feather-Zone andeuten
    if (active && m.closed && m.feather > 0) {
      g.strokeStyle = 'rgba(77,163,255,.25)';
      g.lineWidth = m.feather;
      polyPath(g, m.points);
      g.stroke();
    }
    if (editing && active) {
      for (const [u, v] of m.points) {
        g.fillStyle = '#4da3ff';
        g.fillRect(u - 4 * px, v - 4 * px, 8 * px, 8 * px);
      }
    }
  }
}

/**
 * Masken als Graustufenbild rendern (weiß = sichtbar, schwarz = aus).
 * Weiche Kante über Gauß-Unschärfe (GPU-beschleunigt im Canvas).
 */
export function renderMaskCanvas(masks, W, H, scale = 1, canvas) {
  const c = canvas || document.createElement('canvas');
  c.width = Math.round(W * scale);
  c.height = Math.round(H * scale);
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const active = masks.filter((m) => m.closed && m.enabled !== false && m.points.length >= 3);
  const shows = active.filter((m) => m.mode === 'show');
  const hides = active.filter((m) => m.mode === 'hide');
  g.setTransform(scale, 0, 0, scale, 0, 0);
  if (shows.length) {
    // Nur innerhalb der "show"-Formen sichtbar
    const s = document.createElement('canvas');
    s.width = c.width; s.height = c.height;
    const sg = s.getContext('2d');
    sg.fillStyle = '#000';
    sg.fillRect(0, 0, s.width, s.height);
    sg.setTransform(scale, 0, 0, scale, 0, 0);
    for (const m of shows) {
      sg.filter = m.feather > 0 ? `blur(${(m.feather * scale) / 2}px)` : 'none';
      sg.fillStyle = '#fff';
      polyPath(sg, m.points);
      sg.fill();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.drawImage(s, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.setTransform(scale, 0, 0, scale, 0, 0);
  }
  for (const m of hides) {
    g.filter = m.feather > 0 ? `blur(${(m.feather * scale) / 2}px)` : 'none';
    g.fillStyle = '#000';
    polyPath(g, m.points);
    g.fill();
  }
  g.filter = 'none';
  g.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}
