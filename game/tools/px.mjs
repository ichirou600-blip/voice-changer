// Pixel probe: luma along a column or row of a PNG. Pure-JS PNG decode via zlib.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
export function decode(path) {
  const buf = readFileSync(path);
  let p = 8, w = 0, h = 0, bd = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('bitdepth ' + bd);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0;
  if (!ch) throw new Error('colourtype ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch; const out = Buffer.alloc(w * h * ch);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[o++]; const line = raw.subarray(o, o + stride); o += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev ? prev[i] : 0, c = i >= ch && prev ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}
export const lumaAt = (im, x, y) => {
  const i = (y * im.w + x) * im.ch;
  return 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2];
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, mode, ...rest] = process.argv.slice(2);
  const im = decode(file);
  if (mode === 'col') { const x = +rest[0], y0 = +rest[1], y1 = +rest[2];
    for (let y = y0; y <= y1; y++) console.log(y, lumaAt(im, x, y).toFixed(1)); }
  else if (mode === 'row') { const y = +rest[0], x0 = +rest[1], x1 = +rest[2];
    for (let x = x0; x <= x1; x++) console.log(x, lumaAt(im, x, y).toFixed(1)); }
  else if (mode === 'hist') {
    const b = new Array(256).fill(0); let n = 0;
    const [mx0,my0,mx1,my1] = rest.length ? rest.map(Number) : [0,0,im.w-1,im.h-1];
    for (let y = my0; y <= my1; y++) for (let x = mx0; x <= mx1; x++) { b[Math.round(lumaAt(im,x,y))]++; n++; }
    let cum = 0; const pct = {};
    for (let i = 0; i < 256; i++) { cum += b[i]; for (const q of [1,5,50,95,99,99.9]) if (!(q in pct) && cum >= n*q/100) pct[q]=i; }
    let above200=0, above240=0, above250=0, below10=0, below5=0;
    for (let i=200;i<256;i++) above200+=b[i]; for (let i=240;i<256;i++) above240+=b[i];
    for (let i=250;i<256;i++) above250+=b[i]; for (let i=0;i<10;i++) below10+=b[i]; for (let i=0;i<5;i++) below5+=b[i];
    console.log(JSON.stringify({n, pct, above200, pctAbove200:(100*above200/n).toFixed(3),
      above240, above250, below10, below5, max:b.findLastIndex(v=>v>0), min:b.findIndex(v=>v>0)}));
  }
}
