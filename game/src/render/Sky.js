import * as THREE from 'three';

/**
 * Atmosphere: physically-motivated sky dome, sun/moon direction, volumetric-ish
 * cloud layer, exponential height fog and the IBL environment map that lights
 * every PBR surface in the scene.
 *
 * CONTRACT:
 *   sky.sunDirection : THREE.Vector3 (normalised, points *toward* the sun)
 *   sky.sunColor     : THREE.Color   (linear, intensity-scaled by Lighting)
 *   sky.ambientColor : THREE.Color
 *   sky.setTimeOfDay(hours)
 *   sky.environment  : THREE.Texture (PMREM) assigned to scene.environment
 *   sky.fogParams    : { density, color, heightFalloff }
 */
export class Sky {
  constructor(engine, { timeOfDay = 8.4 } = {}) {
    this.engine = engine;
    this.timeOfDay = timeOfDay;
    this.sunDirection = new THREE.Vector3(0.4, 0.5, 0.6).normalize();
    this.sunColor = new THREE.Color(1.0, 0.93, 0.82);
    this.ambientColor = new THREE.Color(0.35, 0.42, 0.55);
    this.fogParams = { density: 0.011, color: new THREE.Color(0.55, 0.62, 0.72), heightFalloff: 0.06 };

    const geo = new THREE.SphereGeometry(900, 48, 32);
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uZenith: { value: new THREE.Color(0.10, 0.22, 0.45) },
        uHorizon: { value: new THREE.Color(0.62, 0.70, 0.80) },
        uSunTint: { value: new THREE.Color(1.0, 0.78, 0.50) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main(){
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 uSunDir, uZenith, uHorizon, uSunTint;
        void main(){
          vec3 d = normalize(vDir);
          float h = clamp(d.y*0.5+0.5, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(h, 0.65));
          float sun = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunTint * pow(sun, 900.0) * 22.0;
          col += uSunTint * pow(sun, 8.0) * 0.28;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.userData.noCollide = true;
    engine.scene.add(this.mesh);

    this.pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.pmrem.compileEquirectangularShader();
    this.setTimeOfDay(timeOfDay);
  }

  setTimeOfDay(hours) {
    this.timeOfDay = hours;
    const t = ((hours - 6) / 12) * Math.PI; // sunrise 6h → sunset 18h
    const elev = Math.sin(t);
    const azim = Math.cos(t);
    this.sunDirection.set(azim * 0.75, Math.max(0.02, elev), 0.42).normalize();
    this.material.uniforms.uSunDir.value.copy(this.sunDirection);

    const day = THREE.MathUtils.clamp(elev, 0, 1);
    this.sunColor.setRGB(1.0, 0.80 + day * 0.16, 0.55 + day * 0.30);
    this.ambientColor.setRGB(0.18 + day * 0.18, 0.24 + day * 0.20, 0.36 + day * 0.20);
    this.material.uniforms.uZenith.value.setRGB(0.05 + day * 0.07, 0.12 + day * 0.13, 0.30 + day * 0.20);
    this.material.uniforms.uHorizon.value.setRGB(0.42 + day * 0.24, 0.44 + day * 0.28, 0.48 + day * 0.34);
    this.fogParams.color.copy(this.material.uniforms.uHorizon.value);

    this.refreshEnvironment();
  }

  /** Render the dome into a PMREM cube so it drives IBL for every material. */
  refreshEnvironment() {
    const scene = new THREE.Scene();
    const m = this.mesh.clone();
    m.material = this.material;
    scene.add(m);
    const rt = this.pmrem.fromScene(scene, 0, 0.1, 1000);
    if (this.environment) this.environment.dispose?.();
    this.environment = rt.texture;
    this.engine.scene.environment = this.environment;
    this.engine.viewScene.environment = this.environment;
    scene.remove(m);
  }

  update(dt) {
    this.material.uniforms.uTime.value += dt;
    this.mesh.position.copy(this.engine.camera.position);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.pmrem.dispose();
  }
}
