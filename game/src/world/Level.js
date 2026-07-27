import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Simplex, fbm2, mulberry32, clamp, lerp, smoothstep } from '../core/Noise.js';
import { SURFACE } from '../gameplay/Physics.js';

/**
 * The playable space: a war-torn Middle-Eastern urban block built from a
 * modular facade kit, dressed with street clutter and published to the engine
 * as collision geometry plus a set of named camera poses.
 *
 * LAYOUT
 *   A single east-west boulevard (the X axis) punched through a dense block,
 *   widening into a market plaza at the origin. Two terraced rows flank it;
 *   narrow alleys cut through the rows at four points. The sun sits south-east
 *   in the morning, so the northern row (front faces pointing +Z) is lit while
 *   the southern row is in shadow and throws its shadow across the road — the
 *   light/shade split down the street is the whole reason the block is oriented
 *   this way.
 *
 * CONSTRUCTION
 *   Visual geometry is authored as thousands of small boxes/lathes staged into
 *   per-material batches, merged once at the end (a handful of draw calls) and
 *   given baked per-vertex weathering derived from world position. Collision is
 *   authored separately and coarsely — a solid box per building, ramps for
 *   stairs — so the BVH stays small even though the art does not.
 *
 * CONTRACT:
 *   await level.build(onProgress)
 *   level.cameraPoses  — { name: {position:[x,y,z], yaw, pitch, fov?, timeOfDay?, hideViewmodel?} }
 *   level.spawnPoints  — [THREE.Vector3]
 *   level.patrolPoints — [THREE.Vector3]  (AI route seeds)
 *   level.raycastEntities(origin, dir, maxDist) — breakables; null if none hit
 */

// --- block metrics ----------------------------------------------------------
const ROAD_HALF = 7.0;      // kerb-to-kerb half width of the boulevard
const WALK_W = 3.6;         // pavement width
const WALK_H = 0.16;        // pavement / kerb height above the road
const PLAZA = 22.0;         // plaza half extent about the origin
const FLOOR_H = 3.35;       // upper storey height
const GROUND_H = 3.9;       // taller ground floor so shopfronts read
const WALL_T = 0.34;        // facade thickness — this is the window reveal depth
const MAP_X = 112;          // ground half extent along the boulevard
const MAP_Z = 84;
const CELL = 34;            // merge-batch cell size; sets the culling granularity
const CORE_X = 54;          // inside this box the fine merge grid is used; outside,
const CORE_Z = 46;          // one coarse bucket, because nothing out there ever culls

/**
 * The real GPU materials — one per texture set and shading model. Everything a
 * building is made of resolves to one of these, so the whole city draws from
 * about a dozen programs.
 *
 * Colour is deliberately absent: the tint that turns four base textures into a
 * dozen different buildings is baked into vertex colour by `_colorize` instead
 * (see PALETTE). That is what lets five plaster shades share one draw call.
 */
const MATERIALS = {
  plaster: { tex: 'plaster', surface: SURFACE.PLASTER },
  brick: { tex: 'brick', surface: SURFACE.CONCRETE },
  stonework: { tex: 'concrete', surface: SURFACE.CONCRETE },
  ferrous: { tex: 'rustMetal', metalness: 0.22, roughness: 0.86, surface: SURFACE.METAL },
  metal: { tex: 'metalPanel', metalness: 0.82, surface: SURFACE.METAL },
  panel: { tex: 'metalPanel', metalness: 0.68, side: THREE.DoubleSide, surface: SURFACE.METAL },
  wood: { tex: 'wood', roughness: 0.86, surface: SURFACE.WOOD },
  fabric: { tex: 'cloth', side: THREE.DoubleSide, roughness: 0.97, surface: SURFACE.FABRIC },
  granular: { tex: 'sand', roughness: 1, surface: SURFACE.SAND },
  roofdeck: { tex: 'tarFelt', roughness: 1, surface: SURFACE.CONCRETE },
  rubber: { tex: 'rubberTread', roughness: 0.88, surface: SURFACE.RUBBER },
  dark: { tex: 'concrete', roughness: 1, surface: SURFACE.CONCRETE },
  glass: { roughness: 0.12, metalness: 0.35, surface: SURFACE.GLASS },
  sign: { tex: 'sign', roughness: 0.7, side: THREE.DoubleSide, surface: SURFACE.METAL },
  lamp: { tex: 'metalPanel', roughness: 0.6, metalness: 0.6, emissive: 0xffb562, emissiveIntensity: 0, surface: SURFACE.METAL },
};

/**
 * Authoring palette: the names the level actually builds with. Each maps to a
 * GPU material plus the colour that separates it from its siblings. For merged
 * geometry the colour is folded into the vertex colours; for instanced props it
 * becomes the material colour and `instanceColor` varies from there.
 */
const PALETTE = {
  plasterA: { batch: 'plaster', color: 0xb99f6d },
  plasterB: { batch: 'plaster', color: 0xd6c8a9 },
  plasterC: { batch: 'plaster', color: 0x8d9b9c },
  plasterD: { batch: 'plaster', color: 0xa2a482 },
  plasterE: { batch: 'plaster', color: 0xc09480 },
  brick: { batch: 'brick', color: 0xa07b60 },
  concrete: { batch: 'stonework', color: 0xada695 },
  concreteDark: { batch: 'stonework', color: 0x6f6a5f },
  stone: { batch: 'stonework', color: 0xc4b58e },
  barrier: { batch: 'stonework', color: 0xa8a294 },
  // Burnt metal used to be 0x3b332c over an already-dark rust map at metalness
  // 0.45: the product was so close to zero that every wreck resolved to a pure
  // black silhouette with no shading at all. Lifted, and the metalness dropped
  // so the diffuse term survives.
  rust: { batch: 'ferrous', color: 0x8b7d6b },
  burnt: { batch: 'ferrous', color: 0x847767 },
  charred: { batch: 'ferrous', color: 0x4a4237 },
  metal: { batch: 'metal', color: 0x9aa0a6 },
  panel: { batch: 'panel', color: 0xb0b4b6 },
  wood: { batch: 'wood', color: 0xb59a72 },
  fabric: { batch: 'fabric', color: 0xffffff },
  sandbag: { batch: 'granular', color: 0x9c8f66 },
  sand: { batch: 'granular', color: 0xc9ad7d },
  // Deliberately neutral: `_colorize` adds a warm dust cast to every up-facing
  // surface, and a warm base under it turns a bitumen roof into a sand dune.
  roof: { batch: 'roofdeck', color: 0x74746f },
  roofWet: { batch: 'roofdeck', color: 0x464640 },
  roofPatch: { batch: 'roofdeck', color: 0x62625b },
  rubber: { batch: 'rubber', color: 0x2a2a30 },
  dark: { batch: 'dark', color: 0x16130f },
  glass: { batch: 'glass', color: 0x1c2429 },
  sign: { batch: 'sign', color: 0xffffff },
  lamp: { batch: 'lamp', color: 0x2a2622 },
};

/** Batches that should not cast shadows — thin trim whose shadow map cost buys nothing. */
const NO_CAST = new Set(['dark', 'glass', 'sign', 'lamp']);

/**
 * Batches too sparse to be worth a spatial grid. Glazing, signage and trim
 * amount to a few thousand triangles across the whole map; splitting them into
 * a dozen cells each buys culling on geometry that was never the cost and
 * spends a dozen draw calls doing it. One bucket in the core, one outside.
 */
const SPARSE = new Set(['glass', 'sign', 'lamp', 'panel', 'rubber', 'fabric', 'metal', 'dark', 'granular']);

/** Plausible laundry: whites, work blues, faded ochres. Never a random hue. */
const LAUNDRY_COLORS = [
  0xd9d4c6, 0xc3cbd2, 0xa9b6a2, 0xc9ab8d, 0x9fadbc, 0xdccba9,
  0xb0584c, 0xe7e3d9, 0x8c9aa6, 0xd2c0a0,
];

// --- geometry helpers -------------------------------------------------------

/**
 * BoxGeometry whose UVs are rewritten to a constant texel density (tile
 * repeats per metre) instead of 0..1 per face. Without this every wall panel
 * stretches its texture to its own size and the block reads as untextured
 * greybox no matter how good the material is.
 */
function boxGeo(w, h, d, density = 0.42) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // BoxGeometry emits faces in the order +X, -X, +Y, -Y, +Z, -Z, four verts each.
  const span = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const su = span[f][0] * density, sv = span[f][1] * density;
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  return g;
}

/** Cylinder with UVs scaled to the same density convention as boxGeo. */
function cylGeo(rTop, rBot, h, seg = 10, density = 0.42) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false);
  const uv = g.attributes.uv;
  const circ = Math.PI * (rTop + rBot) * density;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h * density);
  return g;
}

/**
 * Faceted rubble chunk. The icosahedron is welded before displacement so the
 * jitter moves whole corners rather than shredding individual triangles, then
 * re-split so the result stays hard-edged like broken masonry.
 */
function rockGeo(radius, rnd) {
  const g = new THREE.IcosahedronGeometry(radius, 0);
  const p = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)}|${p.getY(i).toFixed(3)}|${p.getZ(i).toFixed(3)}`;
    let s = seen.get(key);
    if (s === undefined) { s = 0.55 + rnd() * 0.85; seen.set(key, s); }
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.68, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Constant-texel-density UVs derived from world position, chosen per triangle
 * from the dominant normal axis. Needed for anything not built by boxGeo —
 * ExtrudeGeometry in particular hands back UVs in raw shape units, which is
 * what makes an extruded profile read as flat card however good the map is.
 */
function worldUV(geo, density = 0.9) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else if (ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u * density;
    uv[i * 2 + 1] = v * density;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Split every triangle onto its own vertices and recompute normals, so a
 * faceted profile shades as facets. Smoothing an extruded Jersey barrier across
 * its corners is exactly what turns 82 cm of moulded concrete into a flat pale
 * slab you would swear you could see through.
 */
function facet(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.clearGroups();
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

// --- tileable scalar fields for the level's own texture set -----------------

/** One octave of wrapping value noise sampled onto an N×N grid. */
function latticeField(rnd, N, freq) {
  const g = new Float32Array(freq * freq);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(N * N);
  const s = freq / N;
  for (let y = 0; y < N; y++) {
    const fy = y * s, y0 = Math.floor(fy), ty = fy - y0;
    const wy = ty * ty * (3 - 2 * ty);
    const ya = (y0 % freq) * freq, yb = ((y0 + 1) % freq) * freq;
    for (let x = 0; x < N; x++) {
      const fx = x * s, x0 = Math.floor(fx), tx = fx - x0;
      const wx = tx * tx * (3 - 2 * tx);
      const xa = x0 % freq, xb = (x0 + 1) % freq;
      const t0 = g[ya + xa] + (g[ya + xb] - g[ya + xa]) * wx;
      const t1 = g[yb + xa] + (g[yb + xb] - g[yb + xa]) * wx;
      out[y * N + x] = t0 + (t1 - t0) * wy;
    }
  }
  return out;
}

/** Wrapping fBm in [0,1]. `freq` is the lattice size of the first octave. */
function fbmField(rnd, N, freq, octaves = 3, gain = 0.5) {
  const out = new Float32Array(N * N);
  let amp = 1, tot = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    const l = latticeField(rnd, N, f);
    for (let i = 0; i < out.length; i++) out[i] += l[i] * amp;
    tot += amp; amp *= gain; f *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

/**
 * DataTexture in the same sampling regime as the library's own maps.
 * DataTexture ignores flipY, so every array fed to this must already be in
 * v-up order — see `_localSet`, which flips the canvas readback once.
 */
function dataTex(arr, N, aniso, srgb = false) {
  const t = new THREE.DataTexture(arr, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Central-difference normal map from a wrapping height field, v-up. */
function normalTex(h, N, strength, aniso) {
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    const row = y * N, up = ((y + 1) % N) * N, dn = ((y - 1 + N) % N) * N;
    for (let x = 0; x < N; x++) {
      const hl = h[row + ((x - 1 + N) % N)], hr = h[row + ((x + 1) % N)];
      const nx = (hl - hr) * strength;
      const ny = (h[dn + x] - h[up + x]) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const k = (row + x) * 4;
      d[k] = (nx * inv * 0.5 + 0.5) * 255;
      d[k + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[k + 2] = (inv * 0.5 + 0.5) * 255;
      d[k + 3] = 255;
    }
  }
  return dataTex(d, N, aniso);
}

/** Sequential index so non-indexed primitives can be merged with indexed ones. */
function ensureIndex(geo) {
  if (geo.index) return geo;
  const n = geo.attributes.position.count;
  const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  geo.setIndex(new THREE.BufferAttribute(arr, 1));
  return geo;
}

/**
 * Decompose a `w × h` wall into the minimal set of solid rectangles left once
 * `openings` are punched out: sweep unique X boundaries, then walk Y within
 * each slab. Because the wall is extruded to WALL_T the edges of every hole
 * become genuine recessed reveals rather than a texture trick.
 */
function wallSolids(w, h, openings) {
  const xs = new Set([0, w]);
  for (const o of openings) { xs.add(clamp(o.x, 0, w)); xs.add(clamp(o.x + o.w, 0, w)); }
  const xa = [...xs].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xa.length - 1; i++) {
    const x0 = xa[i], x1 = xa[i + 1];
    if (x1 - x0 < 1e-3) continue;
    const mid = (x0 + x1) * 0.5;
    const spans = openings
      .filter((o) => o.x <= mid && o.x + o.w >= mid)
      .sort((a, b) => a.y - b.y);
    let y = 0;
    for (const o of spans) {
      const oy0 = clamp(o.y, 0, h), oy1 = clamp(o.y + o.h, 0, h);
      if (oy0 > y + 1e-3) out.push({ x: x0, y, w: x1 - x0, h: oy0 - y });
      y = Math.max(y, oy1);
    }
    if (y < h - 1e-3) out.push({ x: x0, y, w: x1 - x0, h: h - y });
  }
  return out;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _col = new THREE.Color();
const _tint = new THREE.Color();   // scratch for palette x caller tint; never escapes _stage
const _size = new THREE.Vector2();

/** Compose a placement matrix without allocating. */
function mat(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ');
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e), _one);
}

export class Level {
  constructor(engine, { textures, physics, seed = 1, lighting }) {
    this.engine = engine;
    this.textures = textures;
    this.physics = physics;
    this.lighting = lighting;
    this.seed = seed;
    this.rnd = mulberry32(seed);
    this.noise = new Simplex(seed);
    this.root = new THREE.Group();
    this.root.name = 'Level';
    engine.scene.add(this.root);

    this.spawnPoints = [];
    this.patrolPoints = [];
    this.breakables = [];
    this.cameraPoses = {};
    this.size = 160;

    this._batches = new Map();   // material key -> staged geometries
    this._mats = new Map();
    this._palCols = new Map();
    this._texSets = new Map();
    this._localTex = new Map();
    this._wires = null;          // staged overhead cabling, flushed to one mesh
    this._footprints = [];       // building rects, drive ground sand-drift + splat
    this._poseFov = 0;
  }

  async build(onProgress = () => {}) {
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

    onProgress(0.04, 'ZONING BLOCK');
    this._plan = this._layout();
    for (const b of this._plan) {
      this._footprints.push({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 });
    }
    await yieldFrame();

    onProgress(0.12, 'TERRAIN');
    this._buildGround();
    await yieldFrame();

    onProgress(0.26, 'KERBS AND PAVEMENT');
    this._buildPavement();
    await yieldFrame();

    onProgress(0.34, 'STRUCTURES');
    for (let i = 0; i < this._plan.length; i++) {
      this._building(this._plan[i]);
      if (i % 6 === 5) { onProgress(0.34 + 0.3 * (i / this._plan.length), 'STRUCTURES'); await yieldFrame(); }
    }
    await yieldFrame();

    onProgress(0.66, 'LANDMARKS');
    this._buildLandmarks();
    this._buildInteriors();
    await yieldFrame();

    onProgress(0.74, 'STREET DRESSING');
    this._buildStreetFurniture();
    this._buildWrecks();
    this._buildMarket();
    await yieldFrame();

    onProgress(0.82, 'CLUTTER');
    this._buildClutter();
    this._buildCables();
    await yieldFrame();

    onProgress(0.9, 'MERGING GEOMETRY');
    this._flushBatches();
    this._flushWires();
    await yieldFrame();

    onProgress(0.96, 'COLLISION');
    this.physics.bake();

    this._defineNavigation();
    this._definePoses();
    onProgress(1, 'LEVEL READY');
    return this;
  }

  // --- material + batching infrastructure -----------------------------------

  /**
   * Private clones of the shared procedural textures. The library hands out one
   * Texture per material name and `setRepeat` mutates it in place, so any other
   * system asking for a different tiling would silently rescale the whole city.
   * Cloning shares the GPU source but gives us our own repeat of (1,1) — all of
   * the level's texel density lives in the UVs instead.
   */
  _texSet(name) {
    if (this._texSets.has(name)) return this._texSets.get(name);
    const src = this._localTex.get(name) || this.textures.get(name) || this._makeLocalTexture(name) || {};
    const out = {};
    for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
      const t = src[k];
      if (!t) continue;
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(1, 1);
      c.needsUpdate = true;
      out[k] = c;
    }
    this._texSets.set(name, out);
    return out;
  }

  /** Linear-space palette colour for an authoring key, cached. */
  _paletteColor(key) {
    let c = this._palCols.get(key);
    if (!c) {
      const p = PALETTE[key];
      c = new THREE.Color(p ? p.color : 0xffffff);
      this._palCols.set(key, c);
    }
    return c;
  }

  _mat(key, instanced = false) {
    const cacheKey = instanced ? `${key}#i` : (PALETTE[key]?.batch || key);
    if (this._mats.has(cacheKey)) return this._mats.get(cacheKey);
    const s = MATERIALS[PALETTE[key]?.batch || key];
    const m = new THREE.MeshStandardMaterial({
      // Merged geometry has the palette colour folded into its vertex colours,
      // so the material itself is neutral and one program serves every tint.
      // Instanced props have no vertex colours to fold into, so they keep it.
      color: instanced ? (PALETTE[key]?.color ?? 0xffffff) : 0xffffff,
      roughness: s.roughness ?? 0.95,
      metalness: s.metalness ?? 0,
      side: s.side ?? THREE.FrontSide,
      // Batched geometry carries baked weathering in vertex colours; instanced
      // props vary per-instance through instanceColor instead.
      vertexColors: !instanced,
    });
    // Nothing in the level is glazing: state this rather than inherit it, so a
    // stray blend flag can never leak in and make solid concrete see-through.
    m.transparent = false;
    m.opacity = 1;
    m.alphaTest = 0;
    m.depthWrite = true;
    m.depthTest = true;
    m.blending = THREE.NoBlending;
    if (s.emissive !== undefined) {
      m.emissive = new THREE.Color(s.emissive);
      m.emissiveIntensity = s.emissiveIntensity ?? 1;
    }
    if (s.tex) {
      const set = this._texSet(s.tex);
      if (set.map) m.map = set.map;
      if (set.normalMap) { m.normalMap = set.normalMap; m.normalScale.set(0.85, 0.85); }
      if (set.roughnessMap) m.roughnessMap = set.roughnessMap;
      if (set.aoMap) m.aoMap = set.aoMap;
    }
    this._mats.set(cacheKey, m);
    return m;
  }

  /**
   * Stage a world-space geometry into a merge batch.
   *
   * Batches are keyed by material *and* by a coarse spatial cell. Merging by
   * material alone would give the fewest draw calls but each mesh would span
   * the whole map, so nothing could ever be frustum-culled and both the colour
   * and the shadow pass would submit the entire city every frame. Cell-sized
   * batches trade a few dozen extra draw calls for real culling, which on a
   * software rasteriser is the difference between a frame and a stall.
   */
  _stage(key, geo, matrix = null, tint = null) {
    if (matrix) geo.applyMatrix4(matrix);
    ensureIndex(geo);
    const pc = this._paletteColor(key);
    this._colorize(geo, tint ? _tint.copy(tint).multiply(pc) : pc);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const mx = (bb.min.x + bb.max.x) * 0.5, mz = (bb.min.z + bb.max.z) * 0.5;
    // Two-tier grid. Inside the playable core the fine cells buy real frustum
    // culling; the skyline filler beyond it is on screen in every pose that can
    // see it at all, so culling there costs draw calls and returns nothing.
    const core = Math.abs(mx) <= CORE_X && Math.abs(mz) <= CORE_Z;
    const batch = PALETTE[key]?.batch || key;
    const c = core ? CELL : CELL * 3;
    const full = SPARSE.has(batch)
      ? `${batch}#${core ? 'c' : 'f'}`
      : `${batch}#${core ? 'c' : 'f'}${Math.floor(mx / c)}_${Math.floor(mz / c)}`;
    let b = this._batches.get(full);
    if (!b) { b = { key, geos: [], far: !core }; this._batches.set(full, b); }
    b.far = b.far && !core;
    b.geos.push(geo);
    return geo;
  }

  _box(key, w, h, d, x, y, z, matrix = null, tint = null, density = 0.42) {
    const g = boxGeo(w, h, d, density);
    g.translate(x, y, z);
    return this._stage(key, g, matrix, tint);
  }

  /**
   * Baked weathering. Every vertex is tinted from its final world position, so
   * grime, sun-bleach and dust accumulation stay coherent across the whole
   * block instead of restarting at each mesh — the single cheapest thing that
   * stops procedural architecture looking like flat-shaded cardboard.
   */
  _colorize(geo, tint) {
    const pos = geo.attributes.position, nrm = geo.attributes.normal;
    const n = this.noise;
    const arr = new Float32Array(pos.count * 3);
    const tr = tint ? tint.r : 1, tg = tint ? tint.g : 1, tb = tint ? tint.b : 1;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const ny = nrm ? nrm.getY(i) : 0;
      // Broad tonal drift so two buildings sharing a material never match.
      const macro = fbm2(n, x * 0.031, z * 0.031, 3) * 0.5 + 0.5;
      // High frequency across, low along height: reads as rain/rust streaking.
      const streak = fbm2(n, (x + z) * 0.42, y * 0.075, 3) * 0.5 + 0.5;
      const ground = 1 - smoothstep(0.0, 3.0, y);      // splash-back grime
      const up = clamp(ny, 0, 1);                       // dust settles on ledges
      const down = clamp(-ny, 0, 1);                    // contact shadow under trim

      let v = 0.80 + macro * 0.30;
      v *= 1 - ground * 0.34 * (0.35 + streak * 0.85);
      v *= 1 - (1 - streak) * 0.11;
      v *= 1 - down * 0.32;
      v *= 1 + up * 0.06;
      const dust = up * (0.35 + macro * 0.45);
      arr[i * 3] = v * lerp(1, 1.14, dust) * tr;
      arr[i * 3 + 1] = v * lerp(1, 1.02, dust) * tg;
      arr[i * 3 + 2] = v * lerp(1, 0.78, dust) * tb;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }

  /** Merge every batch into one mesh per material per spatial cell. */
  _flushBatches() {
    for (const [full, b] of this._batches) {
      const geos = b.geos;
      if (!geos.length) continue;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) { console.warn(`Level: batch "${full}" failed to merge`); continue; }
      if (geos.length > 1) for (const g of geos) g.dispose();
      // aoMap samples the second UV channel; the baked AO is meant to tile with
      // the albedo so the two channels share coordinates.
      merged.setAttribute('uv1', merged.attributes.uv);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, this._mat(b.key));
      // Skyline filler shadows fall on other skyline filler and are never in
      // frame, so the far batches stay out of the shadow pass entirely.
      mesh.castShadow = !b.far && !NO_CAST.has(PALETTE[b.key]?.batch || b.key);
      mesh.receiveShadow = true;
      mesh.userData.noCollide = true;   // collision is authored separately
      mesh.name = `block_${full}`;
      this.root.add(mesh);
    }
    this._batches.clear();
  }

  // --- collision authoring --------------------------------------------------

  /** Stage an oriented box collider. Visual meshes never feed the BVH. */
  _collideBox(x, y, z, w, h, d, ry = 0, surface = SURFACE.CONCRETE, rx = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.applyMatrix4(mat(x, y, z, ry, rx));
    const m = new THREE.Mesh(g);
    m.userData.surface = surface;
    m.updateMatrixWorld(true);
    this.physics.addMesh(m, surface);
    g.dispose();
  }

  /** Four wall slabs + roof, leaving a doorway gap on `openSide` if given. */
  _collideShell(x0, x1, z0, z1, h, openSide, doorAt) {
    const t = WALL_T + 0.1;
    const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
    const w = x1 - x0, d = z1 - z0;
    const sides = [
      { id: 'S', x: cx, z: z1 - t / 2, w, d: t, horiz: true },
      { id: 'N', x: cx, z: z0 + t / 2, w, d: t, horiz: true },
      { id: 'E', x: x1 - t / 2, z: cz, w: t, d, horiz: false },
      { id: 'W', x: x0 + t / 2, z: cz, w: t, d, horiz: false },
    ];
    for (const s of sides) {
      if (s.id === openSide) {
        // Split the wall either side of a 2.4 m doorway so the player can enter.
        const span = s.horiz ? w : d;
        const a = clamp((doorAt ?? 0) - (s.horiz ? cx : cz) + span / 2, 1.6, span - 1.6);
        const gap = 1.2;
        const segs = [[0, a - gap], [a + gap, span]];
        for (const [p0, p1] of segs) {
          if (p1 - p0 < 0.15) continue;
          const off = (p0 + p1) / 2 - span / 2, len = p1 - p0;
          if (s.horiz) this._collideBox(s.x + off, h / 2, s.z, len, h, s.d);
          else this._collideBox(s.x, h / 2, s.z + off, s.w, h, len);
        }
        // Lintel over the doorway keeps the opening head-height.
        if (s.horiz) this._collideBox(s.x + (a - span / 2), (h + 2.4) / 2, s.z, gap * 2, h - 2.4, s.d);
        else this._collideBox(s.x, (h + 2.4) / 2, s.z + (a - span / 2), s.w, h - 2.4, gap * 2);
      } else {
        this._collideBox(s.x, h / 2, s.z, s.w, h, s.d);
      }
    }
    this._collideBox(cx, h + 0.15, cz, w, 0.3, d);   // roof deck
  }

  // --- level-specific textures ----------------------------------------------

  /**
   * Pack a drawn canvas plus a height field into the same three-map set the
   * shared library publishes, so anything built from these maps lands in the
   * lit pipeline with a real normal and roughness rather than as smooth plastic.
   *
   * The canvas readback is flipped to v-up on the way in: CanvasTexture uploads
   * with flipY, DataTexture cannot, and a normal map a texel-row out of phase
   * with its albedo is worse than no normal map at all — so the albedo becomes
   * a DataTexture too and everything shares one orientation.
   */
  _localSet(name, canvas, height, rough, nrmStrength = 3.0) {
    const N = canvas.width;
    const src = canvas.getContext('2d').getImageData(0, 0, N, N).data;
    const aniso = this.textures.maxAniso ?? 1;
    const alb = new Uint8Array(N * N * 4);
    const orm = new Uint8Array(N * N * 4);
    const hv = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      const s = (N - 1 - y) * N, d = y * N;
      for (let x = 0; x < N; x++) {
        const si = (s + x) * 4, di = (d + x) * 4;
        alb[di] = src[si]; alb[di + 1] = src[si + 1];
        alb[di + 2] = src[si + 2]; alb[di + 3] = 255;
        hv[d + x] = height[s + x];
        orm[di] = 255;
        orm[di + 1] = clamp(rough[s + x], 0, 1) * 255;
        orm[di + 3] = 255;
      }
    }
    const set = {
      map: dataTex(alb, N, aniso, true),
      normalMap: normalTex(hv, N, nrmStrength, aniso),
      roughnessMap: dataTex(orm, N, aniso),
    };
    this._localTex.set(name, set);
    return set;
  }

  /**
   * Maps the shared library has no reason to carry: timber, awning canvas,
   * painted signage, tyre rubber, and — the one that matters most — the
   * bitumen-and-gravel roof deck. Every one publishes a normal and a roughness
   * map, not just an albedo.
   */
  _makeLocalTexture(name) {
    const N = 256;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const rnd = mulberry32(this.seed + name.length * 977);
    const H = new Float32Array(N * N);
    const R = new Float32Array(N * N);

    if (name === 'tarFelt') return this._tarFeltTexture(c, g, rnd, N, H, R);
    if (name === 'rubberTread') return this._rubberTexture(c, g, rnd, N, H, R);

    if (name === 'wood') {
      g.fillStyle = '#b08b5d';
      g.fillRect(0, 0, N, N);
      // Plank seams plus drifting grain lines; the low-frequency wobble is what
      // keeps it from reading as printed stripes.
      for (let y = 0; y < N; y++) {
        const grain = Math.sin(y * 0.35 + Math.sin(y * 0.07) * 5) * 0.5 + 0.5;
        g.fillStyle = `rgba(70,45,22,${0.06 + grain * 0.14})`;
        g.fillRect(0, y, N, 1);
      }
      for (let i = 0; i < 5; i++) {
        const y = Math.floor((i + 0.5) * N / 5);
        g.fillStyle = 'rgba(38,24,12,0.55)';
        g.fillRect(0, y, N, 2);
      }
      for (let i = 0; i < 240; i++) {
        g.fillStyle = `rgba(${60 + rnd() * 60 | 0},${40 + rnd() * 40 | 0},20,${rnd() * 0.25})`;
        g.fillRect(rnd() * N, rnd() * N, 1 + rnd() * 26, 1);
      }
      // Relief follows the grain, and the five plank seams cut right through it.
      {
        const tooth = fbmField(rnd, N, 32, 3);
        for (let y = 0; y < N; y++) {
          const grain = Math.sin(y * 0.35 + Math.sin(y * 0.07) * 5) * 0.5 + 0.5;
          const seam = Math.min(...[0, 1, 2, 3, 4].map(
            (k) => Math.abs(y - (k + 0.5) * N / 5))) < 2 ? 1 : 0;
          for (let x = 0; x < N; x++) {
            const i = y * N + x;
            H[i] = 0.62 - grain * 0.30 + tooth[i] * 0.18 - seam * 0.55;
            R[i] = 0.72 + grain * 0.16 + seam * 0.12;
          }
        }
      }
      return this._localSet(name, c, H, R, 2.2);
    } else if (name === 'cloth') {
      // Woven canvas. The eight stripe bands are what the market awnings read
      // as; the weave under them is what stops a hanging sheet looking like an
      // unassigned UV-test checker, which is exactly how the alley laundry read.
      const bands = 8;
      for (let i = 0; i < bands; i++) {
        g.fillStyle = i % 2 ? '#efe6d4' : '#cfc7b5';
        g.fillRect(i * N / bands, 0, N / bands, N);
      }
      const img = g.getImageData(0, 0, N, N);
      const px = img.data;
      const soil = fbmField(rnd, N, 6, 3);
      const T = 6;                                   // threads per repeat cell
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = y * N + x;
          // Plain weave: warp over weft on alternating cells, each thread a
          // rounded ridge, so the normal map gets a real fabric tooth.
          const cxk = Math.floor(x / T), cyk = Math.floor(y / T);
          const warpOver = ((cxk + cyk) & 1) === 0;
          const tx = Math.sin(((x % T) + 0.5) / T * Math.PI);
          const ty = Math.sin(((y % T) + 0.5) / T * Math.PI);
          const h = warpOver ? 0.42 + 0.58 * tx : 0.30 * ty;
          const shade = 0.80 + 0.30 * h - soil[i] * 0.16;
          const k = i * 4;
          px[k] *= shade; px[k + 1] *= shade * 0.995; px[k + 2] *= shade * 0.97;
          H[i] = h * 0.7 + soil[i] * 0.3;
          R[i] = 0.90 + 0.09 * (1 - h);
        }
      }
      g.putImageData(img, 0, 0);
      // Hem seams and a few worn creases across the bolt.
      g.fillStyle = 'rgba(120,105,80,0.20)';
      for (let i = 0; i < 26; i++) g.fillRect(0, rnd() * N, N, 1 + rnd() * 2);
      return this._localSet(name, c, H, R, 1.4);
    } else if (name === 'sign') {
      // Four painted shop plates in one atlas: flat colour fields with a
      // hand-lettered feel from stroked blocks. No text, no fonts, no downloads.
      const plates = ['#1d4f63', '#7a2a22', '#25502c', '#a06a1a'];
      for (let p = 0; p < 4; p++) {
        const ox = (p % 2) * (N / 2), oy = ((p / 2) | 0) * (N / 2), s = N / 2;
        g.fillStyle = plates[p];
        g.fillRect(ox, oy, s, s);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(ox, oy, s, 6); g.fillRect(ox, oy + s - 6, s, 6);
        g.fillStyle = '#e8dfc8';
        let x = ox + 12;
        while (x < ox + s - 16) {
          const w = 5 + rnd() * 16, h = 6 + rnd() * 10;
          g.fillRect(x, oy + s * 0.42 - h * 0.5, w, h);
          if (rnd() < 0.4) g.fillRect(x, oy + s * 0.42 + h * 0.6, w * 0.7, 4);
          x += w + 5 + rnd() * 6;
        }
        g.fillStyle = 'rgba(0,0,0,0.25)';
        for (let i = 0; i < 60; i++) g.fillRect(ox + rnd() * s, oy + rnd() * s, rnd() * 12, rnd() * 3);
      }
      // Painted plate: the lettering stands a little proud, the rest is
      // weathered sheet with a peeling-paint roughness break-up.
      {
        const img = g.getImageData(0, 0, N, N).data;
        const wear = fbmField(rnd, N, 10, 3);
        for (let i = 0; i < N * N; i++) {
          const lum = (img[i * 4] + img[i * 4 + 1] + img[i * 4 + 2]) / 765;
          H[i] = lum * 0.5 + wear[i] * 0.5;
          R[i] = 0.44 + wear[i] * 0.46;
        }
      }
      return this._localSet(name, c, H, R, 1.2);
    }
    return null;
  }

  /**
   * Bitumen roof deck: felt rolls with lapped seams, a scatter of chippings,
   * silver-coat repair patches and the standing water that never drains off a
   * flat roof. This is the map the `skyline` pose spends a third of its frame
   * looking at, and the reason it used to measure as pure sensor grain.
   */
  _tarFeltTexture(c, g, rnd, N, H, R) {
    const macro = fbmField(rnd, N, 3, 3);          // weathering and old repairs
    const patch = fbmField(rnd, N, 5, 2);          // silver-coat patches
    const pond = fbmField(rnd, N, 4, 2);           // where water stands
    const chip = fbmField(rnd, N, 40, 3, 0.55);    // gravel dressing
    const micro = fbmField(rnd, N, 110, 2);        // felt tooth
    const img = g.createImageData(N, N);
    const px = img.data;
    // Roll laps at two per tile. Kept faint on purpose — the strong seams are
    // modelled, and a texture grid on top of a geometry grid is what turns a
    // tar roof into a floor of paving slabs.
    const lapY = (y) => {
      const t = Math.abs(((y / N) * 2 % 1) - 0.02);
      return Math.exp(-t * t * 320);
    };
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const seam = lapY(y);
        const wet = smoothstep(0.50, 0.84, pond[i]);
        const sil = smoothstep(0.58, 0.71, patch[i]);
        const grit = smoothstep(0.30, 0.82, chip[i]);
        // Bitumen base, gravel lifting it, ponding sinking it, repair patches
        // pulling it grey. Four separate scales, which is the whole point: a
        // surface whose autocorrelation keeps climbing with pixel lag instead
        // of flattening into sensor grain at lag two.
        let v = 0.28 + macro[i] * 0.20 + grit * 0.34 + micro[i] * 0.12;
        v = lerp(v, 0.44, sil);
        v *= 1 - wet * 0.42;
        v *= 1 - seam * 0.12;
        const k = i * 4;
        px[k] = clamp(v * 1.0, 0, 1) * 255;
        px[k + 1] = clamp(v * 0.995, 0, 1) * 255;
        px[k + 2] = clamp(v * 0.98, 0, 1) * 255;
        px[k + 3] = 255;
        H[i] = grit * 0.55 + micro[i] * 0.22 + macro[i] * 0.12 + seam * 0.22 - wet * 0.3;
        // Dry chippings are matte; standing water and fresh bitumen are not.
        R[i] = clamp(0.94 + grit * 0.06 - wet * 0.58 - sil * 0.10, 0.10, 1);
      }
    }
    g.putImageData(img, 0, 0);
    // Blistering and torn edges around the repair patches.
    for (let i = 0; i < 260; i++) {
      const x = rnd() * N, y = rnd() * N, r = 1 + rnd() * 3;
      g.fillStyle = `rgba(20,17,13,${0.12 + rnd() * 0.2})`;
      g.fillRect(x, y, r, r);
    }
    return this._localSet('tarFelt', c, H, R, 1.9);
  }

  /** Tyre rubber: circumferential ribs, sidewall lettering relief, matte. */
  _rubberTexture(c, g, rnd, N, H, R) {
    const grain = fbmField(rnd, N, 26, 3);
    const img = g.createImageData(N, N);
    const px = img.data;
    for (let y = 0; y < N; y++) {
      const rib = Math.abs(((y / N) * 9 % 1) - 0.5) < 0.28 ? 1 : 0.55;
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const v = (0.42 + grain[i] * 0.28) * rib;
        const k = i * 4;
        px[k] = v * 255; px[k + 1] = v * 250; px[k + 2] = v * 246; px[k + 3] = 255;
        H[i] = rib * 0.6 + grain[i] * 0.4;
        R[i] = 0.80 + grain[i] * 0.18;
      }
    }
    g.putImageData(img, 0, 0);
    return this._localSet('rubberTread', c, H, R, 2.0);
  }

  // --- ground ---------------------------------------------------------------

  /** Shortest distance from (x,z) to any building footprint; 0 when inside. */
  _wallDistance(x, z) {
    let best = 1e9;
    for (const f of this._footprints) {
      const dx = Math.max(f.x0 - x, 0, x - f.x1);
      const dz = Math.max(f.z0 - z, 0, z - f.z1);
      const d = Math.hypot(dx, dz);
      if (d < best) best = d;
      if (best <= 0) break;
    }
    return best;
  }

  /** True inside the paved boulevard or the plaza square. */
  _pavedMask(x, z) {
    const street = 1 - smoothstep(ROAD_HALF - 0.4, ROAD_HALF + 0.9, Math.abs(z));
    const plazaX = 1 - smoothstep(PLAZA - 2.0, PLAZA + 1.5, Math.abs(x));
    const plazaZ = 1 - smoothstep(PLAZA - 2.0, PLAZA + 1.5, Math.abs(z));
    return clamp(Math.max(street, plazaX * plazaZ), 0, 1);
  }

  /**
   * Ground height. Deliberately shallow — a CoD street is flat enough to
   * strafe across, so the relief is all read: a crowned carriageway, gutters
   * that drain to the kerb, shell craters, and sand piled against every wall.
   */
  _groundY(x, z) {
    const n = this.noise;
    let y = fbm2(n, x * 0.028, z * 0.028, 3) * 0.13 + fbm2(n, x * 0.19, z * 0.19, 2) * 0.035;
    const paved = this._pavedMask(x, z);
    const az = Math.abs(z);
    if (az < ROAD_HALF + 1.4 && Math.abs(x) > PLAZA - 2) {
      const t = clamp(az / ROAD_HALF, 0, 1);
      y += paved * (0.075 * (1 - t * t));                 // camber
      y -= paved * 0.075 * smoothstep(0.72, 1.0, t);      // gutter channel
    }
    for (const p of this._craters) {
      const d = Math.hypot(x - p[0], z - p[1]);
      if (d < p[2]) {
        const k = 1 - d / p[2];
        y -= p[3] * k * k * (1.4 - k);                    // dished, lipped rim
        y += p[3] * 0.28 * smoothstep(0.55, 0.95, d / p[2]);
      }
    }
    // Sand drift banks up against anything vertical.
    const dw = this._wallDistance(x, z);
    y += 0.34 * Math.exp(-dw * 0.62) * (0.5 + 0.5 * fbm2(n, x * 0.09, z * 0.09, 2));
    return y;
  }

  /** Per-vertex splat weights: [asphalt, sand, dirt]. */
  _splatAt(x, z) {
    const n = this.noise;
    const paved = this._pavedMask(x, z);
    const dw = this._wallDistance(x, z);
    const blow = clamp(fbm2(n, x * 0.055, z * 0.055, 3) * 1.5 + 0.45, 0, 1);
    // Sand wins near walls, in the lee of the block, and wherever the wind
    // noise says so; the road only survives where traffic kept it swept.
    const sand = clamp(Math.max(Math.exp(-dw * 0.30) * 1.15, blow * (1 - paved * 0.75)), 0, 1);
    const asphalt = clamp(paved * (1 - sand * 0.72), 0, 1);
    const dirt = clamp(1 - asphalt - sand * 0.8, 0.05, 1);
    return [asphalt, sand, dirt];
  }

  /**
   * Ground material. Three procedural sets blended by a per-vertex splat
   * attribute in world space at three different tiling rates, plus a very low
   * frequency modulation on top — between them there is no visible repeat.
   */
  _groundMaterial() {
    const road = this._texSet('asphalt');
    const sand = this._texSet('sand');
    const dirt = this._texSet('concrete');
    const m = new THREE.MeshStandardMaterial({
      map: road.map, normalMap: road.normalMap,
      color: 0xffffff, roughness: 1, metalness: 0, vertexColors: true,
    });
    m.normalScale.set(0.7, 0.7);
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uSandMap = { value: sand.map };
      sh.uniforms.uSandNrm = { value: sand.normalMap };
      sh.uniforms.uDirtMap = { value: dirt.map };
      sh.uniforms.uDirtNrm = { value: dirt.normalMap };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute vec3 splat;\nvarying vec3 vSplatW;\nvarying vec2 vSplatUV;')
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n'
          + 'vSplatW = splat / max(1e-4, splat.x + splat.y + splat.z);\n'
          + 'vSplatUV = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>',
          '#include <common>\nvarying vec3 vSplatW;\nvarying vec2 vSplatUV;\n'
          + 'uniform sampler2D uSandMap; uniform sampler2D uSandNrm;\n'
          + 'uniform sampler2D uDirtMap; uniform sampler2D uDirtNrm;')
        .replace('vec4 sampledDiffuseColor = texture2D( map, vMapUv );',
          // The library's asphalt is almost black, so it has to be lifted. The
          // pedestal in that lift is pure dilution: everything above it is the
          // signal. Dropping it from 0.30 to 0.06 and paying for the lost mean
          // with gain widens the readable range instead of shifting it, which
          // is where the road's 3.6% RMS contrast was going.
          'vec3 aTex = texture2D(map, vSplatUV*0.34).rgb;\n'
          // Second scale on the same map: chip-seal aggregate at ~2 tiles/m, the
          // frequency that makes autocorrelation keep climbing with pixel lag.
          + 'float aggr = texture2D(map, vSplatUV*3.20).g;\n'
          + 'vec3 cRoad = vec3(0.235,0.233,0.245) * (0.06 + 11.0 * aTex) * (0.74 + 0.55 * aggr);\n'
          + 'vec3 cSand = vec3(1.05,0.94,0.72) * texture2D(uSandMap, vSplatUV*0.21).rgb;\n'
          + 'vec3 cDirt = vec3(0.86,0.74,0.55) * texture2D(uDirtMap, vSplatUV*0.13).rgb;\n'
          + 'vec3 splatC = cRoad*vSplatW.x + cSand*vSplatW.y + cDirt*vSplatW.z;\n'
          + 'splatC *= 0.78 + 0.46 * texture2D(uDirtMap, vSplatUV*0.0125).r;\n'
          + 'vec4 sampledDiffuseColor = vec4(splatC, 1.0);')
        .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
          'vec3 mapN = ( texture2D(normalMap, vSplatUV*0.34).xyz * vSplatW.x\n'
          + '            + texture2D(uSandNrm, vSplatUV*0.21).xyz * vSplatW.y\n'
          + '            + texture2D(uDirtNrm, vSplatUV*0.13).xyz * vSplatW.z ) * 2.0 - 1.0;\n'
          // Aggregate-scale relief on the tarmac only; sand and dirt already
          // carry their own at a readable size.
          + 'mapN.xy += (texture2D(normalMap, vSplatUV*3.1).xy * 2.0 - 1.0) * 0.65 * vSplatW.x;');
      sh.fragmentShader = sh.fragmentShader.replace('float roughnessFactor = roughness;',
        'float roughnessFactor = roughness * (0.66*vSplatW.x + 0.98*vSplatW.y + 0.93*vSplatW.z);\n'
        // Asphalt is read almost entirely off its gloss: a high-frequency
        // detail tile at ~8 tiles/m for the aggregate itself, and a very slow
        // one for the dry-versus-damp patches that give tarmac its scale.
        + 'float micro = texture2D(map, vSplatUV*8.0).r;\n'
        + 'float damp = texture2D(uDirtMap, vSplatUV*0.045).r;\n'
        + 'roughnessFactor *= mix(1.0, mix(0.48, 1.12, damp), vSplatW.x) * (0.84 + 0.34 * micro);\n'
        + 'roughnessFactor = clamp(roughnessFactor, 0.06, 1.0);');
    };
    m.customProgramCacheKey = () => 'levelGroundSplat';
    return m;
  }

  _buildGround() {
    // Shell craters, authored rather than random so none of them lands where a
    // camera pose or a market stall needs flat ground.
    this._craters = [
      [-38, 2.5, 5.2, 0.55], [26, -3.0, 4.4, 0.42], [4, 16, 6.0, 0.5],
      [58, 4, 4.8, 0.45], [-64, -3, 5.5, 0.5], [-12, -16, 4.0, 0.35],
    ];

    // Non-uniform grid: |t|^1.85 concentrates resolution on the playable core
    // and lets the outer ring stretch away cheaply toward the fog.
    const NX = 120, NZ = 92;
    const warp = (t, half) => Math.sign(t) * Math.pow(Math.abs(t), 1.85) * half;
    const pos = new Float32Array((NX + 1) * (NZ + 1) * 3);
    const uv = new Float32Array((NX + 1) * (NZ + 1) * 2);
    const splat = new Float32Array((NX + 1) * (NZ + 1) * 3);
    const col = new Float32Array((NX + 1) * (NZ + 1) * 3);
    const n = this.noise;
    let k = 0;
    for (let j = 0; j <= NZ; j++) {
      const z = warp((j / NZ) * 2 - 1, MAP_Z);
      for (let i = 0; i <= NX; i++, k++) {
        const x = warp((i / NX) * 2 - 1, MAP_X);
        const y = this._groundY(x, z);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = x * 0.34; uv[k * 2 + 1] = z * 0.34;
        const s = this._splatAt(x, z);
        splat[k * 3] = s[0]; splat[k * 3 + 1] = s[1]; splat[k * 3 + 2] = s[2];
        // Tyre tracks, oil staining and a soft occlusion gradient into corners.
        const track = smoothstep(0.55, 0.0, Math.abs(Math.abs(z) - 3.1)) * s[0];
        const stain = clamp(fbm2(n, x * 0.42, z * 0.42, 2) * 0.5 + 0.5, 0, 1);
        const occl = lerp(0.55, 1.0, smoothstep(0.0, 5.0, this._wallDistance(x, z)));
        const v = occl * (0.86 + stain * 0.24) * (1 - track * 0.28);
        col[k * 3] = v; col[k * 3 + 1] = v * 0.995; col[k * 3 + 2] = v * 0.97;
      }
    }
    const idx = new Uint32Array(NX * NZ * 6);
    let t = 0;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('splat', new THREE.BufferAttribute(splat, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    const ground = new THREE.Mesh(geo, this._groundMaterial());
    ground.receiveShadow = true;
    ground.userData.noCollide = true;
    ground.name = 'ground';
    this.root.add(ground);

    // Collision runs on a much coarser sample of the same height field: the
    // player cannot feel a 4 cm difference but the BVH feels 8× the triangles.
    const cg = new THREE.PlaneGeometry(MAP_X * 2, MAP_Z * 2, 60, 44);
    cg.rotateX(-Math.PI / 2);
    const cp = cg.attributes.position;
    for (let i = 0; i < cp.count; i++) cp.setY(i, this._groundY(cp.getX(i), cp.getZ(i)));
    const cm = new THREE.Mesh(cg);
    cm.userData.surface = SURFACE.DIRT;
    cm.updateMatrixWorld(true);
    this.physics.addMesh(cm, SURFACE.DIRT);
    cg.dispose();
  }

  // --- pavement, kerbs and drainage -----------------------------------------

  /**
   * Pavements are authored as explicit runs rather than derived from the road,
   * so alley mouths and plaza corners get real gaps instead of a continuous
   * ribbon. Each run contributes a slab, a darker kerb stone along its road
   * edge and, at intervals, a gully grating.
   */
  _buildPavement() {
    const R = ROAD_HALF, W = WALK_W;
    const runs = [
      // boulevard, north side (lit row) — split at the alleys
      { x0: -100, x1: -62.4, z0: -R - W, z1: -R },
      { x0: -58.2, x1: -34.6, z0: -R - W, z1: -R },
      { x0: -34.4, x1: -21, z0: -R - W, z1: -R },
      { x0: 21, x1: 40.2, z0: -R - W, z1: -R },
      { x0: 44.2, x1: 100, z0: -R - W, z1: -R },
      // boulevard, south side
      { x0: -100, x1: -56.2, z0: R, z1: R + W },
      { x0: -52.2, x1: -21, z0: R, z1: R + W },
      { x0: 21, x1: 44.2, z0: R, z1: R + W },
      { x0: 48.2, x1: 100, z0: R, z1: R + W },
      // plaza perimeter: north and south frontages, then the east/west kerbs
      { x0: -21, x1: 21, z0: -PLAZA - 0.2, z1: -PLAZA + W },
      { x0: -21, x1: 21, z0: PLAZA - W, z1: PLAZA + 0.2 },
      { x0: -PLAZA - 0.2, x1: -PLAZA + W, z0: -PLAZA, z1: -R - 0.6 },
      { x0: -PLAZA - 0.2, x1: -PLAZA + W, z0: R + 0.6, z1: PLAZA },
      { x0: PLAZA - W, x1: PLAZA + 0.2, z0: -PLAZA, z1: -R - 0.6 },
      { x0: PLAZA - W, x1: PLAZA + 0.2, z0: R + 0.6, z1: PLAZA },
    ];
    for (const r of runs) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const base = this._groundY(cx, cz);
      // Slab sits proud of the road; its side face is the visible kerb rise.
      this._box('concrete', w, 0.34, d, cx, base + WALK_H - 0.17, cz, null, null, 0.55);
      this._collideBox(cx, base + WALK_H - 0.17, cz, w, 0.34, d, 0, SURFACE.CONCRETE);

      // Kerb stone: a darker, slightly proud edge along the carriageway side.
      const alongX = w > d;
      const kerbSide = alongX ? (cz < 0 ? r.z1 : r.z0) : (cx < 0 ? r.x1 : r.x0);
      const kw = alongX ? w : 0.26, kd = alongX ? 0.26 : d;
      const kx = alongX ? cx : kerbSide + (cx < 0 ? -0.13 : 0.13);
      const kz = alongX ? kerbSide + (cz < 0 ? -0.13 : 0.13) : cz;
      this._box('concreteDark', kw, 0.4, kd, kx, base + WALK_H - 0.19, kz, null, null, 0.6);

      // Gully gratings every ~12 m along the gutter.
      const span = alongX ? w : d;
      for (let s = 6; s < span - 4; s += 12 + this.rnd() * 6) {
        const gx = alongX ? r.x0 + s : kx + (cx < 0 ? -0.42 : 0.42);
        const gz = alongX ? kz + (cz < 0 ? -0.42 : 0.42) : r.z0 + s;
        this._box('concreteDark', 0.72, 0.1, 0.46, gx, this._groundY(gx, gz) - 0.04, gz, null, null, 1.4);
        for (let b = 0; b < 5; b++) {
          this._box('dark', 0.6, 0.06, 0.035, gx, this._groundY(gx, gz) + 0.02, gz - 0.16 + b * 0.08);
        }
      }
    }
  }

  // --- block layout ---------------------------------------------------------

  /**
   * The block, authored by hand. Runs of terraced buildings with deliberate
   * gaps for alleys, the plaza frontages pulled back to |z| = 24, and a back
   * row plus a far row that exist purely to fill the skyline behind the
   * playable street.
   *
   * `face` picks the vocabulary each elevation is built with:
   *   street — shopfronts, awnings, signage, balconies, string courses
   *   alley  — small barred windows, soil pipes, AC units
   *   plain  — sparse openings, party-wall blankness
   *   none   — solid (shared party wall against the neighbour)
   */
  _layout() {
    const N = (o) => ({ front: 'S', ...o });   // north row faces +Z (into the sun)
    const S = (o) => ({ front: 'N', ...o });   // south row faces -Z (in shade)
    return [
      // ---- north row, west of the plaza
      N({ x0: -86, x1: -62.4, z0: -34, z1: -11, floors: 3, mat: 'plasterA', face: { S: 'street', E: 'alley', W: 'plain', N: 'plain' } }),
      N({ x0: -58.2, x1: -38, z0: -38, z1: -11, floors: 4, mat: 'brick', stair: 'E', roofAccess: true,
          face: { S: 'street', E: 'alley', W: 'alley', N: 'plain' } }),
      N({ x0: -34.4, x1: -21, z0: -31, z1: -11, floors: 3, mat: 'plasterB', hollow: true,
          face: { S: 'street', E: 'plain', W: 'alley', N: 'plain' } }),
      // ---- plaza frontage, north
      N({ x0: -20, x1: -3, z0: -44, z1: -24, floors: 4, mat: 'plasterC',
          breach: { side: 'S', x0: -12.5, x1: -4.5, fromFloor: 1 },
          face: { S: 'street', E: 'street', W: 'plain', N: 'plain' } }),
      N({ x0: 3, x1: 20, z0: -42, z1: -24, floors: 3, mat: 'plasterD', balconies: true,
          face: { S: 'street', W: 'street', E: 'plain', N: 'plain' } }),
      // ---- north row, east of the plaza
      N({ x0: 21, x1: 40.2, z0: -32, z1: -11, floors: 3, mat: 'plasterB', face: { S: 'street', W: 'street', E: 'alley', N: 'plain' } }),
      N({ x0: 44.2, x1: 66, z0: -36, z1: -11, floors: 4, mat: 'plasterA', face: { S: 'street', W: 'alley', E: 'plain', N: 'plain' } }),
      // ---- south row, west of the plaza
      S({ x0: -84, x1: -56.2, z0: 11, z1: 36, floors: 4, mat: 'plasterC', face: { N: 'street', E: 'alley', W: 'plain', S: 'plain' } }),
      S({ x0: -52.2, x1: -32, z0: 11, z1: 32, floors: 3, mat: 'plasterA', hollow: true, interiorLight: true,
          face: { N: 'street', W: 'alley', E: 'blank', S: 'plain' } }),
      S({ x0: -32, x1: -21, z0: 11, z1: 27, floors: 2, mat: 'brick', face: { N: 'street', E: 'street', W: 'blank', S: 'plain' } }),
      // ---- plaza frontage, south
      S({ x0: -20, x1: -1, z0: 24, z1: 43, floors: 3, mat: 'plasterB', face: { N: 'street', E: 'street', W: 'plain', S: 'plain' } }),
      S({ x0: 3, x1: 20, z0: 24, z1: 46, floors: 4, mat: 'plasterD', balconies: true,
          face: { N: 'street', W: 'street', E: 'plain', S: 'plain' } }),
      // ---- south row, east of the plaza
      S({ x0: 21, x1: 44.2, z0: 11, z1: 33, floors: 3, mat: 'plasterA', face: { N: 'street', W: 'street', E: 'alley', S: 'plain' } }),
      S({ x0: 48.2, x1: 72, z0: 11, z1: 38, floors: 5, mat: 'brick', face: { N: 'street', W: 'alley', E: 'plain', S: 'plain' } }),
      // ---- back rows: skyline filler, cheap elevations only
      N({ x0: -74, x1: -42, z0: -66, z1: -46, floors: 5, mat: 'plasterC', simple: true, face: { S: 'plain', E: 'blank', W: 'blank', N: 'none' } }),
      N({ x0: -30, x1: 4, z0: -70, z1: -50, floors: 4, mat: 'plasterE', simple: true, face: { S: 'plain', E: 'blank', W: 'blank', N: 'none' } }),
      N({ x0: 12, x1: 48, z0: -68, z1: -48, floors: 6, mat: 'brick', simple: true, face: { S: 'plain', E: 'blank', W: 'blank', N: 'none' } }),
      S({ x0: -66, x1: -30, z0: 48, z1: 68, floors: 4, mat: 'plasterA', simple: true, face: { N: 'plain', E: 'blank', W: 'blank', S: 'none' } }),
      S({ x0: 16, x1: 52, z0: 50, z1: 72, floors: 5, mat: 'plasterC', simple: true, face: { N: 'plain', E: 'blank', W: 'blank', S: 'none' } }),
      // ---- far blocks flanking the vista, off the boulevard axis
      N({ x0: 78, x1: 104, z0: -44, z1: -16, floors: 6, mat: 'plasterB', simple: true, face: { S: 'plain', W: 'plain', E: 'blank', N: 'blank' } }),
      S({ x0: 82, x1: 106, z0: 16, z1: 46, floors: 5, mat: 'plasterD', simple: true, face: { N: 'plain', W: 'plain', E: 'blank', S: 'blank' } }),
      N({ x0: -104, x1: -88, z0: -46, z1: -18, floors: 5, mat: 'plasterE', simple: true, face: { S: 'plain', E: 'plain', W: 'blank', N: 'blank' } }),
      S({ x0: -102, x1: -86, z0: 16, z1: 44, floors: 4, mat: 'brick', simple: true, face: { N: 'plain', E: 'plain', W: 'blank', S: 'blank' } }),
      // ---- the boulevard is terminated at both ends by a collapsed block, so
      //      the vista dies in rubble and haze rather than at the map edge.
      //      These two close the `closeup` and `goldenHour` vistas, so they are
      //      the one place in the level where detail is spent on a building
      //      nobody can walk to: `simple` is deliberately off, and the shelled
      //      top storey gives the frame a broken roofline to end on.
      N({ x0: 94, x1: 112, z0: -14, z1: 12, floors: 4, mat: 'plasterE', ruin: true,
          face: { W: 'street', S: 'plain', E: 'blank', N: 'plain' } }),
      S({ x0: -112, x1: -94, z0: -12, z1: 14, floors: 4, mat: 'brick', ruin: true,
          face: { E: 'street', N: 'plain', W: 'blank', S: 'plain' } }),
      // Blocks set back behind each terminator so the vista has depth rather
      // than dying on a single plane.
      N({ x0: 74, x1: 100, z0: -78, z1: -56, floors: 7, mat: 'plasterC', simple: true, face: { S: 'plain', W: 'plain', E: 'blank', N: 'none' } }),
      S({ x0: -100, x1: -72, z0: 56, z1: 78, floors: 6, mat: 'plasterB', simple: true, face: { N: 'plain', E: 'plain', W: 'blank', S: 'none' } }),
    ];
  }

  // --- modular building kit -------------------------------------------------

  static floorBase(f) { return f === 0 ? 0 : GROUND_H + (f - 1) * FLOOR_H; }
  static floorHeight(f) { return f === 0 ? GROUND_H : FLOOR_H; }

  _building(spec) {
    const rnd = mulberry32(this.seed + Math.round(spec.x0 * 31 + spec.z0 * 7) + 4096);
    const w = spec.x1 - spec.x0, d = spec.z1 - spec.z0;
    const cx = (spec.x0 + spec.x1) / 2, cz = (spec.z0 + spec.z1) / 2;
    const H = Level.floorBase(spec.floors);
    const base = this._groundY(cx, cz) - 0.25;   // buried slightly so no gap shows
    spec._H = H; spec._cx = cx; spec._cz = cz; spec._w = w; spec._d = d; spec._base = base;

    const sides = {
      S: { pw: w, m: mat(cx, base, cz + d / 2, 0) },
      N: { pw: w, m: mat(cx, base, cz - d / 2, Math.PI) },
      E: { pw: d, m: mat(cx + w / 2, base, cz, Math.PI / 2) },
      W: { pw: d, m: mat(cx - w / 2, base, cz, -Math.PI / 2) },
    };

    for (const id of ['S', 'N', 'E', 'W']) {
      const kind = spec.face?.[id] || 'plain';
      if (kind === 'none') continue;
      const s = sides[id];
      // A blank return wall is one box instead of the several hundred a
      // fenestrated elevation costs. Party walls and the flanks of the skyline
      // filler blocks are never seen closely enough to be worth more.
      if (kind === 'blank') {
        this._box(spec.mat, s.pw, H, WALL_T, 0, H / 2, -WALL_T / 2, s.m);
        continue;
      }
      let breach = null;
      if (spec.breach && spec.breach.side === id) {
        const b = spec.breach;
        const y = Level.floorBase(b.fromFloor);
        // Panel coordinates run 0..pw from the left edge as seen from outside.
        const p0 = id === 'S' ? b.x0 - spec.x0 : id === 'N' ? spec.x1 - b.x1
          : id === 'E' ? spec.z1 - b.x1 : b.x0 - spec.z0;
        breach = { x: p0, y, w: b.x1 - b.x0, h: H - y + 1.4 };
      }
      this._facade({ spec, id, kind, pw: s.pw, m: s.m, H, rnd, breach });
    }

    // Corner pilasters: they proud the corners by 0.1 on both faces, which is
    // what stops a rectangular mass reading as a single flat extrusion. The
    // filler blocks get a slimmer version — four boxes each, and they are the
    // difference between a skyline of buildings and a skyline of boxes.
    const pil = spec.simple ? 0.5 : 0.62;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this._box(spec.mat, pil, H + 0.05, pil,
          cx + sx * (w / 2 - pil / 3), base + H / 2, cz + sz * (d / 2 - pil / 3), null, null, 0.42);
      }
    }
    if (spec.simple) {
      // Plinth: one box, and the mass stops floating on the ground plane.
      this._box('concreteDark', w + 0.34, 0.9, d + 0.34, cx, base + 0.45, cz, null, null, 0.55);
    }

    // Opaque core so windows read as black voids instead of see-through holes.
    const fillY = spec.hollow ? GROUND_H : 0;
    const bz = spec.breach ? 3.2 : 0;
    this._box('dark', w - WALL_T * 2 - 0.04, Math.max(0.2, H - fillY), d - WALL_T * 2 - 0.04 - bz,
      cx, base + fillY + (H - fillY) / 2,
      cz + (spec.breach?.side === 'S' ? -bz / 2 : spec.breach?.side === 'N' ? bz / 2 : 0), null, null, 0.2);

    // Roof deck, cornice and parapet. The deck is bitumen felt with its own
    // map, not the generic dark concrete it used to borrow — in the `skyline`
    // pose this surface is a third of the frame.
    this._box('roof', w + 0.1, 0.3, d + 0.1, cx, base + H - 0.15, cz, null, null, 0.52);
    if (!spec.simple) {
      this._box('concrete', w + 0.7, 0.3, d + 0.7, cx, base + H - 0.3, cz, null, null, 0.5);
    }
    this._parapet(spec, rnd);
    this._roofSurface(spec, rnd);
    if (spec.simple) this._roofDressingLite(spec, rnd);
    else this._roofDressing(spec, rnd);
    if (spec.ruin) this._ruinTop(spec, rnd);
    if (spec.stair) this._exteriorStair(spec, rnd);
    if (spec.breach) this._breachDebris(spec, rnd);

    // Collision: one shell, not the several hundred boxes the art is made of.
    if (spec.hollow) {
      // Line the gap up with the doorway the facade generator actually placed.
      const dx = spec._doorPanelX ?? w / 2;
      this._collideShell(spec.x0, spec.x1, spec.z0, spec.z1, H, spec.front,
        spec.front === 'N' ? spec.x1 - dx : spec.x0 + dx);
    } else {
      this._collideBox(cx, base + H / 2, cz, w, H, d, 0, SURFACE.CONCRETE);
    }
  }

  /**
   * One elevation. Bays are laid out on a fixed grid so window heads and sills
   * line up across the whole facade the way a real building's do; the vocabulary
   * of what fills each bay is what `kind` selects.
   */
  _facade({ spec, id, kind, pw, m, H, rnd, breach }) {
    const key = spec.mat;
    const nb = Math.max(1, Math.round(pw / 3.15));
    const bw = pw / nb;
    const openings = [];
    const detail = [];        // deferred: sills/lintels/frames need the hole first
    const isFront = id === spec.front;
    const street = kind === 'street';
    const alley = kind === 'alley';
    const enterable = spec.hollow && isFront;
    const doorBay = street && !spec.simple ? (rnd() * nb) | 0 : -1;

    for (let f = 0; f < spec.floors; f++) {
      const y0 = Level.floorBase(f);
      for (let b = 0; b < nb; b++) {
        const bx = b * bw;
        const r = rnd();
        if (f === 0) {
          if (street && b === doorBay) {
            // An enterable building gets a wide opening, and records where it
            // ended up so the collision shell can punch its gap in the same place.
            const ow = enterable ? 2.2 : 1.25, oh = enterable ? 2.7 : 2.4;
            const ox = bx + (bw - ow) / 2;
            openings.push({ x: ox, y: 0.02, w: ow, h: oh });
            detail.push({ t: 'door', x: ox, y: 0.02, w: ow, h: oh });
            if (enterable) spec._doorPanelX = ox + ow / 2;
          } else if (street && r < 0.72) {
            const ow = bw - 1.0, oh = 2.55, ox = bx + 0.5;
            openings.push({ x: ox, y: 0.42, w: ow, h: oh });
            detail.push({ t: 'shop', x: ox, y: 0.42, w: ow, h: oh, bw });
          } else if (alley && r < 0.3) {
            const ow = 1.05, oh = 2.15, ox = bx + (bw - ow) / 2;
            openings.push({ x: ox, y: 0.02, w: ow, h: oh });
            detail.push({ t: 'steel', x: ox, y: 0.02, w: ow, h: oh });
          } else if (spec.simple && r < 0.62) {
            // The filler blocks need a ground floor too, or every distant
            // building reads as a solid plinth with windows floating above it.
            const ow = 1.25, oh = 2.0, ox = bx + (bw - ow) / 2;
            openings.push({ x: ox, y: 1.0, w: ow, h: oh });
            detail.push({ t: 'window', x: ox, y: 1.0, w: ow, h: oh, bw });
          }
        } else {
          const balcony = street && spec.balconies && r < 0.42;
          const ow = balcony ? 1.05 : alley ? 0.95 : 1.35;
          const oh = balcony ? 2.15 : alley ? 1.15 : 1.62;
          const oy = y0 + (balcony ? 0.12 : 1.02);
          const chance = alley ? 0.62 : spec.simple ? 0.68 : 0.84;
          if (r < chance || balcony) {
            const ox = bx + (bw - ow) / 2;
            openings.push({ x: ox, y: oy, w: ow, h: oh });
            detail.push({ t: balcony ? 'balcony' : 'window', x: ox, y: oy, w: ow, h: oh, bw });
          }
        }
      }
      // String course between storeys: a band proud of the face by 12 cm, which
      // costs one box per floor and buys a hard horizontal shadow line.
      if (street && f > 0) this._box('concrete', pw, 0.22, 0.46, 0, y0 - 0.11, -0.11, m, null, 0.6);
      // Even the filler gets a band every other floor; at skyline range one
      // horizontal per storey is most of what separates a building from a slab.
      else if (spec.simple && f > 0 && f % 2 === 1) {
        this._box('concreteDark', pw, 0.16, 0.28, 0, y0 - 0.08, -0.05, m, null, 0.7);
      }
    }
    if (breach) openings.push(breach);

    // Solid wall left once the holes are punched.
    for (const s of wallSolids(pw, H, openings)) {
      this._box(key, s.w, s.h, WALL_T, s.x + s.w / 2 - pw / 2, s.y + s.h / 2, -WALL_T / 2, m);
    }

    for (const o of detail) this._opening(spec, key, o, m, rnd, { street, alley, isFront, pw, seeThrough: enterable });

    // Rainwater / soil pipe hugging one edge; alleys get two.
    if (!spec.simple) {
      const pipes = alley ? [-pw / 2 + 0.45, pw / 2 - 0.45] : [rnd() < 0.5 ? -pw / 2 + 0.45 : pw / 2 - 0.45];
      for (const px of pipes) {
        this._stage('rust', cylGeo(0.075, 0.075, H - 0.4, 8, 0.7).translate(px, (H - 0.4) / 2, 0.13), m);
        for (let y = 1.2; y < H - 1; y += 2.6) {
          this._box('rust', 0.26, 0.06, 0.1, px, y, 0.09, m, null, 1.2);
        }
      }
    }
  }

  /**
   * Everything that hangs off a single opening: reveal trim, glazing, fittings.
   *
   * Detail is spent where it is seen. Skyline filler blocks get the hole and
   * nothing else — the dark building core behind already reads as a window —
   * and party walls get trim but no joinery. Only street and alley elevations,
   * the ones a camera ever gets close to, are built out in full.
   */
  _opening(spec, key, o, m, rnd, ctx) {
    const cx = o.x + o.w / 2 - ctx.pw / 2;

    if (spec.simple) {
      // Skyline filler used to get the hole and nothing else, which is exactly
      // why the distance read as pale boxes with two black rectangles punched
      // in them. Three boxes per opening buys a sill shadow, a lintel and a
      // recessed void — enough for a facade to have a grain at 80 metres.
      this._box('concrete', o.w + 0.26, 0.09, 0.2, cx, o.y - 0.045, 0.03, m, null, 0.9);
      this._box('concreteDark', o.w + 0.3, 0.15, 0.16, cx, o.y + o.h + 0.075, 0.0, m, null, 0.9);
      this._box('dark', o.w, o.h, 0.04, cx, o.y + o.h / 2, -WALL_T - 0.02, m, null, 0.4);
      if (rnd() < 0.3) {
        // Boarded or shuttered: breaks the regularity of the grid.
        this._box('rust', o.w, o.h * (0.4 + rnd() * 0.5), 0.05,
          cx, o.y + o.h * 0.75, -0.1, m, null, 1.2);
      }
      return;
    }

    if (!ctx.street && !ctx.alley) {
      this._box('concrete', o.w + 0.3, 0.1, 0.24, cx, o.y - 0.05, 0.02, m, null, 0.9);
      this._box('concrete', o.w + 0.36, 0.18, 0.2, cx, o.y + o.h + 0.09, 0.0, m, null, 0.9);
      this._box('wood', 0.06, o.h - 0.1, 0.05, cx, o.y + o.h / 2, -0.16, m, null, 2.2);
      return;
    }

    if (o.t === 'window' || o.t === 'balcony') {
      // Sill projects 16 cm and returns 10 cm into the reveal; lintel caps the head.
      this._box('concrete', o.w + 0.34, 0.1, 0.26, cx, o.y - 0.05, 0.03, m, null, 0.9);
      this._box('concrete', o.w + 0.4, 0.2, 0.22, cx, o.y + o.h + 0.1, 0.0, m, null, 0.9);
      // Frame set back inside the reveal so the recess is visible from an angle.
      // Only the jambs are modelled: the sill and lintel already read as the
      // horizontal members, so two boxes buy what four would.
      const fz = -0.16;
      this._box('wood', 0.07, o.h, 0.07, cx - o.w / 2 + 0.04, o.y + o.h / 2, fz, m, null, 2.2);
      this._box('wood', 0.07, o.h, 0.07, cx + o.w / 2 - 0.04, o.y + o.h / 2, fz, m, null, 2.2);
      const state = rnd();
      if (state < 0.34) {
        // Intact glazing: a smooth dark pane picks up the sky and gives the
        // facade the specular sparkle that dead matte boxes never have.
        this._box('glass', o.w - 0.12, o.h - 0.12, 0.03, cx, o.y + o.h / 2, fz - 0.05, m, null, 0.5);
        this._box('wood', 0.06, o.h - 0.1, 0.05, cx, o.y + o.h / 2, fz, m, null, 2.2);
      } else if (state < 0.6) {
        // Boarded up with scavenged timber.
        for (let i = 0; i < 2; i++) {
          this._box('wood', o.w + 0.1, 0.22, 0.05, cx, o.y + 0.4 + i * (o.h - 0.8),
            fz + 0.04, m, null, 1.6);
        }
      } else if (state < 0.76) {
        this._box('wood', 0.06, o.h - 0.1, 0.05, cx, o.y + o.h / 2, fz, m, null, 2.2);
      }
      if (o.t === 'balcony') this._balcony(spec, o, m, rnd, cx);
      else if (ctx.street && rnd() < 0.24) this._acUnit(o, m, rnd, cx);
      else if (ctx.alley && rnd() < 0.35) this._acUnit(o, m, rnd, cx);
      if (rnd() < 0.09) this._laundry(o, m, rnd, cx);
      return;
    }

    if (o.t === 'shop') {
      this._box('concrete', o.w + 0.5, 0.26, 0.34, cx, o.y + o.h + 0.13, 0.05, m, null, 0.8);
      const st = rnd();
      if (st < 0.4) {
        // Roller shutter, part-down: one panel plus a handful of proud slats,
        // which corrugates the silhouette without modelling every rib.
        const drop = 0.35 + rnd() * 0.6;
        const hh = o.h * drop;
        this._box('rust', o.w, hh, 0.06, cx, o.y + o.h - hh / 2, 0.02, m, null, 1.4);
        for (let y = 0.2; y < hh - 0.1; y += 0.42) {
          this._box('rust', o.w, 0.07, 0.04, cx, o.y + o.h - y, 0.06, m, null, 1.4);
        }
        this._box('rust', o.w + 0.08, 0.12, 0.1, cx, o.y + o.h - hh, 0.04, m, null, 1.4);
      } else {
        if (!ctx.seeThrough) this._box('dark', o.w, o.h, 0.06, cx, o.y + o.h / 2, -WALL_T - 0.02, m, null, 0.4);
        if (st < 0.7) {
          for (let i = 0; i < 2; i++) {
            this._box('wood', o.w * 1.02, 0.22, 0.06, cx, o.y + 0.5 + i * 1.2, -0.12, m, null, 1.6);
          }
        }
      }
      if (ctx.isFront || ctx.street) {
        if (rnd() < 0.62) this._awning(o, m, rnd, cx);
        if (rnd() < 0.55) this._shopSign(o, m, rnd, cx);
      }
      return;
    }

    if (o.t === 'door' || o.t === 'steel') {
      this._box('concrete', o.w + 0.4, 0.2, 0.24, cx, o.y + o.h + 0.1, 0.02, m, null, 0.9);
      const openLeaf = rnd() < 0.4;
      if (o.t === 'steel' || rnd() < 0.5) {
        // Steel door, sometimes swung open into the reveal.
        const g = boxGeo(o.w - 0.06, o.h - 0.06, 0.06, 1.3);
        g.translate((o.w - 0.06) / 2, 0, 0);
        g.applyMatrix4(mat(cx - (o.w - 0.06) / 2, o.y + o.h / 2, -0.14, openLeaf ? -1.15 : 0));
        this._stage('rust', g, m);
      } else {
        this._box('wood', o.w - 0.08, o.h - 0.06, 0.07, cx, o.y + o.h / 2, -0.14, m, null, 1.5);
      }
      if (!ctx.seeThrough) this._box('dark', o.w, o.h, 0.05, cx, o.y + o.h / 2, -WALL_T - 0.02, m, null, 0.4);
      // Threshold step.
      this._box('concrete', o.w + 0.5, 0.14, 0.42, cx, 0.07, 0.2, m, null, 1.0);
      return;
    }
  }

  _balcony(spec, o, m, rnd, cx) {
    const bw = Math.min(o.bw - 0.2, 2.6), dp = 1.25;
    this._box('concrete', bw, 0.16, dp, cx, o.y - 0.08, dp / 2, m, null, 0.7);
    // Cantilever brackets under the slab.
    for (const sx of [-1, 1]) {
      this._box('concrete', 0.14, 0.34, 0.7, cx + sx * (bw / 2 - 0.12), o.y - 0.3, 0.38, m, null, 1.2);
    }
    const rail = 1.05;
    for (const yy of [0.05, rail]) {
      this._box('rust', bw, 0.05, 0.05, cx, o.y + yy, dp, m, null, 2.0);
      this._box('rust', 0.05, 0.05, dp, cx - bw / 2, o.y + yy, dp / 2, m, null, 2.0);
      this._box('rust', 0.05, 0.05, dp, cx + bw / 2, o.y + yy, dp / 2, m, null, 2.0);
    }
    const n = Math.max(4, Math.round(bw / 0.34));
    for (let i = 0; i <= n; i++) {
      this._box('rust', 0.035, rail, 0.035, cx - bw / 2 + (i / n) * bw, o.y + rail / 2, dp, m, null, 3.0);
    }
    for (const sx of [-1, 1]) {
      this._box('rust', 0.035, rail, 0.035, cx + sx * bw / 2, o.y + rail / 2, dp * 0.5, m, null, 3.0);
    }
    // Balconies are where people keep things: a tank, a chair, drying laundry.
    if (rnd() < 0.5) {
      this._stage('rust', cylGeo(0.32, 0.32, 0.72, 10, 0.9)
        .translate(cx + (rnd() - 0.5) * (bw - 0.8), o.y + 0.36, dp * 0.55), m);
    }
    if (rnd() < 0.45) {
      const tint = _col.setHSL(rnd(), 0.35, 0.62).clone();
      const g = boxGeo(bw * 0.7, 0.55, 0.02, 1.2);
      this._stage('fabric', g.translate(cx, o.y + rail - 0.28, dp - 0.03), m, tint);
    }
  }

  _acUnit(o, m, rnd, cx) {
    const y = o.y - 0.62, x = cx + (rnd() - 0.5) * 0.4;
    this._box('metal', 0.66, 0.44, 0.36, x, y, 0.2, m, null, 1.3);
    this._box('rust', 0.7, 0.05, 0.4, x, y - 0.24, 0.2, m, null, 1.3);
    // Fan grille reads as a dark disc from any distance.
    this._stage('dark', cylGeo(0.16, 0.16, 0.03, 10, 1.0)
      .rotateX(Math.PI / 2).translate(x, y, 0.385), m);
    for (const sx of [-1, 1]) {
      this._box('rust', 0.05, 0.3, 0.05, x + sx * 0.3, y - 0.34, 0.06, m, null, 2.0);
    }
    // Condensate stain streaking down the wall below it.
    this._box('dark', 0.16, 1.4, 0.012, x, y - 0.95, 0.005, m, new THREE.Color(0.35, 0.33, 0.3), 0.6);
  }

  /**
   * A hung sheet: a real surface, not a billboard.
   *
   * The top edge follows the line's own catenary, the hem droops further under
   * its own weight, and the whole panel bellies out of plane with an amplitude
   * that grows toward the hem. Those three things together are the entire
   * difference between drying washing and an untextured placeholder quad, and
   * they cost 42 vertices.
   */
  _clothSheet(a, b, sag, h, tint, rnd) {
    const NU = 6, NV = 5;
    const pos = new Float32Array((NU + 1) * (NV + 1) * 3);
    const uv = new Float32Array((NU + 1) * (NV + 1) * 2);
    const idx = new Uint16Array(NU * NV * 6);
    // Sit the UVs inside a single stripe band so a sheet reads as one cloth
    // colour with a weave, not as a two-axis check.
    const band = ((rnd() * 8) | 0) * 0.125 + 0.03;
    const phase = rnd() * 6.28, curl = 0.05 + rnd() * 0.09;
    let nx = -(b.z - a.z), nz = b.x - a.x;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    let k = 0;
    for (let j = 0; j <= NV; j++) {
      const v = j / NV;
      for (let i = 0; i <= NU; i++, k++) {
        const u = i / NU;
        const droop = sag * 4 * u * (1 - u);
        const belly = Math.sin(u * Math.PI * 2.1 + phase) * curl * v * v;
        pos[k * 3] = lerp(a.x, b.x, u) + nx * belly;
        pos[k * 3 + 1] = lerp(a.y, b.y, u) - droop - v * h - Math.sin(u * Math.PI) * sag * 0.3 * v;
        pos[k * 3 + 2] = lerp(a.z, b.z, u) + nz * belly;
        uv[k * 2] = band + u * 0.06;
        uv[k * 2 + 1] = (1 - v) * h * 1.3;
      }
    }
    let t = 0;
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const p = j * (NU + 1) + i;
        idx[t++] = p; idx[t++] = p + NU + 1; idx[t++] = p + 1;
        idx[t++] = p + 1; idx[t++] = p + NU + 1; idx[t++] = p + NU + 2;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    return { geo: g, tint };
  }

  /** Sheets pegged along a span, plus the pegs themselves. */
  _washingRun(a, b, sag, rnd, m = null) {
    const n = 2 + ((rnd() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const t0 = (i + 0.12) / n, t1 = (i + 0.88) / n;
      const pa = a.clone().lerp(b, t0), pb = a.clone().lerp(b, t1);
      pa.y -= sag * 4 * t0 * (1 - t0);
      pb.y -= sag * 4 * t1 * (1 - t1);
      const tint = _col.setHex(LAUNDRY_COLORS[(rnd() * LAUNDRY_COLORS.length) | 0]).clone();
      const sheet = this._clothSheet(pa, pb, sag * 0.22, 0.42 + rnd() * 0.55, tint, rnd);
      this._stage('fabric', sheet.geo, m, tint);
      for (const p of [pa, pb]) {
        this._box('charred', 0.05, 0.07, 0.05, p.x, p.y + 0.02, p.z, m, null, 3.0);
      }
    }
  }

  _laundry(o, m, rnd, cx) {
    const a = new THREE.Vector3(cx - o.w / 2 - 0.2, o.y + o.h - 0.1, 0.28);
    const b = new THREE.Vector3(cx + o.w / 2 + 0.2, o.y + o.h - 0.12, 0.28);
    const sag = 0.1;
    this._addWire(this._catenary(a.clone(), b.clone(), sag, 8), 0.014,
      new THREE.Color(0x8d8272), m);
    this._washingRun(a, b, sag, rnd, m);
  }

  _awning(o, m, rnd, cx) {
    const w = o.w + 0.3, dp = 1.5, y = o.y + o.h + 0.3;
    const tint = [
      new THREE.Color(0.85, 0.3, 0.24), new THREE.Color(0.25, 0.42, 0.6),
      new THREE.Color(0.35, 0.55, 0.32), new THREE.Color(0.9, 0.78, 0.5),
    ][(rnd() * 4) | 0];
    const g = boxGeo(w, 0.05, dp, 1.1);
    g.applyMatrix4(mat(cx, y - 0.16, dp / 2 + 0.1, 0, -0.34));
    this._stage('fabric', g, m, tint);
    // Valance hanging off the leading edge — the detail that says "market".
    this._box('fabric', w, 0.3, 0.02, cx, y - 0.58, dp + 0.06, m, tint, 1.4);
    for (const sx of [-1, 1]) {
      this._box('metal', 0.05, 0.05, dp, cx + sx * w / 2, y - 0.08, dp / 2 + 0.1, m, null, 2.0);
      this._stage('metal', cylGeo(0.03, 0.03, 1.0, 6, 2.0)
        .applyMatrix4(mat(cx + sx * (w / 2 - 0.05), y - 0.55, dp * 0.55, 0, 0, 0.5)), m);
    }
  }

  _shopSign(o, m, rnd, cx) {
    const w = Math.min(o.w + 0.2, 2.4), h = 0.62;
    const y = o.y + o.h + 0.62;
    // Each sign takes one quadrant of the signage atlas.
    const g = boxGeo(w, h, 0.09, 0.55);
    const uv = g.attributes.uv;
    const qx = (rnd() * 2) | 0, qy = (rnd() * 2) | 0;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) % 1) * 0.5 + qx * 0.5, (uv.getY(i) % 1) * 0.5 + qy * 0.5);
    }
    this._stage('sign', g.translate(cx, y, 0.12), m);
    for (const sx of [-1, 1]) this._box('rust', 0.04, 0.3, 0.16, cx + sx * (w / 2 - 0.1), y + h / 2 + 0.1, 0.1, m, null, 2.0);
    // Some shops hang a perpendicular blade sign — good silhouette from down the street.
    if (rnd() < 0.3) {
      const bg = boxGeo(0.08, 0.9, 0.7, 0.6);
      this._stage('sign', bg.translate(cx + (o.w / 2 + 0.4), y - 0.2, 0.5), m);
      this._box('rust', 0.6, 0.05, 0.05, cx + o.w / 2 + 0.2, y + 0.3, 0.5, m, null, 2.0);
    }
  }

  /**
   * Parapets are built in segments with random gaps and heights. A continuous
   * unbroken parapet is the tell-tale of procedural architecture; a shelled one
   * gives every roofline a different silhouette against the sky.
   */
  _parapet(spec, rnd) {
    const { _cx: cx, _cz: cz, _w: w, _d: d, _H: H, _base: base } = spec;
    const y = base + H;
    const edges = [
      { horiz: true, z: cz + d / 2 - WALL_T / 2, span: w, c: cx, id: 'S' },
      { horiz: true, z: cz - d / 2 + WALL_T / 2, span: w, c: cx, id: 'N' },
      { horiz: false, x: cx + w / 2 - WALL_T / 2, span: d, c: cz, id: 'E' },
      { horiz: false, x: cx - w / 2 + WALL_T / 2, span: d, c: cz, id: 'W' },
    ];
    for (const e of edges) {
      let p = 0;
      while (p < e.span - 0.2) {
        const len = Math.min(e.span - p, 2.4 + rnd() * 5.5);
        const gap = rnd() < (spec.ruin ? 0.5 : 0.16);
        // The switchback tops out near the street end of the stair elevation;
        // leave that stretch open or the roof is not actually reachable.
        const atStair = spec.roofAccess && e.id === spec.stair && p > e.span - 8;
        if (!gap && !atStair && len > 0.5) {
          const hh = spec.ruin ? 0.4 + rnd() * 0.5 : 0.72 + rnd() * 0.42;
          const off = p + len / 2 - e.span / 2;
          if (e.horiz) {
            this._box(spec.mat, len, hh, WALL_T, e.c + off, y + hh / 2, e.z, null, null, 0.42);
            this._box('concrete', len, 0.12, WALL_T + 0.22, e.c + off, y + hh + 0.06, e.z, null, null, 0.7);
          } else {
            this._box(spec.mat, WALL_T, hh, len, e.x, y + hh / 2, e.c + off, null, null, 0.42);
            this._box('concrete', WALL_T + 0.22, 0.12, len, e.x, y + hh + 0.06, e.c + off, null, null, 0.7);
          }
        }
        p += len + (gap ? 0.6 + rnd() * 1.6 : 0);
      }
    }
    if (spec.roofAccess) {
      // A reachable roof needs collision on its parapet or the player walks off.
      this._collideBox(cx, y + 0.5, cz + d / 2 - WALL_T / 2, w, 1.0, WALL_T);
      this._collideBox(cx, y + 0.5, cz - d / 2 + WALL_T / 2, w, 1.0, WALL_T);
      this._collideBox(cx - w / 2 + WALL_T / 2, y + 0.5, cz, WALL_T, 1.0, d);
    }
  }

  /**
   * The deck itself: lapped felt seams, ponding, gravel dressing and the low
   * upstand where the felt turns up the parapet. A flat roof is never flat —
   * it is a patchwork of repairs draining badly toward one corner — and reading
   * that patchwork is the whole reason a rooftop pose has anything to look at.
   */
  _roofSurface(spec, rnd) {
    const { _cx: cx, _cz: cz, _w: w, _d: d, _H: H, _base: base } = spec;
    const y = base + H;
    const alongX = w >= d;
    const span = alongX ? d : w;
    const len = (alongX ? w : d) - 0.5;

    // Lapped seams between the felt rolls. Spacing wanders per seam and the
    // runs stop short at random: an even grid of full-width lines reads as a
    // tiled floor, which is the opposite of what a tar roof looks like.
    for (let p = -span / 2 + 0.7; p < span / 2 - 0.4; p += 0.9 + rnd() * 0.8) {
      const cut = rnd() < 0.3 ? 0.45 + rnd() * 0.4 : 1;
      const off = (1 - cut) * len * (rnd() - 0.5);
      const tw = 0.07 + rnd() * 0.04;
      // A lap is a fold of the same felt, not a grout line: keep it close in
      // value to the deck or the roof reads as a floor of paving slabs.
      if (alongX) this._box('roofPatch', len * cut, 0.03, tw, cx + off, y + 0.015, cz + p, null, null, 1.6);
      else this._box('roofPatch', tw, 0.03, len * cut, cx + p, y + 0.015, cz + off, null, null, 1.6);
    }
    // Cross joints where the rolls butt — two or three, never on a grid.
    for (let i = 0; i < 2 + ((rnd() * 2) | 0); i++) {
      const bj = (rnd() - 0.5) * len * 0.7;
      const cut = 0.4 + rnd() * 0.5;
      const off = (1 - cut) * span * (rnd() - 0.5);
      if (alongX) this._box('roofWet', 0.09, 0.03, span * cut, cx + bj, y + 0.016, cz + off, null, null, 1.6);
      else this._box('roofWet', span * cut, 0.03, 0.09, cx + off, y + 0.016, cz + bj, null, null, 1.6);
    }

    // Upstand: the felt turned up against the parapet, capped with flashing.
    for (const [ux, uz, uw, ud] of [
      [cx, cz + d / 2 - 0.34, w - 0.2, 0.2], [cx, cz - d / 2 + 0.34, w - 0.2, 0.2],
      [cx + w / 2 - 0.34, cz, 0.2, d - 0.9], [cx - w / 2 + 0.34, cz, 0.2, d - 0.9],
    ]) {
      this._box('roofWet', uw, 0.18, ud, ux, y + 0.08, uz, null, null, 1.1);
    }

    // Ponding and silver-coat repair patches, laid on the diagonal so they
    // never line up with the seam grid.
    for (let i = 0; i < 3 + ((rnd() * 3) | 0); i++) {
      const pw = 1.6 + rnd() * 3.4, pd = 1.2 + rnd() * 2.8;
      const px = cx + (rnd() - 0.5) * (w - pw - 1.6);
      const pz = cz + (rnd() - 0.5) * (d - pd - 1.6);
      const wet = rnd() < 0.55;
      this._stage(wet ? 'roofWet' : 'roofPatch', boxGeo(pw, 0.022, pd, 0.5),
        mat(px, y + 0.012 + (wet ? 0 : 0.004), pz, rnd() * 0.7 - 0.35));
    }
    // Chippings swept into drifts. Small and close to the deck in hue — a wide
    // flat quad of dune-coloured sand up here reads as an unassigned plane.
    for (let i = 0; i < 3 + ((rnd() * 4) | 0); i++) {
      const pw = 0.7 + rnd() * 1.5, pd = 0.5 + rnd() * 1.2;
      this._stage('roofPatch', boxGeo(pw, 0.035, pd, 2.2),
        mat(cx + (rnd() - 0.5) * (w - pw - 2), y + 0.022, cz + (rnd() - 0.5) * (d - pd - 2), rnd() * 1.5),
        _col.setHSL(0.10, 0.12, 0.68 + rnd() * 0.34).clone());
    }
    // Perimeter service run: cable on low stands a metre inside the parapet,
    // with vent pipes breaking the deck alongside it. Anchored to the edge
    // rather than scattered, so a rooftop pose always has something in the near
    // field rather than an empty slab from here to the parapet.
    const side = rnd() < 0.5 ? -1 : 1;
    const eo = 1.25;
    const runZ = cz + side * (d / 2 - eo);
    const x0 = cx - w / 2 + 1.2, x1 = cx + w / 2 - 1.2;
    const pts = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      pts.push(new THREE.Vector3(lerp(x0, x1, t), y + 0.34 - Math.sin(t * Math.PI) * 0.05, runZ));
      if (i < 5) {
        const sxp = lerp(x0, x1, t + 0.05);
        this._box('concreteDark', 0.24, 0.3, 0.2, sxp, y + 0.15, runZ, null, null, 1.4);
      }
    }
    this._addWire(pts, 0.022, new THREE.Color(0x241f19));
    // Vent stacks and a soil pipe head along the same run.
    for (let i = 0; i < 3; i++) {
      const vx = lerp(x0, x1, 0.18 + i * 0.32 + rnd() * 0.08);
      const vz = runZ - side * (0.7 + rnd() * 1.6);
      const vh = 0.55 + rnd() * 0.9;
      this._stage('rust', cylGeo(0.085, 0.085, vh, 8, 1.2).translate(vx, y + vh / 2, vz));
      this._stage('rust', cylGeo(0.155, 0.155, 0.06, 8, 1.2).translate(vx, y + vh + 0.03, vz));
      this._box('roofWet', 0.44, 0.06, 0.44, vx, y + 0.03, vz, null, null, 1.4);
    }
    // A stack of spare blocks and an abandoned bucket: the litter of a roof
    // that people actually use.
    const kx = cx + (rnd() - 0.5) * (w - 5), kz = cz - side * (d / 2 - 2.6);
    for (let i = 0; i < 4; i++) {
      this._box('concreteDark', 0.5, 0.09, 0.24, kx + (rnd() - 0.5) * 0.14,
        y + 0.05 + i * 0.09, kz + (rnd() - 0.5) * 0.14, null, null, 1.6);
    }
    this._stage('rust', cylGeo(0.16, 0.13, 0.26, 8, 1.4).translate(kx + 0.7, y + 0.13, kz + 0.3));
  }

  /**
   * Cheap roof clutter for the skyline filler. A flat-topped box is the single
   * most obvious tell that a city is a greybox, and a water tank, an aerial and
   * two vent pipes per building — a dozen primitives, merged with everything
   * else — is the cheapest possible cure.
   */
  _roofDressingLite(spec, rnd) {
    const { _cx: cx, _cz: cz, _w: w, _d: d, _H: H, _base: base } = spec;
    const y = base + H;
    const px = () => cx + (rnd() - 0.5) * (w - 3.4);
    const pz = () => cz + (rnd() - 0.5) * (d - 3.4);

    // Stair head-house, and on the taller blocks a plant room beside it.
    const sx = px(), sz = pz();
    this._box(spec.mat, 2.8, 2.4 + rnd() * 0.8, 2.4, sx, y + 1.3, sz, null, null, 0.42);
    this._box('concrete', 3.1, 0.16, 2.7, sx, y + 2.6, sz, null, null, 0.6);
    if (rnd() < 0.5) {
      this._box(spec.mat, 1.8, 1.5, 1.6, sx + 2.6, y + 0.75, sz + 0.6, null, null, 0.42);
    }
    // Water tanks on stands — the silhouette that says "roof" from a kilometre.
    for (let i = 0; i < 1 + ((rnd() * 3) | 0); i++) {
      const tx = px(), tz = pz();
      this._stage('rust', cylGeo(0.6, 0.6, 1.1, 8, 0.8).translate(tx, y + 1.45, tz));
      for (const ex of [-1, 1]) for (const ez of [-1, 1]) {
        this._box('rust', 0.08, 0.9, 0.08, tx + ex * 0.42, y + 0.45, tz + ez * 0.42, null, null, 2.0);
      }
    }
    // Aerial masts and vent stacks.
    for (let i = 0; i < 1 + ((rnd() * 3) | 0); i++) {
      const ax = px(), az = pz(), ah = 2.2 + rnd() * 3.4;
      this._stage('metal', cylGeo(0.035, 0.055, ah, 5, 1.5).translate(ax, y + ah / 2, az));
      for (let k = 0; k < 3; k++) {
        this._box('metal', 0.85 - k * 0.16, 0.03, 0.03, ax, y + ah * (0.5 + k * 0.15), az, null, null, 3.0);
      }
    }
    for (let i = 0; i < 2 + ((rnd() * 3) | 0); i++) {
      const vx = px(), vz = pz(), vh = 0.45 + rnd() * 1.2;
      this._stage('rust', cylGeo(0.09, 0.09, vh, 6, 1.2).translate(vx, y + vh / 2, vz));
      this._stage('rust', cylGeo(0.17, 0.17, 0.06, 6, 1.2).translate(vx, y + vh + 0.03, vz));
    }
    // A dish or two, seen only in silhouette from the street.
    if (rnd() < 0.7) {
      const dx = px(), dz = pz(), r = 0.4 + rnd() * 0.25;
      const bowl = new THREE.SphereGeometry(r, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.34);
      bowl.applyMatrix4(mat(dx, y + 0.9, dz, rnd() * 6.28, -2.15));
      this._stage('panel', bowl);
      this._stage('metal', cylGeo(0.05, 0.05, 0.9, 5, 1.5).translate(dx, y + 0.45, dz));
    }
  }

  /**
   * A shelled top storey. The two blocks that terminate the boulevard are the
   * focal point of the `closeup` vista, and a flat roofline on a blank slab is
   * the worst possible thing to close a street with.
   */
  _ruinTop(spec, rnd) {
    const { _cx: cx, _cz: cz, _w: w, _d: d, _H: H, _base: base } = spec;
    const y = base + H;
    // Jagged remains of the storey that came off, biased to one corner so the
    // silhouette steps down across the frame instead of crenellating evenly.
    const lean = rnd() < 0.5 ? -1 : 1;
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const hh = (0.6 + rnd() * 2.6) * (0.35 + 0.85 * (lean > 0 ? t : 1 - t));
      const bx = cx + (t - 0.5) * (w - 1.2);
      const bz = cz + (rnd() - 0.5) * (d - 1.6);
      this._box(spec.mat, 0.8 + rnd() * 1.5, hh, 0.5 + rnd() * 0.8, bx, y + hh / 2, bz, null, null, 0.42);
      if (rnd() < 0.5) {
        this._box('concreteDark', 1.4 + rnd() * 1.6, 0.24, 1.8 + rnd() * 1.4,
          bx, y + hh + 0.12, bz, null, null, 0.55);
      }
    }
    // Exposed slab edges and rebar whiskers over the street face.
    const face = spec.front === 'S' ? 1 : -1;
    for (let i = 0; i < 6; i++) {
      const g = cylGeo(0.018, 0.018, 0.8 + rnd() * 1.1, 4, 2.0);
      g.applyMatrix4(mat(cx + (rnd() - 0.5) * (w - 1), y + 0.4 + rnd() * 1.6,
        cz + face * (d / 2 - 0.3), rnd() * 6.28, 0.9 + rnd() * 0.7));
      this._stage('rust', g);
    }
    // A slab that came down into the street, and the spill under it.
    const sx = cx - (w / 2 + 2.2) * (spec.x0 > 0 ? 1 : -1);
    const slab = boxGeo(3.6, 0.28, 2.6, 0.5);
    slab.applyMatrix4(mat(sx, base + 1.4, cz + (rnd() - 0.5) * d * 0.4, 0.4, 0, 0.95));
    this._stage('concreteDark', slab);
    this._rubblePile(sx, cz + (rnd() - 0.5) * d * 0.3, 4.6, 1.6, rnd);
  }

  /**
   * Roof clutter. Middle-Eastern rooftops are working spaces — water tanks,
   * dishes, aerials, vent stacks — and they are most of what a skyline shot is
   * actually looking at.
   */
  _roofDressing(spec, rnd) {
    const { _cx: cx, _cz: cz, _w: w, _d: d, _H: H, _base: base } = spec;
    const y = base + H;
    const inset = 1.4;
    const px = () => cx + (rnd() - 0.5) * (w - inset * 2);
    const pz = () => cz + (rnd() - 0.5) * (d - inset * 2);

    // Stairwell head-house.
    if (rnd() < 0.75) {
      const sx = cx + (rnd() - 0.5) * (w - 4), sz = cz + (rnd() - 0.5) * (d - 4);
      this._box(spec.mat, 2.6, 2.5, 2.3, sx, y + 1.25, sz, null, null, 0.42);
      this._box('concrete', 2.9, 0.18, 2.6, sx, y + 2.6, sz, null, null, 0.6);
      this._box('rust', 0.95, 2.0, 0.07, sx, y + 1.0, sz + 1.19, null, null, 1.4);
    }

    // Water tanks on angle-iron stands.
    const tanks = 1 + ((rnd() * 3) | 0);
    for (let i = 0; i < tanks; i++) {
      const tx = px(), tz = pz();
      this._stage('rust', cylGeo(0.62, 0.62, 1.15, 12, 0.8).translate(tx, y + 1.5, tz));
      this._stage('metal', cylGeo(0.66, 0.66, 0.08, 12, 0.8).translate(tx, y + 2.11, tz));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        this._box('rust', 0.07, 0.95, 0.07, tx + sx * 0.45, y + 0.47, tz + sz * 0.45, null, null, 2.0);
      }
      this._stage('rust', cylGeo(0.045, 0.045, 1.0, 6, 1.6).translate(tx + 0.5, y + 0.5, tz));
    }

    // Satellite dishes: a partial sphere is the cheapest convincing dish.
    const dishes = 1 + ((rnd() * 4) | 0);
    for (let i = 0; i < dishes; i++) {
      const dx = px(), dz = pz(), r = 0.42 + rnd() * 0.3;
      const bowl = new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.34);
      const aim = rnd() * Math.PI * 2;
      bowl.applyMatrix4(mat(dx, y + 0.95 + r * 0.2, dz, aim, -2.15));
      this._stage('panel', bowl);
      this._stage('metal', cylGeo(0.05, 0.05, 0.95, 6, 1.5).translate(dx, y + 0.48, dz));
      this._box('concrete', 0.5, 0.14, 0.5, dx, y + 0.07, dz, null, null, 1.0);
      // Feed arm and LNB standing off the dish mouth, in the bowl's own frame.
      const aimM = mat(dx, y + 0.95 + r * 0.2, dz, aim, -2.15);
      this._stage('metal', boxGeo(0.035, r * 1.2, 0.035, 2.0).translate(0, r * 0.6, 0).applyMatrix4(aimM));
      this._stage('dark', boxGeo(0.1, 0.16, 0.1, 1.0).translate(0, r * 1.22, 0).applyMatrix4(aimM));
    }

    // Vent stacks with rain caps, and an aerial mast.
    for (let i = 0; i < 2 + ((rnd() * 4) | 0); i++) {
      const vx = px(), vz = pz(), vh = 0.5 + rnd() * 1.3;
      this._stage('rust', cylGeo(0.09, 0.09, vh, 8, 1.2).translate(vx, y + vh / 2, vz));
      this._stage('rust', cylGeo(0.16, 0.16, 0.06, 8, 1.2).translate(vx, y + vh + 0.03, vz));
    }
    if (rnd() < 0.55) {
      const ax = px(), az = pz(), ah = 2.6 + rnd() * 2.2;
      this._stage('metal', cylGeo(0.035, 0.05, ah, 6, 1.5).translate(ax, y + ah / 2, az));
      for (let i = 0; i < 4; i++) {
        const yy = y + ah * (0.45 + i * 0.13);
        this._box('metal', 0.9 - i * 0.14, 0.025, 0.025, ax, yy, az, null, null, 3.0);
      }
    }
    // Rooftop AC condensers.
    for (let i = 0; i < ((rnd() * 3) | 0); i++) {
      const ax = px(), az = pz();
      this._box('metal', 0.9, 0.62, 0.7, ax, y + 0.31, az, null, null, 1.1);
      this._stage('dark', cylGeo(0.24, 0.24, 0.03, 10, 1.0).translate(ax, y + 0.63, az));
    }
  }

  /**
   * Switchback exterior staircase in the alley: the map's route to a rooftop
   * overwatch and, incidentally, the strongest vertical read in the alley shot.
   */
  _exteriorStair(spec, rnd) {
    const { _cx: cx, _cz: cz, _w: w, _d: d, _H: H, _base: base } = spec;
    const wallX = cx + (spec.stair === 'E' ? w / 2 : -w / 2);
    const dir = spec.stair === 'E' ? 1 : -1;
    const flightW = 1.5;
    const sx = wallX + dir * (flightW / 2 + 0.05);
    let y = base;
    let z = cz + d / 2 - 1.6;
    let sense = -1;                            // first flight runs into the block
    const flights = Math.max(1, spec.floors);
    for (let f = 0; f < flights; f++) {
      const rise = f === 0 ? GROUND_H : FLOOR_H;
      const steps = Math.round(rise / 0.185);
      const run = steps * 0.29;
      for (let s = 0; s < steps; s++) {
        const sy = y + (s + 0.5) * (rise / steps);
        const sz = z + sense * (s + 0.5) * 0.29;
        this._box('concrete', flightW, 0.17, 0.3, sx, sy, sz, null, null, 0.9);
        // Open riser look: a thin stringer instead of a solid flight underneath.
        if (s % 2 === 0) this._box('concrete', 0.1, rise * 0.9, 0.1, sx + dir * (flightW / 2 - 0.06), sy - 0.4, sz, null, null, 1.6);
      }
      // A single sloped collider per flight — smooth to walk, cheap to trace.
      const ang = Math.atan2(rise, run);
      this._collideBox(sx, y + rise / 2 - 0.12, z + sense * run / 2, flightW, 0.3,
        Math.hypot(run, rise), 0, SURFACE.CONCRETE, sense * -ang);
      // Handrail.
      for (let s = 0; s <= steps; s += 3) {
        const hz = z + sense * s * 0.29;
        this._box('rust', 0.05, 1.0, 0.05, sx + dir * (flightW / 2 - 0.05), y + s * (rise / steps) + 0.5, hz, null, null, 2.0);
      }
      const railG = boxGeo(0.06, 0.06, Math.hypot(run, rise), 1.6);
      railG.applyMatrix4(mat(sx + dir * (flightW / 2 - 0.05), y + rise / 2 + 1.0, z + sense * run / 2, 0, sense * -ang));
      this._stage('rust', railG);

      y += rise;
      z += sense * run;
      // Landing, then reverse direction for the switchback.
      this._box('concrete', flightW + 1.5, 0.2, 1.5, sx + dir * 0.6, y - 0.1, z + sense * 0.75, null, null, 0.8);
      this._collideBox(sx + dir * 0.6, y - 0.1, z + sense * 0.75, flightW + 1.5, 0.2, 1.5);
      z += sense * 1.5;
      sense = -sense;
      if (f < flights - 1) {
        // Doorway off each landing back into the building.
        this._box('rust', 0.95, 2.0, 0.08, wallX + dir * 0.06, y + 1.0, z - sense * 0.75, null, null, 1.4);
      }
    }
  }

  /** Collapsed corner: exposed floor slabs, hanging rebar and a spill of rubble. */
  _breachDebris(spec, rnd) {
    const b = spec.breach;
    const { _cz: cz, _d: d, _base: base } = spec;
    const zFace = spec.breach.side === 'S' ? cz + d / 2 : cz - d / 2;
    const sgn = spec.breach.side === 'S' ? 1 : -1;
    const bx = (b.x0 + b.x1) / 2, bw = b.x1 - b.x0;

    // Floor slabs, now open to the air.
    for (let f = b.fromFloor; f < spec.floors; f++) {
      const y = base + Level.floorBase(f);
      this._box('concreteDark', bw + 0.6, 0.28, 3.4, bx, y - 0.14, zFace - sgn * 1.7, null, null, 0.55);
      // Rebar whiskers off the torn slab edge.
      for (let i = 0; i < 5; i++) {
        const rx = b.x0 + rnd() * bw;
        const g = cylGeo(0.018, 0.018, 0.7 + rnd() * 0.8, 4, 2.0);
        g.applyMatrix4(mat(rx, y - 0.1, zFace - sgn * 0.1, rnd() * 2, 1.2 + rnd() * 0.6));
        this._stage('rust', g);
      }
      // Jagged masonry teeth along the breach edge.
      for (let i = 0; i < 4; i++) {
        const rx = b.x0 - 0.4 + rnd() * (bw + 0.8);
        this._box(spec.mat, 0.4 + rnd() * 0.7, 0.3 + rnd() * 0.8, WALL_T,
          rx, y + 0.3 + rnd() * 0.5, zFace - sgn * WALL_T / 2, null, null, 0.42);
      }
    }
    // A slab that peeled off and is leaning against the facade.
    const lean = boxGeo(3.2, 0.26, 2.4, 0.5);
    lean.applyMatrix4(mat(bx + 1.4, base + 1.5, zFace + sgn * 2.2, 0.3, 0, sgn * 1.05));
    this._stage('concreteDark', lean);
    this._collideBox(bx + 1.4, base + 1.5, zFace + sgn * 2.2, 3.2, 0.26, 2.4, 0.3, SURFACE.CONCRETE, 0);
    this._rubblePile(bx, zFace + sgn * 2.6, 5.5, 1.5, rnd);
  }

  // --- scattered instancing -------------------------------------------------

  /** Queue one instance of a scatter kind; realised as an InstancedMesh later. */
  _scatterAdd(kind, matrix, tint = null) {
    if (!this._scatter) this._scatter = new Map();
    let a = this._scatter.get(kind);
    if (!a) { a = []; this._scatter.set(kind, a); }
    a.push({ m: matrix, c: tint });
    return a.length;
  }

  /**
   * A pile of broken masonry: a mound of chunks with a few bars of rebar
   * sticking out. Used at every building base, inside the breach and wherever
   * the street needs a soft, non-rectilinear silhouette to break up the boxes.
   */
  _rubblePile(x, z, radius, height, rnd) {
    const base = this._groundY(x, z);
    const count = Math.round(radius * radius * 0.9);
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 0.6) * radius;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const drop = 1 - r / radius;
      const s = 0.18 + rnd() * 0.42 * (0.4 + drop);
      const py = base + drop * drop * height * rnd() * 0.9 + s * 0.2;
      this._scatterAdd(rnd() < 0.34 ? 'brickChunk' : 'rubble',
        mat(px, py, pz, rnd() * 6.28, rnd() * 1.4, rnd() * 1.4)
          .scale(_v.set(s, s, s)),
        _col.setHSL(0.09, 0.1, 0.55 + rnd() * 0.35).clone());
    }
    for (let i = 0; i < Math.max(2, radius | 0); i++) {
      const a = rnd() * Math.PI * 2, r = rnd() * radius * 0.7;
      const g = cylGeo(0.016, 0.016, 0.9 + rnd() * 1.4, 4, 2.0);
      g.applyMatrix4(mat(x + Math.cos(a) * r, base + 0.5 + rnd() * height * 0.6, z + Math.sin(a) * r,
        rnd() * 6.28, 0.8 + rnd() * 0.8));
      this._stage('rust', g);
    }
    if (radius > 2.5) this._collideBox(x, base + height * 0.25, z, radius * 1.2, height * 0.5, radius * 1.2, 0, SURFACE.CONCRETE);
  }

  // --- landmarks ------------------------------------------------------------

  /**
   * The minaret. Placed off the boulevard centreline so it anchors the left of
   * the hero framing without blocking the vista, and tall enough to be the one
   * thing visible above the roofline from anywhere on the map.
   */
  _buildLandmarks() {
    const rnd = mulberry32(this.seed + 991);
    const tx = -13.5, tz = -17.5;
    const g0 = this._groundY(tx, tz);
    // Stepped stone plinth.
    this._box('stone', 5.2, 0.5, 5.2, tx, g0 + 0.25, tz, null, null, 0.5);
    this._box('stone', 4.4, 0.6, 4.4, tx, g0 + 0.8, tz, null, null, 0.5);
    this._collideBox(tx, g0 + 0.55, tz, 5.2, 1.1, 5.2);

    // Octagonal shaft with a slight taper.
    const shaftH = 15.5;
    this._stage('stone', cylGeo(1.35, 1.75, shaftH, 8, 0.42).translate(tx, g0 + 1.1 + shaftH / 2, tz));
    this._collideBox(tx, g0 + 1.1 + shaftH / 2, tz, 3.1, shaftH, 3.1);
    // Recessed blind arches around the base give the shaft depth.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const g = boxGeo(0.85, 3.0, 0.2, 0.7);
      g.applyMatrix4(mat(tx + Math.sin(a) * 1.62, g0 + 3.4, tz + Math.cos(a) * 1.62, a));
      this._stage('dark', g);
    }
    // Muezzin's balcony ring: corbel course, deck, then a pierced parapet.
    const by = g0 + 1.1 + shaftH;
    this._stage('stone', cylGeo(2.5, 1.5, 0.8, 8, 0.6).translate(tx, by - 0.4, tz));
    this._stage('stone', cylGeo(2.6, 2.6, 0.22, 8, 0.6).translate(tx, by + 0.11, tz));
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      this._box('stone', 0.14, 0.95, 0.14, tx + Math.sin(a) * 2.42, by + 0.7, tz + Math.cos(a) * 2.42, null, null, 2.0);
    }
    this._stage('stone', cylGeo(2.62, 2.62, 0.14, 8, 0.6).translate(tx, by + 1.24, tz));
    // Upper drum, then the cap — shelled off, which reads instantly as war damage.
    this._stage('stone', cylGeo(1.05, 1.2, 4.2, 8, 0.5).translate(tx, by + 3.4, tz));
    for (let i = 0; i < 5; i++) {
      const a = rnd() * 6.28;
      this._box('stone', 0.5 + rnd() * 0.6, 0.4 + rnd() * 0.9, 0.5,
        tx + Math.sin(a) * 1.0, by + 5.6 + rnd() * 0.5, tz + Math.cos(a) * 1.0, null, null, 0.6);
    }
    this._stage('rust', cylGeo(0.03, 0.03, 1.8, 4, 2.0).translate(tx + 0.4, by + 6.2, tz - 0.3));
    this._rubblePile(tx + 3.4, tz + 2.6, 3.0, 0.9, rnd);

    // Freestanding compound wall closing the plaza's north-west corner: hard
    // cover at mid range and a clean horizontal to read the light against.
    for (let i = 0; i < 7; i++) {
      const wx = -PLAZA + 1.5 + i * 3.05;
      const gy = this._groundY(wx, -PLAZA + 2.5);
      const hh = i === 3 ? 1.1 : 2.4 - (i % 3) * 0.35;
      this._box('plasterE', 3.0, hh, 0.4, wx, gy + hh / 2, -PLAZA + 2.5, null, null, 0.45);
      this._box('concrete', 3.1, 0.14, 0.56, wx, gy + hh + 0.07, -PLAZA + 2.5, null, null, 0.8);
      this._collideBox(wx, gy + hh / 2, -PLAZA + 2.5, 3.0, hh, 0.4);
    }
  }

  /**
   * Two ground floors are real rooms. The interior/exterior exposure gap —
   * a warm practical inside against hard sun outside — is what makes the
   * doorways read as depth rather than as black decals on a wall.
   */
  _buildInteriors() {
    const rnd = mulberry32(this.seed + 313);
    for (const spec of this._plan) {
      if (!spec.hollow) continue;
      const { _cx: cx, _cz: cz, _w: w, _d: d, _base: base } = spec;
      const iw = w - WALL_T * 2 - 0.06, id = d - WALL_T * 2 - 0.06;

      this._box('concrete', iw, 0.18, id, cx, base + 0.09, cz, null, null, 0.55);
      // Ceiling built as four bands around a shell hole, so daylight from the
      // floor above rakes down into the room.
      const hx = cx + (rnd() - 0.5) * (iw - 4), hz = cz + (rnd() - 0.5) * (id - 4);
      const hw = 2.2, hd = 2.0, cy = base + GROUND_H - 0.12;
      const bands = [
        [cx, cz - id / 2 + (hz - hd / 2 - (cz - id / 2)) / 2, iw, hz - hd / 2 - (cz - id / 2)],
        [cx, hz + hd / 2 + (cz + id / 2 - (hz + hd / 2)) / 2, iw, cz + id / 2 - (hz + hd / 2)],
        [cx - iw / 2 + (hx - hw / 2 - (cx - iw / 2)) / 2, hz, hx - hw / 2 - (cx - iw / 2), hd],
        [hx + hw / 2 + (cx + iw / 2 - (hx + hw / 2)) / 2, hz, cx + iw / 2 - (hx + hw / 2), hd],
      ];
      for (const [bx, bz, bw, bd] of bands) {
        if (bw < 0.05 || bd < 0.05) continue;
        this._box('concreteDark', bw, 0.24, bd, bx, cy, bz, null, null, 0.55);
      }
      this._rubblePile(hx, hz, 2.4, 0.6, rnd);

      // Partition wall with a knocked-through opening: interior sightline depth.
      const px = cx + (rnd() - 0.5) * iw * 0.3;
      for (const [z0, z1] of [[cz - id / 2, cz - 1.4], [cz + 1.2, cz + id / 2]]) {
        this._box('plasterB', 0.22, GROUND_H - 0.3, z1 - z0, px, base + (GROUND_H - 0.3) / 2, (z0 + z1) / 2, null, null, 0.45);
        this._collideBox(px, base + (GROUND_H - 0.3) / 2, (z0 + z1) / 2, 0.22, GROUND_H - 0.3, z1 - z0);
      }

      // Shop fittings: a counter, shelving, a scatter of crates and drums.
      const bxp = cx - iw / 2 + 1.4;
      this._box('wood', 0.7, 0.95, 3.2, bxp, base + 0.55, cz + 1.0, null, null, 1.0);
      this._collideBox(bxp, base + 0.55, cz + 1.0, 0.7, 0.95, 3.2, 0, SURFACE.WOOD);
      for (let s = 0; s < 3; s++) {
        this._box('wood', 0.42, 0.06, 3.0, cx + iw / 2 - 0.5, base + 0.7 + s * 0.75, cz - 1.4, null, null, 1.4);
      }
      for (let i = 0; i < 7; i++) {
        const ox = cx + (rnd() - 0.5) * (iw - 1.6), oz = cz + (rnd() - 0.5) * (id - 1.6);
        this._scatterAdd(rnd() < 0.5 ? 'crate' : 'drum',
          mat(ox, base + 0.1, oz, rnd() * 6.28), _col.setHSL(0.08, 0.2, 0.6 + rnd() * 0.3).clone());
      }

      // The practical itself. No shadow map — the contrast is the point, not
      // the shadow, and shadowed point lights are the wrong thing to spend
      // a software rasteriser's budget on.
      if (spec.interiorLight && this.lighting?.addLocal) {
        const l = new THREE.PointLight(0xffa04a, 26, 16, 2);
        l.position.set(cx, base + 2.6, cz);
        l.castShadow = false;
        this.lighting.addLocal(l);
        // A bare bulb so the source is visible from the doorway.
        this._box('lamp', 0.1, 0.14, 0.1, cx, base + 2.62, cz, null, null, 1.0);
        this._addWire([
          new THREE.Vector3(cx, base + GROUND_H - 0.2, cz),
          new THREE.Vector3(cx, base + 2.7, cz),
        ], 0.011, new THREE.Color(0x2a251e));
      }
    }
  }

  // --- street furniture -----------------------------------------------------

  _buildStreetFurniture() {
    const rnd = mulberry32(this.seed + 77);

    // Street lamps down both kerbs. The heads carry emissive so they still
    // register as light sources in the golden-hour pass.
    const lampX = [-88, -70, -50, -30, 30, 50, 70, 88];
    for (const x of lampX) {
      for (const side of [-1, 1]) {
        const z = side * (ROAD_HALF + 0.9);
        this._streetLamp(x, z, side < 0 ? 0 : Math.PI, rnd);
      }
    }
    for (const [x, z, ry] of [[-PLAZA + 2, -10, 0], [PLAZA - 2, 10, Math.PI], [-PLAZA + 2, 14, 0], [PLAZA - 2, -14, Math.PI]]) {
      this._streetLamp(x, z, ry, rnd);
    }

    // Checkpoint across the eastern approach: Jersey barriers chicaned so the
    // road is never a clean corridor, backed by a sandbag position.
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const bx = 24 + i * 0.9;
      const bz = -ROAD_HALF + 1.2 + t * (ROAD_HALF * 2 - 2.4);
      this._barrier(bx + (rnd() - 0.5), bz, 0.12 + (rnd() - 0.5) * 0.25, rnd);
    }
    for (let i = 0; i < 4; i++) this._barrier(-30 + i * 2.35, -ROAD_HALF - 1.4, 0.02, rnd);
    for (let i = 0; i < 3; i++) this._barrier(8 + i * 2.35, PLAZA - 3.5, Math.PI / 2 + 0.03, rnd);

    this._sandbagWall(20.5, 3.2, 5.2, Math.PI / 2 + 0.06, 3, rnd);
    this._sandbagWall(-19, -9.5, 4.4, 0.04, 3, rnd);
    this._sandbagWall(-6.5, 18.5, 5.0, 0.5, 2, rnd);
    // One position up on the roof of the stair building, visible from the street.
    const stairSpec = this._plan.find((s) => s.roofAccess);
    if (stairSpec) {
      this._sandbagWall(stairSpec._cx + 1.5, stairSpec._cz + stairSpec._d / 2 - 2.2,
        4.0, 0.0, 2, rnd, stairSpec._base + stairSpec._H);
    }

    // Concrete bollards along the plaza frontage.
    for (let i = 0; i < 12; i++) {
      const bx = -19 + i * 3.4;
      const bz = -PLAZA + WALK_W + 0.4;
      const gy = this._groundY(bx, bz);
      this._stage('concrete', cylGeo(0.14, 0.17, 0.85, 8, 1.0).translate(bx, gy + 0.42, bz));
      this._collideBox(bx, gy + 0.42, bz, 0.34, 0.85, 0.34);
    }
  }

  _streetLamp(x, z, ry, rnd) {
    const gy = this._groundY(x, z);
    const H = 5.6 + rnd() * 0.8;
    const m = mat(x, gy, z, ry);
    this._box('concrete', 0.5, 0.22, 0.5, 0, 0.11, 0, m, null, 1.0);
    this._stage('metal', cylGeo(0.075, 0.115, H, 8, 0.8).translate(0, H / 2, 0).applyMatrix4(m));
    // Curved gallows arm, approximated by two segments so it silhouettes well.
    const a1 = boxGeo(0.09, 0.09, 1.0, 1.5);
    a1.applyMatrix4(mat(0, H - 0.25, 0.42, 0, -0.75));
    this._stage('metal', a1.applyMatrix4(m));
    const a2 = boxGeo(0.09, 0.09, 0.9, 1.5);
    a2.applyMatrix4(mat(0, H + 0.15, 1.15, 0, -0.18));
    this._stage('metal', a2.applyMatrix4(m));
    this._box('lamp', 0.34, 0.16, 0.68, 0, H + 0.18, 1.6, m, null, 1.2);
    this._box('lamp', 0.28, 0.05, 0.56, 0, H + 0.07, 1.6, m, null, 1.2);
    this._collideBox(x, gy + H / 2, z, 0.24, H, 0.24, 0, SURFACE.METAL);
  }

  /**
   * Classic F-shape Jersey profile, extruded and dropped onto the ground.
   *
   * The extrusion is faceted and re-UV'd before it is used. ExtrudeGeometry
   * hands back smoothed normals across the profile corners and UVs in raw shape
   * units, and the two together flatten the moulding completely: the sloped
   * toe, the vertical face and the top all resolve to one tone, and a solid
   * 82 cm of concrete ends up reading as a translucent card standing on the
   * road. Hard normals give each plane its own value again.
   */
  _barrier(x, z, ry, rnd) {
    if (!this._barrierGeo) {
      const s = new THREE.Shape();
      s.moveTo(-0.31, 0); s.lineTo(0.31, 0); s.lineTo(0.31, 0.09);
      s.lineTo(0.155, 0.33); s.lineTo(0.115, 0.82); s.lineTo(-0.115, 0.82);
      s.lineTo(-0.155, 0.33); s.lineTo(-0.31, 0.09); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: 2.2, bevelEnabled: false, steps: 1 });
      g.translate(0, 0, -1.1);
      this._barrierGeo = worldUV(facet(g), 0.85);
    }
    const gy = this._groundY(x, z);
    this._scatterAdd('barrier', mat(x, gy, z, ry, 0, (rnd() - 0.5) * 0.05),
      _col.setHSL(0.09, 0.05, 0.60 + rnd() * 0.26).clone());
    this._collideBox(x, gy + 0.41, z, 0.62, 0.82, 2.2, ry);
  }

  /**
   * Sandbag emplacement: courses laid with an alternating half-bag offset and
   * a stepped-back top, exactly the way they are actually stacked.
   */
  _sandbagWall(x, z, length, ry, courses, rnd, baseY = null) {
    const gy = baseY ?? this._groundY(x, z);
    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (let c = 0; c < courses; c++) {
      const inset = c * 0.12;
      const len = length - inset * 2;
      const n = Math.max(1, Math.round(len / 0.52));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5 + (c % 2 ? 0.25 / n : 0);
        const off = t * len;
        const px = x + cos * off + (rnd() - 0.5) * 0.05;
        const pz = z - sin * off + (rnd() - 0.5) * 0.05;
        const py = gy + 0.115 + c * 0.215;
        this._scatterAdd('sandbag',
          mat(px, py, pz, ry + (rnd() - 0.5) * 0.22, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.1),
          _col.setHSL(0.11, 0.13 + rnd() * 0.1, 0.5 + rnd() * 0.28).clone());
      }
    }
    this._collideBox(x, gy + courses * 0.215 / 2, z, length, courses * 0.215, 0.55, ry, SURFACE.SAND);
    // Kit dumped behind the position sells it as occupied.
    for (let i = 0; i < 3; i++) {
      const off = (rnd() - 0.5) * length;
      this._scatterAdd(rnd() < 0.5 ? 'crate' : 'drum',
        mat(x + cos * off - sin * (0.9 + rnd() * 0.6), gy, z - sin * off - cos * (0.9 + rnd() * 0.6), rnd() * 6.28),
        _col.setHSL(0.09, 0.2, 0.55 + rnd() * 0.3).clone());
    }
  }

  // --- vehicle wrecks -------------------------------------------------------

  /**
   * Burnt-out saloon. Built as an open cage — pillars and a roof panel rather
   * than a solid cabin — so you can see straight through the window apertures,
   * which is what makes a wreck read as gutted rather than as a grey box.
   */
  _wreck(x, z, ry, rnd, variant = 0) {
    const gy = this._groundY(x, z);
    const roll = (rnd() - 0.5) * 0.06;
    const m = mat(x, gy, z, ry, 0, roll);
    const noRoof = variant === 1;
    const flipped = variant === 2;
    const M = flipped ? mat(x, gy + 1.2, z, ry, 0, 2.9) : m;

    // Faded paint still on the panels, soot on everything structural. Without
    // the split the whole car resolved to one near-black value and every wreck
    // in the level rendered as a flat silhouette with no shading at all.
    const paint = [
      new THREE.Color(1.15, 1.12, 1.05), new THREE.Color(0.82, 0.92, 1.05),
      new THREE.Color(1.12, 0.98, 0.78), new THREE.Color(0.95, 0.80, 0.74),
      new THREE.Color(0.88, 0.94, 0.86),
    ][(rnd() * 5) | 0];
    const soot = new THREE.Color(0.62, 0.60, 0.58);

    this._box('burnt', 4.15, 0.2, 1.72, 0, 0.46, 0, M, soot, 1.0);         // floor pan
    for (const sz of [-1, 1]) this._box('burnt', 4.15, 0.66, 0.14, 0, 0.78, sz * 0.85, M, paint, 1.0);
    for (const sx of [-1, 1]) this._box('burnt', 0.16, 0.66, 1.72, sx * 2.0, 0.78, 0, M, paint, 1.0);
    this._box('burnt', 1.3, 0.14, 1.7, 1.35, 1.12, 0, M, paint, 1.0);       // bonnet
    this._box('burnt', 1.05, 0.14, 1.7, -1.5, 1.12, 0, M, paint, 1.0);      // boot lid
    this._box('burnt', 0.14, 0.52, 1.62, 0.72, 1.35, 0, M, soot, 1.0);      // firewall
    this._box('burnt', 0.14, 0.42, 1.62, -1.0, 1.3, 0, M, soot, 1.0);       // rear bulkhead
    for (const sx of [-1, 1]) this._box('rust', 0.2, 0.24, 1.9, sx * 2.12, 0.85, 0, M, null, 1.2);
    this._box('charred', 1.2, 0.42, 1.55, 1.36, 1.05, 0, M, null, 0.8);     // gutted engine bay
    // Seat frames.
    for (const sz of [-0.42, 0.42]) {
      this._box('charred', 0.5, 0.12, 0.5, -0.05, 0.85, sz, M, null, 1.4);
      this._box('charred', 0.12, 0.62, 0.5, -0.3, 1.16, sz, M, null, 1.4);
    }
    if (!noRoof) {
      this._box('burnt', 1.6, 0.09, 1.5, -0.35, 1.86, 0, M, paint, 1.0);
      for (const sz of [-1, 1]) {
        const a = boxGeo(0.11, 0.95, 0.11, 1.6);
        a.applyMatrix4(mat(0.62, 1.42, sz * 0.74, 0, 0, -0.42));
        this._stage('burnt', a.applyMatrix4(M), null, paint);
        const b = boxGeo(0.11, 0.9, 0.11, 1.6);
        b.applyMatrix4(mat(-1.15, 1.4, sz * 0.74, 0, 0, 0.2));
        this._stage('burnt', b.applyMatrix4(M), null, paint);
        this._box('burnt', 1.7, 0.09, 0.1, -0.35, 1.82, sz * 0.78, M, paint, 1.4);
      }
    }
    // Wheels: some burnt down to the rim, some gone entirely.
    const hubs = [[1.32, 0.86], [1.32, -0.86], [-1.32, 0.86], [-1.32, -0.86]];
    for (let i = 0; i < 4; i++) {
      const missing = rnd() < 0.3;
      const g = cylGeo(missing ? 0.22 : 0.35, missing ? 0.22 : 0.35, missing ? 0.14 : 0.24, 10, 1.2);
      g.applyMatrix4(mat(hubs[i][0], 0.34, hubs[i][1], 0, 0, Math.PI / 2));
      this._stage(missing ? 'rust' : 'rubber', g.applyMatrix4(M));
      this._box('burnt', 1.15, 0.5, 0.16, hubs[i][0], 0.85, hubs[i][1] * 1.02, M, paint, 1.2);  // arch
    }
    this._collideBox(x, gy + 0.9, z, 4.2, flipped ? 1.4 : 1.7, 1.9, ry, SURFACE.METAL);
    // Scorch halo and shed debris around the wreck.
    for (let i = 0; i < 9; i++) {
      const a = rnd() * 6.28, r = 1.8 + rnd() * 2.6;
      this._scatterAdd('debris', mat(x + Math.cos(a) * r, this._groundY(x + Math.cos(a) * r, z + Math.sin(a) * r) + 0.03,
        z + Math.sin(a) * r, rnd() * 6.28, 0, 0).scale(_v.set(0.6 + rnd(), 0.5, 0.6 + rnd())),
        _col.setRGB(0.3, 0.28, 0.26).clone());
    }
  }

  _buildWrecks() {
    const rnd = mulberry32(this.seed + 55);
    const list = [
      [-9.5, 2.6, 0.42, 0], [15.5, -3.4, 2.6, 1], [30, 4.6, 1.1, 2],
      [-2, -13, 3.9, 0], [-33, 3.1, 0.2, 1], [46, -2.2, 2.2, 0],
      [7.5, 15.5, 1.9, 1], [-17.0, 15.5, 0.7, 0],
    ];
    for (const [x, z, ry, v] of list) this._wreck(x, z, ry, rnd, v);
  }

  // --- market ---------------------------------------------------------------

  /**
   * The plaza market. Cloth catches and scatters light better than anything
   * else in the kit, so the stalls are clustered where the two camera poses
   * that look across the plaza will read them against the shaded south row.
   */
  _buildMarket() {
    const rnd = mulberry32(this.seed + 202);
    const stalls = [
      [-15, 12.5, 0.06], [-10.5, 13.2, -0.1], [-6, 12.8, 0.04],
      [-14.2, 17.5, Math.PI + 0.05], [-9.6, 18.1, Math.PI - 0.08],
      [6.5, 12.4, 0.1], [11.2, 13.0, -0.05], [12.5, -12.8, Math.PI + 0.1],
      [-16.5, -12.4, 0.02],
    ];
    for (const [x, z, ry] of stalls) this._stall(x, z, ry, rnd);
  }

  _stall(x, z, ry, rnd) {
    const gy = this._groundY(x, z);
    const m = mat(x, gy, z, ry);
    const w = 2.9, dp = 1.9, postH = 2.35;
    const tint = [
      new THREE.Color(0.86, 0.31, 0.24), new THREE.Color(0.28, 0.44, 0.62),
      new THREE.Color(0.38, 0.56, 0.34), new THREE.Color(0.92, 0.8, 0.5),
      new THREE.Color(0.72, 0.62, 0.86),
    ][(rnd() * 5) | 0];

    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this._box('wood', 0.09, postH, 0.09, sx * w / 2, postH / 2, sz * dp / 2, m, null, 2.0);
    }
    this._box('wood', w + 0.2, 0.1, 0.09, 0, postH, dp / 2, m, null, 1.6);
    this._box('wood', w + 0.2, 0.1, 0.09, 0, postH + 0.35, -dp / 2, m, null, 1.6);
    // Single-pitch canvas roof falling toward the customer side.
    const roof = boxGeo(w + 0.5, 0.04, dp + 0.85, 1.0);
    roof.applyMatrix4(mat(0, postH + 0.2, 0.15, 0, -0.2));
    this._stage('fabric', roof.applyMatrix4(m), null, tint);
    this._box('fabric', w + 0.5, 0.34, 0.02, 0, postH - 0.12, dp / 2 + 0.42, m, tint, 1.4);
    // Counter and a stack of produce boxes on it.
    this._box('wood', w, 0.1, dp * 0.8, 0, 0.92, 0, m, null, 1.2);
    this._box('wood', w, 0.85, 0.07, 0, 0.45, dp * 0.4, m, null, 1.2);
    this._collideBox(x, gy + 0.5, z, w, 1.0, dp * 0.8, ry, SURFACE.WOOD);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this._collideBox(x + Math.cos(ry) * sx * w / 2 + Math.sin(ry) * sz * dp / 2, gy + postH / 2,
        z - Math.sin(ry) * sx * w / 2 + Math.cos(ry) * sz * dp / 2, 0.14, postH, 0.14, ry, SURFACE.WOOD);
    }
    for (let i = 0; i < 4 + ((rnd() * 4) | 0); i++) {
      const ox = (rnd() - 0.5) * (w - 0.6), oz = (rnd() - 0.5) * dp * 0.5;
      const g = boxGeo(0.42, 0.26, 0.34, 1.6);
      g.applyMatrix4(mat(ox, 1.1, oz, rnd() * 0.6 - 0.3));
      this._stage('wood', g.applyMatrix4(m), null, _col.setHSL(0.09, 0.25, 0.6 + rnd() * 0.3).clone());
    }
    // Goods stacked underneath and alongside.
    for (let i = 0; i < 3; i++) {
      const a = rnd() * 6.28, r = 1.5 + rnd() * 1.4;
      this._scatterAdd(rnd() < 0.6 ? 'crate' : 'pallet',
        mat(x + Math.cos(a) * r, this._groundY(x, z), z + Math.sin(a) * r, rnd() * 6.28),
        _col.setHSL(0.09, 0.22, 0.55 + rnd() * 0.35).clone());
    }
  }

  // --- clutter --------------------------------------------------------------

  /** Prototype geometry for every instanced prop kind. */
  _scatterProto(kind, rnd) {
    switch (kind) {
      case 'rubble': return { geo: rockGeo(0.5, rnd), mat: 'concrete', cast: true };
      case 'brickChunk': return { geo: rockGeo(0.38, rnd), mat: 'brick', cast: true };
      case 'debris': return { geo: boxGeo(0.34, 0.05, 0.26, 1.6), mat: 'concreteDark', cast: false };
      case 'sandbag': {
        const g = new THREE.SphereGeometry(0.5, 6, 4);
        g.scale(1.05, 0.42, 0.62);
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.4, uv.getY(i) * 0.9);
        return { geo: g, mat: 'sandbag', cast: true };
      }
      case 'drum': {
        const body = cylGeo(0.3, 0.3, 0.88, 12, 1.0).translate(0, 0.44, 0);
        const r1 = cylGeo(0.325, 0.325, 0.06, 12, 1.0).translate(0, 0.26, 0);
        const r2 = cylGeo(0.325, 0.325, 0.06, 12, 1.0).translate(0, 0.62, 0);
        const lid = cylGeo(0.31, 0.31, 0.04, 12, 1.0).translate(0, 0.9, 0);
        return { geo: mergeGeometries([body, r1, r2, lid]), mat: 'rust', cast: true };
      }
      case 'tyre': {
        const g = new THREE.TorusGeometry(0.33, 0.13, 7, 14);
        g.rotateX(Math.PI / 2).translate(0, 0.14, 0);
        return { geo: g, mat: 'rubber', cast: true };
      }
      case 'crate': {
        const parts = [boxGeo(0.72, 0.6, 0.72, 1.5).translate(0, 0.3, 0)];
        // Corner battens so the silhouette is not a perfect cube.
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          parts.push(boxGeo(0.08, 0.64, 0.08, 2.5).translate(sx * 0.36, 0.32, sz * 0.36));
        }
        return { geo: mergeGeometries(parts), mat: 'wood', cast: true };
      }
      case 'pallet': {
        const parts = [];
        for (let i = 0; i < 5; i++) parts.push(boxGeo(1.1, 0.035, 0.14, 1.6).translate(0, 0.15, -0.45 + i * 0.225));
        for (let i = 0; i < 3; i++) parts.push(boxGeo(0.1, 0.11, 1.1, 1.6).translate(-0.45 + i * 0.45, 0.06, 0));
        return { geo: mergeGeometries(parts), mat: 'wood', cast: true };
      }
      case 'barrier': return { geo: this._barrierGeo, mat: 'barrier', cast: true };
      default: return null;
    }
  }

  _buildClutter() {
    const rnd = mulberry32(this.seed + 1717);

    // Rubble banked against every street-facing wall, heaviest at the corners.
    for (const f of this._footprints) {
      for (let i = 0; i < 3; i++) {
        const alongX = rnd() < 0.5;
        const x = alongX ? lerp(f.x0, f.x1, rnd()) : (rnd() < 0.5 ? f.x0 : f.x1) + (rnd() - 0.5) * 1.2;
        const z = alongX ? (rnd() < 0.5 ? f.z0 : f.z1) + (rnd() - 0.5) * 1.2 : lerp(f.z0, f.z1, rnd());
        if (Math.abs(x) > MAP_X - 6 || Math.abs(z) > MAP_Z - 6) continue;
        this._rubblePile(x, z, 1.4 + rnd() * 2.2, 0.5 + rnd() * 0.7, rnd);
      }
    }

    // Loose ground clutter across the playable core.
    const free = (x, z) => this._wallDistance(x, z) > 0.6 && Math.hypot(x * 0.55, z) < 92;
    for (let i = 0; i < 520; i++) {
      const x = (rnd() * 2 - 1) * 95, z = (rnd() * 2 - 1) * 46;
      if (!free(x, z)) continue;
      const s = 0.5 + rnd() * 1.3;
      this._scatterAdd('debris',
        mat(x, this._groundY(x, z) + 0.025, z, rnd() * 6.28, 0, (rnd() - 0.5) * 0.2).scale(_v.set(s, 1, s)),
        _col.setHSL(0.09, 0.06 + rnd() * 0.1, 0.42 + rnd() * 0.45).clone());
    }
    for (let i = 0; i < 170; i++) {
      const x = (rnd() * 2 - 1) * 80, z = (rnd() * 2 - 1) * 40;
      if (!free(x, z)) continue;
      const s = 0.28 + rnd() * 0.7;
      this._scatterAdd(rnd() < 0.6 ? 'rubble' : 'brickChunk',
        mat(x, this._groundY(x, z) + s * 0.12, z, rnd() * 6.28, rnd(), rnd()).scale(_v.set(s, s, s)),
        _col.setHSL(0.09, 0.09, 0.5 + rnd() * 0.4).clone());
    }

    // Deliberate prop clusters at readable ranges: cover to move between.
    const clusters = [
      [-20, 5.5], [-13, -6.5], [4.5, -8], [12, 6.5], [24, -8], [-27, -3],
      [36, 3], [-40, -4.5], [-46, 5], [52, -5], [-3, 19], [17, 17.5],
      [-34.5, -18], [-56, 14], [-34, 20], [40, 14], [-9, -19], [26, 15],
    ];
    for (const [cx, cz] of clusters) {
      const n = 3 + ((rnd() * 5) | 0);
      for (let i = 0; i < n; i++) {
        const a = rnd() * 6.28, r = rnd() * 2.4;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        if (!free(x, z)) continue;
        const roll = rnd();
        const kind = roll < 0.3 ? 'drum' : roll < 0.55 ? 'crate' : roll < 0.75 ? 'tyre' : roll < 0.9 ? 'pallet' : 'rubble';
        const gy = this._groundY(x, z);
        const tipped = kind === 'drum' && rnd() < 0.35;
        const m = tipped
          ? mat(x, gy + 0.3, z, rnd() * 6.28, 0, Math.PI / 2)
          : mat(x, gy, z, rnd() * 6.28, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.08);
        if (kind === 'rubble') m.scale(_v.set(0.8, 0.8, 0.8));
        this._scatterAdd(kind, m, _col.setHSL(0.08 + rnd() * 0.04, 0.15 + rnd() * 0.2, 0.5 + rnd() * 0.4).clone());
        if (kind === 'drum' || kind === 'crate') {
          this._collideBox(x, gy + 0.45, z, 0.75, 0.9, 0.75, 0,
            kind === 'drum' ? SURFACE.METAL : SURFACE.WOOD);
        }
        // Stack the occasional second tier — vertical cover reads much better.
        if ((kind === 'crate' || kind === 'tyre') && rnd() < 0.45) {
          this._scatterAdd(kind, mat(x, gy + (kind === 'crate' ? 0.62 : 0.28), z, rnd() * 6.28),
            _col.setHSL(0.09, 0.2, 0.55 + rnd() * 0.35).clone());
        }
      }
    }

    // Realise every queued kind as a single InstancedMesh.
    for (const [kind, list] of this._scatter) {
      if (!list.length) continue;
      const proto = this._scatterProto(kind, mulberry32(this.seed + kind.length * 31));
      if (!proto || !proto.geo) continue;
      const mesh = new THREE.InstancedMesh(proto.geo, this._mat(proto.mat, true), list.length);
      for (let i = 0; i < list.length; i++) {
        mesh.setMatrixAt(i, list[i].m);
        if (list[i].c) mesh.setColorAt(i, list[i].c);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = proto.cast;
      mesh.receiveShadow = true;
      mesh.userData.noCollide = true;
      mesh.name = `scatter_${kind}`;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }
    this._scatter.clear();
  }

  // --- overhead cabling -----------------------------------------------------

  /**
   * Cables as screen-space ribbons.
   *
   * A 3 cm tube is sub-pixel past about fifteen metres, and a sub-pixel dark
   * tube on a software rasteriser is not a wire, it is a chain of stair-stepped
   * black dots — which is why the runs used to read as scratches on the lens.
   * The fix is the standard one for hair and wires: expand each segment into a
   * quad in clip space, clamp its width to a screen-space floor, and pay for the
   * clamp with alpha so total ink is conserved and distant runs simply go grey.
   *
   * Built as MeshBasic rather than a raw ShaderMaterial specifically so it
   * inherits Sky's aerial-perspective fog chunks through the normal ShaderLib
   * path: distant cabling then takes the colour of the haze it hangs in.
   */
  _wireMaterial() {
    if (this._wireMat) return this._wireMat;
    this._wireRes = { value: new THREE.Vector2(1280, 720) };
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, fog: true,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uWireRes = this._wireRes;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>',
          '#include <common>\n'
          + 'attribute vec3 aNext;\n'
          + 'attribute vec2 aSide;      // x: -1/+1 across the ribbon, y: real radius (m)\n'
          + 'uniform vec2 uWireRes;\n'
          + 'varying vec3 vWire;        // x: side, y: half width (px), z: coverage')
        .replace('#include <project_vertex>',
          '#include <project_vertex>\n'
          + '{\n'
          + '  vec4 cB = projectionMatrix * (modelViewMatrix * vec4(aNext, 1.0));\n'
          + '  vec2 sA = gl_Position.xy / max(1e-4, abs(gl_Position.w)) * uWireRes;\n'
          + '  vec2 sB = cB.xy / max(1e-4, abs(cB.w)) * uWireRes;\n'
          + '  vec2 dv = sB - sA;\n'
          + '  float dl = length(dv);\n'
          + '  vec2 nrm = dl > 1e-4 ? vec2(dv.y, -dv.x) / dl : vec2(0.0, 1.0);\n'
          + '  float pxPerM = uWireRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -mvPosition.z);\n'
          + '  float trueHalf = aSide.y * pxPerM;\n'
          + '  float halfPx = max(trueHalf, 0.80);\n'
          + '  vWire = vec3(aSide.x, halfPx, clamp(trueHalf / halfPx, 0.30, 1.0));\n'
          + '  gl_Position.xy += nrm * aSide.x * (halfPx * 2.0 / uWireRes) * gl_Position.w;\n'
          + '}');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWire;')
        .replace('#include <alphamap_fragment>',
          '#include <alphamap_fragment>\n'
          // Soft edge one texel wide however far away the run is, and the
          // coverage term gives back the ink the width floor took away.
          + 'diffuseColor.a *= vWire.z * clamp((1.0 - abs(vWire.x)) * vWire.y * 1.7, 0.0, 1.0);');
    };
    m.customProgramCacheKey = () => 'levelWireRibbon';
    this._wireMat = m;
    return m;
  }

  /** Stage a polyline as a ribbon. Points are consumed, not retained. */
  _addWire(points, radius = 0.028, tint = null, matrix = null) {
    if (points.length < 2) return;
    if (!this._wires) this._wires = { pos: [], next: [], side: [], col: [], idx: [], n: 0 };
    const W = this._wires;
    if (matrix) for (const p of points) p.applyMatrix4(matrix);
    const c = tint || _col.setHex(0x211d18);
    const base = W.n;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      // The last vertex has no successor, so mirror the previous segment: the
      // ribbon keeps its orientation instead of collapsing at the end cap.
      const q = i < points.length - 1 ? points[i + 1]
        : _v.copy(p).multiplyScalar(2).sub(points[i - 1]);
      for (const s of [-1, 1]) {
        W.pos.push(p.x, p.y, p.z);
        W.next.push(q.x, q.y, q.z);
        W.side.push(s, radius);
        W.col.push(c.r, c.g, c.b);
      }
      W.n += 2;
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = base + i * 2;
      W.idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }

  /** Sample a sagging span. Parabolic, which is a catenary to within a pixel. */
  _catenary(a, b, sag, segs = 10) {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = a.clone().lerp(b, t);
      p.y -= sag * 4 * t * (1 - t);
      pts.push(p);
    }
    return pts;
  }

  /** Every wire in the level as one mesh — and therefore one draw call. */
  _flushWires() {
    const W = this._wires;
    if (!W || !W.n) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(W.pos), 3));
    geo.setAttribute('aNext', new THREE.BufferAttribute(new Float32Array(W.next), 3));
    geo.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(W.side), 2));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(W.col), 3));
    geo.setIndex(W.n > 65535 ? new THREE.BufferAttribute(new Uint32Array(W.idx), 1)
      : new THREE.BufferAttribute(new Uint16Array(W.idx), 1));
    geo.computeBoundingSphere();
    // The ribbon grows in screen space beyond the vertices it was built from,
    // so pad the bound or a close-up run culls itself out of the frame.
    if (geo.boundingSphere) geo.boundingSphere.radius += 3;
    const mesh = new THREE.Mesh(geo, this._wireMaterial());
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    mesh.userData.noCollide = true;
    mesh.name = 'cables';
    this.root.add(mesh);
    this._wires = null;
  }

  /**
   * Sagging power and telephone lines. They cost almost nothing and they do
   * more for a street's sense of enclosure than another building would: every
   * frame gets a set of dark curves crossing the sky.
   */
  _buildCables() {
    const rnd = mulberry32(this.seed + 1234);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const power = new THREE.Color(0x1e1a15);
    const phone = new THREE.Color(0x35302a);
    const add = (a, b, sag, r = 0.028, c = power, segs = 10) =>
      this._addWire(this._catenary(a, b, sag, segs), r, c);

    // Cross-street spans between the two rows. Sag varies per run, not per
    // bundle: real spans of the same length droop by roughly the same amount.
    for (let x = -84; x < 92; x += 11 + rnd() * 7) {
      if (Math.abs(x) < PLAZA - 4) continue;
      const y = 7.4 + rnd() * 3.2;
      const sag = 1.4 + rnd() * 1.5;
      for (let k = 0; k < 2 + ((rnd() * 2) | 0); k++) {
        add(V(x + k * 0.35, y, -ROAD_HALF - 3.4), V(x + k * 0.35, y - 0.4, ROAD_HALF + 3.4),
          sag + k * 0.12, 0.026 + rnd() * 0.012);
      }
    }
    // Lines running with the street, hopping pole to pole.
    for (const side of [-1, 1]) {
      let px = -88;
      let py = 6.6 + rnd();
      while (px < 88) {
        const nx = px + 16 + rnd() * 8;
        const ny = 6.4 + rnd() * 1.6;
        const sag = 1.0 + rnd() * 1.1;
        for (let k = 0; k < 3; k++) {
          add(V(px, py - k * 0.28, side * (ROAD_HALF + 1.0 + k * 0.1)),
            V(nx, ny - k * 0.28, side * (ROAD_HALF + 1.0 + k * 0.1)),
            sag + k * 0.1, 0.019 + rnd() * 0.008, k ? phone : power, 12);
        }
        px = nx; py = ny;
      }
    }
    // Alley crossings — low, dense, and the thing that frames the alley shot.
    const alleys = [[-36.3, -12, -30], [-54.2, -12, -30], [42.2, -12, -30], [46.2, 12, 30], [-54.2, 12, 30]];
    for (const [x, z0, z1] of alleys) {
      for (let i = 0; i < 6; i++) {
        const z = lerp(z0, z1, (i + 0.5) / 6);
        const y = 3.5 + rnd() * 3.8;
        const a = V(x - 2.6, y, z);
        const b = V(x + 2.6, y - 0.3, z + (rnd() - 0.5) * 1.5);
        const sag = 0.45 + rnd() * 0.6;
        if (y < 6.3 && rnd() < 0.85) {
          // Washing line: heavier cord, and the sheets hang off the actual
          // curve rather than floating in the air near it.
          add(a, b, sag, 0.016, new THREE.Color(0x8d8272), 12);
          this._washingRun(a, b, sag, rnd);
        } else {
          add(a, b, sag, 0.022, phone);
        }
      }
    }
    // Plaza banner run across the open space, a big readable diagonal.
    add(V(-PLAZA + 3, 9.5, -PLAZA + 4), V(PLAZA - 4, 8.8, -6), 2.4, 0.03, power, 14);
    add(V(-PLAZA + 3, 8.2, 8), V(PLAZA - 4, 9.2, PLAZA - 5), 2.2, 0.03, power, 14);
  }

  // --- navigation and poses -------------------------------------------------

  _defineNavigation() {
    const P = (x, z, y = 0.2) => new THREE.Vector3(x, this._groundY(x, z) + y, z);
    // Spawns sit in cover at both ends of the boulevard and behind the plaza
    // frontages, so AI never materialises in the middle of a camera pose.
    this.spawnPoints = [
      P(-46, 3), P(-40, -4), P(-58, 4.5), P(44, -3), P(52, 4), P(60, -4),
      P(-34.3, -22), P(-18, 17), P(14, -16), P(0, 19),
    ];
    // Patrol seeds trace the boulevard, both alleys and the plaza loop.
    this.patrolPoints = [
      P(-70, 0), P(-50, 3), P(-30, -3), P(-16, 4), P(0, 0), P(16, -4),
      P(32, 3), P(52, 0), P(72, 2), P(-34.3, -18), P(-34.3, -28),
      P(46.2, 20), P(-12, 15), P(12, 14), P(-18, -14), P(16, -16),
      P(-6, -19), P(20, 17), P(-24, 8), P(28, -9),
    ];
  }

  /**
   * The five judged frames. Each is composed rather than sampled: a foreground
   * element for depth, a mid-ground subject, a landmark on a third, and a light
   * direction chosen so the frame has a lit side and a shadow side.
   */
  _definePoses() {
    const at = (x, z) => this._groundY(x, z) + 0.05;
    this.cameraPoses = {
      // Standing on the plaza's western kerb looking east down the boulevard,
      // into the morning sun: lit north row on the left, the shaded south row
      // and its shadow spilling across the road on the right, the minaret on
      // the left third, wrecks and barriers stepping away into haze.
      hero: {
        position: [-27.5, at(-27.5, 2.6), 2.6], yaw: -1.485, pitch: -0.035, fov: 72,
      },
      // Deep in the alley beside the stair building, looking out toward the
      // bright street. Everything near-frame is in shadow; the exit glows.
      alley: {
        position: [-36.3, at(-36.3, -26.5), -26.5], yaw: Math.PI + 0.06, pitch: 0.05, fov: 70,
      },
      // Rooftop overwatch reached by the exterior staircase: parapet, sandbags
      // and dishes in the foreground, the plaza and minaret mid-frame, the far
      // rows and sky behind.
      skyline: {
        position: [-46.5, 14.4, -21.0], yaw: -2.28, pitch: -0.135, fov: 74, hideViewmodel: true,
      },
      // Four metres short of the checkpoint sandbags, looking along them into
      // the sun: bags and kit fill the near field, the barrier chicane and a
      // wreck stack the mid-ground, the eastern terrace closes it out.
      closeup: {
        position: [16.4, at(16.4, 3.4), 3.4], yaw: -1.60, pitch: -0.05, fov: 55,
      },
      // Late sun down the barrel of the street from the east end — everything
      // silhouettes, shadows run at the camera, the cabling reads as ink.
      goldenHour: {
        position: [34.0, at(34, 1.2), 1.2], yaw: 1.585, pitch: 0.015, fov: 70, timeOfDay: 17.2,
      },
    };

    // The capture harness sets camera.fov per pose, but the player's FOV spring
    // reclaims it on the next frame. Poses are level-authored composition, so
    // the level re-applies its own choice to the spring's rest value.
    const boot = this.engine.boot;
    if (boot?.capture) {
      const p = this.cameraPoses[boot.pose] || this.cameraPoses.hero;
      this._poseFov = p.fov || 0;
    }
  }

  /** Breakable/entity ray query used by ballistics. Static world is separate. */
  raycastEntities() { return null; }

  update() {
    // The cable ribbons size themselves in pixels, so they need the live
    // drawing-buffer size; it changes on every resize and on quality changes.
    if (this._wireRes) {
      this.engine.renderer.getDrawingBufferSize(_size);
      if (_size.x > 0) this._wireRes.value.copy(_size);
    }
    if (!this._poseFov) return;
    const player = this.engine.game?.player;
    if (player && player.fovBase !== this._poseFov) player.fovBase = this._poseFov;
  }
}
