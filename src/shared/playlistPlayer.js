// Spielt eine Playlist synchron zur gemeinsamen Uhr ab (Bild in den Ausgabefenstern, Ton im Hauptfenster).
// Zwei Medienelemente: eines spielt, das andere hält den nächsten Eintrag bereit (geladen, auf 0).
// Beim Wechsel wird nur getauscht, dadurch fast ohne Lücke.
import { fileUrl, targetTime, syncCorrection, playlistOf, totalDuration, locate } from './playback.js';

export class PlaylistPlayer {
  /** make(): neues HTMLMediaElement. onSwap(element, index): aktives Element hat gewechselt. */
  constructor(make, onSwap = () => {}) {
    this.players = [0, 1].map(() => ({ el: make(), url: '' }));
    this.cur = 0;
    this.onSwap = onSwap;
  }
  get el() { return this.players[this.cur].el; }

  setSrc(pl, url) {
    if (pl.url === url) return;
    pl.url = url;
    if (!url) { pl.el.removeAttribute('src'); pl.el.load(); return; }
    pl.el.src = url;
    pl.el.load();
  }
  activate(i) {
    if (this.cur === i) return;
    this.players[this.cur].el.pause();
    this.cur = i;
    this.onSwap(this.players[i].el, i);
  }
  stop() { for (const pl of this.players) { if (!pl.el.paused) pl.el.pause(); this.setSrc(pl, ''); } }

  /**
   * Bildgenauer Abgleich (Schalter „Präzise Synchronisierung“), aufgerufen je gezeigtem Videobild aus
   * requestVideoFrameCallback. Misst, welches Bild zu welchem Zeitpunkt wirklich auf dem Bildschirm
   * erscheint, statt currentTime zu schätzen, und regelt die Abspielgeschwindigkeit sanft nach.
   * delayMs: dieser Ausgang zeigt um so viel später (unterschiedliche Projektor-Latenzen ausgleichen).
   * Kosten: ein paar Rechenschritte pro Videobild.
   */
  frameSync(el, meta, pb, play, delayMs = 0) {
    if (el !== this.el || !play?.playing || !meta) return;
    const dur = el.duration;
    if (!(dur > 0)) return;
    // Bilddauer aus aufeinanderfolgenden Bildern schätzen
    const f = this.fm;
    if (f && meta.presentedFrames > f.n && meta.mediaTime > f.t) {
      const d = (meta.mediaTime - f.t) / (meta.presentedFrames - f.n);
      if (d > 0.004 && d < 0.2) this.frameDur = this.frameDur ? this.frameDur * 0.9 + d * 0.1 : d;
    }
    this.fm = { n: meta.presentedFrames, t: meta.mediaTime };
    const items = playlistOf(pb);
    const single = items.length === 1;
    const wall = Date.now() - performance.now() + meta.expectedDisplayTime - delayMs;
    let target;
    if (single) target = targetTime(play, dur, wall);
    else {
      const loc = locate(items, targetTime(play, totalDuration(items), wall));
      if (fileUrl(items[loc.index].src) !== this.players[this.cur].url) return; // Wechsel macht sync()
      target = loc.local;
    }
    // Bildmitte gegen Sollzeit: >0 = Bild zu früh. Nahe der Schleifengrenze nicht messen (Sprung).
    const fd = this.frameDur || 1 / 30;
    if (single && play.loop && (meta.mediaTime < 0.15 || meta.mediaTime > dur - 0.15)) return;
    let err = meta.mediaTime + fd / 2 - target;
    if (single && play.loop) { if (err > dur / 2) err -= dur; if (err < -dur / 2) err += dur; }
    this.precise = performance.now();
    if (Math.abs(err) > 0.3) { this.errs = []; el.currentTime = Math.min(target, dur); return; }
    // Median der letzten 7 Bilder (robust gegen einzelne verspätete Bilder), nur alle 4 Bilder nachregeln
    const errs = (this.errs ||= []);
    errs.push(err);
    if (errs.length > 7) errs.shift();
    if (errs.length < 3 || meta.presentedFrames % 4) return;
    const e = [...errs].sort((a, b) => a - b)[errs.length >> 1];
    // Weit daneben (z. B. Decoder kommt bei +5 % nicht hinterher): einmal springen, höchstens alle 2 s.
    // Sprungziel = Sollzeit jetzt plus die bisher beobachtete Nachlaufzeit des Sprungs.
    const t = performance.now();
    if (Math.abs(e) > 0.08 && t - (this.lastJump || 0) > 2000) {
      this.jumpLag = this.lastJump && t - this.lastJump < 6000 ? Math.min(0.5, (this.jumpLag || 0) - e) : Math.max(0, -e);
      this.lastJump = t;
      this.errs = [];
      const now = single ? targetTime(play, dur, Date.now() - delayMs) : target + (Date.now() - wall - delayMs) / 1000;
      const to = now + this.jumpLag;
      el.currentTime = single && play.loop ? to % dur : Math.min(Math.max(0, to), dur);
      return;
    }
    // wie syncCorrection, aber mit gemessener statt geschätzter Zeit; Schritte von 0,25 %
    const rate = Math.abs(e) < 0.004 ? 1 : 1 - Math.max(-0.05, Math.min(0.05, Math.round(e * 0.5 * 400) / 400));
    if (rate !== el.playbackRate) el.playbackRate = rate;
  }

  /** Abgleich: pb = project.playback, play = gemeinsame Uhr. lead = Sekunden Vorlauf (Ausgabelatenz des Tons). */
  sync(pb, play, lead = 0, delayMs = 0) {
    const now = Date.now() + lead * 1000 - delayMs;
    const items = playlistOf(pb);
    if (!items.length || !play) return this.stop();
    const total = totalDuration(items);
    const { index, local } = total > 0 ? locate(items, targetTime(play, total, now)) : { index: 0, local: 0 };
    const url = fileUrl(items[index].src);
    const found = this.players.findIndex((pl) => pl.url === url);
    if (found >= 0) this.activate(found); else this.setSrc(this.players[this.cur], url);
    const spare = this.players[1 - this.cur];
    const nextIdx = items.length > 1 ? (index + 1) % items.length : -1;
    if (nextIdx >= 0 && nextIdx !== index) {
      const nu = fileUrl(items[nextIdx].src);
      if (nu === url) { /* gleiche Datei: nichts vorzuladen */ } else if (spare.url !== nu) this.setSrc(spare, nu);
      else if (spare.el.paused && spare.el.currentTime > 0 && spare.el.readyState >= 1) spare.el.currentTime = 0;
    } else if (spare.url && spare.url !== url) this.setSrc(spare, '');
    if (!spare.el.paused) spare.el.pause();
    const m = this.el, dur = m.duration;
    if (!(dur > 0)) return;
    const single = items.length === 1;
    m.loop = single && !!play.loop;
    const target = Math.min(single ? targetTime(play, dur, now) : local, dur);
    if (!play.playing) {
      if (!m.paused) m.pause();
      if (Math.abs(m.currentTime - target) > 0.04) m.currentTime = target;
      return;
    }
    const c = syncCorrection(m.currentTime, target, dur, single && play.loop);
    if (c.seek != null) m.currentTime = c.seek;
    // bei präziser Synchronisierung regelt frameSync() die Geschwindigkeit
    if (!(pb.precise && performance.now() - (this.precise || 0) < 500)) m.playbackRate = c.rate;
    if (m.paused && target < dur - 0.02) m.play().catch(() => {});
  }
}
