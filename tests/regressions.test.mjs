import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const savedSettings = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (key) => savedSettings.get(key) ?? null, setItem: (key, value) => savedSettings.set(key, value) },
});

// Vite loads the same TypeScript/JSON modules used by the game, without
// adding another compiler or a browser dependency to the test suite.
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "silent",
});
after(() => server.close());
const { WeaponManager } = await server.ssrLoadModule("/src/weapons/WeaponManager.ts");
const { PlayerController } = await server.ssrLoadModule("/src/player/PlayerController.ts");
const { Vector3 } = await import("@babylonjs/core");

test("respawn refills clear aiming, recoil, cooldowns and slide/bolt state", () => {
  const manager = new WeaponManager();
  for (const weapon of manager.weapons) {
    weapon.adsAnimator.update(1, true, true);
    weapon.isAiming = true;
    weapon.visualKickZ = 0.1;
    weapon.timer = 2;
    weapon.fireCooldown = 1;
    weapon.slideKick = 1;
    weapon.boltKick = 1;
    weapon.slideLocked = true;
    weapon.clipAmmo = 0;
    weapon.state = "empty";
  }
  manager.refillAll();
  for (const weapon of manager.weapons) {
    assert.equal(weapon.clipAmmo, weapon.config.magSize);
    assert.equal(weapon.adsAnimator.getProgress(), 0, weapon.id);
    assert.equal(weapon.isAiming, false, weapon.id);
    assert.equal(weapon.visualKickZ, 0, weapon.id);
    assert.equal(weapon.timer, 0, weapon.id);
    if (weapon.id === "usp45") assert.equal(weapon.getSlideBack(), 0);
    if (weapon.id === "mp44") assert.equal(weapon.getBoltBack(), 0);
    if (weapon.id !== "m40a3") assert.equal(weapon.fireCooldown, 0);
  }
});

test("switching away from a scoped weapon clears its cached aim", () => {
  const manager = new WeaponManager();
  manager.activeIndex = 1;
  const previous = manager.getActiveWeapon();
  previous.adsAnimator.update(1, true, true);
  previous.isAiming = true;
  const input = { isKeyPressed: (key) => key === "KeyX", isKeyDown: () => false, isMouseButtonDown: () => false };
  manager.update(0.01, input, { isDead: false }, { setFov() {} }, {}, { playWeaponSwitchSound() {} });
  assert.equal(previous.adsAnimator.getProgress(), 0);
  assert.equal(previous.isAiming, false);
});

test("a 100ms movement frame cannot push a player through a thin wall", () => {
  PlayerController.clearObstacles();
  PlayerController.registerObstacle(-0.05, 0.05, 0, 3, -2, 2);
  const previous = new Vector3(-0.5, 0, 0);
  const velocity = new Vector3(6.2, 0, 0);
  const next = new Vector3();
  PlayerController.moveAndCollide(previous, velocity, 0.1, 1.85, 0.4, next);
  assert.ok(next.x <= -0.45 + 1e-6, `crossed to x=${next.x}`);
  assert.equal(velocity.x, 0);
  PlayerController.clearObstacles();
});

test("standing on a prop remains grounded with zero vertical velocity", () => {
  PlayerController.clearObstacles();
  PlayerController.registerObstacle(-2, 2, 0, 1, -2, 2);
  const next = new Vector3();
  const grounded = PlayerController.moveAndCollide(new Vector3(0, 1, 0), new Vector3(), 1 / 60, 1.85, 0.4, next);
  assert.equal(grounded, true);
  assert.equal(next.y, 1);
  PlayerController.clearObstacles();
});

test("collision steps still slide along a wall", () => {
  PlayerController.registerObstacle(-0.05, 0.05, 0, 3, -2, 2);
  const next = new Vector3();
  PlayerController.moveAndCollide(new Vector3(-0.5, 0, -1), new Vector3(6.2, 0, 3), 0.1, 1.85, 0.4, next);
  assert.ok(next.x <= -0.45 + 1e-6);
  assert.ok(next.z > -0.8);
  PlayerController.clearObstacles();
});

test("a rotated thin wall cannot be crossed during a lag spike", () => {
  const yaw = Math.PI / 4;
  PlayerController.registerObstacleOBB(0, 0, 0.05, 2, 0, 3, yaw);
  const next = new Vector3();
  PlayerController.moveAndCollide(
    new Vector3(-0.5 * Math.cos(yaw), 0, 0.5 * Math.sin(yaw)),
    new Vector3(6.2 * Math.cos(yaw), 0, -6.2 * Math.sin(yaw)),
    0.1,
    1.85,
    0.4,
    next
  );
  assert.ok(Math.cos(yaw) * next.x - Math.sin(yaw) * next.z <= -0.45 + 1e-6);
  PlayerController.clearObstacles();
});

test("ending a paused match then resetting restores helicopter audio", async () => {
  const { Killstreaks } = await server.ssrLoadModule("/src/killstreaks/Killstreaks.ts");
  const streaks = Object.create(Killstreaks.prototype);
  let rotorMuted = true;
  Object.assign(streaks, {
    laptop: { forceClose() {} },
    transmitter: { forceClose() {} },
    apache: { active: false },
    player: { lookLocked: true },
    effects: {
      setRotorMuted: (muted) => {
        rotorMuted = muted;
      },
    },
    hintEl: null,
    bombs: [],
    jetRuns: [],
    jets: [],
  });
  streaks.resetMatch();
  assert.equal(rotorMuted, false);
  assert.equal(streaks.player.lookLocked, false);
});

test("disposed menus cannot start a game or consume match events", async () => {
  const { MatchUI } = await server.ssrLoadModule("/src/ui/MatchUI.ts");
  const { MatchEvents } = await server.ssrLoadModule("/src/ui/MatchEvents.ts");
  const button = new globalThis.EventTarget();
  const document = new globalThis.EventTarget();
  document.getElementById = (id) => (id === "btn-start" ? button : null);
  document.querySelector = () => null;
  document.querySelectorAll = () => [];
  globalThis.document = document;
  let starts = 0;
  let oldKills = 0;
  let newKills = 0;
  const callbacks = { onStart: () => starts++ };
  const oldUI = new MatchUI({}, () => "mp44", callbacks);
  oldUI.onKill = () => oldKills++;
  oldUI.dispose();
  const newUI = new MatchUI({}, () => "mp44", callbacks);
  newUI.onKill = () => newKills++;
  button.dispatchEvent(new globalThis.Event("click"));
  MatchEvents.emit("kill", { headshot: false, cause: "player" });
  assert.equal(starts, 1);
  assert.equal(oldKills, 0);
  assert.equal(newKills, 1);
  newUI.dispose();
  delete globalThis.document;
});

test("respawn cancels an unfinished weapon swap", () => {
  const manager = new WeaponManager();
  manager.switchPhase = "lower";
  manager.switchTimer = 0.1;
  manager.refillAll();
  assert.equal(manager.switchPhase, "none");
  assert.equal(manager.switchTimer, 0);
});

test("unsubscribing during an event does not skip another listener", async () => {
  const { MatchEvents } = await server.ssrLoadModule("/src/ui/MatchEvents.ts");
  const calls = [];
  const offFirst = MatchEvents.on("kill", () => {
    calls.push(1);
    offFirst();
  });
  const offSecond = MatchEvents.on("kill", () => calls.push(2));
  MatchEvents.emit("kill", { headshot: false, cause: "player" });
  assert.deepEqual(calls, [1, 2]);
  offSecond();
});

const { BotNav } = await server.ssrLoadModule("/src/bots/BotNav.ts");
const { observePlayer, samplePlayerBody } = await server.ssrLoadModule("/src/bots/BotPerception.ts");
const { rayVsPlayerBody, angleDelta, selectWeapon } = await server.ssrLoadModule("/src/bots/BotCombat.ts");
const { BotRouteMemory, selectSearchNode } = await server.ssrLoadModule("/src/bots/BotNavigation.ts");
const { BOT_WEAPONS, difficultyForLevel } = await server.ssrLoadModule("/src/bots/BotConfig.ts");

const playerBody = () => ({ position: new Vector3(0, 0, 5), eyeHeight: 1.7, isDead: false });

test("bot perception sees exposed players but cannot see through a wall", () => {
  PlayerController.clearObstacles();
  BotNav.build();
  const sight = { visible: false, exposure: 0, aimSample: 1 };
  const player = playerBody();
  observePlayer(new Vector3(), 0, player, difficultyForLevel(5), false, sight);
  assert.equal(sight.visible, true);
  assert.equal(sight.exposure, 1);
  assert.equal(sight.aimSample, 1, "chest has first aim priority");
  PlayerController.registerObstacle(-2, 2, 0, 3, 2, 3);
  BotNav.build();
  observePlayer(new Vector3(), 0, player, difficultyForLevel(5), false, sight);
  assert.equal(sight.visible, false);
  assert.equal(sight.exposure, 0);
  PlayerController.clearObstacles();
});

test("bot sight cone excludes a player behind it and ignores dead players", () => {
  BotNav.build();
  const player = playerBody();
  const sight = { visible: false, exposure: 0, aimSample: 1 };
  observePlayer(new Vector3(), Math.PI, player, difficultyForLevel(5), true, sight);
  assert.equal(sight.visible, false);
  player.isDead = true;
  observePlayer(new Vector3(), 0, player, difficultyForLevel(5), true, sight);
  assert.equal(sight.visible, false);
});

test("bot silhouette tracks the player's crouched eye height", () => {
  const player = playerBody();
  const out = new Vector3();
  samplePlayerBody(new Vector3(), player, 0, out);
  assert.equal(out.y, 1.7);
  player.eyeHeight = 0.95;
  samplePlayerBody(new Vector3(), player, 0, out);
  assert.equal(out.y, 0.95);
});

test("bot shots hit the body and point-blank shots, but miss above the head", () => {
  const player = playerBody();
  const dir = new Vector3(0, 0, 1);
  assert.ok(Math.abs(rayVsPlayerBody(new Vector3(0, 1, 0), dir, player) - 4.58) < 1e-6);
  assert.equal(rayVsPlayerBody(new Vector3(0, 3, 0), dir, player), Infinity);
  assert.ok(Math.abs(rayVsPlayerBody(new Vector3(0, 1, 5), dir, player) - 0.42) < 1e-6);
  assert.ok(Math.abs(angleDelta(Math.PI - 0.1, -Math.PI + 0.1) - 0.2) < 1e-6);
});

test("weapon utility favors a loaded sidearm when the primary is dry", () => {
  assert.equal(
    selectWeapon(
      [
        { clip: 0, profile: BOT_WEAPONS.mp44 },
        { clip: BOT_WEAPONS.usp45.magSize, profile: BOT_WEAPONS.usp45 },
      ],
      0,
      2,
      1
    ),
    1
  );
});

test("route memory discourages revisits and resets for a new match", () => {
  BotNav.build();
  const memory = new BotRouteMemory();
  const node = BotNav.nearestNode(0, 0);
  memory.remember(node);
  assert.ok(memory.penalty(node, -1, -1, -1) < 1);
  memory.reset();
  assert.equal(memory.penalty(node, -1, -1, -1), 1);
  const chosen = selectSearchNode(new Vector3(-10, 0, -10), { x: 0, z: 0 }, new Vector3(), 5, () => 1);
  assert.ok(chosen >= 0 && BotNav.walkable[chosen] === 1);
});
