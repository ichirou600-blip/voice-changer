/**
 * How broken up is a surface?
 *
 * "The receiver is a 400-px unbroken surface" is a claim about *lines*, not
 * about mean value, and a mean or a standard deviation cannot tell a panel
 * break from film grain. This walks a scanline, smooths it, and counts the
 * places where the trace dips below its own local average by more than a
 * threshold — i.e. how many shadow lines cross the run — and reports how far
 * the longest stretch with no such line runs.
 *
 *   node tools/breaks.mjs shot.png row|col fixed a b [dropPct]
 */
import { decode, lumaAt } from './px.mjs';

const [file, axis, fs, as, bs, dropS] = process.argv.slice(2);
const im = decode(file);
const fixed = +fs; const x0 = +as; const x1 = +bs;
const drop = +(dropS || 25) / 100;

const v = [];
for (let t = x0; t <= x1; t++) v.push(axis === 'col' ? lumaAt(im, fixed, t) : lumaAt(im, t, fixed));
// Local average over a 25 px window — wide enough to ignore a panel line,
// narrow enough to follow the surface's own falloff across the frame.
const W = 12;
const base = v.map((_, i) => {
  let s = 0; let n = 0;
  for (let k = -W; k <= W; k++) { const j = i + k; if (j >= 0 && j < v.length) { s += v[j]; n++; } }
  return s / n;
});
const dark = v.map((a, i) => a < base[i] * (1 - drop));
let lines = 0; let run = 0; let longest = 0; let cur = 0;
for (let i = 0; i < dark.length; i++) {
  if (dark[i]) { if (run === 0) lines++; run++; cur = 0; } else { run = 0; cur++; longest = Math.max(longest, cur); }
}
console.log(JSON.stringify({
  file, axis, fixed, span: x1 - x0, lines, longestUnbrokenPx: longest,
  mean: +(v.reduce((a, b) => a + b) / v.length).toFixed(1),
  min: +Math.min(...v).toFixed(1), max: +Math.max(...v).toFixed(1),
}));
