import * as THREE from 'three';

/**
 * Fully procedural audio — no sample files. Gunshots are synthesised from a
 * noise burst shaped by a multi-band filter stack plus a body resonance, then
 * fed through a convolution reverb whose impulse response is generated at
 * runtime for the level's acoustic character.
 *
 * CONTRACT:
 *   audio.playGunshot(weaponId)
 *   audio.playImpact(surfaceName, position)
 *   audio.playAt(name, position)
 *   audio.play(name)
 *   audio.resume()   — must be called from a user gesture
 */
export class AudioEngine {
  constructor(engine) {
    this.engine = engine;
    this.ready = false;
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this._pending = [];

    // Autoplay policy: the context can only start inside a user gesture.
    const kick = () => this.resume();
    window.addEventListener('pointerdown', kick, { once: true });
    window.addEventListener('keydown', kick, { once: true });
  }

  resume() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.55;

    // Gentle bus compression so a firefight never clips.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 7;
    comp.attack.value = 0.003;
    comp.release.value = 0.19;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.9, 2.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.30;

    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.master.connect(this.reverbGain);
    this.reverbGain.connect(this.reverb);
    this.reverb.connect(comp);

    this.listener = ctx.listener;
    this.ready = true;
    for (const fn of this._pending) fn();
    this._pending.length = 0;
  }

  /** Exponentially decaying noise burst — a serviceable room impulse. */
  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Early reflections layered on the diffuse tail.
        const early = (i < rate * 0.09 && Math.random() < 0.004) ? (Math.random() * 2 - 1) * 0.8 : 0;
        d[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t, decay)) * 0.7 + early;
      }
    }
    return buf;
  }

  _noiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Positional gain/pan derived from the listener transform. */
  _spatial(position, refDistance = 6, maxDistance = 140) {
    const ctx = this.ctx;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = 1.1;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    return panner;
  }

  playGunshot(weaponId = 'rifle') {
    if (!this.ready) return this._pending.push(() => this.playGunshot(weaponId));
    const ctx = this.ctx, t = ctx.currentTime;
    const smg = weaponId === 'smg';

    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.master);

    // 1. Crack — bright, very short noise transient through a high shelf.
    const crack = ctx.createBufferSource();
    crack.buffer = this._noiseBuffer(0.12);
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = 'highpass';
    crackFilter.frequency.value = smg ? 1800 : 1200;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(smg ? 0.55 : 0.75, t);
    crackGain.gain.exponentialRampToValueAtTime(0.0008, t + 0.055);
    crack.connect(crackFilter); crackFilter.connect(crackGain); crackGain.connect(out);
    crack.start(t); crack.stop(t + 0.12);

    // 2. Body — band-passed noise giving the shot its weight and calibre.
    const body = ctx.createBufferSource();
    body.buffer = this._noiseBuffer(0.3);
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'bandpass';
    bodyFilter.frequency.setValueAtTime(smg ? 620 : 420, t);
    bodyFilter.frequency.exponentialRampToValueAtTime(smg ? 180 : 120, t + 0.16);
    bodyFilter.Q.value = 1.1;
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(smg ? 0.5 : 0.85, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
    body.connect(bodyFilter); bodyFilter.connect(bodyGain); bodyGain.connect(out);
    body.start(t); body.stop(t + 0.3);

    // 3. Sub thump — the chest punch.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(smg ? 120 : 92, t);
    sub.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(smg ? 0.35 : 0.6, t);
    subGain.gain.exponentialRampToValueAtTime(0.0006, t + 0.16);
    sub.connect(subGain); subGain.connect(out);
    sub.start(t); sub.stop(t + 0.2);

    // 4. Mechanical action — a tiny metallic click riding on top.
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.setValueAtTime(2400 + Math.random() * 600, t + 0.012);
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.0001, t);
    clickGain.gain.setValueAtTime(0.05, t + 0.012);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    click.connect(clickGain); clickGain.connect(out);
    click.start(t); click.stop(t + 0.06);
  }

  playImpact(surfaceName, position) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const panner = this._spatial(position, 4, 90);
    panner.connect(this.master);

    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.16);
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();

    const profile = {
      metal: { type: 'bandpass', freq: 3200, q: 5, gain: 0.30, decay: 0.14 },
      concrete: { type: 'bandpass', freq: 1300, q: 1.4, gain: 0.24, decay: 0.09 },
      wood: { type: 'bandpass', freq: 800, q: 1.8, gain: 0.22, decay: 0.10 },
      dirt: { type: 'lowpass', freq: 700, q: 0.8, gain: 0.20, decay: 0.08 },
      sand: { type: 'lowpass', freq: 900, q: 0.7, gain: 0.18, decay: 0.07 },
      glass: { type: 'highpass', freq: 3800, q: 2.5, gain: 0.26, decay: 0.18 },
      flesh: { type: 'lowpass', freq: 420, q: 1.0, gain: 0.28, decay: 0.07 },
    }[surfaceName] || { type: 'bandpass', freq: 1200, q: 1.4, gain: 0.22, decay: 0.09 };

    f.type = profile.type;
    f.frequency.value = profile.freq * (0.85 + Math.random() * 0.3);
    f.Q.value = profile.q;
    g.gain.setValueAtTime(profile.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + profile.decay);
    src.connect(f); f.connect(g); g.connect(panner);
    src.start(t); src.stop(t + 0.2);
  }

  playAt(name, position) {
    if (!this.ready) return;
    if (name === 'flesh_impact') return this.playImpact('flesh', position);
    if (name === 'shell') {
      // Brass on concrete: a short, bright, metallic ring with a fast decay.
      const ctx = this.ctx, t = ctx.currentTime;
      const panner = this._spatial(position, 2, 22);
      panner.connect(this.master);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(2600 + Math.random() * 1800, t);
      o.frequency.exponentialRampToValueAtTime(1500, t + 0.09);
      g.gain.setValueAtTime(0.05 + Math.random() * 0.03, t);
      g.gain.exponentialRampToValueAtTime(0.0003, t + 0.11);
      o.connect(g); g.connect(panner);
      o.start(t); o.stop(t + 0.14);
      return;
    }
    if (name === 'enemy_shot') {
      const ctx = this.ctx, t = ctx.currentTime;
      const panner = this._spatial(position, 8, 160);
      panner.connect(this.master);
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(0.25);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.0006, t + 0.2);
      src.connect(f); f.connect(g); g.connect(panner);
      src.start(t); src.stop(t + 0.25);
    }
  }

  /**
   * Footstep: a short filtered noise burst whose spectrum is chosen by the
   * surface underfoot, plus a quieter gear rattle so the player reads as someone
   * carrying kit rather than a floating camera.
   */
  playFootstep(surfaceName = 'concrete', { speed = 3, stance = 0, position = null } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const dest = position ? this._spatial(position, 3, 40) : this.master;
    if (position) dest.connect(this.master);

    // Crouched steps are quieter and duller; sprinting steps are louder and
    // have more high-frequency scuff.
    const effort = clamp01(speed / 6);
    const crouch = stance === 1 ? 0.45 : 1;

    const profile = {
      concrete: { freq: 1500, q: 0.9, type: 'bandpass', gain: 0.16, decay: 0.075 },
      plaster: { freq: 1300, q: 0.9, type: 'bandpass', gain: 0.14, decay: 0.075 },
      metal: { freq: 2600, q: 3.0, type: 'bandpass', gain: 0.15, decay: 0.13 },
      wood: { freq: 700, q: 1.6, type: 'bandpass', gain: 0.15, decay: 0.10 },
      dirt: { freq: 520, q: 0.7, type: 'lowpass', gain: 0.14, decay: 0.07 },
      sand: { freq: 2100, q: 0.5, type: 'highpass', gain: 0.11, decay: 0.09 },
      water: { freq: 900, q: 0.6, type: 'lowpass', gain: 0.18, decay: 0.14 },
    }[surfaceName] || { freq: 1400, q: 0.9, type: 'bandpass', gain: 0.15, decay: 0.08 };

    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(0.2);
    const f = ctx.createBiquadFilter();
    f.type = profile.type;
    f.frequency.value = profile.freq * (0.82 + Math.random() * 0.36);
    f.Q.value = profile.q;
    const g = ctx.createGain();
    const level = profile.gain * crouch * (0.55 + effort * 0.6);
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + profile.decay);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t); src.stop(t + 0.2);

    // Gear rattle: two short metallic ticks slightly after the heel strike.
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      const when = 0.012 + i * 0.021 + Math.random() * 0.012;
      o.type = 'triangle';
      o.frequency.setValueAtTime(2200 + Math.random() * 1600, t + when);
      og.gain.setValueAtTime(0.0001, t + when);
      og.gain.exponentialRampToValueAtTime(0.016 * crouch * effort, t + when + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0001, t + when + 0.035);
      o.connect(og); og.connect(dest);
      o.start(t + when); o.stop(t + when + 0.05);
    }
  }

  /** Landing thump — scales with fall impact, with a knee-flex gear rattle. */
  playLanding(impact = 0.4, surfaceName = 'concrete') {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const k = clamp01(impact);

    const sub = ctx.createOscillator();
    const sg = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, t);
    sub.frequency.exponentialRampToValueAtTime(46, t + 0.10);
    sg.gain.setValueAtTime(0.10 + k * 0.30, t);
    sg.gain.exponentialRampToValueAtTime(0.0005, t + 0.16 + k * 0.1);
    sub.connect(sg); sg.connect(this.master);
    sub.start(t); sub.stop(t + 0.3);

    this.playFootstep(surfaceName, { speed: 4 + k * 6 });
  }

  play(name) {
    if (!this.ready) return this._pending.push(() => this.play(name));
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(this.master);
    const click = (when, freq, gain, dur) => {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(freq, t + when);
      og.gain.setValueAtTime(0.0001, t + when);
      og.gain.exponentialRampToValueAtTime(gain, t + when + 0.004);
      og.gain.exponentialRampToValueAtTime(0.0001, t + when + dur);
      o.connect(og); og.connect(g);
      o.start(t + when); o.stop(t + when + dur + 0.02);
    };
    if (name === 'reload') {
      click(0.00, 900, 0.08, 0.05);
      click(0.42, 480, 0.10, 0.07);
      click(1.10, 1400, 0.07, 0.04);
      click(1.55, 700, 0.09, 0.06);
    } else if (name === 'dryfire') {
      click(0, 1800, 0.06, 0.03);
    } else if (name === 'swap') {
      click(0, 620, 0.06, 0.05);
      click(0.18, 1100, 0.05, 0.04);
    }
  }

  update() {
    if (!this.ready || !this.listener) return;
    const cam = this.engine.camera;
    const l = this.listener;
    if (l.positionX) {
      l.positionX.value = cam.position.x;
      l.positionY.value = cam.position.y;
      l.positionZ.value = cam.position.z;
      _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
      _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
      l.forwardX.value = _fwd.x; l.forwardY.value = _fwd.y; l.forwardZ.value = _fwd.z;
      l.upX.value = _up.x; l.upY.value = _up.y; l.upZ.value = _up.z;
    }
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
