import { Engine, Scene, Color4, Tools } from "@babylonjs/core";
import { Time } from "./Time";
import { Input } from "./Input";
import { WorldMaterials } from "../world/materials/WorldMaterials";
import { PostProcessing } from "../rendering/PostProcessing";
import { CameraRig } from "../player/CameraRig";
import { PlayerController } from "../player/PlayerController";
import { DeathCam } from "../player/DeathCam";
import { WeaponManager } from "../weapons/WeaponManager";
import { ShipBoxMap } from "../world/ShipBoxMap";
import { BotManager } from "../bots/BotManager";
import { preloadSoldierModel } from "../bots/SoldierAssets";
import { Killstreaks } from "../killstreaks/Killstreaks";
import { ViewModelRig } from "../rendering/ViewModelRig";
import { ScopeOverlay } from "../rendering/ScopeOverlay";
import { Effects } from "../rendering/Effects";
import { Hud } from "../ui/Hud";
import { Minimap } from "../ui/Minimap";
import { MatchUI } from "../ui/MatchUI";
import type { MatchResult } from "../ui/MatchUI";
import { RivalVoice } from "../ui/RivalVoice";
import { MatchEvents } from "../ui/MatchEvents";

type MatchState = "start" | "playing" | "paused" | "ended";

export class Game {
  // First to this many kills wins the match
  private static readonly KILL_LIMIT = 10;

  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;

  private time: Time;
  private input: Input;
  private materials: WorldMaterials;
  private postfx: PostProcessing;

  private cameraRig: CameraRig;
  private player: PlayerController;
  private weaponManager: WeaponManager;
  private map: ShipBoxMap;
  private botManager: BotManager;

  private viewModelRig: ViewModelRig;
  private scopeOverlay: ScopeOverlay;
  private effects: Effects;
  private hud: Hud;
  private minimap: Minimap;
  private matchUI: MatchUI;
  private rivalVoice: RivalVoice;
  private killstreaks: Killstreaks;
  private deathCam: DeathCam;

  // Match flow: updates only run while "playing"; paused/ended keep
  // rendering the frozen frame under the DOM overlays
  private matchState: MatchState = "start";
  private everLocked = false;
  private wasDead = false; // edge detector for the death-cam handoff
  private elapsed = 0; // monotonic game time for UI pulse phases
  private lastFpsUpdate = 0; // Time.fpsUpdates seen by the adaptive quality step-down
  private hudRootEl = document.getElementById("hud-root");
  private lastHideCrosshair = false;
  private disposed = false;

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!this.canvas) {
      throw new Error(`Canvas with id ${canvasId} not found.`);
    }

    // 1. Initialize Babylon Engine and Scene
    // - antialias false: AA comes from the FXAA pass; a multisampled
    //   backbuffer behind a post-process pipeline only burns bandwidth
    // - preserveDrawingBuffer/stencil false: nothing reads pixels back and
    //   nothing uses stencil — both cost real GPU time when enabled
    // - adaptToDeviceRatio: render at native device pixels (a Retina display
    //   otherwise gets a half-resolution image stretched 2x — the single
    //   biggest sharpness loss); PostProcessing caps the ratio for speed
    this.engine = new Engine(this.canvas, false, { preserveDrawingBuffer: false, stencil: false, adaptToDeviceRatio: true });
    this.scene = new Scene(this.engine);

    // Gritty industrial fog/clear color
    this.scene.clearColor = new Color4(0.08, 0.09, 0.11, 1.0);

    // FPS input is read from raw DOM events; without this Babylon raycasts
    // the whole scene on every pointermove (hundreds/sec on fast mice) just
    // to track the mesh under the cursor
    this.scene.skipPointerMovePicking = true;

    // The shared rigged-soldier asset loads in the background; soldier
    // bodies are built headless and grow their skin when this lands
    preloadSoldierModel(this.scene);

    // 2. Initialize Subsystems
    this.time = new Time();
    this.input = new Input(this.canvas);
    this.materials = new WorldMaterials(this.scene);
    
    this.cameraRig = new CameraRig(this.scene);
    this.player = new PlayerController(this.input, this.cameraRig);
    this.weaponManager = new WeaponManager();
    this.map = new ShipBoxMap(this.scene, this.materials);
    
    this.viewModelRig = new ViewModelRig(this.scene, this.cameraRig);
    this.scopeOverlay = new ScopeOverlay();
    this.effects = new Effects(this.scene);
    // After the map: the bots grow their nav graph from its collision boxes.
    // Before the material freeze below: their materials are final too.
    this.botManager = new BotManager(this.scene, this.player, this.effects);
    // Respawns land far from (and hidden from) living enemies
    this.player.spawnPicker = (spawns) => this.botManager.pickPlayerSpawn(spawns);
    this.hud = new Hud(this.canvas);
    this.minimap = new Minimap(this.map);
    this.matchUI = new MatchUI(
      this.effects,
      () => this.weaponManager.getActiveWeapon().id,
      {
        onStart: () => this.startMatch(),
        onResume: () => this.input.requestPointerLock(),
        onEndMatch: () => this.endMatch(),
        onPlayAgain: () => this.restartMatch(),
        onDifficultyChange: (level) => this.botManager.setDifficultyLevel(level),
        onToggleTrashTalk: (muted) => this.rivalVoice.setMuted(muted),
      }
    );
    this.rivalVoice = new RivalVoice();
    // Both build meshes/materials, so they sit before the freeze below: the
    // death-cam corpse actor, and the killstreak hardware (laptop viewmodel,
    // Apache airframe, the strike jets)
    this.deathCam = new DeathCam(this.scene);
    this.killstreaks = new Killstreaks(
      this.scene,
      this.cameraRig.camera,
      this.input,
      this.player,
      this.botManager,
      this.effects,
      this.cameraRig
    );

    // Pause rides the pointer lock: P (or Escape) releases the lock, and ANY
    // unlock while playing opens the menu — there is no unpaused-but-unlocked
    // state to get stranded in. Re-locking from the Resume button unpauses.
    document.addEventListener("pointerlockchange", this.onPointerLockChange);

    // Post-processing: anti-aliasing, filmic tone mapping, sharpening,
    // bloom, vignette. This is what lifts the flat-shaded look into
    // something photographic.
    this.postfx = new PostProcessing(this.engine, this.scene, this.cameraRig.camera);

    // Every material in the scene is now final: textures may still repaint
    // (target boards) and light uniforms still update (muzzle flash), but no
    // material ever gains/loses a texture slot or light. Freezing skips the
    // per-frame shader-define re-evaluation for every mesh.
    for (const material of this.scene.materials) {
      material.freeze();
    }

    this.scene.animationsEnabled = false;
    this.viewModelRig.setHidden(true);
    this.hud.hidePrompt();
    this.matchUI.showStart(this.botManager.getDifficultyLevel());

    // 3. Start Main Loop
    this.startLoop();

    // 4. Handle Window Resize
    window.addEventListener("resize", this.onResize);
  }

  private onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    if (locked) {
      this.everLocked = true;
      if (this.matchState === "paused") this.resumeMatch();
    } else if (this.matchState === "playing" && this.everLocked) {
      this.pauseMatch();
    }
  };

  private onResize = (): void => {
    this.engine.resize();
  };

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.stopRenderLoop();
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    window.removeEventListener("resize", this.onResize);
    this.killstreaks.onMatchEnd();
    this.rivalVoice.dispose();
    this.matchUI.dispose();
    this.postfx.dispose();
    MatchEvents.clear();
    this.input.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  private startLoop(): void {
    this.engine.runRenderLoop(() => {
      if (this.disposed) return;
      this.time.update();
      this.frame();
    });
  }

  // Deterministic stepping for tooling: advance the simulation N frames of
  // exactly `dt` seconds each, rendering every one. Dev-only (see main.ts);
  // lets the death choreography, reload animations and bot behaviour be
  // inspected frame by frame from the console without a live mouse.
  public stepFrames(frames: number, dt: number): void {
    for (let i = 0; i < frames; i++) {
      this.time.deltaTime = dt;
      this.engine.beginFrame();
      this.frame();
      this.engine.endFrame();
    }
  }

  // Dev tooling: render one frame and post the result to the dev server's
  // screenshot endpoint (see vite.config.ts), which saves it as a PNG.
  public captureFrame(name: string, dt: number = 1 / 60): Promise<string> {
    return new Promise((resolve, reject) => {
      Tools.CreateScreenshot(this.engine, this.cameraRig.camera, { precision: 1 }, (dataUrl) => {
        fetch("/__dev/screenshot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, dataUrl }),
        })
          .then((r) => r.json())
          .then((j: { file: string }) => resolve(j.file), reject);
      });
      this.stepFrames(1, dt);
    });
  }

  // One simulation + render frame. Time.deltaTime has already been set.
  private frame(): void {
    if (this.matchState === "playing") {
      const dt = this.time.deltaTime;

      // P releases the pointer lock; the pointerlockchange handler turns
      // that into the pause (same path Escape takes)
      if (this.input.isKeyPressed("KeyP") && this.input.getIsPointerLocked()) {
        document.exitPointerLock();
      }

      this.elapsed += dt;
      const activeWeapon = this.weaponManager.getActiveWeapon();
      const adsState = activeWeapon.adsAnimator.getInterpolatedState();

      // Step 2: Update Player (look, movement, camera rig)
      this.player.update(dt, adsState.sensitivityMultiplier, activeWeapon.adsAnimator.getProgress());

      // Step 3: Update Weapon Systems (firing, bolt action state, reloading,
      // ADS animation). While killstreak hardware is in hand, LMB belongs
      // to that device — the trigger is disconnected.
      this.weaponManager.update(
        dt,
        this.input,
        this.player,
        this.cameraRig,
        this.scene,
        this.effects,
        !this.killstreaks.handheldOut
      );

      // Step 3.5: Bots perceive, decide, move and fight — after the player's
      // shots have landed (deaths register before they act) and with this
      // frame's gunshot noise for their hearing. A respawned player gets a
      // fresh Fall of Duty loadout.
      this.botManager.update(dt, this.player, this.weaponManager.firedThisFrame);
      if (this.player.consumeRespawn()) {
        this.weaponManager.refillAll();
        this.deathCam.end();
        this.wasDead = false;
      }

      // Step 3.6: Killstreaks — the C-key laptop, scheduled bombs, the
      // Apache. Runs after the bots so this frame's kills count instantly.
      this.killstreaks.update(dt);

      // Step 3.7: Death: the moment the player drops (bot fire above, or
      // their own airstrike), the camera leaves their eyes and the corpse
      // actor takes the stage until respawn hands control back.
      if (this.player.isDead && !this.wasDead) {
        this.wasDead = true;
        this.deathCam.begin(this.player, this.cameraRig.camera, this.effects);
      }
      if (this.player.isDead) {
        this.deathCam.update(dt, this.cameraRig.camera);
      }

      // Step 4: Update ViewModel & Scope overlay rendering.
      // Re-fetch the weapon: the X-key swap may have just changed it.
      // Dead hands and killstreak hardware hands carry no rifle.
      const hideViewmodel = this.player.isDead || this.killstreaks.handheldOut;
      this.viewModelRig.setHidden(hideViewmodel);
      if (hideViewmodel) {
        this.scopeOverlay.update(0, 0, 0);
      } else {
        const shownWeapon = this.weaponManager.getActiveWeapon();
        const shownAds = shownWeapon.adsAnimator.getInterpolatedState();
        this.viewModelRig.update(
          dt,
          shownWeapon,
          this.input,
          this.player.isSprinting,
          this.weaponManager.getLowerAmount()
        );
        this.scopeOverlay.update(shownAds.scopeOpacity, shownAds.vignetteOpacity, shownWeapon.adsAnimator.getProgress());
      }
      if (hideViewmodel !== this.lastHideCrosshair) {
        this.lastHideCrosshair = hideViewmodel;
        this.hudRootEl?.classList.toggle("hide-crosshair", hideViewmodel);
      }

      // Step 5: Update Map targets
      this.map.update(dt);

      // Step 5.5: Scoreboard + the first-to-10 win condition
      this.matchUI.setScore(this.botManager.playerKills, this.player.deaths);
      if (this.botManager.playerKills >= Game.KILL_LIMIT) {
        this.endMatch("victory");
      } else if (this.player.deaths >= Game.KILL_LIMIT) {
        this.endMatch("defeat");
      }
    }

    // Step 6: Render Scene (paused/ended render the frozen frame under the menus)
    this.scene.render();

    // Step 6.5: Once a second while playing, let the image pipeline judge
    // whether the chosen quality tier is holding a playable frame rate
    if (this.matchState === "playing" && this.time.fpsUpdates !== this.lastFpsUpdate) {
      this.lastFpsUpdate = this.time.fpsUpdates;
      this.postfx.reportFps(this.time.fps);
    }

    // Step 7: Update HUD interface + minimap radar (UAV reveal included)
    if (this.matchState === "playing") {
      this.hud.update(this.weaponManager.getActiveWeapon(), this.input, this.player);
      this.minimap.update(
        this.player,
        this.botManager.bots,
        this.killstreaks.uavActive,
        this.elapsed,
        this.killstreaks.getApacheRadarContact()
      );
    }

    // Step 8: Clear single-frame key transitions (every state — stale
    // presses from menu typing must not fire on resume)
    this.input.postUpdate();
  }

  // ---------------------------------------------------------- match flow

  private startMatch(): void {
    if (this.matchState !== "start") return;
    this.player.resetForMatch();
    this.botManager.resetMatch(this.player);
    this.weaponManager.resetLoadout();
    this.killstreaks.resetMatch();
    this.rivalVoice.resetMatch();
    this.deathCam.end();
    this.wasDead = false;
    this.everLocked = false;
    this.lastHideCrosshair = true;
    this.hudRootEl?.classList.add("hide-crosshair");
    this.matchUI.resetMatch();
    this.matchUI.hideStart();
    this.input.clearAllInputs();
    this.scene.animationsEnabled = true;
    this.killstreaks.setPaused(false);
    this.viewModelRig.setHidden(false);
    this.hudRootEl?.classList.remove("hide-crosshair");
    this.lastHideCrosshair = false;
    this.matchState = "playing";
    this.input.requestPointerLock();
  }

  private pauseMatch(): void {
    if (this.matchState !== "playing") return;
    this.matchState = "paused";
    // scene.render keeps running under the menu — freeze the skeletal clips
    // so the soldiers don't idle behind the frozen frame
    this.scene.animationsEnabled = false;
    this.input.clearAllInputs();
    this.killstreaks.setPaused(true); // the rotor must not thump over the menu
    this.hud.hidePrompt();
    this.matchUI.showPause(
      this.botManager.playerKills,
      this.player.deaths,
      this.botManager.getDifficultyLevel()
    );
  }

  private resumeMatch(): void {
    if (this.matchState !== "paused") return;
    this.matchState = "playing";
    this.scene.animationsEnabled = true;
    this.input.clearAllInputs();
    this.killstreaks.setPaused(false);
    this.matchUI.hidePause();
  }

  // No result given (End Match button): judge by the current score
  private endMatch(result?: MatchResult): void {
    if (this.matchState === "ended") return;
    const kills = this.botManager.playerKills;
    const deaths = this.player.deaths;
    const finalResult: MatchResult =
      result ?? (kills > deaths ? "victory" : deaths > kills ? "defeat" : "draw");
    this.matchState = "ended";
    this.scene.animationsEnabled = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.input.clearAllInputs();
    this.killstreaks.onMatchEnd(); // silence the rotor, shut the laptop, free the keys
    this.hud.hidePrompt();
    this.matchUI.setScore(kills, deaths);
    this.matchUI.showEnd(finalResult, kills, deaths);
  }

  private restartMatch(): void {
    this.scene.animationsEnabled = true;
    this.player.resetForMatch();
    this.botManager.resetMatch(this.player);
    this.weaponManager.resetLoadout();
    this.killstreaks.resetMatch();
    this.rivalVoice.resetMatch();
    this.deathCam.end();
    this.wasDead = false;
    this.matchUI.resetMatch();
    this.input.clearAllInputs();
    this.matchState = "playing";
    // Play Again is a click — a valid user gesture for re-capturing the mouse
    this.input.requestPointerLock();
  }
}
