// Tonausgabe der Playlist über ein Mehrkanal-Audiogerät (Web Audio).
// Signalweg: Medienelement → Aufteilung in Quellkanäle (bis 8, dazu eine Mono-Summe)
//            → je Lautsprecher ein Pegel (Gesamt × Einzel) → Zusammenführung → Gerät.
// Der AudioContext entsteht erst, wenn Ton eingeschaltet wird, und ruht bei Pause (spart CPU).
import { PlaylistPlayer } from '../shared/playlistPlayer.js';

export const MAX_SPEAKERS = 32;
export const SOURCE_CHANNELS = 8;
export const dbToGain = (db) => (db <= -60 ? 0 : 10 ** (db / 20));

/** Standard-Zuordnung: Lautsprecher k bekommt Quellkanal k (bei Stereo abwechselnd L/R). */
export function defaultRoute(k, srcCount = 2) { return k % Math.max(1, srcCount); }

export const SAMPLE_RATES = [0, 44100, 48000, 88200, 96000];
export const BUFFER_SIZES = [128, 256, 512, 1024, 2048, 4096];

export function defaultAudio() {
  // sampleRate 0 = wie das Gerät; buffer in Samples (wird als Latenzwunsch an das System gegeben)
  return { enabled: false, deviceId: '', sampleRate: 0, buffer: 1024, speakers: 2, master: 0, channels: [] };
}

/** Einstellungen eines Lautsprechers (fehlende werden ergänzt). */
export function speakerAt(a, k) {
  return a.channels[k] || { route: defaultRoute(k), gain: 0, mute: false };
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.newPlayer();
    this.nodes = null;
    this.key = '';
    this.peaks = new Float32Array(MAX_SPEAKERS);
    this.buf = new Float32Array(256);
  }

  newPlayer() {
    this.player = new PlaylistPlayer(() => {
      const m = new Audio();
      m.preload = 'auto';
      m.crossOrigin = 'anonymous';
      return m;
    });
    this.sources = new Map(); // Element → MediaElementSourceNode (geht pro Element nur einmal)
  }

  /** Sample-Rate oder Puffer geändert: Context neu anlegen (und damit auch die Medienelemente). */
  async reset() {
    this.player.stop();
    const c = this.ctx;
    this.ctx = null; this.nodes = null; this.key = ''; this.deviceId = undefined;
    this.newPlayer();
    if (c) await c.close().catch(() => {});
  }

  /** Tatsächliche Werte des laufenden Context, für die Anzeige. */
  info() {
    if (!this.ctx) return null;
    return { sampleRate: this.ctx.sampleRate, maxChannels: this.ctx.destination.maxChannelCount,
      latency: (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) };
  }

  get maxChannels() { return this.ctx ? this.ctx.destination.maxChannelCount : 2; }

  async ensure(a) {
    const cfg = `${a.sampleRate || 0}|${a.buffer || 1024}`;
    if (this.ctx && cfg !== this.cfg) await this.reset();
    if (!this.ctx) {
      this.cfg = cfg;
      const rate = a.sampleRate || undefined;
      this.ctx = new AudioContext({ latencyHint: (a.buffer || 1024) / (rate || 48000), ...(rate ? { sampleRate: rate } : {}) });
      this.input = this.ctx.createGain();
      this.split = this.ctx.createChannelSplitter(SOURCE_CHANNELS);
      this.mono = this.ctx.createGain();
      this.mono.channelCount = 1;
      this.mono.channelCountMode = 'explicit';
      this.mono.channelInterpretation = 'speakers';
      this.input.connect(this.split);
      this.input.connect(this.mono);
      for (const pl of this.player.players) this.connectEl(pl.el);
    }
    if ((a.deviceId || '') !== (this.deviceId || '') && this.ctx.setSinkId) {
      try { await this.ctx.setSinkId(a.deviceId || ''); this.deviceId = a.deviceId || ''; } catch (e) { console.warn('Audiogerät:', e.message); }
    }
  }
  connectEl(el) {
    if (this.sources.has(el)) return;
    const src = this.ctx.createMediaElementSource(el);
    src.connect(this.input);
    this.sources.set(el, src);
  }

  /** Graph nur neu bauen, wenn sich Anzahl oder Zuordnung ändert; Pegel werden direkt gesetzt. */
  build(a) {
    const n = Math.min(a.speakers, this.maxChannels, MAX_SPEAKERS);
    const key = `${n}|${Array.from({ length: n }, (_, k) => speakerAt(a, k).route).join(',')}`;
    if (key !== this.key) {
      if (this.nodes) for (const g of this.nodes.gains) g.disconnect();
      this.nodes?.merger.disconnect();
      const dest = this.ctx.destination;
      dest.channelCount = n;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      const merger = this.ctx.createChannelMerger(n);
      const gains = [], meters = [];
      for (let k = 0; k < n; k++) {
        const g = this.ctx.createGain();
        const r = speakerAt(a, k).route;
        if (r === 'sum') this.mono.connect(g);
        else if (r !== 'off') this.split.connect(g, Math.min(SOURCE_CHANNELS - 1, Number(r) || 0));
        g.connect(merger, 0, k);
        const m = this.ctx.createAnalyser();
        m.fftSize = 256;
        g.connect(m);
        gains.push(g); meters.push(m);
      }
      merger.connect(dest);
      this.nodes = { merger, gains, meters, n };
      this.key = key;
    }
    const master = dbToGain(a.master);
    this.nodes.gains.forEach((g, k) => {
      const c = speakerAt(a, k);
      g.gain.setTargetAtTime(c.mute ? 0 : master * dbToGain(c.gain), this.ctx.currentTime, 0.02);
    });
  }

  /** Abgleich mit Projekt und Uhr; ohne Ton bleibt alles aus. */
  async sync(pb, play, a) {
    if (!a?.enabled || !pb) {
      this.player.stop();
      if (this.ctx?.state === 'running') this.ctx.suspend();
      return;
    }
    if (this.busy) return; // Gerätewechsel o. Ä. läuft noch
    this.busy = true;
    try {
      await this.ensure(a);
      this.build(a);
      this.player.sync(pb, play, this.info()?.latency || 0);
      const want = play?.playing ? 'running' : 'suspended';
      if (this.ctx.state !== want) await (want === 'running' ? this.ctx.resume() : this.ctx.suspend()).catch(() => {});
    } finally { this.busy = false; }
  }

  /** Spitzenpegel je Lautsprecher in dBFS (für die Anzeige), mit kurzem Abfall. */
  levels() {
    if (!this.nodes) return [];
    const out = [];
    for (let k = 0; k < this.nodes.n; k++) {
      this.nodes.meters[k].getFloatTimeDomainData(this.buf);
      let p = 0;
      for (let i = 0; i < this.buf.length; i++) { const v = Math.abs(this.buf[i]); if (v > p) p = v; }
      this.peaks[k] = Math.max(p, this.peaks[k] * 0.85);
      out.push(this.peaks[k] > 1e-5 ? 20 * Math.log10(this.peaks[k]) : -90);
    }
    return out;
  }

  async devices() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    } catch { return []; }
  }
}
