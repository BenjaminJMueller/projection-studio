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

  /** Abgleich: pb = project.playback, play = gemeinsame Uhr. lead = Sekunden Vorlauf (Ausgabelatenz des Tons). */
  sync(pb, play, lead = 0) {
    const now = Date.now() + lead * 1000;
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
    m.playbackRate = c.rate;
    if (m.paused && target < dur - 0.02) m.play().catch(() => {});
  }
}
