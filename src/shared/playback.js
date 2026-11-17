// Videowiedergabe: gemeinsame Zeitbasis für alle Ausgabefenster.
// Der Hauptprozess legt fest, wann Position 0 war (startedAt, Date.now()-Millisekunden).
// Jedes Fenster spielt sein eigenes <video> und gleicht laufend auf diese Uhr ab.

/** Lokaler Dateipfad -> file://-URL (Windows-Laufwerksbuchstaben und Sonderzeichen). */
export function fileUrl(p) {
  if (!p) return '';
  if (/^(file|https?|blob|data):/i.test(p)) return p;
  let s = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(s)) s = `/${s}`;
  return `file://${s.split('/').map((seg) => (/^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/')}`;
}

/**
 * Sollposition in Sekunden.
 * play: { playing, startedAt, pausedAt, loop }
 */
export function targetTime(play, duration, now = Date.now()) {
  if (!play) return 0;
  let t = play.playing ? (now - play.startedAt) / 1000 : play.pausedAt || 0;
  if (!(duration > 0)) return Math.max(0, t);
  if (play.loop) t = ((t % duration) + duration) % duration;
  else t = Math.min(Math.max(0, t), duration);
  return t;
}

/**
 * Korrektur für ein laufendes Video.
 * Großer Versatz -> springen, kleiner Versatz -> Abspielgeschwindigkeit leicht anpassen.
 * Rückgabe: { seek: Sekunden | null, rate }
 */
export function syncCorrection(current, target, duration, loop) {
  let d = target - current;
  // über die Schleifengrenze hinweg den kürzeren Weg nehmen
  if (loop && duration > 0) {
    if (d > duration / 2) d -= duration;
    if (d < -duration / 2) d += duration;
  }
  if (Math.abs(d) > 0.3) return { seek: target, rate: 1 };
  const rate = 1 + Math.max(-0.05, Math.min(0.05, d * 0.5));
  return { seek: null, rate: Math.abs(d) < 0.008 ? 1 : rate };
}

/** Neuer Wiedergabezustand nach Play/Pause/Neustart. */
export function playState(prev, action, duration, now = Date.now()) {
  const loop = prev?.loop ?? true;
  const pos = targetTime(prev, duration, now);
  if (action === 'play') return { playing: true, startedAt: now - pos * 1000, pausedAt: pos, loop };
  if (action === 'pause') return { playing: false, startedAt: prev?.startedAt ?? now, pausedAt: pos, loop };
  if (action === 'restart') return { playing: prev?.playing ?? false, startedAt: now, pausedAt: 0, loop };
  return prev;
}
