import * as THREE from 'three';

/**
 * Light rig: the key directional (sun) with a shadow frustum that follows the
 * camera, a hemisphere fill derived from the sky, and a registry for the
 * level's local lights (practicals, muzzle flashes, explosions).
 *
 * CONTRACT:
 *   lighting.sun                       — THREE.DirectionalLight
 *   lighting.addLocal(light, opts)     — register a level light
 *   lighting.flash(pos, color, intensity, duration) — transient light pulse
 */
export class Lighting {
  constructor(engine, sky) {
    this.engine = engine;
    this.sky = sky;

    const sun = new THREE.DirectionalLight(sky.sunColor.clone(), 3.1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 180;
    const s = 48;
    sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
    sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.035;
    sun.target.position.set(0, 0, 0);
    engine.scene.add(sun);
    engine.scene.add(sun.target);
    this.sun = sun;

    this.hemi = new THREE.HemisphereLight(sky.ambientColor.clone(), new THREE.Color(0.16, 0.14, 0.12), 0.85);
    engine.scene.add(this.hemi);

    // Viewmodel gets its own miniature rig so the weapon reads well regardless
    // of where the player is standing.
    this.viewKey = new THREE.DirectionalLight(0xffffff, 2.4);
    this.viewKey.position.set(-0.6, 1.0, 0.8);
    engine.viewScene.add(this.viewKey);
    this.viewFill = new THREE.HemisphereLight(0x9fb6d0, 0x2a2622, 1.1);
    engine.viewScene.add(this.viewFill);

    this.locals = [];
    this.flashes = [];
    this._flashPool = [];
    this.maxFlashes = 6;
  }

  addLocal(light) {
    this.engine.scene.add(light);
    this.locals.push(light);
    return light;
  }

  /** Transient point light — muzzle flash, explosion, sparks. */
  flash(position, color, intensity, duration = 0.06, distance = 22) {
    let l = this._flashPool.pop();
    if (!l) {
      l = new THREE.PointLight(0xffffff, 0, distance, 2);
      l.castShadow = false;
      this.engine.scene.add(l);
    }
    l.visible = true;
    l.color.set(color);
    l.distance = distance;
    l.position.copy(position);
    this.flashes.push({ light: l, t: 0, duration, intensity });
    if (this.flashes.length > this.maxFlashes) {
      const old = this.flashes.shift();
      old.light.visible = false;
      old.light.intensity = 0;
      this._flashPool.push(old.light);
    }
    return l;
  }

  update(dt) {
    const cam = this.engine.camera;
    const sky = this.sky;
    // Keep the shadow frustum centred slightly ahead of the player so the
    // budget is spent on what's actually on screen.
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
    _center.copy(cam.position).addScaledVector(_fwd, 16);
    // Snap to texel grid to stop shadow edges crawling as the camera moves.
    const texel = (96) / this.sun.shadow.mapSize.x;
    _center.x = Math.round(_center.x / texel) * texel;
    _center.z = Math.round(_center.z / texel) * texel;

    this.sun.position.copy(_center).addScaledVector(sky.sunDirection, 80);
    this.sun.target.position.copy(_center);
    this.sun.target.updateMatrixWorld();
    this.sun.color.copy(sky.sunColor);
    this.hemi.color.copy(sky.ambientColor);

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = 1 - f.t / f.duration;
      if (k <= 0) {
        f.light.intensity = 0;
        f.light.visible = false;
        this._flashPool.push(f.light);
        this.flashes.splice(i, 1);
      } else {
        f.light.intensity = f.intensity * k * k;
      }
    }
  }
}

const _fwd = new THREE.Vector3();
const _center = new THREE.Vector3();
