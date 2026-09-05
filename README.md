# Fall of Duty

A browser-native 1v1 first-person shooter. You spawn in Ship Box, a rain-soaked container yard, against one computer-controlled soldier whose skill you dial from Recruit to Terminator. First to ten kills wins. Built on Babylon.js and TypeScript with no game engine and no external art beyond one rigged soldier model: every surface in the yard, every weapon, and every poster is painted procedurally at load.

**Play it:** https://aj7-iii.github.io/Fall-of-Duty/

## Features

- A single opponent with a full behaviour tree: perception with a detection meter, hearing, search and hunt, cover-aware attack positions, reload discipline, weapon selection, and human-limited aim that tightens with difficulty
- Ten difficulty levels. Nine and ten turn the opponent into a liquid-metal Terminator with red running lights
- Three weapons with procedural mechanical animation: the MP44 (mag swap, charging handle), the M40A3 bolt rifle (bolt cycle, single-round feed, scope), and the USP .45 (blowback slide, lock-back, mag swap)
- First-person arms cut from the same rigged soldier as the third-person body, posed by inverse kinematics against each weapon's grip points, so the hands match the body you see on the death cam
- Killstreaks: UAV radar at three, an airstrike laptop at five, an Apache gunship at seven
- A staged death: time slows, the body collapses in one of three ways, and a camera that never clips into a wall pulls back to watch
- Native-resolution rendering with MSAA, ambient occlusion and a sharpen pass, three quality tiers, and an automatic step-down when the frame rate can't hold
- Custom callsign, a trash-talking rival with voice lines (mutable in the settings), kill feed, streak callouts, an end-of-match report

## Controls

| Key | Action |
| --- | --- |
| `W A S D` | Move |
| `Shift` | Sprint |
| `Z` | Jump |
| `Ctrl` or `C` | Tap to crouch, hold to go prone |
| `Space` or right mouse | Aim down sights |
| Left mouse | Fire |
| `R` | Reload |
| `X` | Swap weapon |
| `4` | Use a banked killstreak |
| `P` or `Esc` | Pause |

## Run it locally

Requires Node 20 or newer.

```bash
npm install
npm start
```

That starts the Vite dev server on port 3001 and opens the game in your browser. `npm run build` produces a static site in `dist/`, and `npm run preview` serves that build.

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server without opening a browser |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over the source and config |
| `npm run format` | Prettier over the source, styles, HTML and config |
| `npm run check` | Typecheck, lint and format check together (what CI runs) |

Pushes to `main` run CI and deploy the build to GitHub Pages.

## Graphics settings

Pick a tier on the start screen or in the pause menu:

- **High**: native device pixels (capped at 2x), 4x MSAA, screen-space ambient occlusion, sharpening
- **Balanced**: 1.5x pixel cap, 2x MSAA plus FXAA, sharpening
- **Fast**: 1x pixels, FXAA only

If the measured frame rate stays under 45 for a few seconds the game drops one tier on its own and tells you.

## How the code is laid out

```
src/
  main.ts                 boot, HMR, dev tooling install
  engine/                 Game (match flow, frame loop), Input, Time, DevTools
  player/                 PlayerController (movement, health), CameraRig, DeathCam
  weapons/                weapon state machines, ADS keyframe animator, hitscan
  viewmodels/             procedural first-person weapon meshes, hand poses, ArmsRig
  rendering/              ViewModelRig (sway, recoil, reload choreography), PostProcessing,
                          Effects (flashes, tracers, decals, sound), materials/canvas kit
  bots/                   Bot behaviour tree, BotNav (nav graph, rays), SoldierBody (skinned
                          rig, hitboxes, IK), TerminatorSkin, BotConfig (difficulty as data)
  anim/                   DeathPerformance (collapse choreography), boneMath (IK, frames)
  world/                  ShipBoxMap, wrecks, targets, WorldMaterials (painted surfaces)
  killstreaks/            UAV, airstrike laptop, Apache
  ui/                     start screen, HUD, minimap, pause and end screens, rival voice
  data/                   weapon tuning and ADS keyframes as JSON
  assets/                 voice clips and the public-path helper
public/models/            the one external asset: a rigged soldier (glTF) and its repaint
```

Some design points worth knowing before changing things:

- **Materials are frozen after load.** Every light exists from the start (muzzle flash and explosion lights sit at zero intensity in a pool), so no shader ever recompiles mid-match.
- **The soldier is one shared glTF.** Bots, the player's corpse, and the first-person arms all instantiate it. The arms trim their own copy of the mesh to the arm bone chains and pose the skeleton procedurally; nothing is keyframed.
- **Bots move through the player's physics.** One kinematic solver serves both, so the opponent obeys exactly the movement rules you do.
- **Difficulty is data.** `BotConfig.ts` holds five named presets; the 1 to 10 slider interpolates between them.

## Dev tooling

In a dev build the console exposes `fod`, which can freeze the loop, step exact frames, save full-resolution captures to `.screenshots/`, switch weapons, tune the arm rig and hand poses live, orbit the first-person rig to inspect it, kill the player to replay the death cam, and report frame timings. See `src/engine/DevTools.ts` for the list. The screenshots come back through a dev-only endpoint in `vite.config.ts`.

## Credits

Built in a two-day sprint by AJ7-III with the initial Claude Fable 5 release, then overhauled. The soldier is Mixamo's Vanguard character with a repainted uniform; every other visual is generated in code. Voice lines were recorded for this project.
