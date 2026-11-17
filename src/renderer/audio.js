// Tonausgabe der Playlist über ein Mehrkanal-Audiogerät (Web Audio).
// Signalweg: Medienelement → Aufteilung in Quellkanäle (bis 8, dazu eine Mono-Summe)
//            → je Lautsprecher ein Pegel (Gesamt × Einzel) → Zusammenführung → Gerät.
// Der AudioContext entsteht erst, wenn Ton eingeschaltet wird, und ruht bei Pause (spart CPU).
import { PlaylistPlayer } from '../shared/playlistPlayer.js';
import { logSweep, schedule, SWEEP } from '../shared/roomeq.js';

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
    const tune = a.tuning?.enabled && a.tuning.speakers?.length ? a.tuning.speakers : null;
    const key = `${n}|${Array.from({ length: n }, (_, k) => speakerAt(a, k).route).join(',')}|${tune ? JSON.stringify(tune.map((t) => [t.delay, t.filters])) : ''}`;
    if (key !== this.key) {
      if (this.nodes) for (const g of this.nodes.gains) g.disconnect();
      if (this.nodes) for (const c of this.nodes.chains) for (const x of c) x.disconnect();
      this.nodes?.merger.disconnect();
      const dest = this.ctx.destination;
      dest.channelCount = n;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      const merger = this.ctx.createChannelMerger(n);
      const gains = [], meters = [], chains = [], tests = [];
      for (let k = 0; k < n; k++) {
        const g = this.ctx.createGain();
        const r = speakerAt(a, k).route;
        if (r === 'sum') this.mono.connect(g);
        else if (r !== 'off') this.split.connect(g, Math.min(SOURCE_CHANNELS - 1, Number(r) || 0));
        // Einmessung: Laufzeit und EQ je Lautsprecher (Pegel steckt im Gain)
        const chain = [];
        const t = tune?.[k];
        if (t) {
          if (t.delay > 0.01) { const d = this.ctx.createDelay(0.5); d.delayTime.value = t.delay / 1000; chain.push(d); }
          for (const f of t.filters || []) {
            const b = this.ctx.createBiquadFilter();
            b.type = 'peaking'; b.frequency.value = f.f; b.gain.value = f.gain; b.Q.value = f.q;
            chain.push(b);
          }
        }
        let last = g;
        for (const x of chain) { last.connect(x); last = x; }
        last.connect(merger, 0, k);
        const m = this.ctx.createAnalyser();
        m.fftSize = 256;
        last.connect(m);
        // Messsignal geht ohne Korrektur direkt auf den Ausgang
        const test = this.ctx.createGain();
        test.connect(merger, 0, k);
        test.connect(m);
        gains.push(g); meters.push(m); chains.push(chain); tests.push(test);
      }
      merger.connect(dest);
      this.nodes = { merger, gains, meters, chains, tests, n };
      this.key = key;
    }
    const master = dbToGain(a.master);
    this.nodes.gains.forEach((g, k) => {
      const c = speakerAt(a, k);
      const trim = tune?.[k]?.gain || 0;
      g.gain.setTargetAtTime(c.mute ? 0 : master * dbToGain(c.gain + trim), this.ctx.currentTime, 0.02);
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
      if (this.measuring) return;
      // Bild und Ton: Ausgabelatenz und die längste Einmess-Verzögerung vorziehen
      const maxDelay = a.tuning?.enabled ? Math.max(0, ...(a.tuning.speakers || []).map((t) => t.delay || 0)) / 1000 : 0;
      this.player.sync(pb, play, (this.info()?.latency || 0) + maxDelay);
      const want = play?.playing ? 'running' : 'suspended';
      if (this.ctx.state !== want) await (want === 'running' ? this.ctx.resume() : this.ctx.suspend()).catch(() => {});
    } finally { this.busy = false; }
  }

  /**
   * Messung: Sweeps nacheinander auf allen Lautsprechern (ohne Korrektur), zum Schluss der erste noch einmal.
   * levelDb: Pegel des Messsignals. Rückgabe: Promise, erfüllt nach dem letzten Sweep.
   */
  async playSweeps(a, levelDb = -12) {
    this.measuring = true;
    this.player.stop();
    await this.ensure(a);
    this.build({ ...a, tuning: null });
    await this.ctx.resume();
    const n = this.nodes.n;
    const fs = this.ctx.sampleRate;
    const sweep = logSweep(fs);
    const buf = this.ctx.createBuffer(1, sweep.length, fs);
    buf.copyToChannel(sweep, 0);
    const { slots, total } = schedule(n);
    const t0 = this.ctx.currentTime + 0.1;
    const amp = dbToGain(levelDb);
    for (const sl of slots) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = amp;
      src.connect(g); g.connect(this.nodes.tests[sl.speaker]);
      src.start(t0 + sl.at);
      src.onended = () => { src.disconnect(); g.disconnect(); };
    }
    this.sweepRun = { t0, total };
    await new Promise((r) => setTimeout(r, (total + 0.2) * 1000));
    this.measuring = false;
    this.key = ''; // Graph mit Korrektur wieder aufbauen
    return { n, total };
  }
  /** Kurzer Probeton (rosa Rauschen, 1 s) auf einem Lautsprecher, zum Prüfen der Zuordnung und des Pegels. */
  async testTone(a, k, levelDb = -18) {
    await this.ensure(a);
    this.build(a);
    await this.ctx.resume();
    const fs = this.ctx.sampleRate, len = fs;
    const buf = this.ctx.createBuffer(1, len, fs);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      const env = Math.min(1, i / (0.02 * fs), (len - i) / (0.02 * fs));
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2 * env;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = dbToGain(levelDb);
    src.connect(g); g.connect(this.nodes.tests[Math.min(k, this.nodes.n - 1)]);
    src.start();
    src.onended = () => { src.disconnect(); g.disconnect(); };
  }

  /**
   * Aufnahme vom Messmikrofon an einem Audio-Interface (getUserMedia, ohne Signalverarbeitung des Systems).
   * Rückgabe: { stop(): Promise<{ samples, fs }>, level() }.
   */
  async recordInput(deviceId) {
    await this.ctx?.resume();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
    } });
    const ctx = new AudioContext({ latencyHint: 'playback' });
    await ctx.audioWorklet.addModule(new URL('./recorderWorklet.js', import.meta.url));
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
    const chunks = [];
    let peak = 0;
    node.port.onmessage = (e) => { chunks.push(e.data); for (let i = 0; i < e.data.length; i += 8) peak = Math.max(peak, Math.abs(e.data[i])); };
    src.connect(node);
    return {
      fs: ctx.sampleRate,
      level: () => { const p = peak; peak *= 0.5; return p; },
      stop: async () => {
        await new Promise((r) => setTimeout(r, 150));
        src.disconnect(); node.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const fs = ctx.sampleRate;
        await ctx.close();
        const n = chunks.reduce((s, c) => s + c.length, 0);
        const samples = new Float32Array(n);
        let o = 0;
        for (const c of chunks) { samples.set(c, o); o += c.length; }
        return { samples, fs };
      },
    };
  }

  async inputDevices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { return []; }
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
