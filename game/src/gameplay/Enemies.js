import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SURFACE } from './Physics.js';
import {
  damp, clamp, mulberry32, Simplex, fbm2, worley2, smoothstep,
} from '../core/Noise.js';

/**
 * Hostile AI. Each enemy is a capsule with a hitbox stack (head / torso / limbs)
 * driving a skeletal proxy, plus a behaviour state machine: idle → alert →
 * engage → reposition → suppress → dead.
 *
 * CONTRACT (used by Ballistics/HUD):
 *   enemies.raycastEntities(origin, dir, maxDist, owner)
 *   enemies.onNoise(position, radius)
 *   enemies.alive  — count
 */

const STATE = { IDLE: 0, ALERT: 1, ENGAGE: 2, REPOSITION: 3, DEAD: 4 };

// ---------------------------------------------------------------------------
// Kit surfaces
// ---------------------------------------------------------------------------
// A soldier needs three tiles — cloth weave, nylon webbing, moulded rubber —
// whose only job is to give MeshStandardMaterial a normal and a roughness break
// so the uniform stops reading as a single flat diffuse. TextureGen bakes 512px
// architectural sets through the GPU; three more passes there would cost the
// loading screen more than these are worth, so they are baked on the CPU at
// 128px, which is roughly a millimetre per texel at the tilings used below.

const KIT_TEX = 128;

/**
 * Bilinear cross-fade of four offset copies of a non-tiling field. Cheap way to
 * make fbm seamless across the 0..1 tile, which matters because the same sheet
 * is repeated two or three times around a limb.
 */
function tileFbm(noise, u, v, freq, octaves) {
  const a = fbm2(noise, u * freq, v * freq, octaves);
  const b = fbm2(noise, (u - 1) * freq, v * freq, octaves);
  const c = fbm2(noise, u * freq, (v - 1) * freq, octaves);
  const d = fbm2(noise, (u - 1) * freq, (v - 1) * freq, octaves);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/**
 * Bakes one surface set from a per-texel callback.
 *
 * @param {function(number,number):number[]} fn (u,v) -> [height, roughness, r,g,b]
 *   `height` is only ever differentiated, so its absolute level is free;
 *   `roughness` is stored as a multiplier around 1.0 so the per-material
 *   `roughness` scalar still carries the fabric/gear split; rgb is optional.
 * @param {number} relief Sobel gain — how deep the weave reads.
 */
function bakeKit(fn, relief, albedo = false, size = KIT_TEX) {
  const n = size;
  const N = n * n;
  const h = new Float32Array(N);
  const rough = new Uint8Array(N * 4);
  const alb = albedo ? new Uint8Array(N * 4) : null;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const o = fn((x + 0.5) / n, (y + 0.5) / n);
      h[i] = o[0];
      // Roughness lives in green; three reads roughnessMap.g and multiplies.
      rough[i * 4] = 255;
      rough[i * 4 + 1] = clamp(o[1], 0, 1) * 255;
      rough[i * 4 + 2] = 0;
      rough[i * 4 + 3] = 255;
      if (alb) {
        alb[i * 4] = clamp(o[2], 0, 1) * 255;
        alb[i * 4 + 1] = clamp(o[3], 0, 1) * 255;
        alb[i * 4 + 2] = clamp(o[4], 0, 1) * 255;
        alb[i * 4 + 3] = 255;
      }
    }
  }

  // Sobel the height field into a tangent-space normal, wrapping at the edges
  // so the derivative is continuous across the tile join.
  const nrm = new Uint8Array(N * 4);
  const at = (x, y) => h[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * relief;
      const dy = (at(x, y - 1) - at(x, y + 1)) * relief;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * n + x) * 4;
      nrm[i] = (dx * inv * 0.5 + 0.5) * 255;
      nrm[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      nrm[i + 2] = (inv * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }

  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };

  return {
    map: alb ? mk(alb, true) : null,
    normalMap: mk(nrm, false),
    roughnessMap: mk(rough, false),
  };
}

/**
 * Repeat is a property of the texture, so a second tiling needs a clone — but
 * clones share the Source, so this costs one upload, not two. The albedo gets
 * its own tiling because the two layers live at completely different scales: a
 * camo patch is 20 cm and a thread is a millimetre, and tiling them together
 * means choosing which one to get wrong.
 */
function retile(set, u, v, mu = u, mv = v) {
  const out = {};
  for (const k of ['map', 'normalMap', 'roughnessMap']) {
    if (!set[k]) { out[k] = null; continue; }
    const t = set[k].clone();
    if (k === 'map') t.repeat.set(mu, mv);
    else t.repeat.set(u, v);
    t.needsUpdate = true;
    out[k] = t;
  }
  return out;
}

/**
 * Collects transformed primitives per material and merges them into one buffer
 * each. A kitted soldier is ~90 primitives; merging by material takes that to
 * about thirty draw calls, and because the merge happens inside `_shared()` the
 * result is still one set of buffers for the whole wave.
 */
class GeoBag {
  constructor() { this.byMat = new Map(); }

  add(mat, geo, p = null, r = null, s = null) {
    const g = geo.clone();
    _pos.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
    _eul.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
    _quat.setFromEuler(_eul);
    if (s === null) _scl.set(1, 1, 1);
    else if (typeof s === 'number') _scl.set(s, s, s);
    else _scl.set(s[0], s[1], s[2]);
    _mat4.compose(_pos, _quat, _scl);
    g.applyMatrix4(_mat4);
    let arr = this.byMat.get(mat);
    if (!arr) this.byMat.set(mat, arr = []);
    arr.push(g);
    return this;
  }

  /** @returns {{mat: THREE.Material, geo: THREE.BufferGeometry}[]} */
  build() {
    const out = [];
    for (const [mat, arr] of this.byMat) {
      const geo = arr.length === 1 ? arr[0] : mergeGeometries(arr, false);
      if (arr.length > 1) for (const a of arr) a.dispose();
      geo.computeBoundingSphere();
      out.push({ mat, geo });
    }
    this.byMat.clear();
    return out;
  }
}

export class EnemyManager {
  constructor(engine, { physics, level, player, ballistics, particles, audio, textures, enabled = true }) {
    this.engine = engine;
    this.physics = physics;
    this.level = level;
    this.player = player;
    this.ballistics = ballistics;
    this.particles = particles;
    this.audio = audio;
    this.textures = textures;
    this.enabled = enabled;

    this.enemies = [];
    this.rnd = mulberry32(4242);
    this.root = new THREE.Group();
    this.root.name = 'Enemies';
    engine.scene.add(this.root);

    if (enabled) this._spawnWave(8);
  }

  get alive() { return this.enemies.filter((e) => e.state !== STATE.DEAD).length; }

  _spawnWave(n) {
    const pts = this.level.patrolPoints.length ? this.level.patrolPoints : this.level.spawnPoints;
    for (let i = 0; i < n; i++) {
      const p = pts[(this.rnd() * pts.length) | 0] || new THREE.Vector3();
      const pos = new THREE.Vector3(p.x + (this.rnd() - 0.5) * 6, 0, p.z + (this.rnd() - 0.5) * 6);
      const ground = this.physics.groundHeight(pos.x, pos.z);
      pos.y = (ground ?? 0) + 0.02;
      this.enemies.push(this._makeEnemy(pos));
    }
  }

  /**
   * The three surface sheets. Baked lazily, once, and shared by every material
   * below; the clones only exist because tiling is a property of the texture.
   */
  _sheets() {
    if (this._sheetCache) return this._sheetCache;
    const nz = new Simplex(9137);

    // Ripstop weave carrying a four-tone camo. The pattern is the single biggest
    // thing separating "soldier" from "green mannequin" at 6 m: it breaks the
    // body into patches long before any individual thread is resolvable, and it
    // is the reason the uniform stops reading as one flat diffuse.
    const DARK = [0.115, 0.124, 0.090];
    const MID = [0.186, 0.192, 0.138];
    const LIGHT = [0.256, 0.246, 0.180];
    const BROWN = [0.180, 0.148, 0.112];
    const cloth = bakeKit((u, v) => {
      // Plain weave: warp and weft alternate over and under, so the height field
      // is a checker of two orthogonal ribs rather than a grid of bumps.
      const F = Math.PI * 2 * 22;
      const over = ((Math.floor(u * 44) + Math.floor(v * 44)) & 1) === 0;
      const rib = over ? Math.sin(u * F) : Math.sin(v * F);
      // Ripstop grid — the heavier thread every few millimetres that says
      // "military fabric" rather than "cotton".
      const grid = ((u * 11) % 1 < 0.10 || (v * 11) % 1 < 0.10) ? 0.28 : 0;
      const fuzz = tileFbm(nz, u, v, 40, 2) * 0.10;
      const hgt = 0.5 + rib * 0.16 + grid + fuzz;

      const n1 = tileFbm(nz, u, v, 1.8, 4);
      const n2 = tileFbm(nz, u + 0.31, v + 0.77, 3.6, 3);
      let c = MID;
      if (n1 > 0.10) c = LIGHT;
      if (n1 < -0.13) c = DARK;
      if (n2 > 0.26) c = BROWN;
      // Sun-bleached high points, dirt in the folds.
      const wear = 1 + tileFbm(nz, u + 4.2, v + 1.5, 7, 3) * 0.11 + grid * 0.22;
      const rough = 1 - Math.abs(fuzz) * 1.2 - (over ? 0 : 0.04);
      return [hgt, rough, c[0] * wear, c[1] * wear, c[2] * wear];
    }, 1.6, true);

    // Cordura webbing: coarse ribs across the strap with a stitch line down it.
    // Its sheen is what separates the carrier and pouches from the uniform once
    // the gear roughness of 0.5 is applied on top.
    const nylon = bakeKit((u, v) => {
      const rib = Math.cos(v * Math.PI * 2 * 26);
      const stitch = Math.abs(((u * 6) % 1) - 0.5) < 0.055 ? 0.24 : 0;
      const grain = tileFbm(nz, u + 2.1, v + 8.4, 30, 2) * 0.09;
      return [0.5 + rib * 0.13 + stitch + grain, 0.92 + rib * 0.06 - stitch * 0.35];
    }, 1.4);

    // Moulded rubber / pebbled leather for boot soles and gloves.
    const rubber = bakeKit((u, v) => {
      const w = worley2(u * 18, v * 18, 18, 771);
      const cell = smoothstep(0.02, 0.30, w.f1);
      return [0.5 + cell * 0.42 + tileFbm(nz, u + 3, v + 3, 34, 2) * 0.06, 1 - cell * 0.16];
    }, 2.2);

    // A limb's UV wraps once around a much smaller circumference than the
    // torso's, so an albedo tiled the same on both puts 20 cm camo patches on
    // the chest and 5 cm ones on the forearm — which is what makes a print read
    // as noise rather than as camouflage.
    this._sheetCache = {
      cloth: retile(cloth, 3, 3, 1.15, 1.15),
      clothLimb: retile(cloth, 2.2, 2.6, 0.55, 0.80),
      clothFine: retile(cloth, 1.5, 1.5, 0.9, 0.9),
      nylon: retile(nylon, 2, 2),
      nylonFine: retile(nylon, 1, 1),
      rubber: retile(rubber, 2, 2),
    };
    return this._sheetCache;
  }

  /**
   * Materials and merged part geometry, built once and shared by every soldier.
   * Eight fully-detailed characters would otherwise mean eight copies of ~100
   * buffers, and the GPU would see no instancing benefit at all.
   *
   * The primitives making up one rigid node are merged per material *inside*
   * this shared build, so a soldier costs about thirty draw calls instead of a
   * hundred while the whole wave still shares a single set of buffers.
   */
  _shared() {
    if (this._assets) return this._assets;
    const s = this._sheets();

    // Two roughness families, exactly as the surfaces divide: fabric is matte
    // and close to Lambertian, moulded gear and hard armour hold a broad sheen.
    // The sheets carry the break-up, these two scalars carry the split.
    const FABRIC = 0.90;
    const GEAR = 0.50;

    const M = (color, roughness, metalness, sheet, normalScale = 1) => {
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness,
        metalness,
        map: sheet.map,
        normalMap: sheet.normalMap,
        roughnessMap: sheet.roughnessMap,
      });
      mat.normalScale.set(normalScale, normalScale);
      return mat;
    };

    // A deliberate value ladder — sole 0x0d, webbing 0x19, plate 0x27, pouch
    // 0x3c, helmet 0x42, camo 0x28..0x62, skin 0xb0. Eight steps between the
    // darkest strap and the face is what keeps the kit legible in silhouette.
    const m = {
      camo: M(0xffffff, FABRIC, 0.0, s.cloth),           // albedo is the sheet
      camoLimb: M(0xffffff, FABRIC, 0.0, s.clothLimb),   // arms and legs
      camoWorn: M(0x8f8d84, 0.96, 0.0, s.clothFine),     // pads, cargo pockets
      gaiter: M(0x26271f, FABRIC, 0.0, s.nylonFine, 0.7),
      plate: M(0x1d1f19, GEAR, 0.06, s.nylon),
      pouch: M(0x303227, 0.62, 0.02, s.nylon),
      webbing: M(0x191a15, 0.55, 0.02, s.nylonFine),
      helmet: M(0x42452f, 0.58, 0.05, s.nylonFine, 0.55),
      gear: M(0x131412, 0.42, 0.35, s.nylonFine, 0.5),
      skin: M(0xb08466, 0.62, 0.0, s.nylonFine, 0.22),
      glove: M(0x232420, 0.66, 0.03, s.rubber),
      boot: M(0x2a2823, 0.60, 0.04, s.rubber),
      sole: M(0x0d0d0c, 0.95, 0.0, s.rubber, 1.4),
      lens: new THREE.MeshStandardMaterial({
        color: 0x101a18, roughness: 0.12, metalness: 0.1,
        emissive: 0x0a1512, emissiveIntensity: 0.3,
      }),
      gunmetal: M(0x1c1e1d, 0.45, 0.80, s.nylonFine, 0.4),
    };

    // Unit primitives, scaled into place by the bag. Limb segments stay tapered
    // capsules: real limbs are not cylinders, and the taper is most of what
    // stops a character reading as a balloon animal.
    const P = {
      box: new THREE.BoxGeometry(1, 1, 1),
      sphere: new THREE.SphereGeometry(0.5, 12, 9),
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
      torus: new THREE.TorusGeometry(0.5, 0.048, 6, 20),
      chest: new THREE.CapsuleGeometry(0.172, 0.235, 5, 12),
      pelvis: new THREE.CapsuleGeometry(0.158, 0.125, 5, 10),
      thigh: new THREE.CapsuleGeometry(0.093, 0.24, 4, 10),
      shin: new THREE.CapsuleGeometry(0.070, 0.26, 4, 10),
      upperArm: new THREE.CapsuleGeometry(0.058, 0.19, 4, 9),
      foreArm: new THREE.CapsuleGeometry(0.050, 0.20, 4, 9),
      helmetShell: new THREE.LatheGeometry(HELMET_PROFILE, 22),
    };

    // --- pelvis ---------------------------------------------------------------
    const hips = new GeoBag();
    hips.add(m.camo, P.pelvis);
    // A solid duty belt is what actually reads at distance; the pouches hanging
    // off it are second-order detail.
    hips.add(m.webbing, P.cyl, [0, 0.008, 0], null, [0.336, 0.072, 0.256]);
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI * 0.60 + (i / 5) * Math.PI * 1.2;
      const cx = Math.sin(a);
      const cz = Math.cos(a);
      hips.add(m.pouch, P.box, [cx * 0.150, -0.048, cz * 0.116], [0, a, 0], [0.082, 0.100, 0.060]);
      hips.add(m.webbing, P.box, [cx * 0.154, 0.014, cz * 0.119], [0, a, 0], [0.086, 0.030, 0.064]);
    }
    hips.add(m.pouch, P.box, [-0.105, -0.100, -0.150], [0.10, 0.20, 0], [0.125, 0.150, 0.085]);
    hips.add(m.gear, P.box, [0.162, -0.115, 0.030], [0, 0, 0.12], [0.072, 0.170, 0.100]);

    // --- torso ----------------------------------------------------------------
    const torso = new GeoBag();
    torso.add(m.camo, P.chest);
    torso.add(m.gaiter, P.cyl, [0, 0.168, 0.004], null, [0.200, 0.078, 0.178]);

    // Plate carrier. The hard, bevelled slab standing off the soft body is the
    // strongest "kitted up" cue there is, so it is built as a chest plate, an
    // angled upper bevel and a cummerbund rather than one flat box.
    for (const sz of [1, -1]) {
      torso.add(m.plate, P.box, [0, -0.022, sz * 0.118], null, [0.310, 0.260, 0.056]);
      torso.add(m.plate, P.box, [0, 0.128, sz * 0.096], [-sz * 0.30, 0, 0], [0.258, 0.120, 0.050]);
    }
    // Cummerbund round the ribs — the piece that closes the silhouette from the
    // side, where bare front and back plates leave the body reading as a tube.
    for (const sx of [-1, 1]) {
      torso.add(m.pouch, P.box, [sx * 0.170, -0.078, 0], [0, 0, sx * 0.06], [0.060, 0.150, 0.212]);
      torso.add(m.plate, P.box, [sx * 0.106, 0.148, 0.012], [0, 0, -sx * 0.10], [0.086, 0.076, 0.212]);
    }
    // Three magazine pouches with flaps, a radio, an admin pouch, two grenades.
    // The chest line has to be broken by hard objects standing off it, not by
    // anything painted on.
    for (let i = -1; i <= 1; i++) {
      torso.add(m.pouch, P.box, [i * 0.082, -0.078, 0.152], null, [0.076, 0.135, 0.062]);
      torso.add(m.webbing, P.box, [i * 0.082, 0.002, 0.155], [0.12, 0, 0], [0.080, 0.038, 0.068]);
    }
    torso.add(m.gear, P.box, [-0.148, 0.052, 0.096], [0, 0.25, 0], [0.070, 0.135, 0.062]);
    torso.add(m.gear, P.cyl, [-0.152, 0.212, 0.086], [0, 0, 0.16], [0.010, 0.240, 0.010]);
    torso.add(m.pouch, P.box, [0.150, 0.055, 0.100], [0, -0.25, 0], [0.078, 0.108, 0.055]);
    for (const sx of [-1, 1]) {
      torso.add(m.gear, P.cyl, [sx * 0.058, 0.092, 0.152], null, [0.048, 0.086, 0.048]);
    }
    torso.add(m.pouch, P.box, [0.072, -0.108, -0.148], null, [0.112, 0.102, 0.072]);
    // Sling, right shoulder to left hip, front and back runs.
    torso.add(m.webbing, P.box, [0.005, -0.012, 0.150], [0, 0, 0.62], [0.040, 0.300, 0.020]);
    torso.add(m.webbing, P.box, [0.005, -0.012, -0.150], [0, 0, -0.62], [0.040, 0.290, 0.020]);

    // --- head -----------------------------------------------------------------
    const head = new GeoBag();
    head.add(m.gaiter, P.cyl, [0, -0.082, 0], null, [0.118, 0.092, 0.118]);
    head.add(m.skin, P.sphere, [0, 0, 0.004], null, [0.185, 0.205, 0.196]);
    // Lower face is a neck gaiter, not a blank chin. It puts a hard dark value
    // under the cheekbones, which is what lets a head read as a face at range
    // without modelling features nobody can resolve anyway.
    head.add(m.gaiter, P.sphere, [0, -0.042, 0.010], null, [0.182, 0.150, 0.194]);

    head.add(m.helmet, P.helmetShell, [0, 0.010, -0.006], null, [1.02, 1.0, 1.08]);
    // The brim. A hemisphere reads as a bowl; the lip is what reads as a helmet,
    // and it is also the edge that catches the sun and draws the head.
    head.add(m.helmet, P.box, [0, -0.062, 0.104], [-0.28, 0, 0], [0.176, 0.020, 0.072]);
    head.add(m.webbing, P.torus, [0, -0.012, -0.004], [Math.PI / 2, 0, 0], [0.278, 0.278, 0.278]);
    for (const sx of [-1, 1]) {
      head.add(m.gear, P.box, [sx * 0.130, -0.020, 0.006], null, [0.016, 0.026, 0.150]);
      head.add(m.gear, P.cyl, [sx * 0.114, -0.014, 0.004], [0, 0, Math.PI / 2], [0.096, 0.036, 0.096]);
      head.add(m.webbing, P.box, [sx * 0.084, -0.052, 0.030], [0, 0, sx * 0.35], [0.018, 0.112, 0.052]);
    }
    // NVG mount and its stub arm: the two details that instantly date a helmet
    // as modern military, and a bump proud of the brow line in silhouette.
    head.add(m.gear, P.box, [0, 0.050, 0.108], [0.10, 0, 0], [0.072, 0.044, 0.032]);
    head.add(m.gear, P.box, [0, 0.098, 0.120], [-0.30, 0, 0], [0.032, 0.072, 0.034]);
    head.add(m.webbing, P.box, [0, 0.010, -0.132], [0.18, 0, 0], [0.112, 0.070, 0.062]);
    head.add(m.gear, P.box, [0, 0.028, 0.084], null, [0.166, 0.058, 0.032]);
    head.add(m.lens, P.box, [0, 0.030, 0.092], [0.06, 0, 0], [0.152, 0.044, 0.038]);

    // --- limb segments --------------------------------------------------------
    const thigh = new GeoBag();
    thigh.add(m.camoLimb, P.thigh, [0, -0.210, 0]);
    for (const sx of [-1, 1]) {
      thigh.add(m.camoWorn, P.box, [sx * 0.082, -0.238, 0.006], [0, 0, sx * 0.04], [0.038, 0.135, 0.132]);
      thigh.add(m.webbing, P.box, [sx * 0.090, -0.176, 0.006], null, [0.020, 0.028, 0.126]);
    }

    const knee = new GeoBag();
    knee.add(m.camoLimb, P.shin, [0, -0.200, 0]);
    knee.add(m.camoWorn, P.sphere, [0, -0.022, 0.036], null, [0.156, 0.132, 0.098]);
    knee.add(m.gear, P.box, [0, -0.026, 0.058], [0.10, 0, 0], [0.108, 0.088, 0.022]);
    // Boot: ankle cuff, leather upper, proud rubber sole. The sole is what gives
    // the foot a horizontal line to sit on the ground with.
    knee.add(m.boot, P.cyl, [0, -0.322, 0.004], null, [0.148, 0.112, 0.148]);
    knee.add(m.boot, P.box, [0, -0.394, 0.040], null, [0.108, 0.082, 0.238]);
    knee.add(m.boot, P.box, [0, -0.368, 0.108], [0.30, 0, 0], [0.100, 0.058, 0.072]);
    knee.add(m.webbing, P.box, [0, -0.350, 0.070], null, [0.052, 0.068, 0.054]);
    knee.add(m.sole, P.box, [0, -0.437, 0.044], null, [0.116, 0.028, 0.250]);
    knee.add(m.sole, P.box, [0, -0.424, 0.152], [0.22, 0, 0], [0.104, 0.032, 0.058]);

    const upperArm = new GeoBag();
    upperArm.add(m.plate, P.sphere, [0, 0.010, 0], null, [0.206, 0.172, 0.206]);
    upperArm.add(m.camoLimb, P.upperArm, [0, -0.155, 0]);
    upperArm.add(m.camoWorn, P.cyl, [0, -0.262, 0], null, [0.126, 0.046, 0.126]);

    const elbow = new GeoBag();
    elbow.add(m.camoLimb, P.foreArm, [0, -0.155, 0]);
    elbow.add(m.camoWorn, P.sphere, [0, -0.012, 0.028], null, [0.122, 0.100, 0.076]);
    // Glove: palm, knuckle plate, thumb, fingers. A bare box reads as a mitten.
    elbow.add(m.glove, P.box, [0, -0.308, 0.010], null, [0.068, 0.098, 0.058]);
    elbow.add(m.gear, P.box, [0, -0.290, 0.042], [0.20, 0, 0], [0.062, 0.052, 0.020]);
    elbow.add(m.glove, P.box, [0.036, -0.292, 0.026], [0, 0, 0.40], [0.030, 0.058, 0.034]);
    elbow.add(m.glove, P.box, [0, -0.356, 0.014], [0.10, 0, 0], [0.062, 0.048, 0.052]);

    // --- slung rifle ----------------------------------------------------------
    const rifle = new GeoBag();
    rifle.add(m.gunmetal, P.box, [0, 0, 0], null, [0.046, 0.072, 0.230]);
    rifle.add(m.gunmetal, P.box, [0, -0.004, -0.185], null, [0.042, 0.056, 0.160]);
    rifle.add(m.gunmetal, P.cyl, [0, 0.010, -0.320], [Math.PI / 2, 0, 0], [0.022, 0.190, 0.022]);
    rifle.add(m.gunmetal, P.box, [0, -0.086, -0.010], [0.16, 0, 0], [0.028, 0.120, 0.050]);
    rifle.add(m.gunmetal, P.box, [0, -0.052, 0.058], [-0.22, 0, 0], [0.026, 0.072, 0.045]);
    rifle.add(m.gunmetal, P.box, [0, -0.002, 0.190], null, [0.038, 0.060, 0.150]);
    rifle.add(m.gear, P.box, [0, 0.048, -0.030], null, [0.030, 0.034, 0.110]);
    rifle.add(m.gear, P.box, [0, 0.040, 0.078], null, [0.024, 0.016, 0.140]);

    this._assets = {
      m,
      rig: {
        hips: hips.build(),
        torso: torso.build(),
        head: head.build(),
        thigh: thigh.build(),
        knee: knee.build(),
        upperArm: upperArm.build(),
        elbow: elbow.build(),
        rifle: rifle.build(),
      },
    };
    return this._assets;
  }

  _makeEnemy(position) {
    const { rig } = this._shared();
    const group = new THREE.Group();
    group.position.copy(position);

    /** One rigid node: a group of merged, material-sorted meshes. */
    const node = (parts) => {
      const n = new THREE.Group();
      for (const p of parts) {
        const mesh = new THREE.Mesh(p.geo, p.mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.noCollide = true;
        n.add(mesh);
      }
      return n;
    };

    const hips = node(rig.hips);
    hips.position.y = 0.92;
    const torso = node(rig.torso);
    torso.position.y = 1.22;
    const head = node(rig.head);
    head.position.y = 1.62;
    group.add(hips, torso, head);

    // Each limb is a group pivoting at the joint, so the locomotion code can
    // rotate it directly and the child segments follow.
    const makeLeg = (side) => {
      const leg = node(rig.thigh);
      leg.position.set(side * 0.098, 0.88, 0);
      const knee = node(rig.knee);
      knee.position.y = -0.42;
      leg.add(knee);
      leg.userData.knee = knee;
      return leg;
    };
    const legL = makeLeg(-1);
    const legR = makeLeg(1);
    group.add(legL, legR);

    const makeArm = (side) => {
      const arm = node(rig.upperArm);
      arm.position.set(side * 0.223, 1.36, 0);
      const elbow = node(rig.elbow);
      elbow.position.y = -0.305;
      arm.add(elbow);
      arm.userData.elbow = elbow;
      return arm;
    };
    const armL = makeArm(-1);
    const armR = makeArm(1);
    group.add(armL, armR);

    // Slung across the chest, muzzle down and across the body: the pose reads as
    // a carried weapon from any angle, and the diagonal breaks the torso block.
    const rifle = node(rig.rifle);
    rifle.position.set(0.118, -0.090, 0.196);
    rifle.rotation.set(-0.45, 0.30, 0);
    torso.add(rifle);

    this.root.add(group);

    return {
      group, head, torso, hips, legL, legR, armL, armR,
      position: group.position,
      velocity: new THREE.Vector3(),
      yaw: this.rnd() * Math.PI * 2,
      health: 100,
      state: STATE.IDLE,
      target: null,
      alertness: 0,
      fireTimer: 0,
      burst: 0,
      reposition: new THREE.Vector3(),
      repositionTimer: 0,
      lastSeen: new THREE.Vector3(),
      hasLos: false,
      walkPhase: this.rnd() * 10,
      deathTime: 0,
      hitFlash: 0,
      // Hitbox stack: cheap spheres tested in order of value to the shooter.
      // Limb spheres hang off the knee/elbow joints rather than the hip/shoulder
      // pivots, so they actually sit over the limb mass as it swings.
      hitboxes: [
        { part: 'head', node: head, radius: 0.145, mult: 1 },
        { part: 'torso', node: torso, radius: 0.32, mult: 1 },
        { part: 'limb', node: legL.userData.knee, radius: 0.20, mult: 1 },
        { part: 'limb', node: legR.userData.knee, radius: 0.20, mult: 1 },
        { part: 'limb', node: armL.userData.elbow, radius: 0.17, mult: 1 },
        { part: 'limb', node: armR.userData.elbow, radius: 0.17, mult: 1 },
      ],
      takeDamage: null, // wired below
    };
  }

  raycastEntities(origin, dir, maxDist, owner) {
    if (owner !== 'player') return null;
    let best = null;
    for (const e of this.enemies) {
      if (e.state === STATE.DEAD) continue;
      // Cheap reject against the whole capsule first.
      _c.copy(e.position); _c.y += 0.9;
      if (!raySphere(origin, dir, _c, 1.15, maxDist)) continue;
      for (const hb of e.hitboxes) {
        hb.node.getWorldPosition(_c);
        const t = raySphere(origin, dir, _c, hb.radius, best ? best.distance : maxDist);
        if (t !== null && (!best || t < best.distance)) {
          best = {
            distance: t,
            point: new THREE.Vector3().copy(origin).addScaledVector(dir, t),
            normal: new THREE.Vector3().copy(origin).addScaledVector(dir, t).sub(_c).normalize(),
            entity: e,
            part: hb.part,
            surface: SURFACE.FLESH,
          };
        }
      }
    }
    if (best) best.entity.takeDamage = (dmg, info) => this._damage(best.entity, dmg, info);
    return best;
  }

  _damage(enemy, amount, info) {
    if (enemy.state === STATE.DEAD) return false;
    enemy.health -= amount;
    enemy.hitFlash = 1;
    enemy.alertness = 1;
    enemy.state = STATE.ENGAGE;
    enemy.lastSeen.copy(this.player.position);
    if (enemy.health <= 0) {
      enemy.state = STATE.DEAD;
      enemy.deathTime = 0;
      this.particles.emit('bloodMist', info.point, info.normal, { scale: 2 });
      this.audio?.playAt?.('death', enemy.position);
      return true;
    }
    return false;
  }

  onNoise(position, radius) {
    for (const e of this.enemies) {
      if (e.state === STATE.DEAD) continue;
      if (e.position.distanceTo(position) < radius) {
        e.alertness = Math.max(e.alertness, 0.75);
        e.lastSeen.copy(position);
        if (e.state === STATE.IDLE) e.state = STATE.ALERT;
      }
    }
  }

  fixedUpdate(dt) {
    if (!this.enabled) return;
    const player = this.player;
    for (const e of this.enemies) {
      if (e.state === STATE.DEAD) { this._updateDeath(e, dt); continue; }

      _eye.copy(e.position); _eye.y += 1.6;
      _target.copy(player.position); _target.y += 1.4;
      const dist = _eye.distanceTo(_target);
      e.hasLos = dist < 120 && !this.physics.occluded(_eye, _target);

      if (e.hasLos) {
        _toPlayer.subVectors(_target, _eye).normalize();
        _fwd.set(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));
        const facing = _toPlayer.dot(_fwd);
        // Vision cone: instant if in front, slow build-up in the periphery.
        const gain = facing > 0.3 ? 2.6 : facing > -0.2 ? 0.8 : 0.15;
        e.alertness = clamp(e.alertness + gain * dt * clamp(1 - dist / 110, 0.15, 1), 0, 1);
        if (e.alertness > 0.6) { e.state = STATE.ENGAGE; e.lastSeen.copy(player.position); }
        else if (e.alertness > 0.2 && e.state === STATE.IDLE) e.state = STATE.ALERT;
      } else {
        e.alertness = Math.max(0, e.alertness - 0.28 * dt);
        if (e.state === STATE.ENGAGE && e.alertness < 0.15) e.state = STATE.ALERT;
      }

      switch (e.state) {
        case STATE.IDLE: this._idle(e, dt); break;
        case STATE.ALERT: this._alert(e, dt); break;
        case STATE.ENGAGE: this._engage(e, dt, dist); break;
        case STATE.REPOSITION: this._reposition(e, dt); break;
      }

      this._integrate(e, dt);
    }
  }

  _idle(e, dt) {
    e.repositionTimer -= dt;
    if (e.repositionTimer <= 0) {
      e.repositionTimer = 3 + this.rnd() * 5;
      const pts = this.level.patrolPoints;
      const p = pts[(this.rnd() * pts.length) | 0];
      if (p) e.reposition.copy(p);
    }
    this._moveToward(e, e.reposition, 1.5, dt);
  }

  _alert(e, dt) {
    this._faceToward(e, e.lastSeen, 4.0, dt);
    this._moveToward(e, e.lastSeen, 2.4, dt);
  }

  _engage(e, dt, dist) {
    this._faceToward(e, this.player.position, 9.0, dt);
    // Hold a preferred band: close the gap when far, back off when too close.
    const ideal = 16;
    if (dist > ideal + 8) this._moveToward(e, this.player.position, 3.4, dt);
    else if (dist < ideal - 8) this._moveAway(e, this.player.position, 2.6, dt);
    else { e.velocity.x *= 0.86; e.velocity.z *= 0.86; }

    e.fireTimer -= dt;
    if (e.hasLos && e.fireTimer <= 0) {
      if (e.burst <= 0) { e.burst = 3 + ((this.rnd() * 3) | 0); e.fireTimer = 0.09; }
      else {
        e.burst--;
        e.fireTimer = e.burst > 0 ? 0.1 : 0.9 + this.rnd() * 1.1;
        this._shoot(e);
      }
    }
  }

  _reposition(e, dt) {
    this._moveToward(e, e.reposition, 3.6, dt);
    if (e.position.distanceTo(e.reposition) < 1.5) e.state = STATE.ENGAGE;
  }

  _shoot(e) {
    _eye.copy(e.position); _eye.y += 1.55;
    _target.copy(this.player.position);
    _target.y += 1.0 + this.rnd() * 0.4;
    _dir.subVectors(_target, _eye).normalize();
    // Deliberate inaccuracy so the player has time to react and take cover.
    const spread = 0.028;
    _dir.x += (this.rnd() - 0.5) * spread;
    _dir.y += (this.rnd() - 0.5) * spread;
    _dir.z += (this.rnd() - 0.5) * spread;
    _dir.normalize();

    this.ballistics.fire({
      origin: _eye, direction: _dir,
      weapon: { muzzleVelocity: 620, damage: 14, drag: 0.001, falloff: { start: 24, end: 80, min: 0.4 }, tracerEvery: 2 },
      owner: e,
    });
    this.engine.game?.lighting?.flash(_eye, 0xffcf94, 12, 0.04, 9);
    this.particles.emit('muzzleSmoke', _eye, _dir, { scale: 0.5 });
    this.audio?.playAt?.('enemy_shot', _eye);

    // Enemy rounds hit the player through a direct proximity test rather than
    // relying on the bullet provider list (the player has no entity proxy).
    const hitChance = 0.34;
    if (this.rnd() < hitChance && e.hasLos) {
      this.player.damage(12 + this.rnd() * 8, e.position);
    }
  }

  _moveToward(e, target, speed, dt) {
    _dir.subVectors(target, e.position).setY(0);
    const d = _dir.length();
    if (d < 0.6) return;
    _dir.multiplyScalar(1 / d);
    e.velocity.x = damp(e.velocity.x, _dir.x * speed, 8, dt);
    e.velocity.z = damp(e.velocity.z, _dir.z * speed, 8, dt);
  }

  _moveAway(e, target, speed, dt) {
    _dir.subVectors(e.position, target).setY(0).normalize();
    e.velocity.x = damp(e.velocity.x, _dir.x * speed, 8, dt);
    e.velocity.z = damp(e.velocity.z, _dir.z * speed, 8, dt);
  }

  _faceToward(e, target, rate, dt) {
    _dir.subVectors(target, e.position).setY(0);
    const want = Math.atan2(-_dir.x, -_dir.z);
    let delta = want - e.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    e.yaw += delta * Math.min(1, rate * dt);
  }

  _integrate(e, dt) {
    e.velocity.y += this.physics.gravity * dt;
    e.position.addScaledVector(e.velocity, dt);
    const res = this.physics.resolveCapsule(e.position, 0.34, 1.78, e._res || (e._res = {}));
    e.position.copy(res.position);
    if (res.grounded && e.velocity.y < 0) e.velocity.y = 0;
    if (res.hitWall) {
      const vn = e.velocity.dot(res.wallNormal);
      if (vn < 0) e.velocity.addScaledVector(res.wallNormal, -vn);
    }
    e.group.rotation.y = e.yaw;

    // Procedural locomotion so movement reads as walking rather than sliding.
    const speed = Math.hypot(e.velocity.x, e.velocity.z);
    e.walkPhase += dt * (2.2 + speed * 1.9);
    const amp = clamp(speed / 3.4, 0, 1);
    const s = Math.sin(e.walkPhase), c = Math.cos(e.walkPhase);
    e.legL.rotation.x = s * 0.62 * amp;
    e.legR.rotation.x = -s * 0.62 * amp;
    e.armL.rotation.x = -s * 0.45 * amp;
    e.armR.rotation.x = s * 0.45 * amp;
    e.torso.position.y = 1.22 + Math.abs(c) * 0.028 * amp;
    e.head.position.y = 1.62 + Math.abs(c) * 0.028 * amp;
    // Weapon-ready pose when engaging.
    if (e.state === STATE.ENGAGE) {
      e.armL.rotation.x = damp(e.armL.rotation.x, -1.35, 9, dt);
      e.armR.rotation.x = damp(e.armR.rotation.x, -1.35, 9, dt);
    }
  }

  _updateDeath(e, dt) {
    e.deathTime += dt;
    // Simple keyframed collapse; a real ragdoll solver is the next tier up.
    const t = clamp(e.deathTime / 0.85, 0, 1);
    const fall = t * t * (3 - 2 * t);
    e.group.rotation.x = fall * -Math.PI * 0.48;
    e.group.position.y = e.position.y - fall * 0.05;
    if (e.deathTime > 22) {
      e.group.visible = false;
    }
  }

  update(dt) {
    for (const e of this.enemies) {
      if (e.hitFlash > 0) {
        e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
      }
    }
  }
}

/** Returns the near-hit distance along the ray, or null. */
function raySphere(origin, dir, center, radius, maxDist) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxDist) return null;
  return t;
}

/**
 * Half-section of a combat helmet, lathed about Y. The first three points are
 * the underside lip and the flared brim: a plain hemisphere reads as a salad
 * bowl, and the brim is both the shape cue and the edge the sun catches.
 *
 * Ordered bottom-to-top, which is the order LatheGeometry needs if the faces
 * are to come out with their normals pointing outwards — reversed, the crown of
 * the helmet is back-facing, gets culled, and the wearer's scalp shows through.
 */
const HELMET_PROFILE = [
  [0.118, -0.086], [0.139, -0.090], [0.147, -0.080], [0.141, -0.068],
  [0.133, -0.050], [0.132, -0.014], [0.128, 0.030], [0.118, 0.068],
  [0.101, 0.098], [0.076, 0.118], [0.042, 0.128], [0.000, 0.130],
].map(([r, y]) => new THREE.Vector2(r, y));

const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _eul = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();

const _c = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();

export { STATE };
