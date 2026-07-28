/**
 * Region statistics from a PNG, so a claim about "value separation" is a number
 * rather than an impression. Reuses the decoder in px.mjs.
 *
 *   node tools/region.mjs shot.png x,y,w,h [x,y,w,h ...]
 *
 * Per box: mean sRGB, mean relative luminance (linear), the sRGB encoding of
 * that mean (the "value" a 0-255 ramp step actually means), and the luminance
 * standard deviation inside the box.
 */
import { decode } from './px.mjs';

const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function boxStats(im, x0, y0, bw, bh) {
  let r = 0; let g = 0; let b = 0; let n = 0; let sum = 0; let sum2 = 0;
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0; x < x0 + bw; x++) {
      if (x < 0 || y < 0 || x >= im.w || y >= im.h) continue;
      const i = (y * im.w + x) * im.ch;
      const R = im.data[i] / 255; const G = im.data[i + 1] / 255; const B = im.data[i + 2] / 255;
      r += R; g += G; b += B; n++;
      const L = 0.2126 * toLin(R) + 0.7152 * toLin(G) + 0.0722 * toLin(B);
      sum += L; sum2 += L * L;
    }
  }
  const mean = sum / (n || 1);
  return {
    n,
    srgb: [Math.round((r / n) * 255), Math.round((g / n) * 255), Math.round((b / n) * 255)],
    lum: +mean.toFixed(5),
    value: +(toSrgb(mean) * 255).toFixed(1),
    sd: +Math.sqrt(Math.max(0, sum2 / (n || 1) - mean * mean)).toFixed(5),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const im = decode(file);
  const res = process.argv.slice(3).map((s) => {
    const [x, y, w, h] = s.split(',').map(Number);
    return { box: s, ...boxStats(im, x, y, w, h) };
  });
  console.log(JSON.stringify({ file, size: [im.w, im.h], res }));
}
