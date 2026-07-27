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
      // Ease out rather than fading linearly, and taper the arc at both ends so
      // it reads as a directional wedge rather than a stray stroke floating in
      // the frame. Radius scales with the smaller screen axis so it sits at a
      // consistent distance from the crosshair at any aspect ratio.
      const k = 1 - d.t / 1.2;
      const a = k * k;
      const radius = Math.min(w, h) * 0.17;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rel);
      const grad = ctx.createLinearGradient(-radius * 0.4, 0, radius * 0.4, 0);
      grad.addColorStop(0, `rgba(228,52,38,0)`);
      grad.addColorStop(0.5, `rgba(228,52,38,${a * 0.92})`);
      grad.addColorStop(1, `rgba(228,52,38,0)`);
      ctx.strokeStyle = grad;
      ctx.lineCap = 'round';
      ctx.lineWidth = 5 - k * 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, radius, -Math.PI / 2 - 0.30, -Math.PI / 2 + 0.30);
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

    // --- compass + minimap --------------------------------------------------
    this._drawCompass(ctx, w);
    this._drawMinimap(ctx, w, h, pad);

    // --- objective / score --------------------------------------------------
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(232,228,220,0.5)';
    ctx.font = '500 11px ui-monospace,Menlo,monospace';
    ctx.fillText(`SCORE  ${this.score}`, pad, h - pad - 34);

    if (this.engine.input?.down('F3')) {
      const s = this.engine.stats;
      ctx.fillStyle = 'rgba(140,255,180,0.8)';
      ctx.fillText(`${s.fps.toFixed(0)} FPS  ${s.frameMs.toFixed(1)}ms  ${s.drawCalls} calls  ${(s.triangles / 1000).toFixed(0)}k tris`, pad, 100);
    }
  }

  /**
   * Heading strip across the top of the frame. Cardinal letters and degree ticks
   * scroll against a fixed centre marker, which is how every modern military
   * shooter communicates facing without a full 3D compass.
   */
  _drawCompass(ctx, w) {
    const cx = w / 2;
    const halfWidth = Math.min(300, w * 0.22);
    const degPerPx = 90 / (halfWidth * 2);   // 90 degrees visible across the strip
    // Player yaw of 0 looks down -Z, which is north.
    const heading = ((-this.player.yaw * 180 / Math.PI) % 360 + 360) % 360;

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - halfWidth, 0, halfWidth * 2, 54);
    ctx.clip();

    // Fade the strip out at both ends so it does not terminate on a hard edge.
    const grad = ctx.createLinearGradient(cx - halfWidth, 0, cx + halfWidth, 0);
    grad.addColorStop(0, 'rgba(232,228,220,0)');
    grad.addColorStop(0.18, 'rgba(232,228,220,0.5)');
    grad.addColorStop(0.82, 'rgba(232,228,220,0.5)');
    grad.addColorStop(1, 'rgba(232,228,220,0)');

    const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = -50; d <= 50; d += 5) {
      const deg = Math.round(heading + d);
      const norm = ((deg % 360) + 360) % 360;
      const x = cx + d / degPerPx;
      if (x < cx - halfWidth || x > cx + halfWidth) continue;
      const label = CARDINALS[norm];
      const major = norm % 45 === 0;
      ctx.strokeStyle = grad;
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 26);
      ctx.lineTo(x, major ? 36 : 32);
      ctx.stroke();
      if (label) {
        ctx.fillStyle = grad;
        ctx.textAlign = 'center';
        ctx.font = `${label.length > 1 ? '500 11px' : '600 14px'} ui-monospace,Menlo,monospace`;
        ctx.fillText(label, x, 22);
      }
    }
    ctx.restore();

    // Fixed centre marker.
    ctx.fillStyle = 'rgba(255,236,190,0.95)';
    ctx.beginPath();
    ctx.moveTo(cx, 42);
    ctx.lineTo(cx - 5, 50);
    ctx.lineTo(cx + 5, 50);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Top-left tactical map. Rotates with the player so "up" is always forward,
   * plots nearby level geometry from the physics broadphase and marks hostiles
   * that are currently aware of the player.
   */
  _drawMinimap(ctx, w, h, pad) {
    const size = 148;
    const x0 = pad, y0 = pad + 8;
    const cx = x0 + size / 2, cy = y0 + size / 2;
    const range = 46;                 // metres from centre to edge
    const scale = (size / 2) / range;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(10,13,16,0.46)';
    ctx.fillRect(x0, y0, size, size);

    const px = this.player.position.x, pz = this.player.position.z;
    // Rotate so the player's facing points up the screen.
    const c = Math.cos(this.player.yaw), s = Math.sin(this.player.yaw);
    const project = (wx, wz) => {
      const dx = wx - px, dz = wz - pz;
      return [cx + (dx * c - dz * s) * scale, cy + (dx * s + dz * c) * scale];
    };

    // Level footprint, sampled from the collision BVH's top-level nodes so the
    // map reflects the actual world rather than a hand-authored copy of it.
    const phys = this.engine.game?.physics;
    if (phys?.nodes) {
      ctx.fillStyle = 'rgba(150,164,180,0.30)';
      const nodes = phys.nodes;
      const count = Math.min(phys.nodeCount || 0, 256);
      for (let i = 1; i < count; i++) {
        const o = i * 8;
        const minX = nodes[o], minZ = nodes[o + 2];
        const maxX = nodes[o + 3], maxZ = nodes[o + 5];
        const height = nodes[o + 4] - nodes[o + 1];
        if (height < 1.6) continue;                       // skip ground/low cover
        const [ax, ay] = project(minX, minZ);
        const [bx, by] = project(maxX, maxZ);
        ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      }
    }

    // Hostiles: solid when they have eyes on the player, hollow when merely alert.
    for (const e of this.enemies.enemies || []) {
      if (e.state === 4) continue;                        // STATE.DEAD
      const [ex, ey] = project(e.position.x, e.position.z);
      if (Math.hypot(ex - cx, ey - cy) > size / 2 - 4) continue;
      ctx.beginPath();
      ctx.arc(ex, ey, 3.4, 0, Math.PI * 2);
      if (e.hasLos) { ctx.fillStyle = 'rgba(232,86,72,0.95)'; ctx.fill(); }
      else { ctx.strokeStyle = 'rgba(232,150,72,0.8)'; ctx.lineWidth = 1.4; ctx.stroke(); }
    }
    ctx.restore();

    // Player arrow and the field-of-view wedge.
    ctx.fillStyle = 'rgba(190,236,200,0.16)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, size / 2, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(232,240,232,0.95)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx - 4.5, cy + 5);
    ctx.lineTo(cx + 4.5, cy + 5);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(232,228,220,0.22)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(232,228,220,0.5)';
    ctx.font = '500 11px ui-monospace,Menlo,monospace';
    ctx.fillText(`HOSTILES  ${this.enemies.alive}`, x0, y0 + size + 16);
    void h;
  }

  dispose() {
    this.overlay.remove();
    this.canvas.remove();
  }
}
