/**
 * Still-soldier capture.
 *
 * Enemies patrol continuously, so every ad-hoc shot of one is smeared by the
 * pipeline's motion blur / TAA and cannot be judged. This boots the game, pins
 * one hostile in front of the camera, lets its gait settle to a standstill,
 * then hard-freezes the manager (`enemies.enabled = false`, the same flag
 * `?noenemies` already uses) so the frame is genuinely static before the
 * screenshot. Nothing here touches gameplay: the flag is flipped from the page,
 * at capture time only.
 *
 *   node tools/soldier.mjs --port 5571 --out shots/x.png --dist 2.3 --face 0
 *
 *   --dist   camera-to-soldier metres (default 2.3)
 *   --face   soldier yaw offset in radians: 0 = facing camera, PI = back,
 *            1.57 = left side
 *   --aim    hold the shouldered pose instead of patrol carry
 *   --eye    camera height above ground (default 1.5, chest/head framing)
 *   --pitch  camera pitch
 *   --tod    time of day
 *   --fov    camera fov (default 55, a portrait lens, not the 72 game lens)
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-dev-shm-usage', '--no-sandbox',
];

const o = {
  port: 5571, out: 'shots/soldier.png', width: 1280, height: 720,
  dist: 2.3, face: 0, eye: 1.5, pitch: -0.02, fov: 55, tod: 8.4, q: 'low',
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) o[a.slice(2)] = true;
  else { o[a.slice(2)] = n; i++; }
}

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
const page = await browser.newPage({ viewport: { width: +o.width, height: +o.height } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

const url = `http://127.0.0.1:${o.port}/?capture=1&hud=0&pose=hero&q=${o.q}&tod=${o.tod}`;
await page.goto(url, { waitUntil: 'load', timeout: 120000 });

let ready = false;
for (let i = 0; i < 90; i++) {
  const s = await page.evaluate(() => ({
    r: window.__GAME_READY__, e: window.__GAME_ERROR__,
    stage: document.querySelector('#loading .stage')?.textContent || null,
  }));
  if (s.e) { console.log('BOOT ERROR:', String(s.e).slice(0, 400)); break; }
  if (s.r) { ready = true; console.log('ready after', i * 5, 's'); break; }
  if (i % 12 === 0) console.log('t=', i * 5, 's stage=', s.stage);
  await page.waitForTimeout(5000);
}

// --- pin -------------------------------------------------------------------
const posed = await page.evaluate((opt) => {
  const g = window.__engine?.game;
  if (!g) return { error: 'no game' };
  const e = g.enemies.enemies[0];
  if (!e) return { error: 'no enemies' };

  g.weapons.setViewmodelVisible(false);
  g.player.invulnerable = true;

  const cam = window.__engine.camera;
  // Player.update rewrites cam.fov from fovBase every frame, so the lens has to
  // be changed there, not on the camera.
  g.player.fovBase = +opt.fov;
  g.player.fovCurrent = +opt.fov;
  cam.fov = +opt.fov; cam.updateProjectionMatrix();

  // Camera stands where the hero pose put it; the soldier is dropped straight
  // out in front of it at the requested range. The forward vector is read off
  // the camera rather than rebuilt from player.yaw — the two conventions are
  // not the same and guessing put the first capture's subject behind the lens.
  const p = g.player.position;
  const yaw = g.player.yaw;
  g.player.teleport({ x: p.x, y: g.physics.groundHeight(p.x, p.z) ?? p.y, z: p.z },
    yaw, +opt.pitch);
  g.player.position.y += (+opt.eye) - (g.player.height - 0.18);
  g.player._syncCamera(0);
  cam.updateMatrixWorld(true);
  const camPos = { x: cam.matrixWorld.elements[12], y: cam.matrixWorld.elements[13], z: cam.matrixWorld.elements[14] };
  const el = cam.matrixWorld.elements;
  const d = { x: -el[8], z: -el[10] };
  const flat = Math.hypot(d.x, d.z) || 1;
  const fx = d.x / flat; const fz = d.z / flat;
  const ex = camPos.x + fx * +opt.dist;
  const ez = camPos.z + fz * +opt.dist;
  const ground = g.physics.groundHeight(ex, ez) ?? p.y;

  // Face the camera (plus the requested offset). A soldier's local forward is
  // -Z, so the yaw that points it at the camera is atan2(-dx, -dz).
  const wantYaw = Math.atan2(-(camPos.x - ex), -(camPos.z - ez)) + +opt.face;

  const pin = {
    update: () => {
      e.position.set(ex, ground + 0.02, ez);
      e.velocity.set(0, 0, 0);
      e.yaw = wantYaw;
      e.group.rotation.y = wantYaw;
      e.alertness = opt.aim ? 1 : 0;
      e.state = opt.aim ? 2 : 0;
      e.walkPhase = 0;
      e.walkAmp = 0;
      e.legL.rotation.x = 0;
      e.legR.rotation.x = 0;
      e.reposition.set(ex, ground, ez);
      e.fireTimer = 1e9;              // never shoots while pinned
      g.player.velocity.set(0, 0, 0);
    },
  };
  // Everyone else is hidden rather than moved: physics would put a sunk body
  // straight back on the ground the next step.
  for (const o2 of g.enemies.enemies) if (o2 !== e) o2.group.visible = false;
  window.__engine.add(pin);
  window.__pin = pin;
  window.__hero = e;
  return {
    ok: true,
    cam: [+camPos.x.toFixed(2), +camPos.y.toFixed(2), +camPos.z.toFixed(2)],
    fwd: [+fx.toFixed(3), +fz.toFixed(3)],
    enemy: [+ex.toFixed(2), +ground.toFixed(2), +ez.toFixed(2)],
    yaw: +wantYaw.toFixed(3),
  };
}, o);

// Let the pinned gait damp out, then hard-freeze the whole manager so no part
// of the soldier moves between frames and the temporal passes converge.
await page.waitForTimeout(2500);
const frozen = await page.evaluate(() => {
  const g = window.__engine.game;
  const e = window.__hero;
  g.enemies._poseWeapon(e, 1);
  g.enemies.enabled = false;           // patrol off — capture only
  window.__engine.remove(window.__pin);
  // Where did the subject actually land on screen? Reported so a mis-framed
  // capture is caught from the log instead of from the picture.
  const cam = window.__engine.camera;
  cam.updateMatrixWorld(true);
  e.group.updateMatrixWorld(true);
  const hw = e.head.matrixWorld.elements;
  const px = hw[12]; const py = hw[13]; const pz = hw[14];
  const m = cam.projectionMatrix.elements; const w = cam.matrixWorldInverse.elements;
  const vx = w[0] * px + w[4] * py + w[8] * pz + w[12];
  const vy = w[1] * px + w[5] * py + w[9] * pz + w[13];
  const vz = w[2] * px + w[6] * py + w[10] * pz + w[14];
  const cx = m[0] * vx + m[8] * vz;
  const cy = m[5] * vy + m[9] * vz;
  const cwv = -vz;
  return {
    still: true,
    headNdc: [+(cx / cwv).toFixed(3), +(cy / cwv).toFixed(3)],
    headDist: +Math.hypot(vx, vy, vz).toFixed(2),
  };
});
await page.waitForTimeout(2000);

await mkdir(path.dirname(o.out), { recursive: true });
const shots = [];
// One boot is 3-4 minutes; re-posing a frozen soldier is a second. So every
// requested angle and range comes out of the same session.
const faces = String(o.faces ?? o.face).split(',').map(Number);
const dists = String(o.dists ?? o.dist).split(',').map(Number);
const multi = faces.length > 1 || dists.length > 1;
for (const dist of dists) {
  for (const face of faces) {
    const placed = await page.evaluate(([d, f]) => {
      const g = window.__engine.game;
      const e = window.__hero;
      const cam = window.__engine.camera;
      cam.updateMatrixWorld(true);
      const el = cam.matrixWorld.elements;
      const cx = el[12]; const cz = el[14];
      const fl = Math.hypot(-el[8], -el[10]) || 1;
      const ex = cx + (-el[8] / fl) * d;
      const ez = cz + (-el[10] / fl) * d;
      const ground = g.physics.groundHeight(ex, ez) ?? 0;
      e.position.set(ex, ground + 0.02, ez);
      const yaw = Math.atan2(-(cx - ex), -(cz - ez)) + f;
      e.yaw = yaw; e.group.rotation.y = yaw;
      g.enemies._poseWeapon(e, 1);
      return { d, f, at: [+ex.toFixed(2), +ez.toFixed(2)] };
    }, [dist, face]);
    const name = multi
      ? o.out.replace(/\.png$/, '') + `-d${dist}-f${face}.png`
      : o.out;
    await page.waitForTimeout(1200);
    await page.screenshot({ path: name, timeout: 600000 });

    // Material-ID pass in register with the beauty frame. Every mesh of the
    // frozen soldier is swapped for a flat unlit colour keyed to its material
    // name and re-rendered with tone mapping and the sRGB transfer off, so the
    // byte in the red channel IS the material index. Pairing the two PNGs makes
    // "the plate reads N values off the uniform" a measurement rather than an
    // opinion — and it stays valid when the geometry changes underneath it.
    const ids = await page.evaluate(() => {
      const eng = window.__engine;
      const g = eng.game;
      const e = window.__hero;
      eng.stop();
      const names = new Map();
      for (const [k, v] of Object.entries(g.enemies._assets.m)) names.set(v, k);
      const saved = [];
      const idOf = new Map();
      const list = [];
      e.group.traverse((n) => { if (n.isMesh) list.push(n); });
      for (const mesh of list) {
        const nm = names.get(mesh.material) || 'other';
        if (!idOf.has(nm)) idOf.set(nm, idOf.size + 1);
        const id = idOf.get(nm);
        // The bundle is minified, so THREE's classes are reached through the
        // objects already in the scene rather than by name. A standard material
        // with a black albedo and an emissive of exactly id/255 in linear space,
        // rendered with tone mapping off, writes the id straight to the byte.
        const flat = new (Object.getPrototypeOf(mesh.material).constructor)();
        flat.color.setRGB(0, 0, 0, 'srgb-linear');
        flat.emissive.setRGB(id / 255, 0, 0, 'srgb-linear');
        flat.emissiveIntensity = 1;
        flat.roughness = 1; flat.metalness = 0;
        flat.toneMapped = false;
        saved.push([mesh, mesh.material]);
        mesh.material = flat;
      }
      const tmp = new (Object.getPrototypeOf(eng.scene).constructor)();
      const parent = e.group.parent;
      tmp.add(e.group);
      const tm = eng.renderer.toneMapping; const cs = eng.renderer.outputColorSpace;
      eng.renderer.toneMapping = 0;               // NoToneMapping
      eng.renderer.outputColorSpace = 'srgb-linear';
      eng.renderer.setClearColor(0x000000, 1);
      eng.renderer.setRenderTarget(null);
      eng.renderer.render(tmp, eng.camera);
      eng.renderer.toneMapping = tm; eng.renderer.outputColorSpace = cs;
      parent.add(e.group);
      window.__restore = () => {
        for (const [mesh, mat] of saved) mesh.material = mat;
        eng.start();
      };
      return Object.fromEntries([...idOf].map(([k, v]) => [v, k]));
    });
    const idName = name.replace(/\.png$/, '-id.png');
    await page.screenshot({ path: idName, timeout: 600000 });
    await page.evaluate(() => window.__restore());
    await page.waitForTimeout(400);
    shots.push({ name, idName, placed, ids });
  }
}
const stats = await page.evaluate(() => ({ ...window.__engine.stats }));
console.log(JSON.stringify({ ready, posed, frozen, stats, shots, errors: [...new Set(errors)].slice(0, 6) }));
await browser.close();
