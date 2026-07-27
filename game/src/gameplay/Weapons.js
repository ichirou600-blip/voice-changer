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

    // Hip pose: canted in from the right, low enough to leave the frame open.
    // ADS pose: the model's optical axis (userData.sightHeight, minus the
    // optic's own drop) must land exactly on the view camera's centre line, or
    // the reticle sits off-centre when aiming.
    this.hipPose = { pos: new THREE.Vector3(0.148, -0.128, -0.26), rot: new THREE.Euler(0.02, 0.055, 0.012) };
    this.adsPose = { pos: new THREE.Vector3(0.0, -0.054, -0.155), rot: new THREE.Euler(0, 0, 0) };

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
 * A chamfered box. Real firearms have no perfectly sharp exterior edges, and the
 * thin bright line a chamfer catches from a grazing light is most of what sells
 * an object as machined metal rather than as a primitive.
 */
function bevelBox(w, h, d, bevel = 0.0022, material) {
  const shape = new THREE.Shape();
  const hw = w / 2 - bevel, hh = h / 2 - bevel;
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 1,
  });
  geo.translate(0, 0, -(d - bevel * 2) / 2);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

/**
 * Reproject UVs by box mapping at a fixed world scale.
 *
 * ExtrudeGeometry emits UVs in shape-space units, and cylinders/capsules emit
 * their own parameterisations, so one shared tiling material lands at a wildly
 * different texel density on every part — which is why the untreated weapon
 * shows chaotic high-contrast speckle. Projecting from position at a single
 * scale makes the micro-detail read consistently across the whole model.
 */
function boxProjectUV(geometry, scale = 14) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  if (!pos || !nor) return geometry;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (nx >= ny && nx >= nz) { u = z; v = y; }        // project along X
    else if (ny >= nx && ny >= nz) { u = x; v = z; }   // project along Y
    else { u = x; v = y; }                             // project along Z
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** Picatinny rail: a base plus evenly spaced recoil slots, merged to one mesh. */
function picatinnyRail(length, material, slotPitch = 0.0102) {
  const parts = [];
  const base = new THREE.BoxGeometry(0.021, 0.0055, length);
  parts.push(base);
  const slots = Math.max(1, Math.floor(length / slotPitch));
  for (let i = 0; i < slots; i++) {
    const z = -length / 2 + slotPitch * (i + 0.5);
    const tooth = new THREE.BoxGeometry(0.0212, 0.0042, 0.0052);
    tooth.translate(0, 0.0047, z);
    parts.push(tooth);
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return new THREE.Mesh(merged, material);
}

/** Minimal geometry merge — avoids depending on an addon path across versions. */
function mergeGeometries(geometries) {
  const out = new THREE.BufferGeometry();
  let vertexCount = 0;
  for (const g of geometries) {
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    if (g.index) { g.userData._tmp = nonIndexed; }
    vertexCount += (g.index ? nonIndexed : g).attributes.position.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  let vo = 0, uo = 0;
  for (const g of geometries) {
    const src = g.userData._tmp || g;
    const p = src.attributes.position, n = src.attributes.normal, t = src.attributes.uv;
    position.set(p.array.subarray(0, p.count * 3), vo);
    if (n) normal.set(n.array.subarray(0, n.count * 3), vo);
    if (t) uv.set(t.array.subarray(0, t.count * 2), uo);
    vo += p.count * 3;
    uo += p.count * 2;
    if (g.userData._tmp) { g.userData._tmp.dispose(); delete g.userData._tmp; }
  }
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeVertexNormals();
  return out;
}

/**
 * A gloved first-person hand. Nothing reads "console shooter" faster than hands
 * on the weapon; a floating gun reads as a tech demo no matter how good it is.
 * Built as a palm block plus four curled fingers and an opposed thumb, posed by
 * the caller via `curl` so the same builder serves the grip and the handguard.
 */
function glovedHand(material, { curl = 1.0, mirror = false } = {}) {
  const hand = new THREE.Group();

  const palm = bevelBox(0.048, 0.082, 0.036, 0.006, material);
  palm.position.set(0, 0, 0);
  hand.add(palm);

  const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.021, 10, 8), material);
  knuckle.scale.set(1.15, 0.72, 0.9);
  knuckle.position.set(0, 0.038, -0.004);
  hand.add(knuckle);

  // Four fingers, each two segments so the curl reads as a real grip.
  for (let i = 0; i < 4; i++) {
    const x = (-0.017 + i * 0.0115) * (mirror ? -1 : 1);
    const scale = 1 - Math.abs(i - 1.2) * 0.07;
    const root = new THREE.Group();
    root.position.set(x, 0.036, -0.006);
    root.rotation.x = -0.35 - curl * 1.05;

    const prox = new THREE.Mesh(new THREE.CapsuleGeometry(0.0072 * scale, 0.024 * scale, 3, 6), material);
    prox.rotation.x = Math.PI / 2;
    prox.position.z = -0.017 * scale;
    root.add(prox);

    const distal = new THREE.Group();
    distal.position.z = -0.032 * scale;
    distal.rotation.x = -curl * 1.15;
    const dist = new THREE.Mesh(new THREE.CapsuleGeometry(0.0064 * scale, 0.020 * scale, 3, 6), material);
    dist.rotation.x = Math.PI / 2;
    dist.position.z = -0.014 * scale;
    distal.add(dist);
    root.add(distal);

    hand.add(root);
  }

  // Thumb, opposed across the grip.
  const thumb = new THREE.Group();
  thumb.position.set((mirror ? 0.024 : -0.024), 0.012, -0.008);
  thumb.rotation.set(-0.5 - curl * 0.5, (mirror ? -0.7 : 0.7), 0);
  const thumbMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.0092, 0.030, 3, 6), material);
  thumbMesh.rotation.x = Math.PI / 2;
  thumbMesh.position.z = -0.020;
  thumb.add(thumbMesh);
  hand.add(thumb);

  // Wrist and forearm cuff — the sleeve stops the hand ending in mid-air.
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.030, 0.052, 12), material);
  wrist.rotation.x = Math.PI / 2;
  wrist.position.set(0, -0.048, 0.020);
  wrist.rotation.z = 0.1;
  hand.add(wrist);

  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.033, 0.030, 12), material);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, -0.070, 0.044);
  hand.add(cuff);

  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.038, 0.20, 12), material);
  sleeve.rotation.x = Math.PI / 2;
  sleeve.position.set(0, -0.098, 0.155);
  hand.add(sleeve);

  return hand;
}

/**
 * Procedural viewmodel. Built from primitives with a consistent bevel/material
 * language so it reads as machined hardware rather than grey boxes.
 *
 * Proportions are in metres at true scale and the sight line sits on the model's
 * X=0 centre plane, so the ADS pose in WeaponSystem lines the optic up on the
 * screen centre without a fudge offset.
 */
function buildViewmodel(id, textures) {
  const g = new THREE.Group();
  g.name = `viewmodel_${id}`;
  const smg = id === 'smg';

  // Gunmetal is deliberately rougher than a real bare-steel value: the tiled
  // normal detail aliases into specular fireflies under the strong viewmodel key
  // otherwise, and a matte parkerised finish is the correct look anyway.
  const body = textures.material('gunMetal', { metalness: 0.88, roughness: 0.58 });
  // At viewmodel scale a tiled normal map lands several texels per screen pixel,
  // which aliases into rainbow speckle once the grade pass adds chromatic
  // aberration and sharpening on top. Machined metal barely needs surface normal
  // detail this close, so keep the map for micro-break-up but scale it right down.
  body.normalScale.set(0.18, 0.18);
  const polymer = new THREE.MeshStandardMaterial({ color: 0x22241f, roughness: 0.72, metalness: 0.04 });
  const darkPolymer = new THREE.MeshStandardMaterial({ color: 0x141614, roughness: 0.62, metalness: 0.05 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0e0f0e, roughness: 0.92, metalness: 0.0 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x2b2a26, roughness: 0.86, metalness: 0.02 });

  const barrelLen = smg ? 0.20 : 0.30;
  const SIGHT_Y = 0.058;   // optical axis height above the receiver centreline

  // --- receiver -----------------------------------------------------------
  const upper = bevelBox(0.046, 0.040, 0.235, 0.0028, body);
  upper.position.set(0, 0.019, -0.02);
  g.add(upper);

  const lower = bevelBox(0.042, 0.036, 0.150, 0.0028, body);
  lower.position.set(0, -0.015, 0.020);
  g.add(lower);

  // Magazine well flares outward at the bottom — a strong silhouette cue.
  const magwell = bevelBox(0.040, 0.046, 0.062, 0.003, body);
  magwell.position.set(0, -0.034, -0.012);
  g.add(magwell);

  // Ejection port, brass deflector and forward assist on the right side.
  const port = bevelBox(0.004, 0.020, 0.048, 0.0012, darkPolymer);
  port.position.set(0.024, 0.020, -0.030);
  g.add(port);
  const deflector = new THREE.Mesh(new THREE.ConeGeometry(0.010, 0.020, 8), body);
  deflector.rotation.set(Math.PI / 2, 0, -0.5);
  deflector.position.set(0.025, 0.026, 0.002);
  g.add(deflector);
  const forwardAssist = new THREE.Mesh(new THREE.CylinderGeometry(0.0058, 0.0058, 0.016, 10), body);
  forwardAssist.rotation.z = Math.PI / 2;
  forwardAssist.position.set(0.026, 0.014, 0.010);
  g.add(forwardAssist);

  // Charging handle protruding from the rear of the upper.
  const charge = bevelBox(0.030, 0.008, 0.022, 0.0015, body);
  charge.position.set(0, 0.030, 0.098);
  g.add(charge);
  const chargeLatch = bevelBox(0.014, 0.010, 0.008, 0.001, body);
  chargeLatch.position.set(-0.016, 0.030, 0.100);
  g.add(chargeLatch);

  // Safety selector and magazine release.
  const selector = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.030, 10), body);
  selector.rotation.z = Math.PI / 2;
  selector.position.set(0, -0.008, 0.052);
  g.add(selector);
  const selectorLever = bevelBox(0.006, 0.006, 0.020, 0.0008, body);
  selectorLever.position.set(-0.020, -0.012, 0.050);
  selectorLever.rotation.x = 0.5;
  g.add(selectorLever);
  const magRelease = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.008, 8), body);
  magRelease.rotation.z = Math.PI / 2;
  magRelease.position.set(0.023, -0.020, 0.006);
  g.add(magRelease);

  // --- top rail + optic ----------------------------------------------------
  const rail = picatinnyRail(0.215, body);
  rail.position.set(0, 0.041, -0.02);
  g.add(rail);

  // Red-dot sight: housing, hood, tinted glass and an emissive reticle dot.
  const optic = new THREE.Group();
  optic.position.set(0, SIGHT_Y - 0.004, -0.010);
  const opticBase = bevelBox(0.026, 0.016, 0.048, 0.0018, darkPolymer);
  opticBase.position.y = -0.010;
  optic.add(opticBase);
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.042, 16, 1, true), darkPolymer);
  hood.rotation.x = Math.PI / 2;
  optic.add(hood);
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0x1a2a24, roughness: 0.06, metalness: 0.0,
    transmission: 0.55, thickness: 0.004, ior: 1.5,
    transparent: true, opacity: 0.62,
    // A real coated optic throws a cyan-green sheen back at the shooter.
    iridescence: 0.6, iridescenceIOR: 1.9,
  });
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0148, 20), lensMat);
  lens.position.z = 0.014;
  optic.add(lens);
  const reticle = new THREE.Mesh(
    new THREE.CircleGeometry(0.0016, 10),
    new THREE.MeshBasicMaterial({ color: 0xff2a12, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  reticle.position.z = 0.0155;
  optic.add(reticle);
  g.add(optic);

  // Backup iron sights, folded down beside the optic.
  const rearIron = new THREE.Mesh(new THREE.TorusGeometry(0.0072, 0.0018, 6, 14), body);
  rearIron.position.set(0, SIGHT_Y, 0.082);
  g.add(rearIron);
  const frontPostBase = bevelBox(0.010, 0.014, 0.010, 0.001, body);
  frontPostBase.position.set(0, SIGHT_Y - 0.006, -0.222);
  g.add(frontPostBase);
  const frontPost = new THREE.Mesh(new THREE.BoxGeometry(0.0022, 0.013, 0.0022), body);
  frontPost.position.set(0, SIGHT_Y + 0.002, -0.222);
  g.add(frontPost);

  // --- barrel group --------------------------------------------------------
  const barrelZ = -0.115 - barrelLen * 0.5;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0092, 0.0102, barrelLen, 16), body);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.012, barrelZ);
  g.add(barrel);

  const gasBlock = bevelBox(0.020, 0.024, 0.026, 0.0015, body);
  gasBlock.position.set(0, 0.016, -0.196);
  g.add(gasBlock);
  const gasTube = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.11, 8), body);
  gasTube.rotation.x = Math.PI / 2;
  gasTube.position.set(0, 0.030, -0.148);
  g.add(gasTube);

  // Flash hider with cut prongs.
  const hider = new THREE.Mesh(new THREE.CylinderGeometry(0.0135, 0.0115, 0.040, 14), body);
  hider.rotation.x = Math.PI / 2;
  hider.position.set(0, 0.012, barrelZ - barrelLen * 0.5 - 0.018);
  g.add(hider);
  for (let i = 0; i < 4; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.0032, 0.016, 0.024), darkPolymer);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    slot.position.set(Math.cos(a) * 0.011, 0.012 + Math.sin(a) * 0.011, barrelZ - barrelLen * 0.5 - 0.022);
    slot.rotation.z = a;
    g.add(slot);
  }

  // Free-float handguard with M-LOK slots cut along both flanks.
  const hgLen = barrelLen * 0.78;
  const hgZ = -0.115 - hgLen * 0.5 + 0.012;
  const handguard = new THREE.Mesh(new THREE.CylinderGeometry(0.0225, 0.0235, hgLen, 12), polymer);
  handguard.rotation.x = Math.PI / 2;
  handguard.position.set(0, 0.013, hgZ);
  g.add(handguard);
  const slotCount = Math.floor(hgLen / 0.030);
  for (let i = 0; i < slotCount; i++) {
    const z = hgZ - hgLen / 2 + 0.020 + i * 0.030;
    for (const side of [-1, 1]) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.0075, 0.020), darkPolymer);
      slot.position.set(side * 0.0222, 0.013, z);
      g.add(slot);
    }
  }
  const hgRail = picatinnyRail(hgLen - 0.02, body);
  hgRail.position.set(0, 0.035, hgZ);
  g.add(hgRail);

  // Angled foregrip — gives the support hand something to actually hold.
  const foregrip = bevelBox(0.020, 0.044, 0.030, 0.003, darkPolymer);
  foregrip.position.set(0, -0.014, hgZ - 0.010);
  foregrip.rotation.x = 0.42;
  g.add(foregrip);

  // --- stock, grip, magazine ----------------------------------------------
  const bufferTube = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.155, 12), body);
  bufferTube.rotation.x = Math.PI / 2;
  bufferTube.position.set(0, 0.014, 0.175);
  g.add(bufferTube);

  const stock = bevelBox(0.040, 0.058, 0.115, 0.004, polymer);
  stock.position.set(0, 0.004, 0.205);
  g.add(stock);
  const cheek = bevelBox(0.034, 0.016, 0.090, 0.003, polymer);
  cheek.position.set(0, 0.038, 0.200);
  g.add(cheek);
  const buttPad = bevelBox(0.042, 0.062, 0.014, 0.004, rubber);
  buttPad.position.set(0, -0.002, 0.268);
  g.add(buttPad);

  const grip = bevelBox(0.034, 0.098, 0.046, 0.004, polymer);
  grip.position.set(0, -0.072, 0.062);
  grip.rotation.x = -0.30;
  g.add(grip);
  // Grip texture panels: a few raised strips read as stippling at this scale.
  for (let i = 0; i < 4; i++) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.005, 0.0032), rubber);
    strip.position.set(0, -0.048 - i * 0.016, 0.062 - 0.024 - i * 0.0068);
    strip.rotation.x = -0.30;
    g.add(strip);
  }

  const triggerGuard = new THREE.Mesh(new THREE.TorusGeometry(0.020, 0.0032, 6, 16, Math.PI * 1.15), body);
  triggerGuard.rotation.set(0, Math.PI / 2, -0.35);
  triggerGuard.position.set(0, -0.032, 0.030);
  g.add(triggerGuard);
  const trigger = bevelBox(0.005, 0.020, 0.006, 0.001, body);
  trigger.position.set(0, -0.030, 0.030);
  trigger.rotation.x = 0.25;
  g.add(trigger);

  // Curved STANAG magazine: stacked segments following a shallow arc.
  const mag = new THREE.Group();
  const MAG_SEGMENTS = 6;
  for (let i = 0; i < MAG_SEGMENTS; i++) {
    const t = i / (MAG_SEGMENTS - 1);
    const seg = bevelBox(0.028, 0.026, 0.044 - t * 0.002, 0.002, darkPolymer);
    // Arc forward as it descends, exactly as a real curved magazine does.
    seg.position.set(0, -0.014 - i * 0.024, -0.004 - t * t * 0.026);
    seg.rotation.x = -t * 0.22;
    mag.add(seg);
  }
  mag.position.set(0, -0.044, -0.010);
  g.add(mag);

  // Sling loop at the rear — small, but it breaks up the stock silhouette.
  const slingLoop = new THREE.Mesh(new THREE.TorusGeometry(0.010, 0.0022, 6, 12), body);
  slingLoop.rotation.y = Math.PI / 2;
  slingLoop.position.set(-0.020, 0.006, 0.150);
  g.add(slingLoop);

  // --- hands ---------------------------------------------------------------
  // Firing hand wraps the pistol grip; support hand rides the foregrip.
  const rightHand = glovedHand(glove, { curl: 1.0, mirror: false });
  rightHand.position.set(0.030, -0.074, 0.078);
  rightHand.rotation.set(-0.30, -0.22, 0.16);
  rightHand.scale.setScalar(1.06);
  g.add(rightHand);

  const leftHand = glovedHand(glove, { curl: 0.92, mirror: true });
  leftHand.position.set(-0.032, -0.028, hgZ - 0.014);
  leftHand.rotation.set(0.34, 0.30, -0.22);
  leftHand.scale.setScalar(1.06);
  g.add(leftHand);

  // --- muzzle flash --------------------------------------------------------
  const muzzleZ = barrelZ - barrelLen * 0.5 - 0.038;
  const flash = new THREE.Group();
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  });
  // Star-shaped flash: crossed cards so it reads from any roll angle.
  for (let i = 0; i < 3; i++) {
    const card = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), flashMat);
    card.rotation.z = (i / 3) * Math.PI;
    flash.add(card);
  }
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.030, 0.075, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffb552, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    }),
  );
  cone.rotation.x = -Math.PI / 2;
  cone.position.z = -0.030;
  flash.add(cone);
  flash.position.set(0, 0.012, muzzleZ);
  flash.visible = false;
  g.add(flash);

  g.userData.muzzle = new THREE.Vector3(0, 0.012, muzzleZ);
  g.userData.ejectionPort = new THREE.Vector3(0.026, 0.020, -0.010);
  g.userData.flash = flash;
  g.userData.flashTimer = 0;
  g.userData.sightHeight = SIGHT_Y;

  // Viewmodels never cast into the world and must never be frustum-culled:
  // they live in their own scene rendered after a depth clear. Reproject UVs on
  // everything so the shared tiling gunmetal keeps a consistent texel density.
  g.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = false;
    c.receiveShadow = false;
    c.frustumCulled = false;
    if (c.material === body || c.material === polymer || c.material === darkPolymer) {
      boxProjectUV(c.geometry, 7);
    }
  });
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
