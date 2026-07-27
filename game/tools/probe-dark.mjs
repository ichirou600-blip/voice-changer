/**
 * Isolate what is crushing the near road: sun shadow, ambient occlusion, or
 * neither. Boots once and samples the same screen region with each contributor
 * toggled, so the comparison is apples to apples rather than across separate
 * boots with different TAA convergence.
 *
 *   PORT=5403 node tools/probe-dark.mjs
 */
import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox',
];
const PORT = process.env.PORT || 5403;

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://127.0.0.1:${PORT}/?capture=1&pose=hero&q=low&hud=0`, { waitUntil: 'load', timeout: 120000 });

for (let i = 0; i < 180; i++) {
  const s = await page.evaluate(() => ({ r: window.__GAME_READY__, e: window.__GAME_ERROR__ }));
  if (s.e) { console.log('BOOT ERROR:', String(s.e).slice(0, 300)); break; }
  if (s.r) break;
  await page.waitForTimeout(5000);
}

// Sample the lower-left quadrant, which is where the dark band sits.
const sample = () => page.evaluate(() => {
  const cv = document.querySelector('#app canvas');
  const t = document.createElement('canvas');
  t.width = 64; t.height = 36;
  const ctx = t.getContext('2d');
  ctx.drawImage(cv, 0, 0, 64, 36);
  const d = ctx.getImageData(0, 0, 64, 36).data;
  let band = 0, bandN = 0, lit = 0, litN = 0;
  for (let i = 0; i < d.length; i += 4) {
    const idx = i / 4;
    const px = idx % 64, py = Math.floor(idx / 64);
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (py > 24 && px < 34) { band += l; bandN++; }        // the dark band
    else if (py > 18 && py <= 24 && px > 34) { lit += l; litN++; }  // lit road beyond it
  }
  return { band: +(band / Math.max(1, bandN)).toFixed(1), lit: +(lit / Math.max(1, litN)).toFixed(1) };
});

const settle = () => page.waitForTimeout(6000);

const baseline = await sample();

await page.evaluate(() => { window.__engine.game.lighting.sun.castShadow = false; });
await settle();
const noShadow = await sample();

await page.evaluate(() => {
  window.__engine.game.lighting.sun.castShadow = true;
  window.__engine.renderPipeline.params.ao = false;
});
await settle();
const noAO = await sample();

await page.evaluate(() => { window.__engine.game.lighting.sun.castShadow = false; });
await settle();
const neither = await sample();

console.log(JSON.stringify({ baseline, noShadow, noAO, neither }, null, 1));
await browser.close();
