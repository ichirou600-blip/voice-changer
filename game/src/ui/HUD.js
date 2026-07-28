/**
 * Combat HUD, drawn to a 2D canvas overlay so it scales crisply at any DPI and
 * costs nothing in the WebGL frame.
 *
 * Design rules, so this reads as shipped UI rather than as instrumentation:
 *
 *   - One typeface for numbers you read at a glance (the condensed display
 *     stack) and one for technical text you scan (tabular monospace). Nothing
 *     else. Mixed sizes of a single monospace font is what makes a HUD look
 *     like a debug overlay.
 *   - Three colours: bone for anything the player acts on, the same bone at low
 *     alpha for context, and a single amber accent reserved for state that is
 *     changing right now (reload, the compass lubber line). Red is not a colour
 *     in the palette — it is an alarm, used only for hostiles, damage and
 *     critical health.
 *   - Every glyph and every gauge carries a dark scrim. The frame behind this
 *     UI ranges from black alley to blown-out sky; unshadowed white text is
 *     legible in exactly one of those.
 *   - Hierarchy by size and weight, not by decoration. Ammunition and health
 *     are large; everything else is small and quiet.
 *
 * CONTRACT:
 *   hud.setVisible(bool) / hud.showStartPrompt(cb) / hud.setPointerLocked(bool)
 *   hud.onFire(shot) / hud.onHit(hit) / hud.onKill(hit) / hud.onDamage(d)
 */

/** Condensed grotesque for readouts; falls back through the usual suspects. */
const FONT_DISPLAY = `'Rajdhani','DIN Condensed','DIN Alternate','Oswald','Roboto Condensed','Arial Narrow','Helvetica Neue',system-ui,sans-serif`;
/** Tabular monospace for labels, counts and anything that must not reflow. */
const FONT_MONO = `ui-monospace,'DejaVu Sans Mono',Menlo,Consolas,monospace`;

/** The whole palette. Anything not in here does not belong on the HUD. */
const BONE = '232,228,218';
const AMBER = '255,196,106';
const ALARM = '226,74,58';
const OLIVE = '176,212,176';
const INK = '6,8,10';

const rgba = (c, a) => `rgba(${c},${a})`;

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
    this._t = 0;

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = [
      'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
      'z-index:30', `color:rgb(${BONE})`, `font:500 14px/1.5 ${FONT_MONO}`,
      'letter-spacing:.2em', 'text-transform:uppercase', 'cursor:pointer',
      'background:radial-gradient(ellipse at center, rgba(4,6,8,.34), rgba(2,3,4,.86))',
      'backdrop-filter:blur(3px)',
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
    // One margin drives the whole layout. Tying it to the short axis keeps the
    // corners equally weighted from 16:9 to ultrawide instead of letting the
    // bottom row drift into the middle of the frame.
    this.pad = Math.round(Math.min(Math.max(Math.min(w, h) * 0.052, 26), 54));
  }

  setVisible(v) { this.visible = v; this.canvas.style.display = v ? '' : 'none'; }

  showStartPrompt(onStart) {
    const rule = `height:1px;background:linear-gradient(90deg,rgba(${BONE},0),rgba(${BONE},.45),rgba(${BONE},0))`;
    const key = (k, a) => `<span style="color:rgba(${BONE},.92)">${k}</span>
      <span style="color:rgba(${BONE},.40);letter-spacing:.14em">${a}</span>`;
    this.overlay.innerHTML = `<div style="text-align:center;max-width:640px;padding:0 24px">
      <div style="${rule};margin-bottom:22px"></div>
      <div style="font:400 30px/1 ${FONT_DISPLAY};letter-spacing:.46em;padding-left:.46em">OPERATION BLACKOUT</div>
      <div style="${rule};margin-top:20px"></div>
      <div style="margin-top:20px;font-size:11px;letter-spacing:.34em;color:rgba(${AMBER},.86)">CLICK TO DEPLOY</div>
      <div style="margin-top:34px;display:grid;grid-template-columns:repeat(3,1fr);
                  gap:11px 20px;font-size:10px;letter-spacing:.1em;text-align:left">
        ${key('WASD', 'MOVE')} ${key('SHIFT', 'SPRINT')} ${key('CTRL', 'SLIDE')}
        ${key('SPACE', 'JUMP / MANTLE')} ${key('LMB', 'FIRE')} ${key('RMB', 'ADS')}
        ${key('R', 'RELOAD')} ${key('V', 'FIRE MODE')} ${key('Q / E', 'LEAN')}
        ${key('1 / 2', 'SWAP')}
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
    const points = hit.part === 'head' ? 150 : 100;
    this.score += points;
    this.killfeed.unshift({ text: hit.part === 'head' ? 'HEADSHOT' : 'ELIMINATED', points, t: 0 });
    if (this.killfeed.length > 4) this.killfeed.pop();
  }

  onDamage(d) {
    this.damageFlash = 1;
    if (d.direction) this.damageDirs.push({ dir: d.direction, t: 0 });
  }

  update(dt) {
    this._t += dt;
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

  /* ------------------------------------------------------------------ */
  /* Drawing primitives                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Text with a scrim. Everything on this HUD goes through here: the frame
   * behind it swings from a black alley to blown-out sky within one turn, and a
   * flat white glyph survives only one of those.
   */
  _text(s, x, y, { font, fill, align = 'left', track = 0, glow = 0.62 } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = align;
    ctx.letterSpacing = `${track}px`;
    if (glow > 0) {
      ctx.shadowColor = rgba(INK, glow);
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 1;
    }
    ctx.fillStyle = fill;
    ctx.fillText(s, x, y);
    ctx.restore();
  }

  /** Width of a string under the same font/tracking the drawer would use. */
  _measure(s, font, track = 0) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = font;
    ctx.letterSpacing = `${track}px`;
    const m = ctx.measureText(s).width;
    ctx.restore();
    return m;
  }

  /**
   * A gauge: recessed track, fill, segment breaks, hairline frame. The segment
   * breaks are the whole point — an unbroken rectangle of colour is a progress
   * bar, and a progress bar is what a debug overlay uses.
   */
  _gauge(x, y, w, h, t, colour, segments = 5) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = rgba(INK, 0.55);
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = rgba(INK, 0.62);
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.restore();

    ctx.fillStyle = rgba(BONE, 0.11);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, Math.max(0, w * t), h);

    ctx.fillStyle = rgba(INK, 0.72);
    for (let i = 1; i < segments; i++) ctx.fillRect(Math.round(x + (w * i) / segments), y, 1, h);

    ctx.strokeStyle = rgba(BONE, 0.3);
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  }

  /** Stroke a path twice: dark underneath for contrast, then the real colour. */
  _stroke2(path, colour, width, dark = 0.5) {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.strokeStyle = rgba(INK, dark);
    ctx.lineWidth = width + 1.8;
    path();
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    path();
  }

  /* ------------------------------------------------------------------ */

  _draw() {
    const ctx = this.ctx;
    const w = this.w, h = this.h, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;

    if (this.damageFlash > 0.001) this._drawDamageVignette(cx, cy, w, h);
    this._drawReticle(cx, cy);
    this._drawDamageArcs(cx, cy, w, h);
    this._drawCompass(w);
    this._drawMinimap();
    this._drawKillfeed(w);
    this._drawVitals(w, h);
    this._drawAmmo(w, h);

    if (this.engine.input?.down('F3')) {
      const s = this.engine.stats;
      this._text(
        `${s.fps.toFixed(0)} FPS  ${s.frameMs.toFixed(1)}ms  ${s.drawCalls} calls  ${(s.triangles / 1000).toFixed(0)}k tris`,
        this.pad, this.pad + 220, { font: `500 11px ${FONT_MONO}`, fill: 'rgba(140,255,180,0.85)' },
      );
    }
  }

  _drawDamageVignette(cx, cy, w, h) {
    const ctx = this.ctx;
    // Hug the frame edge and stay well short of opaque. A wide, strong radial
    // wash reads as a red filter over the whole image rather than as damage,
    // and it swamps everything the player needs to see while being shot at.
    const g = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.42, cx, cy, Math.max(w, h) * 0.72);
    g.addColorStop(0, 'rgba(146,12,10,0)');
    g.addColorStop(0.55, `rgba(146,12,10,${0.12 * this.damageFlash})`);
    g.addColorStop(1, `rgba(146,12,10,${0.34 * this.damageFlash})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /** Crosshair and hit marker. */
  _drawReticle(cx, cy) {
    const ctx = this.ctx;
    const wp = this.weapons;
    const ads = wp.ads;

    if (ads < 0.92) {
      const spread = 10 + wp.bloom * 900 + this.player.speed2D * 1.6;
      const len = 6.5;
      ctx.save();
      ctx.globalAlpha = 1 - ads;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        this._stroke2(() => {
          ctx.beginPath();
          ctx.moveTo(cx + dx * spread, cy + dy * spread);
          ctx.lineTo(cx + dx * (spread + len), cy + dy * (spread + len));
          ctx.stroke();
        }, rgba(BONE, 0.95), 1.4, 0.45);
      }
      // Centre pip, dark-cored so it stays visible against a bright wall.
      ctx.fillStyle = rgba(INK, 0.5);
      ctx.beginPath(); ctx.arc(cx, cy, 2.0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba(BONE, 0.95);
      ctx.beginPath(); ctx.arc(cx, cy, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    if (this.hitMarker > 0.001) {
      const a = this.hitMarker;
      const colour = this.hitMarkerKill ? rgba(ALARM, a) : rgba(BONE, a);
      const r0 = 6 + (1 - a) * 5, r1 = 12.5 + (1 - a) * 5;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        this._stroke2(() => {
          ctx.beginPath();
          ctx.moveTo(cx + sx * r0, cy + sy * r0);
          ctx.lineTo(cx + sx * r1, cy + sy * r1);
          ctx.stroke();
        }, colour, 1.9, 0.35 * a);
      }
    }
  }

  _drawDamageArcs(cx, cy, w, h) {
    const ctx = this.ctx;
    for (const d of this.damageDirs) {
      const yaw = Math.atan2(d.dir.x, d.dir.z);
      const rel = yaw - Math.atan2(-Math.sin(this.player.yaw), -Math.cos(this.player.yaw));
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
      grad.addColorStop(0, rgba(ALARM, 0));
      grad.addColorStop(0.5, rgba(ALARM, a * 0.9));
      grad.addColorStop(1, rgba(ALARM, 0));
      ctx.lineCap = 'butt';
      ctx.shadowColor = rgba(INK, 0.5 * a);
      ctx.shadowBlur = 6;
      ctx.strokeStyle = grad;
      ctx.lineWidth = 4.5 - k * 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, radius, -Math.PI / 2 - 0.30, -Math.PI / 2 + 0.30);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Heading strip. Cardinal letters ride above a hairline datum, ticks hang
   * below it in a three-level hierarchy (5 / 15 / 45 degrees), and an amber
   * lubber line marks the boresight. The numeric heading under it is the one
   * concession to precision — every other element here is read peripherally.
   */
  _drawCompass(w) {
    const ctx = this.ctx;
    const cx = w / 2;
    const halfWidth = Math.min(280, w * 0.21);
    const degPerPx = 90 / (halfWidth * 2);   // 90 degrees visible across the strip
    // Player yaw of 0 looks down -Z, which is north.
    const heading = ((-this.player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const top = Math.round(Math.min(this.pad * 0.62, 26));
    const datum = top + 20;

    const fade = ctx.createLinearGradient(cx - halfWidth, 0, cx + halfWidth, 0);
    fade.addColorStop(0, rgba(BONE, 0));
    fade.addColorStop(0.16, rgba(BONE, 0.78));
    fade.addColorStop(0.84, rgba(BONE, 0.78));
    fade.addColorStop(1, rgba(BONE, 0));

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - halfWidth, top - 18, halfWidth * 2, 52);
    ctx.clip();
    ctx.shadowColor = rgba(INK, 0.55);
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;

    // The datum itself, faded at both ends so the strip does not terminate on a
    // hard edge the way a clipped rectangle would. Kept well under the ticks:
    // the rule is there to carry them, and a rule that outweighs its own ticks
    // reads as a stray line drawn across the sky.
    ctx.strokeStyle = fade;
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - halfWidth, datum + 0.5);
    ctx.lineTo(cx + halfWidth, datum + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    ctx.textAlign = 'center';
    ctx.letterSpacing = '1px';
    // Ticks are anchored to absolute bearings, not to offsets from the current
    // heading. Stepping outward from the heading in fives only ever lands on a
    // multiple of 45 when the heading itself is a multiple of five, so the
    // cardinal letters appeared and vanished as the player turned and the whole
    // ladder jumped in five-degree hops instead of sliding. Walking the real
    // degree marks that fall inside the window fixes both.
    const first = Math.ceil((heading - 50) / 5) * 5;
    for (let deg = first; deg <= heading + 50; deg += 5) {
      const norm = ((deg % 360) + 360) % 360;
      const x = cx + (deg - heading) / degPerPx;
      if (x < cx - halfWidth || x > cx + halfWidth) continue;
      const cardinal = norm % 45 === 0;
      const mid = norm % 15 === 0;
      ctx.strokeStyle = fade;
      ctx.globalAlpha = cardinal ? 1.0 : mid ? 0.8 : 0.52;
      ctx.lineWidth = cardinal ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, datum + 1);
      ctx.lineTo(x, datum + (cardinal ? 9.5 : mid ? 6.5 : 4));
      ctx.stroke();
      const label = CARDINALS[norm];
      if (label) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = fade;
        ctx.font = label.length > 1
          ? `500 10px ${FONT_MONO}`
          : `500 15px ${FONT_DISPLAY}`;
        ctx.fillText(label, x, datum - 6);
      }
    }
    ctx.restore();

    // Lubber line: the only amber on the top edge of the frame, so the eye
    // finds the boresight without hunting.
    ctx.save();
    ctx.shadowColor = rgba(INK, 0.6);
    ctx.shadowBlur = 4;
    ctx.fillStyle = rgba(AMBER, 0.96);
    ctx.beginPath();
    ctx.moveTo(cx, datum + 12);
    ctx.lineTo(cx - 4.5, datum + 19);
    ctx.lineTo(cx + 4.5, datum + 19);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    this._text(`${String(Math.round(heading) % 360).padStart(3, '0')}`, cx, datum + 33, {
      font: `500 10px ${FONT_MONO}`, fill: rgba(BONE, 0.42), align: 'center', track: 1.6,
    });
  }

  /**
   * Top-left tactical map. Rotates with the player so "up" is always forward,
   * draws the actual street plan and marks hostiles that are currently aware of
   * the player.
   *
   * Two rules govern the size. It has to be small — the previous disc ran a
   * quarter of the frame height, which made it the loudest object in the image
   * and dragged the eye out of the centre on every glance; a shipped military
   * shooter puts this at ~120 px on a 1080p frame, which is what the clamp
   * below now lands on. And it has to contain a *map*: streets and building
   * mass, so a glance answers "where can I go" rather than "where are the
   * blips". The footprints come straight from the level plan, which is the
   * same rect list the ground splat and sand drift are driven from, so the
   * plot and the world cannot disagree.
   *
   * Reading is by figure/ground, not by decoration: the disc is street, the
   * blocks are built mass, and the only bright marks are the player and the
   * hostiles. An earlier version sampled the collision BVH's coarse upper
   * nodes instead; those bounds tile the level, so the streets came out as
   * holes punched in a slab and the plot read as a quadtree debug view.
   */
  _drawMinimap() {
    const ctx = this.ctx;
    // Half the old radius. Floor and ceiling keep it sane from 720p to 4K.
    const size = Math.round(Math.min(Math.max(Math.min(this.w, this.h) * 0.104, 74), 122));
    const r = size / 2;
    const x0 = this.pad, y0 = this.pad;
    const cx = x0 + r, cy = y0 + r;
    // Pulled in with the disc: the plot is half the width it was, so holding
    // the old 46 m would have halved the scale as well and left the blocks
    // too small to tell apart from the blips.
    const range = 34;                 // metres from centre to edge
    const scale = r / range;

    const px = this.player.position.x, pz = this.player.position.z;
    const c = Math.cos(this.player.yaw), s = Math.sin(this.player.yaw);
    const project = (wx, wz) => {
      const dx = wx - px, dz = wz - pz;
      return [cx + (dx * c - dz * s) * scale, cy + (dx * s + dz * c) * scale];
    };

    // Recessed bezel, drawn before the plot so the plot can sit inside it.
    ctx.save();
    ctx.shadowColor = rgba(INK, 0.55);
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = rgba(INK, 0.52);
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    // Ground plane of the plot. This is the *street* — everything the player
    // can walk on — so it is the darker of the two tones and the blocks read
    // as mass sitting on it.
    ctx.fillStyle = 'rgba(14,18,22,0.62)';
    ctx.fillRect(x0 - 2, y0 - 2, size + 4, size + 4);

    // Everything in this block is drawn in world-delta space: translating and
    // rotating means building footprints stay rectangles instead of being
    // rebuilt as axis-aligned boxes from two rotated corners, which is what
    // made the previous plot smear as the player turned.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.player.yaw);

    // Building footprints, straight off the level plan: `{x0,x1,z0,z1}` rects
    // in world metres. Filled solid rather than stacked at low alpha — these
    // do not overlap, so there is nothing to accumulate, and a solid block on
    // a dark street is the one figure/ground relationship that survives being
    // read in a tenth of a second out of the corner of the eye.
    const fps = this.level?._footprints;
    if (fps) {
      const reach = range + 40;       // generous: a block's near edge can be in view
      ctx.fillStyle = 'rgba(154,164,172,0.50)';
      ctx.strokeStyle = 'rgba(210,220,228,0.34)';
      ctx.lineWidth = 1;
      for (let i = 0; i < fps.length; i++) {
        const f = fps[i];
        // Cheap reject on the world-space AABB. The clip circle would do this
        // correctly anyway; this only keeps the path count down.
        if (f.x1 < px - reach || f.x0 > px + reach || f.z1 < pz - reach || f.z0 > pz + reach) continue;
        const rx = (f.x0 - px) * scale, rz = (f.z0 - pz) * scale;
        const rw = (f.x1 - f.x0) * scale, rh = (f.z1 - f.z0) * scale;
        ctx.fillRect(rx, rz, rw, rh);
        if (rw > 3 && rh > 3) ctx.strokeRect(rx + 0.5, rz + 0.5, rw - 1, rh - 1);
      }
    }
    ctx.restore();

    // One range ring, at half scale. Two rings plus a ten-metre grid was
    // instrument furniture competing with the thing it was framing.
    ctx.strokeStyle = rgba(BONE, 0.10);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // Field-of-view wedge, faded outward so it suggests reach rather than
    // drawing a hard cone across the plot.
    const wedge = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    wedge.addColorStop(0, rgba(BONE, 0.16));
    wedge.addColorStop(1, rgba(BONE, 0));
    ctx.fillStyle = wedge;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2 - 0.52, -Math.PI / 2 + 0.52);
    ctx.closePath();
    ctx.fill();

    // Hostiles: solid when they have eyes on the player, hollow when merely alert.
    for (const e of this.enemies.enemies || []) {
      if (e.state === 4) continue;                        // STATE.DEAD
      const [ex, ey] = project(e.position.x, e.position.z);
      if (Math.hypot(ex - cx, ey - cy) > r - 4) continue;
      ctx.beginPath();
      ctx.arc(ex, ey, 2.7, 0, Math.PI * 2);
      if (e.hasLos) {
        ctx.fillStyle = rgba(ALARM, 0.96); ctx.fill();
        ctx.strokeStyle = rgba(INK, 0.55); ctx.lineWidth = 1; ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(232,150,72,0.85)'; ctx.lineWidth = 1.3; ctx.stroke();
      }
    }

    // Inner shadow: the single cheapest cue that this is a recess and not a
    // sticker. Without it the disc floats exactly the way the props did.
    const inner = ctx.createRadialGradient(cx, cy, r * 0.62, cx, cy, r);
    inner.addColorStop(0, rgba(INK, 0));
    inner.addColorStop(1, rgba(INK, 0.5));
    ctx.fillStyle = inner;
    ctx.fillRect(x0 - 2, y0 - 2, size + 4, size + 4);
    ctx.restore();

    // Player marker, dark-cored so it survives a light building fill under it.
    ctx.save();
    ctx.shadowColor = rgba(INK, 0.7);
    ctx.shadowBlur = 3;
    ctx.fillStyle = rgba(BONE, 0.97);
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5.4);
    ctx.lineTo(cx - 3.8, cy + 4.2);
    ctx.lineTo(cx, cy + 2.2);
    ctx.lineTo(cx + 3.8, cy + 4.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Bezel: hairline over the recess, plus quarter ticks.
    ctx.strokeStyle = rgba(BONE, 0.34);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = rgba(BONE, 0.5);
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r + 1), cy + Math.sin(a) * (r + 1));
      ctx.lineTo(cx + Math.cos(a) * (r + 3.6), cy + Math.sin(a) * (r + 3.6));
      ctx.stroke();
    }

    // North pip rides the bezel, because the plot rotates and the player still
    // has to know which way the map is pointing.
    const nx = cx + s * (r + 2.4), ny = cy - c * (r + 2.4);
    ctx.save();
    ctx.translate(nx, ny);
    ctx.rotate(Math.atan2(-c, s) + Math.PI / 2);
    ctx.fillStyle = rgba(AMBER, 0.92);
    ctx.beginPath();
    ctx.moveTo(0, -3.1); ctx.lineTo(-2.6, 1.9); ctx.lineTo(2.6, 1.9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Caption. Count first and large, label second and quiet — the number is
    // what gets read.
    //
    // On its own scrim, not just a glyph shadow. This row sits directly under
    // the disc, which in the `closeup` framing puts it over sunlit plaster at
    // display code ~200; a 5 px text shadow does not carry bone-on-bone and
    // the count was reading as a smudge. A plate is what every shipped HUD
    // does with a caption that can land anywhere in the frame.
    const capY = y0 + size + 17;
    const n = String(this.enemies.alive ?? 0);
    const nFont = `500 14px ${FONT_DISPLAY}`;
    const lFont = `500 9px ${FONT_MONO}`;
    const nw = this._measure(n, nFont);
    const lw = this._measure('HOSTILES', lFont, 1.8);
    const plateW = nw + lw + 8 + 12, plateH = 15;
    ctx.save();
    ctx.fillStyle = rgba(INK, 0.62);
    ctx.beginPath();
    const px0 = x0 - 5, py0 = capY - 11.5, rr = 2.5;
    ctx.moveTo(px0 + rr, py0);
    ctx.arcTo(px0 + plateW, py0, px0 + plateW, py0 + plateH, rr);
    ctx.arcTo(px0 + plateW, py0 + plateH, px0, py0 + plateH, rr);
    ctx.arcTo(px0, py0 + plateH, px0, py0, rr);
    ctx.arcTo(px0, py0, px0 + plateW, py0, rr);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    this._text(n, x0, capY, { font: nFont, fill: rgba(BONE, 0.92), glow: 0.5 });
    this._text('HOSTILES', x0 + nw + 8, capY - 1, {
      font: lFont, fill: rgba(BONE, 0.5), track: 1.8, glow: 0.5,
    });
  }

  _drawKillfeed(w) {
    const pad = this.pad;
    let y = pad + 62;
    for (let i = 0; i < this.killfeed.length; i++) {
      const k = this.killfeed[i];
      const a = k.t > 3.5 ? Math.max(0, 1 - (k.t - 3.5)) : 1;
      const head = k.text === 'HEADSHOT';
      const ptsFont = `500 10px ${FONT_MONO}`;
      const pts = `+${k.points}`;
      this._text(pts, w - pad, y, { font: ptsFont, fill: rgba(BONE, a * 0.45), align: 'right', track: 0.6 });
      const pw = this._measure(pts, ptsFont, 0.6);
      this._text(k.text, w - pad - pw - 10, y, {
        font: `500 12px ${FONT_DISPLAY}`,
        fill: head ? rgba(AMBER, a * 0.95) : rgba(BONE, a * 0.9),
        align: 'right', track: 1.6,
      });
      // Leading rule instead of an icon: it groups the column without adding a
      // glyph the player has to learn.
      const lw = this._measure(k.text, `500 12px ${FONT_DISPLAY}`, 1.6);
      const ctx = this.ctx;
      ctx.fillStyle = head ? rgba(AMBER, a * 0.8) : rgba(BONE, a * 0.5);
      ctx.fillRect(w - pad - pw - 16 - lw - 9, y - 8, 2, 9);
      y += 21;
    }
  }

  /** Health, score. Bottom-left: secondary to ammunition, primary to all else. */
  _drawVitals(w, h) {
    const pad = this.pad;
    const hp = Math.max(0, Math.min(1, this.player.health / this.player.maxHealth));
    const bw = Math.round(Math.min(Math.max(w * 0.155, 150), 230)), bh = 5;
    const y = h - pad;

    const critical = hp <= 0.25;
    // Two states, not a gradient of them: healthy is olive, hurt is amber, and
    // the alarm colour is reserved for the band where the next burst kills you.
    const colour = critical ? rgba(ALARM, 0.96) : hp > 0.5 ? rgba(OLIVE, 0.92) : rgba(AMBER, 0.94);
    this._gauge(pad, y, bw, bh, hp, colour, 5);

    if (critical) {
      // A slow breath, not a strobe. It has to be noticeable in peripheral
      // vision without competing with the reticle.
      const pulse = 0.35 + 0.35 * Math.sin(this._t * 6.0);
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = rgba(ALARM, pulse * 0.8);
      ctx.lineWidth = 1.4;
      ctx.strokeRect(pad - 2.5, y - 2.5, bw + 5, bh + 5);
      ctx.restore();
    }

    const hpTxt = String(Math.max(0, Math.round(this.player.health)));
    const hpFont = `400 26px ${FONT_DISPLAY}`;
    this._text(hpTxt, pad, y - 12, { font: hpFont, fill: rgba(BONE, 0.94) });
    const hw = this._measure(hpTxt, hpFont);
    this._text('HP', pad + hw + 7, y - 13, {
      font: `500 9px ${FONT_MONO}`, fill: rgba(BONE, 0.4), track: 1.6,
    });

    const scoreFont = `500 13px ${FONT_DISPLAY}`;
    this._text('SCORE', pad, y - 40, { font: `500 9px ${FONT_MONO}`, fill: rgba(BONE, 0.4), track: 1.8 });
    this._text(String(this.score), pad + this._measure('SCORE', `500 9px ${FONT_MONO}`, 1.8) + 10, y - 39, {
      font: scoreFont, fill: rgba(BONE, 0.8),
    });
  }

  /** Ammunition. The largest thing on the HUD, because it is the thing that runs out. */
  _drawAmmo(w, h) {
    const wp = this.weapons;
    const def = wp.def;
    const pad = this.pad;
    const y = h - pad;

    const resFont = `500 15px ${FONT_MONO}`;
    const resTxt = `/ ${wp.reserve}`;
    this._text(resTxt, w - pad, y, { font: resFont, fill: rgba(BONE, 0.46), align: 'right', track: 0.5 });
    const rw = this._measure(resTxt, resFont, 0.5);

    // Magazine count. Turns to alarm inside the last quarter — the one piece of
    // state worth colouring, because it is the one that ends the fight.
    const cap = def?.magazine || wp.magazine || 30;
    const low = wp.ammo <= Math.max(1, Math.ceil(cap * 0.25));
    this._text(String(wp.ammo).padStart(2, '0'), w - pad - rw - 13, y + 2, {
      font: `300 54px ${FONT_DISPLAY}`,
      fill: low ? rgba(ALARM, 0.96) : rgba(BONE, 0.97),
      align: 'right', track: -0.5, glow: 0.7,
    });

    // Weapon identity row, above the count and separated from it by a rule.
    const nameFont = `500 13px ${FONT_DISPLAY}`;
    const modeFont = `500 10px ${FONT_MONO}`;
    const mode = wp.current.fireMode.toUpperCase();
    this._text(mode, w - pad, y - 62, { font: modeFont, fill: rgba(BONE, 0.5), align: 'right', track: 1.8 });
    const mw = this._measure(mode, modeFont, 1.8);
    this._text(def.name.toUpperCase(), w - pad - mw - 13, y - 62, {
      font: nameFont, fill: rgba(BONE, 0.88), align: 'right', track: 1.4,
    });

    const ctx = this.ctx;
    ctx.fillStyle = rgba(BONE, 0.28);
    ctx.fillRect(w - pad - mw - 8, y - 72, 1, 11);
    const ruleW = Math.round(Math.min(Math.max(w * 0.115, 110), 170));
    ctx.fillStyle = rgba(BONE, 0.2);
    ctx.fillRect(w - pad - ruleW, y - 54, ruleW, 1);

    if (wp.reloading > 0) {
      const t = 1 - wp.reloading / wp.reloadTotal;
      this._gauge(w - pad - ruleW, y + 12, ruleW, 3, t, rgba(AMBER, 0.95), 1);
    }
  }

  dispose() {
    this.overlay.remove();
    this.canvas.remove();
  }
}
