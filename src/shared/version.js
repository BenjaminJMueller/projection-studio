// Versionsvergleich und Auswahl der Update-Datei (ohne Electron, damit testbar).

/** "1.0.12" -> [1, 0, 12]; Zusätze wie "-beta" werden ignoriert. */
export function parseVersion(v) {
  return String(v || '').replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
}

/** Ist a neuer als b? */
export function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

/** Update-Datei für 'mac' oder 'win' aus latest.json: { name, sha256, size }. */
export function pickFile(info, platform) {
  const f = info?.files?.[platform];
  if (!f || !/^[\w.-]+$/.test(f.name || '') || !/^[0-9a-f]{64}$/.test(f.sha256 || '')) return null;
  return f;
}
