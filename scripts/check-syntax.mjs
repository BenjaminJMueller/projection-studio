// Schneller Syntax-Check aller JS-Dateien (fängt Tippfehler, bevor die App startet).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(m?js|cjs)$/.test(f)) files.push(p); } };
walk('src'); walk('test');
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error(e.stderr.toString()); }
}
if (bad) { console.error(`${bad} Datei(en) mit Syntaxfehlern`); process.exit(1); }
console.log(`Syntax ok (${files.length} Dateien)`);
