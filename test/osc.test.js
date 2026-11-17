import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { oscMessage } from '../src/core/osc.js';

test('OSC-Nachricht ist korrekt kodiert (mit Python dekodiert)', () => {
  const json = JSON.stringify({ id: 'P1', ä: 'ü', x: [1.5, 2] });
  const buf = oscMessage('/kalibrator/projector', [json, 7, 0.5]);
  assert.equal(buf.length % 4, 0);
  const py = `
import sys, struct
b = sys.stdin.buffer.read()
def rs(b, i):
    j = b.index(b'\\0', i); s = b[i:j].decode('utf8'); i = j + 1
    return s, (i + 3) // 4 * 4
addr, i = rs(b, 0); tags, i = rs(b, i)
out = [addr, tags]
for t in tags[1:]:
    if t == 's': s, i = rs(b, i); out.append(s)
    elif t == 'i': out.append(struct.unpack('>i', b[i:i+4])[0]); i += 4
    elif t == 'f': out.append(struct.unpack('>f', b[i:i+4])[0]); i += 4
print(repr(out))`;
  const res = execFileSync('python3', ['-c', py], { input: buf }).toString().trim();
  assert.ok(res.includes("'/kalibrator/projector', ',sif'"), res);
  assert.ok(res.includes('ü'), res);
  assert.ok(res.endsWith('7, 0.5]'), res);
});
