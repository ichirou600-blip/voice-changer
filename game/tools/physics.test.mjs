/**
 * Headless checks for the collision spine. Physics.js depends only on three, so
 * it runs directly under node with no browser and no renderer.
 *
 *   node tools/physics.test.mjs
 *
 * These cover the properties everything else assumes: rays hit the nearest
 * surface with an outward-facing normal and the right surface id, the capsule
 * solver lands a character on ground and refuses to let it through a wall, and
 * the BVH agrees with brute force over the same triangle set.
 */
import * as THREE from 'three';
import { PhysicsWorld, SURFACE } from '../src/gameplay/Physics.js';

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a, b, eps = 1e-3) { return Math.abs(a - b) <= eps; }

function boxMesh(cx, cy, cz, sx, sy, sz, surface) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz));
  mesh.position.set(cx, cy, cz);
  mesh.userData.surface = surface;
  mesh.updateMatrixWorld(true);
  return mesh;
}

// ---------------------------------------------------------------------------
console.log('\nBVH ray queries');
{
  const world = new PhysicsWorld({});
  // Floor at y=0, a wall at z=-10, and a metal crate in between.
  world.addMesh(boxMesh(0, -0.5, 0, 200, 1, 200, SURFACE.CONCRETE), SURFACE.CONCRETE);
  world.addMesh(boxMesh(0, 5, -10, 40, 10, 1, SURFACE.PLASTER), SURFACE.PLASTER);
  world.addMesh(boxMesh(0, 1, -4, 2, 2, 2, SURFACE.METAL), SURFACE.METAL);
  world.bake();

  check('bakes a non-empty triangle soup', world.triCount > 0, `triCount=${world.triCount}`);

  const down = world.raycast(new THREE.Vector3(20, 5, 20), new THREE.Vector3(0, -1, 0), 50);
  check('ray finds the floor', !!down);
  check('floor hit distance is correct', down && near(down.distance, 5), `got ${down?.distance}`);
  check('floor normal points up', down && near(down.normal.y, 1), `got ${down?.normal.y}`);
  check('floor reports its surface id', down && down.surface === SURFACE.CONCRETE);

  // Fired down the -Z corridor, the crate is nearer than the wall behind it.
  const fwd = world.raycast(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), 50);
  check('ray stops at the nearest surface, not the far one', fwd && near(fwd.distance, 3), `got ${fwd?.distance}`);
  check('nearest hit reports the crate surface', fwd && fwd.surface === SURFACE.METAL, `got ${fwd?.surface}`);
  check('normal faces back along the ray', fwd && near(fwd.normal.z, 1), `got ${fwd?.normal.z}`);

  // maxDist must be respected — a short ray stops before the crate.
  const short = world.raycast(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), 2);
  check('respects maxDist', short === null);

  // A ray into empty sky must miss entirely.
  const miss = world.raycast(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 1, 0), 100);
  check('misses when nothing is in the way', miss === null);

  // Occlusion helper agrees with the ray it wraps.
  check('occluded() sees the wall',
    world.occluded(new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, 3, -20)));
  check('occluded() reports clear line of sight',
    !world.occluded(new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, 3, 3)));

  // groundHeight is what enemy spawning and footstep surfaces rely on.
  const gh = world.groundHeight(12, -3);
  check('groundHeight finds the floor', gh !== null && near(gh, 0), `got ${gh}`);
}

// ---------------------------------------------------------------------------
console.log('\nBVH agrees with brute force');
{
  // A scattering of boxes gives the BVH a real tree to traverse; every ray must
  // return exactly what an exhaustive triangle loop would.
  const world = new PhysicsWorld({});
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 60; i++) {
    world.addMesh(boxMesh(
      (rnd() - 0.5) * 60, rnd() * 8, (rnd() - 0.5) * 60,
      1 + rnd() * 4, 1 + rnd() * 6, 1 + rnd() * 4, SURFACE.CONCRETE,
    ), SURFACE.CONCRETE);
  }
  world.bake();

  const P = world.positions;
  const bruteForce = (o, d, maxDist) => {
    let best = maxDist;
    for (let tri = 0; tri < world.triCount; tri++) {
      const p = tri * 9;
      const e1 = new THREE.Vector3(P[p + 3] - P[p], P[p + 4] - P[p + 1], P[p + 5] - P[p + 2]);
      const e2 = new THREE.Vector3(P[p + 6] - P[p], P[p + 7] - P[p + 1], P[p + 8] - P[p + 2]);
      const h = new THREE.Vector3().crossVectors(d, e2);
      const a = e1.dot(h);
      if (Math.abs(a) < 1e-9) continue;
      const f = 1 / a;
      const s = new THREE.Vector3(o.x - P[p], o.y - P[p + 1], o.z - P[p + 2]);
      const u = f * s.dot(h);
      if (u < 0 || u > 1) continue;
      const q = new THREE.Vector3().crossVectors(s, e1);
      const v = f * d.dot(q);
      if (v < 0 || u + v > 1) continue;
      const t = f * e2.dot(q);
      if (t > 1e-4 && t < best) best = t;
    }
    return best === maxDist ? null : best;
  };

  let mismatches = 0;
  for (let i = 0; i < 200; i++) {
    const o = new THREE.Vector3((rnd() - 0.5) * 70, rnd() * 12, (rnd() - 0.5) * 70);
    const d = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const hit = world.raycast(o, d, 200);
    const expected = bruteForce(o, d, 200);
    const got = hit ? hit.distance : null;
    if ((expected === null) !== (got === null)) { mismatches++; continue; }
    if (expected !== null && !near(expected, got, 1e-3)) mismatches++;
  }
  check('200 random rays match brute force', mismatches === 0, `${mismatches} mismatches`);
}

// ---------------------------------------------------------------------------
console.log('\nCapsule solver');
{
  const world = new PhysicsWorld({});
  world.addMesh(boxMesh(0, -0.5, 0, 100, 1, 100, SURFACE.CONCRETE), SURFACE.CONCRETE);
  world.addMesh(boxMesh(0, 2, -5, 20, 4, 0.5, SURFACE.CONCRETE), SURFACE.CONCRETE);
  world.bake();

  const RADIUS = 0.34, HEIGHT = 1.82;

  // Dropped into the floor, the capsule must be pushed out and report grounded.
  const sunk = world.resolveCapsule(new THREE.Vector3(0, -0.25, 0), RADIUS, HEIGHT);
  check('reports grounded when resting on the floor', sunk.grounded);
  check('pushes the capsule out of the floor', sunk.position.y >= -0.02, `y=${sunk.position.y}`);
  check('ground normal points up', near(sunk.groundNormal.y, 1, 0.05), `got ${sunk.groundNormal.y}`);

  // Standing well clear of anything, nothing should move and nothing is grounded.
  const air = world.resolveCapsule(new THREE.Vector3(0, 20, 0), RADIUS, HEIGHT);
  check('leaves an airborne capsule alone', !air.grounded && near(air.position.y, 20));

  // Driven into the wall, the capsule must end up outside it on the near side.
  const intoWall = world.resolveCapsule(new THREE.Vector3(0, 0.5, -4.9), RADIUS, HEIGHT);
  check('does not let the capsule through a wall',
    intoWall.position.z > -5 + 0.25 - 1e-3, `z=${intoWall.position.z}`);
  check('reports the wall contact', intoWall.hitWall);
  check('wall normal points back toward the player',
    intoWall.wallNormal.z > 0.5, `got ${intoWall.wallNormal.z}`);

  // Repeated resolution must be stable — a settled capsule should not drift.
  let p = new THREE.Vector3(3, 0.0, 3);
  let last = null;
  for (let i = 0; i < 20; i++) {
    const r = world.resolveCapsule(p, RADIUS, HEIGHT);
    p = r.position.clone();
    last = r;
  }
  check('settled capsule is stable under repeated resolution',
    last.grounded && near(p.y, 0, 0.05), `y=${p.y}`);
}

// ---------------------------------------------------------------------------
console.log('\nRigid bodies');
{
  const world = new PhysicsWorld({});
  world.addMesh(boxMesh(0, -0.5, 0, 100, 1, 100, SURFACE.CONCRETE), SURFACE.CONCRETE);
  world.bake();

  let bounced = 0;
  const body = {
    position: new THREE.Vector3(0, 3, 0),
    velocity: new THREE.Vector3(1, 0, 0),
    angularVelocity: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    radius: 0.01,
    life: 5,
    onBounce: () => { bounced++; },
  };
  world.addDynamic(body);
  for (let i = 0; i < 240; i++) world.fixedUpdate(1 / 120);

  check('a dropped body bounces off the floor', bounced > 0, `${bounced} bounces`);
  check('a dropped body comes to rest above the floor',
    body.position.y > -0.05 && body.position.y < 0.3, `y=${body.position.y}`);
  check('a resting body goes to sleep', body.sleeping);

  // Expiry must remove the body and fire its callback exactly once.
  let expired = 0;
  world.addDynamic({
    position: new THREE.Vector3(0, 3, 0),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    radius: 0.01,
    life: 0.1,
    onExpire: () => { expired++; },
  });
  for (let i = 0; i < 60; i++) world.fixedUpdate(1 / 120);
  check('expired bodies are removed once', expired === 1, `expired=${expired}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
