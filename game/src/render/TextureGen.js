import * as THREE from 'three';
import { Simplex, fbm2, ridged2, worley2, clamp, lerp, smoothstep } from '../core/Noise.js';

/**
 * Procedural PBR material library. Nothing is downloaded — every albedo,
 * normal, roughness, AO, height and emissive map in the game is synthesised
 * here into offscreen canvases at load time.
 *
 * CONTRACT (relied on by Level/Weapons/Enemies/Particles/Decals):
 *   await lib.build(onProgress)          — generates everything
 *   lib.get(name)                        — { map, normalMap, roughnessMap, aoMap, ... }
 *   lib.material(name, opts)             — a shared MeshStandardMaterial
 *   lib.sprite(name)                     — a single THREE.Texture for billboards
 *   lib.list()                           — available material names
 *
 * Every set is tileable: generators wrap their noise domain at the tile period.
 */

const SIZE = { low: 256, medium: 512, high: 1024 };

export class TextureLibrary {
  constructor(renderer, seed = 1) {
    this.renderer = renderer;
    this.seed = seed;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.sets = new Map();
    this.materials = new Map();
    this.sprites = new Map();
    this.res = SIZE.high;
  }

  async build(onProgress = () => {}) {
    const jobs = this._jobs();
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      onProgress(i / jobs.length, `SYNTHESISING ${job.name.toUpperCase()}`);
      this.sets.set(job.name, job.make());
      // Yield so the loading bar actually animates.
      if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    onProgress(1, 'MATERIALS READY');
    return this;
  }

  _jobs() {
    return [
      { name: 'concrete', make: () => this._concrete() },
      { name: 'asphalt', make: () => this._asphalt() },
      { name: 'brick', make: () => this._brick() },
      { name: 'metalPanel', make: () => this._metalPanel() },
      { name: 'rustMetal', make: () => this._rustMetal() },
      { name: 'plaster', make: () => this._plaster() },
      { name: 'sand', make: () => this._sand() },
      { name: 'gunMetal', make: () => this._gunMetal() },
    ];
  }

  get(name) { return this.sets.get(name); }
  list() { return [...this.sets.keys()]; }

  material(name, opts = {}) {
    const key = name + JSON.stringify(opts);
    if (this.materials.has(key)) return this.materials.get(key);
    const set = this.sets.get(name);
    const mat = new THREE.MeshStandardMaterial({
      map: set?.map || null,
      normalMap: set?.normalMap || null,
      roughnessMap: set?.roughnessMap || null,
      aoMap: set?.aoMap || null,
      metalness: set?.metalness ?? 0,
      roughness: set?.roughness ?? 1,
      ...opts,
    });
    if (opts.repeat) this.setRepeat(mat, opts.repeat[0], opts.repeat[1]);
    this.materials.set(key, mat);
    return mat;
  }

  setRepeat(material, u, v) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'displacementMap']) {
      const t = material[k];
      if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(u, v); t.needsUpdate = true; }
    }
    return material;
  }

  // --- canvas helpers -------------------------------------------------------

  _canvas(size = this.res) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  _texture(canvas, { srgb = false, aniso = true } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso ? this.maxAniso : 1;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  /** Build a tangent-space normal map from a height field via Sobel. */
  _normalFromHeight(height, size, strength = 2.0) {
    const c = this._canvas(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
        const l = at(x - 1, y), r = at(x + 1, y);
        const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        let nx = -dx * strength, ny = -dy * strength, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const i = (y * size + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Screen-space-free ambient occlusion baked from the height field. */
  _aoFromHeight(height, size, radius = 6, strength = 1.0) {
    const c = this._canvas(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
    const dirs = 8;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const h0 = at(x, y);
        let occ = 0;
        for (let d = 0; d < dirs; d++) {
          const a = (d / dirs) * Math.PI * 2;
          const dx = Math.cos(a), dy = Math.sin(a);
          let maxSlope = 0;
          for (let s = 1; s <= radius; s++) {
            const hs = at(Math.round(x + dx * s), Math.round(y + dy * s));
            maxSlope = Math.max(maxSlope, (hs - h0) / s);
          }
          occ += clamp(maxSlope * 8, 0, 1);
        }
        occ = 1 - (occ / dirs) * strength;
        const v = clamp(occ, 0, 1) * 255;
        const i = (y * size + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  _grayCanvas(data, size) {
    const c = this._canvas(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < data.length; i++) {
      const v = clamp(data[i], 0, 1) * 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  _rgbCanvas(rgb, size) {
    const c = this._canvas(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      img.data[i * 4] = clamp(rgb[i * 3], 0, 1) * 255;
      img.data[i * 4 + 1] = clamp(rgb[i * 3 + 1], 0, 1) * 255;
      img.data[i * 4 + 2] = clamp(rgb[i * 3 + 2], 0, 1) * 255;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Assemble a finished PBR set from raw float buffers. */
  _pack(albedo, height, rough, size, { metalness = 0, normalStrength = 2.0, aoRadius = 6 } = {}) {
    return {
      map: this._texture(this._rgbCanvas(albedo, size), { srgb: true }),
      normalMap: this._texture(this._normalFromHeight(height, size, normalStrength)),
      roughnessMap: this._texture(this._grayCanvas(rough, size)),
      aoMap: this._texture(this._aoFromHeight(height, size, aoRadius)),
      metalness,
      roughness: 1,
      size,
    };
  }

  // --- generators -----------------------------------------------------------
  // Each returns a packed PBR set. These are intentionally simple baselines;
  // the material-authoring pass replaces them with layered, weathered versions.

  _concrete() {
    const N = this.res, n = new Simplex(this.seed + 11);
    const albedo = new Float32Array(N * N * 3);
    const height = new Float32Array(N * N);
    const rough = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = x / N * 6, v = y / N * 6;
        const grain = fbm2(n, u * 4, v * 4, 5) * 0.5 + 0.5;
        const blotch = fbm2(n, u * 0.7, v * 0.7, 3) * 0.5 + 0.5;
        const pit = worley2(u * 12, v * 12, 72, this.seed).f1;
        const h = grain * 0.55 + blotch * 0.3 + smoothstep(0.0, 0.25, pit) * 0.15;
        height[i] = h;
        const base = 0.44 + blotch * 0.16 + grain * 0.07;
        albedo[i * 3] = base * 1.02;
        albedo[i * 3 + 1] = base;
        albedo[i * 3 + 2] = base * 0.96;
        rough[i] = clamp(0.82 + grain * 0.14 - blotch * 0.06, 0, 1);
      }
    }
    return this._pack(albedo, height, rough, N, { normalStrength: 1.6 });
  }

  _asphalt() {
    const N = this.res, n = new Simplex(this.seed + 22);
    const albedo = new Float32Array(N * N * 3);
    const height = new Float32Array(N * N);
    const rough = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = x / N * 8, v = y / N * 8;
        const w = worley2(u * 9, v * 9, 72, this.seed + 3);
        const agg = smoothstep(0.02, 0.32, w.f1);
        const grain = fbm2(n, u * 9, v * 9, 4) * 0.5 + 0.5;
        const h = agg * 0.7 + grain * 0.3;
        height[i] = h;
        const base = 0.055 + agg * 0.05 + grain * 0.035;
        albedo[i * 3] = base;
        albedo[i * 3 + 1] = base * 1.01;
        albedo[i * 3 + 2] = base * 1.06;
        rough[i] = clamp(0.88 - agg * 0.16, 0, 1);
      }
    }
    return this._pack(albedo, height, rough, N, { normalStrength: 2.4 });
  }

  _brick() {
    const N = this.res, n = new Simplex(this.seed + 33);
    const albedo = new Float32Array(N * N * 3);
    const height = new Float32Array(N * N);
    const rough = new Float32Array(N * N);
    const rows = 12, cols = 6, mortar = 0.055;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const fy = y / N * rows;
        const row = Math.floor(fy);
        const offset = (row % 2) * 0.5;
        const fx = x / N * cols + offset;
        const col = Math.floor(fx);
        const lx = fx - col, ly = fy - row;
        const edge = Math.min(lx, 1 - lx, ly, 1 - ly);
        const isMortar = edge < mortar;
        const rnd = ((row * 73 + col * 151) % 97) / 97;
        const grain = fbm2(n, x / N * 22, y / N * 22, 4) * 0.5 + 0.5;
        if (isMortar) {
          height[i] = 0.18 + grain * 0.12;
          const g = 0.42 + grain * 0.12;
          albedo[i * 3] = g; albedo[i * 3 + 1] = g * 0.98; albedo[i * 3 + 2] = g * 0.93;
          rough[i] = 0.94;
        } else {
          const bev = smoothstep(mortar, mortar + 0.045, edge);
          height[i] = 0.55 + bev * 0.3 + grain * 0.12;
          const r = 0.34 + rnd * 0.14 + grain * 0.06;
          albedo[i * 3] = r;
          albedo[i * 3 + 1] = r * (0.48 + rnd * 0.08);
          albedo[i * 3 + 2] = r * (0.38 + rnd * 0.06);
          rough[i] = clamp(0.78 + grain * 0.12, 0, 1);
        }
      }
    }
    return this._pack(albedo, height, rough, N, { normalStrength: 3.2, aoRadius: 8 });
  }

  _metalPanel() {
    const N = this.res, n = new Simplex(this.seed + 44);
    const albedo = new Float32Array(N * N * 3);
    const height = new Float32Array(N * N);
    const rough = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = x / N, v = y / N;
        const seamX = Math.min(Math.abs(u % 0.5), 0.5 - Math.abs(u % 0.5));
        const seamY = Math.min(Math.abs(v % 0.5), 0.5 - Math.abs(v % 0.5));
        const seam = smoothstep(0, 0.012, Math.min(seamX, seamY));
        const brushed = fbm2(n, u * 240, v * 3, 3) * 0.5 + 0.5;
        height[i] = seam * 0.8 + brushed * 0.05;
        const g = 0.30 + brushed * 0.10;
        albedo[i * 3] = g * 0.98; albedo[i * 3 + 1] = g; albedo[i * 3 + 2] = g * 1.04;
        rough[i] = clamp(0.32 + brushed * 0.22 + (1 - seam) * 0.2, 0, 1);
      }
    }
    return this._pack(albedo, height, rough, N, { metalness: 1.0, normalStrength: 2.6 });
  }

  _rustMetal() {
    const N = this.res, n = new Simplex(this.seed + 55);
    const albedo = new Float32Array(N * N * 3);
    const height = new Float32Array(N * N);
    const rough = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = x / N * 4, v = y / N * 4;
        const rust = clamp(ridged2(n, u * 2.2, v * 2.2, 5) * 1.5 - 0.25, 0, 1);
        const grain = fbm2(n, u * 18, v * 18, 4) * 0.5 + 0.5;
        height[i] = 0.4 + rust * 0.4 + grain * 0.2;
        const r = lerp(0.31, 0.42, rust), g = lerp(0.33, 0.19, rust), b = lerp(0.36, 0.10, rust);
        albedo[i * 3] = r + grain * 0.05;
        albedo[i * 3 + 1] = g + grain * 0.03;
        albedo[i * 3 + 2] = b + grain * 0.02;
        rough[i] = clamp(lerp(0.38, 0.95, rust) + grain * 0.06, 0, 1);
      }
    }
    return this._pack(albedo, height, rough, N, { metalness: 0.85, normalStrength: 2.2 });
  }

  _plaster() {
    const N = this.res, n = new Simplex(this.seed + 66);
    const albedo = new Float32Array(N * N * 3);
    const height = new Float32Array(N * N);
    const rough = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = x / N * 5, v = y / N * 5;
        const stipple = fbm2(n, u * 26, v * 26, 4) * 0.5 + 0.5;
        const wide = fbm2(n, u * 1.1, v * 1.1, 3) * 0.5 + 0.5;
        height[i] = stipple * 0.6 + wide * 0.4;
        const base = 0.66 + wide * 0.12 + stipple * 0.05;
        albedo[i * 3] = base; albedo[i * 3 + 1] = base * 0.985; albedo[i * 3 + 2] = base * 0.95;
        rough[i] = clamp(0.9 + stipple * 0.08, 0, 1);
      }
    }
    return this._pack(albedo, height, rough, N, { normalStrength: 1.3 });
  }

  _sand() {
    const N = this.res, n = new Simplex(this.seed + 77);
    const albedo = new Float32Array(N * N * 3);
    const height = new Float32Array(N * N);
    const rough = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = x / N * 7, v = y / N * 7;
        const ripple = Math.sin((u * 5 + fbm2(n, u, v, 3) * 2.5) * Math.PI) * 0.5 + 0.5;
        const grain = fbm2(n, u * 40, v * 40, 3) * 0.5 + 0.5;
        height[i] = ripple * 0.5 + grain * 0.5;
        const base = 0.52 + ripple * 0.08 + grain * 0.05;
        albedo[i * 3] = base * 1.06; albedo[i * 3 + 1] = base * 0.94; albedo[i * 3 + 2] = base * 0.72;
        rough[i] = clamp(0.93 - ripple * 0.05, 0, 1);
      }
    }
    return this._pack(albedo, height, rough, N, { normalStrength: 1.8 });
  }

  _gunMetal() {
    const N = Math.min(this.res, 512), n = new Simplex(this.seed + 88);
    const albedo = new Float32Array(N * N * 3);
    const height = new Float32Array(N * N);
    const rough = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const u = x / N * 3, v = y / N * 3;
        const micro = fbm2(n, u * 60, v * 60, 4) * 0.5 + 0.5;
        const wear = clamp(ridged2(n, u * 5, v * 5, 4) * 1.4 - 0.45, 0, 1);
        height[i] = micro * 0.6 + wear * 0.4;
        const base = lerp(0.055, 0.20, wear) + micro * 0.02;
        albedo[i * 3] = base; albedo[i * 3 + 1] = base * 1.01; albedo[i * 3 + 2] = base * 1.05;
        rough[i] = clamp(lerp(0.42, 0.22, wear) + micro * 0.08, 0, 1);
      }
    }
    return this._pack(albedo, height, rough, N, { metalness: 1.0, normalStrength: 1.4 });
  }
}
