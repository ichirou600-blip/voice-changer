# Operation Blackout

A first-person shooter built in Three.js, targeting the visual and mechanical
bar of a modern military shooter. Everything in it is generated in code — there
are no downloaded textures, models, HDRIs or audio samples. The whole game is
one bundle and a procedural content pipeline that runs at load.

## Running it

```bash
cd game
npm install
npm run dev      # http://localhost:5173
```

`npm run build` produces a static bundle in `dist/`; `npm run preview` serves it.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Shift` | Sprint (hold from a standstill for tactical sprint) |
| `Ctrl` / `C` | Crouch — at sprint speed this becomes a slide |
| `Space` | Jump; against a ledge, mantle |
| `Q` / `E` | Lean left / right |
| Mouse | Look |
| LMB | Fire |
| RMB | Aim down sights |
| `R` | Reload |
| `V` | Cycle fire mode (auto / burst / single) |
| `1` `2` / wheel | Swap weapon |
| `F3` | Frame statistics |

A gamepad is supported if one is connected.

## Architecture

The engine is a system registry with a fixed-step accumulator. Systems opt into
whichever phases they need:

```
fixedUpdate(dt)   120 Hz — movement, ballistics, rigid bodies
update(dt)        per rendered frame
lateUpdate(dt)    after the camera is resolved
resize(w, h)
```

Rendering is split into two scenes. The world renders into the post-processing
chain's HDR target; the viewmodel lives in `engine.viewScene` with its own
camera and narrower FOV, and is composited after a depth clear so the weapon can
never intersect level geometry.

```
src/
  core/       Engine loop, input (pointer lock + gamepad), seeded noise toolkit
  render/     Sky and atmosphere, light rig, post-processing frame graph,
              procedural PBR material library
  world/      Level assembly, collision authoring, camera poses
  gameplay/   Physics (BVH + capsule solver), player controller, weapons,
              ballistics, enemy AI
  fx/         Particles, decals, shell casings, procedural audio
  ui/         HUD
  tools/      Headless capture and inspection harnesses
```

### Collision

The level is baked once into a flat triangle soup with a BVH over it. Everything
lives in typed arrays, so ray queries are pointer-chase free — which matters
because full-auto fire issues dozens of rays per frame. Each triangle carries a
surface id, so an impact resolves its decal, particle burst, audio profile and
penetration coefficient from the hit itself without a second lookup.

Characters are capsules resolved by iterative depenetration against that soup.

### Ballistics

Rounds are simulated projectiles, not hitscan: they carry muzzle velocity,
quadratic drag and gravity, so distant shots need lead and drop. Damage falls
off with distance travelled, and hits resolve against a per-enemy hitbox stack
(head / torso / limb) rather than a single capsule.

### Procedural content

Materials, sky, cloud density, decal atlases, particle sprites and all audio are
synthesised at startup. Audio in particular has no samples — gunshots are built
from a noise transient, a band-passed body, a sub thump and a mechanical click,
fed through a convolution reverb whose impulse response is generated at runtime.

## Visual review harness

`tools/capture.sh` builds the game, serves it on a private port, and captures a
PNG from each named camera pose defined by the level:

```bash
tools/capture.sh 5300 shots/review
```

The game exposes `?capture=1&pose=<name>` to pose the camera without a pointer
lock, and sets `window.__GAME_READY__` only after several frames have actually
presented — so a capture never catches a cold shader cache or an unconverged
temporal buffer. `tools/inspect.mjs` captures from an arbitrary pose, or framed
on a specific entity, for things the fixed poses do not cover.

This exists so visual quality can be reviewed the way it is judged: by looking
at frames.

## Notes on the rendering environment

Captures run headless against a software rasteriser. Two behaviours there are
worth knowing about, because both produce a silently black frame rather than an
error:

- `renderer.autoClear` must be off around the two-scene composite, or the
  viewmodel pass wipes the world it was meant to draw on top of.
- The driver advertises half-float render targets and then renders nothing into
  them. The pipeline probes this at startup by blitting through an 8-bit target
  and reading it back, and falls back when the probe fails.
