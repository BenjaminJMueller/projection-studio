// electron-builder afterSign (nur macOS): App ad hoc signieren, falls electron-builder nicht signiert hat.
//
// Warum: Ohne gültige Signatur des ganzen Bundles fragt macOS (ab 15) nie nach „Lokales Netzwerk“ und
// sperrt Verbindungen ins LAN still. electron-builder überspringt die Ad-hoc-Signatur, wenn kein
// Zertifikat im Schlüsselbund liegt. Hier also selbst signieren, nach dem Ersetzen der UUIDs (afterPack)
// und vor dem Packen ins DMG. Ohne „hardened runtime“, weil Ad-hoc-Apps damit abstürzen können.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const verify = () => { try { execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' }); return true; } catch { return false; } };
  if (verify()) { console.log('  • Signatur bereits gültig'); return; }
  execFileSync('xattr', ['-cr', app]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
  if (!verify()) throw new Error(`Ad-hoc-Signatur von ${app} ungültig`);
  console.log('  • ad hoc signiert');
};
