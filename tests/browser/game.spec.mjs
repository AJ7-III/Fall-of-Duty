import { test, expect, waitForStartup, waitForStartupError } from "./fixtures.mjs";

const ready = async (page) => {
  await waitForStartup(page);
  await page.waitForFunction(() => Boolean(window.__game && window.fod));
};
const start = async (page) => {
  await page.goto("/");
  await ready(page);
  await page.locator("#btn-start").click();
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(true);
  await page.waitForFunction(() => window.__game.input.getIsPointerLocked());
};

const runtimeErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("fallOfDuty.graphics", "performance"));
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([]);
});

test("boots with essential assets, working dev captures and no runtime errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await ready(page);
  expect(await page.evaluate(() => window.__game.botManager.bots.every((bot) => bot.rig.body.loaded))).toBe(true);
  expect(
    await page.evaluate(() => {
      const scene = window.__game.scene;
      const walls = scene.getMaterialByName("graffitiWallAtlasMat");
      const meshes = scene.meshes.filter((mesh) => mesh.material === walls);
      return {
        albedo: walls.albedoTexture.getSize(),
        normal: walls.bumpTexture.getSize(),
        scale: [walls.albedoTexture.uScale, walls.albedoTexture.vScale],
        meshes: meshes.length,
        wallStrips: [
          ...new Set(
            meshes[0]
              .getVerticesData("uv")
              .filter((_, i) => i % 2)
              .map((v) => Math.floor(v * 4))
          ),
        ].sort(),
      };
    })
  ).toEqual({
    albedo: { width: 2048, height: 1024 },
    normal: { width: 256, height: 256 },
    scale: [1, 1],
    meshes: 1,
    wallStrips: [0, 1, 2, 3],
  });
  await expect.poll(() => page.evaluate(() => window.__game.engine._activeRenderLoops.length)).toBe(0);
  let captured;
  await page.route("**/__dev/screenshot", (route) => {
    captured = route.request().postDataJSON().dataUrl;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ file: "browser-test.png" }) });
  });
  expect(await page.evaluate(() => window.fod.shot("browser-test"))).toBe("browser-test.png");
  expect(captured).toMatch(/^data:image\/png;base64,/);
  expect(Buffer.from(captured.split(",")[1], "base64").length).toBeGreaterThan(10000);
  expect(errors).toEqual([]);
});

test("vehicle side windows follow the pillars and all glazing still breaks correctly", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const result = await page.evaluate(async () => {
    const g = window.__game;
    g.engine.stopRenderLoop();
    const { Ray } = await import("/node_modules/@babylonjs/core/Culling/ray.js");
    const { Vector3 } = window.fod.lib;
    const scene = g.scene;
    const root = scene.getTransformNodeByName("carRoot");
    root.computeWorldMatrix(true);
    const assert = (value, message) => {
      if (!value) throw Error(message);
    };
    const sidePick = (pane, x, y, side) => {
      const origin = Vector3.TransformCoordinates(new Vector3(x, y, side * 1.2), root.getWorldMatrix());
      const direction = Vector3.TransformNormal(new Vector3(0, 0, -side), root.getWorldMatrix()).normalize();
      return scene.pickWithRay(new Ray(origin, direction, 1), (mesh) => mesh === pane);
    };
    for (const side of [-1, 1]) {
      const front = scene.getMeshByName(`car_glassF${side}`);
      const rear = scene.getMeshByName(`car_glassR${side}`);
      assert(sidePick(front, 0.44, 1.0, side)?.hit, "Front glass must reach the lower A-pillar");
      assert(!sidePick(front, 0.29, 1.33, side)?.hit, "Front glass must stop at the sloping A-pillar");
      assert(sidePick(rear, -1.5, 1.0, side)?.hit, "Rear glass must reach the lower C-pillar");
      assert(!sidePick(rear, -1.4, 1.34, side)?.hit, "Rear glass must stop at the sloping C-pillar");
    }
    // Inspect the unmerged truck as well: its entire steering rim must
    // clear the instrument binnacle, including the rim's thickness.
    const [{ Scene }, { WorldMaterials }, { TruckWreck }] = await Promise.all([
      import("/node_modules/@babylonjs/core/scene.js"),
      import("/src/world/materials/WorldMaterials.ts"),
      import("/src/world/TruckWreck.ts"),
    ]);
    const assetScene = new Scene(g.engine);
    try {
      new TruckWreck(assetScene, new WorldMaterials(assetScene), Vector3.Zero(), 0, () => {});
      const wheel = assetScene.getMeshByName("truck_steering_rim");
      const dash = assetScene.getMeshByName("truck_instruments_binnacle");
      wheel.computeWorldMatrix(true);
      dash.computeWorldMatrix(true);
      assert(
        wheel.getBoundingInfo().boundingBox.maximumWorld.x + 0.015 < dash.getBoundingInfo().boundingBox.minimumWorld.x,
        "Truck steering rim must clear the dash by at least 15 mm"
      );
    } finally {
      assetScene.dispose();
    }
    let cracks = 0;
    let breaks = 0;
    const effects = {
      playGlassCrackSound() {
        cracks++;
      },
      playGlassBreakSound() {
        breaks++;
      },
    };
    const panes = scene.meshes.filter((mesh) => mesh.metadata?.type === "carGlass");
    for (const pane of panes) {
      pane.computeWorldMatrix(true);
      const laminated = /windshield|rearGlass/.test(pane.name);
      const axis = pane.name.startsWith("truck_windshield") ? Vector3.Right() : laminated ? Vector3.Up() : Vector3.Forward();
      const normal = Vector3.TransformNormal(axis, pane.getWorldMatrix()).normalize();
      const center = pane.getAbsolutePosition();
      const ray = new Ray(center.add(normal.scale(0.3)), normal.scale(-1), 0.6);
      const pick = scene.pickWithRay(ray, (mesh) => mesh === pane);
      assert(pick?.hit, `${pane.name}: pane must remain pickable after the static merge`);
      for (let hit = 1; hit <= (laminated ? 3 : 1); hit++) {
        pane.metadata.instance.hitGlass(pane, pick, effects);
        assert(pane.isEnabled() === (laminated && hit < 3), `${pane.name}: wrong break timing on hit ${hit}`);
      }
      assert(!pane.isPickable, `${pane.name}: broken glass must not intercept bullets`);
      pane.metadata.instance.hitGlass(pane, pick, effects);
    }
    scene.render();
    return { panes: panes.length, cracks, breaks };
  });
  expect(result).toEqual({ panes: 9, cracks: 6, breaks: 9 });
});

test("vehicle detail stays merged and within budget in every graphics mode", async ({ page }, testInfo) => {
  await page.goto("/");
  await ready(page);
  const result = await page.evaluate(async () => {
    const g = window.__game;
    g.engine.stopRenderLoop();
    const assert = (value, message) => {
      if (!value) throw Error(message);
    };
    const materials = g.scene.materials.filter((mat) =>
      /^(vehicle|carBodyMat|carTrimDarkMat|carSteelMat|carLampMat|carTailLampMat|carInstrumentsMat|truckInstrumentsMat|truckCabPaintMat|truckCargoPaintMat)/.test(
        mat.name
      )
    );
    const meshes = g.scene.meshes.filter((mesh) => materials.includes(mesh.material) && mesh.getTotalVertices() > 0);
    const textures = () => new Set(materials.flatMap((mat) => mat.getActiveTextures()).filter((tex) => !tex.isCube));
    const originalTextures = textures();
    const textureBytes = [...originalTextures].reduce((bytes, tex) => {
      const { width, height } = tex.getSize();
      return bytes + (width * height * 4 * 4) / 3; // RGBA plus the mip chain.
    }, 0);
    const vertices = meshes.reduce((count, mesh) => count + mesh.getTotalVertices(), 0);
    assert(vertices < 50000, `Vehicle geometry exceeded 50,000 vertices: ${vertices}`);
    assert(textureBytes < 10 * 1024 ** 2, `Vehicle surface textures exceeded 10 MiB: ${textureBytes}`);
    assert(meshes.length <= 24, `Vehicle dressing exceeded 24 static meshes: ${meshes.length}`);
    assert(
      materials.every((mat) => meshes.filter((mesh) => mesh.material === mat).length === 1),
      "Vehicle parts must merge by material"
    );
    const qualities = [];
    for (const quality of ["high", "balanced", "performance"]) {
      g.postfx.setQuality(quality, false);
      g.engine.stopRenderLoop();
      for (let frame = 0; frame < 60; frame++) {
        g.engine.beginFrame();
        g.scene.render();
        g.engine.endFrame();
        if (meshes.every((mesh) => mesh.isReady(true))) break;
        await new Promise((resolve) => setTimeout(resolve, 35));
      }
      assert(g.postfx.currentQuality === quality, `Failed to select ${quality}`);
      assert(
        meshes.every((mesh) => mesh.isReady(true)),
        `Vehicle shaders failed in ${quality}`
      );
      const currentTextures = textures();
      assert(
        currentTextures.size === originalTextures.size && [...currentTextures].every((tex) => originalTextures.has(tex)),
        `Switching to ${quality} duplicated vehicle textures`
      );
      qualities.push(quality);
    }
    assert(g.postfx.frameRateLimit === 60, "Fast must retain its 60 FPS limit");
    return { meshes: meshes.length, vertices, textureMiB: textureBytes / 1024 ** 2, qualities };
  });
  expect(result.qualities).toEqual(["high", "balanced", "performance"]);
  await testInfo.attach("vehicle-rendering-budget", {
    body: Buffer.from(JSON.stringify(result, null, 2)),
    contentType: "application/json",
  });
});

test("slow soldier downloads keep Start disabled", async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/models/soldier.glb", async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/");
    await expect.poll(() => requests, { timeout: 45000 }).toBeGreaterThan(0);
    await expect(page.locator("#startup-status")).toBeVisible();
    await expect(page.locator("#btn-start")).toBeDisabled();
  } finally {
    release();
  }
  await ready(page);
});

test("loaded soldier deaths settle on the floor without folding in half", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const poses = await page.evaluate(() => {
    const g = window.__game;
    g.engine.stopRenderLoop();
    const actor = g.deathCam.rig;
    const death = g.deathCam.death;
    const floor = 1.2;
    const poses = [];
    for (const variant of ["back", "forward", "spin"]) {
      death.reset();
      actor.root.setEnabled(true);
      actor.root.position.set(0, floor, 0);
      actor.root.rotation.set(0, 0.7, 0);
      death.begin({}, variant);
      for (let i = 0; i < 150; i++) death.update(1 / 60);
      g.scene.render();
      g.scene.render();
      const joints = actor.body.joints;
      const position = (name) => {
        joints[name].computeWorldMatrix(true);
        return joints[name].getAbsolutePosition().clone();
      };
      const hip = position("Hips");
      const torso = position("Head").subtract(hip).normalize();
      const feet = [position("LeftFoot"), position("RightFoot")];
      const spread = feet.map((foot) => {
        const leg = foot.subtract(hip).normalize();
        return torso.x * leg.x + torso.y * leg.y + torso.z * leg.z;
      });
      const centers = Object.values(joints).map((joint) => {
        joint.computeWorldMatrix(true);
        return joint.getAbsolutePosition().asArray();
      });
      const supportY = Math.min(
        ...["Hips", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot"].map((name) => position(name).y)
      );
      poses.push({ variant, spread, centers, supportY, hipY: hip.y, feetY: feet.map((foot) => foot.y) });
    }
    death.reset();
    actor.root.setEnabled(false);
    return { floor, poses };
  });
  for (const pose of poses.poses) {
    expect(pose.centers.flat().every(Number.isFinite), pose.variant).toBe(true);
    for (const direction of pose.spread) expect(direction, pose.variant).toBeLessThan(-0.1);
    expect(pose.supportY, pose.variant).toBeGreaterThanOrEqual(poses.floor - 0.005);
    expect(Math.min(pose.hipY, ...pose.feetY), pose.variant).toBeLessThan(poses.floor + 0.4);
  }
});

test("failed soldier download offers a working retry", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/models/soldier.glb", (route) => route.fulfill({ status: 404, body: "Model unavailable" }));
  await page.goto("/");
  await waitForStartupError(page);
  await expect(page.locator("#btn-start")).toBeDisabled();
  await expect(page.locator("#btn-retry")).toBeVisible();
  await page.unroute("**/models/soldier.glb");
  await page.locator("#btn-retry").click();
  await ready(page);
  await page.locator("#btn-start").click();
  await expect.poll(() => page.evaluate(() => window.__game.matchState)).toBe("playing");
  expect(errors).toEqual([]);
});

test("failed game bundle reloads successfully on retry", async ({ page }) => {
  await page.route("**/src/engine/Game.ts*", (route) => route.abort("failed"));
  await page.goto("/");
  await waitForStartupError(page);
  await expect(page.locator("#btn-start")).toBeDisabled();
  await page.unroute("**/src/engine/Game.ts*");
  await page.locator("#btn-retry").click();
  await ready(page);
});

test("failed development-tools bundle reloads successfully on retry", async ({ page }) => {
  await page.route("**/src/engine/DevTools.ts*", (route) => route.abort("failed"));
  await page.goto("/");
  await waitForStartupError(page);
  await expect(page.locator("#btn-start")).toBeDisabled();
  await page.unroute("**/src/engine/DevTools.ts*");
  await page.locator("#btn-retry").click();
  await ready(page);
});

test("disposing an active game releases mouse capture", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__game.dispose());
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
});

test("unavailable WebGL shows a recoverable error", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    window.__blockWebGL = true;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (window.__blockWebGL && /webgl/i.test(type)) return null;
      return original.call(this, type, ...args);
    };
  });
  await page.goto("/");
  await waitForStartupError(page);
  await expect(page.locator("#btn-start")).toBeDisabled();
  await page.evaluate(() => {
    window.__blockWebGL = false;
  });
  await page.locator("#btn-retry").click();
  await ready(page);
});

test("missing mouse capture explains the desktop requirement", async ({ page }) => {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.requestPointerLock = undefined;
  });
  await page.goto("/");
  await expect(page.locator("#startup-message")).toContainText("Mouse capture is unavailable");
  await expect(page.locator("#btn-start")).toBeDisabled();
});

test("start, pointer lock, pause, resume, end and replay work", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await start(page);
  await page.keyboard.press("KeyP");
  await expect(page.locator("#menu-overlay")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__game.engine._activeRenderLoops.length)).toBe(0);
  const frames = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__game.scene.getFrameId())).toBe(frames);
  await page.locator("#btn-resume").click();
  await expect.poll(() => page.evaluate(() => window.__game.matchState)).toBe("playing");
  await page.keyboard.press("KeyP");
  await page.locator("#btn-end").click();
  await expect(page.locator("#end-overlay")).toBeVisible();
  await page.locator("#btn-again").click();
  await expect.poll(() => page.evaluate(() => window.__game.matchState)).toBe("playing");
  expect(
    await page.evaluate(() => ({
      kills: window.__game.botManager.playerKills,
      deaths: window.__game.player.deaths,
      muted: window.__game.effects.rotorMuted,
    }))
  ).toEqual({ kills: 0, deaths: 0, muted: false });
  expect(errors).toEqual([]);
});

test("respawn, health regeneration and all killstreaks complete", async ({ page }) => {
  await start(page);
  const result = await page.evaluate(() => {
    const g = window.__game;
    g.engine.stopRenderLoop();
    const bot = g.botManager.bots[0];
    const original = bot.update;
    bot.update = () => {};
    const assert = (value, message) => {
      if (!value) throw Error(message);
    };
    try {
      g.player.invulnUntil = 0;
      g.player.takeDamage(1000, bot.position);
      g.stepFrames(1, 1 / 60, false);
      assert(g.player.isDead && g.deathCam.running && g.time.scale === 0.5, "death camera");
      g.pauseMatch();
      g.engine.stopRenderLoop();
      const deathTime = g.deathCam.t;
      g.stepFrames(20, 1 / 60, false);
      assert(g.deathCam.t === deathTime, "paused death camera");
      g.resumeMatch();
      g.engine.stopRenderLoop();
      g.stepFrames(250, 1 / 60, false);
      assert(!g.player.isDead && !g.deathCam.running && g.time.scale === 1, "respawn");
      assert(g.player.health === 100 && g.weaponManager.getActiveWeapon().clipAmmo === 30, "fresh loadout");
      g.player.invulnUntil = 0;
      g.player.takeDamage(40, bot.position);
      g.player.invulnUntil = Infinity;
      g.stepFrames(180, 1 / 60, false);
      assert(g.player.health === 60, "regen delay");
      g.stepFrames(150, 1 / 60, false);
      assert(g.player.health === 100, "regen complete");
      for (let i = 0; i < 7; i++) {
        bot.takeDamage(10000);
        g.stepFrames(1, 1 / 60, false);
        bot.reset(13.5, 13.5, 0);
      }
      assert(g.killstreaks.uavActive && g.killstreaks.airstrikeReady && g.killstreaks.apacheReady, "streak rewards");
      g.input.keysPressedThisFrame.add("Digit4");
      g.stepFrames(100, 1 / 60, false);
      assert(g.killstreaks.apache.active && !g.killstreaks.apacheReady, "Apache deployed");
      g.input.keysPressedThisFrame.add("Digit4");
      g.stepFrames(40, 1 / 60, false);
      assert(g.killstreaks.laptopOut && g.player.lookLocked, "laptop");
      g.input.mouseButtonsPressedThisFrame.add(0);
      g.stepFrames(1, 1 / 60, false);
      assert(!g.killstreaks.airstrikeReady && g.killstreaks.bombs.length === 9, "airstrike scheduled");
      g.stepFrames(360, 1 / 60, false);
      assert(!g.player.lookLocked && g.killstreaks.bombs.length === 0 && g.killstreaks.jetRuns.length === 0, "strike complete");
      assert(g.cameraRig.camera.position.asArray().every(Number.isFinite), "camera");
      g.stepFrames(1, 1 / 60);
      return true;
    } finally {
      bot.update = original;
    }
  });
  expect(result).toBe(true);
});

test("graphics changes preserve Fast limits and paused redraws", async ({ page }) => {
  await start(page);
  await page.keyboard.press("KeyP");
  await expect(page.locator("#menu-overlay")).toBeVisible();
  const difficulty = page.locator("#diff-slider");
  await difficulty.focus();
  await page.keyboard.press("End");
  await expect.poll(() => page.evaluate(() => window.__game.botManager.getDifficultyLevel())).toBe(10);
  expect(await page.evaluate(() => window.__game.botManager.bots.every((bot) => bot.isTerminator))).toBe(true);
  const picker = page.locator("#menu-overlay [data-quality-picker]");
  await picker.locator('[data-quality="high"]').click();
  expect(
    await page.evaluate(() => ({
      quality: window.__game.postfx.currentQuality,
      ssao: Boolean(window.__game.postfx.ssao),
      shadows: window.__game.map.dynamicShadows,
    }))
  ).toEqual({ quality: "high", ssao: true, shadows: true });
  await picker.locator('[data-quality="balanced"]').click();
  await picker.locator('[data-quality="performance"]').click();
  await difficulty.focus();
  await page.keyboard.press("Home");
  await expect.poll(() => page.evaluate(() => window.__game.botManager.getDifficultyLevel())).toBe(1);
  expect(await page.evaluate(() => window.__game.botManager.bots.some((bot) => bot.isTerminator))).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__game.engine._activeRenderLoops.length)).toBe(0);
  await page.setViewportSize({ width: 2560, height: 1440 });
  expect(
    await page.evaluate(() => {
      const g = window.__game;
      return g.engine.getRenderWidth() * g.engine.getRenderHeight() <= 1920 * 1080 + 3000;
    })
  ).toBe(true);
  await page.locator("#btn-resume").click();
  await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__game.engine.maxFPS)).toBe(60);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("#menu-overlay")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__game.engine._activeRenderLoops.length)).toBe(0);
  const frames = await page.evaluate(() => window.__game.scene.getFrameId());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => page.evaluate(() => window.__game.scene.getFrameId())).toBeGreaterThan(frames);
  await expect.poll(() => page.evaluate(() => window.__game.engine._activeRenderLoops.length)).toBe(0);
  expect(await page.evaluate(() => window.__game.matchState)).toBe("paused");
});

test("a stalled download times out and can be retried", async ({ page }) => {
  await page.clock.install();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/models/soldier.glb", async (route) => {
    requests++;
    await gate;
    await route.continue().catch(() => {}); // Disposal cancels the original request.
  });
  await page.goto("/");
  await expect.poll(() => requests, { timeout: 45000 }).toBeGreaterThan(0);
  await page.clock.fastForward(45001);
  await expect(page.locator("#startup-message")).toContainText("Loading timed out");
  await expect(page.locator("#btn-retry")).toBeVisible();
  release();
  await page.unroute("**/models/soldier.glb");
  await page.clock.resume();
  await page.locator("#btn-retry").click();
  await ready(page);
});

test("all weapons aim, fire and reload without invalid ammo", async ({ page }) => {
  await start(page);
  const result = await page.evaluate(() => {
    const g = window.__game;
    const assert = (value, message) => {
      if (!value) throw Error(message);
    };
    g.engine.stopRenderLoop();
    g.player.invulnUntil = Infinity;
    const updates = g.botManager.bots.map((bot) => bot.update);
    g.botManager.bots.forEach((bot) => {
      bot.update = () => {};
    });
    try {
      for (const [index, weapon] of g.weaponManager.weapons.entries()) {
        g.weaponManager.refillAll();
        g.weaponManager.activeIndex = index;
        g.stepFrames(1, 1 / 60, false);
        g.input.mouseButtons.set(2, true);
        g.stepFrames(60, 1 / 60, false);
        assert(weapon.isAiming && weapon.adsAnimator.getProgress() === 1, `${weapon.id}: aim`);
        g.input.clearAllInputs();
        g.stepFrames(60, 1 / 60, false);
        assert(weapon.adsAnimator.getProgress() === 0, `${weapon.id}: hipfire`);
        const beforeTap = weapon.clipAmmo;
        g.input.mouseButtonsPressedThisFrame.add(0);
        g.stepFrames(1, 1 / 60, false); // The button was released before the next frame.
        assert(weapon.clipAmmo === beforeTap - 1, `${weapon.id}: quick tap`);
        g.input.clearAllInputs();
        g.stepFrames(120, 1 / 60, false);
        const clip = weapon.clipAmmo;
        g.input.mouseButtons.set(0, true);
        g.input.mouseButtonsPressedThisFrame.add(0);
        g.stepFrames(30, 1 / 60, false);
        g.input.clearAllInputs();
        assert(weapon.clipAmmo < clip && weapon.clipAmmo >= 0, `${weapon.id}: fire`);
        if (weapon.id !== "mp44") assert(weapon.clipAmmo === clip - 1, `${weapon.id}: single shot`);
        g.stepFrames(120, 1 / 60, false);
        g.input.keysPressedThisFrame.add("KeyR");
        g.stepFrames(180, 1 / 60, false);
        assert(weapon.clipAmmo === weapon.config.magSize && weapon.state === "idle", `${weapon.id}: reload`);
        weapon.clipAmmo = 1;
        weapon.state = "idle";
        g.input.mouseButtons.set(0, true);
        g.input.mouseButtonsPressedThisFrame.add(0);
        g.stepFrames(1, 1 / 60, false);
        g.input.clearAllInputs();
        g.stepFrames(240, 1 / 60, false);
        assert(
          weapon.clipAmmo === weapon.config.magSize && weapon.state === "idle" && weapon.reserveAmmo >= 0,
          `${weapon.id}: empty reload`
        );
      }
      g.stepFrames(1, 1 / 60);
      return true;
    } finally {
      g.input.clearAllInputs();
      g.botManager.bots.forEach((bot, i) => {
        bot.update = updates[i];
      });
    }
  });
  expect(result).toBe(true);
});
