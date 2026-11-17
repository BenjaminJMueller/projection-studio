// Assistent für die Raumeinmessung: Mikrofon wählen → an mehreren Stellen messen → Korrektur übernehmen.
// Die Rechnung steckt in shared/roomeq.js, hier nur Ablauf und Oberfläche.
import { schedule } from '../shared/roomeq.js';

export function createTuning(h) {
  const { el, ic, tr, nf, api, audio, A, markDirty, refresh, toast } = h;
  const worker = new Worker(new URL('./tuneWorker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map();
  worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); e.data.ok ? p?.resolve(e.data.result) : p?.reject(new Error(e.data.error)); };
  const run = (msg, transfer = []) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer); });

  const W = {
    step: 'mic', mic: 'phone', positions: 4, level: -12, server: null, phone: null, phoneLevel: 0,
    inputs: [], inputId: '', measurements: [], current: null, busy: false, message: '', result: null, sel: 0,
  };
  const root = () => document.getElementById('tuneSheet');
  const n = () => Math.min(A().speakers, audio.maxChannels || A().speakers);

  api.onMeasureEvent?.((ev) => {
    if (ev.type === 'phone') { W.phone = ev.phone; render(); }
    if (ev.type === 'level') { W.phoneLevel = ev.level || 0; const m = document.getElementById('tuneLevel'); if (m) setMeter(m, W.phoneLevel); }
  });
  function setMeter(m, v) {
    const db = 20 * Math.log10(v + 1e-9);
    m.firstChild.style.clipPath = `inset(0 ${(100 - Math.max(0, Math.min(1, (db + 70) / 70)) * 100).toFixed(1)}% 0 0)`;
  }

  async function open() {
    if (!A().enabled) { toast('Erst „Ton ausgeben“ einschalten.'); return; }
    Object.assign(W, { step: 'mic', measurements: [], result: null, message: '', busy: false });
    root().classList.remove('hidden');
    W.inputs = await audio.inputDevices();
    render();
    if (W.mic === 'phone') startPhone();
  }
  function close() {
    root().classList.add('hidden');
    api.measureStop?.();
    W.server = null; W.phone = null;
    stopInputMeter();
  }
  async function startPhone(address) {
    if (!api.measureStart) { W.message = 'Nur in der App verfügbar.'; return render(); }
    const r = await api.measureStart(address);
    if (!r.ok) { W.message = r.error; W.server = null; } else { W.server = r; W.message = ''; }
    render();
  }

  // Pegelanzeige für das Messmikrofon am Interface, solange der Schritt offen ist
  let inputMeter = null;
  async function startInputMeter() {
    stopInputMeter();
    try {
      const rec = await audio.recordInput(W.inputId);
      inputMeter = { rec, timer: setInterval(() => { const m = document.getElementById('tuneLevel'); if (m) setMeter(m, rec.level()); }, 100) };
      W.inputs = await audio.inputDevices(); // Namen sind erst nach der Freigabe sichtbar
    } catch (e) { W.message = `Mikrofon: ${e.message}`; render(); }
  }
  function stopInputMeter() {
    if (!inputMeter) return;
    clearInterval(inputMeter.timer);
    inputMeter.rec.stop();
    inputMeter = null;
  }

  async function measure() {
    W.busy = true; W.message = ''; W.current = null; render();
    const count = n();
    const { total } = schedule(count);
    try {
      let rec;
      if (W.mic === 'phone') {
        api.measureMessage(tr(`Messstelle ${W.measurements.length + 1}: bitte ruhig sein.`));
        let started;
        const go = new Promise((r) => { started = r; });
        const off = api.onMeasureEvent((ev) => { if (ev.type === 'started') started(); });
        const recP = api.measureRecord(total + 2.5);
        const t = setTimeout(() => started('timeout'), 8000);
        const s = await go; clearTimeout(t); off?.();
        if (s === 'timeout') throw new Error(tr('Das Handy startet die Aufnahme nicht. Ist die Seite offen und das Display an?'));
        await new Promise((r) => setTimeout(r, 600)); // Aufnahme sicher angelaufen
        await audio.playSweeps(A(), W.level);
        const res = await recP;
        if (!res.ok) throw new Error(res.error);
        rec = res;
      } else {
        stopInputMeter();
        const r = await audio.recordInput(W.inputId);
        await new Promise((x) => setTimeout(x, 300));
        await audio.playSweeps(A(), W.level);
        await new Promise((x) => setTimeout(x, 800)); // Nachhall
        rec = await r.stop();
      }
      W.message = tr('Wird ausgewertet …'); render();
      const res = await run({ kind: 'analyze', samples: rec.samples, fs: rec.fs, n: count }, [rec.samples.buffer]);
      W.current = check(res);
      W.message = '';
    } catch (e) {
      W.message = e.message;
    }
    W.busy = false;
    render();
  }
  /** Plausibilität: übersteuert, zu leise, Lautsprecher fehlt. */
  function check(res) {
    const sp = res.speakers;
    const peaks = sp.map((s) => 20 * Math.log10(s.peak + 1e-12));
    const med = [...peaks].sort((a, b) => a - b)[Math.floor(peaks.length / 2)];
    const issues = [];
    if (res.clipped) issues.push('Übersteuert. Messpegel senken oder Mikrofon weiter weg.');
    sp.forEach((s, k) => {
      if (peaks[k] < med - 25) issues.push(tr(`Lautsprecher ${k + 1} ist kaum zu hören. Verkabelung und Zuordnung prüfen.`));
      else if (s.snr < 20) issues.push(tr(`Lautsprecher ${k + 1}: zu viel Störgeräusch (${Math.round(s.snr)} dB Abstand).`));
    });
    return { ...res, issues, ok: !res.clipped && !sp.some((s, k) => peaks[k] < med - 25) };
  }
  function keep() {
    W.measurements.push(W.current.speakers);
    W.current = null;
    if (W.measurements.length >= W.positions) evaluate(); else render();
  }
  async function evaluate() {
    W.busy = true; W.message = tr('Korrektur wird berechnet …'); render();
    try {
      W.result = await run({ kind: 'design', measurements: W.measurements });
      W.step = 'result'; W.message = '';
    } catch (e) { W.message = e.message; }
    W.busy = false; render();
  }
  function apply() {
    const a = A();
    a.tuning = {
      enabled: true,
      date: new Date().toISOString(),
      positions: W.measurements.length,
      mic: W.mic,
      speakers: W.result.map((r) => ({ delay: +r.delay.toFixed(3), gain: +r.gain.toFixed(1), filters: r.filters })),
    };
    markDirty();
    close();
    refresh();
    toast('Einmessung übernommen');
  }

  // ------------------------------------------------------------ Oberfläche
  function micStep() {
    const phone = W.mic === 'phone';
    const choice = (id, icon, title, sub) => el('button', { class: `choice ${W.mic === id ? 'on' : ''}`, onclick: () => {
      W.mic = id; W.message = '';
      if (id === 'phone') { stopInputMeter(); if (!W.server) startPhone(); } else { api.measureStop?.(); W.server = null; startInputMeter(); }
      render();
    } }, el('div', { class: 'ci', html: h.icon(icon, 26) }), el('b', {}, title), el('span', {}, sub));
    return [
      el('h1', {}, 'Raum einmessen'),
      el('p', { class: 'lead' }, 'Jeder Lautsprecher spielt nacheinander einen kurzen Ton. Gemessen wird an mehreren Stellen der Liegefläche, die Korrektur gilt für den ganzen Raum, nicht für einen Punkt.'),
      el('div', { class: 'choices' },
        choice('phone', 'phone', 'Smartphone', 'per QR-Code, im selben WLAN'),
        choice('interface', 'mic', 'Messmikrofon', 'an einem Audio-Interface')),
      phone ? phoneBox() : interfaceBox(),
    ];
  }
  function phoneBox() {
    const s = W.server;
    if (!s) return el('p', { class: 'lead tune-msg' }, W.message || 'Startet …');
    const connected = W.phone && Date.now() - W.phone.seen < 10000;
    return el('div', { class: 'tune-qr' },
      el('img', { src: s.qr, alt: 'QR-Code', width: 148, height: 148 }),
      el('div', {},
        el('b', {}, connected ? 'Handy verbunden' : 'Mit dem Handy scannen'),
        el('p', {}, connected ? 'Mikrofon ist freigegeben. Handy an die erste Messstelle legen.' : 'Kamera-App öffnen, Code scannen, die Warnung zum Zertifikat einmal bestätigen und „Mikrofon freigeben“ tippen.'),
        connected ? el('div', { class: 'meter big', id: 'tuneLevel' }, el('i')) : el('code', {}, s.url),
        s.addresses?.length > 1 ? el('select', { onchange: (e) => startPhone(e.target.value), 'aria-label': 'Netzwerk' }, ...s.addresses.map((a) => el('option', { value: a.address, selected: a.address === s.ip }, `${a.name} · ${a.address}`))) : null));
  }
  function interfaceBox() {
    return el('div', { class: 'group' },
      el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Eingang')),
        el('div', { class: 'ctl' }, el('select', { onchange: (e) => { W.inputId = e.target.value; startInputMeter(); } },
          el('option', { value: '' }, 'Standardeingang'), ...W.inputs.filter((d) => d.deviceId !== 'default').map((d) => el('option', { value: d.deviceId, selected: d.deviceId === W.inputId }, d.label || 'Eingang'))))),
      el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Pegel')), el('div', { class: 'ctl' }, el('div', { class: 'meter big', id: 'tuneLevel', style: 'width:100%' }, el('i')))));
  }
  function setupRows() {
    return el('div', { class: 'group' },
      el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Messstellen', el('span', { class: 'sub' }, 'verteilt über die Liegefläche, Mikrofon auf Kopfhöhe nach oben'))),
        el('div', { class: 'ctl' }, el('select', { onchange: (e) => { W.positions = Number(e.target.value); render(); } }, ...[1, 2, 3, 4, 5, 6, 8].map((v) => el('option', { value: v, selected: v === W.positions }, String(v)))))),
      el('div', { class: 'r' }, el('div', { class: 'lbl' }, el('span', {}, 'Messpegel', el('span', { class: 'sub' }, 'so laut, dass es deutlich über dem Raumgeräusch liegt'))),
        el('div', { class: 'ctl' }, el('select', { onchange: (e) => { W.level = Number(e.target.value); } }, ...[-30, -24, -18, -12, -6].map((v) => el('option', { value: v, selected: v === W.level }, `${v} dB`))),
          el('button', { class: 'btn', onclick: () => audio.testTone(A(), 0, W.level - 6) }, 'Probeton'))));
  }
  function measureStep() {
    const k = W.measurements.length + 1;
    const c = W.current;
    const dur = Math.round(schedule(n()).total);
    return [
      el('h1', {}, `Messstelle ${k} von ${W.positions}`),
      el('p', { class: 'lead' }, k === 1 ? 'Mikrofon in die Mitte der Liegefläche legen, nach oben gerichtet. Raum ruhig halten.' : 'Mikrofon an eine andere Stelle legen, z. B. an den Rand oder zwischen zwei Lautsprechergruppen.'),
      el('div', { class: 'tune-pos' }, ...Array.from({ length: W.positions }, (_, i) => el('i', { class: i < W.measurements.length ? 'done' : i === W.measurements.length ? 'now' : '' }))),
      c ? el('div', { class: `status ${c.ok ? 'ok' : 'warn'}` },
        el('div', { class: 'head' }, el('div', { class: 'ic-wrap' }, ic(c.ok ? 'check' : 'alert', 16)),
          el('div', {}, el('b', {}, c.ok ? 'Messung in Ordnung' : 'Messung prüfen'), el('span', {}, `${n()} Lautsprecher · Störabstand mindestens ${Math.round(Math.min(...c.speakers.map((s) => s.snr)))} dB`))),
        c.issues.length ? el('div', { class: 'notes' }, ...c.issues.slice(0, 5).map((t) => el('div', {}, ic('alert', 14), el('span', {}, t)))) : null)
        : el('p', { class: 'lead tune-msg' }, W.busy ? (W.message || `Misst … etwa ${dur} Sekunden`) : `${n()} Lautsprecher, etwa ${dur} Sekunden.`),
      W.message && !W.busy ? el('p', { class: 'lead tune-msg bad' }, W.message) : null,
    ];
  }
  function resultStep() {
    const R = W.result;
    const r = R[W.sel] || R[0];
    return [
      el('h1', {}, 'Ergebnis'),
      el('p', { class: 'lead' }, `Gemittelt über ${W.measurements.length} Messstellen. Laufzeit und Pegel gleichen die Lautsprecher an, der Klang wird nur dort korrigiert, wo es an allen Stellen gleich ist.`),
      el('div', { class: 'tune-table' },
        el('div', { class: 'th' }, el('span', {}, 'Nr.'), el('span', {}, 'Laufzeit'), el('span', {}, 'Pegel'), el('span', {}, 'Filter')),
        ...R.map((x, k) => el('button', { class: `tr ${k === W.sel ? 'on' : ''}`, onclick: () => { W.sel = k; render(); } },
          el('span', {}, String(k + 1)), el('span', {}, `+${nf(x.delay, 2)} ms`), el('span', {}, `${nf(x.gain, 1)} dB`), el('span', {}, String(x.filters.length))))),
      curve(r),
    ];
  }
  /** Frequenzgang des gewählten Lautsprechers: gemessen, Ziel und mit Korrektur. */
  function curve(r) {
    const c = el('canvas', { class: 'tune-curve', width: 920, height: 220 });
    requestAnimationFrame(() => {
      const g = c.getContext('2d'), Wd = c.width, H = c.height;
      const css = getComputedStyle(document.documentElement);
      const col = (v, f) => css.getPropertyValue(v).trim() || f;
      g.clearRect(0, 0, Wd, H);
      const x = (f) => (Math.log10(f / 20) / 3) * Wd, y = (db) => H / 2 - db * (H / 40);
      g.strokeStyle = col('--line', '#444'); g.lineWidth = 1;
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.beginPath(); g.moveTo(x(f), 0); g.lineTo(x(f), H); g.stroke(); }
      for (const d of [-12, -6, 0, 6, 12]) { g.beginPath(); g.moveTo(0, y(d)); g.lineTo(Wd, y(d)); g.stroke(); }
      g.fillStyle = 'rgba(127,127,127,0.12)';
      g.fillRect(0, 0, x(100), H); g.fillRect(x(10000), 0, Wd - x(10000), H);
      const line = (vals, color, w = 2, dash = []) => { g.strokeStyle = color; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); r.grid.forEach((f, i) => (i ? g.lineTo(x(f), y(vals[i])) : g.moveTo(x(f), y(vals[i])))); g.stroke(); g.setLineDash([]); };
      const eq = r.grid.map((f) => r.filters.reduce((s, flt) => s + h.peakingResponse(flt, f), 0));
      line(r.target, col('--text-3', '#888'), 2, [6, 5]);
      line(r.curve, '#e3a33f', 2);
      line(r.curve.map((v, i) => v + eq[i]), col('--accent', '#0a84ff'), 2.5);
      g.fillStyle = col('--text-3', '#888'); g.font = '20px -apple-system, Segoe UI, sans-serif';
      for (const [f, t] of [[100, '100'], [1000, '1k'], [10000, '10k']]) g.fillText(t, x(f) + 4, H - 6);
    });
    return el('div', { class: 'tune-legend' }, c,
      el('div', {}, el('span', { class: 'k a' }, 'gemessen'), el('span', { class: 'k b' }, 'mit Korrektur'), el('span', { class: 'k c' }, 'Ziel')));
  }

  function render() {
    const r = root();
    if (!r || r.classList.contains('hidden')) return;
    const body = W.step === 'mic' ? micStep() : W.step === 'measure' ? measureStep() : resultStep();
    const ready = W.mic === 'phone' ? W.phone && Date.now() - W.phone.seen < 10000 : true;
    const foot = W.step === 'mic'
      ? [el('button', { class: 'btn', onclick: close }, 'Abbrechen'),
        el('button', { class: 'btn primary', disabled: !ready, onclick: () => { stopInputMeter(); W.step = 'measure'; render(); } }, 'Weiter')]
      : W.step === 'measure'
        ? [el('button', { class: 'btn', disabled: W.busy, onclick: () => { W.step = 'mic'; W.current = null; render(); if (W.mic === 'interface') startInputMeter(); } }, 'Zurück'),
          W.current ? el('button', { class: 'btn', disabled: W.busy, onclick: measure }, 'Wiederholen') : null,
          W.current ? el('button', { class: 'btn primary', disabled: W.busy, onclick: keep }, W.measurements.length + 1 >= W.positions ? 'Auswerten' : 'Nächste Stelle')
            : el('button', { class: 'btn primary', disabled: W.busy, onclick: measure, id: 'btnMeasure' }, W.busy ? 'Misst …' : 'Messen'),
          W.measurements.length && !W.current && !W.busy ? el('button', { class: 'btn', onclick: evaluate }, 'Jetzt auswerten') : null]
        : [el('button', { class: 'btn', onclick: () => { W.step = 'measure'; W.measurements = []; W.result = null; render(); } }, 'Neu messen'),
          el('button', { class: 'btn primary', onclick: apply, id: 'btnTuneApply' }, 'Übernehmen')];
    r.replaceChildren(el('div', { class: 'sheet tune' },
      el('div', { class: 'body' }, ...body, W.step === 'mic' ? setupRows() : null),
      el('div', { class: 'foot' }, el('div', { class: 'dots' }, ...['mic', 'measure', 'result'].map((s) => el('i', { class: s === W.step ? 'on' : '' }))), ...foot.filter(Boolean))));
  }

  return { open, close, render, state: W };
}
