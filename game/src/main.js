import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { Input } from './core/Input.js';
import { TextureLibrary } from './render/TextureGen.js';
import { Sky } from './render/Sky.js';
import { Lighting } from './render/Lighting.js';
import { RenderPipeline } from './render/PostFX.js';
import { Level } from './world/Level.js';
import { PhysicsWorld, SURFACE_INFO } from './gameplay/Physics.js';
import { Player } from './gameplay/Player.js';
import { WeaponSystem } from './gameplay/Weapons.js';
import { Ballistics } from './gameplay/Ballistics.js';
import { EnemyManager } from './gameplay/Enemies.js';
import { ParticleSystem } from './fx/Particles.js';
import { DecalManager } from './fx/Decals.js';
import { AudioEngine } from './fx/Audio.js';
import { ShellSystem } from './fx/Shells.js';
import { HUD } from './ui/HUD.js';

const params = new URLSearchParams(location.search);
const boot = {
  quality: params.get('q') || 'high',
  // The screenshot harness drives the game through these: it cannot acquire a
  // pointer lock, so it poses the camera and steps the sim deterministically.
  capture: params.has('capture'),
  pose: params.get('pose') || null,
  seed: Number(params.get('seed') || 20260727),
  timeOfDay: params.has('tod') ? Number(params.get('tod')) : 8.4,
  noEnemies: params.has('noenemies'),
};

const container = document.getElementById('app');
const engine = new Engine(container, { quality: boot.quality });
engine.boot = boot;

const loadingEl = document.getElementById('loading');
const setProgress = (pct, label) => {
  if (!loadingEl) return;
  const fill = loadingEl.querySelector('.bar-fill');
  const stage = loadingEl.querySelector('.stage');
  if (fill) fill.style.width = `${Math.round(pct * 100)}%`;
  if (stage) stage.textContent = label;
};

/** Named camera setups used by the automated screenshot comparison harness. */
function applyPose(name) {
  const poses = engine.game?.level?.cameraPoses || {};
  const p = poses[name] || poses.hero;
  if (!p) return;
  engine.game.player.teleport(p.position, p.yaw, p.pitch);
  if (p.fov) { engine.camera.fov = p.fov; engine.camera.updateProjectionMatrix(); }
  if (p.timeOfDay !== undefined) engine.game.sky.setTimeOfDay(p.timeOfDay);
  engine.game.weapons.setViewmodelVisible(!p.hideViewmodel);
}

async function main() {
  const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

  setProgress(0.05, 'SYNTHESISING MATERIALS');
  const textures = new TextureLibrary(engine.renderer, boot.seed);
  await textures.build((p, label) => setProgress(0.05 + p * 0.4, label));
  await yieldFrame();

  setProgress(0.48, 'BUILDING ATMOSPHERE');
  const sky = engine.add(new Sky(engine, { timeOfDay: boot.timeOfDay }));
  await yieldFrame();

  setProgress(0.56, 'PLACING LIGHTS');
  const lighting = engine.add(new Lighting(engine, sky));
  await yieldFrame();

  setProgress(0.62, 'ASSEMBLING GEOMETRY');
  const physics = engine.add(new PhysicsWorld(engine));
  const level = engine.add(new Level(engine, { textures, physics, seed: boot.seed, lighting }));
  await level.build((p, label) => setProgress(0.62 + p * 0.22, label));
  await yieldFrame();

  setProgress(0.85, 'COMPILING SHADERS');
  const particles = engine.add(new ParticleSystem(engine, textures));
  const decals = engine.add(new DecalManager(engine, textures));
  const audio = engine.add(new AudioEngine(engine));
  const shells = engine.add(new ShellSystem(engine, { physics, audio }));
  const player = engine.add(new Player(engine, { physics, level }));
  const ballistics = engine.add(new Ballistics(engine, { physics, particles, decals, audio }));
  const weapons = engine.add(new WeaponSystem(engine, { player, ballistics, particles, audio, textures }));
  const enemies = engine.add(new EnemyManager(engine, {
    physics, level, player, ballistics, particles, audio, textures, enabled: !boot.noEnemies,
  }));
  const hud = engine.add(new HUD(engine, { player, weapons, enemies, level }));

  engine.renderPipeline = new RenderPipeline(engine, { quality: boot.quality, sky });
  engine.add(engine.renderPipeline);

  const input = new Input(engine.canvas);
  engine.input = input;
  player.attachInput(input);
  weapons.attachInput(input);
  engine.add({ lateUpdate: () => input.endFrame() });

  // Cross-system wiring that would otherwise create import cycles.
  ballistics.setTargetProviders([enemies, level]);
  weapons.onFire = (shot) => { hud.onFire(shot); enemies.onNoise(player.position, 60); };
  ballistics.onHit = (hit) => { hud.onHit(hit); if (hit.kill) hud.onKill(hit); };
  player.onDamage = (d) => hud.onDamage(d);

  // Footsteps are driven by distance travelled, not a timer, so they stay in
  // step at every movement speed. The surface under the foot picks the sample.
  const surfaceUnderfoot = () => {
    const hit = physics.raycast(
      new THREE.Vector3(player.position.x, player.position.y + 0.4, player.position.z),
      new THREE.Vector3(0, -1, 0), 1.4, {},
    );
    return hit ? (SURFACE_INFO[hit.surface]?.name || 'concrete') : 'concrete';
  };
  player.onStep = (e) => {
    if (e.type === 'foot') audio.playFootstep(surfaceUnderfoot(), { speed: e.speed, stance: e.stance });
  };
  player.onLand = (e) => audio.playLanding(e.impact, surfaceUnderfoot());
  player.onJump = () => audio.playFootstep(surfaceUnderfoot(), { speed: 5 });

  engine.game = {
    textures, sky, lighting, level, physics, player, weapons,
    ballistics, enemies, particles, decals, audio, hud, input, shells,
  };

  engine.renderer.compile(engine.scene, engine.camera);
  engine.renderer.compile(engine.viewScene, engine.viewCamera);
  setProgress(1, 'READY');

  if (boot.capture) {
    // Deterministic, input-free presentation mode for the visual critic.
    hud.setVisible(params.get('hud') !== '0');
    applyPose(boot.pose);
  } else {
    hud.showStartPrompt(() => input.requestLock());
    input.onLockChange = (locked) => hud.setPointerLocked(locked);
  }

  engine.start();

  // Signal readiness only after several frames have actually presented, so the
  // harness never captures a half-warmed shader cache or an unconverged TAA.
  let warm = 0;
  const warmup = {
    update: () => { if (++warm >= 16) { window.__GAME_READY__ = true; engine.remove(warmup); } },
  };
  engine.add(warmup);

  if (loadingEl) {
    loadingEl.classList.add('done');
    setTimeout(() => loadingEl.remove(), 900);
  }
}

window.__applyPose = applyPose;
window.__engine = engine;

main().catch((err) => {
  console.error(err);
  window.__GAME_ERROR__ = String((err && err.stack) || err);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:0;color:#f66;background:#100;padding:24px;font:12px monospace;z-index:999;white-space:pre-wrap;overflow:auto';
  el.textContent = String((err && err.stack) || err);
  document.body.appendChild(el);
});

export { engine, THREE };
