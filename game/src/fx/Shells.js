import * as THREE from 'three';

/**
 * Ejected cartridge cases.
 *
 * Casings are real rigid bodies handed to the physics world, so they bounce off
 * the actual level geometry, ring when they land on concrete and settle where
 * they stop — rather than being a particle effect that fades out mid-air. They
 * are drawn as a single InstancedMesh, so a full magazine of brass on the floor
 * still costs one draw call.
 *
 * CONTRACT (called from Weapons.js):
 *   shells.spawn(position, rightVector, upVector, opts)
 */
export class ShellSystem {
  constructor(engine, { physics, audio, max = 96 } = {}) {
    this.engine = engine;
    this.physics = physics;
    this.audio = audio;
    this.max = max;

    // A cartridge case: tapered tube with a rim. Low segment count is fine —
    // these are ~1cm on screen and always in motion.
    const geo = new THREE.CylinderGeometry(0.0045, 0.0050, 0.0195, 7, 1, false);
    geo.rotateZ(Math.PI / 2);   // lie along local X so tumbling reads correctly

    const material = new THREE.MeshStandardMaterial({
      color: 0xb08a3c, metalness: 1.0, roughness: 0.34,
    });

    this.mesh = new THREE.InstancedMesh(geo, material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.noCollide = true;
    this.mesh.count = 0;
    engine.scene.add(this.mesh);

    this.bodies = [];
    this._head = 0;
  }

  /**
   * @param position  world-space ejection port position
   * @param right     camera right vector — casings eject to the shooter's right
   * @param up        camera up vector
   */
  spawn(position, right, up, { speed = 2.4, life = 9 } = {}) {
    if (this.bodies.length >= this.max) {
      // Recycle the oldest casing rather than growing the buffer.
      const oldest = this.bodies.shift();
      this.physics.dynamics.splice(this.physics.dynamics.indexOf(oldest), 1);
    }

    const body = {
      position: position.clone(),
      velocity: new THREE.Vector3()
        .addScaledVector(right, speed * (0.85 + Math.random() * 0.4))
        .addScaledVector(up, speed * (0.45 + Math.random() * 0.3)),
      // Casings tumble fast around their long axis coming off the extractor.
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 34,
        (Math.random() - 0.5) * 22,
        (Math.random() - 0.5) * 34,
      ),
      rotation: new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28),
      radius: 0.010,
      life,
      drag: 0.22,
      restitution: 0.42,
      friction: 0.55,
      sleeping: false,
      onBounce: (b, hit) => {
        // Only the first couple of bounces are audible; after that a casing is
        // skittering, not ringing, and repeated pings sound like a bug.
        if ((b.bounces || 0) <= 2 && b.velocity.lengthSq() > 0.6) {
          this.audio?.playAt?.('shell', hit.point);
        }
      },
    };

    this.physics.addDynamic(body);
    this.bodies.push(body);
    return body;
  }

  update() {
    const n = this.bodies.length;
    // Drop bodies the physics world has already expired.
    for (let i = n - 1; i >= 0; i--) {
      if (this.bodies[i].life <= 0) this.bodies.splice(i, 1);
    }

    const count = this.bodies.length;
    for (let i = 0; i < count; i++) {
      const b = this.bodies[i];
      _q.setFromEuler(b.rotation);
      // Fade the last second of life into the floor by shrinking, so casings
      // vanish without a visible pop.
      const s = b.life < 1 ? Math.max(0.001, b.life) : 1;
      _s.set(s, s, s);
      _m.compose(b.position, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = count;
    if (count > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.engine.scene.remove(this.mesh);
    this.bodies.length = 0;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
