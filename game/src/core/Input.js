/**
 * Pointer-lock mouse + keyboard + gamepad input with a raw accumulator so look
 * deltas are never lost between frames. Also exposes a scripted mode used by the
 * automated screenshot harness (no pointer lock available in headless).
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();   // edge-triggered, cleared at end of frame
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = new Set();
    this.buttonsPressed = new Set();
    this.locked = false;
    this.sensitivity = 0.0022;
    this.adsSensitivityScale = 0.65;
    this.invertY = false;
    this.gamepadIndex = null;
    this.enabled = true;

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      const c = e.code;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
      // Stop the browser eating gameplay keys.
      if (['Space', 'Tab', 'F1', 'F5', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    };
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (!this.locked) return;
      if (!this.buttons.has(e.button)) this.buttonsPressed.add(e.button);
      this.buttons.add(e.button);
      e.preventDefault();
    };
    this._onMouseUp = (e) => { this.buttons.delete(e.button); };
    this._onWheel = (e) => { if (this.locked) { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); } };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.keys.clear(); this.buttons.clear(); }
      this.onLockChange?.(this.locked);
    };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this._onLockChange);
    canvas.addEventListener('contextmenu', this._onContext);
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  requestLock() {
    if (!this.locked) this.canvas.requestPointerLock?.();
  }

  exitLock() {
    if (this.locked) document.exitPointerLock?.();
  }

  down(code) { return this.keys.has(code); }
  justPressed(code) { return this.pressed.has(code); }
  justReleased(code) { return this.released.has(code); }
  mouseDown(b) { return this.buttons.has(b); }
  mouseJustPressed(b) { return this.buttonsPressed.has(b); }

  /** Movement intent in local space: x = strafe, y = forward. Normalised. */
  moveAxis() {
    let x = 0, y = 0;
    if (this.down('KeyW') || this.down('ArrowUp')) y += 1;
    if (this.down('KeyS') || this.down('ArrowDown')) y -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    const gp = this._gamepad();
    if (gp) {
      const lx = deadzone(gp.axes[0]), ly = deadzone(gp.axes[1]);
      if (lx || ly) { x += lx; y -= ly; }
    }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  /** Consumes accumulated look delta in radians. */
  consumeLook(adsFactor = 0) {
    const scale = this.sensitivity * (1 - adsFactor * (1 - this.adsSensitivityScale));
    let yaw = -this.mouse.dx * scale;
    let pitch = -this.mouse.dy * scale * (this.invertY ? -1 : 1);
    this.mouse.dx = 0; this.mouse.dy = 0;
    const gp = this._gamepad();
    if (gp) {
      const rx = expo(deadzone(gp.axes[2])), ry = expo(deadzone(gp.axes[3]));
      const padScale = 2.6 * scale * 60 * (1 / 60);
      yaw -= rx * padScale * 60 * 0.016;
      pitch -= ry * padScale * 60 * 0.016 * (this.invertY ? -1 : 1);
    }
    return { yaw, pitch };
  }

  triggerHeld(which = 'right') {
    const gp = this._gamepad();
    if (!gp) return 0;
    const b = gp.buttons[which === 'right' ? 7 : 6];
    return b ? b.value : 0;
  }

  padButton(i) {
    const gp = this._gamepad();
    return gp && gp.buttons[i] ? gp.buttons[i].pressed : false;
  }

  _gamepad() {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    return navigator.getGamepads()[this.gamepadIndex] || null;
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed.clear();
    this.mouse.wheel = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.canvas.removeEventListener('contextmenu', this._onContext);
  }
}

const deadzone = (v, dz = 0.16) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));
const expo = (v, e = 2.2) => Math.sign(v) * Math.pow(Math.abs(v), e);
