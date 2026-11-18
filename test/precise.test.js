import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistPlayer } from '../src/shared/playlistPlayer.js';

const fakeEl = () => ({ duration: 60, currentTime: 0, playbackRate: 1, paused: true, loop: false, pause() {}, play: async () => {}, load() {}, removeAttribute() {} });

/** Bild, das bei „jetzt“ gezeigt wird, mit Medienzeit mediaTime (Sekunden). */
function frame(p, el, pb, play, mediaTime, n, delay = 0) {
  p.frameSync(el, { mediaTime, presentedFrames: n, expectedDisplayTime: performance.now() }, pb, play, delay);
}

test('Präzise Synchronisierung: zu früh → langsamer, zu spät → schneller, weit weg → springen', () => {
  const pb = { items: [{ src: '/v.mp4', duration: 60 }], precise: true, loop: true };
  const run = (offset, delay = 0) => {
    const p = new PlaylistPlayer(fakeEl);
    const el = p.el;
    p.players[0].url = 'file:///v.mp4';
    const now = Date.now();
    const play = { playing: true, startedAt: now - 10000, loop: true }; // Soll: 10 s
    for (let i = 0; i < 30; i++) frame(p, el, pb, play, 10 + offset, i, delay); // gleichbleibender Versatz (Test dauert nur ms)
    return el;
  };
  assert.ok(run(0.04).playbackRate < 1, 'zu früh');
  assert.ok(run(-0.04).playbackRate > 1, 'zu spät');
  assert.equal(run(0.5).currentTime > 9.9, true, 'Sprung');
  // Verzögerung 40 ms: ein Bild, das 40 ms „zu früh“ wäre, ist dann richtig
  const d = run(0.04 - 0.04, 0);
  assert.ok(Math.abs(d.playbackRate - 1) < 0.03);
  assert.ok(run(-0.04, 40).playbackRate < run(-0.04, 0).playbackRate, 'Verzögerung bremst');
});
