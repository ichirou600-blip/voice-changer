/**
 * Screenshot harness. Boots the game headless (SwiftShader), waits for the
 * renderer to signal a warmed frame, poses the camera and captures PNGs.
 *
 * Usage:
 *   node tools/shot.mjs --pose hero --out shots/hero.png [--hud 0] [--tod 8.4]
 *   node tools/shot.mjs --all --dir shots/run1
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage',
  '--no-sandbox', '--disable-gpu-sandbox', '--js-flags=--max-old-space-size=4096',
];

export const DEFAULT_POSES = ['hero', 'alley', 'skyline', 'closeup', 'goldenHour'];

function parseArgs(argv) {
  const out = {
    pose: 'hero', out: 'shots/shot.png', hud: '1',
    base: 'http://localhost:5173/', wait: 2500, width: 1920, height: 1080,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

async function capture(page, { base, pose, hud, tod, out, wait, quality }) {
  const url = new URL(base);
  url.searchParams.set('capture', '1');
  url.searchParams.set('pose', pose);
  url.searchParams.set('hud', hud);
  if (tod) url.searchParams.set('tod', String(tod));
  if (quality) url.searchParams.set('q', quality);

  const errors = [];
  const onErr = (e) => errors.push(String(e));
  const onConsole = (m) => { if (m.type() === 'error') errors.push(m.text()); };
  page.on('pageerror', onErr);
  page.on('console', onConsole);

  await page.goto(url.toString(), { waitUntil: 'load', timeout: 90000 });
  try {
    // NB: Playwright's signature is (fn, arg, options) — options must be third.
    await page.waitForFunction(
      () => window.__GAME_READY__ === true || window.__GAME_ERROR__,
      null,
      { timeout: 240000, polling: 250 },
    );
  } catch {
    errors.push('TIMEOUT waiting for __GAME_READY__');
  }
  const bootError = await page.evaluate(() => window.__GAME_ERROR__ || null);
  if (bootError) errors.push(`BOOT ERROR: ${bootError}`);

  // Let the frame settle (post stack, particles, shadow warm-up).
  await page.waitForTimeout(Number(wait));
  await mkdir(path.dirname(out), { recursive: true });
  // Playwright's screenshot default is 30s. A single frame on a software
  // rasteriser under contention routinely exceeds that, and the resulting
  // TimeoutError reads as a game hang rather than as slowness.
  await page.screenshot({ path: out, timeout: 600000 });

  const stats = await page.evaluate(() => {
    const e = window.__engine;
    if (!e || !e.stats) return null;
    return {
      fps: +e.stats.fps.toFixed(1),
      frameMs: +e.stats.frameMs.toFixed(2),
      drawCalls: e.stats.drawCalls,
      triangles: e.stats.triangles,
      programs: e.stats.programs,
    };
  });

  page.off('pageerror', onErr);
  page.off('console', onConsole);
  return { out, pose, errors: [...new Set(errors)].slice(0, 8), stats };
}

async function main() {
  const opts = parseArgs(process.argv);
  const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
  const page = await browser.newPage({
    viewport: { width: Number(opts.width), height: Number(opts.height) },
    deviceScaleFactor: 1,
  });

  const results = [];
  if (opts.all) {
    const dir = opts.dir || 'shots';
    for (const pose of DEFAULT_POSES) {
      results.push(await capture(page, { ...opts, pose, out: path.join(dir, `${pose}.png`) }));
    }
  } else {
    results.push(await capture(page, opts));
  }

  await browser.close();
  for (const r of results) console.log(JSON.stringify(r));
  const failed = results.some((r) => r.errors.some((e) => /BOOT ERROR|TIMEOUT/.test(e)));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
