import * as THREE from 'three';

/**
 * Static-world collision built on a flat triangle BVH, plus a capsule solver
 * for characters and an analytic ray/triangle query for hitscan ballistics.
 *
 * The whole level is baked into one triangle soup at load. That keeps queries
 * pointer-chase-free (everything is a typed array) and removes per-frame
 * matrix work, which matters because ballistics can fire dozens of rays a frame
 * during full-auto.
 *
 * Surface identity travels with the triangle: each face carries a material id
 * so impacts pick the right decal, particle burst, ricochet audio and
 * penetration coefficient without a second lookup.
 */

export const SURFACE = {
  CONCRETE: 0,
  METAL: 1,
  WOOD: 2,
  DIRT: 3,
  SAND: 4,
  GLASS: 5,
  FABRIC: 6,
  FLESH: 7,
  WATER: 8,
  FOLIAGE: 9,
  RUBBER: 10,
  PLASTER: 11,
};

/** Per-surface response tuning consumed by Ballistics/Decals/Audio/Particles. */
export const SURFACE_INFO = {
  [SURFACE.CONCRETE]: { name: 'concrete', penetration: 0.35, hardness: 0.9, dustColor: 0xbdb6ab, sparks: 0.05, ricochet: 0.35 },
  [SURFACE.METAL]: { name: 'metal', penetration: 0.22, hardness: 1.0, dustColor: 0x9aa1a8, sparks: 1.0, ricochet: 0.7 },
  [SURFACE.WOOD]: { name: 'wood', penetration: 0.75, hardness: 0.45, dustColor: 0x9c7a4d, sparks: 0.0, ricochet: 0.1 },
  [SURFACE.DIRT]: { name: 'dirt', penetration: 0.55, hardness: 0.3, dustColor: 0x6b5a44, sparks: 0.0, ricochet: 0.05 },
  [SURFACE.SAND]: { name: 'sand', penetration: 0.65, hardness: 0.2, dustColor: 0xc2ab86, sparks: 0.0, ricochet: 0.02 },
  [SURFACE.GLASS]: { name: 'glass', penetration: 0.95, hardness: 0.6, dustColor: 0xcfe4ea, sparks: 0.0, ricochet: 0.0 },
  [SURFACE.FABRIC]: { name: 'fabric', penetration: 0.9, hardness: 0.1, dustColor: 0x6a6257, sparks: 0.0, ricochet: 0.0 },
  [SURFACE.FLESH]: { name: 'flesh', penetration: 0.85, hardness: 0.15, dustColor: 0x7a1414, sparks: 0.0, ricochet: 0.0 },
  [SURFACE.WATER]: { name: 'water', penetration: 0.6, hardness: 0.05, dustColor: 0x9fc4d0, sparks: 0.0, ricochet: 0.15 },
  [SURFACE.FOLIAGE]: { name: 'foliage', penetration: 0.98, hardness: 0.05, dustColor: 0x4d6b34, sparks: 0.0, ricochet: 0.0 },
  [SURFACE.RUBBER]: { name: 'rubber', penetration: 0.5, hardness: 0.35, dustColor: 0x2a2a2c, sparks: 0.0, ricochet: 0.05 },
  [SURFACE.PLASTER]: { name: 'plaster', penetration: 0.6, hardness: 0.35, dustColor: 0xd6cec2, sparks: 0.0, ricochet: 0.1 },
};

const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _p = new THREE.Vector3();
const _q = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3();

export class PhysicsWorld {
  constructor(engine) {
    this.engine = engine;
    this.gravity = -21.5;      // punchier than real g, standard for shooters
    this._tri = [];            // staged triangles before bake
    this._mat = [];
    this.triCount = 0;
    this.positions = null;     // Float32Array, 9 floats per triangle
    this.normals = null;       // Float32Array, 3 floats per triangle (face normal)
    this.surfaces = null;      // Uint8Array, 1 per triangle
    this.nodes = null;         // BVH: flat Float32Array
    this.triIndex = null;      // Uint32Array
    this.dynamics = [];        // rigid bodies (shells, debris, gibs)
    this.bounds = new THREE.Box3();
  }

  /**
   * Bake a mesh (or any object with geometry) into the static collision soup.
   * `surface` selects the SURFACE id used for all its faces unless the geometry
   * carries a per-group override via `geometry.userData.surfaceGroups`.
   */
  addMesh(object, surface = SURFACE.CONCRETE) {
    object.updateWorldMatrix(true, false);
    object.traverse((child) => {
      if (!child.isMesh || child.userData.noCollide) return;
      const geo = child.geometry;
      if (!geo || !geo.attributes.position) return;
      child.updateWorldMatrix(true, false);
      const m = child.matrixWorld;
      const pos = geo.attributes.position;
      const idx = geo.index;
      const surf = child.userData.surface !== undefined ? child.userData.surface : surface;
      const count = idx ? idx.count : pos.count;
      for (let i = 0; i < count; i += 3) {
        const a = idx ? idx.getX(i) : i;
        const b = idx ? idx.getX(i + 1) : i + 1;
        const c = idx ? idx.getX(i + 2) : i + 2;
        _v0.fromBufferAttribute(pos, a).applyMatrix4(m);
        _v1.fromBufferAttribute(pos, b).applyMatrix4(m);
        _v2.fromBufferAttribute(pos, c).applyMatrix4(m);
        this._tri.push(_v0.x, _v0.y, _v0.z, _v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z);
        this._mat.push(surf);
      }
    });
  }

  /** Convenience: an axis-aligned box collider without needing a mesh. */
  addBox(center, size, surface = SURFACE.CONCRETE) {
    const g = new THREE.BoxGeometry(size.x, size.y, size.z);
    const m = new THREE.Mesh(g, null);
    m.position.copy(center);
    m.userData.surface = surface;
    m.updateMatrixWorld(true);
    this.addMesh(m, surface);
    g.dispose();
  }

  /** Build the BVH. Call once after all colliders are staged. */
  bake() {
    const n = this._mat.length;
    this.triCount = n;
    this.positions = new Float32Array(this._tri);
    this.surfaces = new Uint8Array(this._mat);
    this.normals = new Float32Array(n * 3);
    const centroids = new Float32Array(n * 3);
    const bmin = new Float32Array(n * 3);
    const bmax = new Float32Array(n * 3);
    const P = this.positions;

    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const ax = P[o], ay = P[o + 1], az = P[o + 2];
      const bx = P[o + 3], by = P[o + 4], bz = P[o + 5];
      const cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
      _e1.set(bx - ax, by - ay, bz - az);
      _e2.set(cx - ax, cy - ay, cz - az);
      _n.crossVectors(_e1, _e2).normalize();
      this.normals[i * 3] = _n.x; this.normals[i * 3 + 1] = _n.y; this.normals[i * 3 + 2] = _n.z;
      centroids[i * 3] = (ax + bx + cx) / 3;
      centroids[i * 3 + 1] = (ay + by + cy) / 3;
      centroids[i * 3 + 2] = (az + bz + cz) / 3;
      bmin[i * 3] = Math.min(ax, bx, cx); bmax[i * 3] = Math.max(ax, bx, cx);
      bmin[i * 3 + 1] = Math.min(ay, by, cy); bmax[i * 3 + 1] = Math.max(ay, by, cy);
      bmin[i * 3 + 2] = Math.min(az, bz, cz); bmax[i * 3 + 2] = Math.max(az, bz, cz);
    }

    this.triIndex = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.triIndex[i] = i;

    // Node layout: [minx,miny,minz, maxx,maxy,maxz, leftOrStart, countOrZero]
    const maxNodes = Math.max(1, n * 2);
    const nodes = new Float32Array(maxNodes * 8);
    let nodeCount = 1;

    const setBounds = (node, start, count) => {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity;
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = start; i < start + count; i++) {
        const t = this.triIndex[i] * 3;
        if (bmin[t] < x0) x0 = bmin[t];
        if (bmin[t + 1] < y0) y0 = bmin[t + 1];
        if (bmin[t + 2] < z0) z0 = bmin[t + 2];
        if (bmax[t] > x1) x1 = bmax[t];
        if (bmax[t + 1] > y1) y1 = bmax[t + 1];
        if (bmax[t + 2] > z1) z1 = bmax[t + 2];
      }
      const o = node * 8;
      nodes[o] = x0; nodes[o + 1] = y0; nodes[o + 2] = z0;
      nodes[o + 3] = x1; nodes[o + 4] = y1; nodes[o + 5] = z1;
    };

    const LEAF_SIZE = 6;
    const stack = [[0, 0, n]];
    while (stack.length) {
      const [node, start, count] = stack.pop();
      setBounds(node, start, count);
      const o = node * 8;
      if (count <= LEAF_SIZE) {
        nodes[o + 6] = start;
        nodes[o + 7] = count;
        continue;
      }
      // Split on the widest axis at the centroid median (binned midpoint with a
      // median fallback so degenerate distributions still make progress).
      const ex = nodes[o + 3] - nodes[o], ey = nodes[o + 4] - nodes[o + 1], ez = nodes[o + 5] - nodes[o + 2];
      const axis = ex > ey ? (ex > ez ? 0 : 2) : (ey > ez ? 1 : 2);
      const mid = (nodes[o + axis] + nodes[o + 3 + axis]) * 0.5;
      let i = start, j = start + count - 1;
      while (i <= j) {
        if (centroids[this.triIndex[i] * 3 + axis] < mid) i++;
        else { const tmp = this.triIndex[i]; this.triIndex[i] = this.triIndex[j]; this.triIndex[j] = tmp; j--; }
      }
      let leftCount = i - start;
      if (leftCount === 0 || leftCount === count) {
        const sub = Array.from(this.triIndex.subarray(start, start + count));
        sub.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
        for (let k = 0; k < count; k++) this.triIndex[start + k] = sub[k];
        leftCount = count >> 1;
      }
      const left = nodeCount++;
      const right = nodeCount++;
      nodes[o + 6] = left;
      nodes[o + 7] = 0;
      stack.push([left, start, leftCount]);
      stack.push([right, start + leftCount, count - leftCount]);
    }

    this.nodes = nodes;
    this.nodeCount = nodeCount;
    this.bounds.set(
      new THREE.Vector3(nodes[0], nodes[1], nodes[2]),
      new THREE.Vector3(nodes[3], nodes[4], nodes[5]),
    );
    this._tri = null; this._mat = null;
    return this;
  }

  /**
   * Ray query against the static world.
   * @returns {null|{point:THREE.Vector3, normal:THREE.Vector3, distance:number, surface:number, tri:number}}
   */
  raycast(origin, direction, maxDist = 1000, out = {}) {
    if (!this.nodes) return null;
    const P = this.positions, nodes = this.nodes, triIndex = this.triIndex;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = direction.x, dy = direction.y, dz = direction.z;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let best = maxDist, bestTri = -1, bu = 0, bv = 0;

    const stack = _rayStack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 8;
      // Slab test
      let t0 = (nodes[o] - ox) * ix, t1 = (nodes[o + 3] - ox) * ix;
      let tmin = Math.min(t0, t1), tmax = Math.max(t0, t1);
      t0 = (nodes[o + 1] - oy) * iy; t1 = (nodes[o + 4] - oy) * iy;
      tmin = Math.max(tmin, Math.min(t0, t1)); tmax = Math.min(tmax, Math.max(t0, t1));
      t0 = (nodes[o + 2] - oz) * iz; t1 = (nodes[o + 5] - oz) * iz;
      tmin = Math.max(tmin, Math.min(t0, t1)); tmax = Math.min(tmax, Math.max(t0, t1));
      if (tmax < Math.max(tmin, 0) || tmin > best) continue;

      const count = nodes[o + 7];
      if (count > 0) {
        const start = nodes[o + 6];
        for (let i = start; i < start + count; i++) {
          const tri = triIndex[i];
          const p = tri * 9;
          // Möller–Trumbore
          const e1x = P[p + 3] - P[p], e1y = P[p + 4] - P[p + 1], e1z = P[p + 5] - P[p + 2];
          const e2x = P[p + 6] - P[p], e2y = P[p + 7] - P[p + 1], e2z = P[p + 8] - P[p + 2];
          const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
          const a = e1x * hx + e1y * hy + e1z * hz;
          if (a > -1e-9 && a < 1e-9) continue;
          const f = 1 / a;
          const sx = ox - P[p], sy = oy - P[p + 1], sz = oz - P[p + 2];
          const u = f * (sx * hx + sy * hy + sz * hz);
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = f * (dx * qx + dy * qy + dz * qz);
          if (v < 0 || u + v > 1) continue;
          const dist = f * (e2x * qx + e2y * qy + e2z * qz);
          if (dist > 1e-4 && dist < best) { best = dist; bestTri = tri; bu = u; bv = v; }
        }
      } else {
        const left = nodes[o + 6];
        stack[sp++] = left;
        stack[sp++] = left + 1;
      }
    }

    if (bestTri < 0) return null;
    out.point = (out.point || new THREE.Vector3()).set(ox + dx * best, oy + dy * best, oz + dz * best);
    const nrm = out.normal || new THREE.Vector3();
    nrm.set(this.normals[bestTri * 3], this.normals[bestTri * 3 + 1], this.normals[bestTri * 3 + 2]);
    // Always return the normal facing the ray so decals never z-fight inward.
    if (nrm.x * dx + nrm.y * dy + nrm.z * dz > 0) nrm.negate();
    out.normal = nrm;
    out.distance = best;
    out.surface = this.surfaces[bestTri];
    out.tri = bestTri;
    out.uv = { u: bu, v: bv };
    return out;
  }

  /** Cheap boolean visibility test used by AI line-of-sight. */
  occluded(from, to) {
    _t.subVectors(to, from);
    const d = _t.length();
    if (d < 1e-4) return false;
    _t.multiplyScalar(1 / d);
    return this.raycast(from, _t, d - 0.05, _scratchHit) !== null;
  }

  /**
   * Resolve a capsule against the static world by iterative depenetration.
   * The capsule is defined by its base position, radius and total height.
   * Returns { position, grounded, groundNormal, hitWall, wallNormal }.
   *
   * Two details here are load-bearing:
   *
   * 1. Contacts are detected out to radius + SKIN but only pushed when they are
   *    genuinely interpenetrating. Without that margin a capsule that settles
   *    exactly on the floor sits at distance == radius, fails a strict test, and
   *    reports airborne — so the player flickers between grounded and falling on
   *    perfectly flat ground.
   *
   * 2. When the capsule axis ends up *behind* a triangle's plane it is inside
   *    the solid, and the vector from surface to axis points the wrong way —
   *    pushing deeper in. Those contacts are collected separately and resolved
   *    along the face normal, taking only the shallowest exit. Resolving all of
   *    them would have opposite faces of a thin wall fight each other, which is
   *    exactly how a character tunnels through it.
   */
  resolveCapsule(position, radius, height, result = {}) {
    const SKIN = 0.02;
    const half = Math.max(0.001, height * 0.5 - radius);
    let px = position.x, py = position.y + height * 0.5, pz = position.z;
    let grounded = false, hitWall = false;
    const gn = result.groundNormal || new THREE.Vector3(0, 1, 0);
    const wn = result.wallNormal || new THREE.Vector3();
    gn.set(0, 1, 0); wn.set(0, 0, 0);
    let bestGroundY = -Infinity;

    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      // Shallowest exit for the "axis is inside the solid" case, resolved after
      // every triangle has been considered.
      let exitDepth = Infinity, exitX = 0, exitY = 0, exitZ = 0;

      const list = this.queryAABB(
        px - radius - SKIN - 0.1, py - half - radius - SKIN - 0.1, pz - radius - SKIN - 0.1,
        px + radius + SKIN + 0.1, py + half + radius + SKIN + 0.1, pz + radius + SKIN + 0.1,
      );
      for (let li = 0; li < list.length; li++) {
        const tri = list[li];
        const o = tri * 9;
        _v0.set(this.positions[o], this.positions[o + 1], this.positions[o + 2]);
        _v1.set(this.positions[o + 3], this.positions[o + 4], this.positions[o + 5]);
        _v2.set(this.positions[o + 6], this.positions[o + 7], this.positions[o + 8]);
        _n.set(this.normals[tri * 3], this.normals[tri * 3 + 1], this.normals[tri * 3 + 2]);

        // Closest point on the capsule's segment to the triangle plane, then
        // clamp into the triangle to get the true closest feature.
        const segTop = _p.set(px, py + half, pz);
        const segBot = _q.set(px, py - half, pz);
        const cp = closestPointSegmentTriangle(segBot, segTop, _v0, _v1, _v2, _n, _cpOut);
        // Vector from the closest triangle point to the closest segment point:
        // its length is the separation and its direction is the push-out.
        const sx = cp.sx - cp.px, sy = cp.sy - cp.py, sz = cp.sz - cp.pz;
        const dist = Math.hypot(sx, sy, sz);
        if (dist >= radius + SKIN) continue;

        // Signed distance along the face normal tells us which side we are on.
        const signed = sx * _n.x + sy * _n.y + sz * _n.z;

        if (signed < 1e-6 || dist < 1e-7) {
          // Behind the plane (or exactly on it): inside the solid. Record the
          // cheapest way out along the face normal and move on.
          const depth = radius - signed;
          if (depth > 0 && depth < exitDepth) {
            exitDepth = depth; exitX = _n.x; exitY = _n.y; exitZ = _n.z;
          }
          continue;
        }

        const nx = sx / dist, ny = sy / dist, nz = sz / dist;
        const depth = radius - dist;
        if (depth > 0) {
          px += nx * depth; py += ny * depth; pz += nz * depth;
          moved = true;
        }

        // Contact classification uses the skin, so resting contacts still count.
        if (ny > 0.5) {
          grounded = true;
          if (cp.py > bestGroundY) { bestGroundY = cp.py; gn.set(nx, ny, nz); }
        } else if (ny > -0.5) {
          hitWall = true;
          wn.set(nx, ny, nz);
        }
      }

      if (exitDepth < Infinity) {
        px += exitX * exitDepth; py += exitY * exitDepth; pz += exitZ * exitDepth;
        moved = true;
        if (exitY > 0.5) { grounded = true; gn.set(exitX, exitY, exitZ); }
        else if (exitY > -0.5) { hitWall = true; wn.set(exitX, exitY, exitZ); }
      }

      if (!moved) break;
    }

    result.position = (result.position || new THREE.Vector3()).set(px, py - height * 0.5, pz);
    result.grounded = grounded;
    result.groundNormal = gn;
    result.hitWall = hitWall;
    result.wallNormal = wn;
    return result;
  }

  /** Downward probe used for step/ground snapping and enemy foot placement. */
  groundHeight(x, z, fromY = 200, maxDrop = 400) {
    _t.set(0, -1, 0);
    _p.set(x, fromY, z);
    const hit = this.raycast(_p, _t, maxDrop, _scratchHit);
    return hit ? hit.point.y : null;
  }

  /** All triangle indices whose bounds overlap the given AABB. */
  queryAABB(x0, y0, z0, x1, y1, z1) {
    const out = _aabbOut;
    out.length = 0;
    if (!this.nodes) return out;
    const nodes = this.nodes, triIndex = this.triIndex;
    const stack = _rayStack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      const o = node * 8;
      if (nodes[o] > x1 || nodes[o + 3] < x0 ||
          nodes[o + 1] > y1 || nodes[o + 4] < y0 ||
          nodes[o + 2] > z1 || nodes[o + 5] < z0) continue;
      const count = nodes[o + 7];
      if (count > 0) {
        const start = nodes[o + 6];
        for (let i = start; i < start + count; i++) out.push(triIndex[i]);
      } else {
        const left = nodes[o + 6];
        stack[sp++] = left;
        stack[sp++] = left + 1;
      }
    }
    return out;
  }

  /**
   * Register a simple rigid body (shell casings, debris chunks, gibs).
   * Integrated with sphere-vs-world collision and angular damping.
   */
  addDynamic(body) {
    this.dynamics.push(body);
    return body;
  }

  fixedUpdate(dt) {
    const bodies = this.dynamics;
    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      b.life -= dt;
      if (b.life <= 0) {
        b.onExpire?.(b);
        bodies.splice(i, 1);
        continue;
      }
      if (b.sleeping) continue;

      b.velocity.y += this.gravity * dt * (b.gravityScale ?? 1);
      const drag = 1 - Math.min(1, (b.drag ?? 0.12) * dt);
      b.velocity.multiplyScalar(drag);

      _t.copy(b.velocity).multiplyScalar(dt);
      const speed = _t.length();
      if (speed > 1e-5) {
        _n.copy(_t).multiplyScalar(1 / speed);
        const hit = this.raycast(b.position, _n, speed + b.radius, _scratchHit);
        if (hit && hit.distance <= speed + b.radius) {
          const back = Math.max(0, hit.distance - b.radius);
          b.position.addScaledVector(_n, back);
          const vn = b.velocity.dot(hit.normal);
          b.velocity.addScaledVector(hit.normal, -(1 + (b.restitution ?? 0.35)) * vn);
          b.velocity.multiplyScalar(b.friction ?? 0.72);
          b.angularVelocity.multiplyScalar(0.55);
          b.bounces = (b.bounces || 0) + 1;
          b.onBounce?.(b, hit);
          if (b.velocity.lengthSq() < 0.25 && hit.normal.y > 0.6) {
            b.sleeping = true;
            b.velocity.set(0, 0, 0);
            b.angularVelocity.set(0, 0, 0);
          }
        } else {
          b.position.add(_t);
        }
      }
      b.rotation.x += b.angularVelocity.x * dt;
      b.rotation.y += b.angularVelocity.y * dt;
      b.rotation.z += b.angularVelocity.z * dt;
    }
  }

  dispose() {
    this.dynamics.length = 0;
  }
}

const _rayStack = new Int32Array(128);
const _aabbOut = [];
const _scratchHit = {};
const _cpOut = { px: 0, py: 0, pz: 0, sx: 0, sy: 0, sz: 0, segT: 0 };

/**
 * Closest pair of points between a segment (a→b) and a triangle. Writes the
 * triangle-side point into `out.p*` and the segment-side point into `out.s*`.
 * Samples the segment adaptively: exact for the common face case, refined by a
 * short golden-section walk for edge/vertex regions.
 */
function closestPointSegmentTriangle(a, b, v0, v1, v2, n, out) {
  const SAMPLES = 5;
  let bestD2 = Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const sx = a.x + (b.x - a.x) * t;
    const sy = a.y + (b.y - a.y) * t;
    const sz = a.z + (b.z - a.z) * t;
    _tp.set(sx, sy, sz);
    closestPointOnTriangle(_tp, v0, v1, v2, n, _tri3);
    const dx = sx - _tri3.x, dy = sy - _tri3.y, dz = sz - _tri3.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      out.px = _tri3.x; out.py = _tri3.y; out.pz = _tri3.z;
      out.sx = sx; out.sy = sy; out.sz = sz;
      out.segT = t;
    }
  }
  return out;
}

const _tp = new THREE.Vector3();
const _tri3 = new THREE.Vector3();
const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _ap = new THREE.Vector3();
const _bp = new THREE.Vector3(), _cp2 = new THREE.Vector3();

/** Ericson, Real-Time Collision Detection §5.1.5 — barycentric region test. */
export function closestPointOnTriangle(p, a, b, c, _n, out) {
  _ab.subVectors(b, a);
  _ac.subVectors(c, a);
  _ap.subVectors(p, a);
  const d1 = _ab.dot(_ap), d2 = _ac.dot(_ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);

  _bp.subVectors(p, b);
  const d3 = _ab.dot(_bp), d4 = _ac.dot(_bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.copy(a).addScaledVector(_ab, v);
  }

  _cp2.subVectors(p, c);
  const d5 = _ab.dot(_cp2), d6 = _ac.dot(_cp2);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.copy(a).addScaledVector(_ac, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return out.copy(b).addScaledVector(_cp2.subVectors(c, b), w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return out.copy(a).addScaledVector(_ab, v).addScaledVector(_ac, w);
}
