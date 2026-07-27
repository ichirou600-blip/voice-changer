import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

/**
 * The frame graph.
 *
 * Layout of a frame, in order — every stage consumes the one above it:
 *
 *   1. WorldPass      world + viewmodel -> rtScene           (HDR, linear)
 *   2. GBufferPass    view normal + linear depth + velocity  (MRT, 8-bit packed)
 *   3a. GTAO          half-res horizon AO -> bilateral blur
 *   3b. Contact       full-res short-range obscurance + sun-direction shadow ray
 *       -> both multiplied into rtScene by one apply pass
 *   4. TAA            jittered accumulation, velocity reprojection, neighbourhood clip
 *   5. Motion blur    velocity-buffer directional reconstruction
 *   6. Depth of field autofocus on the crosshair, half-res golden-angle bokeh
 *   7. Bloom          threshold + multi-mip down/upsample pyramid
 *   8. Grade          lens distortion, CA, tonemap, 3D LUT, LGG, grain, vignette
 *
 * Antialiasing deliberately happens at step 4, before anything that amplifies
 * high frequencies (motion blur, bokeh, chromatic aberration, sharpening).
 * Running those on a raw aliased image is what produces rainbow speckle on
 * fine geometry like the weapon's rail teeth.
 *
 * CONTRACT:
 *   pipeline.render(dt)
 *   pipeline.resize(w,h)
 *   pipeline.setParam(name, value)   — exposed to the settings menu
 *   pipeline.params                  — live tunables
 */

/** Per-tier cost knobs. Everything visual stays on; only sample counts drop. */
const TIERS = {
  low: {
    aa: 'smaa', aoScale: 0.5, aoDirs: 2, aoSteps: 3, aoBlur: 1, contactTaps: 8, raySteps: 8,
    motionBlur: false, motionSamples: 6, dof: false, dofTaps: 8,
    bloomMips: 4, historyFilter: 0,
  },
  medium: {
    aa: 'taa', aoScale: 0.5, aoDirs: 2, aoSteps: 5, aoBlur: 2, contactTaps: 10, raySteps: 10,
    motionBlur: true, motionSamples: 8, dof: true, dofTaps: 12,
    bloomMips: 5, historyFilter: 1,
  },
  high: {
    aa: 'taa', aoScale: 0.5, aoDirs: 3, aoSteps: 6, aoBlur: 2, contactTaps: 12, raySteps: 12,
    motionBlur: true, motionSamples: 12, dof: true, dofTaps: 20,
    bloomMips: 6, historyFilter: 1,
  },
};

/** Depth is packed against this range, shared by both cameras. */
const DEPTH_FAR = 2000.0;
/** Largest per-frame screen motion the velocity buffer can represent, in uv. */
const VELOCITY_MAX = 0.5;

/** Renders world + viewmodel into the pipeline's HDR target. */
class WorldPass extends Pass {
  constructor(engine) {
    super();
    this.engine = engine;
    this.needsSwap = false;
    this.clear = true;
  }

  render(renderer, writeBuffer, readBuffer) {
    const e = this.engine;
    const target = this.renderToScreen ? null : readBuffer;
    const prevAutoClear = renderer.autoClear;
    // autoClear must be off: the second render() would otherwise wipe the world
    // we just drew and leave only the viewmodel on a black frame.
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    renderer.render(e.scene, e.camera);
    // Viewmodel: separate scene + camera, depth cleared so it always wins.
    renderer.clearDepth();
    renderer.render(e.viewScene, e.viewCamera);
    renderer.autoClear = prevAutoClear;
  }
}

/* ------------------------------------------------------------------ */
/* Shared GLSL                                                         */
/* ------------------------------------------------------------------ */

/**
 * G-buffer codec. Everything is 8-bit RGBA so the pipeline never depends on
 * float render targets being real (see probeHalfFloat).
 *   .rg = octahedral view normal
 *   .ba = 16-bit sqrt-encoded linear view depth
 * sqrt encoding spends its precision near the eye, where AO and DOF need it:
 * at 10 m a step is ~4 mm, at 0.3 m (the viewmodel) it is under a millimetre.
 */
const GLSL_CODEC = /* glsl */`
  #define sat01(x) clamp(x, 0.0, 1.0)

  vec2 packUnit(float v) {
    v = clamp(v, 0.0, 0.9999847);
    float hi = floor(v * 255.0) / 255.0;
    return vec2(hi, (v - hi) * 255.0);
  }
  float unpackUnit(vec2 e) { return e.x + e.y / 255.0; }

  vec2 octEncode(vec3 n) {
    n /= (abs(n.x) + abs(n.y) + abs(n.z));
    vec2 e = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
    return e * 0.5 + 0.5;
  }
  vec3 octDecode(vec2 f) {
    f = f * 2.0 - 1.0;
    vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
    float t = max(-n.z, 0.0);
    n.x += n.x >= 0.0 ? -t : t;
    n.y += n.y >= 0.0 ? -t : t;
    return normalize(n);
  }
`;

/** Decoders used by every consumer of the g-buffer / velocity targets. */
const GLSL_GBUFFER = /* glsl */`
  ${GLSL_CODEC}
  uniform sampler2D tGBuffer;
  uniform sampler2D tVelocity;
  uniform vec2 uProjInfo;   // tan(fovX/2), tan(fovY/2) of the world camera

  float gbufDepth(vec2 uv) {
    float d = unpackUnit(texture2D(tGBuffer, uv).ba);
    return d * d * ${DEPTH_FAR.toFixed(1)};
  }
  vec3 gbufNormal(vec2 uv) { return octDecode(texture2D(tGBuffer, uv).rg); }
  bool isSky(float z) { return z >= ${(DEPTH_FAR * 0.99).toFixed(1)}; }

  // View-space position from uv + linear depth. The viewmodel is rendered with
  // a narrower camera, so its rays are reconstructed slightly wide; the error is
  // a uniform scale on a 0.3 m object and never shows.
  vec3 viewPos(vec2 uv, float z) {
    return vec3((uv * 2.0 - 1.0) * uProjInfo * z, -z);
  }

  vec2 readVelocity(vec2 uv) {
    vec4 v = texture2D(tVelocity, uv);
    return vec2(unpackUnit(v.rg), unpackUnit(v.ba)) * (2.0 * ${VELOCITY_MAX.toFixed(3)})
         - ${VELOCITY_MAX.toFixed(3)};
  }
`;

const GLSL_FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/** Interleaved gradient noise, offset per frame so TAA integrates the samples. */
const GLSL_IGN = /* glsl */`
  float ign(vec2 p, float frame) {
    p += 5.588238 * mod(frame, 64.0);
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }
`;

/* ------------------------------------------------------------------ */
/* G-buffer prepass                                                    */
/* ------------------------------------------------------------------ */

/**
 * Second geometry pass producing view normals, linear depth and a full motion
 * vector per pixel. It runs with the same jittered projection as the colour
 * pass so screen-space effects line up exactly with the image they modify.
 *
 * Velocity is written by the object shader rather than reconstructed from depth
 * because the viewmodel lives in its own scene with a camera that does not
 * follow the player — depth reprojection through the world camera would smear
 * the weapon across the screen on every turn.
 */
class GBufferPass {
  constructor(engine) {
    this.engine = engine;
    this._prev = new WeakMap();   // object -> { m: Matrix4, frame: number }
    this._frame = 0;
    this._skipped = [];

    const shared = {
      uCurVP: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uPrevModel: { value: new THREE.Matrix4() },
    };

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: shared,
      vertexShader: /* glsl */`
        uniform mat4 uCurVP;
        uniform mat4 uPrevVP;
        uniform mat4 uPrevModel;
        out vec3 vNormalView;
        out float vDepth;
        out vec4 vCurClip;
        out vec4 vPrevClip;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vec4 view = viewMatrix * world;
          vNormalView = normalMatrix * normal;
          vDepth = -view.z;
          // Jitter-free clip positions: the TAA jitter must not leak into motion
          // vectors or every static pixel would report half a pixel of movement.
          vCurClip = uCurVP * world;
          vPrevClip = uPrevVP * (uPrevModel * vec4(position, 1.0));
          gl_Position = projectionMatrix * view;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        ${GLSL_CODEC}
        in vec3 vNormalView;
        in float vDepth;
        in vec4 vCurClip;
        in vec4 vPrevClip;
        layout(location = 0) out vec4 oGBuffer;
        layout(location = 1) out vec4 oVelocity;
        void main() {
          vec3 n = normalize(vNormalView);
          if (!gl_FrontFacing) n = -n;
          float d = sqrt(sat01(vDepth * ${(1 / DEPTH_FAR).toExponential()}));
          oGBuffer = vec4(octEncode(n), packUnit(d));

          vec2 cur = vCurClip.xy / vCurClip.w;
          vec2 prev = vPrevClip.xy / vPrevClip.w;
          vec2 vel = (cur - prev) * 0.5;           // ndc delta -> uv delta
          vel = clamp(vel / ${VELOCITY_MAX.toFixed(3)}, -1.0, 1.0) * 0.5 + 0.5;
          oVelocity = vec4(packUnit(vel.x), packUnit(vel.y));
        }`,
    });

    // Per-object previous world matrix. Uniforms are re-uploaded per draw only
    // when the material is flagged dirty, so we do that from inside the hook.
    this.material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const u = this.material.uniforms.uPrevModel.value;
      let rec = this._prev.get(object);
      if (rec && rec.frame === this._frame - 1) u.copy(rec.m);
      else u.copy(object.matrixWorld);           // first sight: no motion vector
      if (!rec) { rec = { m: new THREE.Matrix4(), frame: 0 }; this._prev.set(object, rec); }
      rec.m.copy(object.matrixWorld);
      rec.frame = this._frame;
      this.material.uniformsNeedUpdate = true;
    };

    this.skyMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uProjInv: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCurVP: { value: new THREE.Matrix4() },
        uPrevVP: { value: new THREE.Matrix4() },
      },
      vertexShader: /* glsl */`
        out vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        ${GLSL_CODEC}
        uniform mat4 uProjInv, uCamWorld, uCurVP, uPrevVP;
        in vec2 vUv;
        layout(location = 0) out vec4 oGBuffer;
        layout(location = 1) out vec4 oVelocity;
        void main() {
          // Sky sits at infinity: only camera rotation moves it, which falls out
          // of transforming the view ray as a direction (w = 0).
          vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec3 dirView = (uProjInv * ndc).xyz;
          vec3 dirWorld = mat3(uCamWorld) * dirView;
          vec4 c = uCurVP * vec4(dirWorld, 0.0);
          vec4 p = uPrevVP * vec4(dirWorld, 0.0);
          vec2 vel = (c.xy / c.w - p.xy / p.w) * 0.5;
          vel = clamp(vel / ${VELOCITY_MAX.toFixed(3)}, -1.0, 1.0) * 0.5 + 0.5;
          oGBuffer = vec4(octEncode(vec3(0.0, 0.0, 1.0)), packUnit(1.0));
          oVelocity = vec4(packUnit(vel.x), packUnit(vel.y));
        }`,
    });
    this.skyQuad = new FullScreenQuad(this.skyMaterial);
  }

  /** Objects that do not belong in a depth/normal buffer: glass, decals, FX. */
  _hideNonOpaque(scene, list) {
    scene.traverse((o) => {
      if (!o.visible || !o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && (m.transparent === true || m.depthWrite === false)) { list.push(o); return; }
      }
    });
  }

  render(renderer, target, matrices) {
    const e = this.engine;
    this._frame++;

    this._skipped.length = 0;
    this._hideNonOpaque(e.scene, this._skipped);
    this._hideNonOpaque(e.viewScene, this._skipped);
    for (const o of this._skipped) o.visible = false;

    const prevAutoClear = renderer.autoClear;
    const prevOverride = e.scene.overrideMaterial;
    const prevViewOverride = e.viewScene.overrideMaterial;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    // The colour pass already refreshed the shadow maps this frame and the
    // override material never samples them; re-rendering every cascade here
    // would double the shadow cost for nothing.
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.clear(false, true, false);

    // Fill both attachments with sky before any geometry; a single MRT clear
    // cannot give the two targets different values.
    const su = this.skyMaterial.uniforms;
    su.uProjInv.value.copy(e.camera.projectionMatrixInverse);
    su.uCamWorld.value.copy(e.camera.matrixWorld);
    su.uCurVP.value.copy(matrices.curVP);
    su.uPrevVP.value.copy(matrices.prevVP);
    this.skyQuad.render(renderer);

    const mu = this.material.uniforms;
    mu.uCurVP.value.copy(matrices.curVP);
    mu.uPrevVP.value.copy(matrices.prevVP);
    e.scene.overrideMaterial = this.material;
    renderer.render(e.scene, e.camera);

    renderer.clearDepth();
    mu.uCurVP.value.copy(matrices.curVPView);
    mu.uPrevVP.value.copy(matrices.prevVPView);
    e.viewScene.overrideMaterial = this.material;
    renderer.render(e.viewScene, e.viewCamera);

    e.scene.overrideMaterial = prevOverride;
    e.viewScene.overrideMaterial = prevViewOverride;
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    for (const o of this._skipped) o.visible = true;
    this._skipped.length = 0;
  }

  dispose() {
    this.material.dispose();
    this.skyMaterial.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

/**
 * Ground-truth ambient occlusion. For each of AO_DIRS screen-space slices we
 * find the two horizon angles by marching AO_STEPS samples out from the pixel,
 * then evaluate the cosine-weighted visibility integral analytically
 * (Jimenez et al., "Practical Realtime Strategies for Accurate Indirect
 * Occlusion"). That analytic integral is what separates GTAO from SSAO: the
 * occlusion is correct for the surface normal instead of a hemisphere guess,
 * so flat sunlit walls stay clean and only real creases darken.
 *
 * The slice rotation is jittered per pixel and per frame; TAA downstream turns
 * that jitter into extra samples instead of noise.
 */
const GTAOShader = {
  uniforms: {
    tGBuffer: { value: null },
    tVelocity: { value: null },
    uProjInfo: { value: new THREE.Vector2(1, 1) },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uProjScale: { value: 500 },
    uRadius: { value: 0.9 },
    // sin of the minimum elevation above the tangent plane a sample must clear
    // to count as an occluder — about 5 degrees.
    uBias: { value: 0.09 },
    uMaxRadiusPx: { value: 96 },
    uPower: { value: 1.35 },
    uFrame: { value: 0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_GBUFFER}
    ${GLSL_IGN}
    uniform vec2 uResolution;
    uniform float uProjScale, uRadius, uMaxRadiusPx, uPower, uFrame, uBias;
    varying vec2 vUv;

    const float PI = 3.14159265;
    const float HALF_PI = 1.57079633;

    void main() {
      float z = gbufDepth(vUv);
      vec4 g = texture2D(tGBuffer, vUv);
      if (isSky(z)) { gl_FragColor = vec4(1.0, 0.0, g.b, g.a); return; }

      vec3 P = viewPos(vUv, z);
      vec3 N = octDecode(g.rg);
      vec3 V = normalize(-P);

      // World-space radius projected to pixels, clamped so the loop never walks
      // half the screen for surfaces right against the lens. When the clamp
      // bites, the *world* radius shrinks with it — otherwise the viewmodel,
      // 30 cm from the eye, would be searched with a 0.85 m radius and every
      // sample would occlude, turning the weapon into a black blob.
      float radiusPx = min(uRadius * uProjScale / z, uMaxRadiusPx);
      if (radiusPx < 2.0) { gl_FragColor = vec4(1.0, 0.0, g.b, g.a); return; }
      float effRadius = radiusPx * z / uProjScale;

      float noise = ign(gl_FragCoord.xy, uFrame);
      float stepPx = radiusPx / float(AO_STEPS);
      float falloffScale = 1.0 / (effRadius * 0.75);
      vec2 texel = 1.0 / uResolution;

      float visibility = 0.0;
      for (int d = 0; d < AO_DIRS; d++) {
        float phi = (float(d) + noise) * (PI / float(AO_DIRS));
        vec2 dir = vec2(cos(phi), sin(phi));

        // Orthonormal frame of the slice plane spanned by V and dir.
        vec3 axis = normalize(cross(vec3(dir, 0.0), V));
        vec3 T = cross(axis, V);                     // in-plane, along +dir
        vec3 projN = N - axis * dot(N, axis);
        float projLen = length(projN);
        if (projLen < 1e-4) continue;
        vec3 pn = projN / projLen;

        float cosN = dot(pn, V);
        float sinN = dot(pn, T);
        float n = atan(sinN, cosN);

        float cosPos = -1.0, cosNeg = -1.0;
        for (int s = 0; s < AO_STEPS; s++) {
          float t = (float(s) + 0.5 + noise * 0.9) * stepPx;
          vec2 off = dir * t * texel;

          // Attenuating the horizon cosine toward -1 (fully open) with distance
          // is what keeps a distant background from carving a dark halo around
          // whatever is in front of it.
          // Tangent-plane bias. Without it a surface seen at a grazing angle
          // occludes itself: successive samples along a flat road sit at very
          // different depths, so dot(S, V) reads them as occluders even though
          // they are coplanar. Measuring each sample's elevation above the
          // tangent plane — sin of its angle, so the test is scale invariant —
          // and rejecting anything hugging that plane fixes it. Measured on the
          // open road here, the missing bias was removing 56% of the ground's
          // brightness, which read as a dark band rather than as occlusion.
          vec3 Sp = viewPos(vUv + off, gbufDepth(vUv + off)) - P;
          float lp = length(Sp);
          float elevP = dot(Sp, N) / max(lp, 1e-4);
          float wp = sat01((effRadius * 1.5 - lp) * falloffScale)
                   * smoothstep(uBias * 0.5, uBias, elevP);
          cosPos = max(cosPos, mix(-1.0, dot(Sp, V) / max(lp, 1e-4), wp));

          vec3 Sn = viewPos(vUv - off, gbufDepth(vUv - off)) - P;
          float ln = length(Sn);
          float elevN = dot(Sn, N) / max(ln, 1e-4);
          float wn = sat01((effRadius * 1.5 - ln) * falloffScale)
                   * smoothstep(uBias * 0.5, uBias, elevN);
          cosNeg = max(cosNeg, mix(-1.0, dot(Sn, V) / max(ln, 1e-4), wn));
        }

        // Horizons, clamped into the hemisphere around the surface normal.
        float h1 = n + max(-acos(clamp(cosNeg, -1.0, 1.0)) - n, -HALF_PI);
        float h2 = n + min( acos(clamp(cosPos, -1.0, 1.0)) - n,  HALF_PI);

        visibility += projLen * 0.25 * (
          (-cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN) +
          (-cos(2.0 * h2 - n) + cosN + 2.0 * h2 * sinN));
      }

      float ao = pow(sat01(visibility / float(AO_DIRS)), uPower);
      // .g carries the raw depth-derived edge key for the bilateral blur; .ba
      // keep the packed depth so the blur never has to touch the g-buffer.
      gl_FragColor = vec4(ao, 0.0, g.b, g.a);
    }`,
};

/**
 * Depth-aware separable blur. A plain gaussian on AO is what produces halos
 * around foreground objects, so taps are rejected by depth difference relative
 * to the centre depth, scaled by distance so the tolerance stays constant in
 * world units instead of tightening as you look further away.
 */
const AOBlurShader = {
  uniforms: {
    tAO: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDirection: { value: new THREE.Vector2(1, 0) },
    uDepthSigma: { value: 0.06 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_CODEC}
    uniform sampler2D tAO;
    uniform vec2 uTexel, uDirection;
    uniform float uDepthSigma;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D(tAO, vUv);
      float z0 = unpackUnit(c.ba);
      float sum = c.r, wsum = 1.0;
      // 9-tap, 2-pixel stride: 16 effective pixels of reach at half res.
      for (int i = 1; i <= 4; i++) {
        float o = float(i) * 2.0;
        float gw = exp(-0.5 * (o * o) / 12.25);
        vec2 d = uDirection * uTexel * o;

        vec4 a = texture2D(tAO, vUv + d);
        float wa = gw * exp(-abs(unpackUnit(a.ba) - z0) / uDepthSigma);
        sum += a.r * wa; wsum += wa;

        vec4 b = texture2D(tAO, vUv - d);
        float wb = gw * exp(-abs(unpackUnit(b.ba) - z0) / uDepthSigma);
        sum += b.r * wb; wsum += wb;
      }
      gl_FragColor = vec4(sum / wsum, c.g, c.b, c.a);
    }`,
};

/**
 * Contact occlusion — the short-range half of the ambient term, and the reason
 * props stop floating.
 *
 * The wide GTAO above runs at half resolution with a 0.85 m search: at 1280x720
 * its innermost sample is already ~2 full-res pixels out, so a 5 cm gap between
 * a crate and the floor falls entirely inside its first step and is never seen.
 * No amount of retuning fixes that — the signal is below the pass's sampling
 * rate. This is a genuinely separate, genuinely short-range trace at *full*
 * resolution, so it resolves the metre of world nearest each contact.
 *
 * The estimator is Alchemy/HBAO obscurance rather than GTAO's horizon integral:
 * for each tap, how far the sample rises above this pixel's tangent plane,
 * attenuated by distance. It is noisier per sample than a horizon search but it
 * needs no marching, so all of its samples land inside the contact instead of
 * being spent walking out of it.
 *
 * The same tangent-plane rejection the wide pass uses applies here, for the same
 * reason: without it a road seen at a grazing angle occludes itself and the
 * whole ground darkens. Coplanar samples read elevation ~0 and are rejected
 * regardless of how far away they are, so the test costs nothing at range.
 */
const ContactAOShader = {
  uniforms: {
    tGBuffer: { value: null },
    tVelocity: { value: null },
    uProjInfo: { value: new THREE.Vector2(1, 1) },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uProjScale: { value: 500 },
    uRadius: { value: 0.32 },
    uBias: { value: 0.13 },
    uIntensity: { value: 1.0 },
    uMinRadiusPx: { value: 3.0 },
    uMaxRadiusPx: { value: 42.0 },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uRayRange: { value: 0.8 },
    uRayThickness: { value: 0.35 },
    uRayStrength: { value: 0.6 },
    uFrame: { value: 0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_GBUFFER}
    ${GLSL_IGN}
    uniform vec2 uResolution;
    uniform float uProjScale, uRadius, uBias, uIntensity,
                  uMinRadiusPx, uMaxRadiusPx, uFrame,
                  uRayRange, uRayThickness, uRayStrength;
    uniform vec3 uSunView;
    varying vec2 vUv;
    const float GOLDEN = 2.39996323;

    /** View-space point back to the uv it was rasterised from. */
    vec2 viewToUv(vec3 Q) {
      return (Q.xy / max(-Q.z, 1e-4)) / uProjInfo * 0.5 + 0.5;
    }

    /**
     * Short screen-space shadow ray toward the sun.
     *
     * This is the half of the problem ambient occlusion physically cannot
     * solve. On a road seen at a grazing angle, one screen pixel spans roughly
     * ten centimetres of ground, so the entire half-metre of floor beside a
     * barrier — the whole region an AO search of any radius could darken — is
     * three pixels wide. A shadow ray does not have that problem: it walks
     * along the *light*, and the strip of ground the barrier actually shades
     * runs a metre or more downsun, which is tens of pixels even edge-on.
     *
     * Deliberately short. This is not a replacement for the cascades; it is the
     * few tens of centimetres nearest a caster that a shadow map with a working
     * normal bias must give up in order not to acne, which is exactly the range
     * where a prop reads as glued down or floating.
     */
    float sunRay(vec3 P, vec3 N, float z, float jitter) {
      // Back-facing to the sun is the cosine term's job, not ours; tracing it
      // would just paint a second, offset terminator.
      if (uRayStrength <= 0.0 || dot(N, uSunView) <= 0.03) return 1.0;

      // Lift off along the normal before starting. The g-buffer stores depth in
      // 16 sqrt-encoded bits, so a step near the eye is well under a
      // millimetre but grows to centimetres at range; the offset has to track
      // it or the surface shadows itself at distance.
      vec3 O = P + N * (0.01 + z * 0.0022);
      float occ = 0.0;

      for (int i = 0; i < RAY_STEPS; i++) {
        float t = (float(i) + jitter) / float(RAY_STEPS) * uRayRange;
        vec3 Q = O + uSunView * t;
        float qz = -Q.z;
        if (qz < 0.05) break;
        vec2 uv = viewToUv(Q);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

        float sz = gbufDepth(uv);
        float diff = qz - sz;                  // >0: something is in front of the ray
        // A depth buffer records surfaces, not solids. Without an upper bound
        // every distant rooftop between the pixel and the sun counts as an
        // occluder and the whole frame goes into shadow.
        float thick = uRayThickness + qz * 0.02;
        if (diff > 0.004 + qz * 0.0025 && diff < thick) {
          // Fade out over the last third of the trace. A hit at the very end of
          // a half-metre ray is as likely to be the ray running out as it is a
          // real occluder, and terminating hard draws a straight edge across
          // the ground at exactly uRayRange from every caster.
          occ = max(occ, 1.0 - smoothstep(0.62, 1.0, t / uRayRange));
        }
      }
      return sat01(1.0 - occ * uRayStrength);
    }

    void main() {
      vec4 g = texture2D(tGBuffer, vUv);
      float z = gbufDepth(vUv);
      if (isSky(z)) { gl_FragColor = vec4(1.0, 1.0, g.b, g.a); return; }

      vec3 P = viewPos(vUv, z);
      vec3 N = octDecode(g.rg);

      // World radius projected to pixels, then clamped at both ends. The upper
      // clamp is the same guard the wide pass needs — the viewmodel is 30 cm
      // from the lens and a 0.32 m search there would swallow the whole weapon.
      // The lower clamp matters more here: past ~50 m a 0.32 m radius is under
      // one texel and every tap would land back in the centre pixel, silently
      // switching the term off exactly where a prop needs its base pinned.
      // Whichever clamp bites, the world falloff radius follows it.
      float radiusPx = clamp(uRadius * uProjScale / z, uMinRadiusPx, uMaxRadiusPx);
      float R = radiusPx * z / uProjScale;

      float noise = ign(gl_FragCoord.xy, uFrame);
      float rot = noise * 6.2831853;
      vec2 texel = 1.0 / uResolution;

      float occ = 0.0, wsum = 0.0;
      for (int i = 0; i < CONTACT_TAPS; i++) {
        float fi = float(i) + 0.5;
        // Taps are spaced linearly from 1.5 px out to the full radius. The
        // g-buffer is point sampled, so anything closer than about a texel
        // returns the centre pixel itself and contributes nothing.
        float rPx = mix(1.5, radiusPx, fi / float(CONTACT_TAPS));
        float ang = fi * GOLDEN + rot;
        vec2 suv = vUv + vec2(cos(ang), sin(ang)) * rPx * texel;

        vec3 S = viewPos(suv, gbufDepth(suv)) - P;
        float d = length(S);
        // Elevation above the tangent plane, as a sine — scale invariant, so
        // one bias works from the muzzle to the far parapet. It saturates about
        // 20 degrees above the bias rather than ramping all the way to the
        // zenith: a wall meeting a floor at a right angle presents most of its
        // occluding area at shallow elevations, and a ramp normalised to 90
        // degrees scores that wall at a third of its true obscurance. That
        // single mis-normalisation is most of why the first cut of this pass
        // measured 253/255 mean and was invisible.
        float rise = smoothstep(uBias, uBias + 0.34, dot(S, N) / max(d, 1e-5));
        // Proximity weight: full inside half the radius, gone at the edge.
        float att = smoothstep(0.0, 0.5, 1.0 - d / R);
        occ += rise * att;
        wsum += att;
      }

      // Normalise by the weight actually in range, not by the tap count. A tap
      // that landed on the skyline two hundred metres away is not evidence that
      // this pixel is open — it is no evidence at all, and averaging it in as a
      // zero is what lets seven distant taps bury the one that found the floor
      // the crate is sitting on. occ never exceeds wsum, so the ratio needs no
      // clamping beyond the divide-by-zero guard.
      float ao = sat01(1.0 - uIntensity * occ / max(wsum, 1e-4));
      // .r ambient contact, .g direct contact shadow — the two are consumed
      // with opposite sensitivity to how lit a pixel is, so they cannot be
      // folded into one number here. .ba carry the packed depth so the resolve
      // can reject taps across an edge without a second g-buffer fetch.
      gl_FragColor = vec4(ao, sunRay(P, N, z, noise), g.b, g.a);
    }`,
};

/**
 * Multiplies AO into the lit image. AO is an ambient term, but all we have here
 * is the composite, so the darkening is eased off where a pixel is obviously
 * under direct sun. Without that, occlusion reads as dirt on bright walls.
 *
 * The contact term gets its own, far gentler relief. A wide bowl of ambient
 * occlusion genuinely does vanish on a surface the sun is hitting square on; a
 * 5 cm gap does not — it still blocks most of the sky and all of the bounce.
 * Relieving both by the same amount is what made the previous pass invisible on
 * the sunlit road and the sunlit rooftop, which is precisely where the props
 * looked pasted on.
 *
 * The contact trace is one rotated tap set per pixel, so it arrives noisy. The
 * five-tap diagonal resolve here averages four neighbouring rotation cells
 * together under a depth guard, which makes an 8-tap trace read like a 40-tap
 * one and costs four fetches instead of a whole blur pass.
 */
const AOApplyShader = {
  uniforms: {
    tDiffuse: { value: null },
    tAO: { value: null },
    tContact: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uStrength: { value: 1.0 },
    uDirectRelief: { value: 0.5 },
    uContactStrength: { value: 1.0 },
    uContactRelief: { value: 0.22 },
    uShadowStrength: { value: 1.0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_CODEC}
    uniform sampler2D tDiffuse, tAO, tContact;
    uniform vec2 uTexel;
    uniform float uStrength, uDirectRelief, uContactStrength, uContactRelief,
                  uShadowStrength;
    varying vec2 vUv;

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float ao = texture2D(tAO, vUv).r;

      float contact = 1.0, shadow = 1.0;
      if (uContactStrength > 0.0) {
        vec4 k0 = texture2D(tContact, vUv);
        float z0 = unpackUnit(k0.ba);
        vec2 sum = k0.rg;
        float wsum = 1.0;
        for (int i = 0; i < 4; i++) {
          vec2 o = i == 0 ? vec2(1.0, 1.0) : i == 1 ? vec2(-1.0, 1.0)
                 : i == 2 ? vec2(1.0, -1.0) : vec2(-1.0, -1.0);
          vec4 s = texture2D(tContact, vUv + o * uTexel);
          // Depth is sqrt encoded, so a fixed tolerance here is a world-space
          // tolerance that widens with distance — which is what you want: the
          // resolve must not blur a contact across the silhouette in front of
          // it, but at 100 m the whole prop is a few pixels wide.
          float w = exp(-abs(unpackUnit(s.ba) - z0) * 1200.0);
          sum += s.rg * w; wsum += w;
        }
        contact = sum.x / wsum;
        shadow = sum.y / wsum;
      }

      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float bright = smoothstep(0.35, 1.6, l);
      float kWide = uStrength * (1.0 - uDirectRelief * bright);
      float kNear = uContactStrength * (1.0 - uContactRelief * bright);

      // The shadow ray reads the opposite way round. Occlusion scales ambient,
      // which is why it has to be eased off in full sun; a contact shadow
      // scales *direct*, so it applies only where there is direct light left to
      // remove. Gating it on how lit the pixel already is doubles as the guard
      // against double-darkening: a pixel the cascades have already put in
      // shadow is dark, reads as unlit, and is left alone.
      float lit = smoothstep(0.30, 1.05, l);
      float kSun = uShadowStrength * lit;

      gl_FragColor = vec4(
        c * mix(1.0, ao, kWide) * mix(1.0, contact, kNear) * mix(1.0, shadow, kSun), 1.0);
    }`,
};

/**
 * Temporal antialiasing.
 *
 * History is reprojected through the velocity buffer and clipped to an AABB
 * built from the mean and variance of the 3x3 current-frame neighbourhood in
 * YCoCg — variance clipping keeps far more history than a min/max box and is
 * what stops thin geometry (rail teeth, antennae) from flickering.
 *
 * Blending happens in tonemapped space (Karis): a single very bright sample
 * would otherwise dominate the average and flash as it enters and leaves.
 */
const TAAShader = {
  uniforms: {
    tCurrent: { value: null },
    tHistory: { value: null },
    tVelocity: { value: null },
    tGBuffer: { value: null },
    uProjInfo: { value: new THREE.Vector2(1, 1) },
    uTexel: { value: new THREE.Vector2() },
    uFeedback: { value: 0.92 },
    uClipGamma: { value: 1.25 },
    uValid: { value: 0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_GBUFFER}
    uniform sampler2D tCurrent, tHistory;
    uniform vec2 uTexel;
    uniform float uFeedback, uClipGamma, uValid;
    varying vec2 vUv;

    vec3 rgbToYCoCg(vec3 c) {
      return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
                  0.5 * c.r - 0.5 * c.b,
                 -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
    }
    vec3 yCoCgToRgb(vec3 c) {
      float t = c.x - c.z;
      return vec3(t + c.y, c.x + c.z, t - c.y);
    }
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    vec3 tonemap(vec3 c) { return c / (1.0 + luma(c)); }
    vec3 untonemap(vec3 c) { return c / max(1.0 - luma(c), 1e-4); }

    #ifdef HISTORY_CATMULL_ROM
    // 5-tap Catmull-Rom (Karis). Bilinear history resampling softens the image a
    // little every frame; under motion that compounds into mush.
    vec3 sampleHistory(vec2 uv) {
      vec2 res = 1.0 / uTexel;
      vec2 samplePos = uv * res;
      vec2 tc1 = floor(samplePos - 0.5) + 0.5;
      vec2 f = samplePos - tc1;
      vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
      vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
      vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
      vec2 w3 = f * f * (-0.5 + 0.5 * f);
      vec2 w12 = w1 + w2;
      vec2 tc0 = (tc1 - 1.0) * uTexel;
      vec2 tc3 = (tc1 + 2.0) * uTexel;
      vec2 tc12 = (tc1 + w2 / w12) * uTexel;
      vec3 c = texture2D(tHistory, vec2(tc12.x, tc0.y)).rgb * (w12.x * w0.y)
             + texture2D(tHistory, vec2(tc0.x, tc12.y)).rgb * (w0.x * w12.y)
             + texture2D(tHistory, tc12).rgb * (w12.x * w12.y)
             + texture2D(tHistory, vec2(tc3.x, tc12.y)).rgb * (w3.x * w12.y)
             + texture2D(tHistory, vec2(tc12.x, tc3.y)).rgb * (w12.x * w3.y);
      float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
      return max(c / wsum, 0.0);
    }
    #else
    vec3 sampleHistory(vec2 uv) { return texture2D(tHistory, uv).rgb; }
    #endif

    void main() {
      vec3 cur = tonemap(texture2D(tCurrent, vUv).rgb);

      // Neighbourhood statistics for the clip box. A 5-tap cross rather than the
      // full 3x3: the diagonals barely move the variance estimate and this is a
      // full-resolution pass, so the four saved fetches are worth more than the
      // marginal tightening they would buy.
      vec3 c0 = rgbToYCoCg(cur);
      vec3 m1 = c0, m2 = c0 * c0, lo = c0, hi = c0;
      for (int i = 0; i < 4; i++) {
        vec2 o = i == 0 ? vec2(1.0, 0.0) : i == 1 ? vec2(-1.0, 0.0)
               : i == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0);
        vec3 s = rgbToYCoCg(tonemap(texture2D(tCurrent, vUv + o * uTexel).rgb));
        m1 += s; m2 += s * s; lo = min(lo, s); hi = max(hi, s);
      }
      vec3 mean = m1 / 5.0;
      vec3 sigma = sqrt(max(m2 / 5.0 - mean * mean, 0.0));
      vec3 boxMin = max(mean - uClipGamma * sigma, lo);
      vec3 boxMax = min(mean + uClipGamma * sigma, hi);

      vec2 vel = readVelocity(vUv);
      vec2 prevUv = vUv - vel;
      float inside = (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) ? 0.0 : 1.0;

      vec3 histY = rgbToYCoCg(tonemap(sampleHistory(prevUv)));

      // Clip toward the box centre along the history-to-centre ray rather than
      // clamping each axis: clamping shifts hue, clipping does not.
      vec3 centre = 0.5 * (boxMax + boxMin);
      vec3 extent = max(0.5 * (boxMax - boxMin), vec3(1e-5));
      vec3 delta = histY - centre;
      vec3 unit = abs(delta / extent);
      float maxUnit = max(unit.x, max(unit.y, unit.z));
      if (maxUnit > 1.0) histY = centre + delta / maxUnit;

      // Give up more history the faster the pixel is moving.
      float speed = length(vel / uTexel);
      float feedback = mix(uFeedback, uFeedback * 0.72, sat01(speed / 24.0));
      feedback *= inside * uValid;

      vec3 outC = untonemap(mix(cur, yCoCgToRgb(histY), feedback));
      gl_FragColor = vec4(max(outC, 0.0), 1.0);
    }`,
};

/**
 * Reconstruction motion blur. Samples along the pixel's own motion vector with
 * a dithered start so the trail bands into noise instead of ghost steps.
 * Taps whose own velocity disagrees strongly are down-weighted, which keeps a
 * static background from being dragged along by a fast object in front of it.
 */
const MotionBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    tVelocity: { value: null },
    tGBuffer: { value: null },
    uProjInfo: { value: new THREE.Vector2(1, 1) },
    uTexel: { value: new THREE.Vector2() },
    uStrength: { value: 0.55 },
    uMaxPx: { value: 48 },
    uFrame: { value: 0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_GBUFFER}
    ${GLSL_IGN}
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uStrength, uMaxPx, uFrame;
    varying vec2 vUv;

    void main() {
      vec2 vel = readVelocity(vUv) * uStrength;
      vec2 velPx = vel / uTexel;
      float lenPx = length(velPx);
      if (lenPx < 0.75) { gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); return; }
      if (lenPx > uMaxPx) vel *= uMaxPx / lenPx;

      float jitter = ign(gl_FragCoord.xy, uFrame) - 0.5;
      vec3 sum = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < MB_SAMPLES; i++) {
        float t = (float(i) + 0.5 + jitter) / float(MB_SAMPLES) - 0.5;
        vec2 suv = clamp(vUv + vel * t, vec2(0.0), vec2(1.0));
        vec2 sv = readVelocity(suv) * uStrength;
        // Cosine-ish weight plus velocity coherence.
        float w = mix(0.35, 1.0, sat01(dot(normalize(sv + 1e-6), normalize(vel + 1e-6))));
        sum += texture2D(tDiffuse, suv).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
    }`,
};

/**
 * Autofocus. Runs into a 1x1 target and ping-pongs its own result so the focus
 * distance can be smoothed over time without a GPU->CPU readback stall. Depth
 * is averaged over a small cross at the reticle so a wire or a railing cannot
 * yank focus, and floored so the viewmodel can never pull focus to 30 cm.
 */
const FocusShader = {
  uniforms: {
    tGBuffer: { value: null },
    tVelocity: { value: null },
    tPrevFocus: { value: null },
    uProjInfo: { value: new THREE.Vector2(1, 1) },
    uRate: { value: 0.12 },
    uMinFocus: { value: 3.0 },
    uMaxFocus: { value: 140.0 },
    uValid: { value: 0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_GBUFFER}
    uniform sampler2D tPrevFocus;
    uniform float uRate, uMinFocus, uMaxFocus, uValid;
    varying vec2 vUv;
    void main() {
      float z = gbufDepth(vec2(0.5, 0.5));
      z = min(z, gbufDepth(vec2(0.5 + 0.012, 0.5)));
      z = min(z, gbufDepth(vec2(0.5 - 0.012, 0.5)));
      z = min(z, gbufDepth(vec2(0.5, 0.5 + 0.02)));
      z = min(z, gbufDepth(vec2(0.5, 0.5 - 0.02)));
      float target = clamp(z, uMinFocus, uMaxFocus);
      float prev = unpackUnit(texture2D(tPrevFocus, vec2(0.5)).rg);
      prev = prev * prev * ${DEPTH_FAR.toFixed(1)};
      // Focus travels in log space so a pull from 5 m to 50 m takes the same
      // time as 50 m to 500 m, which is how a real lens behaves.
      float f = uValid > 0.5 ? exp(mix(log(max(prev, uMinFocus)), log(target), uRate)) : target;
      gl_FragColor = vec4(packUnit(sqrt(sat01(f * ${(1 / DEPTH_FAR).toExponential()}))), 0.0, 1.0);
    }`,
};

/** Half-res colour + signed circle of confusion, near-field dilated. */
const DOFDownsampleShader = {
  uniforms: {
    tDiffuse: { value: null },
    tGBuffer: { value: null },
    tVelocity: { value: null },
    tFocus: { value: null },
    uProjInfo: { value: new THREE.Vector2(1, 1) },
    uTexel: { value: new THREE.Vector2() },
    uNearScale: { value: 1.0 },
    uFarScale: { value: 0.35 },
    uMaxCoc: { value: 10.0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_GBUFFER}
    uniform sampler2D tDiffuse, tFocus;
    uniform vec2 uTexel;
    uniform float uNearScale, uFarScale, uMaxCoc;
    varying vec2 vUv;

    float focusDistance() {
      float f = unpackUnit(texture2D(tFocus, vec2(0.5)).rg);
      return f * f * ${DEPTH_FAR.toFixed(1)};
    }

    // Thin-lens circle of confusion, normalised so the far field saturates
    // gently and the near field (the weapon) ramps hard.
    float cocAt(vec2 uv, float focus) {
      float z = gbufDepth(uv);
      // Normalise against the focus distance, NOT against z. Dividing by z
      // makes the near term blow up as z shrinks — focus at 60 m gave ground
      // 5 m out a rel of -11, which saturates to maximum blur and softens the
      // entire play space. Against focus the same sample is rel -0.92, which
      // lands under a pixel, and only genuinely close geometry blurs.
      float rel = (z - focus) / max(focus, 1e-3);
      float c = rel < 0.0 ? rel * uNearScale : rel * uFarScale;
      return clamp(c * uMaxCoc, -uMaxCoc, uMaxCoc);
    }

    void main() {
      float focus = focusDistance();
      vec2 o = uTexel;
      vec3 c = texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb
             + texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb
             + texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb
             + texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb;
      c *= 0.25;

      // Keep the most negative (nearest) CoC of the four so out-of-focus
      // foreground grows outward instead of being eaten at its own silhouette.
      float coc = cocAt(vUv + vec2(-o.x, -o.y), focus);
      coc = min(coc, cocAt(vUv + vec2( o.x, -o.y), focus));
      coc = min(coc, cocAt(vUv + vec2(-o.x,  o.y), focus));
      coc = min(coc, cocAt(vUv + vec2( o.x,  o.y), focus));
      float far = cocAt(vUv, focus);
      if (coc > -0.001) coc = far;

      gl_FragColor = vec4(c, coc / uMaxCoc * 0.5 + 0.5);
    }`,
};

/** Golden-angle disc gather at half res. */
const DOFBlurShader = {
  uniforms: {
    tDof: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uMaxCoc: { value: 10.0 },
    uFrame: { value: 0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_CODEC}
    ${GLSL_IGN}
    uniform sampler2D tDof;
    uniform vec2 uTexel;
    uniform float uMaxCoc, uFrame;
    varying vec2 vUv;
    const float GOLDEN = 2.39996323;

    void main() {
      vec4 centre = texture2D(tDof, vUv);
      float coc0 = (centre.a * 2.0 - 1.0) * uMaxCoc;
      float rad = abs(coc0);
      float nearest = min(coc0, 0.0);
      if (rad < 0.6) { gl_FragColor = vec4(centre.rgb, centre.a); return; }

      float rot = ign(gl_FragCoord.xy, uFrame) * 6.2831853;
      vec3 sum = centre.rgb;
      float wsum = 1.0;
      for (int i = 0; i < DOF_TAPS; i++) {
        float fi = float(i) + 0.5;
        float rr = sqrt(fi / float(DOF_TAPS));
        float ang = fi * GOLDEN + rot;
        vec2 off = vec2(cos(ang), sin(ang)) * rr;
        vec4 s = texture2D(tDof, vUv + off * rad * uTexel);
        float cocS = (s.a * 2.0 - 1.0) * uMaxCoc;
        // A tap only reaches this pixel if its own blur circle is wide enough.
        float w = sat01(abs(cocS) - rr * rad + 1.0);
        sum += s.rgb * w;
        wsum += w;
        nearest = min(nearest, cocS + rr * rad);
      }
      // Alpha carries how far near-field blur has spread, so the full-res
      // composite can bleed foreground bokeh past its own silhouette.
      gl_FragColor = vec4(sum / wsum, nearest / uMaxCoc * 0.5 + 0.5);
    }`,
};

const DOFCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tBlur: { value: null },
    tGBuffer: { value: null },
    tVelocity: { value: null },
    tFocus: { value: null },
    uProjInfo: { value: new THREE.Vector2(1, 1) },
    uNearScale: { value: 1.0 },
    uFarScale: { value: 0.35 },
    uMaxCoc: { value: 10.0 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    ${GLSL_GBUFFER}
    uniform sampler2D tDiffuse, tBlur, tFocus;
    uniform float uNearScale, uFarScale, uMaxCoc;
    varying vec2 vUv;

    void main() {
      vec3 sharp = texture2D(tDiffuse, vUv).rgb;
      float f = unpackUnit(texture2D(tFocus, vec2(0.5)).rg);
      float focus = f * f * ${DEPTH_FAR.toFixed(1)};
      float z = gbufDepth(vUv);
      // Same normalisation as the downsample pass — these two must agree or the
      // composite blends a blur the CoC pass never actually produced.
      float rel = (z - focus) / max(focus, 1e-3);
      float coc = clamp((rel < 0.0 ? rel * uNearScale : rel * uFarScale) * uMaxCoc, -uMaxCoc, uMaxCoc);

      vec4 blur = texture2D(tBlur, vUv);
      float nearSpread = max(0.0, -((blur.a * 2.0 - 1.0) * uMaxCoc));
      float radius = max(abs(coc), nearSpread);
      float k = smoothstep(0.7, 2.6, radius);
      gl_FragColor = vec4(mix(sharp, blur.rgb, k), 1.0);
    }`,
};

/** Soft-knee threshold + Karis average, first step of the bloom pyramid. */
const BloomPrefilterShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: 1.1 },
    uKnee: { value: 0.55 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uThreshold, uKnee;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    // Karis weighting: a lone very bright texel would otherwise survive the
    // whole pyramid and reappear as a flickering blob three mips later.
    vec3 tap(vec2 uv, inout float wsum) {
      vec3 c = max(texture2D(tDiffuse, uv).rgb, 0.0);
      float w = 1.0 / (1.0 + luma(c));
      wsum += w;
      return c * w;
    }

    void main() {
      float wsum = 0.0;
      vec3 c = tap(vUv + vec2(-uTexel.x, -uTexel.y), wsum)
             + tap(vUv + vec2( uTexel.x, -uTexel.y), wsum)
             + tap(vUv + vec2(-uTexel.x,  uTexel.y), wsum)
             + tap(vUv + vec2( uTexel.x,  uTexel.y), wsum);
      c /= wsum;

      // Quadratic knee: nothing below the threshold contributes, and the ramp
      // above it is smooth so a surface drifting into range does not pop.
      float l = luma(c);
      float soft = l - uThreshold + uKnee;
      soft = clamp(soft, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-5);
      float contrib = max(soft, l - uThreshold) / max(l, 1e-5);
      gl_FragColor = vec4(c * contrib, 1.0);
    }`,
};

/** 13-tap downsample (Sledgehammer / "Next Generation Post Processing in COD"). */
const BloomDownShader = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec2 t = uTexel;
      vec3 a = texture2D(tDiffuse, vUv + vec2(-2.0 * t.x,  2.0 * t.y)).rgb;
      vec3 b = texture2D(tDiffuse, vUv + vec2( 0.0,        2.0 * t.y)).rgb;
      vec3 c = texture2D(tDiffuse, vUv + vec2( 2.0 * t.x,  2.0 * t.y)).rgb;
      vec3 d = texture2D(tDiffuse, vUv + vec2(-2.0 * t.x,  0.0)).rgb;
      vec3 e = texture2D(tDiffuse, vUv).rgb;
      vec3 f = texture2D(tDiffuse, vUv + vec2( 2.0 * t.x,  0.0)).rgb;
      vec3 g = texture2D(tDiffuse, vUv + vec2(-2.0 * t.x, -2.0 * t.y)).rgb;
      vec3 h = texture2D(tDiffuse, vUv + vec2( 0.0,       -2.0 * t.y)).rgb;
      vec3 i = texture2D(tDiffuse, vUv + vec2( 2.0 * t.x, -2.0 * t.y)).rgb;
      vec3 j = texture2D(tDiffuse, vUv + vec2(-t.x,  t.y)).rgb;
      vec3 k = texture2D(tDiffuse, vUv + vec2( t.x,  t.y)).rgb;
      vec3 l = texture2D(tDiffuse, vUv + vec2(-t.x, -t.y)).rgb;
      vec3 m = texture2D(tDiffuse, vUv + vec2( t.x, -t.y)).rgb;
      vec3 o = e * 0.125;
      o += (a + c + g + i) * 0.03125;
      o += (b + d + f + h) * 0.0625;
      o += (j + k + l + m) * 0.125;
      gl_FragColor = vec4(o, 1.0);
    }`,
};

/**
 * 9-tap tent upsample. Drawn with additive blending straight into the
 * next-larger mip, so the pyramid accumulates in place with no scratch targets.
 */
const BloomUpShader = {
  uniforms: {
    tLower: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uRadius: { value: 0.85 },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tLower;
    uniform vec2 uTexel;
    uniform float uRadius;
    varying vec2 vUv;
    void main() {
      vec2 t = uTexel * uRadius;
      vec3 s = texture2D(tLower, vUv + vec2(-t.x,  t.y)).rgb
             + texture2D(tLower, vUv + vec2( 0.0,  t.y)).rgb * 2.0
             + texture2D(tLower, vUv + vec2( t.x,  t.y)).rgb
             + texture2D(tLower, vUv + vec2(-t.x,  0.0)).rgb * 2.0
             + texture2D(tLower, vUv).rgb * 4.0
             + texture2D(tLower, vUv + vec2( t.x,  0.0)).rgb * 2.0
             + texture2D(tLower, vUv + vec2(-t.x, -t.y)).rgb
             + texture2D(tLower, vUv + vec2( 0.0, -t.y)).rgb * 2.0
             + texture2D(tLower, vUv + vec2( t.x, -t.y)).rgb;
      gl_FragColor = vec4(s * (1.0 / 16.0), 1.0);
    }`,
};

/**
 * Final grade. Everything here runs on a resolved, antialiased image, which is
 * the whole reason TAA sits upstream: chromatic aberration and sharpening
 * applied to raw aliased edges is what turned the weapon rails into rainbow
 * speckle.
 *
 * Order matters: lens artefacts (distortion, CA) belong in front of the sensor,
 * bloom is the lens flaring, tonemap maps scene light to display, and the LUT
 * plus lift/gamma/gain are the colourist's pass in perceptual space.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    tLut: { value: null },
    uResolution: { value: new THREE.Vector2(1600, 900) },
    uTime: { value: 0 },
    uExposure: { value: 1.0 },
    uBloomStrength: { value: 0.24 },
    uChromatic: { value: 0.0011 },
    uDistortion: { value: 0.022 },
    uSharpen: { value: 0.22 },
    uLutMix: { value: 1.0 },
    uVignette: { value: 0.36 },
    uGrain: { value: 0.032 },
    uSaturation: { value: 1.04 },
    uContrast: { value: 1.03 },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
  },
  vertexShader: GLSL_FS_VERT,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse, tBloom, tLut;
    uniform vec2 uResolution;
    uniform float uTime, uExposure, uBloomStrength, uChromatic, uDistortion,
                  uSharpen, uLutMix, uVignette, uGrain, uSaturation, uContrast;
    uniform vec3 uLift, uGamma, uGain;
    varying vec2 vUv;

    #define sat01(x) clamp(x, 0.0, 1.0)
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    vec3 linearToSRGB(vec3 c) {
      c = max(c, 0.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }

    /* ---- AgX ---------------------------------------------------------- */
    const mat3 REC2020_TO_SRGB = mat3(
      vec3( 1.6605, -0.1246, -0.0182),
      vec3(-0.5876,  1.1329, -0.1006),
      vec3(-0.0728, -0.0083,  1.1187));
    const mat3 SRGB_TO_REC2020 = mat3(
      vec3(0.6274, 0.0691, 0.0164),
      vec3(0.3293, 0.9195, 0.0880),
      vec3(0.0433, 0.0113, 0.8956));

    vec3 agxContrast(vec3 x) {
      vec3 x2 = x * x, x4 = x2 * x2;
      return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
           + 0.4298 * x2 + 0.1191 * x - 0.00232;
    }

    vec3 agx(vec3 color) {
      const mat3 inset = mat3(
        vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
        vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
        vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
      const mat3 outset = mat3(
        vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
        vec3(-0.11060664309660323,  1.157823702216272, -0.11060664309660294),
        vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
      const float minEv = -12.47393, maxEv = 4.026069;

      color = SRGB_TO_REC2020 * color;
      color = inset * color;
      color = log2(max(color, 1e-10));
      color = clamp((color - minEv) / (maxEv - minEv), 0.0, 1.0);
      color = agxContrast(color);

      // "Punchy" look: AgX on its own is deliberately flat, which reads as
      // washed-out on a military palette. Slope/power/saturation put the
      // contrast back without reintroducing the highlight clipping ACES has.
      float l = luma(color);
      color = mix(vec3(l), color, 1.18);
      color = pow(max(color, 0.0), vec3(1.12));

      color = outset * color;
      color = pow(max(color, 0.0), vec3(2.2));
      color = REC2020_TO_SRGB * color;
      return clamp(color, 0.0, 1.0);
    }

    /* ---- ACES (Hill RRT+ODT fit) -------------------------------------- */
    vec3 aces(vec3 color) {
      const mat3 inMat = mat3(
        vec3(0.59719, 0.07600, 0.02840),
        vec3(0.35458, 0.90834, 0.13383),
        vec3(0.04823, 0.01566, 0.83777));
      const mat3 outMat = mat3(
        vec3( 1.60475, -0.10208, -0.00327),
        vec3(-0.53108,  1.10813, -0.07276),
        vec3(-0.07367, -0.00605,  1.07602));
      color = inMat * (color / 0.6);
      vec3 a = color * (color + 0.0245786) - 0.000090537;
      vec3 b = color * (0.983729 * color + 0.432951) + 0.238081;
      return clamp(outMat * (a / b), 0.0, 1.0);
    }

    /* ---- 3D LUT, tetrahedral ------------------------------------------ */
    // A 16^3 cube laid out as 16 horizontal 16x16 tiles. Trilinear filtering of
    // a 2D atlas bleeds across tile seams, so the four corners are fetched with
    // NEAREST and blended tetrahedrally: four taps instead of eight, and it is
    // the interpolation LUT authoring tools assume.
    vec3 lutTexel(vec3 idx) {
      float u = (idx.b * 16.0 + idx.r + 0.5) / 256.0;
      float v = (idx.g + 0.5) / 16.0;
      return texture2D(tLut, vec2(u, v)).rgb;
    }

    vec3 applyLut(vec3 c) {
      vec3 p = sat01(c) * 15.0;
      vec3 i0 = floor(p);
      vec3 f = p - i0;
      vec3 i1 = min(i0 + 1.0, 15.0);
      vec3 c000 = lutTexel(i0);
      vec3 c111 = lutTexel(i1);
      vec3 v1, v2;
      float w0, w1, w2, w3;
      if (f.r >= f.g) {
        if (f.g >= f.b) {
          v1 = vec3(i1.r, i0.g, i0.b); v2 = vec3(i1.r, i1.g, i0.b);
          w1 = f.r - f.g; w2 = f.g - f.b; w3 = f.b;
        } else if (f.r >= f.b) {
          v1 = vec3(i1.r, i0.g, i0.b); v2 = vec3(i1.r, i0.g, i1.b);
          w1 = f.r - f.b; w2 = f.b - f.g; w3 = f.g;
        } else {
          v1 = vec3(i0.r, i0.g, i1.b); v2 = vec3(i1.r, i0.g, i1.b);
          w1 = f.b - f.r; w2 = f.r - f.g; w3 = f.g;
        }
      } else {
        if (f.b >= f.g) {
          v1 = vec3(i0.r, i0.g, i1.b); v2 = vec3(i0.r, i1.g, i1.b);
          w1 = f.b - f.g; w2 = f.g - f.r; w3 = f.r;
        } else if (f.b >= f.r) {
          v1 = vec3(i0.r, i1.g, i0.b); v2 = vec3(i0.r, i1.g, i1.b);
          w1 = f.g - f.b; w2 = f.b - f.r; w3 = f.r;
        } else {
          v1 = vec3(i0.r, i1.g, i0.b); v2 = vec3(i1.r, i1.g, i0.b);
          w1 = f.g - f.r; w2 = f.r - f.b; w3 = f.b;
        }
      }
      w0 = 1.0 - w1 - w2 - w3;
      return c000 * w0 + lutTexel(v1) * w1 + lutTexel(v2) * w2 + c111 * w3;
    }

    float hash13(vec3 p) {
      p = fract(p * vec3(443.897, 441.423, 437.195));
      p += dot(p, p.yzx + 19.19);
      return fract((p.x + p.y) * p.z);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // Barrel distortion first: it is the shape of the glass, so everything
      // downstream sees the image the sensor actually receives.
      vec2 uv = vUv + c * uDistortion * (r2 - 0.19);

      // Lateral chromatic aberration grows toward the frame edge.
      float ca = uChromatic * (0.2 + r2 * 3.2);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ca).b;

      // Luma-only unsharp, applied as a *ratio* so it cannot push a channel
      // negative or shift hue. Sharpening chroma is what makes fine detail
      // fringe; sharpening a normalised luminance high-pass does not. Safe here
      // only because the image reaching this pass is already TAA-resolved.
      vec2 px = 1.0 / uResolution;
      float l0 = luma(col);
      float lR = luma(texture2D(tDiffuse, uv + vec2( px.x, 0.0)).rgb);
      float lL = luma(texture2D(tDiffuse, uv + vec2(-px.x, 0.0)).rgb);
      float lU = luma(texture2D(tDiffuse, uv + vec2(0.0,  px.y)).rgb);
      float lD = luma(texture2D(tDiffuse, uv + vec2(0.0, -px.y)).rgb);
      float lb = 0.25 * (lR + lL + lU + lD);
      float hp = clamp((l0 - lb) / max(l0 + lb, 1e-4), -0.6, 0.6);
      // Contrast-limited: the sharpened luma is clamped into the range its own
      // neighbourhood already spans. An unbounded unsharp mask overshoots on
      // one side of every silhouette, which is exactly the 1-2 px light rim
      // that was showing along the left edge of the rooftop AC unit — the halo
      // is not a tuning problem, it is what the operator does. Clamped, a step
      // edge still steepens (the dark side falls toward the local minimum, the
      // bright side rises toward the local maximum) but neither side can leave
      // the range, so no rim can be created that was not already in the image.
      float lo = min(l0, min(min(lL, lR), min(lU, lD)));
      float hi = max(l0, max(max(lL, lR), max(lU, lD)));
      float lSharp = clamp(l0 * (1.0 + hp * uSharpen * sat01(1.0 - r2 * 1.4)), lo, hi);
      col *= lSharp / max(l0, 1e-4);

      col += texture2D(tBloom, uv).rgb * uBloomStrength;
      col = agxOrAces(col * uExposure);

      // Colourist's pass in perceptual space, where equal steps look equal.
      vec3 s = linearToSRGB(max(col, 0.0));
      s = mix(s, applyLut(s), uLutMix);

      s = uLift + s * (uGain - uLift);
      s = pow(max(s, 0.0), 1.0 / max(uGamma, vec3(0.01)));
      float ls = luma(s);
      s = mix(vec3(ls), s, uSaturation);
      s = (s - 0.5) * uContrast + 0.5;

      // Natural falloff: cos^4-ish, floored so the corners stay readable and
      // slightly desaturated rather than crushed to black.
      float vig = 1.0 - uVignette * smoothstep(0.10, 0.86, r2 * 2.05);
      float lv = luma(s);
      s = mix(s, vec3(lv), (1.0 - vig) * 0.35) * mix(1.0, vig, 0.92);

      // Sensor grain: strongest in the shadows and mids, gone in the highlights,
      // and monochrome-dominant with a touch of chroma like real film scan noise.
      float g = hash13(vec3(gl_FragCoord.xy, floor(uTime * 24.0))) - 0.5;
      float gc = hash13(vec3(gl_FragCoord.yx + 31.7, floor(uTime * 24.0))) - 0.5;
      float shadowW = 1.0 - smoothstep(0.05, 0.75, luma(s));
      s += (vec3(g) + vec3(gc, -gc, gc * 0.5) * 0.25) * uGrain * (0.25 + shadowW);

      gl_FragColor = vec4(max(s, 0.0), 1.0);
    }`,
};

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export class RenderPipeline {
  constructor(engine, { quality = 'high', sky } = {}) {
    this.engine = engine;
    // Kept because the construction contract exposes it to the settings menu
    // and to any future sky-driven exposure work.
    this.sky = sky;
    this.quality = quality;
    this.tier = TIERS[quality] || TIERS.high;

    this.params = {
      // Measured across five captures, the brightest non-HUD pixel was luma
      // 176/255 and sunlit plaster topped out at 126: the whole image sat
      // between 0.10 and 0.69 with nothing in the top two stops, which is what
      // makes a render read as a matte print instead of a photograph. Keying up
      // ~0.7 stop puts sunlit diffuse near 0.75 display and leaves the top stop
      // free for speculars to actually clip.
      // Reverting a mistake: this was lifted to 1.62 to chase a missing top end,
      // but the scene simply never produced radiance above ~2, so it slid the
      // whole distribution up instead of widening it. The floor came up, the
      // ceiling moved a tenth of a stop, and the frame got milkier. The real
      // cause was the sun-to-sky ratio, now derived in Sky.js.
      exposure: 1.15,
      tonemap: 'agx',

      ao: true,
      aoRadius: 0.85,
      aoIntensity: 1.0,
      aoPower: 1.5,
      aoBias: 0.09,

      // Short-range contact occlusion, full res, independent of the wide term.
      // 0.32 m is deliberately just over prop scale: wide enough that the
      // gradient under a crate or a barrier foot reads as a soft shadow rather
      // than a hard line, tight enough that it never becomes a second, worse
      // copy of the GTAO above.
      contact: true,
      contactRadius: 0.32,
      contactIntensity: 1.0,
      // Same units as aoBias — sine of the minimum elevation above the tangent
      // plane. Slightly higher than the wide pass because the taps here are one
      // to two pixels apart, where depth quantisation is a larger share of the
      // measured rise.
      contactBias: 0.13,
      contactStrength: 1.0,

      // Screen-space contact shadow, traced along the sun. The range is chosen
      // against the cascades rather than against the art: cascade 0's normal
      // bias measures 0.008 world units and grows with each split, and the band
      // a shadow map necessarily loses to that bias is the first few tens of
      // centimetres downsun of a caster. This covers that band and stops there.
      // 0.8 m rather than 0.5 because on ground seen edge-on it is the *length*
      // of the shaded strip that has to survive the projection, not its width.
      contactShadow: true,
      contactShadowRange: 0.8,
      // Depth buffers store surfaces, not solids: an occluder is only an
      // occluder if the ray passes within this much of it, otherwise every
      // rooftop between here and the sun shadows the whole street.
      contactShadowThickness: 0.35,
      // How much direct light a full hit removes. Not 1.0: this multiplies the
      // composite, which still contains sky and bounce, and a contact shadow
      // that takes the ambient with it reads as a hole rather than as shade.
      contactShadowStrength: 0.6,

      taa: this.tier.aa === 'taa',
      taaFeedback: 0.93,

      motionBlur: this.tier.motionBlur,
      motionBlurStrength: 0.5,

      dof: this.tier.dof,
      // Scales are calibrated against a real lens: with focus at 30 m, a 35 mm
      // f/2.8 puts ~20 full-res pixels of blur on a viewmodel 30 cm from the
      // eye and well under one pixel on ground 5 m out. Anything larger softens
      // the play space, which is exactly what you must never do in a shooter.
      dofNear: 0.11,
      dofFar: 0.12,
      dofMaxCoc: 9.0,

      bloom: true,
      bloomStrength: 0.24,
      bloomRadius: 0.85,
      // With nothing in the frame above 1.05 the bloom never fired on world
      // geometry at all. Dropping the knee lets real speculars bloom.
      // Back up now that the sun carries real energy: bloom should fire on
      // speculars, not on bright diffuse.
      bloomThreshold: 1.0,
      bloomKnee: 0.55,

      lut: 1.0,
      // 0.38 cost ~13 luma at the bottom of the frame, deepening the very
      // region that was already reading as a dark band.
      // 0.38 was crushing the near road; 0.20 removed the frame containment
      // entirely. Split the difference.
      vignette: 0.28,
      grain: 0.03,
      chromatic: 0.0011,
      distortion: 0.024,
      saturation: 1.03,
      contrast: 1.02,
      // Was ringing a 1-2px light halo along silhouettes; the unsharp is now
      // clamped to its own neighbourhood, so overshoot is structurally
      // impossible and the amount can go back up to where the image needs it.
      sharpen: 0.22,
      lift: 0.0,
    };

    const renderer = engine.renderer;
    // Half-float gives the post stack real HDR headroom, but some software
    // rasterisers advertise the extension and then render nothing into it.
    // Probe once and fall back to 8-bit rather than shipping a black frame.
    this.hdr = probeHalfFloat(renderer);
    this.hdrType = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    // Motion vectors come from a second colour attachment; without MRT there is
    // no per-object velocity, so TAA/motion blur step aside for SMAA.
    this.mrt = renderer.getContext().getParameter(renderer.getContext().MAX_DRAW_BUFFERS) >= 2;
    if (!this.mrt) { this.params.taa = false; this.params.motionBlur = false; }
    this.useTaa = this.params.taa;

    this.worldPass = new WorldPass(engine);
    this.gbufferPass = this.mrt ? new GBufferPass(engine) : null;

    this.lut = buildFilmLut();

    this._quads = {
      gtao: fsQuad(GTAOShader, { AO_DIRS: this.tier.aoDirs, AO_STEPS: this.tier.aoSteps }),
      contact: fsQuad(ContactAOShader, {
        CONTACT_TAPS: this.tier.contactTaps, RAY_STEPS: this.tier.raySteps,
      }),
      aoBlur: fsQuad(AOBlurShader),
      aoApply: fsQuad(AOApplyShader),
      taa: fsQuad(TAAShader, this.tier.historyFilter ? { HISTORY_CATMULL_ROM: '' } : {}),
      motion: fsQuad(MotionBlurShader, { MB_SAMPLES: this.tier.motionSamples }),
      focus: fsQuad(FocusShader),
      dofDown: fsQuad(DOFDownsampleShader),
      dofBlur: fsQuad(DOFBlurShader, { DOF_TAPS: this.tier.dofTaps }),
      dofComposite: fsQuad(DOFCompositeShader),
      bloomPre: fsQuad(BloomPrefilterShader),
      bloomDown: fsQuad(BloomDownShader),
      bloomUp: fsQuad(BloomUpShader, {}, { blending: THREE.AdditiveBlending }),
      grade: fsQuad(GradeShader),
    };
    // The tonemapper is a compile-time choice; swapping it rebuilds the grade
    // program rather than branching on a uniform every pixel.
    this._setTonemap(this.params.tonemap);
    this._quads.grade.material.uniforms.tLut.value = this.lut;

    if (!this.useTaa) {
      this.smaa = new SMAAPass();
      this.smaa.renderToScreen = false;
    }

    this._targets = [];
    /** Set true to fill `timings` with per-stage milliseconds (costs a flush). */
    this.profile = false;
    this.timings = {};
    this._t = 0;
    this._frame = 0;
    this._historyIndex = 0;
    this._focusIndex = 0;
    this._historyValid = 0;
    this._focusValid = 0;
    this._jitter = new THREE.Vector2();
    this._tmpProjInfo = new THREE.Vector2();
    this._savedProj = new Float32Array(4);
    this._savedClear = new THREE.Color();
    this._matrices = {
      curVP: new THREE.Matrix4(), prevVP: new THREE.Matrix4(),
      curVPView: new THREE.Matrix4(), prevVPView: new THREE.Matrix4(),
    };
    this._haltonX = halton(2, 16);
    this._haltonY = halton(3, 16);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this._build(size.x, size.y);
  }

  /* -------------------- resource management -------------------- */

  _rt(w, h, opts = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      ...opts,
    });
    this._targets.push(rt);
    return rt;
  }

  _build(w, h) {
    this._disposeTargets();
    this.width = w; this.height = h;

    const hdrOpts = { type: this.hdrType };
    this.rtScene = this._rt(w, h, { ...hdrOpts, depthBuffer: true });
    this.rtLit = this._rt(w, h, hdrOpts);
    this.rtHistory = [this._rt(w, h, hdrOpts), this._rt(w, h, hdrOpts)];
    this.rtPost = [this._rt(w, h, hdrOpts), this._rt(w, h, hdrOpts)];

    if (this.mrt) {
      this.rtGBuffer = this._rt(w, h, {
        count: 2, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
    }

    const s = this.tier.aoScale;
    this.rtAO = [this._rt(w * s, h * s), this._rt(w * s, h * s)];
    // Contact occlusion is the one screen-space term that must not be
    // downsampled: the feature it is looking for is a handful of pixels wide.
    this.rtContact = this._rt(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.rtFocus = [
      this._rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      this._rt(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
    ];
    this.rtDof = [this._rt(w * 0.5, h * 0.5, hdrOpts), this._rt(w * 0.5, h * 0.5, hdrOpts)];

    this.rtBloom = [];
    let bw = w, bh = h;
    for (let i = 0; i < this.tier.bloomMips; i++) {
      bw = Math.max(2, Math.floor(bw / 2));
      bh = Math.max(2, Math.floor(bh / 2));
      this.rtBloom.push(this._rt(bw, bh, hdrOpts));
    }

    if (this.smaa) this.smaa.setSize(w, h);
    this._historyValid = 0;
    this._focusValid = 0;
  }

  _disposeTargets() {
    for (const rt of this._targets) rt.dispose();
    this._targets.length = 0;
  }

  _setTonemap(name) {
    const fn = name === 'aces' ? 'aces' : 'agx';
    const mat = this._quads.grade.material;
    mat.fragmentShader = GradeShader.fragmentShader.replace(/agxOrAces/g, fn);
    mat.needsUpdate = true;
  }

  /* -------------------- public API -------------------- */

  setParam(name, value) {
    this.params[name] = value;
    if (name === 'tonemap') this._setTonemap(value);
    if (name === 'taa') { this.useTaa = value && this.mrt; this._historyValid = 0; }
  }

  resize(w, h) {
    if (!this.engine) return;
    const dpr = this.engine.renderer.getPixelRatio();
    this._build(Math.round(w * dpr), Math.round(h * dpr));
  }

  render(dt) {
    const e = this.engine;
    const r = e.renderer;
    if (!this.rtScene) return;

    this._t += dt;
    this._frame++;
    const p = this.params;

    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevClearAlpha = r.getClearAlpha();
    r.getClearColor(this._savedClear);

    this._updateMatrices();
    this._pushJitter();

    // 1 — world colour, 2 — g-buffer, both with the same jittered projection.
    this._time('world', () => this.worldPass.render(r, null, this.rtScene));
    if (this.gbufferPass) {
      this._time('gbuffer', () => this.gbufferPass.render(r, this.rtGBuffer, this._matrices));
    }

    this._popJitter();

    const gbuf = this.mrt ? this.rtGBuffer.textures[0] : null;
    const vel = this.mrt ? this.rtGBuffer.textures[1] : null;
    const projInfo = this._projInfo();

    // 3 — ambient occlusion.
    let lit = this.rtScene.texture;
    if (p.ao && this.mrt) {
      this._time('ao', () => this._renderAO(r, gbuf, vel, projInfo));
      const u = this._quads.aoApply.material.uniforms;
      u.tDiffuse.value = this.rtScene.texture;
      u.tAO.value = this.rtAO[0].texture;
      u.tContact.value = this.rtContact.texture;
      u.uTexel.value.set(1 / this.width, 1 / this.height);
      u.uStrength.value = p.aoIntensity;
      u.uContactStrength.value = p.contact ? p.contactStrength : 0.0;
      u.uShadowStrength.value = (p.contact && p.contactShadow) ? 1.0 : 0.0;
      this._time('aoApply', () => this._draw(r, this._quads.aoApply, this.rtLit));
      lit = this.rtLit.texture;
    }

    // 4 — antialiasing.
    let src;
    if (this.useTaa) {
      const cur = this._historyIndex;
      const prev = 1 - cur;
      const u = this._quads.taa.material.uniforms;
      u.tCurrent.value = lit;
      u.tHistory.value = this.rtHistory[prev].texture;
      u.tGBuffer.value = gbuf;
      u.tVelocity.value = vel;
      u.uProjInfo.value.copy(projInfo);
      u.uTexel.value.set(1 / this.width, 1 / this.height);
      u.uFeedback.value = p.taaFeedback;
      u.uValid.value = this._historyValid;
      this._time('taa', () => this._draw(r, this._quads.taa, this.rtHistory[cur]));
      src = this.rtHistory[cur];
      this._historyIndex = prev;
      this._historyValid = 1;
    } else if (this.smaa) {
      // SMAAPass reads readBuffer.texture, so hand it whichever target holds
      // the lit image and let it resolve into the first post ping-pong slot.
      this._time('smaa', () => this.smaa.render(r, this.rtPost[0], lit === this.rtScene.texture ? this.rtScene : this.rtLit));
      src = this.rtPost[0];
    } else {
      src = lit === this.rtScene.texture ? this.rtScene : this.rtLit;
    }

    let ping = src === this.rtPost[0] ? 1 : 0;
    const next = () => { const t = this.rtPost[ping]; ping = 1 - ping; return t; };

    // 5 — motion blur.
    if (p.motionBlur && this.mrt) {
      const u = this._quads.motion.material.uniforms;
      u.tDiffuse.value = src.texture;
      u.tGBuffer.value = gbuf;
      u.tVelocity.value = vel;
      u.uProjInfo.value.copy(projInfo);
      u.uTexel.value.set(1 / this.width, 1 / this.height);
      u.uStrength.value = p.motionBlurStrength;
      u.uFrame.value = this._frame;
      const dst = next();
      this._time('motionBlur', () => this._draw(r, this._quads.motion, dst));
      src = dst;
    }

    // 6 — depth of field.
    if (p.dof && this.mrt) {
      this._time('dof', () => { src = this._renderDOF(r, src, gbuf, vel, projInfo); });
      ping = src === this.rtPost[0] ? 1 : 0;
    }

    // 7 — bloom.
    if (p.bloom) this._time('bloom', () => this._renderBloom(r, src));

    // 8 — grade to screen.
    const g = this._quads.grade.material.uniforms;
    g.tDiffuse.value = src.texture;
    g.tBloom.value = this.rtBloom[0].texture;
    g.uResolution.value.set(this.width, this.height);
    g.uTime.value = this._t;
    g.uExposure.value = p.exposure;
    g.uBloomStrength.value = p.bloom ? p.bloomStrength : 0.0;
    g.uChromatic.value = p.chromatic;
    g.uDistortion.value = p.distortion;
    g.uSharpen.value = p.sharpen;
    g.uLutMix.value = p.lut;
    g.uVignette.value = p.vignette;
    g.uGrain.value = p.grain;
    g.uSaturation.value = p.saturation;
    g.uContrast.value = p.contrast;
    g.uLift.value.setScalar(p.lift);
    this._time('grade', () => this._draw(r, this._quads.grade, null));

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.setClearColor(this._savedClear, prevClearAlpha);
  }

  dispose() {
    this._disposeTargets();
    for (const q of Object.values(this._quads)) q.material.dispose();
    this.gbufferPass?.dispose();
    this.smaa?.dispose?.();
    this.lut.dispose();
  }

  /* -------------------- internals -------------------- */

  _draw(renderer, quad, target, clear = true) {
    renderer.setRenderTarget(target);
    renderer.autoClear = clear;
    quad.render(renderer);
  }

  /**
   * Wall-clock cost of one stage. Off by default; flipping `profile` on makes
   * every stage flush the driver so the numbers attribute to the right pass
   * instead of piling up on whichever call happens to block.
   */
  _time(label, fn) {
    if (!this.profile) { fn(); return; }
    const gl = this.engine.renderer.getContext();
    const t0 = performance.now();
    fn();
    gl.finish();
    this.timings[label] = (this.timings[label] || 0) * 0.7 + (performance.now() - t0) * 0.3;
  }

  /** tan(fov/2) for the world camera, used to rebuild view rays from depth. */
  _projInfo() {
    const cam = this.engine.camera;
    const ty = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    return this._tmpProjInfo.set(ty * cam.aspect, ty);
  }

  _updateMatrices() {
    const e = this.engine;
    const m = this._matrices;
    e.camera.updateMatrixWorld();
    e.viewCamera.updateMatrixWorld();
    e.camera.matrixWorldInverse.copy(e.camera.matrixWorld).invert();
    e.viewCamera.matrixWorldInverse.copy(e.viewCamera.matrixWorld).invert();
    m.prevVP.copy(m.curVP);
    m.prevVPView.copy(m.curVPView);
    m.curVP.multiplyMatrices(e.camera.projectionMatrix, e.camera.matrixWorldInverse);
    m.curVPView.multiplyMatrices(e.viewCamera.projectionMatrix, e.viewCamera.matrixWorldInverse);
    if (this._frame <= 1) { m.prevVP.copy(m.curVP); m.prevVPView.copy(m.curVPView); }
  }

  /**
   * Sub-pixel projection offset from a Halton(2,3) sequence. Shifting the
   * clip-space x/y of the projection is equivalent to moving the whole camera
   * by a fraction of a pixel, which is what gives TAA new samples to integrate.
   */
  _pushJitter() {
    const e = this.engine;
    const s = this._savedProj;
    const a = e.camera.projectionMatrix.elements;
    const b = e.viewCamera.projectionMatrix.elements;
    s[0] = a[8]; s[1] = a[9]; s[2] = b[8]; s[3] = b[9];
    if (!this.useTaa) return;

    const i = this._frame % 16;
    const ox = this._haltonX[i] - 0.5;
    const oy = this._haltonY[i] - 0.5;
    this._jitter.set((2 * ox) / this.width, (2 * oy) / this.height);
    a[8] += this._jitter.x; a[9] += this._jitter.y;
    b[8] += this._jitter.x; b[9] += this._jitter.y;
    e.camera.projectionMatrixInverse.copy(e.camera.projectionMatrix).invert();
    e.viewCamera.projectionMatrixInverse.copy(e.viewCamera.projectionMatrix).invert();
  }

  _popJitter() {
    const e = this.engine;
    const s = this._savedProj;
    const a = e.camera.projectionMatrix.elements;
    const b = e.viewCamera.projectionMatrix.elements;
    a[8] = s[0]; a[9] = s[1]; b[8] = s[2]; b[9] = s[3];
    e.camera.projectionMatrixInverse.copy(e.camera.projectionMatrix).invert();
    e.viewCamera.projectionMatrixInverse.copy(e.viewCamera.projectionMatrix).invert();
  }

  _renderAO(renderer, gbuf, vel, projInfo) {
    const p = this.params;
    const aoW = this.rtAO[0].width, aoH = this.rtAO[0].height;
    const u = this._quads.gtao.material.uniforms;
    u.tGBuffer.value = gbuf;
    u.tVelocity.value = vel;
    u.uProjInfo.value.copy(projInfo);
    u.uResolution.value.set(aoW, aoH);
    // Pixels per metre at one metre: half the buffer height over tan(fov/2).
    u.uProjScale.value = (aoH * 0.5) / projInfo.y;
    u.uRadius.value = p.aoRadius;
    u.uBias.value = p.aoBias;
    u.uMaxRadiusPx.value = aoH * 0.12;
    u.uPower.value = p.aoPower;
    u.uFrame.value = this._frame;
    this._draw(renderer, this._quads.gtao, this.rtAO[0]);

    const b = this._quads.aoBlur.material.uniforms;
    b.uTexel.value.set(1 / aoW, 1 / aoH);
    for (let i = 0; i < this.tier.aoBlur; i++) {
      b.tAO.value = this.rtAO[0].texture;
      b.uDirection.value.set(1, 0);
      this._draw(renderer, this._quads.aoBlur, this.rtAO[1]);
      b.tAO.value = this.rtAO[1].texture;
      b.uDirection.value.set(0, 1);
      this._draw(renderer, this._quads.aoBlur, this.rtAO[0]);
    }

    if (!p.contact) return;
    const c = this._quads.contact.material.uniforms;
    c.tGBuffer.value = gbuf;
    c.tVelocity.value = vel;
    c.uProjInfo.value.copy(projInfo);
    c.uResolution.value.set(this.width, this.height);
    // Full-res pixels per metre at one metre — this pass is not downsampled, so
    // it must not inherit the AO buffer's scale.
    c.uProjScale.value = (this.height * 0.5) / projInfo.y;
    c.uRadius.value = p.contactRadius;
    c.uBias.value = p.contactBias;
    c.uIntensity.value = p.contactIntensity;
    c.uMaxRadiusPx.value = this.height * 0.058;
    // Sun direction in view space. The sky owns it and it points *toward* the
    // sun, which is the direction a shadow ray marches. Without a sky the trace
    // has no light to aim at and switches itself off rather than guessing.
    if (this.sky?.sunDirection) {
      c.uSunView.value.copy(this.sky.sunDirection)
        .transformDirection(this.engine.camera.matrixWorldInverse);
      c.uRayStrength.value = p.contactShadow ? p.contactShadowStrength : 0.0;
    } else {
      c.uRayStrength.value = 0.0;
    }
    c.uRayRange.value = p.contactShadowRange;
    c.uRayThickness.value = p.contactShadowThickness;
    // Rotating the tap set per frame is only free when something integrates the
    // frames. With TAA off the rotation is held still, trading a fixed dither
    // for occlusion that crawls over every static surface as you stand there.
    c.uFrame.value = this.useTaa ? this._frame : 0;
    this._draw(renderer, this._quads.contact, this.rtContact);
  }

  _renderDOF(renderer, src, gbuf, vel, projInfo) {
    const p = this.params;
    const cur = this._focusIndex, prev = 1 - cur;

    const f = this._quads.focus.material.uniforms;
    f.tGBuffer.value = gbuf;
    f.tVelocity.value = vel;
    f.tPrevFocus.value = this.rtFocus[prev].texture;
    f.uProjInfo.value.copy(projInfo);
    f.uValid.value = this._focusValid;
    this._draw(renderer, this._quads.focus, this.rtFocus[cur]);
    this._focusIndex = prev;
    this._focusValid = 1;
    const focusTex = this.rtFocus[cur].texture;

    const d = this._quads.dofDown.material.uniforms;
    d.tDiffuse.value = src.texture;
    d.tGBuffer.value = gbuf;
    d.tVelocity.value = vel;
    d.tFocus.value = focusTex;
    d.uProjInfo.value.copy(projInfo);
    d.uTexel.value.set(1 / this.width, 1 / this.height);
    d.uNearScale.value = p.dofNear;
    d.uFarScale.value = p.dofFar;
    d.uMaxCoc.value = p.dofMaxCoc;
    this._draw(renderer, this._quads.dofDown, this.rtDof[0]);

    const b = this._quads.dofBlur.material.uniforms;
    b.tDof.value = this.rtDof[0].texture;
    b.uTexel.value.set(1 / this.rtDof[0].width, 1 / this.rtDof[0].height);
    b.uMaxCoc.value = p.dofMaxCoc;
    b.uFrame.value = this._frame;
    this._draw(renderer, this._quads.dofBlur, this.rtDof[1]);

    const c = this._quads.dofComposite.material.uniforms;
    c.tDiffuse.value = src.texture;
    c.tBlur.value = this.rtDof[1].texture;
    c.tGBuffer.value = gbuf;
    c.tVelocity.value = vel;
    c.tFocus.value = focusTex;
    c.uProjInfo.value.copy(projInfo);
    c.uNearScale.value = p.dofNear;
    c.uFarScale.value = p.dofFar;
    c.uMaxCoc.value = p.dofMaxCoc;
    const dst = src === this.rtPost[0] ? this.rtPost[1] : this.rtPost[0];
    this._draw(renderer, this._quads.dofComposite, dst);
    return dst;
  }

  _renderBloom(renderer, src) {
    const p = this.params;
    const mips = this.rtBloom;

    const pre = this._quads.bloomPre.material.uniforms;
    pre.tDiffuse.value = src.texture;
    pre.uTexel.value.set(1 / this.width, 1 / this.height);
    pre.uThreshold.value = p.bloomThreshold;
    pre.uKnee.value = p.bloomKnee;
    this._draw(renderer, this._quads.bloomPre, mips[0]);

    const down = this._quads.bloomDown.material.uniforms;
    for (let i = 1; i < mips.length; i++) {
      down.tDiffuse.value = mips[i - 1].texture;
      down.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      this._draw(renderer, this._quads.bloomDown, mips[i]);
    }

    // Upsample back down the chain, each level blended additively into the one
    // above it. The accumulated tent filters are what give the wide, soft skirt
    // that a single gaussian cannot reach without an enormous kernel, and the
    // additive draw means the whole pyramid needs no scratch targets.
    const up = this._quads.bloomUp.material.uniforms;
    up.uRadius.value = p.bloomRadius;
    for (let i = mips.length - 1; i > 0; i--) {
      up.tLower.value = mips[i].texture;
      up.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      this._draw(renderer, this._quads.bloomUp, mips[i - 1], false);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fsQuad(shader, defines = {}, extra = {}) {
  return new FullScreenQuad(new THREE.ShaderMaterial({
    defines: { ...defines },
    uniforms: THREE.UniformsUtils.clone(shader.uniforms),
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
    depthTest: false,
    depthWrite: false,
    ...extra,
  }));
}

/** Van der Corput / Halton sequence used for the TAA sample pattern. */
function halton(base, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let f = 1, r = 0, n = i + 1;
    while (n > 0) { f /= base; r += f * (n % base); n = Math.floor(n / base); }
    out[i] = r;
  }
  return out;
}

/**
 * Render a known value into a half-float target and read it back. Returns false
 * if the driver silently produces black, which is what some software GL stacks
 * do despite reporting EXT_color_buffer_half_float.
 */
function probeHalfFloat(renderer) {
  const gl = renderer.getContext();
  if (!gl.getExtension('EXT_color_buffer_half_float') && !gl.getExtension('EXT_color_buffer_float')) return false;
  let hdrRT = null, byteRT = null, quad = null;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  try {
    hdrRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
    byteRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });

    renderer.autoClear = false;
    renderer.setRenderTarget(hdrRT);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear(true, false, false);

    // Read back through an 8-bit copy: readPixels on a half-float attachment is
    // not portable, so blit first and sample the format we know we can read.
    quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: hdrRT.texture, toneMapped: false }),
    );
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const scene = new THREE.Scene();
    scene.add(quad);
    renderer.setRenderTarget(byteRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(scene, cam);

    const buf = new Uint8Array(4 * 4 * 4);
    renderer.readRenderTargetPixels(byteRT, 0, 0, 4, 4, buf);
    return buf[0] > 128;
  } catch {
    return false;
  } finally {
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
    quad?.geometry.dispose();
    quad?.material.dispose();
    hdrRT?.dispose();
    byteRT?.dispose();
  }
}

/**
 * Authored 16^3 look-up table, generated rather than downloaded, laid out as a
 * 256x16 atlas of sixteen 16x16 blue slices.
 *
 * The look is the modern military-shooter grade: cyan-steel shadows, a warm
 * midtone so skin and dust stay alive, highlights rolled toward straw and
 * desaturated, and greens pulled to olive. Everything is computed in linear
 * light and re-encoded, so the curve behaves like a real film emulation rather
 * than an sRGB channel twist.
 */
function buildFilmLut(size = 16) {
  const data = new Uint8Array(size * size * size * 4);
  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  const SHADOW = [0.82, 0.97, 1.16];   // cyan-steel
  const HIGH = [1.06, 1.01, 0.90];     // straw

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let c = [
          srgbToLinear(r / (size - 1)),
          srgbToLinear(g / (size - 1)),
          srgbToLinear(b / (size - 1)),
        ];
        const l = lum(c[0], c[1], c[2]);

        // Split tone: weights are built from luminance so the tint follows
        // tonal range rather than hue.
        const sw = 1 - smooth(0.0, 0.22, l);
        const hw = smooth(0.28, 0.9, l);
        for (let i = 0; i < 3; i++) {
          c[i] *= 1 + (SHADOW[i] - 1) * sw * 0.85 + (HIGH[i] - 1) * hw * 0.7;
        }

        // Filmic S-curve about middle grey, applied in log2 exposure space so
        // it compresses shoulder and toe symmetrically.
        for (let i = 0; i < 3; i++) {
          const ev = Math.log2(Math.max(c[i], 1e-5) / 0.18);
          const shaped = ev / (1 + Math.abs(ev) * 0.16) * 1.14;
          c[i] = 0.18 * Math.pow(2, shaped);
        }

        // Pull greens toward olive and take a little life out of pure blues:
        // the palette should read as dust and concrete, not primaries.
        const l2 = lum(c[0], c[1], c[2]);
        const greenBias = Math.max(0, c[1] - Math.max(c[0], c[2])) / Math.max(l2, 1e-4);
        c[0] += c[1] * greenBias * 0.10;
        c[2] -= c[2] * greenBias * 0.14;
        const blueBias = Math.max(0, c[2] - Math.max(c[0], c[1])) / Math.max(l2, 1e-4);
        c[2] -= c[2] * blueBias * 0.06;

        // Highlight desaturation — bright surfaces trend toward the light's
        // colour in every real imaging chain.
        const l3 = lum(c[0], c[1], c[2]);
        const desat = smooth(0.55, 2.2, l3) * 0.45;
        for (let i = 0; i < 3; i++) c[i] += (l3 - c[i]) * desat;

        // Global saturation and a mild toe lift so shadows keep detail.
        const l4 = lum(c[0], c[1], c[2]);
        for (let i = 0; i < 3; i++) {
          c[i] = l4 + (c[i] - l4) * 1.06;
          c[i] = Math.max(0, c[i]) + 0.0035;
        }

        // Atlas is (tileB * 16 + r, g) — matches lutTexel() in the grade shader.
        const px = (g * size * size + b * size + r) * 4;
        data[px + 0] = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(c[0]))));
        data[px + 1] = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(c[1]))));
        data[px + 2] = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(c[2]))));
        data[px + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, size * size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
