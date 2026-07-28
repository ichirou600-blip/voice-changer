/** Scene budget + scatter census. PORT=5630 node stats.mjs [pose] */
import { chromium } from 'playwright';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox'];
const PORT = process.env.PORT || 5630;
const pose = process.argv[2] || 'hero';
const b = await chromium.launch({ executablePath: CHROME, args: ARGS });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
const t0 = Date.now();
await p.goto(`http://127.0.0.1:${PORT}/?capture=1&pose=${pose}&q=low`, { waitUntil: 'load', timeout: 120000 });
let ready = false, tReady = 0;
for (let i = 0; i < 200; i++) {
  const s = await p.evaluate(() => ({ r: window.__GAME_READY__, e: window.__GAME_ERROR__ }));
  if (s.e) { console.log('BOOT ERROR:', String(s.e).slice(0, 400)); break; }
  if (s.r) { ready = true; tReady = (Date.now() - t0) / 1000; break; }
  await p.waitForTimeout(2000);
}
await p.waitForTimeout(3000);
const rep = await p.evaluate(() => {
  const e = window.__engine, g = e.game, r = e.renderer;
  const info = r.info.render;
  const scat = {};
  let instTris = 0, totalTris = 0, meshes = 0;
  g.level.root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const gi = o.geometry.index;
    const tri = (gi ? gi.count : o.geometry.attributes.position.count) / 3;
    const n = o.isInstancedMesh ? o.count : 1;
    totalTris += tri * n;
    if (o.name && o.name.startsWith('scatter_')) {
      scat[o.name.slice(8)] = { count: o.count, protoTris: tri, tris: tri * o.count };
      instTris += tri * o.count;
    }
  });
  return {
    frameCalls: info.calls, frameTris: info.triangles, programs: r.info.programs.length,
    levelMeshes: meshes, levelTrisAll: Math.round(totalTris), scatterTris: Math.round(instTris), scat,
  };
});
console.log(JSON.stringify({ ready, loadSeconds: +tReady.toFixed(1), ...rep, errors: [...new Set(errs)].slice(0, 5) }, null, 1));
await b.close();
