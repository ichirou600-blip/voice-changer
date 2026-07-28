import * as THREE from 'three';
import {
  damp, clamp, lerp, Simplex, fbm2, worley2, smoothstep,
} from '../core/Noise.js';

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
    // The old hip pose put the receiver's centreline within 5 mm of the bottom
    // of the frame, so everything that says "rifle" rather than "bar" — magwell,
    // ejection port, charging handle, selector, grip — was cropped off and the
    // only thing on screen was handguard, rail and optic. Raised and pushed out
    // to 30 cm so the receiver sits about half way down the right of the frame.
    this.hipPose = { pos: new THREE.Vector3(0.152, -0.086, -0.300), rot: new THREE.Euler(0.03, 0.135, 0.014) };
    // Derived from the model rather than written down: the optic sits higher
    // now that it clamps onto the rail instead of intersecting it, and a hand
    // number here would put the reticle off the screen centre.
    const sight = this.models[this.loadout[0]].userData.sightHeight;
    this.adsPose = { pos: new THREE.Vector3(0.0, -(sight - 0.004), -0.155), rot: new THREE.Euler(0, 0, 0) };

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

    // The reticle is an emitter behind a lens, not paint on the objective: an
    // eye forty degrees off the optical axis — which is where the camera is at
    // the hip pose — sees nothing of it at all. It fades in with the aim blend.
    const ret = model.userData.reticle;
    if (ret) {
      const vis = this.ads * this.ads;
      if (model.userData.reticleNode) model.userData.reticleNode.visible = vis > 0.005;
      for (const r of ret) r.m.opacity = r.o * vis;
    }

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
  // Per *triangle*, not per vertex. Choosing the axis from each vertex's own
  // normal means a triangle spanning the corner of a box — or any triangle on a
  // cylinder near the 45 degree line — gets two of its corners projected down X
  // and the third down Y. The UVs then interpolate across a discontinuity, the
  // derivative explodes, the sampler drops to the smallest mip and the surface
  // comes out in hard-edged light and dark patches. That was the blotching all
  // over the rail, the buffer tube and the barrel. Deriving the axis from the
  // face normal keeps every triangle internally consistent; the seams between
  // triangles are invisible because the sheets are stochastic.
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = src.attributes.position;
  if (!pos) return geometry;
  const uv = new Float32Array(pos.count * 2);
  const ax = new THREE.Vector3(), bx = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t + 2 < pos.count; t += 3) {
    ax.set(pos.getX(t + 1) - pos.getX(t), pos.getY(t + 1) - pos.getY(t), pos.getZ(t + 1) - pos.getZ(t));
    bx.set(pos.getX(t + 2) - pos.getX(t), pos.getY(t + 2) - pos.getY(t), pos.getZ(t + 2) - pos.getZ(t));
    n.crossVectors(ax, bx);
    const nx = Math.abs(n.x), ny = Math.abs(n.y), nz = Math.abs(n.z);
    const axis = (nx >= ny && nx >= nz) ? 0 : (ny >= nz ? 1 : 2);
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const u = axis === 0 ? z : x;
      const v = axis === 1 ? z : y;
      uv[i * 2] = u * scale;
      uv[i * 2 + 1] = v * scale;
    }
  }
  src.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (src !== geometry) {
    geometry.copy(src);
    src.dispose();
  }
  return geometry;
}

// MIL-STD-1913 cross-section, in metres. The rib is 21.2 mm across the top of
// its flanks and chamfered down to 16 mm at the crown; the web it stands on is
// 15.6 mm, so every rib overhangs the web by 2.8 mm a side. That overhang is
// the whole point: it is what puts a shadowed undercut under every rib and a
// visible floor at the bottom of every slot. A rail modelled as a flat bar with
// ribs the same width as the bar has no cross-slot depth from any angle, which
// is exactly what the last build shipped.
const RAIL_WEB_W = 0.0156;
const RAIL_WEB_H = 0.0102;
const RAIL_RIB_W = 0.0212;
const RAIL_TOP_W = 0.0160;
const RAIL_RIB_H = 0.0052;
/** Height of a rail's crown above its own origin — where a mount sits. */
export const RAIL_CROWN = RAIL_WEB_H / 2 + RAIL_RIB_H;

/** Chamfered rib cross-section, extruded along the rail's axis. */
function railRibGeometry(len) {
  const y0 = RAIL_WEB_H / 2;
  const y1 = y0 + RAIL_RIB_H;
  const s = new THREE.Shape();
  s.moveTo(-RAIL_RIB_W / 2, y0);
  s.lineTo(RAIL_RIB_W / 2, y0);
  s.lineTo(RAIL_RIB_W / 2, y1 - 0.0016);
  s.lineTo(RAIL_TOP_W / 2, y1);
  s.lineTo(-RAIL_TOP_W / 2, y1);
  s.lineTo(-RAIL_RIB_W / 2, y1 - 0.0016);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -len / 2);
  return geo;
}

/**
 * Picatinny rail: a narrow web carrying chamfered recoil ribs at the real 10 mm
 * pitch, returned as a group of two meshes so the web can be a value darker
 * than the ribs.
 *
 * An earlier build halved the pitch to stop the rail reading as a bicycle
 * chain. It did — by turning it into a row of identical bright blocks with a
 * 1.4 mm gap, which is under two pixels at viewmodel scale and so resolves as
 * one continuous bright bar. The chain read came from the slots having no
 * *depth*, not from their pitch; with a 5 mm floor, an undercut and a darker
 * web the true pitch reads as a rail.
 */
function picatinnyRail(length, ribMat, webMat, slotPitch = 0.0100) {
  const group = new THREE.Group();
  const web = new THREE.Mesh(new THREE.BoxGeometry(RAIL_WEB_W, RAIL_WEB_H, length), webMat);
  group.add(web);

  const slots = Math.max(1, Math.round(length / slotPitch));
  const pitch = length / slots;
  const proto = railRibGeometry(pitch * 0.465);
  const parts = [];
  for (let i = 0; i < slots; i++) {
    const g = proto.clone();
    g.translate(0, 0, -length / 2 + pitch * (i + 0.5));
    parts.push(g);
  }
  proto.dispose();
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  group.add(new THREE.Mesh(merged, ribMat));
  group.userData.crown = RAIL_CROWN;
  return group;
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
 * Joint angles for a three-phalange finger closing on a cylinder.
 *
 * Everything here happens in the hand's YZ plane, where the held object is a
 * circle of radius `radius` centred on (axisY, axisZ) and the knuckle sits at
 * (rootY, rootZ). The proximal segment is the chord that reaches from the
 * knuckle onto that circle; the middle and distal segments are chords *of* it.
 * The result is a finger that lies on the surface of the thing it grips instead
 * of at whatever angle a hand-tuned Euler happened to be, and — because the
 * chords keep turning — one that carries on past the far side rather than
 * stopping on top.
 *
 * @returns absolute rotations about X, one per segment, in root-frame order.
 */
function wrapFinger(rootY, rootZ, axisY, axisZ, radius, lens) {
  const dy = rootY - axisY;
  const dz = rootZ - axisZ;
  const d0 = Math.max(1e-5, Math.hypot(dy, dz));
  const start = Math.atan2(dz, dy);

  // Where segment 1 lands on the circle: law of cosines on (d0, radius, L0).
  const cosD = (d0 * d0 + radius * radius - lens[0] * lens[0]) / (2 * d0 * radius);
  const phi = [start - Math.acos(clamp(cosD, -1, 1))];
  for (let i = 1; i < lens.length; i++) {
    phi.push(phi[i - 1] - 2 * Math.asin(clamp(lens[i] / (2 * radius), -1, 1)));
  }

  // A segment rotated by t about X points along (sin t, -cos t) in YZ, so the
  // tangent of the arc at angle p is simply t = p — the chord of an arc between
  // two angles takes the tangent at their midpoint.
  const qy = axisY + radius * Math.cos(phi[0]);
  const qz = axisZ + radius * Math.sin(phi[0]);
  const out = [Math.atan2(qy - rootY, -(qz - rootZ))];
  for (let i = 1; i < lens.length; i++) out.push((phi[i - 1] + phi[i]) / 2);
  return out;
}

const HAND_ARM_AXIS = new THREE.Vector3(0, -1, 0);

/**
 * Bake an occlusion term into a geometry's colour attribute.
 *
 * The viewmodel is rendered into its own scene after a depth clear, so nothing
 * in the frame's ambient-occlusion pass can ever see it: the channels between
 * the fingers are lit by exactly the same hemisphere as the finger crowns and
 * measure the same value, which is the single loudest reason a hand reads as a
 * mannequin. Vertex colour is the one channel every material here already
 * multiplies into albedo, so the occlusion goes there.
 *
 * `fn` is evaluated at the vertex position expressed in the *hand's* frame, so
 * one function can reason about neighbouring fingers and about the object being
 * gripped without caring which joint the vertex happens to hang off.
 */
function paintAO(mesh, toHand, fn) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (toHand) v.applyMatrix4(toHand);
    const a = clamp(fn(v.x, v.y, v.z), 0, 1);
    col[i * 3] = a; col[i * 3 + 1] = a; col[i * 3 + 2] = a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** Flat white, so a vertexColors material is safe on an unpainted mesh. */
function whiteAO(mesh) {
  const pos = mesh.geometry.attributes.position;
  if (mesh.geometry.getAttribute('color')) return;
  const col = new Float32Array(pos.count * 3).fill(1);
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/**
 * A gloved first-person hand.
 *
 * Built around the thing it holds rather than around itself. `gripRadius` is the
 * radius of the cylinder the fingers must close on, and the held axis is placed
 * *on the palm's own front surface*, so the palm slab always ends up behind the
 * geometry it grips. The version this replaces put that axis 30 mm clear of the
 * palm face and 30 mm above its centre, which is why the palm hung in open air
 * below the handguard with ground visible under it and the fingers lay across
 * the top of the tube instead of closing round it.
 *
 * Local frame: +X spreads the knuckles and is the axis of the held object,
 * +Y runs wrist -> fingertips, -Z is the direction the palm faces. Knuckles,
 * knuckle guard and the glove's back panel are all on +Z, which is the other
 * half of why the old fingers read as ridges lying on the handguard: the hard
 * plates were modelled on the palmar side, between the hand and the weapon.
 */
function glovedHand(material, plate, sleeveMat, creaseMat, nailMat, {
  mirror = false, trigger = false, thumbForward = false,
  gripRadius = 0.024, holdY = 0.008, scale = 0.92,
} = {}) {
  const hand = new THREE.Group();
  const s = mirror ? -1 : 1;
  hand.scale.setScalar(scale);
  // Meshes that take the baked occlusion. `fi` is the digit index for anything
  // that has a neighbouring finger to be shadowed by, -1 for the inter-digital
  // webbing (always in a channel) and -2 for the rest of the hand.
  const aoMesh = [];
  const ao = (mesh, fi = -2) => { aoMesh.push({ mesh, fi }); return mesh; };

  // Grip radius arrives in the parent's units; everything below is hand-local.
  const R = gripRadius / scale;
  const PALM_W = 0.082;    // knuckle spread — runs along the held axis
  const PALM_L = 0.088;    // wrist to knuckle
  const PALM_T = 0.030;    // palmar face to back of hand
  const FRONT = -PALM_T / 2;
  const holdZ = FRONT - R;

  // Palm. Rolled slightly about Z so the knuckle line runs diagonally the way a
  // real hand's does — a symmetric block is what reads as a mitten.
  const palm = bevelBox(PALM_W, PALM_L, PALM_T, 0.006, material);
  palm.rotation.z = s * 0.06;
  hand.add(palm);

  // Glove back panel and knuckle guard: the hard, darker shell every shooting
  // glove has, and the value break that stops the hand reading as one slab.
  const backPanel = bevelBox(PALM_W * 0.90, PALM_L * 0.70, 0.009, 0.0025, plate);
  backPanel.position.set(0, 0.002, PALM_T / 2 - 0.002);
  backPanel.rotation.z = s * 0.06;
  hand.add(backPanel);

  // Thenar and hypothenar: the two muscle pads that make a palm a palm. Both on
  // the palmar side, where they press into the thing being held.
  const pad = (px, py, pz, sx, sy, sz) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), material);
    m.scale.set(sx, sy, sz);
    m.position.set(px, py, pz);
    ao(m);
    hand.add(m);
  };
  pad(-s * 0.026, -0.004, FRONT + 0.009, 0.032, 0.056, 0.026);
  pad(s * 0.030, -0.012, FRONT + 0.010, 0.026, 0.048, 0.023);

  // Four knuckles as individual domes on the back of the hand, not one bar: the
  // scalloped knuckle line is the most recognisable thing about a fist.
  const KNUCKLE_X = (i) => s * (-0.0295 + i * 0.0197);
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.0106, 8, 6), plate);
    k.scale.set(1.0, 0.82, 1.1);
    k.position.set(KNUCKLE_X(i), 0.041 - Math.abs(t - 0.35) * 0.007, PALM_T / 2 - 0.003);
    hand.add(k);
  }
  const guard = bevelBox(PALM_W * 0.92, 0.020, 0.011, 0.002, plate);
  guard.position.set(0, 0.039, PALM_T / 2 + 0.001);
  guard.rotation.x = -0.30;
  hand.add(guard);

  // Four fingers, three phalanges each, solved onto the grip circle. Lengths
  // and radii are staggered per finger so the four do not close as one block.
  const FINGER = [0.97, 1.06, 1.00, 0.86];
  const roots = [];      // per finger: the root group and its solved angles
  const dorsal = [];     // nodes that must be oriented off the back of the hand
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const fs = FINGER[i];
    const lens = [0.038 * fs, 0.029 * fs, 0.026 * fs];
    // Radii, not diameters — adjacent fingers are KNUCKLE_X apart (0.0197 m),
    // and at the previous 0.0105 the proximal capsules were up to 0.0222 m
    // across with fs applied, so every adjacent pair interpenetrated by 1-2.5
    // mm. The four fingers fused into one tube with three transverse creases
    // and read as a mitten. These leave roughly 3 mm of daylight between
    // proximals, which is what lets the creases separate at viewmodel scale.
    const radii = [0.0082 * fs, 0.0074 * fs, 0.0064 * fs];

    const root = new THREE.Group();
    const rootY = 0.037;
    const rootZ = 0.004;
    root.position.set(KNUCKLE_X(i), rootY, rootZ);
    root.rotation.y = s * (t - 0.4) * 0.13;     // fingers fan slightly

    // The trigger finger is straight and indexed along the receiver. An index
    // folded into the fist with the other three is the tell that a hand was
    // modelled as a unit rather than as a hand doing something.
    const th = (trigger && i === 0)
      ? [-0.34, 0.16, 0.10]
      : wrapFinger(rootY, rootZ, holdY, holdZ, R + radii[0], lens);

    root.rotation.x = th[0];

    // A phalanx is a tapered tube, not a capsule. Butting two capsules of
    // different radii end to end leaves the thinner one's hemisphere standing
    // proud inside the thicker one's — a hard silhouette step at every joint,
    // which is the bead-string read the review called a mannequin. A frustum
    // whose base radius is the previous segment's tip radius has no step at
    // all, and the joint is then built explicitly and the right way round: a
    // knuckle swelling on the back of the finger, a dark flexion crease on the
    // palmar side.
    const seg = (rBase, rTip, len, parent, rel) => {
      const grp = new THREE.Group();
      grp.rotation.x = rel;
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(rBase, rTip, len, 10, 1, true), material,
      );
      mesh.rotation.x = Math.PI / 2;   // geometry +Y -> group +Z, so top is the base
      mesh.position.z = -len / 2;
      grp.add(ao(mesh, i));
      parent.add(grp);
      return grp;
    };
    // Flexion crease: a narrow inset band of darker glove at the joint. It is
    // what a knuckle looks like from the camera's side of the hand, and it is
    // also the only thing that tells two abutting frusta apart.
    const crease = (r, parent) => {
      // A hair proud, not inset: geometry cannot be cut here, so the groove has
      // to be a dark band standing 1% off the surface it divides. It is the
      // same trick the receiver's panel breaks use, at a tenth of the scale.
      const c = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.012, r * 1.012, r * 0.44, 10, 1, true), creaseMat,
      );
      c.rotation.x = Math.PI / 2;
      parent.add(c);
    };
    // Knuckle: a swelling on the *back* of the joint. Which way that is falls
    // out of the wrap solve, so it is resolved from the grip axis later.
    const knuckle = (r, parent) => {
      const k = new THREE.Mesh(new THREE.SphereGeometry(r * 1.10, 8, 6), material);
      k.scale.set(0.92, 1.0, 0.72);
      parent.add(ao(k, i));
      dorsal.push({ node: parent, mesh: k, out: r * 0.38, along: 0, flat: false });
      return k;
    };

    const rMid = radii[0] * 0.90;
    const rDist = radii[1] * 0.92;
    // Metacarpal head. Anatomically it is the knuckle you punch with; here it
    // also closes the open base of the proximal frustum.
    const mcp = new THREE.Mesh(new THREE.SphereGeometry(radii[0] * 1.06, 8, 6), material);
    mcp.scale.set(0.94, 1.0, 0.86);
    root.add(ao(mcp, i));
    const prox = seg(radii[0], rMid, lens[0], root, 0);
    const mid = seg(rMid, rDist, lens[1], prox, th[1] - th[0]);
    mid.position.z = -lens[0];
    const tip = seg(rDist, radii[2] * 0.86, lens[2], mid, th[2] - th[1]);
    tip.position.z = -lens[1];
    crease(rMid, mid);
    crease(rDist, tip);
    knuckle(rMid, mid);
    knuckle(rDist, tip);

    // Fingertip: a rounded cap so the digit does not end on a cut circle, and a
    // nail plate on the back of it.
    const capMesh = new THREE.Mesh(new THREE.SphereGeometry(radii[2] * 0.86, 8, 6), material);
    capMesh.position.z = -lens[2];
    capMesh.scale.set(1, 1, 1.25);
    tip.add(ao(capMesh, i));
    // Nail plate: a flat shell on the back of the last joint. On a gloved hand
    // it is the fingertip reinforcement, which is in the same place and reads
    // the same way — a hard, slightly darker cap the light breaks across.
    const nailPlate = new THREE.Mesh(new THREE.SphereGeometry(radii[2] * 0.66, 8, 5), nailMat);
    nailPlate.scale.set(0.94, 0.30, 1.50);
    dorsal.push({ node: tip, mesh: nailPlate, out: radii[2] * 0.62, along: -lens[2] * 0.60, flat: true });
    tip.add(nailPlate);

    hand.add(root);
    roots.push({ root, lens, radii, th });
  }

  // Webbing. Between two fingers there has to be something that is neither
  // finger nor sky; without it the inter-digital channel shows whatever is
  // behind the hand and measures brighter than the crowns it sits between.
  // These slabs sit a good 2 mm inside the finger radius, so all the camera
  // ever sees of them is a recessed surface at the bottom of a slot.
  for (let i = 0; i < 3; i++) {
    // An extended trigger finger has left the fist; there is no channel between
    // it and its neighbour to fill.
    if (trigger && i === 0) continue;
    const a = roots[i]; const b = roots[i + 1];
    const dx = (KNUCKLE_X(i + 1) - KNUCKLE_X(i)) / 2;
    const rr = Math.min(a.radii[0], b.radii[0]);
    const web = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(dx) * 2.1, rr * 1.30, 0.030), material);
    web.position.set(dx, 0, -0.014);
    web.rotation.x = clamp((b.th[0] - a.th[0]) * 0.5, -0.25, 0.25);
    a.root.add(ao(web, -1));
  }

  // Thumb. On the support hand it lies forward along the held axis, rolled up
  // onto it — the C-clamp. On the firing hand it opposes across the grip and
  // rolls over the middle finger, which is what closes the loop of a fist.
  const thumbPivot = new THREE.Group();
  const thumb = new THREE.Group();
  thumbPivot.add(thumb);
  if (thumbForward) {
    thumbPivot.position.set(-s * 0.033, holdY - R * 0.10, holdZ + R * 0.86);
    thumbPivot.rotation.z = -s * 0.46;
    thumb.rotation.y = s * Math.PI / 2;
  } else {
    thumbPivot.position.set(-s * 0.032, 0.004, FRONT + 0.006);
    thumbPivot.rotation.set(-0.52, -s * 0.82, s * 0.34);
  }
  // The thumb takes the same treatment as the digits: tapered sections that
  // meet without a step, a crease at the joint and a nail on the back of it.
  const meta = new THREE.Mesh(new THREE.CylinderGeometry(0.0116, 0.0102, 0.038, 10, 1, true), material);
  meta.rotation.x = Math.PI / 2;
  meta.position.z = -0.019;
  thumb.add(ao(meta));
  const distal = new THREE.Group();
  distal.position.z = -0.036;
  distal.rotation.x = thumbForward ? -0.24 : -0.78;
  const thumbBase = new THREE.Mesh(new THREE.SphereGeometry(0.0120, 8, 6), material);
  thumb.add(ao(thumbBase));
  const thumbCrease = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0104, 0.0104, 0.0046, 10, 1, true), creaseMat,
  );
  thumbCrease.rotation.x = Math.PI / 2;
  distal.add(thumbCrease);
  const distalMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.0102, 0.0084, 0.028, 10, 1, true), material);
  distalMesh.rotation.x = Math.PI / 2;
  distalMesh.position.z = -0.014;
  distal.add(ao(distalMesh));
  const thumbTip = new THREE.Mesh(new THREE.SphereGeometry(0.0084, 8, 6), material);
  thumbTip.position.z = -0.028;
  thumbTip.scale.z = 1.3;
  distal.add(ao(thumbTip));
  // Placed in the thumb's own frame, not by the grip solve. The four digits
  // wrap the handguard so "outward from the held axis" is their dorsal side;
  // the thumb lies *along* that axis, where the same rule points sideways and
  // lays the plate across the back of the wrist as a 20 mm dark blade.
  const nail = new THREE.Mesh(new THREE.SphereGeometry(0.0058, 8, 5), nailMat);
  nail.scale.set(0.92, 0.32, 1.35);
  nail.position.set(0, 0.0062, -0.019);
  distal.add(nail);
  thumb.add(distal);
  hand.add(thumbPivot);

  // Wrist and sleeve. This is not a stub: it is a tapered run that `poseHand`
  // aims down and back so it leaves through the bottom of the frame, which is
  // what shipped viewmodels do. Every section is a capsule, so no cut face can
  // ever be presented to the lens no matter where the arm ends up pointing.
  const arm = new THREE.Group();
  const sleeve = (r0, r1, len, y, mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 14, 1, false), mat);
    m.position.y = y;
    m.scale.z = 0.82;
    arm.add(m);
    return m;
  };
  const wrist = new THREE.Mesh(new THREE.CapsuleGeometry(0.0268, 0.030, 4, 12), material);
  wrist.position.y = -0.052;
  wrist.scale.z = 0.80;
  arm.add(wrist);
  sleeve(0.0300, 0.0345, 0.030, -0.086, plate);        // glove cuff
  // Past the cuff it is a uniform sleeve, not more glove. Running the same
  // coyote nomex all the way down turned the forearm into a bare arm.
  sleeve(0.0316, 0.0340, 0.070, -0.134, sleeveMat);
  // Rolled cuff band: one hard line across an otherwise featureless column.
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0348, 0.0344, 0.016, 14), plate);
  band.position.y = -0.168;
  band.scale.z = 0.84;
  arm.add(band);
  const armEnd = new THREE.Mesh(new THREE.CapsuleGeometry(0.0352, 0.070, 4, 12), sleeveMat);
  armEnd.position.y = -0.212;
  armEnd.scale.z = 0.86;
  arm.add(armEnd);
  hand.add(arm);

  // The palm takes the bake; the wrist does not, because `poseHand` re-aims the
  // whole arm after this runs and a bake done in the pre-aim frame would be a
  // shadow pointing the wrong way.
  ao(palm);

  // --- resolve the back of the hand ---------------------------------------
  // Which way is "dorsal" for a given phalanx is an output of the wrap solve,
  // not something that can be written down as a sign: the finger turns through
  // most of a half circle on its way round the handguard. So it is read back
  // from the finished pose — outward from the gripped axis — and the knuckles
  // and nails are placed along it.
  hand.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(hand.matrixWorld).invert();
  const _p = new THREE.Vector3(); const _d = new THREE.Vector3();
  const _z = new THREE.Vector3(); const _x = new THREE.Vector3();
  const _m4 = new THREE.Matrix4(); const _m3 = new THREE.Matrix3();
  for (const d of dorsal) {
    _m4.copy(toLocal).multiply(d.node.matrixWorld);
    _p.setFromMatrixPosition(_m4);
    _d.set(0, _p.y - holdY, _p.z - holdZ);
    if (_d.lengthSq() < 1e-9) _d.set(0, 1, 0);
    _d.normalize().applyMatrix3(_m3.setFromMatrix4(_m4).invert()).normalize();
    d.mesh.position.set(_d.x * d.out, _d.y * d.out, _d.z * d.out + d.along);
    if (d.flat) {
      // Lay the plate on the back of the joint: its thin axis along the
      // outward normal, its long axis down the finger.
      _z.set(0, 0, -1).addScaledVector(_d, _d.z);
      if (_z.lengthSq() > 1e-6) {
        _z.normalize();
        _x.crossVectors(_d, _z).normalize();
        d.mesh.quaternion.setFromRotationMatrix(_m4.identity().makeBasis(_x, _d, _z));
      }
    }
  }

  // --- bake the occlusion --------------------------------------------------
  hand.updateMatrixWorld(true);
  const SPREAD = Math.abs(KNUCKLE_X(1) - KNUCKLE_X(0));
  for (const { mesh, fi } of aoMesh) {
    _m4.copy(toLocal).multiply(mesh.matrixWorld);
    paintAO(mesh, _m4, (x, y, z) => {
      let a = 1;
      if (fi >= 0) {
        // Cavity between digits: how close this surface is to the axis of the
        // nearest *other* finger. The crown of a finger has no neighbour within
        // half a spread and stays open; the flank of the channel is buried.
        let near = 0;
        for (let j = 0; j < 4; j++) {
          if (j === fi) continue;
          const t = (x - KNUCKLE_X(j)) / (SPREAD * 0.60);
          near = Math.max(near, Math.exp(-t * t));
        }
        a -= 0.38 * near;
      } else if (fi === -1) {
        a -= 0.42;                       // webbing lives at the bottom of a slot
      }
      // Contact: anything within a couple of millimetres of the gripped
      // cylinder is in a closed crevice against it, and that crevice is what
      // tells an eye the hand is *on* the handguard rather than beside it.
      const dr = Math.hypot(y - holdY, z - holdZ);
      a -= 0.30 * smoothstep(R + 0.010, R - 0.003, dr);
      // A general drop toward the palmar side, which never sees the sky.
      a -= 0.14 * smoothstep(FRONT + 0.006, FRONT - 0.010, z);
      return clamp(a, 0.32, 1);
    });
  }
  hand.traverse((c) => { if (c.isMesh) whiteAO(c); });

  // The held axis and the sleeve, published in the parent's units so `poseHand`
  // stays correct when the hand is scaled.
  hand.userData.hold = new THREE.Vector3(0, holdY, holdZ).multiplyScalar(scale);
  hand.userData.arm = arm;
  return hand;
}

/**
 * Put a hand on something.
 *
 * @param hold   Point the held object's axis passes through, in model space.
 * @param axis   Direction that object runs in — the knuckles spread along it.
 * @param palm   Direction the palm faces: from the palm's surface toward the
 *               held object's axis. Squared against `axis`.
 * @param armDir Where the sleeve runs, in model space.
 *
 * The roll is driven off the palm normal rather than off a forearm vector,
 * because the two are not independent: fixing where the wrist points fixes
 * which quadrant of the handguard the hand can sit in, and the quadrant is the
 * thing that decides whether the camera sees the back of the hand or nothing
 * but a wrist. The sleeve is aimed separately, which is legitimate — the wrist
 * of a C-clamp grip really is dorsiflexed by most of a right angle.
 */
function poseHand(hand, hold, axis, palm, armDir) {
  const x = _hx.copy(axis).normalize();
  const n = _hf.copy(palm);
  n.addScaledVector(x, -n.dot(x)).normalize();   // squared to the axis
  // Local +Y (wrist -> fingertips) is X cross N in the hand's own frame, so the
  // same cross product in model space is where the knuckles have to point.
  const y = _hb.crossVectors(x, n);
  _hm.makeBasis(x, y, _hs.copy(n).negate());
  hand.quaternion.setFromRotationMatrix(_hm);
  hand.position.copy(hold).sub(
    _ho.copy(hand.userData.hold).applyQuaternion(hand.quaternion),
  );
  if (armDir && hand.userData.arm) {
    _hs.copy(armDir).normalize().applyQuaternion(_hq.copy(hand.quaternion).invert());
    hand.userData.arm.quaternion.setFromUnitVectors(HAND_ARM_AXIS, _hs);
  }
  return hand;
}

// ---------------------------------------------------------------------------
// Viewmodel surface sheets
// ---------------------------------------------------------------------------
// The texture library's only weapon set is a parkerised near-black, which is
// right for a receiver and wrong for everything else, so every non-metal on the
// old build ran `map: null` and resolved — correctly — as flat untextured slate:
// handguard, rail, stock and optic body all one value, all carrying the sky and
// nothing else. These three CPU-baked sheets give the polymer a moulding grain,
// the alloy a machining direction and the glove a weave, which is what a
// specular break needs something to break *on*.

const SHEET_PX = 96;

/** Bake albedo / normal / roughness from a per-texel callback. */
function bakeSheet(fn, relief) {
  const n = SHEET_PX;
  const N = n * n;
  const h = new Float32Array(N);
  const alb = new Uint8Array(N * 4);
  const rgh = new Uint8Array(N * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const o = fn((x + 0.5) / n, (y + 0.5) / n);
      h[i] = o[0];
      rgh[i * 4] = 255;
      rgh[i * 4 + 1] = clamp(o[1], 0, 1) * 255;
      rgh[i * 4 + 3] = 255;
      alb[i * 4] = clamp(o[2], 0, 1) * 255;
      alb[i * 4 + 1] = clamp(o[3], 0, 1) * 255;
      alb[i * 4 + 2] = clamp(o[4], 0, 1) * 255;
      alb[i * 4 + 3] = 255;
    }
  }
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
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(alb, true), normalMap: mk(nrm, false), roughnessMap: mk(rgh, false) };
}

let _vmSheets = null;
function viewmodelSheets() {
  if (_vmSheets) return _vmSheets;
  const nz = new Simplex(2207);
  // Seamless fbm by cross-fading four offset copies. Decorrelation has to be
  // done by moving the *sample* point, never by adding to u or v: those are the
  // blend weights, and pushing them outside 0..1 extrapolates the fade instead
  // of interpolating it. An offset of 8 turns a +/-1 field into a +/-40 one,
  // which is what put the large soft light and dark patches all over the
  // receiver and the rail.
  const tile = (u, v, f, oct, ox = 0, oy = 0) => {
    const a = fbm2(nz, u * f + ox, v * f + oy, oct);
    const b = fbm2(nz, (u - 1) * f + ox, v * f + oy, oct);
    const c = fbm2(nz, u * f + ox, (v - 1) * f + oy, oct);
    const d = fbm2(nz, (u - 1) * f + ox, (v - 1) * f + oy, oct);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  };

  // Glass-filled nylon: a pebbled mould texture with a coarse flake in it, and
  // the raised pebbles polished a shade smoother than the valleys, which is the
  // whole reason a polymer handguard has a readable form in sunlight.
  const polymer = bakeSheet((u, v) => {
    const w = worley2(u * 16, v * 16, 16, 4127);
    const cell = smoothstep(0.02, 0.34, w.f1);
    const flake = tile(u, v, 26, 2);
    const drift = tile(u, v, 3.2, 3, 37.0, 11.0);
    const hgt = cell * 0.55 + flake * 0.16;
    const tone = 0.86 + drift * 0.26 + flake * 0.10;
    const rough = 1.0 - cell * 0.20 + Math.abs(flake) * 0.10;
    return [hgt, rough, 0.235 * tone, 0.246 * tone, 0.198 * tone];
  }, 1.9);

  // Hard-anodised aluminium: unidirectional machining passes plus an anodising
  // mottle. The stripes are the thing that gives an extrusion a direction and
  // makes the highlight travel along it rather than sit on it as a blob.
  const alloy = bakeSheet((u, v) => {
    const pass = Math.sin(v * Math.PI * 2 * 30) * 0.5 + tile(u, v, 54, 2) * 0.6;
    const mottle = tile(u, v, 4.0, 2, 83.0, 29.0);
    const hgt = pass * 0.06 + mottle * 0.10;
    const tone = 0.96 + mottle * 0.17 + pass * 0.020;
    const rough = 0.98 + mottle * 0.10 - pass * 0.03;
    return [hgt, rough, 0.60 * tone, 0.602 * tone, 0.580 * tone];
  }, 0.30);

  // Nomex/goatskin glove: a twill running diagonally across the palm, seams
  // every few centimetres, and a warm coyote that is deliberately the lightest
  // and by far the warmest thing in the frame.
  const nomex = bakeSheet((u, v) => {
    const twill = Math.sin((u + v) * Math.PI * 2 * 19);
    const cross = Math.sin((u - v) * Math.PI * 2 * 19) * 0.4;
    const seam = (Math.abs(((v * 1.5) % 1) - 0.5) < 0.030) ? 0.26 : 0;
    const fuzz = tile(u, v, 34, 2, 14.0, 62.0);
    const patch = tile(u, v, 2.6, 2, 9.0, 44.0);
    const hgt = twill * 0.11 + cross * 0.05 + seam + fuzz * 0.06;
    const tone = 0.97 + patch * 0.07 + fuzz * 0.035;
    const rough = 1.02 - Math.abs(twill) * 0.05 - seam * 0.20;
    return [hgt, rough, 0.372 * tone, 0.318 * tone, 0.244 * tone];
  }, 0.95);

  _vmSheets = { polymer, alloy, nomex };
  return _vmSheets;
}

/** Per-material texture set at its own tiling — repeat lives on the texture. */
function sheetAt(set, repeat) {
  const out = {};
  for (const k of ['map', 'normalMap', 'roughnessMap']) {
    const t = set[k].clone();
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
    out[k] = t;
  }
  return out;
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

  // The receiver keeps the library's parkerised set. Everything else now takes
  // one of the three sheets baked above, because `map: null` — which is what the
  // furniture, the rail, the stock and the optic all used to run — is exactly
  // the thing that made them resolve as one flat untextured slate. A tinted
  // constant with a normal map on it is still a constant to the eye at 30 cm.
  //
  // Value ladder, darkest first: buttpad 0x0d -> mag/optic 0x1a -> receiver
  // (parkerised) -> handguard and stock 0x3c -> glove 0x66 -> rail 0x92 ->
  // bare steel 0xb4. The last one is new and is the specular anchor: a handful
  // of small polished parts at roughness 0.11 that cannot fail to return a hit.
  const v2 = (s) => new THREE.Vector2(s, s);
  const kit = (opts) => textures.material('gunMetal', opts);
  const sheets = viewmodelSheets();
  const std = (set, repeat, params) => {
    const mat = new THREE.MeshStandardMaterial({ ...sheetAt(set, repeat), ...params });
    mat.aoMapIntensity = 0;
    return mat;
  };

  // Parkerised receiver. Rougher than bare steel but well short of the 0.58 it
  // used to run at: under a 3.4-intensity key, 0.58 spreads the lobe so wide
  // that a metalness-0.9 surface returns no highlight at all, which is exactly
  // the "zero specular anywhere" the review found.
  const body = std(sheets.alloy, 3, {
    color: 0x5c5c51, metalness: 0.55, roughness: 0.44, normalScale: v2(0.30),
  });
  // Hard-anodised aluminium: the brightest, glossiest large surface, and the one
  // part guaranteed to carry a specular highlight along its machining passes.
  const rail = std(sheets.alloy, 4, {
    color: 0x8a867c, metalness: 0.68, roughness: 0.40, normalScale: v2(0.20),
  });
  // Small polished steel: pins, screws, the charging latch, the bolt face, the
  // chamfer strips. Nothing else on the weapon is this smooth, and that is the
  // point — these are the parts that put a hard white hit in the frame.
  const steel = std(sheets.alloy, 4, {
    color: 0xb6b2a8, metalness: 0.98, roughness: 0.17, normalScale: v2(0.12),
  });
  // Reinforced polymer furniture: matte, non-metallic, warm, and a clear step
  // lighter than the receiver so the handguard separates from the gun it wraps.
  const polymer = std(sheets.polymer, 3, {
    color: 0x83836c, metalness: 0.02, roughness: 0.60, normalScale: v2(0.80),
  });
  const darkPolymer = std(sheets.polymer, 5, {
    color: 0x4a4c41, metalness: 0.03, roughness: 0.58, normalScale: v2(0.60),
  });
  const rubber = std(sheets.polymer, 6, {
    color: 0x1a1b18, metalness: 0.0, roughness: 0.94, normalScale: v2(1.5),
  });
  // Coyote-brown nomex. Gloves the same value as the weapon are gloves nobody
  // sees; this is the warmest, lightest surface in the frame on purpose.
  // `vertexColors` is on for every surface of the hand, because the viewmodel
  // is drawn into its own scene after a depth clear and so is invisible to the
  // frame's occlusion pass: the only cavity shading it will ever have is the
  // one baked into these attributes.
  const glove = std(sheets.nomex, 4, {
    color: 0xb3a385, metalness: 0.0, roughness: 0.80, normalScale: v2(0.85),
    vertexColors: true,
  });
  // Flexion creases and the inter-digital channels: the same leather a stop
  // darker and rougher, so a joint reads as a line and not as a step.
  const gloveCrease = std(sheets.nomex, 7, {
    color: 0x6b5f4c, metalness: 0.0, roughness: 0.92, normalScale: v2(1.1),
    vertexColors: true,
  });
  // The glove's hard shell — knuckle guard, back panel, cuff, nail plates — a
  // value below the leather.
  const gloveShell = std(sheets.polymer, 5.5, {
    color: 0x34322a, metalness: 0.04, roughness: 0.52, normalScale: v2(1.0),
    vertexColors: true,
  });
  // Nail plates / fingertip reinforcement. In the shell's near-black these read
  // as hard sticks laid on the digits rather than as part of them; one stop
  // under the leather is what a reinforcement patch actually is.
  const gloveHard = std(sheets.nomex, 6, {
    color: 0x7c7259, metalness: 0.03, roughness: 0.55, normalScale: v2(0.9),
    vertexColors: true,
  });
  // Combat-shirt sleeve past the glove cuff: olive ripstop, a clear value and
  // hue step off the coyote glove so the wrist reads as a cuff and not as skin.
  const sleeveCloth = std(sheets.nomex, 3.2, {
    color: 0x5d6046, metalness: 0.0, roughness: 0.90, normalScale: v2(1.1),
    vertexColors: true,
  });
  // Shadow line. Every panel break on this weapon is a strip of this standing a
  // fraction of a millimetre proud of the surface it divides: a near-black,
  // near-dielectric matte that returns almost nothing under any key. It is what
  // a 2 mm gap between two castings looks like, and there were none anywhere on
  // the 400 mm of receiver flank the camera actually points at.
  const seam = std(sheets.alloy, 8, {
    color: 0x2a2c33, metalness: 0.18, roughness: 0.90, normalScale: v2(0.25),
  });
  // The rail's web, under the ribs. Darker than the rib crowns so every slot
  // has a floor that reads as a floor.
  const railWeb = std(sheets.alloy, 5, {
    color: 0x3d3b35, metalness: 0.62, roughness: 0.56, normalScale: v2(0.25),
  });
  // Combustion soot: what the last 60 mm of any barrel and the whole of a flash
  // hider actually look like after a magazine. Blacker and far rougher than the
  // parkerising it sits on, so the muzzle end stops matching the receiver.
  const carbon = std(sheets.alloy, 9, {
    color: 0x17161a, metalness: 0.30, roughness: 0.95, normalScale: v2(0.55),
  });
  // Hard-anodised optic housing. It used to wear the handguard's glass-filled
  // nylon, whose mould pebble is the coarsest normal detail on the weapon and
  // has no business on a machined sight body.
  const anodised = std(sheets.alloy, 6, {
    color: 0x33332e, metalness: 0.52, roughness: 0.42, normalScale: v2(0.34),
  });

  const barrelLen = smg ? 0.20 : 0.30;
  // Optical axis height above the receiver centreline. The rail crown sits at
  // 0.0513, so anything under about 0.068 puts the optic's own tube *inside*
  // the rail it is supposed to be clamped to — which is what the last build
  // shipped, and most of why the sight read as painted on rather than mounted.
  const SIGHT_Y = 0.0795;
  const RAIL_Y = 0.041;                    // rail origin above the centreline
  const RAIL_TOP = RAIL_Y + RAIL_CROWN;    // the crown a mount clamps onto

  // --- receiver -----------------------------------------------------------
  const upper = bevelBox(0.046, 0.040, 0.235, 0.0058, body);
  upper.position.set(0, 0.019, -0.02);
  g.add(upper);

  const lower = bevelBox(0.042, 0.036, 0.150, 0.0050, body);
  lower.position.set(0, -0.015, 0.020);
  g.add(lower);

  // Magazine well flares outward at the bottom — a strong silhouette cue.
  const magwell = bevelBox(0.040, 0.046, 0.062, 0.0050, body);
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
  // The selector shaft is 30 mm long in a 42 mm lower, so both ends of it used
  // to stop 6 mm inside the casting: there was no selector on the weapon at
  // all, on either flank. It is an ambidextrous shaft that comes through.
  const selector = new THREE.Mesh(new THREE.CylinderGeometry(0.0058, 0.0058, 0.050, 12), body);
  selector.rotation.z = Math.PI / 2;
  selector.position.set(0, -0.008, 0.052);
  g.add(selector);
  const selectorLever = bevelBox(0.007, 0.008, 0.024, 0.0010, body);
  selectorLever.position.set(-0.0272, -0.013, 0.049);
  selectorLever.rotation.x = 0.42;
  g.add(selectorLever);
  const magRelease = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.008, 8), body);
  magRelease.rotation.z = Math.PI / 2;
  magRelease.position.set(0.023, -0.020, 0.006);
  g.add(magRelease);

  // LEFT-SIDE FURNITURE. The shipped camera sits behind and to the left of the
  // weapon, so it never sees the port, the deflector, the forward assist or the
  // mag release — every one of which is on the right. These are the controls
  // that are actually in shot, and their absence is most of why the receiver
  // read as a blank extrusion.
  const boltCatch = bevelBox(0.006, 0.014, 0.030, 0.0012, body);
  boltCatch.position.set(-0.023, -0.004, 0.028);
  g.add(boltCatch);
  const boltPaddle = bevelBox(0.005, 0.020, 0.011, 0.0012, body);
  boltPaddle.position.set(-0.025, -0.008, 0.040);
  g.add(boltPaddle);
  // Take-down and pivot pins: two bright steel discs on the flank, and two of
  // the most reliable specular hits on the whole model.
  for (const pz of [0.070, -0.052]) {
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0062, 0.006, 12), steel);
    pin.rotation.z = Math.PI / 2;
    pin.position.set(-0.023, -0.004, pz);
    g.add(pin);
  }
  // Chamfer strip along the top of the upper. A thin polished edge catching the
  // key is what separates machined aluminium from a box.
  for (const sx of [-1, 1]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.0032, 0.0032, 0.230), steel);
    edge.rotation.z = Math.PI / 4;
    edge.position.set(sx * 0.0225, 0.0355, -0.020);
    g.add(edge);
  }
  // Magazine-release fence, on the right where the release is. It used to be a
  // 30 by 56 mm slab down *both* flanks, which did not fence anything: it just
  // widened the magwell into one more face of the same unbroken plane and
  // buried every panel line placed on it.
  const fence = bevelBox(0.005, 0.020, 0.026, 0.001, body);
  fence.position.set(0.0212, -0.019, 0.004);
  g.add(fence);
  // Dust cover, hinged along the upper: a long hard line down the receiver.
  const dustCover = bevelBox(0.010, 0.024, 0.086, 0.0012, body);
  dustCover.position.set(0.020, 0.020, -0.040);
  dustCover.rotation.z = -0.35;
  g.add(dustCover);

  // --- panel breaks --------------------------------------------------------
  // The receiver is not one casting and must not read as one. An AR is an upper
  // and a lower pinned together with a magazine well hanging off the front of
  // the lower, and the two horizontal gaps between those three parts are the
  // longest hard lines anywhere on the weapon. Without them the flank is a
  // 400-pixel unbroken plane, which is the single loudest thing in the frame
  // that no photograph of a rifle has ever contained.
  const strip = (mat, x, y, z, w, h, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  for (const sx of [-1, 1]) {
    // Upper-to-lower joint, the full length of the receiver.
    strip(seam, sx * 0.0223, 0.0018, 0.020, 0.0036, 0.0030, 0.150);
    // Lower-to-magwell joint.
    strip(seam, sx * 0.0216, -0.0118, -0.012, 0.0036, 0.0026, 0.062);
    // Front face of the lower against the magwell's rear flare.
    strip(seam, sx * 0.0212, -0.032, 0.0195, 0.0034, 0.044, 0.0026);
    // Roll-mark panel on the magwell flank: a shallow recessed rectangle with
    // two engraved lines in it. At this scale the eye reads "there is writing
    // there", which is all a roll mark ever does at arm's length.
    strip(seam, sx * 0.0208, -0.0315, -0.010, 0.0032, 0.0230, 0.0400);
    strip(steel, sx * 0.0219, -0.0262, -0.012, 0.0022, 0.0022, 0.0330);
    strip(steel, sx * 0.0219, -0.0362, -0.016, 0.0022, 0.0020, 0.0230);
    // Machined relief along the top of the upper — two long parallel lines a
    // grazing key can travel down.
    strip(seam, sx * 0.0236, 0.0300, -0.028, 0.0024, 0.0022, 0.176);
    // Magwell mouth: a polished lip, the brightest wear edge on the weapon.
    strip(steel, sx * 0.0206, -0.0552, -0.012, 0.0032, 0.0034, 0.0620);
  }
  // Mouth lip across the front and back of the magwell, so it closes.
  for (const dz of [-0.0435, 0.0195]) {
    strip(steel, 0, -0.0552, dz, 0.0410, 0.0034, 0.0032);
  }
  // Recessed surrounds behind the left-hand controls. A control the same value
  // as the casting it sits on is not a control, it is a bump.
  strip(seam, -0.0216, -0.0050, 0.0330, 0.0034, 0.0250, 0.0460);
  for (const pz of [0.070, -0.052]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.0094, 0.0094, 0.0032, 12), seam);
    ring.rotation.z = Math.PI / 2;
    ring.position.set(-0.0218, -0.004, pz);
    g.add(ring);
  }
  // Selector boss and its two position marks.
  const selBoss = new THREE.Mesh(new THREE.CylinderGeometry(0.0112, 0.0112, 0.0030, 14), seam);
  selBoss.rotation.z = Math.PI / 2;
  selBoss.position.set(-0.0216, -0.008, 0.052);
  g.add(selBoss);
  for (const [my, mz] of [[0.0022, 0.0086], [-0.0086, 0.0022]]) {
    strip(steel, -0.0228, -0.008 + my, 0.052 + mz, 0.0018, 0.0028, 0.0028);
  }
  // Trigger and hammer pins through the lower.
  for (const pz of [0.030, 0.050]) {
    const tp = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, 0.0040, 10), steel);
    tp.rotation.z = Math.PI / 2;
    tp.position.set(-0.0212, -0.019, pz);
    g.add(tp);
  }

  // --- top rail + optic ----------------------------------------------------
  const topRail = picatinnyRail(0.215, rail, railWeb);
  topRail.position.set(0, RAIL_Y, -0.02);
  g.add(topRail);

  // Red-dot sight. The old build put an opaque additive disc *in front* of the
  // glass, which is why it read as an orange sticker: the reticle has to sit
  // behind the lens, at the focal plane, so the glass tints and reflects over
  // the top of it. So: housing, hood, a transmissive coated lens, and behind it
  // a 2 MOA dot inside a ring — a shape, not a blob — plus a soft bloom card
  // that gives the emitter the glow a real illuminated reticle has.
  const optic = new THREE.Group();
  optic.position.set(0, SIGHT_Y - 0.004, -0.010);
  // Mount. Everything below is measured off the rail crown rather than guessed,
  // so the tube stands clear of the ribs on a leg that visibly straddles them
  // instead of intersecting the rail it is nominally clamped to.
  const mountY = RAIL_TOP - optic.position.y;      // rail crown, in optic-local
  // Top of the leg, buried a few millimetres into the tube so its corners meet
  // the curve rather than stopping short of it and leaving a notch.
  const legTop = -0.0168;
  const opticBase = bevelBox(0.021, legTop - mountY, 0.026, 0.0018, anodised);
  opticBase.position.y = (mountY + legTop) / 2;
  opticBase.position.z = -0.0060;
  optic.add(opticBase);
  // The clamp straddles the rail: a jaw either side of the crown, joined under
  // it by a cross-bolt. This is the joint the review said was missing.
  const opticClamp = bevelBox(0.030, 0.017, 0.020, 0.0012, rail);
  opticClamp.position.set(0, mountY - 0.0055, -0.014);
  optic.add(opticClamp);
  for (const jx of [-1, 1]) {
    const jaw = bevelBox(0.0042, 0.0130, 0.0200, 0.0010, rail);
    jaw.position.set(jx * 0.0129, mountY - 0.0045, -0.014);
    optic.add(jaw);
  }
  // Ring: the mount holds the tube in a band, not by butting a post against
  // the bottom of the glass. Without it the leg had to reach up past the
  // objective's lower edge and cut across the lens.
  const mountBand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0183, 0.0183, 0.0110, 20, 1, true), rail,
  );
  mountBand.rotation.x = Math.PI / 2;
  mountBand.position.set(0, 0, -0.0060);
  optic.add(mountBand);
  const clampNut = new THREE.Mesh(new THREE.CylinderGeometry(0.0040, 0.0040, 0.0060, 8), steel);
  clampNut.rotation.z = Math.PI / 2;
  clampNut.position.set(-0.0150, mountY - 0.0060, -0.014);
  optic.add(clampNut);
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.0170, 0.0170, 0.044, 20, 1, true), anodised);
  hood.rotation.x = Math.PI / 2;
  optic.add(hood);

  // A bare tube is a can. Turrets, a rotary brightness dial, a battery cap,
  // knurling and clamp bolts are what make it an optic — and every one of them
  // is a hard convex edge in a place the key can find.
  const turret = (px, py, pz, rot) => {
    const t = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0072, 0.0080, 0.011, 14), anodised);
    t.add(barrel);
    const capMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.0064, 0.0072, 0.008, 14), steel);
    capMesh.position.y = 0.0092;
    t.add(capMesh);
    // Knurling: eight ribs is enough to read as a milled edge at this size.
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.008, 0.0016), anodised);
      r.position.set(Math.cos(a) * 0.0068, 0.0092, Math.sin(a) * 0.0068);
      r.rotation.y = -a;
      t.add(r);
    }
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.0090, 0.0016, 0.0022), anodised);
    slot.position.y = 0.0129;
    t.add(slot);
    t.position.set(px, py, pz);
    t.rotation.set(rot[0], rot[1], rot[2]);
    optic.add(t);
    return t;
  };
  turret(0, 0.0168, -0.004, [0, 0, 0]);                     // elevation, on top
  turret(0.0168, 0.0004, -0.004, [0, 0, -Math.PI / 2]);     // windage, right side
  // Rotary brightness dial on the left, which is the side the camera sees.
  const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.0098, 0.0098, 0.0075, 16), anodised);
  dial.rotation.z = Math.PI / 2;
  dial.position.set(-0.0180, 0.0006, 0.0075);
  optic.add(dial);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.0026, 0.0016, 0.0016), anodised);
    d.position.set(-0.0212, Math.sin(a) * 0.0092, 0.0075 + Math.cos(a) * 0.0092);
    d.rotation.x = -a;
    optic.add(d);
  }
  const battery = new THREE.Mesh(new THREE.CylinderGeometry(0.0072, 0.0080, 0.0060, 14), steel);
  battery.rotation.z = Math.PI / 2;
  battery.position.set(-0.0192, 0.0006, -0.0110);
  optic.add(battery);
  // Two cross-bolts through the mount clamp.
  for (const bz of [-0.020, -0.008]) {
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, 0.032, 10), steel);
    bolt.rotation.z = Math.PI / 2;
    bolt.position.set(0, mountY - 0.0090, bz);
    optic.add(bolt);
  }

  // The tube interior, so a glance down the side of the optic sees a dark bore
  // rather than the back faces of the hood.
  const bore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0158, 0.0158, 0.040, 20, 1, true),
    kit({ map: null, color: 0x08090a, roughness: 0.95, metalness: 0.0, side: THREE.BackSide }),
  );
  bore.rotation.x = Math.PI / 2;
  optic.add(bore);

  // The reticle. The old one was a 10.8 mm hard-edged annulus at full additive
  // opacity across a 31.6 mm objective — a third of the glass, uniformly bright,
  // with no falloff, which is precisely how a decal looks. A real illuminated
  // reticle is a 2 MOA emitter: tiny, very bright at the centre, and everything
  // around it is glow. So the dot keeps its intensity, the ring drops to a thin
  // 65 MOA hairline at a third of the brightness, and the halo does the rest.
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0xff6a33, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xff5a24, transparent: true, opacity: 0.34,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const reticle = new THREE.Group();
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.00072, 10), dotMat);
  reticle.add(dot);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.00285, 0.00335, 32), ringMat);
  reticle.add(ring);
  // Bloom card: the emitter's halo, and what stops the dot reading as a decal.
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(0.0034, 16),
    new THREE.MeshBasicMaterial({
      color: 0xff4a18, transparent: true, opacity: 0.13,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  halo.position.z = -0.0004;
  reticle.add(halo);
  // At the optical centre, not up against the ocular: a reticle a millimetre
  // behind the glass swings across it with every degree of view angle, which is
  // the parallax that made it read as paint on the outside of the objective.
  reticle.position.z = 0.0005;
  optic.add(reticle);
  // An illuminated reticle is only visible to an eye behind the tube. At the
  // hip pose the camera looks at this optic from about forty degrees off its
  // optical axis, where a real emitter returns nothing at all — so the dot that
  // was burning there in every shipped frame was not a reticle, it was a red
  // sticker on the objective bezel, which is exactly how the review read it.
  // It is faded in with the aim blend instead.
  g.userData.reticle = [dotMat, ringMat, halo.material].map((m) => ({ m, o: m.opacity }));
  for (const r of g.userData.reticle) r.m.opacity = 0;
  reticle.visible = false;

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
  // Polished bezels retaining each lens. Whatever the sun angle, a torus of
  // roughness-0.11 steel around the glass returns a highlight somewhere on its
  // circumference, and it is also the hard bright ring that stops the objective
  // reading as a painted-on disc.
  for (const bz of [0.0176, -0.0186]) {
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.0166, 0.0016, 8, 24), steel);
    bezel.position.z = bz;
    optic.add(bezel);
  }
  g.add(optic);
  g.userData.reticleNode = reticle;

  // Backup irons, folded flat onto the rail — which is where a folded BUIS
  // lives. They used to float at the optic's height with nothing under them.
  const rearIron = new THREE.Mesh(new THREE.TorusGeometry(0.0072, 0.0018, 6, 14), body);
  rearIron.rotation.x = 1.32;
  rearIron.position.set(0, RAIL_TOP + 0.0055, 0.079);
  g.add(rearIron);
  const rearIronBase = bevelBox(0.0230, 0.0090, 0.0180, 0.0012, body);
  rearIronBase.position.set(0, RAIL_TOP - 0.0010, 0.086);
  g.add(rearIronBase);
  const frontPostBase = bevelBox(0.0230, 0.0100, 0.0160, 0.0012, body);
  frontPostBase.position.set(0, RAIL_TOP - 0.0010, -0.222);
  g.add(frontPostBase);
  const frontPost = new THREE.Mesh(new THREE.BoxGeometry(0.0070, 0.0030, 0.0180), body);
  frontPost.rotation.x = -1.28;
  frontPost.position.set(0, RAIL_TOP + 0.0055, -0.229);
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

  // Flash hider with cut prongs. Carbon, not parkerising: after one magazine
  // the muzzle device and the last few centimetres of barrel behind it are the
  // blackest, flattest thing on the weapon, and a muzzle that matches the
  // receiver is the reason every part read as one uniform semigloss.
  const hider = new THREE.Mesh(new THREE.CylinderGeometry(0.0135, 0.0115, 0.040, 14), carbon);
  hider.rotation.x = Math.PI / 2;
  hider.position.set(0, 0.012, barrelZ - barrelLen * 0.5 - 0.018);
  g.add(hider);
  const soot = new THREE.Mesh(new THREE.CylinderGeometry(0.0106, 0.0098, 0.050, 14), carbon);
  soot.rotation.x = Math.PI / 2;
  soot.position.set(0, 0.012, barrelZ - barrelLen * 0.5 + 0.026);
  g.add(soot);
  // Crush washer: one bright turned ring behind the black device.
  const crushWasher = new THREE.Mesh(new THREE.CylinderGeometry(0.0124, 0.0124, 0.0034, 14), steel);
  crushWasher.rotation.x = Math.PI / 2;
  crushWasher.position.set(0, 0.012, barrelZ - barrelLen * 0.5 + 0.0035);
  g.add(crushWasher);
  for (let i = 0; i < 4; i++) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.0032, 0.016, 0.024), darkPolymer);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 8;
    slot.position.set(Math.cos(a) * 0.011, 0.012 + Math.sin(a) * 0.011, barrelZ - barrelLen * 0.5 - 0.022);
    slot.rotation.z = a;
    g.add(slot);
  }

  // Free-float handguard with M-LOK slots cut along both flanks. The tube is
  // heavily segmented because its vertex colours carry the hand's contact
  // shadow — see the grip-shadow bake below.
  const hgLen = barrelLen * 0.78;
  const hgZ = -0.115 - hgLen * 0.5 + 0.012;
  const UPPER_FACE = -0.1375;              // front face of the upper receiver
  const gripShade = std(sheets.polymer, 3, {
    color: 0x83836c, metalness: 0.02, roughness: 0.60, normalScale: v2(0.80),
    vertexColors: true,
  });
  // Radii the right way round: the tube tapers *toward* the muzzle. Local +Y
  // maps to model +Z, so radiusTop is the rear.
  const handguard = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0236, 0.0224, hgLen, 22, 14), gripShade,
  );
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
  // Top deck: the flat the rail is machined onto. A round tube with a rail bar
  // hovering over it is two objects; a flat deck with the rail standing on it
  // and screws down its length is one part, which is what the review was asking
  // for when it said the handguard and the rail never interface.
  const deckTop = RAIL_Y - RAIL_WEB_H / 2;
  const deck = bevelBox(0.0300, deckTop - 0.0250, hgLen - 0.004, 0.0018, polymer);
  deck.position.set(0, (deckTop + 0.0250) / 2, hgZ);
  g.add(deck);
  for (const sx of [-1, 1]) {
    strip(seam, sx * 0.0152, deckTop - 0.0035, hgZ, 0.0024, 0.0060, hgLen - 0.006);
  }
  // The handguard rail butts against the receiver rail; the joint between them
  // is a real one on a free-float rifle and gets a real shadow line.
  const railJoint = -0.1305;               // where the two rails butt
  const hgRailLen = railJoint - (hgZ - hgLen / 2);
  const hgRail = picatinnyRail(hgRailLen, rail, railWeb);
  hgRail.position.set(0, RAIL_Y, hgZ - hgLen / 2 + hgRailLen / 2);
  g.add(hgRail);
  strip(seam, 0, RAIL_Y, railJoint + 0.0016, 0.0218, RAIL_WEB_H + 0.0086, 0.0028);

  // Barrel nut: the machined ring where the handguard meets the receiver, with
  // its ring of index teeth. It used to sit 30 mm *inside* the upper, so the
  // tube simply vanished into the receiver with no joint anywhere. It is cut
  // away over the top because the rail passes across it there — which is also
  // true of the rifle.
  const nutZ = UPPER_FACE - 0.0090;
  const barrelNut = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0268, 0.0268, 0.018, 18, 1, false, -Math.PI * 0.70, Math.PI * 1.40),
    rail,
  );
  barrelNut.rotation.x = Math.PI / 2;
  barrelNut.position.set(0, 0.013, nutZ);
  g.add(barrelNut);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    if (Math.abs(a - Math.PI / 2) < 0.95) continue;   // clear of the rail
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.0042, 0.0034, 0.016), seam);
    tooth.position.set(Math.cos(a) * 0.0262, 0.013 + Math.sin(a) * 0.0262, nutZ);
    tooth.rotation.z = a;
    g.add(tooth);
  }
  // Anti-rotation screws down the near flank of the deck, where they are in
  // shot — they used to be on the right, which the camera never sees.
  for (let i = 0; i < 4; i++) {
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.0030, 0.0030, 0.006, 8), steel);
    screw.rotation.z = Math.PI / 2;
    screw.position.set(-0.0152, deckTop - 0.0060, hgZ - hgLen * 0.5 + 0.040 + i * 0.052);
    g.add(screw);
  }

  // Weapon light clamped to the left M-LOK — the one piece of kit on the whole
  // model with a bright bezel and a mirror inside it, mounted on the flank the
  // shipped camera actually looks at.
  const lightBody = new THREE.Mesh(new THREE.CylinderGeometry(0.0128, 0.0128, 0.058, 14), darkPolymer);
  lightBody.rotation.x = Math.PI / 2;
  lightBody.position.set(-0.0295, 0.006, hgZ - hgLen * 0.5 + 0.062);
  g.add(lightBody);
  const lightMount = bevelBox(0.016, 0.014, 0.020, 0.0015, rail);
  lightMount.position.set(-0.0245, 0.013, hgZ - hgLen * 0.5 + 0.086);
  g.add(lightMount);
  const lightBezel = new THREE.Mesh(new THREE.CylinderGeometry(0.0142, 0.0128, 0.008, 14), steel);
  lightBezel.rotation.x = Math.PI / 2;
  lightBezel.position.set(-0.0295, 0.006, hgZ - hgLen * 0.5 + 0.032);
  g.add(lightBezel);
  const reflector = new THREE.Mesh(
    new THREE.ConeGeometry(0.0118, 0.016, 16, 1, true),
    kit({ map: null, color: 0xd8d4c8, metalness: 1.0, roughness: 0.06, side: THREE.BackSide }),
  );
  reflector.rotation.x = Math.PI / 2;
  reflector.position.set(-0.0295, 0.006, hgZ - hgLen * 0.5 + 0.038);
  g.add(reflector);
  const tailCap = new THREE.Mesh(new THREE.CylinderGeometry(0.0112, 0.0118, 0.010, 12), rubber);
  tailCap.rotation.x = Math.PI / 2;
  tailCap.position.set(-0.0295, 0.006, hgZ - hgLen * 0.5 + 0.094);
  g.add(tailCap);

  // QD sling socket in the handguard's rear flank.
  const qd = new THREE.Mesh(new THREE.CylinderGeometry(0.0056, 0.0056, 0.005, 12), steel);
  qd.rotation.z = Math.PI / 2;
  // Forward of the barrel nut: at its old station it was 2 mm inside the upper.
  qd.position.set(-0.0224, 0.005, hgZ + hgLen * 0.5 - 0.062);
  g.add(qd);

  // Contact shadow for the support hand.
  //
  // The hand closes right round this tube, and the viewmodel is drawn into its
  // own scene after a depth clear, so nothing in the frame — not the shadow
  // map, not the AO pass — can put any darkness under it. Without this the
  // fingers meet the handguard at a join that measures the same value on both
  // sides of the contact, which is the difference between a hand gripping
  // something and a hand parked next to it. The occlusion is baked straight
  // into the tube's vertex colours instead.
  {
    const pos = handguard.geometry.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const gripL = -0.026;              // hand centre along the tube, tube-local
    for (let i = 0; i < pos.count; i++) {
      // Tube-local -> model: rotation.x = PI/2 sends +Y to +Z and +Z to -Y.
      const mx = pos.getX(i);
      const my = -pos.getZ(i);
      const axial = smoothstep(0.058, 0.012, Math.abs(pos.getY(i) - gripL));
      const r = Math.max(1e-4, Math.hypot(mx, my));
      // Straight down is deepest in the fist; the far flank carries the palm.
      const wrap = clamp(0.34 + 0.40 * (-my / r) + 0.24 * (mx / r), 0, 1);
      const a = clamp(1 - 0.48 * axial * wrap, 0, 1);
      col[i * 3] = a; col[i * 3 + 1] = a; col[i * 3 + 2] = a;
    }
    handguard.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

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

  // The stock sits about 10 cm from the eye, so its flank is the largest single
  // surface in the frame — and it was completely blank. Castle nut, end plate,
  // the six position notches under the buffer tube, a lightening cut and the
  // adjustment latch put a run of hard shadow lines across it.
  const castleNut = new THREE.Mesh(new THREE.CylinderGeometry(0.0200, 0.0200, 0.010, 14), body);
  castleNut.rotation.x = Math.PI / 2;
  castleNut.position.set(0, 0.014, 0.104);
  g.add(castleNut);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.0030, 0.0048, 0.010), darkPolymer);
    notch.position.set(Math.cos(a) * 0.0196, 0.014 + Math.sin(a) * 0.0196, 0.104);
    notch.rotation.z = a;
    g.add(notch);
  }
  const endPlate = bevelBox(0.036, 0.038, 0.005, 0.0015, steel);
  endPlate.position.set(0, 0.014, 0.096);
  g.add(endPlate);
  // Position notches along the underside of the buffer tube.
  for (let i = 0; i < 6; i++) {
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.005, 0.008), darkPolymer);
    notch.position.set(0, -0.001, 0.130 + i * 0.021);
    g.add(notch);
  }
  // Lightening cut and the latch lever on the left flank of the stock body.
  for (const sx of [-1, 1]) {
    const cut = bevelBox(0.007, 0.030, 0.052, 0.002, darkPolymer);
    cut.position.set(sx * 0.019, 0.000, 0.208);
    g.add(cut);
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.040, 0.006), polymer);
    rib.position.set(sx * 0.021, 0.004, 0.246);
    g.add(rib);
  }
  const latch = bevelBox(0.024, 0.012, 0.030, 0.002, darkPolymer);
  latch.position.set(0, -0.026, 0.196);
  g.add(latch);
  const latchLever = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.030, 10), steel);
  latchLever.rotation.z = Math.PI / 2;
  latchLever.position.set(0, -0.030, 0.184);
  g.add(latchLever);
  // QD socket in the stock and the sling loop it pairs with.
  const stockQd = new THREE.Mesh(new THREE.CylinderGeometry(0.0058, 0.0058, 0.006, 12), steel);
  stockQd.rotation.z = Math.PI / 2;
  stockQd.position.set(-0.020, 0.010, 0.222);
  g.add(stockQd);

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

  // Sling attachment. This used to be a bare torus hanging 4 mm clear of the
  // buffer tube with nothing joining the two — a ring floating in space beside
  // the weapon, which is exactly the kind of thing an eye finds in well under a
  // second. It is now the four parts it is on the rifle: a socket let into the
  // tube, a push-button swivel in the socket, the swivel's eye, and a webbing
  // loop through the eye.
  const slingSocket = new THREE.Mesh(new THREE.CylinderGeometry(0.0074, 0.0074, 0.0060, 12), body);
  slingSocket.rotation.z = Math.PI / 2;
  slingSocket.position.set(-0.0172, 0.012, 0.150);
  g.add(slingSocket);
  const swivel = new THREE.Mesh(new THREE.CylinderGeometry(0.0044, 0.0050, 0.0130, 10), steel);
  swivel.rotation.z = Math.PI / 2;
  swivel.position.set(-0.0248, 0.012, 0.150);
  g.add(swivel);
  const swivelEye = new THREE.Mesh(new THREE.TorusGeometry(0.0058, 0.0021, 6, 12), steel);
  swivelEye.rotation.y = Math.PI / 2;
  swivelEye.position.set(-0.0302, 0.0062, 0.150);
  g.add(swivelEye);
  const slingLoop = new THREE.Mesh(new THREE.TorusGeometry(0.0104, 0.0026, 6, 14), rubber);
  slingLoop.rotation.y = Math.PI / 2;
  slingLoop.position.set(-0.0302, -0.0050, 0.150);
  g.add(slingLoop);

  // --- hands ---------------------------------------------------------------
  // Firing hand closes on the pistol grip with the trigger finger out; support
  // hand takes the handguard in a C-clamp. Both are placed by `poseHand`, which
  // solves the orientation from the axis of the thing being held rather than
  // from three hand-tuned Euler angles — the old numbers had both hands rotated
  // as though gripping a bar running left-to-right across the screen, which is
  // why neither one made contact with anything.
  const HAND_SCALE = 0.90;
  // `mirror` builds the hand whose thumb sits on local +X. Chirality follows
  // from palmOut = fingers x thumb for a right hand and thumb x fingers for a
  // left one, and with the fingers at local +Y and the palm facing local -Z
  // that puts a right hand's thumb at +X — so the firing hand is the mirrored
  // one. The two flags used to be the wrong way round, which is why the support
  // hand's fingers swept round the barrel in the wrong direction no matter what
  // it was rolled to.
  const rightHand = glovedHand(glove, gloveShell, sleeveCloth, gloveCrease, gloveHard, {
    mirror: true, trigger: true, gripRadius: 0.022, holdY: 0.004, scale: HAND_SCALE,
  });
  poseHand(
    rightHand,
    new THREE.Vector3(0, -0.062, 0.058),        // where the grip passes through the fist
    new THREE.Vector3(0, 0.955, -0.296),        // up the grip: index at the top
    new THREE.Vector3(0, -0.296, -0.955),       // palm on the grip's backstrap
    new THREE.Vector3(0.42, -0.80, 0.43),       // sleeve leaves down, back and right
  );
  g.add(rightHand);

  // Support hand, C-clamped on the handguard. The camera looks at the weapon
  // from roughly 150 degrees round the barrel, and the roll is chosen against
  // that: the palm sits at about 325 degrees, on the far-lower quadrant, where
  // its own silhouette falls entirely inside the tube's — so the slab is behind
  // the geometry it grips, with no sky or ground behind it — while the four
  // fingers sweep from the far-lower flank, under the tube, and close on the
  // near side at 155 degrees, right where the lens is. Rolled onto the near
  // side instead, the palm hangs off the flank in open air, which is the
  // cutting-board read; rolled with the old (inverted) chirality the fingers
  // swept the wrong way and only their tips ever crested the tube.
  // The grip radius has to be the tube's own radius at the point the hand takes
  // it, plus a fraction of a millimetre for the leather. At 24.8 mm the fingers
  // solved onto a circle a millimetre and a half clear of the handguard, so the
  // whole hand floated off the thing it was gripping.
  const leftHand = glovedHand(glove, gloveShell, sleeveCloth, gloveCrease, gloveHard, {
    thumbForward: true, gripRadius: 0.0234, holdY: 0.010, scale: HAND_SCALE,
  });
  poseHand(
    leftHand,
    new THREE.Vector3(0, 0.013, hgZ - 0.026),   // the handguard's own axis
    new THREE.Vector3(0, 0, 1),                 // knuckles spread along the barrel
    new THREE.Vector3(-0.819, 0.574, 0),        // palm on the tube's far-lower flank
    new THREE.Vector3(-0.30, -0.80, 0.52),      // sleeve leaves down, back and left
  );
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
  const projected = new Set([
    body, rail, railWeb, steel, seam, carbon, polymer, gripShade, darkPolymer, rubber,
    anodised, glove, gloveCrease, gloveShell, gloveHard, sleeveCloth,
  ]);
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
const _hs = new THREE.Vector3();
const _hm = new THREE.Matrix4();
const _hq = new THREE.Quaternion();

const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();
const _worldMuzzle = new THREE.Vector3();
const _shellPos = new THREE.Vector3();
const _zero = new THREE.Vector3();
