// Minimaler OSC-1.0-Encoder (UDP), ohne Abhängigkeiten.
function oscString(s) {
  const b = Buffer.from(s + '\0', 'utf8');
  const pad = (4 - (b.length % 4)) % 4;
  return Buffer.concat([b, Buffer.alloc(pad)]);
}
export function oscMessage(address, args) {
  let tags = ',';
  const data = [];
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; data.push(oscString(a)); }
    else if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); data.push(b); }
    else { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); data.push(b); }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...data]);
}
