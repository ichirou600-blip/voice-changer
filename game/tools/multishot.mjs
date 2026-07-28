/**
 * Several captures from one bake.
 *
 * A capture costs 2-5 minutes, nearly all of it procedural texture and geometry
 * synthesis that is identical between variants. Every claim about the post
 * stack is an A/B difference, and a pair shot from two separate runs is not a
 * controlled one — anything else landing in the tree between them shows up in
 * the difference too. This loads the page once and then shoots each variant by
 * poking `renderPipeline.params` directly, so the only thing that differs
 * between the frames is the parameter under test.
 *
 *   PORT=5531 node tools/multishot.mjs <pose> <outdir> '[{"name":"a"},{"name":"b","exposure":1.3}]'
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox'];
const pose = process.argv[2] || 'hero';
const outdir = process.argv[3] || 'shots/multi';
const variants = JSON.parse(process.argv[4] || '[{"name":"base"}]');
const PORT = process.env.PORT || 5340;

const b = await chromium.launch({ executablePath: CHROME, args: ARGS });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await p.goto(`http://127.0.0.1:${PORT}/?capture=1&pose=${pose}&q=low`, { waitUntil: 'load', timeout: 120000 });

let ready = false;
for (let i = 0; i < 180; i++) {
  const s = await p.evaluate(() => ({ r: window.__GAME_READY__, e: window.__GAME_ERROR__ }));
  if (s.e) { console.log('BOOT ERROR:', String(s.e).slice(0, 400)); break; }
  if (s.r) { ready = true; console.log('ready after', i * 5, 's'); break; }
  await p.waitForTimeout(5000);
}
await p.waitForTimeout(3000);
await mkdir(outdir, { recursive: true });
for (const v of variants) {
  const { name, ...over } = v;
  // Restore the shipped defaults before each variant. Without this the
  // overrides accumulate and every frame after the first is measuring the
  // union of everything asked for so far, which is not an A/B at all.
  const applied = await p.evaluate((o) => {
    const pipe = window.__engine.renderPipeline;
    if (!pipe.__defaults) pipe.__defaults = { ...pipe.params };
    Object.assign(pipe.params, pipe.__defaults);
    const q = pipe.params;
    for (const k of Object.keys(o)) q[k] = o[k];
    return Object.keys(o).map((k) => `${k}=${q[k]}`).join(' ');
  }, over);
  // Several frames so anything that integrates (focus, history) settles.
  await p.waitForTimeout(1500);
  const out = `${outdir}/${name}.png`;
  await p.screenshot({ path: out, timeout: 600000 });
  console.log(JSON.stringify({ out, applied, ready }));
}
console.log(JSON.stringify({ ready, errors: [...new Set(errs)].slice(0, 5) }));
await b.close();
