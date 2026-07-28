/**
 * Triangle census of the viewmodel, offline.
 *
 * Builds WeaponSystem against a stub engine/texture library so the model can be
 * counted without a WebGL context or a 3-minute procedural bake.
 *
 *   node tools/vmtris.mjs
 */
import * as THREE from 'three';
import { WeaponSystem } from '../src/gameplay/Weapons.js';

const textures = {
  material(_name, opts = {}) { return new THREE.MeshStandardMaterial(opts); },
};
const engine = { viewScene: new THREE.Group(), camera: new THREE.PerspectiveCamera() };
const player = { setAdsFov() {}, speeds: { run: 5 }, recoilRot: new THREE.Vector3() };
const ws = new WeaponSystem(engine, { player, ballistics: {}, particles: {}, audio: {}, textures });

const report = {};
let grand = 0;
for (const [id, model] of Object.entries(ws.models)) {
  let tris = 0; let meshes = 0;
  const byMat = new Map();
  model.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    const t = (g.index ? g.index.count : g.attributes.position.count) / 3;
    tris += t;
    const k = o.material.name || o.material.uuid.slice(0, 6);
    byMat.set(k, (byMat.get(k) || 0) + t);
  });
  report[id] = { meshes, tris };
  grand += tris;
}
console.log(JSON.stringify({ ...report, grand }, null, 1));

// Sanity: no NaN in any attribute, and every mesh wearing a vertexColors
// material actually has a colour attribute (an undefined attribute reads as
// black in WebGL, which would silently paint the hand out of the frame).
const bad = [];
for (const model of Object.values(ws.models)) {
  model.traverse((o) => {
    if (!o.isMesh) return;
    for (const [k, a] of Object.entries(o.geometry.attributes)) {
      for (let i = 0; i < a.array.length; i++) {
        if (!Number.isFinite(a.array[i])) { bad.push(`NaN in ${k} of ${o.name || o.type}`); break; }
      }
    }
    if (o.material.vertexColors && !o.geometry.getAttribute('color')) {
      bad.push(`vertexColors material with no colour attribute: ${o.geometry.type}`);
    }
    if (!o.material.vertexColors && o.geometry.getAttribute('color')) {
      bad.push(`colour attribute on a non-vertexColors material: ${o.geometry.type}`);
    }
  });
}
console.log(bad.length ? JSON.stringify([...new Set(bad)], null, 1) : 'checks ok');
