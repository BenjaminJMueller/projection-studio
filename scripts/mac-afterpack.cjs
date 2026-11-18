// electron-builder afterPack (nur macOS): jedem Programm im App-Bundle eine eigene Mach-O-UUID geben.
//
// Warum: macOS (ab 15) ordnet die Freigabe „Lokales Netzwerk“ einer App auch über die UUID ihres
// Programms zu. Alle Apps mit derselben Electron-Version haben dieselbe UUID; macOS verwechselt sie dann
// mit einer anderen App und verweigert den Zugriff still (EHOSTUNREACH, keine Abfrage). Für den
// Mehrrechner-Verbund muss die App ins lokale Netz. Die neue UUID hängt nur von App-ID, Programmname und
// CPU ab, ist also bei jedem Bau gleich. Signiert wird danach von electron-builder (identity "-").
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LC_UUID = 0x1b;

function newUuid(seed) {
  const b = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80; // Version 8 (frei gewählt)
  b[8] = (b[8] & 0x3f) | 0x80; // Variante RFC 4122
  return b;
}

/** Ein schlankes 64-Bit-Mach-O ab off patchen. Rückgabe: [alte, neue] UUID oder null. */
function patchThin(buf, off, seedBase) {
  if (buf.readUInt32LE(off) !== 0xfeedfacf) return null; // nur 64 Bit (arm64, x86_64)
  const cputype = buf.readUInt32LE(off + 4);
  const ncmds = buf.readUInt32LE(off + 16);
  let p = off + 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
    if (cmd === LC_UUID) {
      const old = Buffer.from(buf.subarray(p + 8, p + 24));
      const nu = newUuid(`${seedBase}|${cputype}`);
      nu.copy(buf, p + 8);
      return [old, nu];
    }
    if (size < 8) break;
    p += size;
  }
  return null;
}

/** Datei (schlank oder universal) patchen. Rückgabe: Liste der geänderten UUIDs. */
function patchFile(file, seedBase) {
  const buf = fs.readFileSync(file);
  const out = [];
  const magic = buf.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const n = buf.readUInt32BE(4), is64 = magic === 0xcafebabf;
    for (let i = 0; i < n; i++) {
      const e = 8 + i * (is64 ? 32 : 20);
      const off = is64 ? Number(buf.readBigUInt64BE(e + 8)) : buf.readUInt32BE(e + 8);
      const r = patchThin(buf, off, seedBase);
      if (r) out.push(r);
    }
  } else {
    const r = patchThin(buf, 0, seedBase);
    if (r) out.push(r);
  }
  if (out.length) fs.writeFileSync(file, buf);
  return out;
}

/** Alle Programme im Bundle: Hauptprogramm und die Helfer in Contents/Frameworks. */
function executables(appDir) {
  const list = [];
  const main = path.join(appDir, 'Contents', 'MacOS');
  for (const f of fs.readdirSync(main)) list.push(path.join(main, f));
  const fw = path.join(appDir, 'Contents', 'Frameworks');
  for (const d of fs.existsSync(fw) ? fs.readdirSync(fw) : []) {
    if (!d.endsWith('.app')) continue;
    const dir = path.join(fw, d, 'Contents', 'MacOS');
    for (const f of fs.readdirSync(dir)) list.push(path.join(dir, f));
  }
  return list;
}

function patchApp(appDir, appId) {
  const done = [];
  for (const exe of executables(appDir)) {
    const name = path.basename(exe);
    for (const [o, n] of patchFile(exe, `${appId}|${name}`)) done.push(`${name}: ${o.toString('hex')} -> ${n.toString('hex')}`);
  }
  return done;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const info = context.packager.appInfo;
  const appDir = path.join(context.appOutDir, `${info.productFilename}.app`);
  const done = patchApp(appDir, info.id);
  console.log(`  • Mach-O-UUIDs ersetzt (${done.length}):\n    ${done.join('\n    ')}`);
};
module.exports.patchFile = patchFile;
module.exports.patchApp = patchApp;
