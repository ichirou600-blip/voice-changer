import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * The frame graph. Renders the world at HDR precision, composites the
 * viewmodel on a cleared depth buffer so the weapon never intersects level
 * geometry, then runs the post chain.
 *
 * CONTRACT:
 *   pipeline.render(dt)
 *   pipeline.resize(w,h)
 *   pipeline.setParam(name, value)   — exposed to the settings menu
 *   pipeline.params                  — live tunables
 */

/** Renders world + viewmodel into the composer's HDR target. */
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

export class RenderPipeline {
  constructor(engine, { quality = 'high', sky } = {}) {
    this.engine = engine;
    this.sky = sky;
    this.quality = quality;

    this.params = {
      exposure: 1.0,
      bloomStrength: 0.42,
      bloomRadius: 0.55,
      bloomThreshold: 0.92,
      vignette: 0.42,
      grain: 0.045,
      chromatic: 0.0016,
      saturation: 1.06,
      contrast: 1.04,
      lift: 0.0,
      sharpen: 0.35,
    };

    const renderer = engine.renderer;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // Half-float gives the post stack real HDR headroom, but some software
    // rasterisers advertise the extension and then render nothing into it.
    // Probe once and fall back to 8-bit rather than shipping a black frame.
    this.hdr = probeHalfFloat(renderer);
    const rtOpts = {
      type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      colorSpace: THREE.NoColorSpace,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
    };
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, rtOpts);
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new WorldPass(engine));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      this.params.bloomStrength, this.params.bloomRadius, this.params.bloomThreshold,
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    this._t = 0;
  }

  setParam(name, value) {
    this.params[name] = value;
    if (name === 'bloomStrength') this.bloom.strength = value;
    if (name === 'bloomRadius') this.bloom.radius = value;
    if (name === 'bloomThreshold') this.bloom.threshold = value;
    if (name === 'exposure') this.engine.renderer.toneMappingExposure = value;
  }

  resize(w, h) {
    if (!this.composer) return;
    const dpr = this.engine.renderer.getPixelRatio();
    this.composer.setSize(w, h);
    this.composer.setPixelRatio?.(dpr);
    this.bloom.setSize(w * dpr, h * dpr);
    const u = this.grade.uniforms;
    u.uResolution.value.set(w * dpr, h * dpr);
  }

  render(dt) {
    this._t += dt;
    const u = this.grade.uniforms;
    u.uTime.value = this._t;
    u.uVignette.value = this.params.vignette;
    u.uGrain.value = this.params.grain;
    u.uChromatic.value = this.params.chromatic;
    u.uSaturation.value = this.params.saturation;
    u.uContrast.value = this.params.contrast;
    u.uSharpen.value = this.params.sharpen;
    this.composer.render(dt);
  }

  dispose() { this.composer.dispose(); }
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

/** Film grade: chromatic aberration, sharpen, tone shaping, grain, vignette. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1600, 900) },
    uTime: { value: 0 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.045 },
    uChromatic: { value: 0.0016 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.04 },
    uSharpen: { value: 0.35 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime, uVignette, uGrain, uChromatic, uSaturation, uContrast, uSharpen;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c,c);

      // Lateral chromatic aberration grows toward the frame edge, like glass.
      float ca = uChromatic * (0.25 + r2 * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ca).b;

      // Unsharp mask for a crisp, "rendered on console" microcontrast.
      vec2 px = 1.0 / uResolution;
      vec3 blur = (
        texture2D(tDiffuse, uv + vec2( px.x, 0.0)).rgb +
        texture2D(tDiffuse, uv + vec2(-px.x, 0.0)).rgb +
        texture2D(tDiffuse, uv + vec2(0.0,  px.y)).rgb +
        texture2D(tDiffuse, uv + vec2(0.0, -px.y)).rgb) * 0.25;
      col += (col - blur) * uSharpen;

      // Saturation + contrast around mid grey.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;

      // Vignette.
      col *= 1.0 - uVignette * smoothstep(0.15, 0.85, r2 * 2.0);

      // Animated film grain, scaled down in the highlights so it lives in the
      // shadows where real sensor noise lives.
      float g = hash(uv * uResolution + fract(uTime) * 137.0) - 0.5;
      col += g * uGrain * (1.0 - luma * 0.75);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

export { GradeShader };
