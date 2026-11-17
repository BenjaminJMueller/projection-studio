// Seite für das Handy (Messmikrofon). Bewusst eine einzige Datei ohne Abhängigkeiten.
export const PHONE_PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Projection Studio · Mikrofon</title>
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--sub:#6e6e73;--accent:#0a84ff;--ok:#30a14e;--bad:#d94b43}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f5f5f7;--sub:#98989d}}
*{box-sizing:border-box}body{margin:0;font:17px/1.4 -apple-system,system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--text);padding:max(20px,env(safe-area-inset-top)) 16px 24px;min-height:100vh;display:flex;flex-direction:column;gap:16px}
h1{font-size:22px;margin:4px 0 0}.card{background:var(--card);border-radius:14px;padding:16px}
.sub{color:var(--sub);font-size:15px}button{font:inherit;font-weight:600;border:0;border-radius:12px;padding:14px;width:100%;background:var(--accent);color:#fff}
button:disabled{opacity:.4}.meter{height:10px;border-radius:5px;background:rgba(127,127,127,.25);overflow:hidden}.meter i{display:block;height:100%;width:0;background:var(--ok);transition:width .1s}
.big{font-size:20px;font-weight:600}.state{display:flex;align-items:center;gap:8px}.dot{width:10px;height:10px;border-radius:50%;background:var(--sub)}.rec .dot{background:var(--bad)}.ready .dot{background:var(--ok)}
</style></head><body>
<h1>Projection Studio</h1>
<div class="card"><div class="state" id="state"><span class="dot"></span><span class="big" id="title"></span></div><p class="sub" id="text"></p>
<div class="meter"><i id="lvl"></i></div></div>
<button id="go"></button>
<p class="sub" id="hint"></p>
<script>
const en = !/^de/i.test(navigator.language || '');
const T = en ? {
  start:'Allow microphone', ready:'Ready', readyText:'Place the phone at the measuring spot, microphone facing up, screen on. The measurement is started on the computer.',
  rec:'Measuring', recText:'Please keep quiet and do not move the phone.', send:'Sending …', idle:'Microphone access', idleText:'This phone is used as a measuring microphone. Volume control and noise suppression are switched off for the measurement.',
  hint:'Keep this page open and the screen on until the measurement is finished.', err:'Error', denied:'Microphone access was denied. Allow it in the browser settings and reload the page.'
} : {
  start:'Mikrofon freigeben', ready:'Bereit', readyText:'Handy an die Messstelle legen, Mikrofon nach oben, Display an. Die Messung wird am Rechner gestartet.',
  rec:'Misst', recText:'Bitte ruhig sein und das Handy nicht bewegen.', send:'Sendet …', idle:'Mikrofon-Zugriff', idleText:'Dieses Handy dient als Messmikrofon. Lautstärkeregelung und Rauschunterdrückung werden für die Messung abgeschaltet.',
  hint:'Seite geöffnet und Display an lassen, bis die Messung fertig ist.', err:'Fehler', denied:'Der Mikrofon-Zugriff wurde abgelehnt. In den Browser-Einstellungen erlauben und die Seite neu laden.'
};
const $ = (id) => document.getElementById(id);
const base = location.pathname.replace(/\\/$/, '');
let ctx, stream, node, level = 0, rec = null, settings = null, lock = null;
function ui(kind, title, text) { $('state').className = 'state ' + kind; $('title').textContent = title; $('text').textContent = text; }
ui('', T.idle, T.idleText); $('go').textContent = T.start; $('hint').textContent = T.hint;
async function post(path, body, type = 'application/json') { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': type }, body }); return r.ok ? r.json() : null; }
$('go').onclick = async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  } catch (e) { ui('', T.err, T.denied); return; }
  const tr = stream.getAudioTracks()[0];
  try { await tr.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }); } catch {}
  settings = tr.getSettings ? tr.getSettings() : null;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    const x = e.inputBuffer.getChannelData(0);
    let p = 0; for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > p) p = v; }
    level = Math.max(p, level * 0.8);
    if (rec) { rec.chunks.push(new Float32Array(x)); rec.n += x.length; if (rec.n >= rec.want) finish(); }
  };
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  $('go').hidden = true;
  ui('ready', T.ready, T.readyText);
  poll();
  meter();
};
function meter() { $('lvl').style.width = Math.min(100, Math.max(0, (20 * Math.log10(level + 1e-9) + 60) / 60 * 100)) + '%'; requestAnimationFrame(meter); }
async function finish() {
  const r = rec; rec = null;
  ui('ready', T.send, '');
  const all = new Float32Array(r.n); let o = 0; for (const c of r.chunks) { all.set(c, o); o += c.length; }
  try { await fetch(base + '/upload?id=' + r.id + '&fs=' + ctx.sampleRate, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: all.buffer }); }
  catch (e) { await post('/error?id=' + r.id, String(e), 'text/plain').catch(() => {}); }
  ui('ready', T.ready, T.readyText);
}
async function poll() {
  for (;;) {
    try {
      const m = await post('/poll', JSON.stringify({ level, fs: ctx.sampleRate, ready: true, settings }));
      if (m?.cmd?.cmd === 'record' && !rec) {
        if (lock?.released) { try { lock = await navigator.wakeLock?.request('screen'); } catch {} }
        rec = { id: m.cmd.id, want: Math.round(m.cmd.seconds * ctx.sampleRate), chunks: [], n: 0 };
        ui('rec', T.rec, m.message || T.recText);
        await post('/started?id=' + m.cmd.id, '{}');
      } else if (rec && m?.message) $('text').textContent = m.message;
    } catch {}
    await new Promise((r) => setTimeout(r, rec ? 1000 : 400));
  }
}
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && ctx) { ctx.resume(); try { lock = await navigator.wakeLock?.request('screen'); } catch {} } });
</script></body></html>`;
