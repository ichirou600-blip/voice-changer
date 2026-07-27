import * as THREE from 'three';
import { SURFACE_INFO } from './Physics.js';

/**
 * Projectile simulation and impact resolution. Rounds are simulated as
 * travelling projectiles (not instant hitscan) with drag and gravity, so
 * long-range shots need lead and drop — then resolved against the static BVH
 * and any registered entity providers.
 *
 * CONTRACT:
 *   ballistics.fire({origin, direction, weapon, owner})
 *   ballistics.setTargetProviders([...])  — each needs raycastEntities(o,d,maxDist)
 *   ballistics.onHit(hit)                 — callback for HUD/feedback
 */
export class Ballistics {
  constructor(engine, { physics, particles, decals, audio }) {
    this.engine = engine;
    this.physics = physics;
    this.particles = particles;
    this.decals = decals;
    this.audio = audio;
    this.providers = [];
    this.onHit = null;

    this.max = 256;
    this.active = [];
    this.pool = [];

    // Tracers: one instanced stretched-billboard draw call for every round in
    // flight, so full-auto costs a single batch.
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.attributes.position = plane.attributes.position;
    this.geometry.attributes.uv = plane.attributes.uv;
    this.aStart = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this.aEnd = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 2), 2);
    for (const a of [this.aStart, this.aEnd, this.aParams]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aStart', this.aStart);
    this.geometry.setAttribute('aEnd', this.aEnd);
    this.geometry.setAttribute('aParams', this.aParams);
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(1.0, 0.72, 0.32) } },
      vertexShader: /* glsl */`
        attribute vec3 aStart, aEnd; attribute vec2 aParams;
        varying vec2 vUv; varying float vAlpha;
        void main(){
          vUv = uv; vAlpha = aParams.y;
          vec4 s = modelViewMatrix * vec4(aStart, 1.0);
          vec4 e = modelViewMatrix * vec4(aEnd, 1.0);
          vec3 axis = e.xyz - s.xyz;
          float len = length(axis);
          vec3 dir = len > 1e-5 ? axis / len : vec3(0.0, 1.0, 0.0);
          vec3 side = normalize(cross(dir, vec3(0.0, 0.0, 1.0)));
          vec3 p = s.xyz + dir * (uv.y * len) + side * ((uv.x - 0.5) * aParams.x);
          gl_Position = projectionMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying vec2 vUv; varying float vAlpha;
        void main(){
          float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float along = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
          float a = pow(across, 2.2) * along * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * (1.0 + across * 1.6), a);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.userData.noCollide = true;
    engine.scene.add(this.mesh);
  }

  setTargetProviders(list) { this.providers = list.filter(Boolean); }

  fire({ origin, direction, weapon, owner = 'player' }) {
    const b = this.pool.pop() || {
      pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), trail: new THREE.Vector3(),
    };
    b.pos.copy(origin);
    b.prev.copy(origin);
    b.trail.copy(origin);
    b.vel.copy(direction).multiplyScalar(weapon.muzzleVelocity ?? 780);
    b.damage = weapon.damage ?? 32;
    b.drag = weapon.drag ?? 0.0009;
    b.owner = owner;
    b.penetration = weapon.penetration ?? 1;
    b.life = 3.0;
    b.distance = 0;
    b.tracer = weapon.tracerEvery ? (weapon._shotIndex ?? 0) % weapon.tracerEvery === 0 : true;
    b.headshotMult = weapon.headshotMultiplier ?? 2.6;
    b.falloff = weapon.falloff ?? { start: 30, end: 90, min: 0.55 };
    if (this.active.length < this.max) this.active.push(b);
    return b;
  }

  fixedUpdate(dt) {
    const g = this.physics.gravity;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.life -= dt;
      b.prev.copy(b.pos);

      const speed = b.vel.length();
      // Quadratic drag: v -= k * v^2 * dt, applied along the velocity.
      const decel = b.drag * speed * speed * dt;
      if (speed > 1e-4) b.vel.addScaledVector(b.vel, -decel / speed);
      b.vel.y += g * dt;

      _step.copy(b.vel).multiplyScalar(dt);
      const stepLen = _step.length();
      b.distance += stepLen;

      if (stepLen > 1e-6) {
        _dir.copy(_step).multiplyScalar(1 / stepLen);
        const hit = this._traceSegment(b.prev, _dir, stepLen, b.owner);
        if (hit) {
          this._resolveImpact(b, hit);
          this._recycle(i);
          continue;
        }
      }
      b.pos.add(_step);
      if (b.life <= 0 || b.distance > 600) this._recycle(i);
    }
  }

  _traceSegment(origin, dir, maxDist, owner) {
    let best = null;
    const world = this.physics.raycast(origin, dir, maxDist, _worldHit);
    if (world) best = { ...world, entity: null };
    for (const p of this.providers) {
      const h = p.raycastEntities?.(origin, dir, best ? best.distance : maxDist, owner);
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best;
  }

  _resolveImpact(bullet, hit) {
    const info = SURFACE_INFO[hit.surface] || SURFACE_INFO[0];
    const falloff = this._falloff(bullet, bullet.distance);
    const damage = bullet.damage * falloff * (hit.part === 'head' ? bullet.headshotMult : hit.part === 'limb' ? 0.78 : 1);

    if (hit.entity) {
      const killed = hit.entity.takeDamage?.(damage, {
        point: hit.point, normal: hit.normal, part: hit.part, from: bullet.owner,
      });
      this.particles.emit('bloodMist', hit.point, hit.normal);
      this.decals.add(hit.point, hit.normal, { kind: 'blood', size: 0.28, lifetime: 30 });
      this.onHit?.({ point: hit.point.clone(), entity: hit.entity, damage, part: hit.part, kill: !!killed, owner: bullet.owner });
      this.audio?.playAt?.('flesh_impact', hit.point);
      return;
    }

    this.particles.emit('impactDust', hit.point, hit.normal, { color: info.dustColor, scale: 0.8 + info.hardness * 0.6 });
    if (info.sparks > 0.01) {
      this.particles.emit('impactSpark', hit.point, hit.normal, { scale: info.sparks });
    }
    this.particles.emit('debris', hit.point, hit.normal, { color: info.dustColor, scale: 0.6 });
    this.decals.add(hit.point, hit.normal, { kind: 'hole', size: 0.09 + Math.random() * 0.05 });
    this.audio?.playImpact?.(info.name, hit.point);
    this.onHit?.({ point: hit.point.clone(), entity: null, damage: 0, surface: hit.surface, owner: bullet.owner });
  }

  _falloff(b, dist) {
    const f = b.falloff;
    if (dist <= f.start) return 1;
    if (dist >= f.end) return f.min;
    const t = (dist - f.start) / (f.end - f.start);
    return 1 - (1 - f.min) * t;
  }

  _recycle(i) {
    const b = this.active[i];
    this.active.splice(i, 1);
    this.pool.push(b);
  }

  update() {
    const n = this.active.length;
    const s = this.aStart.array, e = this.aEnd.array, p = this.aParams.array;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const b = this.active[i];
      if (!b.tracer) continue;
      // Tracer body trails the round so it reads as a streak, not a dot.
      b.trail.lerp(b.pos, 0.55);
      s[k * 3] = b.trail.x; s[k * 3 + 1] = b.trail.y; s[k * 3 + 2] = b.trail.z;
      e[k * 3] = b.pos.x; e[k * 3 + 1] = b.pos.y; e[k * 3 + 2] = b.pos.z;
      p[k * 2] = 0.035;
      p[k * 2 + 1] = Math.min(1, b.distance / 6);  // fade in so it doesn't pop at the muzzle
      k++;
    }
    this.aStart.needsUpdate = this.aEnd.needsUpdate = this.aParams.needsUpdate = true;
    this.geometry.instanceCount = k;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _worldHit = {};
