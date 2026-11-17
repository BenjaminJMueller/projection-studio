// Umkehrtabelle der Feinkorrektur im Hintergrund-Thread, damit Wiedergabe und Overlay flüssig bleiben.
import { inverseMap } from '../shared/warp.js';

self.onmessage = (e) => {
  const { id, key, warp, mw, mh } = e.data;
  const map = inverseMap(warp, mw, mh);
  // Half Float für die GPU (RG16F ist linear filterbar)
  const half = new Uint16Array(map.length);
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < map.length; i++) {
    f32[0] = map[i];
    const x = u32[0], sign = (x >>> 16) & 0x8000;
    let exp = ((x >>> 23) & 0xff) - 127 + 15, mant = x & 0x7fffff;
    if (exp <= 0) half[i] = sign; // zu klein: 0
    else if (exp >= 31) half[i] = sign | 0x7c00;
    else half[i] = sign | ((exp << 10) + ((mant + 0x1000) >> 13)); // gerundet (Übertrag in den Exponenten ist richtig)
  }
  self.postMessage({ id, key, mw, mh, half }, [half.buffer]);
};
