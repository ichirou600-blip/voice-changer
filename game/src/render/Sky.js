import * as THREE from 'three';

/**
 * Atmosphere: single-scattering Rayleigh + Mie sky, a baked volumetric cloud
 * layer projected onto a curved shell, the sun direction, height-based aerial
 * perspective and the IBL environment map that lights every PBR surface.
 *
 * The expensive physics runs once per time-of-day change, never per frame:
 *   1. a sky-view LUT is raymarched through the atmosphere on the GPU,
 *   2. a tileable cloud density field is generated from domain-warped FBM,
 *   3. that field is light-marched toward the sun to bake self-shadowing, the
 *      powder/dark-edge term and the silver lining,
 *   4. the resulting dome is convolved into a PMREM probe.
 * Per frame the dome shader costs three texture fetches and some cheap analytic
 * work, which is what makes this affordable on a software rasteriser.
 *
 * CONTRACT:
 *   sky.sunDirection : THREE.Vector3 (normalised, points *toward* the sun)
 *   sky.sunColor     : THREE.Color   (linear, intensity-scaled by Lighting)
 *   sky.ambientColor : THREE.Color
 *   sky.setTimeOfDay(hours)
 *   sky.environment  : THREE.Texture (PMREM) assigned to scene.environment
 *   sky.fogParams    : { density, color, heightFalloff }
 */

// ---------------------------------------------------------------------------
// Medium parameters, Bruneton/Hillaire parameterisation. Lengths are in
// KILOMETRES: at metre scale, dot(p, p) - R*R for a planet-sized sphere loses
// most of its significant digits in a 32-bit float and the ray/sphere tests
// fall apart. Coefficients are per-kilometre to match.
//
// The same table drives the GPU raymarch and the CPU evaluation used for sun
// colour, ambient and fog, so the two can never drift apart.
// ---------------------------------------------------------------------------
const ATMO = {
  rGround: 6360.0,
  rTop: 6420.0,
  betaR: [5.802e-3, 13.558e-3, 33.100e-3], // Rayleigh scattering
  betaMs: 3.996e-3,                        // Mie scattering
  betaMe: 4.440e-3,                        // Mie extinction (scatter + absorb)
  betaO: [0.650e-3, 1.881e-3, 0.085e-3],   // ozone absorption
  hR: 8.0,                                 // Rayleigh scale height
  hM: 1.2,                                 // Mie scale height
  ozoneCenter: 25.0,
  ozoneWidth: 15.0,
  mieG: 0.76,                              // Henyey-Greenstein asymmetry
  viewAltitude: 0.04,                      // observer height above sea level
  viewSteps: 16,
  sunSteps: 8,
};

/** GLSL needs an explicit decimal point or exponent on every float literal. */
const glslFloat = (x) => Number(x).toExponential(6).replace('e+', 'e');

const SKY_LUT_RANGE = 6.0;
const SKY_LUT_W = 256;
const SKY_LUT_H = 160;
const TRANS_LUT_W = 128;
const TRANS_LUT_H = 48;
const CLOUD_TILE_KM = 9.0;
const CLOUD_BASE_KM = 1.75;
const CIRRUS_BASE_KM = 7.2;
const CLOUD_TEX_SIZE = 512;

const ATMO_GLSL = /* glsl */`
  #define PI 3.141592653589793
  const float R_GROUND = ${glslFloat(ATMO.rGround)};
  const float R_TOP    = ${glslFloat(ATMO.rTop)};
  const vec3  BETA_R   = vec3(${glslFloat(ATMO.betaR[0])}, ${glslFloat(ATMO.betaR[1])}, ${glslFloat(ATMO.betaR[2])});
  const float BETA_M_S = ${glslFloat(ATMO.betaMs)};
  const float BETA_M_E = ${glslFloat(ATMO.betaMe)};
  const vec3  BETA_O   = vec3(${glslFloat(ATMO.betaO[0])}, ${glslFloat(ATMO.betaO[1])}, ${glslFloat(ATMO.betaO[2])});
  const float H_R      = ${glslFloat(ATMO.hR)};
  const float H_M      = ${glslFloat(ATMO.hM)};
  const float OZ_C     = ${glslFloat(ATMO.ozoneCenter)};
  const float OZ_W     = ${glslFloat(ATMO.ozoneWidth)};
  const float MIE_G    = ${glslFloat(ATMO.mieG)};
  const float VIEW_ALT = ${glslFloat(ATMO.viewAltitude)};

  uniform float uTurbidity;     // aerosol load; 1 = pristine, 8 = industrial haze
  uniform float uSunIrradiance; // scales physical radiance into render units
  uniform float uMultiScatter;  // strength of the multiple-scattering fudge
  uniform vec3  uGroundTint;    // ambient bounce colour under the horizon

  float hgPhase(float mu, float g) {
    float g2 = g * g;
    float d = 1.0 + g2 - 2.0 * g * mu;
    return (1.0 - g2) / (4.0 * PI * d * sqrt(max(d, 1e-4)));
  }

  // Near/far intersection of a ray with a sphere centred on the origin.
  // Returns (1, -1) — an empty interval — when the ray misses.
  vec2 raySphere(vec3 ro, vec3 rd, float R) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - R * R;
    float d = b * b - c;
    if (d < 0.0) return vec2(1.0, -1.0);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }

  // Turbidity is the ratio of total to molecular optical thickness, so the
  // aerosol column scales roughly linearly with (T - 1).
  float mieDensityScale() { return max(0.05, (uTurbidity - 1.0) * 0.75); }

  vec3 mediumDensity(float h) {
    return vec3(
      exp(-h / H_R),
      exp(-h / H_M) * mieDensityScale(),
      max(0.0, 1.0 - abs(h - OZ_C) / OZ_W));
  }

  // Transmittance is tabulated rather than marched inline. GLSL ES 1.00 forces
  // constant loop bounds, so the translator fully unrolls them: a 16-step view
  // march with a 5-step sun march nested inside expands to a single basic block
  // of ~10k instructions, and the software rasteriser's JIT spends minutes
  // optimising it. Factoring the inner march into a LUT keeps both shaders
  // small, and buys a finer sun march for free.
  uniform sampler2D tTransmittance;

  // (altitude, cos of sun zenith) -> exp(-opticalDepth) to space. The mu_s axis
  // is warped so texels bunch up around the horizon, where the slant path — and
  // therefore the reddening — changes fastest.
  vec2 transmittanceUv(float r, float mus) {
    float h = clamp(r - R_GROUND, 0.0, R_TOP - R_GROUND);
    return vec2(
      clamp((1.0 - exp(-3.0 * mus - 0.6)) / ${glslFloat(1 - Math.exp(-3.6))}, 0.0, 1.0),
      sqrt(h / (R_TOP - R_GROUND)));
  }

  vec3 sunTransmittance(vec3 p, vec3 sd) {
    // Soft planet terminator. A hard occlusion test draws a razor line across
    // the sky at sunset; widening it by a degree or so stands in for the
    // penumbra plus the multiple scattering that keeps twilight lit.
    float r = length(p);
    float mus = dot(p / r, sd);
    float cosHorizon = -sqrt(max(0.0, 1.0 - (R_GROUND * R_GROUND) / (r * r)));
    float shadow = smoothstep(cosHorizon - 0.03, cosHorizon + 0.02, mus);
    if (shadow <= 0.0) return vec3(0.0);
    vec3 t = texture2D(tTransmittance, transmittanceUv(r, mus)).rgb;
    return t * t * shadow; // LUT is gamma-2 encoded to survive 8 bits
  }

  // Single-scattering integral along a view ray, plus an isotropic term that
  // stands in for the higher orders we do not trace. Without it the sky reads
  // far too dark away from the sun and twilight collapses to black.
  vec3 skyRadiance(vec3 rd, vec3 sd) {
    vec3 ro = vec3(0.0, R_GROUND + VIEW_ALT, 0.0);
    float tMax = raySphere(ro, rd, R_TOP).y;
    vec2 tG = raySphere(ro, rd, R_GROUND);
    bool hitsGround = tG.x > 0.0;
    if (hitsGround) tMax = min(tMax, tG.x);

    float mu = dot(rd, sd);
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    float phaseM = hgPhase(mu, MIE_G);

    vec3 od = vec3(0.0), sumR = vec3(0.0), sumM = vec3(0.0), msR = vec3(0.0), msM = vec3(0.0);
    float prev = 0.0;
    for (int i = 0; i < ${ATMO.viewSteps}; i++) {
      // Same reasoning as above: almost all of the scattering mass is in the
      // first few kilometres, while a horizon ray is hundreds of km long.
      float k = (float(i) + 1.0) / float(${ATMO.viewSteps});
      float t = tMax * k * k;
      float dt = t - prev;
      vec3 p = ro + rd * (prev + dt * 0.5);
      prev = t;

      vec3 d = mediumDensity(max(0.0, length(p) - R_GROUND)) * dt;
      od += BETA_R * d.x + vec3(BETA_M_E) * d.y + BETA_O * d.z;
      vec3 trView = exp(-od);
      vec3 trSun = sunTransmittance(p, sd);
      sumR += trView * trSun * d.x;
      sumM += trView * trSun * d.y;
      msR += trView * d.x;
      msM += trView * d.y;
    }

    vec3 L = BETA_R * phaseR * sumR + vec3(BETA_M_S) * phaseM * sumM;
    vec3 sunAtGround = texture2D(tTransmittance, transmittanceUv(R_GROUND + VIEW_ALT, sd.y)).rgb;
    sunAtGround *= sunAtGround;
    // Higher scattering orders arrive from every direction, so they carry the
    // isotropic phase 1/4pi. Leaving that factor out inflates the whole sky by
    // more than an order of magnitude relative to the single-scattering term.
    // Achromatic drive for the multiple-scattering term — see the CPU mirror.
    // Multiply-scattered light has lost the direct beam's directional
    // character, and its spectrum comes from the scattering coefficient rather
    // than one path's transmittance. Modulating per channel by the reddened
    // beam cancels exactly the blue Rayleigh produces and peaks the result in
    // green, which tints the horizon and the fog colour.
    float sunAtGroundMean = (sunAtGround.r + sunAtGround.g + sunAtGround.b) / 3.0;
    L += (BETA_R * msR + vec3(BETA_M_S) * msM) * (uMultiScatter / (4.0 * PI)) * sunAtGroundMean
       * max(0.0, sd.y + 0.12);

    // Rays that terminate on the planet pick up a dim lambertian bounce, which
    // is what stops the sky reading as a hard-edged dome at the horizon line.
    if (hitsGround) L += uGroundTint * exp(-od) * max(0.0, sd.y);

    return L * uSunIrradiance;
  }
`;

// ---------------------------------------------------------------------------
// CPU mirror of the model above: sun colour, hemisphere ambient and the
// aerial-perspective basis colours all have to be known outside the shader.
// ---------------------------------------------------------------------------
function mieScaleJS(turbidity) { return Math.max(0.05, (turbidity - 1.0) * 0.75); }

function densityJS(h, mieScale) {
  return [
    Math.exp(-h / ATMO.hR),
    Math.exp(-h / ATMO.hM) * mieScale,
    Math.max(0, 1 - Math.abs(h - ATMO.ozoneCenter) / ATMO.ozoneWidth),
  ];
}

function raySphereJS(ro, rd, R) {
  const b = ro[0] * rd[0] + ro[1] * rd[1] + ro[2] * rd[2];
  const c = ro[0] * ro[0] + ro[1] * ro[1] + ro[2] * ro[2] - R * R;
  let d = b * b - c;
  if (d < 0) return [1, -1];
  d = Math.sqrt(d);
  return [-b - d, -b + d];
}

function smoothstepJS(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const clampRGB = (c, hi) => c.map((x) => Math.min(hi, Math.max(0, x)));

function normalize3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** exp(-opticalDepth) from p toward the sun, ignoring planet occlusion. */
function sunTransmittanceJS(p, sd, mieScale) {
  const tTop = raySphereJS(p, sd, ATMO.rTop)[1];
  const od = [0, 0, 0];
  let prev = 0;
  for (let i = 0; i < ATMO.sunSteps; i++) {
    const k = (i + 1) / ATMO.sunSteps;
    const t = tTop * k * k;
    const dt = t - prev;
    const s = prev + dt * 0.5;
    prev = t;
    const q = [p[0] + sd[0] * s, p[1] + sd[1] * s, p[2] + sd[2] * s];
    const d = densityJS(Math.max(0, Math.hypot(q[0], q[1], q[2]) - ATMO.rGround), mieScale);
    for (let c = 0; c < 3; c++) {
      od[c] += (ATMO.betaR[c] * d[0] + ATMO.betaMe * d[1] + ATMO.betaO[c] * d[2]) * dt;
    }
  }
  return [Math.exp(-od[0]), Math.exp(-od[1]), Math.exp(-od[2])];
}

function skyRadianceJS(rd, sd, opts) {
  const { turbidity, irradiance, multiScatter, groundTint } = opts;
  const mieScale = mieScaleJS(turbidity);
  const ro = [0, ATMO.rGround + ATMO.viewAltitude, 0];
  let tMax = raySphereJS(ro, rd, ATMO.rTop)[1];
  const tG = raySphereJS(ro, rd, ATMO.rGround);
  const hitsGround = tG[0] > 0;
  if (hitsGround) tMax = Math.min(tMax, tG[0]);

  const mu = rd[0] * sd[0] + rd[1] * sd[1] + rd[2] * sd[2];
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g2 = ATMO.mieG * ATMO.mieG;
  const dd = 1 + g2 - 2 * ATMO.mieG * mu;
  const phaseM = (1 - g2) / (4 * Math.PI * dd * Math.sqrt(Math.max(dd, 1e-4)));

  const od = [0, 0, 0], sumR = [0, 0, 0], sumM = [0, 0, 0], msR = [0, 0, 0], msM = [0, 0, 0];
  let prev = 0;
  for (let i = 0; i < ATMO.viewSteps; i++) {
    const k = (i + 1) / ATMO.viewSteps;
    const t = tMax * k * k;
    const dt = t - prev;
    const s = prev + dt * 0.5;
    prev = t;
    const p = [ro[0] + rd[0] * s, ro[1] + rd[1] * s, ro[2] + rd[2] * s];
    const r = Math.hypot(p[0], p[1], p[2]);
    const d = densityJS(Math.max(0, r - ATMO.rGround), mieScale);
    const cosHorizon = -Math.sqrt(Math.max(0, 1 - (ATMO.rGround * ATMO.rGround) / (r * r)));
    const cosSun = (p[0] * sd[0] + p[1] * sd[1] + p[2] * sd[2]) / r;
    const shadow = smoothstepJS(cosHorizon - 0.03, cosHorizon + 0.02, cosSun);
    const trSun = shadow > 0 ? sunTransmittanceJS(p, sd, mieScale) : [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      od[c] += (ATMO.betaR[c] * d[0] + ATMO.betaMe * d[1] + ATMO.betaO[c] * d[2]) * dt;
      const trView = Math.exp(-od[c]);
      sumR[c] += trView * trSun[c] * shadow * d[0] * dt;
      sumM[c] += trView * trSun[c] * shadow * d[1] * dt;
      msR[c] += trView * d[0] * dt;
      msM[c] += trView * d[1] * dt;
    }
  }

  const sunGround = sunTransmittanceJS(ro, sd, mieScale);
  // Multiply-scattered light has already lost the direct beam's directional
  // character, and its spectrum comes from the scattering coefficient rather
  // than from one path's transmittance. Modulating it per channel by the
  // reddened beam cancels exactly the blue that Rayleigh produces, peaking the
  // result in green — measured fog came out (0.62, 0.84, 0.77), green above
  // blue, which no physical sky does. Drive the magnitude achromatically and
  // let betaR carry the hue. Must match the GPU dome.
  const sunGroundMean = (sunGround[0] + sunGround[1] + sunGround[2]) / 3;
  const msGate = Math.max(0, sd[1] + 0.12);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] = ATMO.betaR[c] * phaseR * sumR[c] + ATMO.betaMs * phaseM * sumM[c];
    out[c] += (ATMO.betaR[c] * msR[c] + ATMO.betaMs * msM[c])
      * (multiScatter / (4 * Math.PI)) * sunGroundMean * msGate;
    if (hitsGround) out[c] += groundTint[c] * Math.exp(-od[c]) * Math.max(0, sd[1]);
    out[c] *= irradiance;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Periodic gradient noise. Every octave wraps on an integer lattice period so
// the baked cloud tile is seamless — including after domain warping, because
// the warp field shares that period and therefore wraps with it.
// ---------------------------------------------------------------------------
const NOISE_GLSL = /* glsl */`
  vec2 noiseGrad(vec2 i, float seed) {
    vec3 p3 = fract(vec3(i.x, i.y, i.x + i.y) * vec3(0.1031, 0.1030, 0.0973) + seed);
    p3 += dot(p3, p3.yzx + 19.19);
    vec2 r = fract(vec2((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y)) * 2.0 - 1.0;
    return r * inversesqrt(max(dot(r, r), 1e-4));
  }

  float pnoise(vec2 x, vec2 period, float seed) {
    vec2 i = floor(x), fr = fract(x);
    vec2 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
    float a = dot(noiseGrad(mod(i, period), seed), fr);
    float b = dot(noiseGrad(mod(i + vec2(1.0, 0.0), period), seed), fr - vec2(1.0, 0.0));
    float c = dot(noiseGrad(mod(i + vec2(0.0, 1.0), period), seed), fr - vec2(0.0, 1.0));
    float d = dot(noiseGrad(mod(i + vec2(1.0, 1.0), period), seed), fr - vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 0.7071 + 0.5;
  }

  // The loop bound is what the translator unrolls against, not the octave
  // count, so it is kept as tight as the deepest caller actually needs.
  float fbm(vec2 x, vec2 period, int octaves, float seed) {
    float amp = 0.5, sum = 0.0, norm = 0.0;
    for (int i = 0; i < 5; i++) {
      if (i >= octaves) break;
      sum += amp * pnoise(x, period, seed + float(i) * 7.13);
      norm += amp;
      amp *= 0.5;
      x *= 2.0;
      period *= 2.0;
    }
    return sum / norm;
  }

  float remap(float v, float lo, float hi) {
    return clamp((v - lo) / max(hi - lo, 1e-4), 0.0, 1.0);
  }

  /** Sub-LSB noise so smooth ramps do not contour when written to 8 bits. */
  float dither255(vec2 uv) {
    return (fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  }
`;

const FULLSCREEN_VS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------
// Aerial perspective. three's stock fog is one flat colour on a straight depth
// ramp; real distance haze takes the colour of the sky you are looking through
// and thins out with altitude. These replacement chunks are installed globally
// so every fogged material in the scene picks them up.
// ---------------------------------------------------------------------------
const AERIAL_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif
`;

const AERIAL_VERTEX = /* glsl */`
#ifdef USE_FOG
  // mat3(viewMatrix) is orthonormal, so post-multiplying by it applies the
  // inverse rotation and takes the view-space point back to world space. This
  // works in every shader that includes <fog_vertex>, including sprites and
  // points, which never define "transformed" or "worldPosition".
  vFogWorldPos = cameraPosition + mvPosition.xyz * mat3(viewMatrix);
#endif
`;

const AERIAL_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif

  uniform vec3 uAerialZenith;
  uniform vec3 uAerialHorizon;
  uniform vec3 uAerialSunHorizon;
  uniform vec3 uAerialInscatter;
  uniform vec3 uAerialSunDir;
  uniform float uAerialHeightFalloff;
  uniform float uAerialDensity;
  uniform float uAerialMaxOpacity;

  // Cheap reconstruction of the dome radiance. Three measured samples of the
  // real scattering solution (zenith, horizon away from the sun, horizon toward
  // the sun) plus a forward Mie lobe track the sky closely enough for haze at a
  // fraction of the raymarch cost — and this runs on every lit fragment.
  vec3 aerialSky(vec3 dir) {
    float up = clamp(dir.y, 0.0, 1.0);
    float cs = dot(dir, uAerialSunDir);
    vec3 horizon = mix(uAerialHorizon, uAerialSunHorizon, smoothstep(-0.25, 0.95, cs));
    vec3 col = mix(horizon, uAerialZenith, pow(up, 0.55));
    return col + uAerialInscatter * pow(max(cs, 0.0), 8.0);
  }

  vec3 applyAerialPerspective(vec3 base) {
    vec3 delta = vFogWorldPos - cameraPosition;
    float dist = max(length(delta), 1e-3);
    vec3 dir = delta / dist;

    // Analytic optical depth through an exponentially stratified medium:
    //   od = rho0 * exp(-k*y0) * (1 - exp(-k*dy*d)) / (k*dy)
    // with the dy -> 0 case falling back to constant density.
    float k = uAerialHeightFalloff;
    float ky = k * dir.y * dist;
    float ramp = abs(ky) > 1e-3 ? (1.0 - exp(-ky)) / (k * dir.y) : dist;
    float od = uAerialDensity * exp(-k * cameraPosition.y) * ramp;
    float amount = (1.0 - exp(-od)) * uAerialMaxOpacity;
    if (amount < 0.002) return base;
    return mix(base, aerialSky(dir), amount);
  }
#endif
`;

const AERIAL_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  gl_FragColor.rgb = applyAerialPerspective(gl_FragColor.rgb);
#endif
`;

/** Uniform names this module adds to every fog-enabled material. */
const AERIAL_UNIFORM_NAMES = [
  'uAerialZenith', 'uAerialHorizon', 'uAerialSunHorizon', 'uAerialInscatter',
  'uAerialSunDir', 'uAerialHeightFalloff', 'uAerialDensity', 'uAerialMaxOpacity',
];

function aerialDefaults() {
  return {
    uAerialZenith: { value: new THREE.Color(0.05, 0.11, 0.26) },
    uAerialHorizon: { value: new THREE.Color(0.35, 0.44, 0.58) },
    uAerialSunHorizon: { value: new THREE.Color(0.62, 0.58, 0.52) },
    uAerialInscatter: { value: new THREE.Color(0.10, 0.08, 0.06) },
    uAerialSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uAerialHeightFalloff: { value: 0.022 },
    uAerialDensity: { value: 0.0032 },
    uAerialMaxOpacity: { value: 0.94 },
  };
}

let aerialInstalled = false;
let stockFogChunks = null;

/**
 * Swap three's fog chunks for the aerial-perspective versions and register the
 * extra uniforms with every built-in shader, so materials created later inherit
 * them through the normal ShaderLib clone path.
 */
function installAerialPerspective() {
  if (aerialInstalled) return;
  aerialInstalled = true;

  stockFogChunks = {
    fog_pars_vertex: THREE.ShaderChunk.fog_pars_vertex,
    fog_vertex: THREE.ShaderChunk.fog_vertex,
    fog_pars_fragment: THREE.ShaderChunk.fog_pars_fragment,
    fog_fragment: THREE.ShaderChunk.fog_fragment,
  };
  THREE.ShaderChunk.fog_pars_vertex = AERIAL_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = AERIAL_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = AERIAL_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = AERIAL_FRAGMENT;

  Object.assign(THREE.UniformsLib.fog, aerialDefaults());
  for (const key of Object.keys(THREE.ShaderLib)) {
    const uniforms = THREE.ShaderLib[key].uniforms;
    if (uniforms && uniforms.fogColor) Object.assign(uniforms, aerialDefaults());
  }
}

function uninstallAerialPerspective() {
  if (!aerialInstalled) return;
  Object.assign(THREE.ShaderChunk, stockFogChunks);
  for (const name of AERIAL_UNIFORM_NAMES) {
    delete THREE.UniformsLib.fog[name];
    for (const key of Object.keys(THREE.ShaderLib)) {
      const uniforms = THREE.ShaderLib[key].uniforms;
      if (uniforms) delete uniforms[name];
    }
  }
  aerialInstalled = false;
  stockFogChunks = null;
}

export class Sky {
  constructor(engine, { timeOfDay = 8.4, turbidity = 2.6, coverage = 0.52 } = {}) {
    this.engine = engine;
    this.timeOfDay = timeOfDay;
    this.turbidity = turbidity;
    this.coverage = coverage;

    this.sunDirection = new THREE.Vector3(0.4, 0.5, 0.6).normalize();
    this.sunColor = new THREE.Color(1.0, 0.93, 0.82);
    this.ambientColor = new THREE.Color(0.35, 0.42, 0.55);
    this.fogParams = {
      density: 0.0032,
      color: new THREE.Color(0.55, 0.62, 0.72),
      heightFalloff: 0.022,
    };

    // Radiance scaling. The scattering integral is dimensionless; `irradiance`
    // is the single factor that maps it into render units, calibrated so a
    // clear midday zenith lands near 0.25 linear and the horizon near 0.5 —
    // comfortably inside the ACES shoulder. Everything the class publishes
    // (dome, fog, ambient, cloud light) is derived from that same solution, so
    // one number controls the exposure of the whole atmosphere.
    this.exposure = { irradiance: 9.0, multiScatter: 1.4, sunDisc: 22.0 };
    this._groundTint = new THREE.Color(0.09, 0.085, 0.075);

    installAerialPerspective();

    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.Camera();
    this._quadGeometry = new THREE.PlaneGeometry(2, 2);
    this._quadMesh = new THREE.Mesh(this._quadGeometry, null);
    this._quadMesh.frustumCulled = false;
    this._quadScene.add(this._quadMesh);

    this._buildTransmittanceLut();
    this._buildSkyLut();
    this._buildCloudBakers();
    this._buildDome();

    this.pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.pmrem.compileEquirectangularShader();
    this._envScene = new THREE.Scene();
    this._envMesh = new THREE.Mesh(this.mesh.geometry, this.material);
    this._envMesh.frustumCulled = false;
    this._envScene.add(this._envMesh);

    engine.scene.fog = new THREE.FogExp2(this.fogParams.color.getHex(), this.fogParams.density);

    this._cloudDrift = new THREE.Vector2();
    this._cirrusDrift = new THREE.Vector2();

    // Both of these are independent of the sun, so they are baked exactly once.
    this._renderInto(this._transLutMaterial, this._transLutRT);
    this._bakeCloudShape();
    this.setTimeOfDay(timeOfDay);
  }

  // -------------------------------------------------------------------------
  // Resource construction
  // -------------------------------------------------------------------------

  _buildTransmittanceLut() {
    this._transLutRT = new THREE.WebGLRenderTarget(TRANS_LUT_W, TRANS_LUT_H, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });

    this._transLutMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { uTurbidity: { value: this.turbidity } },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        ${ATMO_GLSL}

        void main() {
          // Invert transmittanceUv: recover altitude and sun zenith cosine.
          float h = vUv.y * vUv.y * (R_TOP - R_GROUND);
          float mus = -(log(max(1e-6, 1.0 - vUv.x * ${glslFloat(1 - Math.exp(-3.6))})) + 0.6) / 3.0;

          vec3 p = vec3(0.0, R_GROUND + h, 0.0);
          vec3 sd = vec3(sqrt(max(0.0, 1.0 - mus * mus)), mus, 0.0);

          // Quadratic spacing: a grazing ray is hundreds of km long but all of
          // its mass sits in the first few, and uniform steps miss it badly.
          float tTop = raySphere(p, sd, R_TOP).y;
          vec3 od = vec3(0.0);
          float prev = 0.0;
          for (int i = 0; i < ${ATMO.sunSteps}; i++) {
            float k = (float(i) + 1.0) / float(${ATMO.sunSteps});
            float t = tTop * k * k;
            float dt = t - prev;
            vec3 q = p + sd * (prev + dt * 0.5);
            prev = t;
            vec3 d = mediumDensity(max(0.0, length(q) - R_GROUND));
            od += (BETA_R * d.x + vec3(BETA_M_E) * d.y + BETA_O * d.z) * dt;
          }
          gl_FragColor = vec4(sqrt(exp(-od)), 1.0);
        }`,
    });
  }

  _buildSkyLut() {
    // Sky-view LUT. u runs from "toward the sun" to "away from the sun" — the
    // atmosphere is symmetric about the solar meridian, so half the sphere is
    // all we need — and v uses a signed-quadratic elevation warp that packs
    // texels into the horizon band where the whole gradient lives.
    //
    // Stored gamma-2 encoded in RGBA8 rather than half float: colour-renderable
    // float targets are the first thing a software GL stack lies about, and the
    // dither in the bake makes the 8-bit quantisation invisible anyway.
    this._skyLutRT = new THREE.WebGLRenderTarget(SKY_LUT_W, SKY_LUT_H, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });

    this._skyLutMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        tTransmittance: { value: this._transLutRT.texture },
        uTurbidity: { value: this.turbidity },
        uSunIrradiance: { value: this.exposure.irradiance },
        uMultiScatter: { value: this.exposure.multiScatter },
        uGroundTint: { value: this._groundTint.clone() },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform vec3 uSunDir;
        ${ATMO_GLSL}
        ${NOISE_GLSL}

        void main() {
          // Inverse of the dome-side parameterisation. Both warps are chosen so
          // the lookup costs a sqrt instead of an asin/acos: elevation is warped
          // on sin(elev) and azimuth on sin(phi/2), which still concentrates
          // texels at the horizon and around the sun where the gradients are.
          float s = vUv.y * 2.0 - 1.0;
          float sinElev = sign(s) * s * s;
          float cosElev = sqrt(max(0.0, 1.0 - sinElev * sinElev));
          float cosPhi = 1.0 - 2.0 * vUv.x * vUv.x;
          float sinPhi = sqrt(max(0.0, 1.0 - cosPhi * cosPhi));

          vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-5, 0.0, 0.0));
          vec3 side = cross(vec3(0.0, 1.0, 0.0), sunH);
          vec3 rd = cosElev * (cosPhi * sunH + sinPhi * side) + sinElev * vec3(0.0, 1.0, 0.0);

          vec3 L = skyRadiance(normalize(rd), normalize(uSunDir));
          vec3 enc = sqrt(clamp(L / ${glslFloat(SKY_LUT_RANGE)}, 0.0, 1.0));
          gl_FragColor = vec4(enc + dither255(vUv), 1.0);
        }`,
    });
  }

  _buildCloudBakers() {
    const shapeOpts = {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
    };
    this._cloudShapeRT = new THREE.WebGLRenderTarget(CLOUD_TEX_SIZE, CLOUD_TEX_SIZE, shapeOpts);

    this._cloudLitRT = new THREE.WebGLRenderTarget(CLOUD_TEX_SIZE, CLOUD_TEX_SIZE, {
      ...shapeOpts,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    // The cloud plane compresses hard toward the horizon; without mips it
    // shimmers into noise exactly where it should read as a soft distant band.
    // Trilinear only — anisotropic filtering multiplies the tap count of the
    // single most-sampled texture in the frame, which the software rasteriser
    // cannot afford, and the horizon haze fade hides the extra blur anyway.
    this._cloudLitRT.texture.anisotropy = 1;

    this._cloudShapeMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCoverage: { value: this.coverage },
        uWarp: { value: 0.34 },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform float uCoverage, uWarp;
        ${NOISE_GLSL}

        void main() {
          // Two-stage domain warp. Plain FBM gives isotropic blobs; displacing
          // the lookup by lower-frequency FBM shears the masses into the curled
          // shapes convection actually produces.
          vec2 w1 = vec2(
            fbm(vUv * 2.0, vec2(2.0), 2, 11.0),
            fbm(vUv * 2.0, vec2(2.0), 2, 23.0)) - 0.5;
          vec2 w2 = vec2(
            fbm((vUv + w1 * 0.5) * 5.0, vec2(5.0), 2, 37.0),
            fbm((vUv + w1 * 0.5) * 5.0, vec2(5.0), 2, 53.0)) - 0.5;
          vec2 q = vUv + (w1 * 0.7 + w2 * 0.3) * uWarp;

          float weather = fbm(q * 2.0, vec2(2.0), 3, 3.0);
          float base = fbm(q * 6.0, vec2(6.0), 5, 41.0);
          float detail = fbm(q * 22.0, vec2(22.0), 3, 71.0);

          // Coverage carves the field; the detail octave then eats into the
          // result so edges dissolve into wisps instead of ending on a contour.
          float cov = smoothstep(0.30, 0.86, weather) * uCoverage + uCoverage * 0.35;
          float d = remap(base, 1.0 - cov, 1.0 - cov * 0.18);
          d = remap(d, detail * 0.42, 1.0);

          // Billow profile: thin at the rim, full depth through the core, which
          // is what gives the layer a sense of vertical extent from below.
          float thickness = d * d * (3.0 - 2.0 * d);

          // Cirrus: the same machinery stretched 8:1 onto its own shell, so the
          // high deck streaks across the wind instead of repeating the cumulus
          // silhouette one octave smaller.
          float cir = fbm(vec2(q.x * 3.0, q.y * 24.0), vec2(3.0, 24.0), 4, 97.0);
          cir = remap(cir, 0.52, 0.84) * smoothstep(0.30, 0.70, 1.0 - weather);

          gl_FragColor = vec4(d, thickness, cir, 1.0) + dither255(vUv);
        }`,
    });

    this._cloudLightMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tShape: { value: this._cloudShapeRT.texture },
        uSunStep: { value: new THREE.Vector2() },
        uSlabStep: { value: 0.1 },
        uExtinction: { value: 5.4 },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tShape;
        uniform vec2 uSunStep;    // UV advance per shadow step, along the sun
        uniform float uSlabStep;  // fraction of the layer depth crossed per step
        uniform float uExtinction;
        ${NOISE_GLSL}

        void main() {
          vec4 shape = texture2D(tShape, vUv);
          float density = shape.r;
          float thickness = shape.g;

          // Light march. Stepping the real density field along the sun's
          // horizontal projection is a genuine shadow trace through the slab:
          // as the sun drops, uSunStep lengthens and the clouds throw the long
          // shadows across one another that sell the layer as volumetric.
          float tau = 0.0;
          vec2 p = vUv;
          float slab = 0.0;
          for (int i = 0; i < 10; i++) {
            p += uSunStep;
            slab += uSlabStep;
            if (slab >= 1.0) break;
            // Only the cloud mass still above us can shadow this point.
            tau += texture2D(tShape, p).r * (1.0 - slab) * uSlabStep * uExtinction * 2.0;
          }

          float tauSelf = density * thickness * uExtinction * 0.35;
          float alpha = 1.0 - exp(-density * uExtinction);

          // Beer-powder: pure Beer's law makes cloud edges brighter than their
          // cores, which is backwards. The (1 - exp(-2 tau)) factor darkens the
          // thin rim back down and restores the crumpled cauliflower reading.
          float direct = exp(-tau);
          float powder = 1.0 - exp(-2.0 * (tau + tauSelf));
          float sun = direct * mix(1.0, powder, 0.72);

          // Sky light reaching the base, attenuated by the column above it:
          // this is what makes cumulus bases read dark and flat.
          float ambient = exp(-(density * 0.9 + thickness * 0.7) * uExtinction * 0.35);

          // Silver lining: optically thin material the sun shines through
          // almost unattenuated. Peaks on the rim, vanishes in the core.
          float silver = exp(-tau * 0.5) * pow(1.0 - alpha, 1.6) * step(0.02, density);

          gl_FragColor = vec4(sun, ambient, silver, alpha) + dither255(vUv);
        }`,
    });
  }

  _buildDome() {
    const geo = new THREE.SphereGeometry(900, 40, 24);
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        tSkyLut: { value: this._skyLutRT.texture },
        tClouds: { value: this._cloudLitRT.texture },
        uSunDir: { value: this.sunDirection },
        uSunAzimuth: { value: new THREE.Vector2(0, 1) },
        uSunDisc: { value: new THREE.Color(1, 1, 1) },
        uSunLight: { value: new THREE.Color(1, 1, 1) },
        uSkyLight: { value: new THREE.Color(0.4, 0.5, 0.7) },
        uCloudOffset: { value: new THREE.Vector2() },
        uCirrusOffset: { value: new THREE.Vector2() },
        uCloudStrength: { value: 1.0 },
        uCirrusStrength: { value: 0.4 },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform sampler2D tSkyLut;
        uniform sampler2D tClouds;
        uniform vec3 uSunDir, uSunDisc, uSunLight, uSkyLight;
        uniform vec2 uSunAzimuth, uCloudOffset, uCirrusOffset;
        uniform float uCloudStrength, uCirrusStrength;

        #define PI 3.141592653589793
        const float R_GROUND = ${glslFloat(ATMO.rGround)};
        const float LUT_RANGE = ${glslFloat(SKY_LUT_RANGE)};
        const float CLOUD_TILE = ${glslFloat(CLOUD_TILE_KM)};
        const float CLOUD_BASE = ${glslFloat(CLOUD_BASE_KM)};
        const float CIRRUS_BASE = ${glslFloat(CIRRUS_BASE_KM)};
        const float SUN_ANGULAR_RADIUS = 0.00465;

        float hg(float mu, float g) {
          float g2 = g * g;
          float d = 1.0 + g2 - 2.0 * g * mu;
          return (1.0 - g2) / (4.0 * PI * d * sqrt(max(d, 1e-4)));
        }

        vec3 sampleSkyLut(vec3 rd) {
          vec2 rh = vec2(rd.x, rd.z);
          float rl = length(rh);
          float cosPhi = rl > 1e-5 ? clamp(dot(rh / rl, uSunAzimuth), -1.0, 1.0) : 1.0;
          // Matches the bake: u = sin(phi/2), v warped on sin(elevation). Two
          // square roots instead of an acos and an asin, on every sky pixel.
          float u = sqrt(max(0.0, 0.5 - 0.5 * cosPhi));
          float s = sign(rd.y) * sqrt(abs(rd.y));
          vec3 enc = texture2D(tSkyLut, vec2(u, s * 0.5 + 0.5)).rgb;
          return enc * enc * LUT_RANGE;
        }

        // Distance to a cloud shell of altitude h on a curved planet, so the
        // layer converges to a finite horizon instead of stretching to infinity
        // the way a flat plane does.
        float shellDistance(vec3 rd, float h) {
          if (rd.y <= 0.002) return -1.0;
          float rc = R_GROUND + h;
          float b = R_GROUND * rd.y;
          return -b + sqrt(b * b + rc * rc - R_GROUND * R_GROUND);
        }

        void main() {
          vec3 rd = normalize(vDir);
          float mu = dot(rd, uSunDir);

          vec3 col = sampleSkyLut(rd);

          // Sun disc with limb darkening. The LUT is far too coarse to resolve
          // a quarter-degree disc, so it is drawn analytically on top. Small
          // angles let us work from (1 - mu) and skip the acos: for the disc,
          // (angle / radius)^2 == 2*(1 - mu) / radius^2 to well within a texel.
          float d2 = 2.0 * (1.0 - mu) / (SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS);
          if (d2 < 1.0) {
            // Linear limb-darkening law; u = 0.6 is about right for the
            // photosphere across the visible band.
            col += uSunDisc * (1.0 - 0.6 * (1.0 - sqrt(1.0 - d2)));
          }
          // The forward Mie peak within a couple of degrees of the disc, which
          // the LUT cannot resolve either. exp(-k*(1-mu)) is the same curve as
          // pow(mu, n) near mu = 1 and costs one exp instead of a log+exp pair.
          float dm = 1.0 - mu;
          col += uSunDisc * (0.0032 * exp(-3000.0 * dm) + 0.00045 * exp(-260.0 * dm));

          // ---- cumulus deck -------------------------------------------------
          // Near the horizon we are looking at the sides and tops of clouds
          // rather than up at their bases, so the lighting has to shift.
          float horizonLift = smoothstep(0.40, 0.015, rd.y);

          float tc = shellDistance(rd, CLOUD_BASE);
          if (tc > 0.0) {
            vec2 uv = rd.xz * tc / CLOUD_TILE + uCloudOffset;
            vec4 c = texture2D(tClouds, uv);
            // A second, much larger lookup modulates coverage so the 9 km tile
            // never announces itself as a repeat across the visible dome.
            vec4 big = texture2D(tClouds, uv * 0.207 + vec2(0.31, 0.62));
            float alpha = c.a * mix(0.35, 1.15, big.a) * uCloudStrength;

            vec3 lit = uSunLight * (c.r * (0.55 + 1.1 * hg(mu, 0.62)) + c.b * 4.0 * hg(mu, 0.88))
                     + uSkyLight * mix(c.g, 0.55 + 0.45 * c.g, horizonLift);

            // Clouds sit in the same air as everything else: the further away,
            // the more they wash into the sky behind them.
            float haze = clamp(tc / 110.0, 0.0, 1.0);
            lit = mix(lit, col, haze * 0.88);
            alpha *= (1.0 - haze * 0.55) * smoothstep(0.002, 0.05, rd.y);

            col = mix(col, lit, clamp(alpha, 0.0, 1.0));
          }

          // ---- cirrus deck --------------------------------------------------
          float tf = shellDistance(rd, CIRRUS_BASE);
          if (tf > 0.0) {
            vec2 uv = rd.xz * tf / (CLOUD_TILE * 3.4) + uCirrusOffset;
            float alpha = texture2D(tClouds, uv).b * uCirrusStrength;
            float haze = clamp(tf / 240.0, 0.0, 1.0);
            // Ice cloud: strongly forward-scattering, effectively unshadowed,
            // and it catches the warm light long before the cumulus deck does.
            vec3 lit = uSunLight * (0.55 + 3.0 * hg(mu, 0.55)) + uSkyLight * 0.6;
            lit = mix(lit, col, haze * 0.9);
            alpha *= (1.0 - haze * 0.7) * smoothstep(0.01, 0.10, rd.y);
            col = mix(col, lit, clamp(alpha, 0.0, 1.0));
          }

          // A third of the frame covered by a slow gradient will band visibly
          // through an 8-bit output pass without a sub-LSB dither.
          float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          col += (n - 0.5) * 0.0025;

          gl_FragColor = vec4(max(col, 0.0), 1.0);
        }`,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    // Drawn last in the opaque pass rather than first: the depth buffer is
    // already populated by then, so the dome only shades pixels the world does
    // not cover. On a software rasteriser that halves the cost of the most
    // expensive shader in the frame.
    this.mesh.renderOrder = 999;
    this.mesh.userData.noCollide = true;
    this.engine.scene.add(this.mesh);
  }

  // -------------------------------------------------------------------------
  // Baking
  // -------------------------------------------------------------------------

  _renderInto(material, target) {
    const renderer = this.engine.renderer;
    const prevTarget = renderer.getRenderTarget();
    this._quadMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this._quadScene, this._quadCamera);
    renderer.setRenderTarget(prevTarget);
  }

  /** Time-independent cloud density field. Runs once, at construction. */
  _bakeCloudShape() {
    this._renderInto(this._cloudShapeMaterial, this._cloudShapeRT);
  }

  /** Re-light the cloud field for the current sun. Runs per time-of-day. */
  _bakeCloudLighting() {
    const sd = this.sunDirection;
    const horizontal = Math.hypot(sd.x, sd.z) || 1e-4;
    const elevation = Math.max(0.06, sd.y);
    const steps = 10;

    // How far a shadow ray travels horizontally while climbing the layer depth.
    // Capped so a sun on the horizon cannot smear shadows across the whole tile.
    const layerDepthKm = 0.9;
    const reach = Math.min(layerDepthKm * (horizontal / elevation), CLOUD_TILE_KM * 0.75);
    const u = this._cloudLightMaterial.uniforms;
    u.uSunStep.value.set(
      (sd.x / horizontal) * (reach / CLOUD_TILE_KM) / steps,
      (sd.z / horizontal) * (reach / CLOUD_TILE_KM) / steps,
    );
    u.uSlabStep.value = 1 / steps;
    this._renderInto(this._cloudLightMaterial, this._cloudLitRT);
  }

  _bakeSkyLut() {
    const u = this._skyLutMaterial.uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    u.uTurbidity.value = this.turbidity;
    u.uSunIrradiance.value = this.exposure.irradiance;
    u.uMultiScatter.value = this.exposure.multiScatter;
    u.uGroundTint.value.copy(this._groundTint);
    this._renderInto(this._skyLutMaterial, this._skyLutRT);
  }

  // -------------------------------------------------------------------------
  // Time of day
  // -------------------------------------------------------------------------

  /**
   * Solar position for an equinox day at ~40 deg latitude with solar noon at
   * 11.6h, chosen so the golden-hour pose (17.2h) puts the sun a few degrees
   * above the horizon rather than halfway up the sky. The compass is then spun
   * about Y so the sun sets forward-left of the level's default view direction
   * and rises behind it, which front-lights the block in the morning poses.
   */
  setTimeOfDay(hours) {
    this.timeOfDay = hours;

    const H = (hours - 11.6) * (Math.PI / 12); // hour angle, 0 at solar noon
    const cosLat = 0.766, sinLat = 0.643;      // ~40 deg N, declination 0
    const east = -Math.sin(H);
    const north = -sinLat * Math.cos(H);
    const up = cosLat * Math.cos(H);

    // ENU -> world (east = +Z, north = +X), then rotated about Y by psi.
    const psi = 0.416, cp = Math.cos(psi), sp = Math.sin(psi);
    this.sunDirection.set(north * cp + east * sp, up, -north * sp + east * cp).normalize();

    // Below the horizon the sun is pinned just under it: the scattering model
    // stays stable and Lighting still has a usable key direction at 4h and 20h.
    if (this.sunDirection.y < -0.06) {
      this.sunDirection.y = -0.06;
      this.sunDirection.normalize();
    }

    this._bakeSkyLut();
    this._bakeCloudLighting();
    this._updateDerivedColors();
    this.refreshEnvironment();
  }

  /**
   * Pull sun colour, hemisphere ambient and the aerial-perspective basis out of
   * the same scattering solution the dome is rendered from, so the lighting rig
   * and the haze always agree with what is on screen.
   */
  _updateDerivedColors() {
    const sd = this.sunDirection.toArray();
    const opts = {
      turbidity: this.turbidity,
      irradiance: this.exposure.irradiance,
      multiScatter: this.exposure.multiScatter,
      groundTint: this._groundTint.toArray(),
    };
    const mieScale = mieScaleJS(this.turbidity);
    const elevation = this.sunDirection.y;
    const above = smoothstepJS(-0.06, 0.10, elevation); // fades out under the horizon

    // --- key light -----------------------------------------------------------
    const tr = sunTransmittanceJS([0, ATMO.rGround + ATMO.viewAltitude, 0], sd, mieScale);
    const peak = Math.max(tr[0], tr[1], tr[2]) || 1e-4;
    // Normalised so the key stays a full-strength white lamp when the sun is
    // high, then dims and reddens as the slant path grows.
    const dim = (0.25 + 0.75 * smoothstepJS(0.02, 0.42, elevation)) * above;
    this.sunColor.setRGB((tr[0] / peak) * dim, (tr[1] / peak) * dim, (tr[2] / peak) * dim);

    // --- sky probes ----------------------------------------------------------
    const horiz = Math.hypot(sd[0], sd[2]) || 1e-4;
    const toSun = normalize3([sd[0] / horiz, 0.06, sd[2] / horiz]);
    const awaySun = normalize3([-sd[0] / horiz, 0.06, -sd[2] / horiz]);
    const zenith = skyRadianceJS([0, 1, 0], sd, opts);
    const hSun = skyRadianceJS(toSun, sd, opts);
    const hAway = skyRadianceJS(awaySun, sd, opts);
    const upSun = skyRadianceJS(normalize3([sd[0], 1.0, sd[2]]), sd, opts);

    // --- hemisphere fill -----------------------------------------------------
    // Weighted average of the probes. The sky is the dominant fill light in any
    // exterior, and getting its colour right is what stops shadowed surfaces
    // reading as flat grey.
    // Weighted average of the probes, then radiance -> irradiance: a hemisphere
    // of uniform radiance L delivers pi*L onto a surface facing it, and that
    // irradiance is what a HemisphereLight's colour actually represents.
    // Clamped rather than normalised so the fill still dims into the evening
    // instead of staying at full strength in a different hue.
    const ambRadiance = [0, 1, 2].map((c) =>
      zenith[c] * 0.42 + upSun[c] * 0.26 + hSun[c] * 0.18 + hAway[c] * 0.14);
    // Clamping pinned green and blue at 1.0 and threw the hue away — measured
    // (0.881, 1, 1), a flat cyan-white that flattens every shadowed surface.
    // A light's colour is chromaticity and its intensity is magnitude, so
    // normalise to unit maximum and let ambientIntensity below carry the
    // strength. The fill still dims into the evening, because that dimming
    // lives in the intensity rather than in a desaturating colour.
    const ambMax = Math.max(ambRadiance[0], ambRadiance[1], ambRadiance[2], 1e-6);
    this.ambientColor.setRGB(
      ambRadiance[0] / ambMax, ambRadiance[1] / ambMax, ambRadiance[2] / ambMax,
    );
    // Published for a rig that wants magnitude and hue separated; the colour
    // above already carries the magnitude for one that does not.
    this.ambientIntensity = Math.min(1.8, ambRadiance[1] * Math.PI * 1.1 + 0.15);

    // --- dome uniforms -------------------------------------------------------
    const u = this.material.uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    u.uSunAzimuth.value.set(sd[0] / horiz, sd[2] / horiz);
    // Disc radiance is the extincted solar beam. Physically it is ~1e5x the
    // sky; clamped here to something bloom can turn into a believable flare
    // rather than a white hole across a third of the frame.
    const discScale = this.exposure.sunDisc * (0.35 + 0.65 * above);
    u.uSunDisc.value.setRGB(tr[0] * discScale, tr[1] * discScale, tr[2] * discScale);
    // Cloud illumination uses the beam itself, not the normalised key colour,
    // so the deck reddens with the sun. Scaled so a sunlit top lands just above
    // 1.0 — the brightest thing in frame after the disc itself.
    const cloudSun = 1.2 * above;
    u.uSunLight.value.setRGB(tr[0] * cloudSun, tr[1] * cloudSun, tr[2] * cloudSun);
    // Sky fill on the cloud, again radiance -> irradiance over the hemisphere.
    u.uSkyLight.value.setRGB(zenith[0] * Math.PI, zenith[1] * Math.PI, zenith[2] * Math.PI);

    // --- aerial perspective --------------------------------------------------
    // fogParams is a published, human-readable description of the horizon, so
    // it is clamped into gamut. Nothing in the frame is drawn from it: the
    // aerial chunk below replaces three's fog maths outright.
    const fogRGB = clampRGB(hAway, 1.0);
    this.fogParams.color.setRGB(fogRGB[0], fogRGB[1], fogRGB[2]);
    if (this.engine.scene.fog) {
      this.engine.scene.fog.color.copy(this.fogParams.color);
      this.engine.scene.fog.density = this.fogParams.density;
    }

    // The aerial basis, by contrast, stays in raw radiance. The haze mix runs
    // inside the material shader — in linear HDR, before the output pass
    // tonemaps — so for a distant surface to converge to the dome behind it,
    // it has to converge to the dome's *radiance*. Tonemapping these first
    // would push every hazed surface below the sky it is meant to melt into.
    // The ceiling is a guard against a sunset horizon, not a normalisation.
    const zenithHDR = clampRGB(zenith, 3.0);
    const hAwayHDR = clampRGB(hAway, 3.0);
    const hSunHDR = clampRGB(hSun, 3.0);
    // The forward lobe is the one thing three basis colours cannot express: the
    // bright bloom of haze immediately around the sun.
    const inscatter = [0, 1, 2].map((c) => Math.max(0, hSunHDR[c] - hAwayHDR[c]) * 1.6);
    this._aerial = {
      uAerialZenith: zenithHDR,
      uAerialHorizon: hAwayHDR,
      uAerialSunHorizon: hSunHDR,
      uAerialInscatter: inscatter,
      uAerialSunDir: sd,
      uAerialHeightFalloff: this.fogParams.heightFalloff,
      uAerialDensity: this.fogParams.density,
      uAerialMaxOpacity: 0.94,
    };
    this._syncAerialUniforms();
  }

  /**
   * Push the aerial values everywhere three might read them from: the ShaderLib
   * templates that not-yet-compiled materials clone, and the per-material
   * uniform copies that already-compiled ones own.
   */
  _syncAerialUniforms() {
    const values = this._aerial;
    const apply = (uniforms) => {
      if (!uniforms || !uniforms.uAerialZenith) return;
      for (const name of AERIAL_UNIFORM_NAMES) {
        const target = uniforms[name];
        const v = values[name];
        if (!target) continue;
        if (typeof v === 'number') target.value = v;
        else if (target.value && target.value.isColor) target.value.setRGB(v[0], v[1], v[2]);
        else if (target.value && target.value.isVector3) target.value.set(v[0], v[1], v[2]);
      }
    };

    apply(THREE.UniformsLib.fog);
    for (const key of Object.keys(THREE.ShaderLib)) apply(THREE.ShaderLib[key].uniforms);

    const properties = this.engine.renderer.properties;
    const visit = (object) => {
      const material = object.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const m of list) apply(properties.get(m).uniforms);
    };
    this.engine.scene.traverse(visit);
    this.engine.viewScene.traverse(visit);
  }

  /** Render the dome into a PMREM cube so it drives IBL for every material. */
  /**
   * Convolve the dome into the IBL probe that supplies most of the indirect
   * term for every PBR surface in the game.
   *
   * Returns the probe's mean radiance so the caller can tell a good bake from a
   * dead one. That check is not paranoia: this used to be called exactly once,
   * from setTimeOfDay() inside the constructor, which runs before the level
   * exists and can catch the sky LUT render targets cold. When it did, every
   * ambient-lit surface in the game permanently lost the bulk of its fill and
   * only the deliberately-weak hemisphere light remained — a roughly threefold
   * collapse of the shadow half of the frame, varying from boot to boot. The
   * giveaway was that goldenHour, the one camera pose that sets a time of day
   * and therefore triggers a second bake after the world is up, was also the
   * one pose that never showed it.
   */
  refreshEnvironment() {
    const rt = this.pmrem.fromScene(this._envScene, 0, 0.1, 1000);
    if (this._envRT) this._envRT.dispose();
    this._envRT = rt;
    this.environment = rt.texture;
    this.engine.scene.environment = this.environment;
    this.engine.viewScene.environment = this.environment;
    this._envMean = this._measureEnvironment(rt);
    return this._envMean;
  }

  /** Mean luminance of the probe, read back through an 8-bit blit. */
  _measureEnvironment(rt) {
    const r = this.engine.renderer;
    let probe = null;
    const prevTarget = r.getRenderTarget();
    try {
      probe = new THREE.WebGLRenderTarget(8, 8, {
        type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
      });
      const quad = new THREE.Mesh(
        this._quadGeometry,
        new THREE.MeshBasicMaterial({ map: rt.texture, toneMapped: false }),
      );
      const scene = new THREE.Scene();
      scene.add(quad);
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const prevAutoClear = r.autoClear;
      r.autoClear = false;
      r.setRenderTarget(probe);
      r.clear(true, false, false);
      r.render(scene, cam);
      const buf = new Uint8Array(8 * 8 * 4);
      r.readRenderTargetPixels(probe, 0, 0, 8, 8, buf);
      r.autoClear = prevAutoClear;
      quad.material.dispose();
      let sum = 0;
      for (let i = 0; i < buf.length; i += 4) sum += (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
      return sum / (8 * 8) / 255;
    } catch {
      return null;
    } finally {
      r.setRenderTarget(prevTarget);
      probe?.dispose();
    }
  }

  update(dt) {
    // Re-bake the probe once the world is actually up. The constructor's bake
    // can land before the sky LUTs have resolved, and a cold probe silently
    // removes most of the indirect light from every shadowed surface for the
    // rest of the session. Re-baking on an early frame costs one convolution
    // and removes the whole failure mode; if the result still looks dead, keep
    // retrying for a few frames rather than shipping the frame with no fill.
    if (this._envSettleFrames === undefined) this._envSettleFrames = 0;
    if (this._envSettleFrames < 8) {
      this._envSettleFrames++;
      const stale = this._envMean === null || this._envMean === undefined || this._envMean < 0.02;
      if (this._envSettleFrames === 3 || stale) this.refreshEnvironment();
    }

    // Real cumulus drift at 10-20 m/s; the cirrus deck runs faster and across
    // the low layer, which reads as wind shear rather than a scrolling texture.
    const u = this.material.uniforms;
    this._cloudDrift.x += (dt * 0.011) / CLOUD_TILE_KM;
    this._cloudDrift.y += (dt * 0.004) / CLOUD_TILE_KM;
    this._cirrusDrift.x += (dt * 0.026) / (CLOUD_TILE_KM * 3.4);
    this._cirrusDrift.y -= (dt * 0.009) / (CLOUD_TILE_KM * 3.4);
    u.uCloudOffset.value.copy(this._cloudDrift);
    u.uCirrusOffset.value.copy(this._cirrusDrift);
    this.mesh.position.copy(this.engine.camera.position);
  }

  dispose() {
    this.engine.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this._quadGeometry.dispose();
    this._transLutMaterial.dispose();
    this._skyLutMaterial.dispose();
    this._cloudShapeMaterial.dispose();
    this._cloudLightMaterial.dispose();
    this._transLutRT.dispose();
    this._skyLutRT.dispose();
    this._cloudShapeRT.dispose();
    this._cloudLitRT.dispose();
    if (this._envRT) this._envRT.dispose();
    this.pmrem.dispose();
    uninstallAerialPerspective();
  }
}
