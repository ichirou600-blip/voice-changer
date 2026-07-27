import * as THREE from 'three';

/**
 * Procedural PBR material library. Nothing is downloaded — every albedo,
 * normal, roughness, AO and metalness map in the game is synthesised here on
 * the GPU at load time with fullscreen shader passes.
 *
 * CONTRACT (relied on by Level/Weapons/Enemies/Particles/Decals):
 *   await lib.build(onProgress)          — generates everything
 *   lib.get(name)                        — { map, normalMap, roughnessMap, aoMap, ... }
 *   lib.material(name, opts)             — a shared MeshStandardMaterial
 *   lib.setRepeat(material, u, v)        — retile a material
 *   lib.sprite(name)                     — a single THREE.Texture for billboards
 *   lib.list()                           — available material names
 *   lib.decorate(material, name)         — opt a hand-built MeshStandardMaterial
 *                                          into the detail normal + world-space
 *                                          weathering that `material()` applies
 *
 * PIPELINE — four passes per material, all on the GPU:
 *
 *   1. surface   (per-material shader, MRT) → [ albedo.rgb + height.a,
 *                                               roughness / metalness / cavity ]
 *   2. normal    (shared) → tangent-space normal from a Sobel of the height,
 *                           height kept in alpha for parallax
 *   3. curvature (shared, half res) → horizon-swept ambient occlusion AND the
 *                           complementary convexity term, from the same taps
 *   4. finish    (shared, MRT) → [ final albedo, packed ORM ]
 *                           deposits and edge wear are applied here because
 *                           only now do we know the real geometric cavity
 *
 * The finished targets are then read back once into DataTextures: consumers
 * clone these sets to get independent tiling, and a clone of a render-target
 * texture has no entry in the renderer's source cache, so it would come back
 * blank. See `_publish`.
 *
 * Everything is seamlessly tileable: every lattice lookup wraps its cell
 * coordinate through mod(cell, period) before hashing, and each fbm octave
 * doubles frequency and period together. The residual repeat that tiling still
 * produces is broken at shading time by the world-space weathering `decorate`
 * injects into the material.
 */

const SIZE = { low: 256, medium: 512, high: 1024 };

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

/**
 * Periodic noise toolkit. Every generator function below takes a *frequency*
 * expressed in tiles-per-texture; the period passed to the hash is that same
 * number, which is what makes the field wrap exactly at uv 0/1. Frequencies
 * must therefore be integers — octave doubling keeps them integral.
 */
const NOISE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uSeed;
uniform float uRes;

// An octave finer than about a third of the sampling rate cannot be resolved;
// all it can contribute is aliasing, which then shows up as the salt-and-pepper
// crunch that makes a surface sparkle at distance. Octave zero is always kept
// (it is the authored frequency), the rest stop at the limit.
bool tooFine( vec2 f ) { return max( f.x, f.y ) > uRes * 0.34; }

float sat( float x ) { return clamp( x, 0.0, 1.0 ); }

// GLSL leaves smoothstep undefined when edge0 > edge1, but a reversed ramp is
// how half the masks below are authored ("1 inside the pit, 0 outside"). Route
// every call through a version that is well defined in both directions.
float sstep( float e0, float e1, float x ) {
  float t = clamp( ( x - e0 ) / ( e1 - e0 ), 0.0, 1.0 );
  return t * t * ( 3.0 - 2.0 * t );
}
#define smoothstep sstep

vec2 hash2( vec2 cell, vec2 period ) {
  vec2 p = mod( cell, period );
  vec3 q = fract( vec3( p.x, p.y, p.x + p.y ) * vec3( 0.1031, 0.1030, 0.0973 ) + uSeed );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.xx + q.yz ) * q.zy );
}

float hash1( vec2 cell, vec2 period ) { return hash2( cell + 19.7, period ).y; }

// Unit gradient without a sin/cos pair. Trig is a transcendental call per
// lattice corner — four per noise sample, sixteen per fbm octave — and on a
// software rasteriser that dominated generation time. A normalised hash pair is
// visually indistinguishable here and roughly a third of the cost.
vec2 gradDir( vec2 cell, vec2 period ) {
  vec2 g = hash2( cell, period ) * 2.0 - 1.0;
  return g * inversesqrt( max( dot( g, g ), 1e-6 ) );
}

// Periodic gradient (Perlin) noise, roughly [-1,1].
float pnoise( vec2 p, vec2 period ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  float a = dot( gradDir( i, period ), f );
  float b = dot( gradDir( i + vec2( 1.0, 0.0 ), period ), f - vec2( 1.0, 0.0 ) );
  float c = dot( gradDir( i + vec2( 0.0, 1.0 ), period ), f - vec2( 0.0, 1.0 ) );
  float d = dot( gradDir( i + vec2( 1.0, 1.0 ), period ), f - vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 1.4;
}

// fbm in [0,1]. freq is in tiles-per-texture and may be anisotropic.
float fbm( vec2 uv, vec2 freq, int oct ) {
  float s = 0.0, amp = 0.5, norm = 0.0;
  vec2 f = freq;
  for ( int i = 0; i < 7; i ++ ) {
    if ( i >= oct || ( i > 0 && tooFine( f ) ) ) break;
    s += amp * pnoise( uv * f, f );
    norm += amp;
    f *= 2.0;
    amp *= 0.5;
  }
  return s / norm * 0.5 + 0.5;
}

// Ridged multifractal in [0,1] — sharp crests, used for cracks and rust fronts.
float ridged( vec2 uv, vec2 freq, int oct ) {
  float s = 0.0, amp = 0.5, norm = 0.0;
  vec2 f = freq;
  for ( int i = 0; i < 7; i ++ ) {
    if ( i >= oct || ( i > 0 && tooFine( f ) ) ) break;
    float v = 1.0 - abs( pnoise( uv * f, f ) );
    s += amp * v * v;
    norm += amp;
    f *= 2.0;
    amp *= 0.5;
  }
  return s / norm;
}

// x = F1, y = F2, z = per-cell random id.
vec3 worley( vec2 uv, vec2 freq ) {
  vec2 p = uv * freq;
  vec2 n = floor( p ), f = fract( p );
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for ( int j = -1; j <= 1; j ++ ) {
    for ( int i = -1; i <= 1; i ++ ) {
      vec2 g = vec2( float( i ), float( j ) );
      vec2 o = hash2( n + g, freq );
      vec2 r = g + o - f;
      float d = dot( r, r );
      if ( d < f1 ) { f2 = f1; f1 = d; id = o.y; }
      else if ( d < f2 ) { f2 = d; }
    }
  }
  return vec3( sqrt( f1 ), sqrt( f2 ), id );
}

// Domain warp. A constant offset never breaks periodicity, and the warp field
// is itself periodic, so warp( uv + 1 ) == warp( uv ) + 1.
vec2 warp( vec2 uv, vec2 freq, float amount, int oct ) {
  return uv + amount * vec2( fbm( uv, freq, oct ) - 0.5, fbm( uv + 4.31, freq, oct ) - 0.5 );
}

// Long anisotropic smears. squash > 1 stretches the field along v, which is
// world-up on every wall face, so this reads as rain running down.
float runoff( vec2 uv, float across, float along, int oct ) {
  return fbm( uv, vec2( across, along ), oct );
}
`;

/** Wrapper appended after each material's surface() implementation. */
const SURFACE_MAIN = /* glsl */ `
layout(location = 0) out vec4 oFieldHeight;
layout(location = 1) out vec4 oSurface;

void main() {
  vec3 albedo = vec3( 0.5 );
  float height = 0.5, rough = 0.9, metal = 0.0, cav = 1.0, dirt = 0.5;
  surface( vUv, albedo, height, rough, metal, cav, dirt );
  oFieldHeight = vec4( max( albedo, 0.0 ), sat( height ) );
  // b = analytic cavity (where geometry hides), a = deposit affinity (where
  // weather has actually put something). Grime needs both to be true.
  oSurface = vec4( sat( rough ), sat( metal ), sat( cav ), sat( dirt ) );
}`;

const NORMAL_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uField;
uniform vec2 uTexel;
uniform float uStrength;

float h( vec2 o ) { return texture2D( uField, vUv + o * uTexel ).a; }

void main() {
  // Sobel over the wrapped height field. The source target uses RepeatWrapping,
  // so the derivative is continuous across the tile seam and the normal map
  // tiles as cleanly as the albedo does.
  float tl = h( vec2( -1.0, -1.0 ) ), tc = h( vec2( 0.0, -1.0 ) ), tr = h( vec2( 1.0, -1.0 ) );
  float ml = h( vec2( -1.0, 0.0 ) ),  mc = h( vec2( 0.0, 0.0 ) ),  mr = h( vec2( 1.0, 0.0 ) );
  float bl = h( vec2( -1.0, 1.0 ) ),  bc = h( vec2( 0.0, 1.0 ) ),  br = h( vec2( 1.0, 1.0 ) );
  float dx = ( tr + 2.0 * mr + br ) - ( tl + 2.0 * ml + bl );
  float dy = ( bl + 2.0 * bc + br ) - ( tl + 2.0 * tc + tr );
  // Tangent-space normal of a height field is ( -dh/du, -dh/dv, 1 ); OpenGL
  // convention, which is what MeshStandardMaterial expects.
  vec3 n = normalize( vec3( -dx * uStrength, -dy * uStrength, 1.0 ) );
  gl_FragColor = vec4( n * 0.5 + 0.5, mc );
}`;

const CURV_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uField;
uniform vec2 uTexel;
uniform float uRelief;

void main() {
  float h0 = texture2D( uField, vUv ).a;
  // Interleaved gradient noise rotates the sweep per pixel; without it six
  // fixed directions band badly on smooth slopes.
  float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );

  float occ = 0.0, cvx = 0.0;
  for ( int d = 0; d < 6; d ++ ) {
    float a = ( float( d ) + jitter ) * 1.04719755;
    vec2 dir = vec2( cos( a ), sin( a ) );
    float up = 0.0, down = 0.0;
    float r = 1.5;
    for ( int s = 0; s < 4; s ++ ) {
      float dh = texture2D( uField, vUv + dir * uTexel * r ).a - h0;
      up = max( up, dh * uRelief / r );
      // Convexity is deliberately read from the two shortest rings only. A
      // broad dome is not an edge, and letting the long rings vote turns whole
      // panels convex — which then get painted with edge wear and read as mould
      // rather than as rubbed arrises.
      if ( s < 2 ) down = max( down, -dh * uRelief * 0.55 );
      r *= 2.6;
    }
    occ += clamp( up, 0.0, 1.0 );
    cvx += clamp( down, 0.0, 1.0 );
  }
  // r = openness (1 = unoccluded), g = convexity (0 = flat or concave).
  gl_FragColor = vec4( 1.0 - occ / 6.0, cvx / 6.0, 0.0, 1.0 );
}`;

const FINISH_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uField;
uniform sampler2D uSurf;
uniform sampler2D uCurv;
uniform vec3 uGrimeColor;
uniform vec3 uWearColor;
uniform vec4 uAmount;   // x grime, y wear, z ao contrast, w wear metalness

layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oOrm;

// The maps are read back to 8-bit and re-uploaded as ordinary textures, so the
// sRGB curve has to be applied here rather than left to an sRGB framebuffer —
// readPixels from an sRGB attachment is not well defined across drivers.
vec3 linearToSrgb( vec3 c ) {
  return mix( c * 12.92, 1.055 * pow( max( c, 0.0 ), vec3( 0.41666 ) ) - 0.055,
              step( vec3( 0.0031308 ), c ) );
}

void main() {
  vec4 field = texture2D( uField, vUv );
  vec4 surf = texture2D( uSurf, vUv );
  vec2 curv = texture2D( uCurv, vUv ).rg;

  float rough = surf.r, metal = surf.g;

  // The generator's analytic cavity mask knows about features the height field
  // cannot resolve on its own (hairline cracks, thin mortar joints); the baked
  // horizon term knows about real geometric shadowing. Combining them is the
  // curvature-driven masking that separates a PBR surface from a pile of noise.
  float open = clamp( curv.r * surf.b, 0.0, 1.0 );
  float recess = 1.0 - open;
  float edge = smoothstep( 0.20, 0.62, curv.g );

  // Grime — dark, desaturated, matte, non-metallic. Deposit affinity says where
  // weather has been working; the cavity says how much of it stuck. Multiplying
  // the two is what stops grime from either hazing everything uniformly or
  // clinging to nothing but a few isolated pits.
  float grime = clamp( uAmount.x * surf.a * ( 0.30 + 1.85 * recess ), 0.0, 0.92 );
  vec3 albedo = mix( field.rgb, uGrimeColor, grime );
  rough = mix( rough, 0.97, grime * 0.85 );
  metal *= 1.0 - grime * 0.9;

  // Wear — raised material gets rubbed: lighter, markedly smoother, and for a
  // painted or oxidised metal it opens back up to bare substrate.
  float wear = uAmount.y * edge;
  albedo = mix( albedo, uWearColor, wear );
  rough = mix( rough, rough * 0.42 + 0.05, wear );
  metal = mix( metal, uAmount.w, wear );

  oAlbedo = vec4( linearToSrgb( albedo ), 1.0 );
  oOrm = vec4( clamp( 1.0 - recess * uAmount.z, 0.0, 1.0 ),
               clamp( rough, 0.035, 1.0 ),
               clamp( metal, 0.0, 1.0 ), 1.0 );
}`;

/** Shared high-frequency detail height, turned into a normal by NORMAL_FS. */
const DETAIL_SURFACE = /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  // Three scales of isotropic tooth. This is what the camera sees at 30 cm,
  // where the base map has long since run out of texels.
  float a = fbm( uv, vec2( 34.0 ), 3 );
  float b = worley( uv, vec2( 62.0 ) ).x;
  float c = fbm( uv, vec2( 150.0 ), 2 );
  height = a * 0.42 + smoothstep( 0.65, 0.05, b ) * 0.33 + c * 0.25;
  albedo = vec3( height );
  rough = 1.0;
  metal = 0.0;
  cav = 1.0;
  dirt = 0.0;
}`;

// ---------------------------------------------------------------------------
// Material definitions
// ---------------------------------------------------------------------------
//
// ALBEDO CONVENTION: these are tintable sets. Level.js drives material identity
// with a per-instance `color` multiplier (five plasters, three concretes, all
// from one map) on top of vertex-colour weathering, so each albedo is authored
// bright and only lightly saturated — the hue arrives with the tint. Author
// them at their true reflectance and everything downstream comes out muddy.
//
// Tuning fields:
//   normal      Sobel gain for the base normal map
//   relief      height-to-slope ratio used by the AO/convexity bake
//   grime       how much dirt collects in the baked recesses
//   wear        how much the baked convex edges get rubbed back
//   wearMetal   metalness the worn edges expose (1 = bare metal under a coat)
//   grimeColor  linear colour of the deposit
//   wearColor   linear colour of the exposed substrate
//   metalness   material-level metalness multiplier (the map carries the mask)
//   detail      [ tiles-per-uv, strength ] of the shared detail-normal layer
//   macro       [ world frequency, albedo swing, roughness swing ]
//   splash      [ height in metres, strength ] of ground-thrown dirt
//   dust        strength of settled dust on upward-facing surfaces
//   size        texture resolution override

const MATERIALS = {

  concrete: {
    normal: 1.4, relief: 30, grime: 0.72, wear: 0.14, wearMetal: 0.0,
    grimeColor: [0.048, 0.046, 0.041], wearColor: [0.60, 0.592, 0.570],
    detail: [11, 0.55], macro: [0.030, 0.20, 0.12], splash: [1.7, 0.60], dust: 0.10,
    glsl: /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  // 1 — substrate. Barely-tinted cement: the tint multiplier decides whether
  //     this ends up as pavement, breeze block or a stained precast panel.
  vec3 cement = vec3( 0.470, 0.464, 0.446 );

  // 2 — large-scale tone. Poured concrete is never one colour: separate pours,
  //     damp that never dried, forty years of unequal washing. This is a wide
  //     swing on purpose — it is what stops the wall reading as painted card.
  float pour = fbm( uv, vec2( 2.0 ), 3 );
  float wash = smoothstep( 0.40, 0.82, fbm( uv + 3.1, vec2( 3.0 ), 3 ) );
  float soil = smoothstep( 0.30, 0.78, fbm( uv + 19.4, vec2( 4.0 ), 3 ) );

  // 3 — mid structure: the shallow ribbing left by timber shuttering, plus the
  //     coarse aggregate sitting just under the skin.
  //     The board joint is a hairline, not a plank edge — anything stronger and
  //     the wall reads as corrugated cladding.
  vec2 fw = warp( uv, vec2( 6.0 ), 0.020, 2 );
  float board = smoothstep( 0.0, 0.035, abs( fract( fw.y * 4.0 ) - 0.5 ) );
  float agg = worley( uv, vec2( 22.0 ) ).x;
  float aggBump = smoothstep( 0.52, 0.14, agg );

  // 4 — micro: cement grain and trapped air (blowholes).
  float grain = fbm( uv, vec2( 88.0 ), 3 );
  vec3 blow = worley( uv + 7.3, vec2( 54.0 ) );
  float holes = smoothstep( 0.14, 0.0, blow.x ) * step( 0.58, blow.z );

  // 5 — damage: a hairline crack network and spalled chips where the skin has
  //     flaked off and left paler, rougher aggregate exposed. Kept small — this
  //     map is also tiled at 7 m as the city's dirt layer, and anything bigger
  //     reads as cracked mud rather than concrete.
  float crack = smoothstep( 0.88, 0.99, ridged( warp( uv, vec2( 3.0 ), 0.05, 2 ), vec2( 6.0 ), 4 ) );
  vec3 sp = worley( uv + 11.7, vec2( 14.0 ) );
  float spall = smoothstep( 0.24, 0.05, sp.x ) * step( 0.74, sp.z );

  height = 0.60 + ( pour - 0.5 ) * 0.10 + ( board - 1.0 ) * 0.030 + aggBump * 0.06
         + ( grain - 0.5 ) * 0.07 - holes * 0.40 - crack * 0.32 - spall * 0.22;

  // Analytic cavity: 1 = exposed, 0 = a recess the sweep is too coarse to see.
  cav = 1.0 - sat( holes * 0.95 + crack * 0.95 + ( 1.0 - board ) * 0.30 + spall * 0.50 );

  vec3 col = cement * ( 0.66 + pour * 0.72 );
  col = mix( col, cement * 1.26, wash * 0.45 );
  col = mix( col, vec3( 0.360, 0.352, 0.334 ), aggBump * 0.45 );
  col *= 0.90 + grain * 0.20;
  col = mix( col, vec3( 0.615, 0.596, 0.560 ), spall * 0.85 );
  col = mix( col, col * 0.42, crack * 0.75 );

  rough = 0.86 - wash * 0.06 + ( grain - 0.5 ) * 0.12 + spall * 0.08;

  // 6 — deposits. Rain runs down: long vertical smears, seeded per column and
  //     thresholded hard so a few strong runs form instead of a uniform comb.
  float seed = fbm( vec2( uv.x, 0.37 ), vec2( 9.0, 1.0 ), 3 );
  float body = runoff( warp( uv, vec2( 3.0, 7.0 ), 0.055, 2 ), 26.0, 2.0, 3 );
  float streak = smoothstep( 0.56, 0.95, seed * 0.55 + body * 0.62 );
  col = mix( col, vec3( 0.118, 0.114, 0.104 ), streak * 0.50 );
  rough = mix( rough, 0.74, streak * 0.40 );

  // Salt bloom pushed out through the cracks — chalky, bright, very matte.
  float efflor = smoothstep( 0.58, 0.90, fbm( uv + 8.9, vec2( 7.0 ), 3 ) ) * smoothstep( 0.2, 0.8, crack + 0.5 );
  col = mix( col, vec3( 0.800, 0.796, 0.775 ), efflor * 0.40 );
  rough = mix( rough, 0.98, efflor * 0.5 );

  // Moss only where water lingers.
  float moss = smoothstep( 0.62, 0.94, fbm( uv + 2.2, vec2( 5.0, 4.0 ), 3 ) ) * ( 1.0 - cav * 0.6 );
  col = mix( col, vec3( 0.076, 0.100, 0.048 ), moss * 0.60 );
  rough = mix( rough, 0.95, moss * 0.6 );

  // Deposit affinity: soot lands where it is already damp and shaded — under
  // the streaks, in the soiled patches, and along the board joints.
  dirt = sat( soil * 0.85 + streak * 0.75 + ( 1.0 - board ) * 0.25 + 0.10 );

  albedo = col;
  metal = 0.0;
}` },

  asphalt: {
    // Road is tiled at ~3 m and Level.js runs its albedo through an affine lift
    // with a gain of 9 to reach tarmac grey. That gain amplifies contrast as
    // well as level, so the absolute range here is tiny — but the *relative*
    // range is wide, which is what survives the lift as readable aggregate.
    normal: 0.95, relief: 34, grime: 0.30, wear: 0.16, wearMetal: 0.0,
    grimeColor: [0.026, 0.025, 0.025], wearColor: [0.135, 0.134, 0.134],
    detail: [9, 0.60], macro: [0.022, 0.30, 0.16], splash: [0.0, 0.0], dust: 0.20,
    glsl: /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  // 1 — bitumen binder.
  vec3 binder = vec3( 0.042, 0.042, 0.045 );

  // 2 — low-contrast drift only. Anything bolder would repeat every 3 metres.
  float drift = fbm( uv, vec2( 3.0 ), 3 );

  // 3 — the aggregate: chippings of assorted stone bound in bitumen. F2 - F1
  //     gives the binder gap between neighbouring stones, and it is those gaps,
  //     not the stones, that make a surface read as road rather than as gravel.
  vec3 w = worley( warp( uv, vec2( 8.0 ), 0.006, 2 ), vec2( 46.0 ) );
  float gap = smoothstep( 0.10, 0.02, w.y - w.x );
  float face = 1.0 - gap;
  float crown = smoothstep( 0.34, 0.02, w.x );          // centre of each chip
  vec3 w2 = worley( uv + 5.5, vec2( 108.0 ) );
  float fines = smoothstep( 0.08, 0.02, w2.y - w2.x );

  // 4 — micro grain over everything.
  float grain = fbm( uv, vec2( 130.0 ), 3 );

  // 5 — damage: a crack network, and ravelled patches where the chippings have
  //     been plucked out and only binder and dust are left.
  float crack = smoothstep( 0.87, 0.99, ridged( warp( uv, vec2( 4.0 ), 0.05, 2 ), vec2( 7.0 ), 4 ) );
  float ravel = smoothstep( 0.62, 0.88, fbm( uv + 13.0, vec2( 9.0 ), 3 ) );

  height = 0.55 + face * 0.16 - gap * 0.10 - fines * 0.05
         + ( grain - 0.5 ) * 0.08 - crack * 0.40 - ravel * 0.10;

  cav = 1.0 - sat( gap * 0.70 + fines * 0.30 + crack * 0.95 + ravel * 0.35 );

  // Per-stone colour: most chippings are grey granite, some pale limestone, a
  // few iron-stained. Chips run 2-3x the binder so the lift keeps the contrast.
  float tint = w.z;
  vec3 chip = mix( vec3( 0.108, 0.108, 0.110 ), vec3( 0.168, 0.162, 0.150 ), smoothstep( 0.55, 0.95, tint ) );
  chip = mix( chip, vec3( 0.112, 0.086, 0.062 ), smoothstep( 0.10, 0.0, tint ) );

  vec3 col = mix( binder, chip, face * ( 0.30 + 0.70 * crown ) );
  col *= 0.93 + drift * 0.16;
  col *= 0.94 + grain * 0.13;
  col = mix( col, binder * 1.5, ravel * 0.4 );

  // Roughness carries most of the story here: stone crowns are polished by
  // traffic, the binder between them stays dead matte.
  rough = mix( 0.95, 0.55, face * crown );
  rough = mix( rough, 0.98, ravel * 0.5 );
  rough += ( grain - 0.5 ) * 0.07;

  // 6 — deposits: grit sifting into the gaps, and old oil soaked in glossy.
  float grit = smoothstep( 0.35, 0.75, fbm( uv + 21.0, vec2( 12.0 ), 3 ) );
  float oil = smoothstep( 0.74, 0.95, fbm( uv + 31.7, vec2( 6.0 ), 3 ) );
  col = mix( col, vec3( 0.030, 0.028, 0.030 ), oil * 0.6 );
  rough = mix( rough, 0.30, oil * 0.75 );

  dirt = sat( grit * 0.9 + 0.15 );

  albedo = col;
  metal = 0.0;
}` },

  brick: {
    normal: 2.2, relief: 60, grime: 0.75, wear: 0.16, wearMetal: 0.0,
    grimeColor: [0.042, 0.038, 0.033], wearColor: [0.54, 0.46, 0.41],
    detail: [13, 0.45], macro: [0.026, 0.22, 0.10], splash: [1.9, 0.65], dust: 0.09,
    glsl: /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  vec2 COURSE = vec2( 10.0, 30.0 );     // bricks across, courses up (even, so
                                        // the running-bond offset also wraps)

  float fy = uv.y * COURSE.y;
  float row = floor( fy );
  float ly = fy - row;
  float fx = uv.x * COURSE.x + mod( row, 2.0 ) * 0.5;
  float col = floor( fx );
  float lx = fx - col;

  // Per-brick identity. Bricks out of the same kiln load still vary hugely, and
  // that spread is the single most recognisable thing about brickwork.
  vec2 cell = vec2( col, row );
  vec2 id = hash2( cell, COURSE );
  float id2 = hash1( cell, COURSE );

  // Joint mask. The cell is 3:1, so the vertical fraction is 3x the horizontal
  // one to make the mortar the same physical thickness in both directions.
  float ex = min( lx, 1.0 - lx ) / 0.055;
  float ey = min( ly, 1.0 - ly ) / 0.165;
  float e = min( ex, ey );
  float slump = fbm( uv, vec2( 40.0 ), 3 ) * 0.35;
  float brickFace = smoothstep( 0.70 + slump, 1.45 + slump, e );

  float grain = fbm( uv, vec2( 110.0 ), 3 );
  float coarse = fbm( uv + id.x * 9.0, vec2( 26.0 ), 3 );

  // Face detail: shallow pitting, plus chipped arrises on a minority of bricks.
  vec3 pit = worley( uv + id.y * 13.0, vec2( 70.0 ) );
  float pits = smoothstep( 0.13, 0.0, pit.x ) * step( 0.55, pit.z );
  float chip = step( 0.72, id2 ) * smoothstep( 1.9, 0.7, e )
             * smoothstep( 0.45, 0.75, fbm( uv, vec2( 46.0 ), 3 ) );

  // Whole-brick spalling: the face has blown off and the pale core shows.
  float spall = step( 0.93, id2 ) * smoothstep( 0.40, 0.75, fbm( uv + id.y * 4.0, vec2( 18.0 ), 3 ) ) * brickFace;

  // A crack that prefers to travel through the joints.
  float crack = smoothstep( 0.90, 0.995, ridged( warp( uv, vec2( 3.0, 6.0 ), 0.04, 2 ), vec2( 5.0, 9.0 ), 4 ) );
  crack *= 0.35 + 0.65 * ( 1.0 - brickFace );

  height = mix( 0.26, 0.80, brickFace )
         + brickFace * ( ( coarse - 0.5 ) * 0.07 - pits * 0.30 - chip * 0.24 - spall * 0.10 )
         + ( 1.0 - brickFace ) * ( grain - 0.5 ) * 0.10
         + ( grain - 0.5 ) * 0.03
         - crack * 0.30;

  cav = 1.0 - sat( ( 1.0 - brickFace ) * 0.95 + pits * 0.7 + chip * 0.55 + crack * 0.9 );

  // Fired-clay palette: dark ironspot, common red, and a handful of pale
  // underfired bricks. Only lightly saturated — Level.js supplies the clay hue
  // as a tint — but with a wide *value* spread, which is what the eye reads.
  float t = id.x * id.x * ( 3.0 - 2.0 * id.x );   // bias the lottery toward the
                                                 // common reds; pale outliers
                                                 // that repeat every tile are
                                                 // the loudest tiling tell
  vec3 clay = mix( vec3( 0.092, 0.062, 0.052 ), vec3( 0.310, 0.222, 0.188 ), smoothstep( 0.0, 0.60, t ) );
  clay = mix( clay, vec3( 0.400, 0.304, 0.258 ), smoothstep( 0.60, 0.94, t ) );
  clay *= 0.74 + coarse * 0.54;
  clay *= 0.94 + grain * 0.12;
  clay = mix( clay, clay * 1.35 + vec3( 0.05, 0.045, 0.040 ), spall * 0.8 );

  // Mortar is markedly lighter than the brick it beds — that value step is what
  // makes a wall read as courses instead of as a noisy sheet.
  vec3 mortar = vec3( 0.545, 0.536, 0.512 ) * ( 0.78 + fbm( uv + 3.7, vec2( 60.0 ), 3 ) * 0.46 );

  vec3 colr = mix( mortar, clay, brickFace );
  rough = mix( 0.96, 0.78 + coarse * 0.14, brickFace );
  rough = mix( rough, 0.93, spall * 0.6 );

  // Deposits. Rain streaking down the face, efflorescence blooming out of the
  // mortar, moss where the wall stays damp.
  float seed = fbm( vec2( uv.x, 0.61 ), vec2( 8.0, 1.0 ), 3 );
  float body = runoff( warp( uv, vec2( 3.0, 6.0 ), 0.050, 2 ), 26.0, 2.0, 3 );
  float streak = smoothstep( 0.56, 0.94, seed * 0.55 + body * 0.62 );
  colr = mix( colr, vec3( 0.068, 0.058, 0.050 ), streak * 0.45 );
  rough = mix( rough, 0.70, streak * 0.35 );

  float efflor = smoothstep( 0.64, 0.94, fbm( uv + 17.3, vec2( 8.0 ), 3 ) ) * ( 1.0 - brickFace * 0.55 );
  colr = mix( colr, vec3( 0.790, 0.782, 0.756 ), efflor * 0.45 );
  rough = mix( rough, 0.98, efflor * 0.55 );

  float moss = smoothstep( 0.66, 0.95, fbm( uv + 6.6, vec2( 6.0, 5.0 ), 3 ) ) * ( 1.0 - cav * 0.5 );
  colr = mix( colr, vec3( 0.070, 0.092, 0.046 ), moss * 0.65 );
  rough = mix( rough, 0.96, moss * 0.6 );

  // Soot goes into the joints first and follows the streaks down the face.
  dirt = sat( ( 1.0 - brickFace ) * 0.9 + streak * 0.8
            + smoothstep( 0.30, 0.88, fbm( uv + 29.0, vec2( 2.0 ), 3 ) ) * 0.80 );

  albedo = colr;
  metal = 0.0;
}` },

  metalPanel: {
    size: SIZE.medium,
    normal: 1.6, relief: 44, grime: 0.55, wear: 0.30, wearMetal: 1.0,
    grimeColor: [0.050, 0.048, 0.043], wearColor: [0.50, 0.508, 0.520],
    detail: [15, 0.35], macro: [0.030, 0.14, 0.10], splash: [1.5, 0.55], dust: 0.14,
    metalness: 1.0,
    glsl: /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  // 1 — painted steel cladding, riveted to a frame on a 4x4 bay grid.
  vec3 steel = vec3( 0.600, 0.608, 0.624 );
  vec3 paint = vec3( 0.310, 0.330, 0.342 );

  vec2 cellUv = fract( uv * 4.0 );

  // 2 — panel seams and the shallow oil-canning dish in the middle of each bay.
  float seamX = min( cellUv.x, 1.0 - cellUv.x );
  float seamY = min( cellUv.y, 1.0 - cellUv.y );
  float seam = smoothstep( 0.004, 0.028, min( seamX, seamY ) );
  float dish = fbm( uv, vec2( 4.0 ), 2 );

  // 3 — rivets marching down the vertical seams at a fixed pitch.
  vec2 rp = fract( uv * vec2( 4.0, 28.0 ) ) - 0.5;
  float rivet = smoothstep( 0.40, 0.22, length( rp * vec2( 7.0, 1.0 ) ) )
              * smoothstep( 0.070, 0.026, seamX );

  // 4 — micro: the directional grain of rolled and brushed sheet.
  float brushed = fbm( uv, vec2( 420.0, 6.0 ), 3 );
  float tooth = fbm( uv, vec2( 90.0 ), 3 );

  // 5 — damage. Paint fails from the edges inward, so the loss mask is driven
  //     by a warped field thresholded tightly and then eaten back along a
  //     higher-frequency fringe: flakes with ragged perimeters, not blobs.
  float dent = smoothstep( 0.62, 0.96, fbm( uv + 9.1, vec2( 7.0 ), 3 ) );
  float scratch = smoothstep( 0.965, 1.0, ridged( warp( uv, vec2( 5.0 ), 0.06, 2 ), vec2( 14.0, 5.0 ), 3 ) );
  float lossField = fbm( warp( uv + 2.4, vec2( 7.0 ), 0.05, 2 ), vec2( 13.0 ), 3 );
  float fringe = fbm( uv + 6.1, vec2( 60.0 ), 3 );
  float flake = smoothstep( 0.60, 0.70, lossField * 0.80 + fringe * 0.20 );

  height = 0.62 - ( 1.0 - seam ) * 0.32 + rivet * 0.30 + ( dish - 0.5 ) * 0.07
         - dent * 0.06 + ( brushed - 0.5 ) * 0.02 + ( tooth - 0.5 ) * 0.025
         - scratch * 0.10 - flake * 0.06;

  cav = 1.0 - sat( ( 1.0 - seam ) * 0.95 + scratch * 0.6 + flake * 0.25 );

  // Paint over metal: where the coat survives it is a dielectric, where it has
  // flaked the bare steel shows through. That is what metalness has to encode.
  float bare = sat( flake * 0.9 + scratch );
  vec3 colr = mix( paint * ( 0.78 + dish * 0.45 ), steel * ( 0.88 + brushed * 0.26 ), bare * 0.85 );
  colr *= 0.88 + tooth * 0.24;
  colr *= 0.86 + fbm( uv + 41.0, vec2( 5.0 ), 3 ) * 0.34;   // panel-to-panel fade
  colr *= 0.84 + fbm( uv + 63.0, vec2( 11.0 ), 3 ) * 0.36;  // weathering within a bay
  colr = mix( colr, steel * 1.05, rivet * 0.5 );
  metal = bare * 0.95;

  rough = mix( 0.54 + tooth * 0.14, 0.34 + brushed * 0.24, bare );
  rough = mix( rough, 0.28, scratch * 0.6 );

  // 6 — deposits: rust bleeding DOWN from every rivet and seam. The source mask
  //     is the fixing itself; the smear is a vertically stretched field gated
  //     by it, so the stain always has somewhere it came from.
  float source = sat( rivet * 1.6 + ( 1.0 - seam ) * 0.7 + flake * 0.5 );
  float down = runoff( warp( uv, vec2( 4.0, 10.0 ), 0.010, 2 ), 48.0, 4.0, 3 );
  float bleed = sat( source * 0.55 + smoothstep( 0.50, 0.86, down ) * smoothstep( 0.05, 0.45, source ) );
  colr = mix( colr, vec3( 0.245, 0.118, 0.052 ), bleed * 0.60 );
  rough = mix( rough, 0.93, bleed * 0.7 );
  metal *= 1.0 - bleed * 0.85;

  dirt = sat( ( 1.0 - seam ) * 0.9 + bleed * 0.7
            + smoothstep( 0.35, 0.85, fbm( uv + 27.0, vec2( 6.0 ), 3 ) ) * 0.6 );

  albedo = colr;
}` },

  rustMetal: {
    size: SIZE.medium,
    normal: 1.8, relief: 46, grime: 0.42, wear: 0.22, wearMetal: 1.0,
    grimeColor: [0.048, 0.042, 0.036], wearColor: [0.430, 0.436, 0.446],
    detail: [14, 0.50], macro: [0.035, 0.18, 0.12], splash: [1.2, 0.60], dust: 0.16,
    metalness: 1.0,
    glsl: /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  // 1 — mild steel that lost its paint years ago.
  vec3 steel = vec3( 0.560, 0.570, 0.588 );

  // 2 — the rust front. Ridged noise gives oxidation an advancing edge rather
  //     than a soft blob, which is what real corrosion looks like.
  vec2 wu = warp( uv, vec2( 3.0 ), 0.08, 3 );
  float front = ridged( wu, vec2( 4.0 ), 4 );
  //     Biased hard toward "corroded": a drum that has stood outside for years
  //     is rust with slivers of steel, not steel with patches of rust. Left
  //     even, the clean islands blow out to near-white under a bright sky.
  float rust = smoothstep( 0.16, 0.56, front * 0.65 + fbm( wu, vec2( 7.0 ), 3 ) * 0.55 );

  // 3 — three stages of corrosion, each with its own colour and relief: thin
  //     bloom, thick orange scale, and black pitted iron oxide.
  float scale = smoothstep( 0.55, 0.90, rust + fbm( uv + 5.0, vec2( 16.0 ), 3 ) * 0.35 - 0.18 );
  float deep = smoothstep( 0.80, 1.0, rust ) * smoothstep( 0.45, 0.85, fbm( uv + 12.0, vec2( 10.0 ), 3 ) );

  // 4 — micro: mill scale tooth on the bare steel, granular flake on the rust.
  float mill = fbm( uv, vec2( 140.0 ), 3 );
  float flake = fbm( uv + 3.3, vec2( 46.0 ), 3 );
  vec3 pit = worley( uv + 8.8, vec2( 58.0 ) );
  float pits = smoothstep( 0.16, 0.0, pit.x ) * rust;

  // 5 — dents, and a seam weld running across the sheet.
  float dent = fbm( uv + 19.0, vec2( 5.0 ), 3 );
  float weld = smoothstep( 0.030, 0.0, abs( fract( uv.y * 2.0 + fbm( uv, vec2( 12.0, 3.0 ), 2 ) * 0.05 ) - 0.5 ) );

  height = 0.55 + ( dent - 0.5 ) * 0.10 + ( mill - 0.5 ) * 0.03
         + rust * 0.06 + scale * ( flake - 0.35 ) * 0.30 - pits * 0.34
         + weld * 0.11 - deep * 0.12;

  cav = 1.0 - sat( pits * 0.85 + deep * 0.60 + scale * 0.22 );

  vec3 bloom = vec3( 0.300, 0.186, 0.116 );
  vec3 orange = vec3( 0.430, 0.212, 0.086 );
  vec3 black = vec3( 0.106, 0.076, 0.058 );

  vec3 colr = steel * ( 0.62 + mill * 0.34 );
  colr = mix( colr, bloom, rust );
  colr = mix( colr, orange * ( 0.70 + flake * 0.62 ), scale );
  colr = mix( colr, black, deep * 0.88 );
  colr = mix( colr, vec3( 0.500, 0.500, 0.510 ), weld * 0.5 * ( 1.0 - rust ) );

  // Rust is an oxide, not a metal — the single biggest tell if authored wrong,
  // because metallic rust turns bronze under any sky light.
  metal = ( 1.0 - sat( rust * 0.9 + scale * 0.6 ) ) * 0.95;
  rough = mix( 0.32 + mill * 0.16, 0.93, sat( rust * 0.8 + scale ) );
  rough = mix( rough, 0.99, deep * 0.7 );

  // 6 — rust bleeding down out of the corroded patches onto the clean steel.
  float down = runoff( warp( uv, vec2( 4.0, 12.0 ), 0.010, 2 ), 52.0, 4.0, 3 );
  float bleed = smoothstep( 0.55, 0.92, down ) * smoothstep( 0.1, 0.5, rust + 0.28 ) * ( 1.0 - scale );
  colr = mix( colr, vec3( 0.290, 0.144, 0.062 ), bleed * 0.6 );
  rough = mix( rough, 0.90, bleed * 0.6 );
  metal *= 1.0 - bleed * 0.75;

  dirt = sat( deep * 0.8 + scale * 0.35 + bleed * 0.5 + 0.12 );

  albedo = colr;
}` },

  plaster: {
    normal: 1.2, relief: 30, grime: 0.68, wear: 0.14, wearMetal: 0.0,
    grimeColor: [0.062, 0.058, 0.050], wearColor: [0.80, 0.780, 0.740],
    detail: [12, 0.50], macro: [0.028, 0.22, 0.12], splash: [1.8, 0.68], dust: 0.10,
    glsl: /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  // 1 — lime render over masonry. Near-neutral so the five tinted variants
  //     Level.js derives from this one map all land somewhere believable.
  vec3 render = vec3( 0.690, 0.678, 0.646 );

  // 2 — sun-bleached and water-stained tonal patches, deliberately wide.
  float tone = fbm( uv, vec2( 2.0 ), 3 );
  float stain = smoothstep( 0.40, 0.86, fbm( uv + 6.2, vec2( 4.0 ), 3 ) );

  // 3 — trowel work: broad swept arcs left by the float, then the stipple.
  vec2 tw = warp( uv, vec2( 3.0 ), 0.10, 3 );
  float trowel = fbm( tw, vec2( 9.0, 6.0 ), 3 );
  float stipple = fbm( uv, vec2( 64.0 ), 3 );
  float tooth = fbm( uv, vec2( 170.0 ), 2 );

  // 4 — damage: shrinkage cracks, then whole patches of render fallen away to
  //     reveal the masonry behind. That sub-layer is the story of the material,
  //     so the loss threshold is set where it actually fires often enough to see.
  //
  //     The crack network is a *contour*, not a threshold on a rough field. A
  //     single-octave ridged crest is the zero set of a smooth function, which
  //     is by construction one continuous curve; every octave above the first
  //     chops that curve into short arcs, and thresholding those arcs high is
  //     precisely how a crack network degenerates into a scatter of black
  //     comma-shaped ticks that repeat with the tile. One octave, two
  //     independent generations, and a fine one that only fires where the
  //     coarse one is already close — cracks branch off cracks.
  vec2 cw = warp( uv, vec2( 2.0 ), 0.11, 2 );
  float ridgeA = ridged( cw, vec2( 3.0, 2.0 ), 1 );
  float ridgeB = ridged( cw + 7.9, vec2( 2.0, 4.0 ), 1 );
  float crackMain = max( smoothstep( 0.940, 0.994, ridgeA ),
                         smoothstep( 0.958, 0.996, ridgeB ) * 0.80 );
  float crackFine = smoothstep( 0.966, 0.998, ridged( cw + 2.6, vec2( 11.0, 9.0 ), 1 ) )
                  * smoothstep( 0.55, 0.86, max( ridgeA, ridgeB ) );
  // Crazing is patchy: render cracks where the substrate moved and where damp
  // got behind it, not evenly over every square metre. An unmasked network at
  // full strength covers a wall in what reads as handwriting.
  float crackZone = smoothstep( 0.40, 0.74, fbm( uv + 13.1, vec2( 2.0 ), 3 ) );
  float crack = sat( crackMain + crackFine * 0.45 ) * ( 0.16 + 0.84 * crackZone );
  float lossField = fbm( warp( uv + 15.0, vec2( 4.0 ), 0.05, 2 ), vec2( 5.0 ), 3 );
  // Ragged perimeter: a high-frequency fringe eats into the threshold so the
  //     patches lose their blobby silhouette.
  float fringe = fbm( uv + 9.7, vec2( 44.0 ), 3 );
  float lossMix = lossField * 0.86 + fringe * 0.14;
  float loss = smoothstep( 0.645, 0.715, lossMix );
  float lip = smoothstep( 0.715, 0.645, lossMix ) * smoothstep( 0.600, 0.660, lossMix );

  // The exposed substrate: coarse brick courses, low contrast so it reads as
  // "something structural behind" rather than as a second competing texture.
  float sy = uv.y * 24.0;
  float srow = floor( sy );
  float sx = uv.x * 8.0 + mod( srow, 2.0 ) * 0.5;
  float joint = smoothstep( 0.90, 0.99, max( abs( fract( sx ) - 0.5 ), abs( fract( sy ) - 0.5 ) ) * 2.0 );
  vec3 substrate = mix( vec3( 0.455, 0.352, 0.292 ), vec3( 0.560, 0.548, 0.520 ), joint );
  substrate *= 0.86 + fbm( uv, vec2( 50.0 ), 3 ) * 0.30;

  height = 0.66 + ( tone - 0.5 ) * 0.07 + ( trowel - 0.5 ) * 0.10 + ( stipple - 0.5 ) * 0.10
         + ( tooth - 0.5 ) * 0.03 - crack * 0.13 - loss * 0.34 + lip * 0.07;

  // A hairline in lime render is a shadow slot, not an inkwell. Letting the
  // crack drive cavity to zero handed the finish pass a licence to fill it with
  // near-black grime, which is what turned a 1 cm crack into a painted glyph.
  cav = 1.0 - sat( crack * 0.12 + loss * 0.28 + ( 1.0 - stipple ) * 0.22 );

  vec3 colr = render * ( 0.70 + tone * 0.62 );
  colr = mix( colr, render * 0.66, stain * 0.45 );
  colr *= 0.92 + stipple * 0.17;
  colr = mix( colr, substrate, loss * 0.88 );
  colr = mix( colr, render * 1.12, lip * 0.45 );
  colr = mix( colr, colr * 0.80, crack * 0.34 );

  rough = mix( 0.92 + ( stipple - 0.5 ) * 0.08, 0.90, loss );

  // 5 — deposits: heavy vertical staining, then moss where it stays damp.
  float seed = fbm( vec2( uv.x, 0.19 ), vec2( 7.0, 1.0 ), 3 );
  float body = runoff( warp( uv, vec2( 3.0, 6.0 ), 0.055, 2 ), 24.0, 2.0, 3 );
  float streak = smoothstep( 0.54, 0.94, seed * 0.52 + body * 0.64 );
  colr = mix( colr, vec3( 0.185, 0.172, 0.148 ), streak * 0.55 );
  rough = mix( rough, 0.75, streak * 0.40 );

  float moss = smoothstep( 0.64, 0.95, fbm( uv + 4.4, vec2( 5.0, 4.0 ), 3 ) ) * ( 1.0 - cav * 0.55 );
  colr = mix( colr, vec3( 0.078, 0.102, 0.050 ), moss * 0.65 );
  rough = mix( rough, 0.96, moss * 0.6 );

  dirt = sat( stain * 0.8 + streak * 0.85 + loss * 0.18 + 0.12 );

  albedo = colr;
  metal = 0.0;
}` },

  sand: {
    normal: 1.1, relief: 26, grime: 0.22, wear: 0.08, wearMetal: 0.0,
    grimeColor: [0.155, 0.136, 0.104], wearColor: [0.74, 0.690, 0.580],
    detail: [16, 0.55], macro: [0.020, 0.24, 0.10], splash: [0.0, 0.0], dust: 0.12,
    glsl: /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  // 1 — dry sand. Bright and almost perfectly matte; only faintly warm so the
  //     sandbag and open-ground tints can pull it in either direction.
  vec3 dry = vec3( 0.640, 0.588, 0.496 );
  vec3 damp = vec3( 0.330, 0.294, 0.232 );

  // 2 — dunes: a low-frequency drift the ripples ride on.
  float dune = fbm( uv, vec2( 2.0 ), 3 );

  // 3 — wind ripples. A heavily warped sine beats layered fbm here because real
  //     ripples have a crest line; the warp keeps them from reading as a comb.
  vec2 rw = warp( uv, vec2( 3.0 ), 0.16, 3 );
  float ripple = sin( ( rw.x * 3.0 + rw.y * 9.0 ) * 6.28318530718 ) * 0.5 + 0.5;
  ripple = pow( ripple, 1.6 );
  float cross = sin( ( rw.x * 7.0 - rw.y * 4.0 ) * 6.28318530718 ) * 0.5 + 0.5;
  ripple = mix( ripple, ripple * ( 0.55 + 0.45 * cross ), 0.5 );

  // 4 — micro: individual grains, plus pebbles and shell fragments.
  float grain = fbm( uv, vec2( 230.0 ), 2 );
  vec3 peb = worley( uv + 3.9, vec2( 34.0 ) );
  float pebble = smoothstep( 0.16, 0.05, peb.x ) * step( 0.80, peb.z );

  // 5 — scour: wind-swept hollows where the fines have blown out.
  float scour = smoothstep( 0.54, 0.86, fbm( uv + 22.0, vec2( 6.0 ), 3 ) );

  height = 0.50 + ( dune - 0.5 ) * 0.22 + ripple * 0.20
         + ( grain - 0.5 ) * 0.05 + pebble * 0.18 - scour * 0.10;

  cav = 1.0 - sat( ( 1.0 - ripple ) * 0.45 + scour * 0.40 );

  vec3 colr = dry * ( 0.80 + dune * 0.42 );
  colr = mix( colr, dry * 1.16, ripple * 0.32 );                    // lit crests
  colr = mix( colr, damp, scour * 0.40 );                           // damp hollows
  colr = mix( colr, vec3( 0.470, 0.452, 0.412 ), pebble * 0.75 );
  colr *= 0.93 + grain * 0.14;

  rough = 0.95 - ripple * 0.04 + ( grain - 0.5 ) * 0.05;
  rough = mix( rough, 0.80, pebble * 0.6 );

  dirt = sat( scour * 0.7 + ( 1.0 - ripple ) * 0.35 );

  albedo = colr;
  metal = 0.0;
}` },

  gunMetal: {
    // Weapons.js multiplies this by roughness 0.58 / metalness 0.88, so the map
    // is authored high and lets those scalars bring it down to gun finish.
    size: SIZE.medium,
    normal: 1.0, relief: 26, grime: 0.30, wear: 0.30, wearMetal: 1.0,
    grimeColor: [0.018, 0.017, 0.016], wearColor: [0.180, 0.184, 0.192],
    detail: [18, 0.30], macro: [0.0, 0.0, 0.0], splash: [0.0, 0.0], dust: 0.0,
    metalness: 1.0,
    glsl: /* glsl */ `
void surface( vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float cav, out float dirt ) {
  // 1 — manganese phosphate over steel. Nearly black, granular, and very matte
  //     until it is rubbed, which is the whole character of a used weapon.
  vec3 park = vec3( 0.0295, 0.0300, 0.0315 );
  vec3 steel = vec3( 0.440, 0.446, 0.458 );

  // 2 — the phosphate crystal structure: fine, tight, isotropic.
  vec3 cry = worley( uv, vec2( 170.0 ) );
  float crystal = smoothstep( 0.55, 0.05, cry.x );
  float micro = fbm( uv, vec2( 260.0 ), 2 );

  // 3 — machining: fine longitudinal tool marks on the receiver flats.
  float tool = fbm( uv, vec2( 520.0, 8.0 ), 2 );

  // 4 — handling wear. Narrow and sparse: a service weapon is polished along
  //     the few edges a hand and a sling actually touch, not blotched all over.
  vec2 wu = warp( uv, vec2( 4.0 ), 0.05, 2 );
  float rub = smoothstep( 0.80, 0.99, ridged( wu, vec2( 5.0, 3.0 ), 4 ) );
  float scratch = smoothstep( 0.975, 1.0, ridged( warp( uv, vec2( 6.0 ), 0.05, 2 ), vec2( 22.0, 6.0 ), 3 ) );

  // 5 — carbon fouling: soot baked into the finish, matte and light-absorbing.
  float carbon = smoothstep( 0.55, 0.90, fbm( uv + 8.2, vec2( 5.0 ), 3 ) );

  height = 0.60 + ( crystal - 0.5 ) * 0.10 + ( micro - 0.5 ) * 0.05
         + ( tool - 0.5 ) * 0.03 + rub * 0.03 - scratch * 0.18;

  cav = 1.0 - sat( ( 1.0 - crystal ) * 0.30 + scratch * 0.7 );

  float bare = sat( rub * 0.8 + scratch );
  // Polished phosphate silvers only slightly; almost all of the read is the
  // roughness drop below. Driving it through albedo gives a magpie finish.
  vec3 colr = mix( park * ( 0.80 + crystal * 0.55 ), steel * ( 0.92 + tool * 0.16 ), bare * 0.22 );
  colr = mix( colr, park * 0.55, carbon * 0.6 );

  metal = mix( 0.88, 1.0, bare );
  // Authored high: Weapons.js scales this down to reach the final finish.
  rough = mix( 0.96 - crystal * 0.10, 0.52 + tool * 0.14, bare );
  rough = mix( rough, 1.0, carbon * 0.35 );
  rough = mix( rough, 0.40, scratch * 0.7 );

  dirt = sat( carbon * 0.9 + 0.10 );

  albedo = colr;
}` },
};

// ---------------------------------------------------------------------------
// Shader injection applied to every material this library hands out
// ---------------------------------------------------------------------------

const WEATHER_PARS = /* glsl */ `
uniform sampler2D uDetailNormal;
uniform vec2 uDetail;       // x tiles-per-uv, y strength
uniform vec2 uDetailFade;   // x fade start, y fade end (view metres)
uniform vec3 uMacro;        // x world frequency, y albedo swing, z roughness swing
uniform vec2 uSplash;       // x reach in metres, y strength
uniform float uDust;
uniform vec3 uGrimeTint;
uniform vec3 uDustTint;
varying vec3 vWorldPos;

float wHash( vec2 p ) {
  vec3 q = fract( vec3( p.x, p.y, p.x + p.y ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}

float wNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wHash( i ), wHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( wHash( i + vec2( 0.0, 1.0 ) ), wHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
`;

// Injected immediately before <lights_physical_fragment>, where diffuseColor,
// roughnessFactor, metalnessFactor and the final shading normal all exist.
const WEATHER_BODY = /* glsl */ `
{
  // World-space weathering. None of this tiles with the texture, which is what
  // kills the repeat grid on a ground plane tiled 42 times, and what beds props
  // into the floor instead of leaving them floating on it.
  vec3 wN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
  float macro = wNoise( vWorldPos.xz * uMacro.x ) * 0.62
              + wNoise( vWorldPos.xz * uMacro.x * 3.7 + 11.0 ) * 0.38;

  diffuseColor.rgb *= 1.0 + ( macro - 0.5 ) * uMacro.y;
  roughnessFactor = clamp( roughnessFactor + ( macro - 0.5 ) * uMacro.z, 0.035, 1.0 );

  // Dirt thrown up off the ground: strongest at the base, gone by waist height,
  // and biased off surfaces that face the sky (rain washes those clean).
  float splash = smoothstep( uSplash.x, 0.0, vWorldPos.y ) * uSplash.y;
  splash *= 0.45 + 1.05 * wNoise( vWorldPos.xz * 1.7 + vWorldPos.y * 0.9 );
  splash *= 1.0 - saturate( wN.y ) * 0.65;
  splash = clamp( splash, 0.0, 0.8 );
  diffuseColor.rgb = mix( diffuseColor.rgb, uGrimeTint, splash );
  roughnessFactor = clamp( roughnessFactor + splash * 0.30, 0.035, 1.0 );
  metalnessFactor *= 1.0 - splash * 0.85;

  // Dust settles on anything facing up. Bright, matte, and it is what makes a
  // horizontal surface read as horizontal.
  float dust = saturate( wN.y );
  dust = dust * dust * uDust * ( 0.35 + 1.15 * macro );
  dust = clamp( dust, 0.0, 0.7 );
  diffuseColor.rgb = mix( diffuseColor.rgb, uDustTint, dust );
  roughnessFactor = clamp( roughnessFactor + dust * 0.28, 0.035, 1.0 );
  metalnessFactor *= 1.0 - dust * 0.8;
}
`;

// Spliced into <normal_fragment_maps> right after the base normal is unpacked.
const DETAIL_BLEND = /* glsl */ `
	mapN.xy *= normalScale;
	{
		// Detail normal. The base map is authored for a couple of metres of wall;
		// this layer tiles an order of magnitude faster so the surface still has
		// structure with the muzzle pressed against it. Faded out with distance,
		// otherwise it aliases into shimmer past a few metres.
		vec3 dN = texture2D( uDetailNormal, vNormalMapUv * uDetail.x ).xyz * 2.0 - 1.0;
		float dFade = 1.0 - smoothstep( uDetailFade.x, uDetailFade.y, length( vViewPosition ) );
		mapN = normalize( vec3( mapN.xy + dN.xy * uDetail.y * dFade, mapN.z ) );
	}
`;

/** Splice a three.js ShaderChunk inline so its body can be patched. */
function inlineChunk(src, name) {
  return src.replace(`#include <${name}>`, THREE.ShaderChunk[name]);
}

export class TextureLibrary {
  constructor(renderer, seed = 1) {
    this.renderer = renderer;
    this.seed = seed;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.sets = new Map();
    this.materials = new Map();
    this.sprites = new Map();
    this.res = SIZE.high;
    this.buildMs = 0;

    // Half-float scratch keeps the height field smooth enough that the Sobel in
    // the normal pass does not terrace. Falls back to 8-bit where the float
    // colour-buffer extension is missing (some software rasterisers).
    const hasFloatRT = renderer.extensions.has('EXT_color_buffer_float')
      || renderer.extensions.has('EXT_color_buffer_half_float');
    this._scratchType = hasFloatRT ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    this._passes = new Map();   // fragment source -> ShaderMaterial
    this._scratch = new Map();  // resolution -> { field, curv }
  }

  async build(onProgress = () => {}) {
    const t0 = performance.now();
    const names = Object.keys(MATERIALS);

    onProgress(0, 'SYNTHESISING DETAIL');
    this.detailNormal = this._buildDetailNormal();

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      onProgress(i / names.length, `SYNTHESISING ${name.toUpperCase()}`);
      this.sets.set(name, this._generate(name, MATERIALS[name]));
      // Yield so the loading bar actually animates between materials.
      await new Promise((r) => setTimeout(r, 0));
    }

    this._releaseTemporaries();
    this.buildMs = Math.round(performance.now() - t0);
    console.info(`[TextureLibrary] ${names.length} materials at ${this.res}px in ${this.buildMs} ms`);
    onProgress(1, 'MATERIALS READY');
    return this;
  }

  get(name) { return this.sets.get(name); }
  list() { return [...this.sets.keys()]; }

  /** Single texture for billboards and UI — the albedo of a named set. */
  sprite(name) {
    if (this.sprites.has(name)) return this.sprites.get(name);
    const t = this.sets.get(name)?.map || null;
    this.sprites.set(name, t);
    return t;
  }

  material(name, opts = {}) {
    const key = name + JSON.stringify(opts);
    if (this.materials.has(key)) return this.materials.get(key);

    const set = this.sets.get(name);
    const { repeat, ...params } = opts;
    const mat = new THREE.MeshStandardMaterial({
      map: set?.map || null,
      normalMap: set?.normalMap || null,
      roughnessMap: set?.ormMap || null,
      aoMap: set?.ormMap || null,
      metalnessMap: (set?.metalness ?? 0) > 0 ? set.ormMap : null,
      metalness: set?.metalness ?? 0,
      roughness: set?.roughness ?? 1,
      ...params,
    });
    if (set) this.decorate(mat, name);
    if (repeat) this.setRepeat(mat, repeat[0], repeat[1]);
    this.materials.set(key, mat);
    return mat;
  }

  setRepeat(material, u, v) {
    // Maps are shared between every material of a given name, so retiling one
    // retiles them all. Level.js requests a single repeat per material name,
    // which is the arrangement this library is built around.
    for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap', 'displacementMap']) {
      const t = material[k];
      if (!t) continue;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(u, v);
      // The UV transform is rebuilt every frame from matrixAutoUpdate, so no
      // re-upload is needed — and flagging a render-target texture for update
      // makes the renderer re-allocate it from its (empty) image and lose the
      // pixels we just generated.
      if (!t.isRenderTargetTexture) t.needsUpdate = true;
    }
    return material;
  }

  // --- shader injection -----------------------------------------------------

  /**
   * Attach the two layers no baked texture can provide: a much higher-frequency
   * detail normal that survives being magnified, and world-space weathering
   * (macro tonal drift, ground splash, settled dust) that deliberately does not
   * repeat with the UVs.
   *
   * `material()` applies this automatically. It is public so that a consumer
   * building its own MeshStandardMaterial from `get(name)` — Level.js does, to
   * get independent tiling — can opt into the same treatment with one call.
   */
  decorate(mat, name) {
    const def = MATERIALS[name];
    if (!def) return mat;
    const u = {
      uDetailNormal: { value: this.detailNormal },
      uDetail: { value: new THREE.Vector2(def.detail[0], def.detail[1]) },
      uDetailFade: { value: new THREE.Vector2(7, 26) },
      uMacro: { value: new THREE.Vector3(...def.macro) },
      uSplash: { value: new THREE.Vector2(...def.splash) },
      uDust: { value: def.dust },
      uGrimeTint: { value: new THREE.Color().fromArray(def.grimeColor) },
      uDustTint: { value: new THREE.Color(0.34, 0.30, 0.235) },
    };
    mat.userData.weathering = u;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);

      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec3 vWorldPos;\nvoid main() {')
        .replace('#include <project_vertex>',
          '#include <project_vertex>\n\tvWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');

      // onBeforeCompile sees unresolved #include directives, so the chunk we
      // need to patch has to be spliced in by hand first.
      shader.fragmentShader = inlineChunk(shader.fragmentShader, 'normal_fragment_maps')
        .replace('#include <common>', '#include <common>\n' + WEATHER_PARS)
        .replace('\tmapN.xy *= normalScale;\n', DETAIL_BLEND)
        .replace('#include <lights_physical_fragment>', WEATHER_BODY + '#include <lights_physical_fragment>');
    };
    // Programs differ per material because the injected constants differ only
    // through uniforms, but the detail/weather block itself is identical — one
    // cache key for the whole family keeps the program count down.
    mat.customProgramCacheKey = () => 'texgen-weathered';
    return mat;
  }

  // --- GPU pass plumbing ----------------------------------------------------

  _passMaterial(fragmentShader, uniforms, mrt) {
    let m = this._passes.get(fragmentShader);
    if (!m) {
      m = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader,
        uniforms,
        depthTest: false,
        depthWrite: false,
        glslVersion: mrt ? THREE.GLSL3 : null,
      });
      this._passes.set(fragmentShader, m);
    } else {
      for (const k in uniforms) m.uniforms[k].value = uniforms[k].value;
    }
    return m;
  }

  _render(fragmentShader, uniforms, target, mrt = false) {
    this._quad.material = this._passMaterial(fragmentShader, uniforms, mrt);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quadScene, this._quadCamera);
    this.renderer.setRenderTarget(prev);
  }

  // Every target here is an intermediate that is either sampled 1:1 by the next
  // pass or read straight back, so none of them need mipmaps. RepeatWrapping is
  // what keeps the Sobel and the horizon sweep continuous across the tile seam.
  _target(size, { count = 1, type = THREE.UnsignedByteType } = {}) {
    return new THREE.WebGLRenderTarget(size, size, {
      count,
      type,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  /**
   * Pull a finished render target back into an ordinary DataTexture.
   *
   * Render-target textures cannot be cloned — a clone has no entry in the
   * renderer's source cache, so it allocates a fresh empty GL texture and the
   * generated pixels vanish. Level.js legitimately clones these sets to give
   * itself independent tiling, so everything this library publishes has to be a
   * plain texture. The readback is a one-off cost at load; all the actual
   * synthesis still happened on the GPU.
   */
  _publish(target, index, size, srgb) {
    const data = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, size, size, data, undefined, index);
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = this.maxAniso;
    t.needsUpdate = true;
    return t;
  }

  /** Scratch buffers are shared across materials of the same resolution. */
  _scratchFor(size) {
    let s = this._scratch.get(size);
    if (!s) {
      s = {
        field: this._target(size, { count: 2, type: this._scratchType }),
        curv: this._target(size >> 1),
      };
      this._scratch.set(size, s);
    }
    return s;
  }

  /** Generation is a one-shot; the scratch buffers and pass programs can go. */
  _releaseTemporaries() {
    for (const s of this._scratch.values()) { s.field.dispose(); s.curv.dispose(); }
    this._scratch.clear();
    for (const m of this._passes.values()) m.dispose();
    this._passes.clear();
    this._quad.geometry.dispose();
    this._quad.material = null;
  }

  // --- generation -----------------------------------------------------------

  _seedFor(name) {
    // Stable per-material offset so two materials never share a noise field.
    let h = this.seed >>> 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
    return (h % 100000) / 100000;
  }

  _buildDetailNormal() {
    const N = SIZE.medium;
    const field = this._target(N, { count: 2, type: this._scratchType });
    const out = this._target(N);
    const seed = { value: this._seedFor('detail') };

    this._render(NOISE + DETAIL_SURFACE + SURFACE_MAIN,
      { uSeed: seed, uRes: { value: N } }, field, true);
    this._render(NORMAL_FS, {
      uField: { value: field.textures[0] },
      uTexel: { value: new THREE.Vector2(1 / N, 1 / N) },
      uStrength: { value: 1.6 },
    }, out);

    const tex = this._publish(out, 0, N, false);
    field.dispose();
    out.dispose();
    return tex;
  }

  _generate(name, def) {
    const N = def.size || this.res;
    const texel = new THREE.Vector2(1 / N, 1 / N);
    const scratch = this._scratchFor(N);
    const seed = { value: this._seedFor(name) };

    const normalRT = this._target(N);
    const finalRT = this._target(N, { count: 2 });

    // 1 — the expensive one: the layered material itself.
    this._render(NOISE + def.glsl + SURFACE_MAIN,
      { uSeed: seed, uRes: { value: N } }, scratch.field, true);

    // 2 — normal from the height field, height kept in alpha.
    this._render(NORMAL_FS, {
      uField: { value: scratch.field.textures[0] },
      uTexel: { value: texel },
      uStrength: { value: def.normal },
    }, normalRT);

    // 3 — occlusion and convexity, swept at half resolution: the field is
    //     inherently low frequency and this is the only pass with a real
    //     sample loop, so the 4x saving is worth the softer edges.
    this._render(CURV_FS, {
      uField: { value: scratch.field.textures[0] },
      uTexel: { value: texel },
      uRelief: { value: def.relief },
    }, scratch.curv);

    // 4 — deposits and edge wear, now that the true cavity is known.
    this._render(FINISH_FS, {
      uField: { value: scratch.field.textures[0] },
      uSurf: { value: scratch.field.textures[1] },
      uCurv: { value: scratch.curv.texture },
      uGrimeColor: { value: new THREE.Color().fromArray(def.grimeColor) },
      uWearColor: { value: new THREE.Color().fromArray(def.wearColor) },
      uAmount: { value: new THREE.Vector4(def.grime, def.wear, 0.75, def.wearMetal) },
    }, finalRT, true);

    const map = this._publish(finalRT, 0, N, true);
    const orm = this._publish(finalRT, 1, N, false);
    const normalMap = this._publish(normalRT, 0, N, false);
    normalRT.dispose();
    finalRT.dispose();

    return {
      map,
      normalMap,
      ormMap: orm,
      roughnessMap: orm,
      aoMap: orm,
      metalnessMap: (def.metalness ?? 0) > 0 ? orm : null,
      heightMap: normalMap,   // height lives in the normal map's alpha
      metalness: def.metalness ?? 0,
      roughness: 1,
      size: N,
    };
  }
}
