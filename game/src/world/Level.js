import * as THREE from 'three';
import { Simplex, fbm2, mulberry32, clamp } from '../core/Noise.js';
import { SURFACE } from '../gameplay/Physics.js';

/**
 * The playable space. Assembles terrain, a modular urban block, props, clutter
 * and the collision soup, and publishes the named camera poses the automated
 * visual-comparison harness shoots from.
 *
 * CONTRACT:
 *   await level.build(onProgress)
 *   level.cameraPoses  — { name: {position:[x,y,z], yaw, pitch, fov?, timeOfDay?, hideViewmodel?} }
 *   level.spawnPoints  — [THREE.Vector3]
 *   level.patrolPoints — [THREE.Vector3]  (AI route seeds)
 *   level.raycastEntities(origin, dir, maxDist) — breakables; null if none hit
 */
export class Level {
  constructor(engine, { textures, physics, seed = 1, lighting }) {
    this.engine = engine;
    this.textures = textures;
    this.physics = physics;
    this.lighting = lighting;
    this.seed = seed;
    this.rnd = mulberry32(seed);
    this.noise = new Simplex(seed);
    this.root = new THREE.Group();
    this.root.name = 'Level';
    engine.scene.add(this.root);

    this.spawnPoints = [];
    this.patrolPoints = [];
    this.breakables = [];
    this.cameraPoses = {};
    this.size = 160;
  }

  async build(onProgress = () => {}) {
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

    onProgress(0.05, 'TERRAIN');
    this._buildGround();
    await yieldFrame();

    onProgress(0.35, 'STRUCTURES');
    this._buildBlocks();
    await yieldFrame();

    onProgress(0.7, 'PROPS');
    this._buildProps();
    await yieldFrame();

    onProgress(0.85, 'COLLISION');
    this.physics.bake();

    this._definePoses();
    onProgress(1, 'LEVEL READY');
    return this;
  }

  _buildGround() {
    const S = this.size;
    const geo = new THREE.PlaneGeometry(S * 2, S * 2, 96, 96);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = fbm2(this.noise, x * 0.006, z * 0.006, 4) * 2.2;
      pos.setY(i, h);
    }
    geo.computeVertexNormals();
    geo.setAttribute('uv2', geo.attributes.uv);

    const mat = this.textures.material('asphalt', { repeat: [42, 42] });
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    ground.userData.surface = SURFACE.CONCRETE;
    this.root.add(ground);
    this.physics.addMesh(ground, SURFACE.CONCRETE);
  }

  _buildBlocks() {
    const rnd = this.rnd;
    const concrete = this.textures.material('concrete', { repeat: [4, 4] });
    const brick = this.textures.material('brick', { repeat: [3, 5] });
    const plaster = this.textures.material('plaster', { repeat: [3, 4] });
    const mats = [concrete, brick, plaster];

    // A ring of buildings around a central courtyard: readable sightlines,
    // multiple engagement ranges, and cover at every distance.
    const count = 14;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rnd() * 0.2;
      const dist = 34 + rnd() * 30;
      const w = 8 + rnd() * 12;
      const d = 8 + rnd() * 12;
      const h = 6 + rnd() * 16;
      const geo = new THREE.BoxGeometry(w, h, d);
      geo.setAttribute('uv2', geo.attributes.uv);
      const mesh = new THREE.Mesh(geo, mats[(rnd() * mats.length) | 0]);
      mesh.position.set(Math.cos(a) * dist, h / 2, Math.sin(a) * dist);
      mesh.rotation.y = rnd() * Math.PI;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.surface = SURFACE.CONCRETE;
      this.root.add(mesh);
      this.physics.addMesh(mesh, SURFACE.CONCRETE);

      this.patrolPoints.push(new THREE.Vector3(
        Math.cos(a) * (dist - w), 0, Math.sin(a) * (dist - d),
      ));
    }

    // Central cover: low walls players can vault and shoot over.
    for (let i = 0; i < 18; i++) {
      const a = rnd() * Math.PI * 2;
      const dist = 6 + rnd() * 22;
      const w = 2.4 + rnd() * 5;
      const h = 1.05 + rnd() * 0.5;
      const geo = new THREE.BoxGeometry(w, h, 0.6);
      geo.setAttribute('uv2', geo.attributes.uv);
      const mesh = new THREE.Mesh(geo, concrete);
      mesh.position.set(Math.cos(a) * dist, h / 2, Math.sin(a) * dist);
      mesh.rotation.y = rnd() * Math.PI;
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.root.add(mesh);
      this.physics.addMesh(mesh, SURFACE.CONCRETE);
    }
  }

  _buildProps() {
    const rnd = this.rnd;
    const metal = this.textures.material('rustMetal', { repeat: [2, 2] });
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2;
      const dist = 8 + rnd() * 40;
      const geo = new THREE.BoxGeometry(1.0, 1.4, 1.0);
      geo.setAttribute('uv2', geo.attributes.uv);
      const crate = new THREE.Mesh(geo, metal);
      crate.position.set(Math.cos(a) * dist, 0.7, Math.sin(a) * dist);
      crate.rotation.y = rnd() * Math.PI;
      crate.castShadow = true; crate.receiveShadow = true;
      crate.userData.surface = SURFACE.METAL;
      this.root.add(crate);
      this.physics.addMesh(crate, SURFACE.METAL);
    }

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.spawnPoints.push(new THREE.Vector3(Math.cos(a) * 16, 1.0, Math.sin(a) * 16));
    }
  }

  _definePoses() {
    this.cameraPoses = {
      hero: { position: [0, 2.0, 22], yaw: 0, pitch: -0.06, fov: 70 },
      alley: { position: [-24, 2.0, 8], yaw: 1.25, pitch: -0.02, fov: 70 },
      skyline: { position: [8, 2.0, 40], yaw: 0.15, pitch: 0.16, fov: 75 },
      closeup: { position: [4, 1.7, 6], yaw: -0.6, pitch: -0.12, fov: 60 },
      goldenHour: { position: [0, 2.0, 26], yaw: 0.1, pitch: 0.02, fov: 70, timeOfDay: 17.2 },
    };
  }

  /** Breakable/entity ray query used by ballistics. Static world is separate. */
  raycastEntities() { return null; }

  update() {}
}
