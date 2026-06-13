import { Scene, Vector3 } from "@babylonjs/core";
import { Input } from "../engine/Input";
import { CameraRig } from "../player/CameraRig";
import { ADSAnimator } from "./ADSAnimator";
import { fireHitscanRay } from "./WeaponTypes";
import type { Weapon, WeaponConfig, WeaponState } from "./WeaponTypes";
import { Effects } from "../rendering/Effects";
import { AssetLoader } from "../engine/AssetLoader";

type ReloadEvent = { time: number; kind: "magOut" | "magIn" | "slideRelease" };

// Semi-auto .45 sidearm. No bolt cycle: the slide blows back on every shot
// and locks open on the last round; reload is a single mag swap.
export class Pistol implements Weapon {
  // Reload timeline (seconds) — ViewModelRig mirrors these to drive the
  // support hand / magazine animation, so keep both in sync.
  public static readonly RELOAD_TOTAL = 1.16;
  public static readonly MAG_OUT_AT = 0.15; // mag drops free of the grip
  public static readonly MAG_DOWN_AT = 0.41; // hand + spent mag reach the pouch
  public static readonly MAG_IN_AT = 0.75; // fresh mag seats (ammo refills here)
  public static readonly SLIDE_RELEASE_AT = 0.94; // slide slams home if it was locked

  public readonly id = "usp45" as const;
  public config: WeaponConfig;
  public clipAmmo: number;
  public reserveAmmo: number;

  public state: WeaponState = "idle";
  public timer: number = 0;
  public reloadTotal: number = 0;

  public adsAnimator: ADSAnimator;
  public isAiming: boolean = false;

  // Recoil offset on weapon mesh (visual model translation kickback)
  public visualKickZ: number = 0;

  // Slide blowback: spikes to 1 on each shot and snaps back; ViewModelRig
  // reads getSlideBack() which also holds the slide open while locked.
  private slideKick: number = 0;
  private slideLocked: boolean = false;

  private fireCooldown: number = 0;
  private reloadEvents: ReloadEvent[] = [];

  constructor(loader: AssetLoader) {
    this.config = loader.loadPistolConfig();
    this.clipAmmo = this.config.magSize;
    this.reserveAmmo = this.config.maxReserveAmmo;

    this.adsAnimator = new ADSAnimator(loader.loadPistolAdsAnimation());
  }

  // 0..1 — how far back the slide sits this frame
  public getSlideBack(): number {
    return this.slideLocked ? 1 : this.slideKick;
  }

  public isSlideLocked(): boolean {
    return this.slideLocked;
  }

  public update(
    deltaTime: number,
    input: Input,
    _playerController: unknown,
    cameraRig: CameraRig,
    scene: Scene,
    effects: Effects,
    inputEnabled: boolean
  ): void {
    // 1. ADS input — same bindings as the rifle (Space / right mouse)
    const canAds = this.state === "idle" || this.state === "empty";
    this.isAiming =
      inputEnabled && (input.isKeyDown("Space") || input.isMouseButtonDown(2)) && canAds;

    this.adsAnimator.update(deltaTime, this.isAiming, canAds);
    cameraRig.setFov(this.adsAnimator.getInterpolatedState().fov);

    // 2. Visual recovery — the slide snaps back much faster than the kick fades
    this.visualKickZ *= Math.exp(-14 * deltaTime);
    this.slideKick *= Math.exp(-26 * deltaTime);
    this.fireCooldown -= deltaTime;

    // 3. Reload state machine
    if (this.state === "reloading") {
      this.timer -= deltaTime;

      const elapsed = this.reloadTotal - this.timer;
      while (this.reloadEvents.length > 0 && elapsed >= this.reloadEvents[0].time) {
        const ev = this.reloadEvents.shift()!;
        if (ev.kind === "magOut") {
          effects.playMagOutSound();
        } else if (ev.kind === "magIn") {
          // One-piece mag swap: the whole load arrives at once
          const rounds = Math.min(this.config.magSize - this.clipAmmo, this.reserveAmmo);
          this.clipAmmo += rounds;
          this.reserveAmmo -= rounds;
          effects.playMagInSound();
        } else {
          this.slideLocked = false; // slide slams forward, chambering a round
          effects.playSlideReleaseSound();
        }
      }

      if (this.timer <= 0) {
        this.reloadEvents = [];
        this.state = this.clipAmmo === 0 ? "empty" : "idle";
      }
    }

    // 4. Fire / reload input — semi-auto: one shot per click
    const canUseTrigger = (this.state === "idle" || this.state === "empty") && inputEnabled;
    if (canUseTrigger && this.state === "empty" && this.clipAmmo === 0 && this.reserveAmmo > 0) {
      this.startReload();
      return;
    }
    if (canUseTrigger && input.isMouseButtonPressed(0)) {
      if (this.clipAmmo > 0 && this.fireCooldown <= 0) {
        this.fire(scene, cameraRig, effects);
      } else if (this.clipAmmo === 0) {
        if (this.reserveAmmo > 0) {
          this.startReload();
        } else {
          effects.playDryFireSound();
        }
      }
    }

    if (
      canUseTrigger &&
      input.isKeyPressed("KeyR") &&
      this.clipAmmo < this.config.magSize &&
      this.reserveAmmo > 0
    ) {
      this.startReload();
    }
  }

  public cancelReload(): void {
    if (this.state !== "reloading") return;
    this.reloadEvents = [];
    this.timer = 0;
    this.state = this.clipAmmo === 0 ? "empty" : "idle";
    // Holstered after the fresh mag seated but before the slide-release
    // event: the gun comes back up chambered, not pinned open over a full mag
    if (this.clipAmmo > 0) this.slideLocked = false;
  }

  // Respawn refill bypasses the reload timeline, so release the slide here
  public onRefill(): void {
    this.slideLocked = false;
  }

  private fire(scene: Scene, cameraRig: CameraRig, effects: Effects): void {
    this.clipAmmo--;
    this.fireCooldown = this.config.fireInterval;
    this.slideLocked = false; // firing cycles the slide — it can't stay pinned
    this.slideKick = 1;
    if (this.clipAmmo === 0) {
      this.slideLocked = true; // slide locks open on the empty mag
      this.state = "empty";
    }

    const recoilSettings = this.isAiming ? this.config.recoilAds : this.config.recoilHip;
    this.visualKickZ = recoilSettings.kickBack;

    effects.playPistolShootSound();

    // Hitscan from the camera center — identical model to the rifle
    const camera = cameraRig.camera;
    const origin = camera.globalPosition.clone();
    const forward = camera.getDirection(Vector3.Forward());
    const right = camera.getDirection(Vector3.Right());
    const up = camera.getDirection(Vector3.Up());

    // Muzzle flash at the pistol's muzzle; converges to center as ADS completes
    const adsProgress = this.adsAnimator.getProgress();
    const hipOffset = 1 - adsProgress;
    const flashPos = origin
      .add(forward.scale(0.6))
      .addInPlace(right.scale(0.085 * hipOffset))
      .addInPlace(up.scale(-0.11 * hipOffset));
    effects.createMuzzleFlash(flashPos, 0.7); // shorter barrel, smaller bloom

    fireHitscanRay(scene, camera, effects, origin, forward, right, up, this.config.adsSpread, adsProgress, this.config.damage);

    cameraRig.applyRecoil(recoilSettings.pitch, recoilSettings.yaw, recoilSettings.kickBack);

    if (this.clipAmmo === 0 && this.reserveAmmo > 0) {
      this.startReload();
    }
  }

  private startReload(): void {
    if (this.reserveAmmo <= 0 || this.clipAmmo === this.config.magSize) return;

    this.state = "reloading";
    this.reloadTotal = Pistol.RELOAD_TOTAL;
    this.timer = this.reloadTotal;

    this.reloadEvents = [
      { time: Pistol.MAG_OUT_AT, kind: "magOut" },
      { time: Pistol.MAG_IN_AT, kind: "magIn" },
    ];
    if (this.slideLocked) {
      this.reloadEvents.push({ time: Pistol.SLIDE_RELEASE_AT, kind: "slideRelease" });
    }
  }
}
