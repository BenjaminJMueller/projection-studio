import test from 'node:test';
import assert from 'node:assert/strict';
import { fileUrl, targetTime, syncCorrection, playState } from '../src/shared/playback.js';

test('fileUrl: macOS, Windows, Sonderzeichen', () => {
  assert.equal(fileUrl('/Users/benny/Videos/Decke 1.mp4'), 'file:///Users/benny/Videos/Decke%201.mp4');
  assert.equal(fileUrl('C:\\Videos\\Gewölbe#2.mp4'), 'file:///C:/Videos/Gew%C3%B6lbe%232.mp4');
  assert.equal(fileUrl('file:///x.mp4'), 'file:///x.mp4');
});

test('targetTime: Schleife, Ende, Pause', () => {
  const play = { playing: true, startedAt: 0, loop: true };
  assert.equal(targetTime(play, 10, 25000), 5);
  assert.equal(targetTime({ ...play, loop: false }, 10, 25000), 10);
  assert.equal(targetTime({ playing: false, pausedAt: 3.5, loop: true }, 10, 99999), 3.5);
});

test('syncCorrection: springt bei großem Versatz, regelt kleinen über die Rate', () => {
  assert.deepEqual(syncCorrection(1, 5, 10, true), { seek: 5, rate: 1 });
  const c = syncCorrection(5, 5.05, 10, true);
  assert.equal(c.seek, null);
  assert.ok(c.rate > 1 && c.rate <= 1.05);
  // Schleifengrenze: 9.95 -> 0.02 ist nur 0.07 s Versatz, kein Sprung
  assert.equal(syncCorrection(9.95, 0.02, 10, true).seek, null);
  assert.equal(syncCorrection(5, 5.001, 10, true).rate, 1);
});

test('playState: Pause hält Position, Play setzt dort fort', () => {
  let s = playState({ loop: true }, 'play', 10, 1000);
  assert.equal(targetTime(s, 10, 3000), 2);
  s = playState(s, 'pause', 10, 3000);
  assert.equal(targetTime(s, 10, 50000), 2);
  s = playState(s, 'play', 10, 50000);
  assert.equal(targetTime(s, 10, 51000), 3);
  s = playState(s, 'restart', 10, 52000);
  assert.equal(targetTime(s, 10, 52500), 0.5);
});

test('Playlist: Position auf Einträge abbilden, alte Projekte lesen', async () => {
  const { playlistOf, totalDuration, locate, startOf } = await import('../src/shared/playback.js');
  assert.deepEqual(playlistOf({ src: '/v/a.mp4' }), [{ src: '/v/a.mp4', name: 'a.mp4' }]);
  const items = [{ src: 'a', duration: 10 }, { src: 'x', error: true }, { src: 'b', duration: 5 }, { src: 'c' }];
  assert.equal(totalDuration(items), 15);
  assert.deepEqual(locate(items, 3), { index: 0, local: 3, start: 0 });
  assert.deepEqual(locate(items, 12), { index: 2, local: 2, start: 10 });
  assert.deepEqual(locate(items, 15), { index: 2, local: 5, start: 10 });
  assert.equal(startOf(items, 2), 10);
});
