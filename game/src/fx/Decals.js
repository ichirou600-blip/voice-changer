import * as THREE from 'three';

/**
 * Bullet holes, scorches and blood splatter, drawn as camera-independent
 * oriented quads offset along the surface normal. Backed by a fixed-size ring
 * buffer with a single instanced draw call, so spraying a wall never costs
 * more than one batch.
 *
 * CONTRACT:
 *   decals.add(point, normal, { surface, size, kind })
 *   decals.clear()
 */
export class DecalManager {
  constructor(engine, textures) {
    this.engine = engine;
    this.textures = textures;
    this.max = 512;
    this.head = 0;
    this.count = 0;

    this.atlas = this._buildAtlas();

    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.attributes.position = plane.attributes.position;
    this.geometry.attributes.uv = plane.attributes.uv;

    this.aMatrix = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 16), 16);
    this.aTile = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 4), 4); // tileX, tileY, alpha, age
    this.aMatrix.setUsage(THREE.DynamicDrawUsage);
    this.aTile.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aMatrix', this.aMatrix);
    this.geometry.setAttribute('aTile', this.aTile);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { uAtlas: { value: this.atlas }, uTiles: { value: 4 } },
      vertexShader: /* glsl */`
        attribute mat4 aMatrix; attribute vec4 aTile;
        varying vec2 vUv; varying float vAlpha; varying vec2 vTile;
        void main(){
          vUv = uv; vAlpha = aTile.z; vTile = aTile.xy;
          gl_Position = projectionMatrix * modelViewMatrix * aMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uAtlas; uniform float uTiles;
        varying vec2 vUv; varying float vAlpha; varying vec2 vTile;
        void main(){
          vec2 uv = (vTile + clamp(vUv, 0.001, 0.999)) / uTiles;
          vec4 t = texture2D(uAtlas, uv);
          float a = t.a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(t.rgb, a);
        }`,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.userData.noCollide = true;
    engine.scene.add(this.mesh);

    this.ages = new Float32Array(this.max);
    this.lifetimes = new Float32Array(this.max);
  }

  /** 4x4 atlas of hole/scorch/splatter variants, drawn procedurally. */
  _buildAtlas() {
    const S = 512, T = 4, cell = S / T;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, S, S);

    for (let ty = 0; ty < T; ty++) {
      for (let tx = 0; tx < T; tx++) {
        const cx = tx * cell + cell / 2, cy = ty * cell + cell / 2;
        const idx = ty * T + tx;
        ctx.save();
        ctx.translate(cx, cy);
        if (ty < 2) {
          // Bullet holes: dark core, cracked rim, dusty halo.
          const r = cell * 0.13 * (0.8 + (idx % 3) * 0.14);
          const halo = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, cell * 0.44);
          halo.addColorStop(0, 'rgba(30,26,22,0.92)');
          halo.addColorStop(0.35, 'rgba(70,64,56,0.42)');
          halo.addColorStop(1, 'rgba(120,112,100,0)');
          ctx.fillStyle = halo;
          ctx.beginPath(); ctx.arc(0, 0, cell * 0.44, 0, Math.PI * 2); ctx.fill();

          ctx.fillStyle = 'rgba(12,10,9,0.97)';
          ctx.beginPath();
          for (let a = 0; a < 20; a++) {
            const ang = (a / 20) * Math.PI * 2;
            const rr = r * (0.82 + Math.sin(ang * 3 + idx) * 0.16 + Math.random() * 0.08);
            ctx[a ? 'lineTo' : 'moveTo'](Math.cos(ang) * rr, Math.sin(ang) * rr);
          }
          ctx.closePath(); ctx.fill();

          ctx.strokeStyle = 'rgba(180,172,160,0.30)';
          ctx.lineWidth = 1.2;
          for (let k = 0; k < 7; k++) {
            const ang = Math.random() * Math.PI * 2;
            const len = r * (1.4 + Math.random() * 2.2);
            ctx.beginPath();
            ctx.moveTo(Math.cos(ang) * r, Math.sin(ang) * r);
            ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
            ctx.stroke();
          }
        } else if (ty === 2) {
          // Scorch marks.
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, cell * 0.46);
          g.addColorStop(0, 'rgba(16,13,11,0.88)');
          g.addColorStop(0.5, 'rgba(28,24,20,0.42)');
          g.addColorStop(1, 'rgba(40,34,28,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          for (let a = 0; a < 28; a++) {
            const ang = (a / 28) * Math.PI * 2;
            const rr = cell * 0.42 * (0.7 + Math.sin(ang * 2.7 + idx * 1.3) * 0.22 + Math.random() * 0.1);
            ctx[a ? 'lineTo' : 'moveTo'](Math.cos(ang) * rr, Math.sin(ang) * rr);
          }
          ctx.closePath(); ctx.fill();
        } else {
          // Blood splatter.
          ctx.fillStyle = 'rgba(96,10,10,0.86)';
          ctx.beginPath(); ctx.arc(0, 0, cell * 0.15, 0, Math.PI * 2); ctx.fill();
          for (let k = 0; k < 22; k++) {
            const ang = Math.random() * Math.PI * 2;
            const d = cell * (0.1 + Math.random() * 0.34);
            const rr = cell * (0.012 + Math.random() * 0.045);
            ctx.globalAlpha = 0.35 + Math.random() * 0.5;
            ctx.beginPath();
            ctx.ellipse(Math.cos(ang) * d, Math.sin(ang) * d, rr, rr * (0.6 + Math.random()), ang, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        ctx.restore();
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /** kind: 'hole' | 'scorch' | 'blood' */
  add(point, normal, { size = 0.12, kind = 'hole', lifetime = 45 } = {}) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.count = Math.min(this.count + 1, this.max);

    _n.copy(normal).normalize();
    // Build an orthonormal basis on the surface with a random spin so repeated
    // hits on one wall never look stamped.
    _up.set(0, 1, 0);
    if (Math.abs(_n.dot(_up)) > 0.95) _up.set(1, 0, 0);
    _t.crossVectors(_up, _n).normalize();
    _b.crossVectors(_n, _t);
    const spin = Math.random() * Math.PI * 2;
    const cs = Math.cos(spin), sn = Math.sin(spin);
    _x.copy(_t).multiplyScalar(cs).addScaledVector(_b, sn).multiplyScalar(size);
    _y.copy(_t).multiplyScalar(-sn).addScaledVector(_b, cs).multiplyScalar(size);
    _z.copy(_n).multiplyScalar(size);
    _p.copy(point).addScaledVector(_n, 0.012);

    _m.set(
      _x.x, _y.x, _z.x, _p.x,
      _x.y, _y.y, _z.y, _p.y,
      _x.z, _y.z, _z.z, _p.z,
      0, 0, 0, 1,
    );
    _m.toArray(this.aMatrix.array, i * 16);

    const row = kind === 'scorch' ? 2 : kind === 'blood' ? 3 : (Math.random() < 0.5 ? 0 : 1);
    const col = (Math.random() * 4) | 0;
    this.aTile.array[i * 4] = col;
    this.aTile.array[i * 4 + 1] = row;
    this.aTile.array[i * 4 + 2] = 1;
    this.aTile.array[i * 4 + 3] = 0;
    this.ages[i] = 0;
    this.lifetimes[i] = lifetime;

    this.aMatrix.needsUpdate = true;
    this.aTile.needsUpdate = true;
    this.geometry.instanceCount = this.count;
  }

  update(dt) {
    if (!this.count) return;
    const a = this.aTile.array;
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      if (this.lifetimes[i] <= 0) continue;
      this.ages[i] += dt;
      const t = this.ages[i] / this.lifetimes[i];
      if (t >= 1) { a[i * 4 + 2] = 0; this.lifetimes[i] = 0; dirty = true; }
      else if (t > 0.8) { a[i * 4 + 2] = 1 - (t - 0.8) / 0.2; dirty = true; }
    }
    if (dirty) this.aTile.needsUpdate = true;
  }

  clear() {
    this.count = 0; this.head = 0;
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
  }
}

const _n = new THREE.Vector3(), _t = new THREE.Vector3(), _b = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _p = new THREE.Vector3(), _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
