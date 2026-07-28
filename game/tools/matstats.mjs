/**
 * Pairs a beauty frame with the material-ID frame `soldier.mjs` renders in
 * register with it, and reports, per material: how many pixels of the soldier
 * it owns and what value those pixels actually rendered at.
 *
 *   node tools/matstats.mjs shot.png shot-id.png '{"1":"camo","2":"plate"}'
 *
 * The id JSON is the `ids` field printed by soldier.mjs.
 */
import { decode } from './px.mjs';

const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

const [beautyPath, idPath, idsJson] = process.argv.slice(2);
const B = decode(beautyPath);
const I = decode(idPath);
if (B.w !== I.w || B.h !== I.h) throw new Error('size mismatch');
const names = JSON.parse(idsJson);

const acc = new Map();
for (let y = 0; y < I.h; y++) {
  for (let x = 0; x < I.w; x++) {
    const id = I.data[(y * I.w + x) * I.ch];
    if (!id) continue;
    const nm = names[id] || `id${id}`;
    let a = acc.get(nm);
    if (!a) acc.set(nm, a = { n: 0, sum: 0, sum2: 0, r: 0, g: 0, b: 0 });
    const i = (y * B.w + x) * B.ch;
    const R = B.data[i] / 255; const G = B.data[i + 1] / 255; const Bl = B.data[i + 2] / 255;
    const L = 0.2126 * toLin(R) + 0.7152 * toLin(G) + 0.0722 * toLin(Bl);
    a.n++; a.sum += L; a.sum2 += L * L; a.r += R; a.g += G; a.b += Bl;
  }
}

let total = 0;
for (const a of acc.values()) total += a.n;
const rows = [...acc].map(([nm, a]) => {
  const mean = a.sum / a.n;
  return {
    mat: nm,
    px: a.n,
    pct: +(100 * a.n / total).toFixed(2),
    srgb: [Math.round(255 * a.r / a.n), Math.round(255 * a.g / a.n), Math.round(255 * a.b / a.n)],
    value: +(255 * toSrgb(mean)).toFixed(1),
    lum: +mean.toFixed(5),
    sd: +Math.sqrt(Math.max(0, a.sum2 / a.n - mean * mean)).toFixed(5),
  };
}).sort((p, q) => q.px - p.px);

const byName = Object.fromEntries(rows.map((r) => [r.mat, r]));
const pair = (a, b) => {
  const A = byName[a]; const C = byName[b];
  if (!A || !C) return null;
  return {
    pair: `${a}/${b}`,
    dValue: +(A.value - C.value).toFixed(1),
    ratio: +(A.lum / C.lum).toFixed(2),
  };
};
console.log(JSON.stringify({
  file: beautyPath,
  soldierPx: total,
  rows,
  contrast: [pair('plate', 'camo'), pair('plate', 'camoArm'), pair('pouch', 'camo'),
    pair('webbing', 'plate'), pair('helmet', 'camo'), pair('skin', 'camo')].filter(Boolean),
}, null, 1));
