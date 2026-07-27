/**
 * Evaluate-only diagnostic: boots the game and reports the live tone mapping,
 * bloom, fog and atmosphere values plus measured frame luminance, without
 * taking a screenshot. Cheap enough to run while the machine is loaded, and it
 * answers "is the frame washed out by the scene or by the post chain?".
 *
 *   PORT=5343 node tools/diag.mjs
 */
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox',
];
const PORT = process.env.PORT || 5343;

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

await page.goto(`http://127.0.0.1:${PORT}/?capture=1&pose=hero&q=low`, { waitUntil: 'load', timeout: 120000 });

let ready = false;
for (let i = 0; i < 180; i++) {
  const s = await page.evaluate(() => ({ r: window.__GAME_READY__, e: window.__GAME_ERROR__ }));
  if (s.e) { console.log('BOOT ERROR:', String(s.e).slice(0, 300)); break; }
  if (s.r) { ready = true; break; }
  await page.waitForTimeout(5000);
}

const report = await page.evaluate(() => {
  const e = window.__engine;
  if (!e || !e.game) return { error: 'no game' };
  const g = e.game;
  const r = e.renderer;
  const pipe = e.renderPipeline;

  // Sample the presented canvas to see what actually reached the screen.
  const cv = document.querySelector('#app canvas');
  const t = document.createElement('canvas');
  t.width = 64; t.height = 36;
  const ctx = t.getContext('2d');
  ctx.drawImage(cv, 0, 0, 64, 36);
  const d = ctx.getImageData(0, 0, 64, 36).data;
  let sum = 0, min = 255, max = 0;
  // Sample the upper third (sky) and lower two thirds (ground) separately —
  // a veiled frame and an over-bright sky look different in that split.
  let skySum = 0, skyN = 0, groundSum = 0, groundN = 0;
  for (let i = 0; i < d.length; i += 4) {
    const px = (i / 4) % 64, py = Math.floor((i / 4) / 64);
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += l; if (l < min) min = l; if (l > max) max = l;
    if (py < 12) { skySum += l; skyN++; } else { groundSum += l; groundN++; }
    void px;
  }

  return {
    toneMapping: r.toneMapping,
    exposure: r.toneMappingExposure,
    pipelineParams: pipe ? JSON.parse(JSON.stringify(pipe.params)) : null,
    hdr: pipe ? pipe.hdr : null,
    fog: e.scene.fog ? { type: e.scene.fog.type, density: e.scene.fog.density, color: e.scene.fog.color.getHexString() } : null,
    sunColor: g.sky.sunColor.getHexString(),
    sunIntensity: g.lighting.sun.intensity,
    ambient: g.sky.ambientColor.getHexString(),
    fogParams: { density: g.sky.fogParams.density, heightFalloff: g.sky.fogParams.heightFalloff, color: g.sky.fogParams.color.getHexString() },
    // getHexString() clamps, which hides an out-of-range colour. These are the
    // raw components — anything above 1.0 here will blow out whatever it is
    // mixed into, however modest the fog opacity is.
    rawColors: {
      fog: [g.sky.fogParams.color.r, g.sky.fogParams.color.g, g.sky.fogParams.color.b].map((v) => +v.toFixed(3)),
      ambient: [g.sky.ambientColor.r, g.sky.ambientColor.g, g.sky.ambientColor.b].map((v) => +v.toFixed(3)),
      sun: [g.sky.sunColor.r, g.sky.sunColor.g, g.sky.sunColor.b].map((v) => +v.toFixed(3)),
      sceneFog: e.scene.fog ? [e.scene.fog.color.r, e.scene.fog.color.g, e.scene.fog.color.b].map((v) => +v.toFixed(3)) : null,
    },
    luma: { mean: +(sum / (64 * 36)).toFixed(1), min, max, sky: +(skySum / skyN).toFixed(1), ground: +(groundSum / groundN).toFixed(1) },
    stats: { fps: +e.stats.fps.toFixed(1), drawCalls: e.stats.drawCalls, triangles: e.stats.triangles },
  };
});

console.log(JSON.stringify({ ready, report, errors: [...new Set(errors)].slice(0, 4) }, null, 1));
await browser.close();
