import * as THREE from 'three';
import { damp, clamp, lerp } from '../core/Noise.js';

/**
 * Weapon handling: the viewmodel rig, fire control, recoil patterns, ADS,
 * reloads and shell ejection.
 *
 * The viewmodel lives in engine.viewScene and is animated by composing
 * additive offsets — idle sway, walk bob, ADS blend, recoil kick, reload
 * animation — so no two systems fight over the same transform.
 *
 * CONTRACT:
 *   weapons.attachInput(input)
 *   weapons.setViewmodelVisible(bool)
 *   weapons.current   — active weapon definition + runtime state
 *   weapons.onFire(shot)
 */

export const WEAPONS = {
  rifle: {
    id: 'rifle', name: 'M4A1', class: 'Assault Rifle',
    rpm: 780, damage: 33, magazine: 30, reserve: 210,
    muzzleVelocity: 880, drag: 0.00085, penetration: 1.0,
    headshotMultiplier: 2.6, falloff: { start: 34, end: 96, min: 0.52 },
    adsTime: 0.22, adsFov: 46, tracerEvery: 3,
    recoil: { pitch: 0.0105, yaw: 0.0042, kick: 0.028, roll: 0.008, recovery: 9.5 },
    spread: { hip: 0.036, ads: 0.0022, moving: 0.028, bloomPerShot: 0.0035, bloomMax: 0.03, decay: 0.09 },
    reloadTime: 2.15, reloadEmptyTime: 2.85,
    fireModes: ['auto', 'burst', 'single'],
  },
  smg: {
    id: 'smg', name: 'MP5', class: 'Submachine Gun',
    rpm: 900, damage: 25, magazine: 30, reserve: 240,
    muzzleVelocity: 400, drag: 0.0013, penetration: 0.7,
    headshotMultiplier: 2.2, falloff: { start: 18, end: 52, min: 0.42 },
    adsTime: 0.17, adsFov: 52, tracerEvery: 4,
    recoil: { pitch: 0.0082, yaw: 0.0048, kick: 0.021, roll: 0.007, recovery: 11.5 },
    spread: { hip: 0.030, ads: 0.0034, moving: 0.024, bloomPerShot: 0.0030, bloomMax: 0.032, decay: 0.11 },
    reloadTime: 1.85, reloadEmptyTime: 2.45,
    fireModes: ['auto', 'single'],
  },
};

export class WeaponSystem {
  constructor(engine, { player, ballistics, particles, audio, textures }) {
    this.engine = engine;
    this.player = player;
    this.ballistics = ballistics;
    this.particles = particles;
    this.audio = audio;
    this.textures = textures;

    this.loadout = ['rifle', 'smg'];
    this.slot = 0;
    this.state = {};
    for (const id of this.loadout) {
      const def = WEAPONS[id];
      this.state[id] = { ammo: def.magazine, reserve: def.reserve, fireMode: def.fireModes[0], burstLeft: 0 };
    }

    this.ads = 0;
    this.bloom = 0;
    this.fireCooldown = 0;
    this.reloading = 0;
    this.reloadTotal = 0;
    this.swapping = 0;
    this.shotIndex = 0;
    this.recoilIndex = 0;
    this.onFire = null;

    this.rig = new THREE.Group();
    engine.viewScene.add(this.rig);
    this.models = {};
    for (const id of this.loadout) {
      const m = buildViewmodel(id, textures);
      m.visible = false;
      this.rig.add(m);
      this.models[id] = m;
    }
    this.models[this.loadout[0]].visible = true;

    // Composed transform state.
    this._sway = new THREE.Vector2();
    this._swayVel = new THREE.Vector2();
    this._bob = 0;
    this._kick = 0;
    this._kickVel = 0;
    this._recoilRot = new THREE.Vector3();
    this._visible = true;

    this.hipPose = { pos: new THREE.Vector3(0.155, -0.135, -0.30), rot: new THREE.Euler(0.02, 0.055, 0.012) };
    this.adsPose = { pos: new THREE.Vector3(0.0, -0.072, -0.20), rot: new THREE.Euler(0, 0, 0) };

    player.setAdsFov(WEAPONS[this.loadout[0]].adsFov);
  }

  attachInput(input) { this.input = input; }

  get def() { return WEAPONS[this.loadout[this.slot]]; }
  get current() { return { def: this.def, ...this.state[this.loadout[this.slot]] }; }
  get ammo() { return this.state[this.loadout[this.slot]].ammo; }
  get reserve() { return this.state[this.loadout[this.slot]].reserve; }

  setViewmodelVisible(v) {
    this._visible = v;
    this.rig.visible = v;
  }

  update(dt) {
    if (!this.input) return;
    const def = this.def;
    const st = this.state[def.id];
    const input = this.input;

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.swapping = Math.max(0, this.swapping - dt);

    // --- ADS ---------------------------------------------------------------
    const wantAds = (input.mouseDown(2) || input.triggerHeld('left') > 0.35) &&
      !this.reloading && !this.swapping && !this.player.sprinting;
    const adsRate = 1 / Math.max(0.05, def.adsTime);
    this.ads = clamp(this.ads + (wantAds ? adsRate : -adsRate * 1.25) * dt, 0, 1);
    this.player.adsFactor = this.ads;
    this.player.setAdsFov(def.adsFov);

    // --- reload ------------------------------------------------------------
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const need = def.magazine - st.ammo;
        const take = Math.min(need, st.reserve);
        st.ammo += take; st.reserve -= take;
        this.reloading = 0;
      }
    } else if ((input.justPressed('KeyR') || input.padButton(2)) && st.ammo < def.magazine && st.reserve > 0) {
      this.reloadTotal = st.ammo === 0 ? def.reloadEmptyTime : def.reloadTime;
      this.reloading = this.reloadTotal;
      this.audio?.play?.('reload');
    }

    // --- weapon swap -------------------------------------------------------
    if (input.justPressed('Digit1')) this._swap(0);
    if (input.justPressed('Digit2')) this._swap(1);
    if (input.mouse.wheel !== 0) this._swap((this.slot + (input.mouse.wheel > 0 ? 1 : -1) + this.loadout.length) % this.loadout.length);
    if (input.justPressed('KeyV')) {
      const modes = def.fireModes;
      st.fireMode = modes[(modes.indexOf(st.fireMode) + 1) % modes.length];
    }

    // --- firing ------------------------------------------------------------
    const triggerHeld = input.mouseDown(0) || input.triggerHeld('right') > 0.4;
    const triggerPressed = input.mouseJustPressed(0);
    const canFire = !this.reloading && !this.swapping && this.fireCooldown <= 0 &&
      st.ammo > 0 && !this.player.sprinting && !this.player.dead;

    let wantsShot = false;
    if (canFire) {
      if (st.fireMode === 'auto') wantsShot = triggerHeld;
      else if (st.fireMode === 'single') wantsShot = triggerPressed;
      else if (st.fireMode === 'burst') {
        if (triggerPressed && st.burstLeft <= 0) st.burstLeft = 3;
        wantsShot = st.burstLeft > 0;
      }
    }
    if (wantsShot) {
      this._shoot(def, st);
      if (st.fireMode === 'burst') st.burstLeft--;
    }
    if (st.ammo === 0 && triggerPressed && !this.reloading) this.audio?.play?.('dryfire');

    // Spread bloom decays back toward the base cone.
    this.bloom = Math.max(0, this.bloom - def.spread.decay * dt * (this.ads > 0.5 ? 2.2 : 1.4));

    this._animate(dt, def);
  }

  _swap(slot) {
    if (slot === this.slot || this.swapping > 0 || slot >= this.loadout.length) return;
    this.slot = slot;
    this.swapping = 0.45;
    this.reloading = 0;
    this.ads = 0;
    for (const id of this.loadout) this.models[id].visible = (id === this.loadout[slot]);
    this.audio?.play?.('swap');
  }

  _shoot(def, st) {
    st.ammo--;
    this.fireCooldown = 60 / def.rpm;
    this.shotIndex++;
    def._shotIndex = this.shotIndex;

    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    _dir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();

    // Cone: base spread by stance, plus per-shot bloom, plus movement penalty.
    const sp = def.spread;
    const moving = clamp(this.player.speed2D / this.player.speeds.run, 0, 1);
    const base = lerp(sp.hip, sp.ads, this.ads) + moving * sp.moving * (1 - this.ads * 0.8);
    const cone = base + this.bloom;
    if (cone > 1e-5) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * cone;
      _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
      _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      _dir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
    }
    this.bloom = Math.min(sp.bloomMax, this.bloom + sp.bloomPerShot);

    _origin.copy(cam.position).addScaledVector(_dir, 0.35);
    this.ballistics.fire({ origin: _origin, direction: _dir, weapon: def, owner: 'player' });

    // Recoil: a deterministic pattern with a small random component, which is
    // what makes a weapon learnable instead of random.
    const rc = def.recoil;
    const n = this.recoilIndex++;
    const patternYaw = Math.sin(n * 0.9) * 0.55 + Math.sin(n * 0.31) * 0.45;
    const climb = 1 - Math.exp(-n * 0.22);
    const adsScale = lerp(1, 0.66, this.ads);
    this.player.addRecoil(
      rc.pitch * (0.55 + climb) * adsScale * (0.85 + Math.random() * 0.3),
      rc.yaw * patternYaw * adsScale * (0.7 + Math.random() * 0.6),
    );
    this._kickVel -= rc.kick * 42;
    this._recoilRot.x -= rc.pitch * 14 * adsScale;
    this._recoilRot.z += rc.roll * patternYaw * 6;

    // Muzzle flash: light + particles at the barrel tip in world space.
    const model = this.models[def.id];
    model.updateMatrixWorld(true);
    const muzzleLocal = model.userData.muzzle || _zero;
    _muzzleWorld.copy(muzzleLocal).applyMatrix4(model.matrixWorld);
    // Convert the viewmodel-space muzzle into world space for the world FX.
    _worldMuzzle.copy(cam.position).addScaledVector(_dir, 0.55);
    _worldMuzzle.y -= 0.06;
    this.engine.game?.lighting?.flash(_worldMuzzle, 0xffd9a0, 26, 0.045, 14);
    this.particles.emit('muzzleSmoke', _worldMuzzle, _dir, { scale: 0.7 });
    if (model.userData.flash) {
      model.userData.flash.visible = true;
      model.userData.flashTimer = 0.035;
      model.userData.flash.rotation.z = Math.random() * Math.PI * 2;
      model.userData.flash.scale.setScalar(0.85 + Math.random() * 0.5);
    }

    this._ejectShell(model);
    this.audio?.playGunshot?.(def.id);
    this.onFire?.({ weapon: def, ammo: st.ammo, direction: _dir.clone(), origin: _origin.clone() });
  }

  _ejectShell(model) {
    const port = model.userData.ejectionPort;
    if (!port || !this.engine.game?.physics) return;
    // Shells are world-space rigid bodies so they bounce off real geometry.
    const cam = this.engine.camera;
    _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    _dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _shellPos.copy(cam.position).addScaledVector(_dir, 0.3).addScaledVector(_right, 0.16).addScaledVector(_up, -0.05);
    this.engine.game.shells?.spawn?.(_shellPos, _right, _up);
  }

  _animate(dt, def) {
    if (!this._visible) return;
    const model = this.models[def.id];
    const player = this.player;

    // Sway: the weapon lags behind the look direction on a spring.
    const look = player.recoilRot;
    const targetSwayX = clamp(-look.y * 6, -0.06, 0.06);
    const targetSwayY = clamp(-look.x * 6, -0.06, 0.06);
    const swayDamp = lerp(9, 18, this.ads);
    this._sway.x = damp(this._sway.x, targetSwayX, swayDamp, dt);
    this._sway.y = damp(this._sway.y, targetSwayY, swayDamp, dt);

    // Walk bob, killed by ADS so the sight picture stays clean.
    const speedRatio = clamp(player.speed2D / player.speeds.run, 0, 1.4) * (1 - this.ads * 0.9);
    this._bob += dt * (7 + speedRatio * 6);
    const bobX = Math.sin(this._bob) * 0.014 * speedRatio;
    const bobY = -Math.abs(Math.cos(this._bob)) * 0.017 * speedRatio;

    // Recoil kick spring along the barrel axis.
    this._kickVel += -this._kick * 260 * dt;
    this._kickVel *= Math.exp(-14 * dt);
    this._kick += this._kickVel * dt;
    this._kick = clamp(this._kick, -0.09, 0.02);
    this._recoilRot.multiplyScalar(Math.exp(-def.recoil.recovery * dt));

    // Sprint pose: weapon drops and tilts across the body.
    const sprint = player.sprinting ? clamp(speedRatio, 0, 1) : 0;
    this._sprintBlend = damp(this._sprintBlend || 0, sprint, 10, dt);

    // Reload animation: dip down and rotate out, then return.
    let reloadDip = 0, reloadRot = 0;
    if (this.reloading > 0) {
      const t = 1 - this.reloading / this.reloadTotal;
      const curve = Math.sin(clamp(t, 0, 1) * Math.PI);
      reloadDip = -curve * 0.14;
      reloadRot = curve * 0.55;
    }
    // Weapon swap: drop off screen and come back up.
    const swapDip = this.swapping > 0 ? -Math.sin((1 - this.swapping / 0.45) * Math.PI) * 0.22 : 0;

    const pose = this.hipPose, apose = this.adsPose;
    const a = smootherstep(this.ads);
    model.position.set(
      lerp(pose.pos.x, apose.pos.x, a) + this._sway.x + bobX + this._sprintBlend * 0.07,
      lerp(pose.pos.y, apose.pos.y, a) + this._sway.y + bobY + reloadDip + swapDip - this._sprintBlend * 0.05,
      lerp(pose.pos.z, apose.pos.z, a) + this._kick,
    );
    model.rotation.set(
      lerp(pose.rot.x, apose.rot.x, a) + this._recoilRot.x - this._sway.y * 2.2 + this._sprintBlend * 0.16,
      lerp(pose.rot.y, apose.rot.y, a) + this._sway.x * 2.6 + reloadRot * 0.35 - this._sprintBlend * 0.55,
      lerp(pose.rot.z, apose.rot.z, a) + this._recoilRot.z + reloadRot * 0.5 + this._sprintBlend * 0.42,
    );

    if (model.userData.flashTimer > 0) {
      model.userData.flashTimer -= dt;
      if (model.userData.flashTimer <= 0 && model.userData.flash) model.userData.flash.visible = false;
    }
  }
}

const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Procedural viewmodel. Built from primitives with a consistent bevel/material
 * language so it reads as machined hardware rather than grey boxes.
 */
function buildViewmodel(id, textures) {
  const g = new THREE.Group();
  g.name = `viewmodel_${id}`;

  const body = textures.material('gunMetal', { metalness: 0.95, roughness: 0.42 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x1d1f1e, roughness: 0.68, metalness: 0.05 });

  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.072, 0.30), body);
  receiver.position.set(0, 0, 0.02);
  g.add(receiver);

  const barrelLen = id === 'smg' ? 0.20 : 0.30;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0115, barrelLen, 16), body);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, -0.16 - barrelLen * 0.5 + 0.16);
  g.add(barrel);

  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.05, barrelLen * 0.8), polymer);
  handguard.position.set(0, 0.008, -0.16);
  g.add(handguard);

  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.062, 0.16), polymer);
  stock.position.set(0, -0.005, 0.24);
  g.add(stock);

  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.10, 0.05), polymer);
  grip.position.set(0, -0.075, 0.10);
  grip.rotation.x = -0.28;
  g.add(grip);

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.115, 0.052), polymer);
  mag.position.set(0, -0.085, -0.005);
  mag.rotation.x = 0.1;
  g.add(mag);

  // Iron sights, aligned on the model's centre line so ADS actually lines up.
  const rearRing = new THREE.Mesh(new THREE.TorusGeometry(0.0085, 0.0022, 8, 16), body);
  rearRing.position.set(0, 0.052, 0.09);
  g.add(rearRing);
  const frontPost = new THREE.Mesh(new THREE.BoxGeometry(0.0022, 0.014, 0.0022), body);
  frontPost.position.set(0, 0.052, -0.245);
  g.add(frontPost);

  // Muzzle flash card, hidden until a shot.
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd08a, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.11), flashMat);
  flash.position.set(0, 0.012, -0.30 - barrelLen * 0.2);
  flash.visible = false;
  g.add(flash);

  g.userData.muzzle = new THREE.Vector3(0, 0.012, -0.30 - barrelLen * 0.2);
  g.userData.ejectionPort = new THREE.Vector3(0.03, 0.02, 0.03);
  g.userData.flash = flash;
  g.userData.flashTimer = 0;

  g.traverse((c) => { if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; c.frustumCulled = false; } });
  return g;
}

const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();
const _worldMuzzle = new THREE.Vector3();
const _shellPos = new THREE.Vector3();
const _zero = new THREE.Vector3();
