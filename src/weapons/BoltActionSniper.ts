import { Scene, Vector3 } from "@babylonjs/core";
import { Input } from "../engine/Input";
import { CameraRig } from "../player/CameraRig";
import { ADSAnimator } from "./ADSAnimator";
import { fireHitscanRay } from "./WeaponTypes";
import type { Weapon, WeaponConfig, WeaponState } from "./WeaponTypes";
import { Effects } from "../rendering/Effects";
import { AssetLoader } from "../engine/AssetLoader";

type ReloadEvent = { time: number; kind: "boltOpen" | "insert" | "boltClose" };

export class BoltActionSniper implements Weapon {
  public readonly id = "m40a3" as const;

  // Reload timeline (seconds): open the bolt, feed each round through the
  // open action into the internal magazine, then run the bolt home.
  // ViewModelRig reads these to drive the matching hand/bolt animation.
  public static readonly RELOAD_OPEN = 0.41;
  public static readonly RELOAD_PER_ROUND = 0.38;
  public static readonly RELOAD_CLOSE = 0.45;

  public config: WeaponConfig;
  public clipAmmo: number;
  public reserveAmmo: number;

  public state: WeaponState = "idle";
  public timer: number = 0; // Countdown timer for current state

  // Active reload timeline (set on startReload)
  public reloadTotal: number = 0;
  public reloadRounds: number = 0;
  private reloadEvents: ReloadEvent[] = [];

  public adsAnimator: ADSAnimator;
  public isAiming: boolean = false;

  // Track if bolt sound has been played during this cycle
  private boltSoundPlayed: boolean = false;

  // Recoil offset on weapon mesh (visual model translation kickback)
  public visualKickZ: number = 0;

  constructor(loader: AssetLoader) {
    this.config = loader.loadWeaponConfig();
    this.clipAmmo = this.config.magSize;
    this.reserveAmmo = this.config.maxReserveAmmo;

    const adsAnimData = loader.loadAdsAnimation();
    this.adsAnimator = new ADSAnimator(adsAnimData);
  }

  public update(
    deltaTime: number,
    input: Input,
    _playerController: unknown,
    cameraRig: CameraRig,
    scene: Scene,
    effects: Effects,
    inputEnabled: boolean = true
  ): void {
    // 1. Check ADS input — Space bar is the zoom key (right mouse also works)
    // Cannot aim down sights if reloading or cycling the bolt
    const canAds = this.state === "idle" || this.state === "empty";
    this.isAiming =
      inputEnabled && (input.isKeyDown("Space") || input.isMouseButtonDown(2)) && canAds;

    // Update ADS frames
    this.adsAnimator.update(deltaTime, this.isAiming, canAds);

    // Apply current ADS state properties
    const adsState = this.adsAnimator.getInterpolatedState();
    cameraRig.setFov(adsState.fov);
    
    // 2. Weapon Visual Kick recovery using robust exponential decay
    this.visualKickZ *= Math.exp(-12 * deltaTime);

    // 3. Manage State Machine
    if (this.state === "cycling") {
      this.timer -= deltaTime;
      
      // Delay bolt cycle sound to play 0.4 seconds after the shot
      const elapsedCycleTime = this.config.boltCycleDuration - this.timer;
      if (elapsedCycleTime >= 0.4 && !this.boltSoundPlayed) {
        effects.playBoltCycleSound();
        this.boltSoundPlayed = true;
      }

      if (this.timer <= 0) {
        if (this.clipAmmo === 0 && this.reserveAmmo > 0) {
          this.startReload();
        } else {
          this.state = this.clipAmmo === 0 ? "empty" : "idle";
        }
      }
    } else if (this.state === "reloading") {
      this.timer -= deltaTime;

      // Fire timeline events (sounds + per-round ammo) as the animation
      // passes each point — the mag fills one round at a time
      const elapsed = this.reloadTotal - this.timer;
      while (this.reloadEvents.length > 0 && elapsed >= this.reloadEvents[0].time) {
        const ev = this.reloadEvents.shift()!;
        if (ev.kind === "boltOpen") {
          effects.playBoltOpenSound();
        } else if (ev.kind === "insert") {
          if (this.reserveAmmo > 0 && this.clipAmmo < this.config.magSize) {
            this.clipAmmo++;
            this.reserveAmmo--;
          }
          effects.playRoundInsertSound();
        } else {
          effects.playBoltCloseSound();
        }
      }

      if (this.timer <= 0) {
        this.reloadEvents = [];
        this.state = this.clipAmmo === 0 ? "empty" : "idle";
      }
    }

    // 4. Handle Fire and Reload inputs
    // "empty" must accept trigger/reload input, otherwise a dry mag soft-locks the weapon
    const canUseTrigger = (this.state === "idle" || this.state === "empty") && inputEnabled;
    if (canUseTrigger && this.state === "empty" && this.clipAmmo === 0 && this.reserveAmmo > 0) {
      this.startReload();
      return;
    }
    if (canUseTrigger && input.isMouseButtonPressed(0)) { // Left click
      if (this.clipAmmo > 0) {
        this.fire(scene, cameraRig, effects);
      } else {
        this.startReload();
      }
    }

    if (input.isKeyPressed("KeyR") && canUseTrigger && this.clipAmmo < this.config.magSize && this.reserveAmmo > 0) {
      this.startReload();
    }
  }

  private fire(scene: Scene, cameraRig: CameraRig, effects: Effects): void {
    this.clipAmmo--;
    this.state = "cycling";
    this.timer = this.config.boltCycleDuration;
    this.boltSoundPlayed = false;

    // Apply visual kick to weapon model
    const recoilSettings = this.isAiming ? this.config.recoilAds : this.config.recoilHip;
    this.visualKickZ = recoilSettings.kickBack; // kick the weapon viewmodel back

    // 1. Play synthesized gunshot
    effects.playShootSound();

    // 2. Raycast hitscan shot from the camera center
    const camera = cameraRig.camera;
    const origin = camera.globalPosition.clone();
    const forward = camera.getDirection(Vector3.Forward());
    const right = camera.getDirection(Vector3.Right());
    const up = camera.getDirection(Vector3.Up());

    // Muzzle flash sits at the barrel tip; converges toward screen center as ADS completes
    const adsProgress = this.adsAnimator.getProgress();
    const hipOffset = 1 - adsProgress;
    const flashPos = origin
      .add(forward.scale(0.8))
      .addInPlace(right.scale(0.1 * hipOffset))
      .addInPlace(up.scale(-0.145 * hipOffset));
    effects.createMuzzleFlash(flashPos);

    // Spread, scene pick and hit response are shared by every weapon
    fireHitscanRay(scene, camera, effects, origin, forward, right, up, this.config.adsSpread, adsProgress, this.config.damage);

    // 3. Apply Camera recoil impulse
    cameraRig.applyRecoil(recoilSettings.pitch, recoilSettings.yaw, recoilSettings.kickBack);
  }

  // Holstering mid-reload abandons the animation; rounds already fed stay loaded
  public cancelReload(): void {
    if (this.state !== "reloading") return;
    this.reloadEvents = [];
    this.timer = 0;
    this.state = this.clipAmmo === 0 ? "empty" : "idle";
  }

  private startReload(): void {
    if (this.reserveAmmo <= 0 || this.clipAmmo === this.config.magSize) return;

    const rounds = Math.min(this.config.magSize - this.clipAmmo, this.reserveAmmo);
    this.reloadRounds = rounds;
    this.reloadTotal =
      BoltActionSniper.RELOAD_OPEN +
      rounds * BoltActionSniper.RELOAD_PER_ROUND +
      BoltActionSniper.RELOAD_CLOSE;

    this.state = "reloading";
    this.timer = this.reloadTotal;

    // Timeline events: bolt-open click mid-open, one insert per round timed
    // to the hand pressing it in, bolt-close clunk as the bolt slides home
    this.reloadEvents = [{ time: BoltActionSniper.RELOAD_OPEN * 0.55, kind: "boltOpen" }];
    for (let i = 0; i < rounds; i++) {
      this.reloadEvents.push({
        time: BoltActionSniper.RELOAD_OPEN + (i + 0.85) * BoltActionSniper.RELOAD_PER_ROUND,
        kind: "insert",
      });
    }
    this.reloadEvents.push({ time: this.reloadTotal - BoltActionSniper.RELOAD_CLOSE * 0.45, kind: "boltClose" });
  }
}
