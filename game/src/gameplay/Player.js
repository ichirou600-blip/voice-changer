import * as THREE from 'three';
import { damp, clamp, smoothstep } from '../core/Noise.js';

/**
 * Capsule character controller with the movement vocabulary a modern military
 * shooter expects: accelerate/decelerate curves, air control, sprint with a
 * tactical-sprint tier, crouch and slide, mantle, lean, and a camera rig that
 * layers sway/bob/breathe/recoil without any of them fighting each other.
 *
 * The camera is composed as: eye position + view offset (crouch/slide/land) and
 * orientation = look (yaw/pitch) * sway * bob * recoil * lean.
 */

const STANCE = { STAND: 0, CROUCH: 1, SLIDE: 2, PRONE: 3 };

export class Player {
  constructor(engine, { physics, level }) {
    this.engine = engine;
    this.physics = physics;
    this.level = level;

    this.position = new THREE.Vector3(0, 2, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.radius = 0.34;
    this.standHeight = 1.82;
    this.crouchHeight = 1.12;
    this.slideHeight = 0.95;
    this.height = this.standHeight;
    this.eyeOffset = 0.72;      // from capsule centre to eye

    this.stance = STANCE.STAND;
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.sprinting = false;
    this.tacSprint = 0;
    this.sprintHold = 0;
    this.slideTimer = 0;
    this.slideCooldown = 0;
    this.lean = 0;
    this.leanTarget = 0;
    this.adsFactor = 0;
    this.mantle = null;

    this.speeds = { walk: 3.05, run: 5.25, tacSprint: 7.1, crouch: 1.85, ads: 2.15, air: 1.0 };
    this.accelGround = 62;
    this.accelAir = 14;
    this.friction = 11.5;
    this.jumpVelocity = 6.55;

    this.health = 100;
    this.maxHealth = 100;
    // Presentation mode holds the player still in front of live hostiles, so
    // without this every hero shot is taken through a full-strength damage
    // vignette.
    this.invulnerable = false;
    this.regenDelay = 4.2;
    this.regenRate = 26;
    this.lastDamageAt = -99;
    this.dead = false;

    // Camera motion state.
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._swayPos = new THREE.Vector2();
    this._swayVel = new THREE.Vector2();
    this._landOffset = 0;
    this._landVel = 0;
    this._breathPhase = Math.random() * 10;
    this._viewOffset = new THREE.Vector3();
    this._prevGrounded = true;
    this._fallSpeed = 0;
    this._stepDist = 0;

    this.recoilRot = new THREE.Vector2();   // pitch, yaw applied to camera
    this.fovBase = 70;
    this.fovCurrent = 70;

    this._capsuleResult = {};
    this.onDamage = null;
    this.onStep = null;
    this.onLand = null;
    this.onJump = null;
  }

  attachInput(input) { this.input = input; }

  teleport(pos, yaw = 0, pitch = 0) {
    this.position.set(pos[0] ?? pos.x, pos[1] ?? pos.y, pos[2] ?? pos.z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw; this.pitch = pitch;
    this._syncCamera(0);
  }

  get eyePosition() {
    return _eye.set(this.position.x, this.position.y + this.height - 0.18, this.position.z);
  }

  get speed2D() { return Math.hypot(this.velocity.x, this.velocity.z); }

  addRecoil(pitch, yaw) {
    this.recoilRot.x += pitch;
    this.recoilRot.y += yaw;
  }

  damage(amount, from) {
    if (this.dead || this.invulnerable) return;
    this.health = Math.max(0, this.health - amount);
    this.lastDamageAt = this.engine.elapsed;
    const dir = from ? _tmp.subVectors(from, this.position).setY(0).normalize() : null;
    this.onDamage?.({ amount, health: this.health, direction: dir ? dir.clone() : null, from });
    if (this.health <= 0) this.dead = true;
  }

  fixedUpdate(dt) {
    if (!this.input) return;
    if (this.mantle) { this._updateMantle(dt); return; }

    const input = this.input;
    const axis = input.moveAxis();
    const wantSprint = (input.down('ShiftLeft') || input.padButton(10)) && axis.y > 0.3 && this.adsFactor < 0.4;
    const wantCrouch = input.down('ControlLeft') || input.down('KeyC') || input.padButton(1);

    // --- stance -------------------------------------------------------------
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    if (this.stance === STANCE.SLIDE) {
      this.slideTimer -= dt;
      const slideSpeed = this.speed2D;
      if (this.slideTimer <= 0 || slideSpeed < 2.4 || !this.grounded) {
        this.stance = wantCrouch ? STANCE.CROUCH : STANCE.STAND;
        this.slideCooldown = 0.45;
      }
    } else if (wantCrouch) {
      const fast = this.speed2D > 4.6 && this.grounded && this.slideCooldown <= 0 && this.sprinting;
      if (fast) {
        this.stance = STANCE.SLIDE;
        this.slideTimer = 0.72;
        // Slide converts sprint momentum into a burst, then decays.
        const dirLen = this.speed2D;
        if (dirLen > 0.01) {
          this.velocity.x *= 1.28;
          this.velocity.z *= 1.28;
        }
        this.onStep?.({ type: 'slide', position: this.position.clone() });
      } else {
        this.stance = STANCE.CROUCH;
      }
    } else if (this.stance === STANCE.CROUCH) {
      if (this._canStand()) this.stance = STANCE.STAND;
    }

    const targetHeight = this.stance === STANCE.SLIDE ? this.slideHeight
      : this.stance === STANCE.CROUCH ? this.crouchHeight : this.standHeight;
    this.height = damp(this.height, targetHeight, 14, dt);

    // Tactical sprint: hold sprint from a standstill for a short window to get
    // the higher speed tier; it drains and must recover.
    this.sprinting = wantSprint && this.stance !== STANCE.CROUCH;
    if (this.sprinting) {
      this.sprintHold += dt;
      this.tacSprint = clamp(this.tacSprint + dt * (this.sprintHold > 0.35 ? 1.7 : 0), 0, 1);
    } else {
      this.sprintHold = 0;
      this.tacSprint = clamp(this.tacSprint - dt * 2.4, 0, 1);
    }

    // --- look ---------------------------------------------------------------
    const look = input.consumeLook(this.adsFactor);
    this.yaw += look.yaw;
    this.pitch = clamp(this.pitch + look.pitch, -Math.PI * 0.495, Math.PI * 0.495);

    // Recoil recovers toward zero; the residual is what makes spray patterns
    // climb rather than instantly snapping back.
    this.recoilRot.x = damp(this.recoilRot.x, 0, 9.5, dt);
    this.recoilRot.y = damp(this.recoilRot.y, 0, 8.0, dt);

    // --- lean ---------------------------------------------------------------
    this.leanTarget = 0;
    if (input.down('KeyQ')) this.leanTarget = 1;
    if (input.down('KeyE')) this.leanTarget = -1;
    if (this.stance === STANCE.SLIDE) this.leanTarget = 0;
    this.lean = damp(this.lean, this.leanTarget, 11, dt);

    // --- horizontal movement -----------------------------------------------
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    // yaw 0 looks down -Z
    const fwdX = -sin, fwdZ = -cos;
    const rightX = cos, rightZ = -sin;
    let wishX = fwdX * axis.y + rightX * axis.x;
    let wishZ = fwdZ * axis.y + rightZ * axis.x;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-4) { wishX /= wishLen; wishZ /= wishLen; }

    let maxSpeed = this.speeds.walk;
    if (this.stance === STANCE.CROUCH) maxSpeed = this.speeds.crouch;
    else if (this.stance === STANCE.SLIDE) maxSpeed = this.speeds.tacSprint;
    else if (this.sprinting) maxSpeed = THREE.MathUtils.lerp(this.speeds.run, this.speeds.tacSprint, this.tacSprint);
    else if (this.adsFactor > 0.5) maxSpeed = this.speeds.ads;
    else if (wishLen > 0.01) maxSpeed = this.speeds.run * 0.82;
    // Strafing and backpedalling are deliberately slower than pushing forward.
    if (axis.y < -0.1) maxSpeed *= 0.78;

    if (this.stance === STANCE.SLIDE) {
      // No acceleration input during a slide, just directional bleed + friction.
      const decay = 1 - Math.min(1, 2.05 * dt);
      this.velocity.x *= decay; this.velocity.z *= decay;
      // Slopes accelerate the slide, which is the signature CoD feel.
      const slope = 1 - this.groundNormal.y;
      if (slope > 0.02) {
        this.velocity.x += this.groundNormal.x * slope * 34 * dt;
        this.velocity.z += this.groundNormal.z * slope * 34 * dt;
      }
    } else if (this.grounded) {
      const cur = _tmp2.set(this.velocity.x, 0, this.velocity.z);
      const curSpeed = cur.length();
      if (wishLen < 0.01) {
        const drop = curSpeed * this.friction * dt;
        const scale = curSpeed > 0 ? Math.max(0, curSpeed - drop) / curSpeed : 0;
        this.velocity.x *= scale; this.velocity.z *= scale;
      } else {
        const currentInWish = this.velocity.x * wishX + this.velocity.z * wishZ;
        const addSpeed = maxSpeed - currentInWish;
        if (addSpeed > 0) {
          const accel = Math.min(this.accelGround * maxSpeed * dt, addSpeed);
          this.velocity.x += wishX * accel;
          this.velocity.z += wishZ * accel;
        }
        // Bleed off any velocity that isn't in the wish direction so ground
        // movement feels crisp rather than icy.
        const lateralX = this.velocity.x - wishX * currentInWish;
        const lateralZ = this.velocity.z - wishZ * currentInWish;
        const bleed = 1 - Math.min(1, 9.0 * dt);
        this.velocity.x = wishX * currentInWish + lateralX * bleed;
        this.velocity.z = wishZ * currentInWish + lateralZ * bleed;
      }
    } else {
      const currentInWish = this.velocity.x * wishX + this.velocity.z * wishZ;
      const addSpeed = maxSpeed * 1.0 - currentInWish;
      if (addSpeed > 0) {
        const accel = Math.min(this.accelAir * maxSpeed * dt, addSpeed);
        this.velocity.x += wishX * accel;
        this.velocity.z += wishZ * accel;
      }
    }

    // --- jump ---------------------------------------------------------------
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    if (input.justPressed('Space') || input.padButton(0)) this.jumpBuffer = 0.14;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0 && this.stance !== STANCE.SLIDE) {
      this.velocity.y = this.jumpVelocity;
      this.grounded = false;
      this.coyote = 0; this.jumpBuffer = 0;
      this.onJump?.({ position: this.position.clone() });
    } else if (this.jumpBuffer > 0 && !this.grounded) {
      this._tryMantle();
    }

    // --- gravity + integrate ------------------------------------------------
    this.velocity.y += this.physics.gravity * dt;
    if (this.velocity.y < -60) this.velocity.y = -60;

    this.position.addScaledVector(this.velocity, dt);

    const res = this.physics.resolveCapsule(this.position, this.radius, this.height, this._capsuleResult);
    this.position.copy(res.position);
    const wasGrounded = this.grounded;
    this.grounded = res.grounded;
    this.groundNormal.copy(res.groundNormal);

    if (res.grounded && this.velocity.y < 0) this.velocity.y = 0;
    if (res.hitWall) {
      // Slide along the wall instead of sticking to it.
      const vn = this.velocity.dot(res.wallNormal);
      if (vn < 0) this.velocity.addScaledVector(res.wallNormal, -vn);
    }
    if (!res.grounded && this.velocity.y > 0) {
      // Head bump.
      const headHit = this.physics.raycast(
        _tmp.set(this.position.x, this.position.y + this.height - this.radius, this.position.z),
        _up, this.radius + 0.06, _hit,
      );
      if (headHit) this.velocity.y = Math.min(this.velocity.y, 0);
    }

    // Landing impulse feeds the camera dip and the footstep audio.
    if (!wasGrounded && this.grounded) {
      const impact = clamp(this._fallSpeed / 16, 0, 1.4);
      this._landVel -= impact * 3.6;
      this.onLand?.({ impact, position: this.position.clone(), stance: this.stance });
      if (impact > 0.86) this.damage((impact - 0.86) * 120, null);
    }
    this._fallSpeed = this.grounded ? 0 : Math.max(this._fallSpeed, -this.velocity.y);

    // Footsteps by distance travelled, not by timer — correct at every speed.
    if (this.grounded && this.stance !== STANCE.SLIDE) {
      this._stepDist += this.speed2D * dt;
      const stride = this.stance === STANCE.CROUCH ? 1.5 : this.sprinting ? 2.25 : 1.85;
      if (this._stepDist > stride) {
        this._stepDist = 0;
        this.onStep?.({ type: 'foot', position: this.position.clone(), speed: this.speed2D, stance: this.stance });
      }
    }

    // --- health regen -------------------------------------------------------
    if (!this.dead && this.engine.elapsed - this.lastDamageAt > this.regenDelay && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + this.regenRate * dt);
    }
  }

  _canStand() {
    const hit = this.physics.raycast(
      _tmp.set(this.position.x, this.position.y + this.crouchHeight, this.position.z),
      _up, this.standHeight - this.crouchHeight + 0.15, _hit,
    );
    return !hit;
  }

  /** Ledge detection: chest-height wall with clear space above it. */
  _tryMantle() {
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    _tmp2.set(-sin, 0, -cos);
    const chest = _tmp.set(this.position.x, this.position.y + 0.95, this.position.z);
    const wall = this.physics.raycast(chest, _tmp2, this.radius + 0.55, _hit);
    if (!wall || Math.abs(wall.normal.y) > 0.5) return;

    // Probe downward just past the wall to find the ledge top.
    const probe = _tmp3.copy(wall.point).addScaledVector(_tmp2, 0.45);
    probe.y = this.position.y + 2.35;
    const top = this.physics.raycast(probe, _down, 2.2, _hit2);
    if (!top) return;
    const rise = top.point.y - this.position.y;
    if (rise < 0.5 || rise > 1.95) return;
    if (top.normal.y < 0.6) return;

    this.mantle = {
      t: 0,
      duration: 0.42 + rise * 0.1,
      from: this.position.clone(),
      to: new THREE.Vector3(probe.x, top.point.y + 0.02, probe.z),
    };
    this.velocity.set(0, 0, 0);
    this.jumpBuffer = 0;
  }

  _updateMantle(dt) {
    const m = this.mantle;
    m.t += dt / m.duration;
    const t = clamp(m.t, 0, 1);
    // Up first, then forward — reads as pulling yourself over a ledge.
    const up = smoothstep(0, 0.62, t);
    const fwd = smoothstep(0.28, 1, t);
    this.position.set(
      THREE.MathUtils.lerp(m.from.x, m.to.x, fwd),
      THREE.MathUtils.lerp(m.from.y, m.to.y, up),
      THREE.MathUtils.lerp(m.from.z, m.to.z, fwd),
    );
    if (t >= 1) {
      this.mantle = null;
      this.grounded = true;
      this._landVel -= 0.6;
    }
  }

  update(dt) {
    this._syncCamera(dt);
  }

  _syncCamera(dt) {
    const cam = this.engine.camera;
    const speedRatio = clamp(this.speed2D / this.speeds.run, 0, 1.6);

    // Head bob: figure-eight, amplitude driven by ground speed, killed by ADS.
    const bobTarget = this.grounded && this.stance !== STANCE.SLIDE ? speedRatio : 0;
    this._bobAmp = damp(this._bobAmp, bobTarget * (1 - this.adsFactor * 0.85), 8, dt);
    this._bobPhase += dt * (6.2 + speedRatio * 5.4);
    const bobX = Math.sin(this._bobPhase) * 0.021 * this._bobAmp;
    const bobY = -Math.abs(Math.cos(this._bobPhase)) * 0.026 * this._bobAmp;
    const bobRoll = Math.sin(this._bobPhase) * 0.011 * this._bobAmp;

    // Idle breathing keeps the frame alive when standing still.
    this._breathPhase += dt * 1.15;
    const idle = (1 - this._bobAmp) * (1 - this.adsFactor * 0.7);
    const breathY = Math.sin(this._breathPhase) * 0.0045 * idle;
    const breathX = Math.sin(this._breathPhase * 0.53) * 0.0032 * idle;

    // Landing spring.
    this._landVel += -this._landOffset * 145 * dt;
    this._landVel *= Math.exp(-11 * dt);
    this._landOffset += this._landVel * dt;
    this._landOffset = clamp(this._landOffset, -0.42, 0.12);

    const eye = this.eyePosition;
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    const rightX = cos, rightZ = -sin;
    const leanAmount = this.lean * 0.42;

    cam.position.set(
      eye.x + bobX + breathX + rightX * leanAmount,
      eye.y + bobY + breathY + this._landOffset - (this.stance === STANCE.SLIDE ? 0.12 : 0),
      eye.z + rightZ * leanAmount,
    );

    cam.rotation.set(
      this.pitch + this.recoilRot.x,
      this.yaw + this.recoilRot.y,
      bobRoll - this.lean * 0.30 - this._strafeRoll(dt),
      'YXZ',
    );

    // FOV: widens with speed, narrows with ADS. Kept on a spring so it never
    // pops during a slide-cancel.
    const speedFov = this.sprinting ? 6.5 * this.tacSprint + 3.0 : speedRatio * 2.2;
    const target = this.fovBase + speedFov - this.adsFactor * (this.fovBase - this.adsFov());
    this.fovCurrent = damp(this.fovCurrent, target, 9, dt);
    if (Math.abs(cam.fov - this.fovCurrent) > 0.004) {
      cam.fov = this.fovCurrent;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  adsFov() { return this._adsFov ?? 48; }
  setAdsFov(v) { this._adsFov = v; }

  _strafeRoll(dt) {
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    const rightX = cos, rightZ = -sin;
    const lateral = this.velocity.x * rightX + this.velocity.z * rightZ;
    this._roll = damp(this._roll || 0, clamp(lateral / this.speeds.run, -1, 1) * 0.026, 7, dt);
    return this._roll;
  }
}

const _eye = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _tmp3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _hit = {}, _hit2 = {};

export { STANCE };
