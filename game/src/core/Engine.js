import * as THREE from 'three';

/**
 * Owns the WebGL device, the swap-chain sized render targets, the frame clock
 * and the fixed-step accumulator. Everything else in the game is a system that
 * gets ticked by this loop.
 *
 * Contract for systems registered via `engine.add(system)`:
 *   system.fixedUpdate?(dt, engine)  — called at a fixed 120 Hz for physics
 *   system.update?(dt, engine)       — called once per rendered frame
 *   system.lateUpdate?(dt, engine)   — after camera has been resolved
 *   system.resize?(w, h, engine)
 *   system.dispose?()
 */
export class Engine {
  constructor(container, opts = {}) {
    this.container = container;
    this.quality = opts.quality || 'high';

    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    container.appendChild(canvas);
    this.canvas = canvas;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // resolved by the post stack (TAA/FXAA), not MSAA
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // required for headless screenshot capture
    });
    renderer.debug.checkShaderErrors = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2000);
    this.camera.rotation.order = 'YXZ';

    // Viewmodel lives in its own scene+camera so it never clips into geometry
    // and can carry a separate (narrower) FOV, exactly like a real FPS.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(55, 1, 0.002, 10);

    this.systems = [];
    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.frame = 0;
    this.accumulator = 0;
    this.fixedStep = 1 / 120;
    this.maxFrameTime = 0.1;
    this.timeScale = 1;
    this.paused = false;

    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);
    this.resize();

    // Frame statistics for the perf HUD and for automated capture.
    this.stats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, programs: 0 };
    this._fpsAccum = 0; this._fpsFrames = 0;
  }

  get pixelRatio() {
    const cap = this.quality === 'low' ? 1 : this.quality === 'medium' ? 1.25 : 1.5;
    return Math.min(window.devicePixelRatio || 1, cap);
  }

  add(system) {
    this.systems.push(system);
    if (system.resize) system.resize(this.width, this.height, this);
    return system;
  }

  remove(system) {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    for (const s of this.systems) if (s.resize) s.resize(w, h, this);
  }

  start() {
    this.clock.start();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.tick();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  tick() {
    const t0 = performance.now();
    let dt = Math.min(this.clock.getDelta(), this.maxFrameTime) * this.timeScale;
    if (this.paused) dt = 0;
    this.elapsed += dt;
    this.frame++;

    // Fixed-step simulation keeps movement and ballistics stable regardless of
    // display refresh rate; the render step then interpolates.
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < 8) {
      for (const s of this.systems) if (s.fixedUpdate) s.fixedUpdate(this.fixedStep, this);
      this.accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === 8) this.accumulator = 0; // bail out of a death spiral

    for (const s of this.systems) if (s.update) s.update(dt, this);
    for (const s of this.systems) if (s.lateUpdate) s.lateUpdate(dt, this);

    if (this.renderPipeline) this.renderPipeline.render(dt);
    else this.renderer.render(this.scene, this.camera);

    const info = this.renderer.info;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs ? info.programs.length : 0;
    info.reset();

    const ms = performance.now() - t0;
    this.stats.frameMs = ms;
    this._fpsAccum += dt; this._fpsFrames++;
    if (this._fpsAccum >= 0.25) {
      this.stats.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0; this._fpsFrames = 0;
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const s of this.systems) if (s.dispose) s.dispose();
    this.renderer.dispose();
  }
}
