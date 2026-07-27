/**
 * Combat HUD, drawn to a 2D canvas overlay so it scales crisply at any DPI and
 * costs nothing in the WebGL frame.
 *
 * CONTRACT:
 *   hud.setVisible(bool) / hud.showStartPrompt(cb) / hud.setPointerLocked(bool)
 *   hud.onFire(shot) / hud.onHit(hit) / hud.onKill(hit) / hud.onDamage(d)
 */
export class HUD {
  constructor(engine, { player, weapons, enemies, level }) {
    this.engine = engine;
    this.player = player;
    this.weapons = weapons;
    this.enemies = enemies;
    this.level = level;
    this.visible = true;

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:20';
    engine.container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.hitMarker = 0;
    this.hitMarkerKill = false;
    this.damageFlash = 0;
    this.damageDirs = [];
    this.killfeed = [];
    this.score = 0;
    this.kills = 0;

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = [
      'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
      'z-index:30', 'color:#e8e4dc', 'font:600 15px/1.5 ui-monospace,Menlo,monospace',
      'letter-spacing:.18em', 'text-transform:uppercase', 'cursor:pointer',
      'background:radial-gradient(ellipse at center, rgba(0,0,0,.25), rgba(0,0,0,.72))',
      'backdrop-filter:blur(2px)',
    ].join(';');
    this.overlay.style.display = 'none';
    engine.container.appendChild(this.overlay);

    this.resize(engine.width, engine.height);
  }

  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.dpr = dpr;
    this.w = w; this.h = h;
  }

  setVisible(v) { this.visible = v; this.canvas.style.display = v ? '' : 'none'; }

  showStartPrompt(onStart) {
    this.overlay.innerHTML = `<div style="text-align:center">
      <div style="font-size:26px;letter-spacing:.42em;margin-bottom:18px">OPERATION BLACKOUT</div>
      <div style="opacity:.72;font-size:12px">CLICK TO DEPLOY</div>
      <div style="opacity:.42;font-size:11px;margin-top:26px;line-height:2">
        WASD MOVE &nbsp;·&nbsp; SHIFT SPRINT &nbsp;·&nbsp; CTRL SLIDE &nbsp;·&nbsp; SPACE JUMP / MANTLE<br>
        LMB FIRE &nbsp;·&nbsp; RMB ADS &nbsp;·&nbsp; R RELOAD &nbsp;·&nbsp; V FIRE MODE &nbsp;·&nbsp; Q/E LEAN &nbsp;·&nbsp; 1/2 SWAP
      </div>
    </div>`;
    this.overlay.style.display = 'flex';
    this.overlay.style.pointerEvents = 'auto';
    this._onStart = () => onStart();
    this.overlay.addEventListener('click', this._onStart);
  }

  setPointerLocked(locked) {
    this.overlay.style.display = locked ? 'none' : 'flex';
    this.overlay.style.pointerEvents = locked ? 'none' : 'auto';
  }

  onFire() {}

  onHit(hit) {
    if (hit.owner !== 'player' || !hit.entity) return;
    this.hitMarker = 1;
    this.hitMarkerKill = !!hit.kill;
  }

  onKill(hit) {
    this.kills++;
    this.score += hit.part === 'head' ? 150 : 100;
    this.killfeed.unshift({ text: hit.part === 'head' ? 'HEADSHOT' : 'ELIMINATED', t: 0 });
    if (this.killfeed.length > 5) this.killfeed.pop();
  }

  onDamage(d) {
    this.damageFlash = 1;
    if (d.direction) this.damageDirs.push({ dir: d.direction, t: 0 });
  }

  update(dt) {
    this.hitMarker = Math.max(0, this.hitMarker - dt * 2.6);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    for (let i = this.damageDirs.length - 1; i >= 0; i--) {
      this.damageDirs[i].t += dt;
      if (this.damageDirs[i].t > 1.2) this.damageDirs.splice(i, 1);
    }
    for (let i = this.killfeed.length - 1; i >= 0; i--) {
      this.killfeed[i].t += dt;
      if (this.killfeed[i].t > 4.5) this.killfeed.splice(i, 1);
    }
    if (this.visible) this._draw();
  }

  _draw() {
    const ctx = this.ctx;
    const w = this.w, h = this.h, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    // --- damage vignette ----------------------------------------------------
    if (this.damageFlash > 0.001) {
      const g = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.24, cx, cy, Math.max(w, h) * 0.62);
      g.addColorStop(0, 'rgba(150,10,10,0)');
      g.addColorStop(1, `rgba(150,10,10,${0.55 * this.damageFlash})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // --- crosshair ----------------------------------------------------------
    const wp = this.weapons;
    const ads = wp.ads;
    if (ads < 0.92) {
      const spread = 10 + wp.bloom * 900 + this.player.speed2D * 1.6;
      const len = 7;
      ctx.globalAlpha = 1 - ads;
      ctx.strokeStyle = 'rgba(235,240,235,0.92)';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        ctx.beginPath();
        ctx.moveTo(cx + dx * spread, cy + dy * spread);
        ctx.lineTo(cx + dx * (spread + len), cy + dy * (spread + len));
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(235,240,235,0.85)';
      ctx.fillRect(cx - 1, cy - 1, 2, 2);
      ctx.globalAlpha = 1;
    }

    // --- hit marker ---------------------------------------------------------
    if (this.hitMarker > 0.001) {
      const a = this.hitMarker;
      ctx.strokeStyle = this.hitMarkerKill ? `rgba(255,60,50,${a})` : `rgba(255,255,255,${a})`;
      ctx.lineWidth = 2.2;
      const r0 = 6 + (1 - a) * 5, r1 = 13 + (1 - a) * 5;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(cx + sx * r0, cy + sy * r0);
        ctx.lineTo(cx + sx * r1, cy + sy * r1);
        ctx.stroke();
      }
    }

    // --- directional damage indicators --------------------------------------
    const cam = this.engine.camera;
    for (const d of this.damageDirs) {
      const yaw = Math.atan2(d.dir.x, d.dir.z);
      const rel = yaw - Math.atan2(
        -Math.sin(this.player.yaw), -Math.cos(this.player.yaw),
      );
      const a = 1 - d.t / 1.2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rel);
      ctx.strokeStyle = `rgba(220,40,30,${a * 0.85})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, 108, -Math.PI / 2 - 0.34, -Math.PI / 2 + 0.34);
      ctx.stroke();
      ctx.restore();
    }
    void cam;

    // --- ammo ---------------------------------------------------------------
    const def = wp.def;
    const pad = 46;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(232,228,220,0.96)';
    ctx.font = '300 46px ui-monospace,Menlo,monospace';
    ctx.fillText(String(wp.ammo).padStart(2, '0'), w - pad, h - pad);
    ctx.font = '400 15px ui-monospace,Menlo,monospace';
    ctx.fillStyle = 'rgba(232,228,220,0.55)';
    ctx.fillText(`/ ${wp.reserve}`, w - pad, h - pad + 20);
    ctx.font = '500 12px ui-monospace,Menlo,monospace';
    ctx.fillStyle = 'rgba(232,228,220,0.72)';
    ctx.fillText(`${def.name}  ·  ${wp.current.fireMode.toUpperCase()}`, w - pad, h - pad - 52);

    if (wp.reloading > 0) {
      const t = 1 - wp.reloading / wp.reloadTotal;
      const bw = 160, bh = 3;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(w - pad - bw, h - pad + 34, bw, bh);
      ctx.fillStyle = 'rgba(255,214,120,0.95)';
      ctx.fillRect(w - pad - bw, h - pad + 34, bw * t, bh);
    }

    // --- health -------------------------------------------------------------
    ctx.textAlign = 'left';
    const hp = this.player.health / this.player.maxHealth;
    const bw = 210, bh = 4;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(pad, h - pad, bw, bh);
    ctx.fillStyle = hp > 0.5 ? 'rgba(190,236,200,0.92)' : hp > 0.25 ? 'rgba(240,200,110,0.94)' : 'rgba(232,86,72,0.96)';
    ctx.fillRect(pad, h - pad, bw * hp, bh);
    ctx.font = '400 12px ui-monospace,Menlo,monospace';
    ctx.fillStyle = 'rgba(232,228,220,0.62)';
    ctx.fillText(`${Math.round(this.player.health)}`, pad, h - pad - 12);

    // --- killfeed -----------------------------------------------------------
    ctx.textAlign = 'right';
    for (let i = 0; i < this.killfeed.length; i++) {
      const k = this.killfeed[i];
      const a = k.t > 3.5 ? 1 - (k.t - 3.5) : 1;
      ctx.fillStyle = `rgba(255,236,190,${a * 0.9})`;
      ctx.font = '500 12px ui-monospace,Menlo,monospace';
      ctx.fillText(k.text, w - pad, 62 + i * 20);
    }

    // --- objective / score --------------------------------------------------
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(232,228,220,0.5)';
    ctx.font = '500 11px ui-monospace,Menlo,monospace';
    ctx.fillText(`HOSTILES  ${this.enemies.alive}`, pad, 60);
    ctx.fillText(`SCORE  ${this.score}`, pad, 78);

    if (this.engine.input?.down('F3')) {
      const s = this.engine.stats;
      ctx.fillStyle = 'rgba(140,255,180,0.8)';
      ctx.fillText(`${s.fps.toFixed(0)} FPS  ${s.frameMs.toFixed(1)}ms  ${s.drawCalls} calls  ${(s.triangles / 1000).toFixed(0)}k tris`, pad, 100);
    }
  }

  dispose() {
    this.overlay.remove();
    this.canvas.remove();
  }
}
