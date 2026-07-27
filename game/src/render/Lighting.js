import * as THREE from 'three';

/**
 * The light rig: a cascaded-shadow sun, a sky fill, a slot-based registry for
 * the level's practicals, and a transient pool for muzzle flashes/explosions.
 * Also owns the viewmodel's private three-point rig.
 *
 * CONTRACT:
 *   lighting.sun                       — THREE.DirectionalLight (cascade 0)
 *   lighting.addLocal(light)           — register a level practical
 *   lighting.flash(pos, color, intensity, duration, distance) — light pulse
 *   lighting.update(dt)
 *
 * SHADOWS
 * Three has no built-in CSM for WebGLRenderer, and the shipped `csm` addon
 * needs every material registered by hand (it overwrites onBeforeCompile) and
 * re-runs the whole BRDF once per cascade. Instead we patch
 * `lights_fragment_begin` once, at construction, before anything compiles: the
 * first N directional lights are understood to be one sun sliced into N
 * cascades, so only the cascade containing the fragment is sampled and the
 * lighting equation still runs exactly once. Materials need no registration,
 * which matters because the level's materials are built by another system.
 */

// Per-quality shadow budget. `intervals` is the stagger: cascade i re-renders
// its map every intervals[i] frames. The software rasteriser used by the
// capture harness cannot afford four full depth passes every frame, and distant
// cascades barely change between frames anyway.
const QUALITY = {
  high: {
    cascades: 4,
    mapSizes: [2048, 2048, 1536, 1536],
    intervals: [1, 2, 4, 6],
    shadowDistance: 110,
    localSlots: 4,
    flashSlots: 2,
  },
  medium: {
    cascades: 3,
    mapSizes: [1536, 1024, 1024],
    intervals: [1, 2, 4],
    shadowDistance: 95,
    localSlots: 3,
    flashSlots: 2,
  },
  low: {
    cascades: 3,
    mapSizes: [1024, 768, 512],
    intervals: [1, 3, 6],
    shadowDistance: 70,
    localSlots: 2,
    flashSlots: 1,
  },
};

// Split distribution weight. 0 = uniform (wastes the near cascades), 1 = pure
// logarithmic (starves the far ones). 0.72 puts roughly half the texels inside
// the first 10 m, which is where the player actually looks.
const SPLIT_LAMBDA = 0.72;
// Splits are computed from this rather than camera.near (0.05 m), otherwise the
// logarithmic term collapses the first cascade to centimetres.
const SPLIT_NEAR = 0.9;
// PCF kernel radius in texels, per cascade. Constant in texels means the
// penumbra grows in world units exactly as the cascades grow, so contacts stay
// crisp and distant shadows go soft for free.
const PCF_RADIUS = [1.6, 2.0, 2.4, 2.6];
// Tallest thing that may cast into a cascade, measured vertically. The light's
// back-off distance is this divided by the sun elevation, so a low golden-hour
// sun still catches the tops of the buildings.
const CASTER_HEIGHT = 28;
// Normal-offset bias in texels, per cascade. Cascade 0 is deliberately far
// below one texel: at a 14 m radius on a 1024 map a single texel is 2.8 cm, and
// a contact shadow lives at exactly that scale, so anything approaching a full
// texel of peter-panning erases the darkening where a prop meets the ground.
// The slack is taken back out by the slope-scaled depth bias in the shader.
const NORMAL_BIAS = [0.4, 0.85, 1.15, 1.3];
// Depth-bias multiplier per unit of tan(angle-to-sun). Two texels of extra bias
// at 45 degrees, which is what a five-tap PCF disc needs to stay clean.
const SLOPE_BIAS = 1.9;
// Viewmodel IBL multiplier. See the note where it is applied.
const VIEW_ENV = 0.6;

let _patched = false;

/**
 * Rewrites the directional-light section of `lights_fragment_begin` into a
 * cascade-aware version. The split distances are baked in as literals: they
 * depend only on camera near/far, which never change, so no uniforms and no
 * per-material bookkeeping are needed.
 *
 * The rewritten block is guarded by `NUM_DIR_LIGHT_SHADOWS >= cascades`, so any
 * scene that does not own the cascade rig — the viewmodel scene, for one —
 * still compiles the stock path verbatim.
 *
 * @returns {boolean} false if three's chunk no longer matches, in which case
 *   nothing is patched and the rig degrades to a single-cascade sun.
 */
function patchCascadeShader(count, splits, bands, fadeStart) {
  if (_patched) return true;

  const src = THREE.ShaderChunk.lights_fragment_begin;
  const head = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
  const tail = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
  const a = src.indexOf(head);
  const b = src.indexOf(tail);
  if (a < 0 || b <= a) {
    console.warn('Lighting: lights_fragment_begin layout changed, CSM disabled');
    return false;
  }
  const stock = src.slice(a, b);

  const f = (x) => (Number.isInteger(x) ? `${x}.0` : x.toFixed(5));
  // Depth bias is scaled per fragment by the surface slope relative to the sun
  // (see `csmBiasScale` below), so what the uniform carries is the flat-on case.
  const sample = (i) => `getShadow( directionalShadowMap[ ${i} ], `
    + `directionalLightShadows[ ${i} ].shadowMapSize, `
    + `directionalLightShadows[ ${i} ].shadowIntensity, `
    + `directionalLightShadows[ ${i} ].shadowBias * csmBiasScale, `
    + `directionalLightShadows[ ${i} ].shadowRadius, `
    + `vDirectionalShadowCoord[ ${i} ] )`;

  // One if/else chain over view depth. Inside a blend band both neighbouring
  // cascades are sampled and lerped, which is what makes the resolution step
  // across a cascade boundary invisible; everywhere else exactly one cascade is
  // touched, so N cascades cost the same as one.
  let chain = '';
  for (let i = 0; i < count; i++) {
    const far = splits[i];
    if (i < count - 1) {
      const inner = far - bands[i];
      chain += `\t\t\tif ( csmViewZ < ${f(inner)} ) {\n\t\t\t\tcsmShadow = ${sample(i)};\n\t\t\t} else if ( csmViewZ < ${f(far)} ) {\n`
        + `\t\t\t\tcsmShadow = mix( ${sample(i)}, ${sample(i + 1)}, ( csmViewZ - ${f(inner)} ) * ${f(1 / bands[i])} );\n\t\t\t} else `;
    } else {
      // Last cascade dissolves its shadow into full light before the cut-off so
      // the end of the shadow distance is not a visible line on the ground.
      chain += `if ( csmViewZ < ${f(far)} ) {\n\t\t\t\tcsmShadow = mix( ${sample(i)}, 1.0, smoothstep( ${f(fadeStart)}, ${f(far)}, csmViewZ ) );\n\t\t\t}\n`;
    }
  }

  const csm = /* glsl */`
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS >= ${count} )

	// --- Cascaded shadow maps ------------------------------------------------
	// Directional lights 0..${count - 1} are one sun; only their shadow maps differ.
	DirectionalLight directionalLight;
	float csmViewZ = vViewPosition.z; // positive distance from the eye
	float csmShadow = 1.0;

	// Slope-scaled depth bias. Acne is a function of how much the light-space
	// depth changes across one shadow texel, which is proportional to tan of the
	// angle between the surface and the sun. Covering the worst case with a
	// constant normal offset instead means every surface pays the steep-slope
	// bias, and an offset that large lifts the shadow clear of the base of every
	// object standing on flat ground — the "sticker on the road" look. Here the
	// normal offset is cut to a fraction of a texel and the grazing case is paid
	// for only by the fragments that actually graze.
	float csmNdotL = saturate( dot( geometryNormal, directionalLights[ 0 ].direction ) );
	float csmBiasScale = 1.0 + min( sqrt( 1.0 - csmNdotL * csmNdotL ) / max( csmNdotL, 0.08 ), 9.0 ) * ${f(SLOPE_BIAS)};

	if ( receiveShadow ) {

${chain}
	}

	directionalLight = directionalLights[ 0 ];
	getDirectionalLightInfo( directionalLight, directLight );
	directLight.color *= csmShadow;
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	#if ( NUM_DIR_LIGHTS > ${count} )

		// Any directional light beyond the cascade block is an ordinary
		// unshadowed fill and is evaluated normally.
		#pragma unroll_loop_start
		for ( int i = ${count}; i < NUM_DIR_LIGHTS; i ++ ) {

			directionalLight = directionalLights[ i ];
			getDirectionalLightInfo( directionalLight, directLight );
			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		}
		#pragma unroll_loop_end

	#endif

#else

${stock}
#endif

`;

  THREE.ShaderChunk.lights_fragment_begin = src.slice(0, a) + csm + src.slice(b);
  _patched = true;
  return true;
}

/** Practical split scheme (Nvidia's PSSM): lerp of uniform and logarithmic. */
function practicalSplits(count, near, far, lambda) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const uni = near + (far - near) * (i / count);
    const log = near * (far / near) ** (i / count);
    out.push(THREE.MathUtils.lerp(uni, log, lambda));
  }
  out[count - 1] = far;
  return out;
}

export class Lighting {
  constructor(engine, sky) {
    this.engine = engine;
    this.sky = sky;

    const q = QUALITY[engine.quality] || QUALITY.high;
    this.quality = q;

    // r0.185 dropped PCFSoftShadowMap; anything that is not PCF or VSM silently
    // compiles down to SHADOWMAP_TYPE_BASIC, i.e. a single unfiltered tap and
    // stair-stepped shadow edges. PCF is the hardware-compare path: five Vogel
    // disc taps, each a bilinear 2x2 compare, for twenty effective samples.
    engine.renderer.shadowMap.type = THREE.PCFShadowMap;
    engine.renderer.shadowMap.enabled = true;

    const cam = engine.camera;
    this.shadowDistance = Math.min(q.shadowDistance, cam.far);
    this.splits = practicalSplits(q.cascades, SPLIT_NEAR, this.shadowDistance, SPLIT_LAMBDA);
    // Blend band in front of each split. Proportional to the split distance so
    // the transition is a roughly constant fraction of the screen.
    this.bands = this.splits.map((s) => Math.max(0.8, s * 0.14));
    this.csm = patchCascadeShader(
      q.cascades, this.splits, this.bands, this.shadowDistance * 0.82,
    );

    this._lightBasis = new THREE.Matrix4();
    this._lightBasisInv = new THREE.Matrix4();
    this._lastSunDir = new THREE.Vector3(0, -1, 0);

    this.cascades = [];
    const cascadeCount = this.csm ? q.cascades : 1;
    for (let i = 0; i < cascadeCount; i++) {
      const light = new THREE.DirectionalLight(sky.sunColor.clone(), i === 0 ? 3.4 : 0);
      light.castShadow = true;
      const size = q.mapSizes[i];
      light.shadow.mapSize.set(size, size);
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 400;
      light.shadow.radius = PCF_RADIUS[Math.min(i, PCF_RADIUS.length - 1)];
      // Driven by hand so distant cascades can be staggered across frames.
      light.shadow.autoUpdate = false;
      light.shadow.needsUpdate = true;
      light.matrixAutoUpdate = true;
      engine.scene.add(light);
      engine.scene.add(light.target);
      this.cascades.push({
        light,
        size,
        near: i === 0 ? cam.near : this.splits[i - 1] - this.bands[i - 1],
        far: this.splits[i],
        interval: q.intervals[i],
        phase: i, // de-phase so two cascades never re-render on the same frame
        center: new THREE.Vector3(),
        committed: new THREE.Vector3(),
        radius: 0,
        slack: 0,
      });
    }
    // Cascade 0 is the light the rest of the game means when it says "the sun":
    // it carries the sun's colour and intensity for every fragment.
    this.sun = this.cascades[0].light;

    // Sky fill. The PMREM environment already supplies most of the indirect
    // term, so this is deliberately weak — it only keeps shadowed geometry from
    // going to a flat, ambient-occluded black and adds the warm bounce coming
    // back up off the asphalt.
    this.hemi = new THREE.HemisphereLight(
      sky.ambientColor.clone(), new THREE.Color(0.13, 0.115, 0.10),
      sky.ambientIntensity ?? 0.55,
    );
    engine.scene.add(this.hemi);

    // Ground bounce. A HemisphereLight's ground colour is unreachable for a
    // floor: the weight is `0.5 * dot(N, up) + 0.5`, so a horizontal surface
    // takes 100% of the *sky* colour and none of the ground's. The road in
    // shadow therefore ends up carrying the sky's chromaticity neat, which on a
    // clear day is a strong cyan, and the whole lower half of the frame goes
    // blue. This second hemisphere is inverted — its position is below the
    // origin, so its "ground" half faces upwards — which puts the warm light
    // coming back off sunlit asphalt exactly on the horizontal surfaces that
    // could never see it, and half of it on the walls, which is about right.
    this.bounce = new THREE.HemisphereLight(0x000000, 0xffffff, 0);
    this.bounce.position.set(0, -1, 0);
    engine.scene.add(this.bounce);

    // --- viewmodel rig ------------------------------------------------------
    // Viewmodel geometry is small and nearly edge-on to the camera, so a
    // world-calibrated sun leaves the weapon a black silhouette. This rig is
    // brighter than the world on purpose and is intensity-linked to the sky so
    // the weapon still reads as being in the same place as the level.
    this.viewKey = new THREE.DirectionalLight(0xfff2df, 3.4);
    this.viewKey.position.set(-0.7, 1.0, 0.9);
    engine.viewScene.add(this.viewKey);
    this.viewKey.target.position.set(0, 0, -1);
    engine.viewScene.add(this.viewKey.target);

    // Rim from high behind-right separates the barrel from the background. It
    // used to sit nearly level with the camera, which put its specular lobe
    // straight down the barrel and blew out the rubber butt pad; lifting it
    // keeps the edge without the hot spot. It carries most of the separation now
    // that the fill has been cut, so it runs well above unity and cold.
    this.viewRim = new THREE.DirectionalLight(0x86aae6, 1.3);
    this.viewRim.position.set(0.85, 1.15, -0.75);
    engine.viewScene.add(this.viewRim);

    // Warm bounce from below-front, standing in for light coming back off the
    // ground. Fills the underside of the receiver so it does not read as a hole.
    this.viewBounce = new THREE.DirectionalLight(0xffd7ad, 0.5);
    this.viewBounce.position.set(-0.35, -1.0, 0.45);
    engine.viewScene.add(this.viewBounce);

    // Kept deliberately weak. This is ambient occlusion's opposite number: any
    // more of it and the key stops modelling and starts competing.
    this.viewFill = new THREE.HemisphereLight(0x9fb6d0, 0x2a2622, 0.6);
    engine.viewScene.add(this.viewFill);

    // Sky.js hands the viewmodel scene the same PMREM probe the world uses,
    // which is a fifth broad unshadowed source on a model that is only 40 cm
    // deep — and the one no amount of tuning the four lights above can
    // counteract. It is dialled back rather than removed because the specular
    // half of it is what puts the sheen on the receiver and the optic body.
    engine.viewScene.environmentIntensity = VIEW_ENV;

    // Muzzle flashes have to light the weapon too, and the viewmodel lives in
    // its own scene, so it needs its own copy of the flash.
    this.viewFlash = new THREE.PointLight(0xffd9a0, 0, 3.2, 2);
    this.viewFlash.position.set(0.12, -0.06, -0.55);
    engine.viewScene.add(this.viewFlash);
    this._viewFlash = null;

    // --- local lights -------------------------------------------------------
    // Registered practicals are proxied through a fixed pool of point lights.
    // The pool size is fixed because the number of *visible* lights is part of
    // three's program cache key: switching a light on or off would recompile
    // every material in the scene, which on a software rasteriser is a stall
    // measured in seconds.
    this.locals = [];
    this.slots = [];
    for (let i = 0; i < q.localSlots; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 24, 2);
      l.castShadow = false;
      engine.scene.add(l);
      this.slots.push({ light: l, source: null, level: 0 });
    }

    this.flashes = [];
    this._flashSlots = [];
    for (let i = 0; i < q.flashSlots; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 2);
      l.castShadow = false;
      engine.scene.add(l);
      this._flashSlots.push(l);
    }
    this.maxFlashes = q.flashSlots;

    this._sortTimer = 0;
    this._forceCascades = true;
  }

  /**
   * Register a level practical. Point lights are held in the registry and
   * rendered through the slot pool (nearest-N), so a level may add far more of
   * them than the shader could ever hold. Anything else is left alone.
   */
  addLocal(light) {
    this.engine.scene.add(light);
    if (light.isPointLight) {
      light.decay = 2; // inverse-square, always
      if (!light.distance) light.distance = 26;
      light.visible = false; // proxied; see the slot pool
      light.castShadow = false;
      this.locals.push(light);
      this._sortTimer = 0;
    }
    return light;
  }

  /**
   * Transient point light — muzzle flash, explosion, sparks. Real flashes have
   * an almost instant rise and an exponential fall, and are bright enough at
   * peak to read as white before settling into their own colour.
   */
  flash(position, color, intensity, duration = 0.06, distance = 22) {
    const attack = duration * 0.07;
    const decay = duration * 0.34;
    // Normalise so the envelope peaks at exactly `intensity`.
    const tPeak = attack * Math.log(1 + decay / attack);
    const peak = (1 - Math.exp(-tPeak / attack)) * Math.exp(-tPeak / decay);

    let slot = this._flashSlots.pop();
    if (!slot) {
      // Pool exhausted: steal the oldest flash rather than allocate, which
      // would change the light count and recompile the world.
      const old = this.flashes.shift();
      if (this._viewFlash === old) this._viewFlash = null;
      slot = old.light;
    }
    slot.color.set(color);
    slot.distance = distance;
    slot.intensity = 0;
    slot.position.copy(position);

    const f = {
      light: slot, t: 0, duration, intensity, attack, decay,
      norm: peak > 1e-4 ? 1 / peak : 1,
      base: new THREE.Color(color),
    };
    this.flashes.push(f);

    // Anything going off in the player's hands lights the viewmodel too.
    if (position.distanceToSquared(this.engine.camera.position) < 9) {
      this.viewFlash.color.set(color);
      this._viewFlash = f;
    }
    return slot;
  }

  update(dt) {
    const sky = this.sky;
    this.sun.color.copy(sky.sunColor);
    // Magnitude from the sky as well, not just chromaticity. A constant key
    // against a sky-derived fill is what collapsed the direct:indirect ratio to
    // 1.17:1 and left nothing in the frame casting a readable shadow.
    if (sky.sunIntensity !== undefined) this.sun.intensity = sky.sunIntensity;
    this.hemi.color.copy(sky.ambientColor);
    // Magnitude has to come from the sky's published intensity, not a constant.
    // ambientColor is clamped into gamut, so a fixed intensity calibrated when
    // that colour still carried raw radiance leaves the fill ~20x too weak and
    // crushes every shadowed surface to black.
    const amb = sky.ambientIntensity ?? this.hemi.intensity;
    if (sky.ambientIntensity !== undefined) this.hemi.intensity = sky.ambientIntensity;

    // Warm bounce off the ground. Chromaticity is the sun through one reflection
    // off warm grey asphalt, normalised to unit maximum so the magnitude stays
    // where it belongs — on the sky's published ambient level, scaled by how
    // much sun there is to bounce in the first place.
    _bounce.copy(sky.sunColor).lerp(_asphaltBounce, 0.72);
    const peak = Math.max(_bounce.r, _bounce.g, _bounce.b, 1e-4);
    this.bounce.groundColor.copy(_bounce).multiplyScalar(1 / peak);
    const sun = THREE.MathUtils.clamp(sky.sunDirection.y * 2.2, 0, 1);
    this.bounce.intensity = amb * (0.24 + 0.58 * sun);

    this._updateCascades();
    this._updateLocals(dt);
    this._updateFlashes(dt);
    this._updateViewRig();
  }

  // --- cascaded shadow maps -------------------------------------------------

  /**
   * Re-fits every cascade to its slice of the view frustum.
   *
   * Two things keep the edges from crawling. The cascade is fitted to the
   * *bounding sphere* of its frustum slice, which is invariant under camera
   * rotation, so turning on the spot cannot change the projection; and the
   * sphere centre is snapped to the shadow map's own texel grid in light space,
   * so translating the camera moves the projection in whole-texel steps.
   */
  _updateCascades() {
    const cam = this.engine.camera;
    const sunDir = this.sky.sunDirection;
    cam.updateMatrixWorld();

    if (sunDir.dot(this._lastSunDir) < 0.999999) {
      // The light basis is the frame the texel snap happens in, so it must only
      // be rebuilt when the sun genuinely moves.
      const up = Math.abs(sunDir.y) > 0.99 ? _up2 : _up;
      _v.copy(sunDir).negate();
      this._lightBasis.lookAt(_zero, _v, up);
      this._lightBasisInv.copy(this._lightBasis).transpose();
      this._lastSunDir.copy(sunDir);
      this._forceCascades = true;
    }

    // How far behind the cascade the light has to sit to catch every caster.
    const back = CASTER_HEIGHT / Math.max(0.14, sunDir.y);
    const frame = this.engine.frame;

    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const k2 = tanH * tanH * (1 + cam.aspect * cam.aspect);

    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      const near = c.near;
      const far = this.csm ? c.far : this.shadowDistance;

      // Bounding sphere of the frustum slice, analytically. When the slice is
      // short and wide the sphere sits on the far plane; otherwise it sits
      // between the planes.
      let centerZ; let radius;
      if (k2 >= (far - near) / (far + near)) {
        centerZ = far;
        radius = far * Math.sqrt(k2);
      } else {
        centerZ = 0.5 * (far + near) * (1 + k2);
        radius = 0.5 * Math.sqrt(
          (far - near) * (far - near)
          + 2 * (far * far + near * near) * k2
          + (far + near) * (far + near) * k2 * k2,
        );
      }
      // Quantise the radius so a nudge of the FOV (ADS, pose changes) cannot
      // rescale the projection by a fraction of a texel every frame.
      radius = Math.ceil(radius * 4) / 4;
      c.center.copy(cam.position).addScaledVector(_fwd, centerZ);

      // Staggered cascades are padded, so they stay valid while stale; if the
      // camera outruns the padding the cascade is refreshed early anyway.
      const due = this._forceCascades
        || c.interval === 1
        || (frame + c.phase) % c.interval === 0
        || radius !== c.radius
        || c.center.distanceToSquared(c.committed) > c.slack * c.slack;

      if (!due) {
        c.light.shadow.needsUpdate = false;
        continue;
      }

      c.radius = radius;
      c.slack = (c.interval - 1) * 0.5;
      const pad = radius + c.slack;

      // Snap the centre to the shadow texel grid, in light space.
      const texel = (2 * pad) / c.size;
      _v.copy(c.center).applyMatrix4(this._lightBasisInv);
      _v.x = Math.round(_v.x / texel) * texel;
      _v.y = Math.round(_v.y / texel) * texel;
      _v.applyMatrix4(this._lightBasis);
      c.committed.copy(c.center);

      const shadow = c.light.shadow;
      const scam = shadow.camera;
      scam.left = -pad; scam.right = pad;
      scam.top = pad; scam.bottom = -pad;
      scam.near = 0.5;
      scam.far = back + 2 * pad;
      scam.updateProjectionMatrix();

      c.light.position.copy(_v).addScaledVector(sunDir, back + pad);
      c.light.target.position.copy(_v);
      c.light.target.updateMatrixWorld();

      // Bias. The normal offset is kept well under one texel in the near
      // cascade so that contact shadows survive; acne is handled by the
      // slope-scaled depth bias applied in the patched shader, which costs the
      // flat-lit surfaces almost nothing. Both terms are expressed in world
      // units first, so they scale themselves per cascade.
      const texelWorld = (2 * pad) / c.size;
      shadow.normalBias = texelWorld * NORMAL_BIAS[Math.min(i, NORMAL_BIAS.length - 1)];
      shadow.bias = -texelWorld * 0.55 / (scam.far - scam.near);
      shadow.needsUpdate = true;
    }
    this._forceCascades = false;
  }

  // --- local lights ---------------------------------------------------------

  /** Bind the nearest registered practicals to the fixed pool of point lights. */
  _updateLocals(dt) {
    if (!this.slots.length) return;
    const cam = this.engine.camera;

    this._sortTimer -= dt;
    if (this._sortTimer <= 0 && this.locals.length) {
      this._sortTimer = 0.12;
      // Rank by how much of this light actually reaches the camera: a bright
      // street lamp 30 m away beats a candle at 8 m.
      for (const l of this.locals) {
        const d = Math.max(0.5, l.position.distanceTo(cam.position));
        l.userData._score = d > l.distance + 2 ? -1 : l.intensity / (d * d);
      }
      _rank.length = 0;
      for (const l of this.locals) if (l.userData._score > 0) _rank.push(l);
      _rank.sort((a, b) => b.userData._score - a.userData._score);
      for (let i = 0; i < this.slots.length; i++) {
        this.slots[i].source = _rank[i] || null;
      }
    }

    for (const slot of this.slots) {
      const src = slot.source;
      let target = 0;
      if (src) {
        slot.light.position.copy(src.position);
        slot.light.distance = src.distance;
        slot.light.color.copy(src.color);
        target = src.intensity;
        // Fires and failing tubes ask for it by tagging themselves.
        const fl = src.userData.flicker;
        if (fl) {
          const t = this.engine.elapsed * 11 + src.id * 1.7;
          target *= 1 - fl * (0.5 + 0.5 * Math.sin(t) * Math.sin(t * 2.13 + 1.1));
        }
      }
      // Cross-fade on hand-over so a practical swapping slots does not pop.
      slot.level += (target - slot.level) * Math.min(1, dt * 9);
      slot.light.intensity = slot.level < 0.01 ? 0 : slot.level;
    }
  }

  // --- transient flashes ----------------------------------------------------

  _updateFlashes(dt) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      if (f.t >= f.duration) {
        f.light.intensity = 0;
        this._flashSlots.push(f.light);
        this.flashes.splice(i, 1);
        if (this._viewFlash === f) this._viewFlash = null;
        continue;
      }
      const env = (1 - Math.exp(-f.t / f.attack)) * Math.exp(-f.t / f.decay) * f.norm;
      f.light.intensity = f.intensity * env;
      // A flash bright enough to matter reads white at its core and falls back
      // to its own colour temperature as it dies.
      f.light.color.copy(f.base).lerp(_white, 0.45 * Math.min(1, env * 1.3));
    }

    const vf = this._viewFlash;
    if (vf) {
      const env = (1 - Math.exp(-vf.t / vf.attack)) * Math.exp(-vf.t / vf.decay) * vf.norm;
      this.viewFlash.intensity = Math.min(vf.intensity, 30) * env * 0.06;
      this.viewFlash.color.copy(vf.base).lerp(_white, 0.5 * Math.min(1, env * 1.3));
    } else if (this.viewFlash.intensity !== 0) {
      this.viewFlash.intensity = 0;
    }
  }

  // --- viewmodel ------------------------------------------------------------

  _updateViewRig() {
    const sky = this.sky;
    const cam = this.engine.camera;

    // Swing the key to follow the world sun so the weapon's shading agrees with
    // the scene, but never let it fall below the horizon of the view space: a
    // gun lit from behind is a silhouette, and this rig exists to prevent that.
    _q.copy(cam.quaternion).invert();
    _sunView.copy(sky.sunDirection).applyQuaternion(_q);
    this.viewKey.position.set(
      _sunView.x * 0.85 - 0.30,
      Math.max(0.45, _sunView.y),
      _sunView.z * 0.7 + 0.60,
    );
    this.viewKey.color.copy(sky.sunColor);
    // Track the sky's own level so the weapon dims at dusk instead of staying
    // stuck at noon exposure, but hold a floor so it never goes to silhouette.
    const day = THREE.MathUtils.clamp(sky.sunDirection.y * 1.6, 0, 1);
    this.viewKey.intensity = 2.4 + day * 2.0;
    // Re-asserted every frame: Sky.js reassigns viewScene.environment on every
    // probe re-bake, and a future change there could reset the multiplier.
    this.engine.viewScene.environmentIntensity = VIEW_ENV;
    // Four broad lights with no shadowing flat-fill the model and erase every
    // form-defining crease, and the weapon ends up one smooth brown lump. The
    // fill is therefore cut to roughly a third of what it was: the key does the
    // modelling, and what is left of the fill only keeps the shadow side off
    // black. The rim is the other half of the fix — at 0.55 it could not
    // separate the barrel from the background at all.
    this.viewFill.color.copy(sky.ambientColor);
    this.viewFill.intensity = 0.42 + day * 0.24;
    this.viewRim.color.copy(sky.ambientColor).lerp(_coolRim, 0.55);
    this.viewRim.intensity = 1.30 + day * 0.55;
    this.viewBounce.color.copy(sky.ambientColor).lerp(_warmBounce, 0.62);
    this.viewBounce.intensity = 0.34 + day * 0.16;
  }

  dispose() {
    for (const c of this.cascades) c.light.shadow.dispose?.();
  }
}

const _fwd = new THREE.Vector3();
const _v = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _up2 = new THREE.Vector3(0, 0, 1);
const _sunView = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _white = new THREE.Color(1, 1, 1);
const _warmBounce = new THREE.Color(1.0, 0.72, 0.45);
// Sun through one bounce off warm grey asphalt.
const _asphaltBounce = new THREE.Color(1.0, 0.63, 0.36);
const _bounce = new THREE.Color();
// Deep sky, well past the ambient chromaticity: the rim only has to say "not
// the same light as the key", and a cold edge is what sells a barrel against a
// warm-lit background.
const _coolRim = new THREE.Color(0.34, 0.55, 1.0);
const _rank = [];
