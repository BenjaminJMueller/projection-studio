// Kamera für die automatische Kalibrierung: Bilder als Helligkeitswerte, Belichtung/Fokus/Weißabgleich
// feststellen, soweit die Kamera das erlaubt (Chrome: UVC-Steuerung unter Windows und Linux, unter macOS
// je nach Kamera nur teilweise). Was nicht geht, wird erkannt und im Assistenten erklärt.

const luma = (d, out) => {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return out;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listCameras() {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { return []; }
}

export class Camera {
  constructor() { this.stream = null; this.track = null; this.video = null; this.width = 0; this.height = 0; this.caps = {}; }

  async open(deviceId = '') {
    this.close();
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.track = this.stream.getVideoTracks()[0];
    this.label = this.track.label;
    this.deviceId = this.track.getSettings?.().deviceId || deviceId;
    this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: this.stream });
    await this.video.play();
    for (let i = 0; i < 50 && !this.video.videoWidth; i++) await wait(20);
    this.width = this.video.videoWidth; this.height = this.video.videoHeight;
    this.canvas = Object.assign(document.createElement('canvas'), { width: this.width, height: this.height });
    this.g = this.canvas.getContext('2d', { willReadFrequently: true });
    this.small = Object.assign(document.createElement('canvas'), { width: 640, height: Math.round((640 * this.height) / this.width) });
    this.gs = this.small.getContext('2d', { willReadFrequently: true });
    this.caps = this.track.getCapabilities?.() || {};
    return this;
  }

  /** Was sich an dieser Kamera einstellen lässt. */
  controls() {
    const c = this.caps;
    return {
      exposure: !!c.exposureMode?.includes('manual'),
      focus: !!c.focusMode?.includes('manual'),
      autofocus: !!(c.focusMode?.includes('continuous') || c.focusMode?.includes('single-shot')),
      whiteBalance: !!c.whiteBalanceMode?.includes('manual'),
      exposureTime: c.exposureTime || null,
    };
  }

  async #apply(adv) {
    if (!this.track || !Object.keys(adv).length) return false;
    try { await this.track.applyConstraints({ advanced: [adv] }); return true; } catch { return false; }
  }

  /** Alles wieder automatisch (Vorschau, Ausrichten). */
  async auto() {
    const c = this.caps, adv = {};
    if (c.exposureMode?.includes('continuous')) adv.exposureMode = 'continuous';
    if (c.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
    if (c.whiteBalanceMode?.includes('continuous')) adv.whiteBalanceMode = 'continuous';
    return this.#apply(adv);
  }

  /** Aktuelle automatische Werte übernehmen und festhalten. Rückgabe: was festgestellt wurde. */
  async lock({ exposure = true, focus = true, whiteBalance = true } = {}) {
    const ctl = this.controls(), s = this.track.getSettings?.() || {}, adv = {};
    if (exposure && ctl.exposure) { adv.exposureMode = 'manual'; if (s.exposureTime) adv.exposureTime = s.exposureTime; }
    if (focus && ctl.focus) { adv.focusMode = 'manual'; if (s.focusDistance != null) adv.focusDistance = s.focusDistance; }
    if (whiteBalance && ctl.whiteBalance) { adv.whiteBalanceMode = 'manual'; if (s.colorTemperature) adv.colorTemperature = s.colorTemperature; }
    await this.#apply(adv);
    return { exposure: !!adv.exposureMode, focus: !!adv.focusMode, whiteBalance: !!adv.whiteBalanceMode };
  }

  /** Belichtung verkürzen (Faktor < 1), falls Weiß übersteuert. */
  async darker(factor = 0.6) {
    const ctl = this.controls(), s = this.track.getSettings?.() || {};
    if (!ctl.exposure || !s.exposureTime) return false;
    const min = ctl.exposureTime?.min ?? 0;
    const t = Math.max(min, s.exposureTime * factor);
    if (t >= s.exposureTime) return false;
    return this.#apply({ exposureMode: 'manual', exposureTime: t });
  }

  /** Autofokus kurz arbeiten lassen und dann festhalten. onFrame(luma, w, h) läuft währenddessen. */
  async autofocus(ms = 1800) {
    const c = this.caps;
    const mode = c.focusMode?.includes('continuous') ? 'continuous' : c.focusMode?.includes('single-shot') ? 'single-shot' : null;
    if (!mode) return false;
    await this.#apply({ focusMode: mode });
    await wait(ms);
    if (this.controls().focus) await this.lock({ exposure: false, whiteBalance: false, focus: true });
    return true;
  }

  /** Nächstes neues Kamerabild abwarten. */
  #next() {
    const v = this.video;
    if (v.requestVideoFrameCallback) return new Promise((r) => v.requestVideoFrameCallback(() => r()));
    return wait(40);
  }

  /** Ein Bild als Helligkeit. small: auf 640 px Breite verkleinert (Vorschau, Schärfe). */
  async frame(small = false) {
    await this.#next();
    const [cv, g] = small ? [this.small, this.gs] : [this.canvas, this.g];
    g.drawImage(this.video, 0, 0, cv.width, cv.height);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    return { data: luma(d, new Uint8Array(cv.width * cv.height)), w: cv.width, h: cv.height };
  }

  /** n Bilder mitteln (weniger Rauschen). */
  async grab(n = 2) {
    if (n <= 1) return (await this.frame()).data;
    const acc = new Uint16Array(this.width * this.height);
    for (let k = 0; k < n; k++) { const f = await this.frame(); for (let i = 0; i < acc.length; i++) acc[i] += f.data[i]; }
    const out = new Uint8Array(acc.length);
    for (let i = 0; i < acc.length; i++) out[i] = Math.round(acc[i] / n);
    return out;
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null;
    if (this.video) this.video.srcObject = null;
  }
}
