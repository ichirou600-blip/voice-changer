import * as THREE from 'three';

/**
 * GPU-instanced particle system. One draw call per material class; every
 * particle lives in typed arrays and is simulated on the CPU with SIMD-friendly
 * straight-line loops, then uploaded as instance attributes.
 *
 * CONTRACT (called from Ballistics/Weapons/Enemies):
 *   fx.emit(preset, position, normalOrDir, opts)
 *   fx.presets — impactDust, impactSpark, muzzleSmoke, bloodMist, shellSmoke,
 *                debris, explosion, tracerPuff
 */
export class ParticleSystem {
  constructor(engine, textures) {
    this.engine = engine;
    this.textures = textures;
    this.max = 4096;
    this.count = 0;

    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);
    this.size = new Float32Array(this.max);
    this.sizeVel = new Float32Array(this.max);
    this.drag = new Float32Array(this.max);
    this.grav = new Float32Array(this.max);
    this.rot = new Float32Array(this.max);
    this.rotVel = new Float32Array(this.max);
    this.tile = new Float32Array(this.max);

    const geo = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = geo.index;
    this.geometry.attributes.position = geo.attributes.position;
    this.geometry.attributes.uv = geo.attributes.uv;

    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3); // size, alpha, rot
    this.aOffset.setUsage(THREE.DynamicDrawUsage);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    this.aParams.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aOffset', this.aOffset);
    this.geometry.setAttribute('aColor', this.aColor);
    this.aTile = new THREE.InstancedBufferAttribute(new Float32Array(this.max), 1);
    this.aTile.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aParams', this.aParams);
    this.geometry.setAttribute('aTile', this.aTile);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uAtlas: { value: null },   // assigned after the atlas is generated
        uTiles: { value: 4 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aOffset, aColor, aParams;
        attribute float aTile;
        varying vec3 vColor; varying float vAlpha; varying vec2 vUv; varying float vTile;
        void main(){
          vColor = aColor; vAlpha = aParams.y; vUv = uv; vTile = aTile;
          float s = aParams.x, a = aParams.z;
          vec2 p = position.xy * s;
          vec2 rp = vec2(p.x*cos(a) - p.y*sin(a), p.x*sin(a) + p.y*cos(a));
          vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
          mv.xy += rp;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uAtlas;
        uniform float uTiles;
        varying vec3 vColor; varying float vAlpha; varying vec2 vUv; varying float vTile;
        void main(){
          // Sample one cell of the puff atlas. Insetting by half a texel stops
          // neighbouring cells bleeding in under the mip chain.
          float col = mod(vTile, uTiles);
          float row = floor(vTile / uTiles);
          vec2 cell = (vec2(col, row) + clamp(vUv, 0.004, 0.996)) / uTiles;
          vec4 t = texture2D(uAtlas, cell);
          float a = t.a * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor * t.rgb, a);
        }`,
    });

    this.atlas = buildParticleAtlas();
    this.material.uniforms.uAtlas.value = this.atlas;
    // Sparks and flame are authored bright and left untonemapped so the post
    // stack's bloom threshold actually catches them, which is what sells a
    // hot ember against a dim street.
    this.material.toneMapped = false;

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.userData.noCollide = true;
    engine.scene.add(this.mesh);

    this.presets = PRESETS;
  }

  emit(presetName, position, dir = _up, opts = {}) {
    const preset = this.presets[presetName];
    if (!preset) return;
    const n = Math.round((opts.count ?? preset.count) * (opts.scale ?? 1));
    for (let i = 0; i < n; i++) {
      if (this.count >= this.max) break;
      const id = this.count++;
      const spread = opts.spread ?? preset.spread;
      _v.set(
        dir.x + (Math.random() - 0.5) * spread,
        dir.y + (Math.random() - 0.5) * spread,
        dir.z + (Math.random() - 0.5) * spread,
      ).normalize();
      const speed = preset.speed[0] + Math.random() * (preset.speed[1] - preset.speed[0]);
      this.pos[id * 3] = position.x; this.pos[id * 3 + 1] = position.y; this.pos[id * 3 + 2] = position.z;
      this.vel[id * 3] = _v.x * speed; this.vel[id * 3 + 1] = _v.y * speed; this.vel[id * 3 + 2] = _v.z * speed;
      const c = opts.color !== undefined ? _c.set(opts.color) : _c.set(preset.color);
      const jitter = 1 - Math.random() * (preset.colorJitter ?? 0.2);
      this.col[id * 3] = c.r * jitter; this.col[id * 3 + 1] = c.g * jitter; this.col[id * 3 + 2] = c.b * jitter;
      const life = preset.life[0] + Math.random() * (preset.life[1] - preset.life[0]);
      this.life[id] = life; this.maxLife[id] = life;
      this.size[id] = preset.size[0] + Math.random() * (preset.size[1] - preset.size[0]);
      this.sizeVel[id] = preset.growth ?? 0;
      this.drag[id] = preset.drag ?? 1.6;
      this.grav[id] = preset.gravity ?? 0;
      this.rot[id] = Math.random() * Math.PI * 2;
      this.rotVel[id] = (Math.random() - 0.5) * (preset.spin ?? 2);
      const tiles = preset.tiles || [0, 3];
      this.tile[id] = tiles[0] + Math.floor(Math.random() * (tiles[1] - tiles[0] + 1));
    }
  }

  update(dt) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Swap-remove keeps the arrays dense with no per-particle branching.
        const last = --n;
        if (i !== last) {
          for (let k = 0; k < 3; k++) {
            this.pos[i * 3 + k] = this.pos[last * 3 + k];
            this.vel[i * 3 + k] = this.vel[last * 3 + k];
            this.col[i * 3 + k] = this.col[last * 3 + k];
          }
          this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
          this.size[i] = this.size[last]; this.sizeVel[i] = this.sizeVel[last];
          this.drag[i] = this.drag[last]; this.grav[i] = this.grav[last];
          this.rot[i] = this.rot[last]; this.rotVel[i] = this.rotVel[last];
          this.tile[i] = this.tile[last];
        }
        i--;
        continue;
      }
      const d = 1 - Math.min(1, this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d + this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.sizeVel[i] * dt;
      this.rot[i] += this.rotVel[i] * dt;
    }
    this.count = n;

    const o = this.aOffset.array, c = this.aColor.array, p = this.aParams.array, tl = this.aTile.array;
    for (let i = 0; i < n; i++) {
      o[i * 3] = this.pos[i * 3]; o[i * 3 + 1] = this.pos[i * 3 + 1]; o[i * 3 + 2] = this.pos[i * 3 + 2];
      c[i * 3] = this.col[i * 3]; c[i * 3 + 1] = this.col[i * 3 + 1]; c[i * 3 + 2] = this.col[i * 3 + 2];
      const t = this.life[i] / this.maxLife[i];
      p[i * 3] = Math.max(0.001, this.size[i]);
      p[i * 3 + 1] = t * t * (3 - 2 * t);  // smooth fade in/out envelope
      p[i * 3 + 2] = this.rot[i];
      tl[i] = this.tile[i];
    }
    this.aOffset.addUpdateRange(0, n * 3); this.aOffset.needsUpdate = true;
    this.aColor.addUpdateRange(0, n * 3); this.aColor.needsUpdate = true;
    this.aParams.addUpdateRange(0, n * 3); this.aParams.needsUpdate = true;
    this.aTile.addUpdateRange(0, n); this.aTile.needsUpdate = true;
    this.geometry.instanceCount = n;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}

/**
 * 4x4 sprite atlas for the particle system, drawn once at startup.
 *
 * Row 0-1: soft smoke/dust puffs — irregular clumped blobs rather than clean
 *          radial gradients, because a perfect circle is the tell that gives
 *          away a billboard system instantly.
 * Row 2:   debris chips and grit specks.
 * Row 3:   hot sparks and flame licks, authored bright for the bloom threshold.
 */
function buildParticleAtlas() {
  const S = 512, T = 4, cell = S / T;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);

  for (let ty = 0; ty < T; ty++) {
    for (let tx = 0; tx < T; tx++) {
      const ox = tx * cell + cell / 2, oy = ty * cell + cell / 2;
      ctx.save();
      ctx.translate(ox, oy);
      const seed = ty * T + tx;

      if (ty < 2) {
        // Smoke: several overlapping soft lobes at varied offsets and radii,
        // which reads as a turbulent puff instead of a fuzzy ball.
        const lobes = 5 + (seed % 3);
        for (let i = 0; i < lobes; i++) {
          const a = (i / lobes) * Math.PI * 2 + seed;
          const d = cell * (0.04 + ((seed * 7 + i * 13) % 10) / 100);
          const r = cell * (0.16 + ((seed * 3 + i * 5) % 12) / 100);
          const px = Math.cos(a) * d, py = Math.sin(a) * d;
          const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
          grad.addColorStop(0, 'rgba(255,255,255,0.30)');
          grad.addColorStop(0.45, 'rgba(255,255,255,0.14)');
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (ty === 2) {
        // Debris: a few angular chips scattered in the cell.
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const chips = 2 + (seed % 3);
        for (let i = 0; i < chips; i++) {
          const a = (seed * 17 + i * 41) % 360 * Math.PI / 180;
          const d = cell * 0.10 * i;
          const r = cell * (0.045 + ((seed + i) % 5) / 120);
          ctx.save();
          ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
          ctx.rotate(a);
          ctx.beginPath();
          ctx.moveTo(-r, -r * 0.6);
          ctx.lineTo(r * 0.9, -r * 0.3);
          ctx.lineTo(r * 0.5, r * 0.8);
          ctx.lineTo(-r * 0.7, r * 0.4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      } else {
        // Sparks: a bright core with a motion-stretched tail, so a spark reads
        // as travelling rather than as a dot.
        const len = cell * (0.22 + (seed % 4) * 0.05);
        const grad = ctx.createLinearGradient(0, -len, 0, len * 0.35);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.55, 'rgba(255,240,200,0.55)');
        grad.addColorStop(0.82, 'rgba(255,255,255,1)');
        grad.addColorStop(1, 'rgba(255,220,150,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(-cell * 0.020, -len, cell * 0.040, len * 1.35);
        const core = ctx.createRadialGradient(0, len * 0.12, 0, 0, len * 0.12, cell * 0.075);
        core.addColorStop(0, 'rgba(255,255,255,1)');
        core.addColorStop(0.4, 'rgba(255,226,160,0.7)');
        core.addColorStop(1, 'rgba(255,180,90,0)');
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(0, len * 0.12, cell * 0.075, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const PRESETS = {
  impactDust: { tiles: [0, 7],  count: 12, life: [0.35, 0.9], size: [0.05, 0.18], growth: 0.5, speed: [1.2, 4.0], spread: 0.9, color: 0xbdb6ab, drag: 3.2, gravity: -1.2, spin: 3 },
  impactSpark: { tiles: [12, 15],  count: 14, life: [0.12, 0.4], size: [0.012, 0.035], growth: -0.02, speed: [5, 16], spread: 1.1, color: 0xffc46a, drag: 1.1, gravity: -14, spin: 0 },
  debris: { tiles: [8, 11],  count: 8, life: [0.6, 1.4], size: [0.02, 0.06], speed: [2, 7], spread: 1.0, color: 0x7a7168, drag: 0.9, gravity: -16, spin: 8 },
  muzzleSmoke: { tiles: [0, 7],  count: 8, life: [0.35, 0.85], size: [0.06, 0.16], growth: 0.55, speed: [0.8, 2.6], spread: 0.5, color: 0x9c9c99, drag: 3.6, gravity: 0.35, spin: 1.6 },
  bloodMist: { tiles: [0, 7],  count: 16, life: [0.3, 0.75], size: [0.04, 0.14], growth: 0.3, speed: [2, 6], spread: 0.85, color: 0x8c1010, drag: 3.0, gravity: -6, spin: 2 },
  explosion: { tiles: [0, 7],  count: 60, life: [0.5, 1.3], size: [0.3, 1.1], growth: 1.6, speed: [4, 14], spread: 1.6, color: 0xffa040, drag: 2.4, gravity: 1.2, spin: 2 },
  shellSmoke: { tiles: [0, 7],  count: 2, life: [0.2, 0.5], size: [0.02, 0.05], growth: 0.3, speed: [0.3, 1.0], spread: 1.0, color: 0xb0aca4, drag: 4, gravity: 0.2, spin: 1 },
};

const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
