// Electron-Hauptprozess: Fenster, Bildschirme, Dateien.
import { app, BrowserWindow, ipcMain, screen, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import { oscMessage } from '../core/osc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const isMac = process.platform === 'darwin';

let mainWin = null;
/** displayId -> BrowserWindow */
const outputWins = new Map();

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1e1e1f',
    title: 'Projection Studio',
    // Native Fensterleiste in die Werkzeugleiste integrieren (macOS: Ampel links, Windows: Schaltflächen rechts)
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
      : process.platform === 'win32'
        ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#2b2b2d', symbolColor: '#ececee', height: 44 } }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWin.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  mainWin.on('closed', () => {
    mainWin = null;
    for (const w of outputWins.values()) if (!w.isDestroyed()) w.close();
    outputWins.clear();
  });
}

function listDisplays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    index: i + 1,
    label: d.label || `Bildschirm ${i + 1}`,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    pixelSize: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) },
    primary: d.id === primary.id,
  }));
}

function openOutput(displayId, outputName) {
  const d = screen.getAllDisplays().find((x) => x.id === displayId);
  if (!d) return { ok: false, error: 'Bildschirm nicht gefunden' };
  let win = outputWins.get(displayId);
  if (win && !win.isDestroyed()) {
    win.webContents.send('output:config', { outputName });
    return { ok: true };
  }
  win = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    frame: false,
    show: false,
    backgroundColor: '#000000',
    enableLargerThanScreen: true,
    hasShadow: false,
    title: `Ausgang ${outputName}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(ROOT, 'src', 'output', 'output.html'), { query: { display: String(displayId), name: outputName } });
  win.once('ready-to-show', () => {
    win.setBounds(d.bounds);
    if (isMac) win.setSimpleFullScreen(true);
    else win.setFullScreen(true);
    win.showInactive();
    mainWin?.focus();
  });
  win.on('closed', () => {
    outputWins.delete(displayId);
    mainWin?.webContents.send('output:closed', { displayId });
  });
  outputWins.set(displayId, win);
  return { ok: true };
}

function closeOutput(displayId) {
  const w = outputWins.get(displayId);
  if (w && !w.isDestroyed()) w.close();
  outputWins.delete(displayId);
}

ipcMain.handle('displays:list', () => listDisplays());
ipcMain.handle('output:open', (_e, { displayId, outputName }) => openOutput(displayId, outputName));
ipcMain.handle('output:close', (_e, { displayId }) => closeOutput(displayId));
ipcMain.handle('output:closeAll', () => {
  for (const id of [...outputWins.keys()]) closeOutput(id);
});
ipcMain.handle('output:openIds', () => [...outputWins.keys()]);

// Hauptfenster -> alle Ausgabefenster
ipcMain.on('state:broadcast', (_e, msg) => {
  for (const w of outputWins.values()) if (!w.isDestroyed()) w.webContents.send('state:update', msg);
});
// Ausgabefenster -> Hauptfenster (Maus/Tastatur auf dem Projektor)
ipcMain.on('output:event', (_e, msg) => {
  mainWin?.webContents.send('output:event', msg);
});
ipcMain.on('output:focusMain', () => mainWin?.focus());

// Dateien
ipcMain.handle('file:read', async (_e, p, encoding) => {
  const buf = await fs.readFile(p);
  return encoding ? buf.toString(encoding) : buf;
});
ipcMain.handle('file:write', async (_e, p, data, encoding) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) await fs.writeFile(p, Buffer.from(data));
  else await fs.writeFile(p, data, encoding || 'utf8');
  return true;
});
ipcMain.handle('file:exists', async (_e, p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('dialog:open', async (_e, opts) => {
  const r = await dialog.showOpenDialog(mainWin, opts);
  return r.canceled ? null : r.filePaths;
});
ipcMain.handle('dialog:save', async (_e, opts) => {
  const r = await dialog.showSaveDialog(mainWin, opts);
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('app:paths', () => ({
  userData: app.getPath('userData'),
  documents: app.getPath('documents'),
  examples: path.join(ROOT, 'examples'),
  td: path.join(ROOT, 'td'),
}));
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));

// ---------------- OSC (Live-Verbindung zu TouchDesigner)
const oscSocket = dgram.createSocket('udp4');
ipcMain.handle('osc:send', (_e, { host, port, address, args }) => new Promise((resolve) => {
  const msg = oscMessage(address, args);
  oscSocket.send(msg, port, host || '127.0.0.1', (err) => resolve(err ? { ok: false, error: err.message } : { ok: true, bytes: msg.length }));
}));

function buildMenu() {
  const send = (cmd) => () => mainWin?.webContents.send('menu', cmd);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Datei',
      submenu: [
        { label: 'Neues Projekt', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Projekt öffnen …', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Speichern', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Speichern unter …', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: '3D-Modell laden …', click: send('loadModel') },
        { label: 'Für TouchDesigner exportieren …', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Beenden' },
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { label: 'Rückgängig', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Wiederholen', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: send('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einfügen' },
      ],
    },
    {
      label: 'Ausgabe',
      submenu: [
        { label: 'Ausgänge öffnen', accelerator: 'CmdOrCtrl+Shift+O', click: send('openOutputs') },
        { label: 'Ausgänge schließen', accelerator: 'Escape', click: send('closeOutputs') },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Hilfe',
      role: 'help',
      submenu: [{ label: 'Einführung anzeigen', click: send('onboarding') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createMainWindow();
  screen.on('display-added', () => mainWin?.webContents.send('displays:changed'));
  screen.on('display-removed', () => mainWin?.webContents.send('displays:changed'));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
