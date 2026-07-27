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

/**
 * Picatinny rail: a solid base, a continuous ribbed top, and narrow recoil
 * grooves cut into it.
 *
 * The previous build spaced 5 mm teeth on a 10 mm pitch, which is the real MIL-
 * STD-1913 geometry and still read as a bicycle chain — because at viewmodel
 * scale each tooth covers a dozen screen pixels and the 5 mm of *background*
 * between them covers a dozen more. So the pitch is halved and the groove
 * narrowed to a fifth of it: the rail resolves as one ribbed bar with a texture
 * of slots, which is what a rail looks like to an eye rather than to a caliper.
 * The base is also tall enough now that the grooves never cut through to sky.
 */
function picatinnyRail(length, material, slotPitch = 0.0051) {
  const parts = [];
  parts.push(new THREE.BoxGeometry(0.021, 0.0082, length));
  // The ribbed top is one continuous bar; the grooves are the gaps between the
  // ribs, so there is never a hole through the rail.
  const slots = Math.max(1, Math.round(length / slotPitch));
  const rib = slotPitch - 0.0011;
  for (let i = 0; i < slots; i++) {
    const z = -length / 2 + slotPitch * (i + 0.5);
    const tooth = new THREE.BoxGeometry(0.0212, 0.0040, rib);
    tooth.translate(0, 0.0058, z);
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
 * Built as a wedge palm, a thenar pad, four scalloped knuckles under a hard
 * guard, four three-segment fingers and a two-segment opposed thumb — because
 * the version this replaces resolved, at the size the weapon actually occupies
 * on screen, to four smooth stacked rings. Fingers are what make a hand read;
 * everything else is the wrist it hangs off. `curl`, `wrap` and `trigger` pose
 * it, so the same builder serves the pistol grip and the handguard.
 */
function glovedHand(material, plate, { curl = 1.0, mirror = false, wrap = 0, trigger = false } = {}) {
  const hand = new THREE.Group();
  const s = mirror ? -1 : 1;

  // Palm: wedge-shaped, thicker at the thumb side, and rolled about Z so the
  // knuckle line runs diagonally the way a real hand's does. A symmetric block
  // is the thing that reads as a mitten.
  const palm = bevelBox(0.046, 0.076, 0.032, 0.005, material);
  palm.rotation.z = s * 0.10;
  hand.add(palm);
  // Thenar pad — the muscle at the base of the thumb, and the widest part of a
  // closed fist in silhouette.
  const thenar = new THREE.Mesh(new THREE.SphereGeometry(0.017, 10, 8), material);
  thenar.scale.set(0.9, 1.5, 1.15);
  thenar.position.set(-s * 0.019, -0.008, 0.004);
  hand.add(thenar);

  // Four knuckles as individual domes, not one bar: the scalloped knuckle line
  // is the single most recognisable thing about a fist at this distance.
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.0092, 8, 6), plate);
    k.scale.set(1.0, 0.85, 1.25);
    k.position.set(s * (-0.0165 + i * 0.011), 0.0375 - Math.abs(t - 0.35) * 0.006, -0.008);
    hand.add(k);
  }
  // Knuckle guard across them — the hard plate every shooting glove has.
  const guard = bevelBox(0.042, 0.017, 0.011, 0.002, plate);
  guard.position.set(0, 0.036, -0.011);
  guard.rotation.x = -0.35;
  hand.add(guard);

  // Four fingers, three segments each, wrapping around and *under* whatever the
  // hand is holding. `wrap` splays the curl across the fingers so they close in
  // sequence instead of all at the same angle, which is what turns four
  // parallel tubes into a grip.
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const scale = 1.03 - Math.abs(t - 0.28) * 0.20;
    const root = new THREE.Group();
    root.position.set(s * (-0.0165 + i * 0.011), 0.034, -0.010);
    // Fingers fan slightly outward from the hand's axis.
    root.rotation.y = s * (t - 0.4) * 0.16;
    // The trigger finger is straight, not curled: an index finger folded into
    // the fist alongside the other three is the tell that a hand was modelled
    // as a unit rather than as a hand doing something.
    const c = (trigger && i === 0) ? 0.18 : curl + wrap * (t - 0.4);
    root.rotation.x = -0.30 - c * 1.05;

    const prox = new THREE.Mesh(new THREE.CapsuleGeometry(0.0080 * scale, 0.026 * scale, 3, 7), material);
    prox.rotation.x = Math.PI / 2;
    prox.position.z = -0.018 * scale;
    root.add(prox);

    const mid = new THREE.Group();
    mid.position.z = -0.035 * scale;
    mid.rotation.x = -c * 1.05;
    const midMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.0072 * scale, 0.019 * scale, 3, 7), material);
    midMesh.rotation.x = Math.PI / 2;
    midMesh.position.z = -0.013 * scale;
    mid.add(midMesh);
    root.add(mid);

    const tip = new THREE.Group();
    tip.position.z = -0.026 * scale;
    tip.rotation.x = -c * 0.85;
    const tipMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.0064 * scale, 0.013 * scale, 3, 7), material);
    tipMesh.rotation.x = Math.PI / 2;
    tipMesh.position.z = -0.010 * scale;
    tip.add(tipMesh);
    mid.add(tip);

    hand.add(root);
  }

  // Thumb: two segments, opposed across the grip and rolled over the top of the
  // fingers, which is what closes the loop of a fist.
  const thumb = new THREE.Group();
  thumb.position.set(-s * 0.021, 0.006, -0.006);
  thumb.rotation.set(-0.42 - curl * 0.34, -s * (0.62 + curl * 0.22), s * 0.30);
  const meta = new THREE.Mesh(new THREE.CapsuleGeometry(0.0098, 0.024, 3, 7), material);
  meta.rotation.x = Math.PI / 2;
  meta.position.z = -0.017;
  thumb.add(meta);
  const distal = new THREE.Group();
  distal.position.z = -0.031;
  distal.rotation.x = -curl * 0.75;
  const distalMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.0086, 0.018, 3, 7), material);
  distalMesh.rotation.x = Math.PI / 2;
  distalMesh.position.z = -0.013;
  distal.add(distalMesh);
  thumb.add(distal);
  hand.add(thumb);

  // Wrist and forearm cuff — the sleeve stops the hand ending in mid-air. The
  // wrist is squashed on one axis because a round wrist is a broom handle.
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.029, 0.050, 12), material);
  wrist.rotation.x = Math.PI / 2;
  wrist.scale.set(1.0, 1.0, 0.78);
  wrist.position.set(0, -0.046, 0.020);
  wrist.rotation.z = 0.1;
  hand.add(wrist);

  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.033, 0.026, 12), plate);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.set(0, -0.068, 0.042);
  hand.add(cuff);

  // Short stub, not a full forearm. poseHand aims the arm axis back toward the
  // eye, so a 20 cm sleeve runs straight at the near plane and renders as a
  // beige cylinder across the bottom of the frame — it was the largest object
  // on screen. Real viewmodels let the arm leave through the frame edge instead
  // of modelling it toward the lens; this only has to close off the cuff.
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.034, 0.075, 12), material);
  sleeve.rotation.x = Math.PI / 2;
  sleeve.position.set(0, -0.082, 0.088);
  hand.add(sleeve);

  return hand;
}

// Reference frame of the hand `glovedHand` builds, in its own local space:
// the held object passes through HAND_HOLD, the four knuckles are spread along
// +X, and the forearm leaves along HAND_FORE.
const HAND_HOLD = new THREE.Vector3(0, 0.030, -0.030);
const HAND_FORE = new THREE.Vector3(0, -0.548, 0.837).normalize();
const HAND_BINORM = new THREE.Vector3(1, 0, 0).cross(HAND_FORE);
const HAND_LOCAL = new THREE.Matrix4()
  .makeBasis(new THREE.Vector3(1, 0, 0), HAND_FORE, HAND_BINORM)
  .transpose();

/**
 * Put a hand on something.
 *
 * @param hold  Point the held object's axis passes through, in model space.
 * @param axis  Direction that object runs in — the fingers spread along it.
 * @param fore  Direction the forearm leaves toward the shoulder.
 *
 * Solving from the held geometry instead of from Euler angles is what keeps the
 * fingers actually closed around the handguard: move the handguard and the hand
 * follows it, rather than drifting off into space the next time a proportion
 * changes.
 */
function poseHand(hand, hold, axis, fore) {
  const x = _hx.copy(axis).normalize();
  const f = _hf.copy(fore);
  f.addScaledVector(x, -f.dot(x)).normalize();   // forearm, squared to the axis
  const b = _hb.crossVectors(x, f);
  _hm.makeBasis(x, f, b).multiply(HAND_LOCAL);
  hand.quaternion.setFromRotationMatrix(_hm);
  hand.position.copy(hold).sub(_ho.copy(HAND_HOLD).applyQuaternion(hand.quaternion));
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

  // Every material on the weapon comes out of the texture library, so every one
  // of them carries a normal and a roughness map. Hand-rolled flat-colour
  // MeshStandardMaterials for the furniture were most of why the receiver, the
  // handguard, the rail and the optic all resolved to the same slate blue-grey:
  // with no roughness break there is nothing for the key to model, and with no
  // albedo separation the only thing left distinguishing them was the sky
  // reflection they all shared.
  //
  // `map: null` on the non-metals is deliberate. The gunMetal albedo is a 0.03
  // parkerised near-black, which is right for a receiver and wrong for anything
  // else — dropping it lets the material colour carry the value ladder while the
  // normal and ORM maps still do their job. The ladder, darkest first:
  // buttpad 0x0e -> mag/optic 0x1a -> receiver (parkerised map) -> handguard and
  // stock 0x3a -> glove 0x5b -> rail 0x93. Six steps, and the rail and the glove
  // are the two the eye lands on.
  const v2 = (s) => new THREE.Vector2(s, s);
  const kit = (opts) => textures.material('gunMetal', opts);

  // Parkerised receiver. Rougher than bare steel but well short of the 0.58 it
  // used to run at: under a 3.4-intensity key, 0.58 spreads the lobe so wide
  // that a metalness-0.9 surface returns no highlight at all, which is exactly
  // the "zero specular anywhere" the review found.
  const body = kit({ metalness: 0.90, roughness: 0.38, normalScale: v2(0.20) });
  // Hard-anodised aluminium: the brightest, glossiest thing on the weapon, and
  // the one part guaranteed to carry a specular highlight.
  const rail = kit({ map: null, color: 0x86837c, metalness: 0.94, roughness: 0.28, normalScale: v2(0.30) });
  // Reinforced polymer furniture — matte, non-metallic, and a clear step lighter
  // than the receiver so the handguard separates from the gun it wraps.
  const polymer = kit({ map: null, color: 0x3a3e35, metalness: 0.03, roughness: 0.62, normalScale: v2(0.85) });
  const darkPolymer = kit({ map: null, color: 0x1a1c19, metalness: 0.04, roughness: 0.50, normalScale: v2(0.75) });
  const rubber = kit({ map: null, color: 0x0e100e, metalness: 0.0, roughness: 0.92, normalScale: v2(1.15) });
  // Coyote-brown nomex. Gloves the same value as the weapon are gloves nobody
  // sees; this is the warmest, lightest surface in the frame on purpose.
  const glove = kit({ map: null, color: 0x5b513c, metalness: 0.02, roughness: 0.74, normalScale: v2(1.0) });

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
  const topRail = picatinnyRail(0.215, rail);
  topRail.position.set(0, 0.041, -0.02);
  g.add(topRail);

  // Red-dot sight. The old build put an opaque additive disc *in front* of the
  // glass, which is why it read as an orange sticker: the reticle has to sit
  // behind the lens, at the focal plane, so the glass tints and reflects over
  // the top of it. So: housing, hood, a transmissive coated lens, and behind it
  // a 2 MOA dot inside a ring — a shape, not a blob — plus a soft bloom card
  // that gives the emitter the glow a real illuminated reticle has.
  const optic = new THREE.Group();
  optic.position.set(0, SIGHT_Y - 0.004, -0.010);
  const opticBase = bevelBox(0.026, 0.016, 0.048, 0.0018, darkPolymer);
  opticBase.position.y = -0.019;
  optic.add(opticBase);
  // The mount clamp — a hard bright edge where the optic meets the rail.
  const opticClamp = bevelBox(0.030, 0.007, 0.014, 0.0012, rail);
  opticClamp.position.set(0, -0.026, -0.014);
  optic.add(opticClamp);
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.0170, 0.0170, 0.044, 20, 1, true), darkPolymer);
  hood.rotation.x = Math.PI / 2;
  optic.add(hood);

  // The tube interior, so a glance down the side of the optic sees a dark bore
  // rather than the back faces of the hood.
  const bore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0158, 0.0158, 0.040, 20, 1, true),
    kit({ map: null, color: 0x08090a, roughness: 0.95, metalness: 0.0, side: THREE.BackSide }),
  );
  bore.rotation.x = Math.PI / 2;
  optic.add(bore);

  const reticleMat = new THREE.MeshBasicMaterial({
    color: 0xff5522, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const reticle = new THREE.Group();
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.00085, 10), reticleMat);
  reticle.add(dot);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.0043, 0.0054, 28), reticleMat);
  reticle.add(ring);
  // Bloom card: the emitter's halo, and what stops the dot reading as a decal.
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(0.0058, 16),
    new THREE.MeshBasicMaterial({
      color: 0xff4a18, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  halo.position.z = -0.0004;
  reticle.add(halo);
  reticle.position.z = 0.0075;
  optic.add(reticle);

  // Glass last, so it composites over the reticle behind it.
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0x223a33, roughness: 0.03, metalness: 0.0,
    transmission: 0.86, thickness: 0.003, ior: 1.52,
    transparent: true, opacity: 0.5, depthWrite: false,
    // A real coated optic throws a cyan-green sheen back at the shooter.
    iridescence: 0.9, iridescenceIOR: 2.1, iridescenceThicknessRange: [180, 480],
    clearcoat: 1.0, clearcoatRoughness: 0.02,
  });
  const ocular = new THREE.Mesh(new THREE.CircleGeometry(0.0158, 24), lensMat);
  ocular.position.z = 0.0165;          // the shooter's side: +Z is behind the gun
  ocular.renderOrder = 2;
  optic.add(ocular);
  // Objective glass, so the optic is a tube with two surfaces and not a cup.
  const objective = new THREE.Mesh(new THREE.CircleGeometry(0.0158, 24), lensMat);
  objective.position.z = -0.0175;
  objective.rotation.y = Math.PI;
  objective.renderOrder = 2;
  optic.add(objective);
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
  const hgRail = picatinnyRail(hgLen - 0.02, rail);
  hgRail.position.set(0, 0.035, hgZ);
  g.add(hgRail);

  // Handstop, forward of the support hand. The angled foregrip it replaces sat
  // exactly where the fingers now wrap, so the hand could only ever be posed
  // beside the weapon instead of around it.
  const handstop = bevelBox(0.018, 0.020, 0.016, 0.002, darkPolymer);
  handstop.position.set(0, -0.006, hgZ - hgLen * 0.5 + 0.030);
  handstop.rotation.x = 0.55;
  g.add(handstop);

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
  // Firing hand closes on the pistol grip with the trigger finger out; support
  // hand takes the handguard in a C-clamp. Both are placed by `poseHand`, which
  // solves the orientation from the axis of the thing being held rather than
  // from three hand-tuned Euler angles — the old numbers had both hands rotated
  // as though gripping a bar running left-to-right across the screen, which is
  // why neither one made contact with anything.
  const rightHand = glovedHand(glove, darkPolymer, { curl: 1.0, wrap: 0.22, trigger: true });
  poseHand(
    rightHand,
    new THREE.Vector3(0, -0.058, 0.056),        // where the grip passes through the fist
    new THREE.Vector3(0, -0.955, 0.296),        // down the grip: index at the top
    new THREE.Vector3(0.34, -0.30, 0.89),       // forearm runs back and right
  );
  rightHand.scale.setScalar(1.06);
  g.add(rightHand);

  const leftHand = glovedHand(glove, darkPolymer, { curl: 0.80, wrap: 0.30, mirror: true });
  poseHand(
    leftHand,
    new THREE.Vector3(0, 0.013, hgZ + 0.018),   // the handguard's own axis
    new THREE.Vector3(0, 0, -1),                // fingers spread along the barrel
    new THREE.Vector3(-0.42, -0.52, 0.74),      // forearm runs back and left
  );
  leftHand.scale.setScalar(1.04);
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
  // Every kit material now shares one tiled set, so every mesh wearing one needs
  // the same box projection — the rail, the buttpad and the gloves included, or
  // their normal detail lands at a texel density nothing else on the model uses.
  const projected = new Set([body, rail, polymer, darkPolymer, rubber, glove]);
  g.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = false;
    c.receiveShadow = false;
    c.frustumCulled = false;
    if (projected.has(c.material)) boxProjectUV(c.geometry, 7);
  });
  return g;
}

const _hx = new THREE.Vector3();
const _hf = new THREE.Vector3();
const _hb = new THREE.Vector3();
const _ho = new THREE.Vector3();
const _hm = new THREE.Matrix4();

const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();
const _worldMuzzle = new THREE.Vector3();
const _shellPos = new THREE.Vector3();
const _zero = new THREE.Vector3();
