/**
 * Ad-hoc inspection shot: boots the game, then poses the camera at an arbitrary
 * point (or in front of a named entity) before capturing. Used for looking at
 * things the fixed level poses do not frame — enemies, impact FX, the viewmodel.
 *
 *   node tools/inspect.mjs --base http://127.0.0.1:5210/ --out shots/x.png \
 *        --look enemy --index 0 --dist 3.5
 *   node tools/inspect.mjs --at 4,2,10 --yaw 1.2 --pitch -0.1
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox',
];

const opts = { base: 'http://127.0.0.1:5210/', out: 'shots/inspect.png', width: 1600, height: 900, wait: 2500, dist: 3.5, index: 0 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) opts[a.slice(2)] = true;
  else { opts[a.slice(2)] = next; i++; }
}

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
const page = await browser.newPage({ viewport: { width: +opts.width, height: +opts.height } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const url = new URL(opts.base);
url.searchParams.set('capture', '1');
if (opts.hud !== undefined) url.searchParams.set('hud', String(opts.hud));
if (opts.tod) url.searchParams.set('tod', String(opts.tod));

await page.goto(url.toString(), { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(
  () => window.__GAME_READY__ === true || window.__GAME_ERROR__,
  null,
  { timeout: 240000, polling: 250 },
).catch(() => errors.push('TIMEOUT waiting for __GAME_READY__'));

const posed = await page.evaluate((o) => {
  const e = window.__engine;
  if (!e || !e.game) return { error: 'no game' };
  const g = e.game;

  if (o.look === 'enemy') {
    const list = g.enemies.enemies || [];
    const target = list[Math.min(+o.index, list.length - 1)];
    if (!target) return { error: `no enemy at index ${o.index}, ${list.length} alive` };
    const t = target.position;
    // Stand off along +Z from the target and look back at chest height.
    const d = +o.dist;
    const px = t.x, pz = t.z + d;
    const ground = g.physics.groundHeight(px, pz) ?? t.y;
    g.player.teleport({ x: px, y: ground + 0.05, z: pz }, 0, -0.06);
    return { ok: true, target: [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)], enemies: list.length };
  }

  if (o.at) {
    const [x, y, z] = String(o.at).split(',').map(Number);
    g.player.teleport({ x, y, z }, +(o.yaw || 0), +(o.pitch || 0));
    return { ok: true, at: [x, y, z] };
  }
  return { ok: true, note: 'default pose' };
}, opts);

await page.waitForTimeout(+opts.wait);
await mkdir(path.dirname(opts.out), { recursive: true });
await page.screenshot({ path: opts.out });
console.log(JSON.stringify({ out: opts.out, posed, errors: [...new Set(errors)].slice(0, 6) }));
await browser.close();
