// Ersatz für window.api, wenn die Oberfläche ohne Electron im Browser läuft
// (Design-Vorschau, automatisierte Tests). Dateien werden per fetch gelesen.
export function makeBrowserStub() {
  const mem = new Map();
  const noop = () => () => {};
  const langCbs = new Set();
  let lang = new URLSearchParams(location.search).get('lang');
  try { lang ||= localStorage.getItem('kalib.lang'); } catch { /* egal */ }
  return {
    platform: 'browser',
    getLang: async () => lang || 'de',
    setLang: async (l) => { lang = l; try { localStorage.setItem('kalib.lang', l); } catch { /* egal */ } langCbs.forEach((cb) => cb(l)); },
    onLangChanged: (cb) => { langCbs.add(cb); return () => langCbs.delete(cb); },
    listDisplays: async () => [
      { id: 1, index: 1, label: 'Eingebaut', bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, pixelSize: { width: 3024, height: 1964 }, primary: true },
      { id: 2, index: 2, label: 'HDMI A (4K)', bounds: { x: 1512, y: 0, width: 3840, height: 2160 }, scaleFactor: 1, pixelSize: { width: 3840, height: 2160 }, primary: false },
      { id: 3, index: 3, label: 'HDMI B (4K)', bounds: { x: 5352, y: 0, width: 3840, height: 2160 }, scaleFactor: 1, pixelSize: { width: 3840, height: 2160 }, primary: false },
    ],
    openOutput: async () => ({ ok: true }),
    closeOutput: async () => {},
    closeAllOutputs: async () => {},
    openOutputIds: async () => [],
    broadcast: () => {},
    sendOutputEvent: () => {},
    focusMain: () => {},
    readFile: async (p, enc) => {
      if (mem.has(p)) return mem.get(p);
      const r = await fetch(p);
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return enc ? r.text() : new Uint8Array(await r.arrayBuffer());
    },
    writeFile: async (p, d) => { mem.set(p, d); return true; },
    exists: async (p) => mem.has(p),
    openDialog: async () => null,
    saveDialog: async () => null,
    paths: async () => ({ userData: '/__mem', documents: '/__mem', examples: '../../examples', td: '../../td' }),
    showItem: async () => {},
    oscSend: async () => ({ ok: true }),
    onStateUpdate: noop,
    onOutputEvent: noop,
    onOutputConfig: noop,
    onOutputClosed: noop,
    onMenu: noop,
    onDisplaysChanged: noop,
    clusterGet: async () => ({ role: 'solo', id: 'browser', name: 'Browser', clients: [], status: null, masters: [] }),
    clusterSetRole: async (role) => ({ role, id: 'browser', name: 'Browser', clients: [], status: null, masters: [] }),
    clusterConnect: async () => ({}),
    clusterOutputs: async () => {},
    clusterClearCache: async () => 0,
    clusterFirewall: async () => null,
    clusterFirewallAllow: async () => null,
    localNetworkSettings: async () => {},
    onClusterEvent: noop,
  };
}
