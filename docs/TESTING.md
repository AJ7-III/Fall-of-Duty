# Testing and release checks

Use the Node version selected by `.nvmrc`, install from the lockfile with
`npm ci`, and install the browser binaries once:

```bash
npx playwright install chromium firefox
npm run check
FOD_REAL_POINTER_LOCK=0 npm run test:browser
npm run build
```

`npm run check` runs strict TypeScript checking, Node regression tests, ESLint
and Prettier. Type checking includes the Vite and Playwright configuration.

The Node tests cover collision tunnelling and grounding, weapon reset/switching,
match subscriptions and audio state. Bot tests check silhouette visibility,
wall occlusion, stance height, shot geometry, weapon choice and route history.
Death regressions check timing, reset and rifle motion across frame sizes.

## Browser coverage

Playwright runs the same suite in Chromium and Firefox with one worker to avoid
competing GPU-heavy scenes. GitHub runs each browser on its own runner in
parallel. Each runner stops after a confirmed failure and uploads its traces,
screenshots and startup diagnostics as a seven-day artifact. Tests cover:

- Successful startup, slow/failed model downloads, stalled-download timeout,
  failed game-bundle imports and successful retry.
- Missing WebGL and mouse capture, with visible error messages.
- Mouse capture, start, pause, resume, match end and replay.
- Death camera, respawn, delayed health regeneration and killstreak rewards.
- Loaded soldier deaths keep the torso and legs extended and settle above
  the floor across all three fall variants.
- UAV, Apache deployment, airstrike targeting and returning camera control.
- All three weapons' aiming, firing and manual/empty-magazine reloads.
- Difficulty changes and Terminator skin switching, graphics switching,
  Fast's pixel/FPS limits, idle rendering and focus loss.
- Graffiti uses four atlas strips on one merged wall mesh, within its texture
  budget; disposing the game releases mouse capture.
- The production build hosted at `/Fall-of-Duty/`, including firing, reloading
  and replay, with no development console tools exposed.

Startup bounds asset and module downloads at 45 seconds, then allows up to
90 seconds for graphics preparation. The test budget covers both phases so
software rendering can finish without hiding the stalled-download check.

The suite launches a development server on port 3001 and a production preview
on port 4173. Both ports must be available in CI. Local runs can reuse an existing
server; stop it if it serves a different checkout. Screenshots and traces from
failed tests are saved in the ignored `test-results/` directory.

Local runs simulate pointer lock inside the page so hidden test browsers cannot
grab your desktop cursor. GitHub workflows explicitly enable native pointer
lock in their isolated runners; setting `CI` alone does not enable it.
`FOD_REAL_POINTER_LOCK=0` forces cursor-safe tests even when `CI` is set.
For an intentional native capture check on a dedicated test desktop, run
`FOD_REAL_POINTER_LOCK=1 npm run test:browser`; this can take control of the
desktop cursor. Browser input events exercise gameplay; Firefox firing events
are dispatched to the canvas because its automation protocol does not deliver
mouse events while native pointer lock is active.

Chromium runs with a software WebGL backend to keep CI independent of a physical
GPU. This validates rendering and behavior, not laptop battery life or hardware
performance. Long deterministic gameplay scenarios advance the update loop
without drawing each intermediate frame, then render the resulting scene.
Firefox runs with an Xvfb display and Mesa software rendering on GitHub; its
CI profile permits WebGL on that software driver. Local Firefox stays headless
with its default graphics preferences. Safari, touch controls and
real-device frame-rate measurements are outside the automated matrix.

## Deployment gate and bundle budget

Both GitHub workflows install browsers and run checks and browser tests before
building. The deploy job requires the validated build job to succeed. The
production test exercises the Pages base path, so missing prefixed asset URLs
fail before publication.

Every build checks all generated JavaScript chunks: at most 4,000,000 bytes in
total and no single chunk over 1,600,000 bytes before compression. This is a
regression budget, not a frame-rate guarantee. Runtime Babylon imports use
specific module paths; lint prevents adding the broad core barrel back.

Both build commands copy the project license, asset notices, Babylon package
licenses and upstream attribution notice into `dist/` for deployment.

Babylon core and loaders are pinned together at 9.29.0. This includes the
upstream RGBD texture cleanup fix needed when startup fails while a texture
shader is still compiling. The failed-model retry case checks for uncaught
errors during that cleanup and the next successful start.

To update the README screenshot intentionally:

```bash
FOD_REAL_POINTER_LOCK=0 FOD_CAPTURE_DOCS=1 npx playwright test production --project=chromium
```

This replaces `docs/images/gameplay.png` with a capture from the production game.
Review the image before committing it. Normal tests do not modify the screenshot.
