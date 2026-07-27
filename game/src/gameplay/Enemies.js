import * as THREE from 'three';
import { SURFACE } from './Physics.js';
import { damp, clamp, mulberry32 } from '../core/Noise.js';

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
   * Materials and geometry are built once and shared by every soldier. Eight
   * fully-detailed characters would otherwise mean eight copies of ~40 buffers,
   * and the GPU would see no instancing benefit at all.
   */
  _shared() {
    if (this._assets) return this._assets;
    const M = (color, roughness, metalness = 0.02) =>
      new THREE.MeshStandardMaterial({ color, roughness, metalness });

    const a = {
      fatigue: M(0x4a4c3c, 0.90),          // uniform cloth
      fatigueDark: M(0x35372b, 0.92),      // knee/elbow pads, shadowed panels
      plate: M(0x2b2d24, 0.72, 0.05),      // plate carrier shell
      pouch: M(0x3a3c30, 0.86),
      webbing: M(0x24261e, 0.88),
      skin: M(0x9c7355, 0.58),
      glove: M(0x1e1f1c, 0.82),
      boot: M(0x181816, 0.74),
      helmet: M(0x33362c, 0.62, 0.08),
      gear: M(0x141513, 0.55, 0.30),       // NVG mount, buckles, optics housing
      lens: new THREE.MeshStandardMaterial({
        color: 0x101a18, roughness: 0.12, metalness: 0.1,
        emissive: 0x0a1512, emissiveIntensity: 0.3,
      }),
      gunmetal: M(0x1a1c1b, 0.52, 0.85),
    };

    const g = {
      // Limb segments are tapered capsules; real limbs are not cylinders and the
      // taper is most of what stops a character reading as a balloon animal.
      thigh: new THREE.CapsuleGeometry(0.093, 0.24, 4, 10),
      shin: new THREE.CapsuleGeometry(0.072, 0.26, 4, 10),
      boot: new THREE.BoxGeometry(0.108, 0.088, 0.235),
      upperArm: new THREE.CapsuleGeometry(0.058, 0.19, 4, 9),
      foreArm: new THREE.CapsuleGeometry(0.050, 0.20, 4, 9),
      hand: new THREE.BoxGeometry(0.070, 0.098, 0.052),
      chest: new THREE.CapsuleGeometry(0.185, 0.24, 5, 12),
      pelvis: new THREE.CapsuleGeometry(0.163, 0.13, 5, 10),
      plateFront: new THREE.BoxGeometry(0.315, 0.345, 0.098),
      shoulder: new THREE.SphereGeometry(0.093, 10, 8),
      neck: new THREE.CylinderGeometry(0.055, 0.062, 0.075, 8),
      skull: new THREE.SphereGeometry(0.098, 14, 12),
      jaw: new THREE.BoxGeometry(0.118, 0.082, 0.115),
      helmetShell: new THREE.SphereGeometry(0.126, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
      pouch: new THREE.BoxGeometry(0.088, 0.098, 0.062),
      mag: new THREE.BoxGeometry(0.030, 0.098, 0.056),
      nvgMount: new THREE.BoxGeometry(0.052, 0.040, 0.030),
      goggle: new THREE.BoxGeometry(0.148, 0.048, 0.036),
      headsetCup: new THREE.CylinderGeometry(0.046, 0.046, 0.032, 10),
      rifleBody: new THREE.BoxGeometry(0.045, 0.070, 0.330),
      rifleBarrel: new THREE.CylinderGeometry(0.011, 0.012, 0.230, 8),
      rifleMag: new THREE.BoxGeometry(0.028, 0.115, 0.048),
      rifleStock: new THREE.BoxGeometry(0.038, 0.058, 0.135),
      strap: new THREE.BoxGeometry(0.062, 0.235, 0.030),
    };

    this._assets = { m: a, g };
    return this._assets;
  }

  _makeEnemy(position) {
    const { m, g } = this._shared();
    const group = new THREE.Group();
    group.position.copy(position);

    const part = (geo, mat, x, y, z) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      return mesh;
    };

    // --- pelvis --------------------------------------------------------------
    const hips = new THREE.Group();
    hips.position.y = 0.92;
    hips.add(part(g.pelvis, m.fatigue, 0, 0, 0));
    // Duty belt with pouches around the hips.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 1.5 + Math.PI * 0.25;
      const p = part(g.pouch, m.pouch, Math.cos(a) * 0.155, -0.03, Math.sin(a) * 0.115);
      p.rotation.y = -a;
      p.scale.setScalar(0.78);
      hips.add(p);
    }
    group.add(hips);

    // --- torso ---------------------------------------------------------------
    const torso = new THREE.Group();
    torso.position.y = 1.22;
    torso.add(part(g.chest, m.fatigue, 0, 0, 0));

    // Plate carrier: front and rear plates plus shoulder straps. The hard,
    // squared-off silhouette against the soft body is what reads as "kitted up".
    const front = part(g.plateFront, m.plate, 0, 0.012, 0.088);
    front.scale.set(1, 1, 0.55);
    torso.add(front);
    const rear = part(g.plateFront, m.plate, 0, 0.012, -0.088);
    rear.scale.set(1, 1, 0.55);
    torso.add(rear);
    for (const sx of [-1, 1]) {
      torso.add(part(g.strap, m.webbing, sx * 0.098, 0.145, 0));
    }
    // Magazine pouches across the chest rig.
    for (let i = 0; i < 3; i++) {
      torso.add(part(g.mag, m.pouch, -0.078 + i * 0.078, -0.055, 0.128));
    }
    // Radio on the left shoulder with a stub antenna.
    const radio = part(g.pouch, m.gear, -0.135, 0.075, 0.062);
    radio.scale.set(0.7, 0.9, 0.7);
    torso.add(radio);
    const antenna = part(new THREE.CylinderGeometry(0.004, 0.003, 0.24, 5), m.gear, -0.135, 0.20, 0.062);
    antenna.rotation.z = 0.18;
    torso.add(antenna);
    group.add(torso);

    // --- head ----------------------------------------------------------------
    const head = new THREE.Group();
    head.position.y = 1.62;
    head.add(part(g.neck, m.skin, 0, -0.075, 0));
    head.add(part(g.skull, m.skin, 0, 0, 0));
    const jaw = part(g.jaw, m.skin, 0, -0.048, 0.022);
    jaw.scale.set(0.92, 1, 0.92);
    head.add(jaw);

    const helmet = part(g.helmetShell, m.helmet, 0, 0.012, -0.004);
    helmet.scale.set(1.03, 1.1, 1.06);
    head.add(helmet);
    // NVG mount on the brow and the counterweight pouch at the rear — the two
    // details that instantly date a helmet as modern military.
    head.add(part(g.nvgMount, m.gear, 0, 0.072, 0.098));
    const counterweight = part(g.pouch, m.webbing, 0, 0.030, -0.115);
    counterweight.scale.set(0.9, 0.6, 0.6);
    head.add(counterweight);
    head.add(part(g.goggle, m.lens, 0, 0.038, 0.092));
    for (const sx of [-1, 1]) {
      const cup = part(g.headsetCup, m.gear, sx * 0.106, -0.005, 0);
      cup.rotation.z = Math.PI / 2;
      head.add(cup);
    }
    group.add(head);

    // --- limbs ---------------------------------------------------------------
    // Each limb is a group pivoting at the joint, so the locomotion code can
    // rotate it directly and the child segments follow.
    const makeLeg = (side) => {
      const leg = new THREE.Group();
      leg.position.set(side * 0.098, 0.88, 0);
      leg.add(part(g.thigh, m.fatigue, 0, -0.21, 0));
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      knee.add(part(g.shin, m.fatigue, 0, -0.20, 0));
      const kneePad = part(new THREE.SphereGeometry(0.078, 8, 6), m.fatigueDark, 0, -0.02, 0.038);
      kneePad.scale.set(1, 0.85, 0.62);
      knee.add(kneePad);
      const boot = part(g.boot, m.boot, 0, -0.40, 0.038);
      knee.add(boot);
      leg.add(knee);
      leg.userData.knee = knee;
      return leg;
    };
    const legL = makeLeg(-1);
    const legR = makeLeg(1);
    group.add(legL, legR);

    const makeArm = (side) => {
      const arm = new THREE.Group();
      arm.position.set(side * 0.223, 1.36, 0);
      arm.add(part(g.shoulder, m.plate, 0, 0.012, 0));
      arm.add(part(g.upperArm, m.fatigue, 0, -0.155, 0));
      const elbow = new THREE.Group();
      elbow.position.y = -0.305;
      elbow.add(part(g.foreArm, m.fatigue, 0, -0.155, 0));
      const elbowPad = part(new THREE.SphereGeometry(0.062, 8, 6), m.fatigueDark, 0, -0.01, 0.030);
      elbowPad.scale.set(1, 0.8, 0.6);
      elbow.add(elbowPad);
      elbow.add(part(g.hand, m.glove, 0, -0.315, 0.012));
      arm.add(elbow);
      arm.userData.elbow = elbow;
      return arm;
    };
    const armL = makeArm(-1);
    const armR = makeArm(1);
    group.add(armL, armR);

    // --- carried rifle -------------------------------------------------------
    // Parented to the torso so it tracks the body, posed across the chest.
    const rifle = new THREE.Group();
    rifle.add(part(g.rifleBody, m.gunmetal, 0, 0, 0));
    const barrel = part(g.rifleBarrel, m.gunmetal, 0, 0.012, -0.28);
    barrel.rotation.x = Math.PI / 2;
    rifle.add(barrel);
    rifle.add(part(g.rifleMag, m.gunmetal, 0, -0.085, -0.02));
    rifle.add(part(g.rifleStock, m.gunmetal, 0, -0.004, 0.225));
    rifle.position.set(0.16, -0.10, 0.135);
    rifle.rotation.set(0.08, -0.30, -0.22);
    torso.add(rifle);

    group.traverse((c) => {
      if (!c.isMesh) return;
      c.castShadow = true;
      c.receiveShadow = true;
      c.userData.noCollide = true;
    });
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

const _c = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();

export { STATE };
