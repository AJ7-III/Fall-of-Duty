import { Scene, Vector3 } from "@babylonjs/core";
import { Input } from "../engine/Input";
import { CameraRig } from "../player/CameraRig";
import { ADSAnimator } from "./ADSAnimator";
import { fireHitscanRay } from "./WeaponTypes";
import type { Weapon, WeaponConfig, WeaponState } from "./WeaponTypes";
import { Effects } from "../rendering/Effects";
import { AssetLoader } from "../engine/AssetLoader";

type ReloadEvent = { time: number; kind: "magOut" | "magIn" | "charge" };

// MP44/StG-44-style automatic rifle. It keeps the weapon loop fast and punchy:
// full-auto fire while held, magazine reload, and an empty-mag charging handle.
export class Mp44 implements Weapon {
  public static readonly RELOAD_TOTAL = 1.26;
  public static readonly EMPTY_RELOAD_TOTAL = 1.62;
  public static readonly MAG_OUT_AT = 0.2;
  public static readonly MAG_DOWN_AT = 0.52;
  public static readonly MAG_IN_AT = 0.92;
  public static readonly CHARGE_START_AT = 1.1;
  public static readonly CHARGE_RELEASE_AT = 1.38;

  public readonly id = "mp44" as const;
  public config: WeaponConfig;
  public clipAmmo: number;
  public reserveAmmo: number;

  public state: WeaponState = "idle";
  public timer: number = 0;
  public reloadTotal: number = 0;

  public adsAnimator: ADSAnimator;
  public isAiming: boolean = false;
  public visualKickZ: number = 0;

  private fireCooldown: number = 0;
  private boltKick: number = 0;
  private reloadEvents: ReloadEvent[] = [];
  private reloadStartedEmpty: boolean = false;

  constructor(loader: AssetLoader) {
    this.config = loader.loadMp44Config();
    this.clipAmmo = this.config.magSize;
    this.reserveAmmo = this.config.maxReserveAmmo;
    this.adsAnimator = new ADSAnimator(loader.loadMp44AdsAnimation());
  }

  public getBoltBack(): number {
    return this.boltKick;
  }

  public isEmptyReload(): boolean {
    return this.state === "reloading" && this.reloadStartedEmpty;
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
    const canAds = this.state === "idle" || this.state === "empty";
    this.isAiming =
      inputEnabled && (input.isKeyDown("Space") || input.isMouseButtonDown(2)) && canAds;

    this.adsAnimator.update(deltaTime, this.isAiming, canAds);
    cameraRig.setFov(this.adsAnimator.getInterpolatedState().fov);

    this.visualKickZ *= Math.exp(-18 * deltaTime);
    this.boltKick *= Math.exp(-34 * deltaTime);
    this.fireCooldown -= deltaTime;

    if (this.state === "reloading") {
      this.timer -= deltaTime;
      const elapsed = this.reloadTotal - this.timer;

      while (this.reloadEvents.length > 0 && elapsed >= this.reloadEvents[0].time) {
        const ev = this.reloadEvents.shift()!;
        if (ev.kind === "magOut") {
          effects.playMagOutSound();
        } else if (ev.kind === "magIn") {
          const rounds = Math.min(this.config.magSize - this.clipAmmo, this.reserveAmmo);
          this.clipAmmo += rounds;
          this.reserveAmmo -= rounds;
          effects.playMagInSound();
        } else {
          effects.playBoltCycleSound();
        }
      }

      if (this.timer <= 0) {
        this.reloadEvents = [];
        this.reloadStartedEmpty = false;
        this.state = this.clipAmmo === 0 ? "empty" : "idle";
      }
    }

    const canUseTrigger = (this.state === "idle" || this.state === "empty") && inputEnabled;
    if (canUseTrigger && this.state === "empty" && this.clipAmmo === 0 && this.reserveAmmo > 0) {
      this.startReload();
      return;
    }
    if (canUseTrigger && input.isMouseButtonDown(0)) {
      if (this.clipAmmo > 0 && this.fireCooldown <= 0) {
        this.fire(scene, cameraRig, effects);
      } else if (this.clipAmmo === 0 && input.isMouseButtonPressed(0)) {
        if (this.reserveAmmo > 0) {
          this.startReload();
        } else {
          effects.playDryFireSound();
          this.fireCooldown = 0.2;
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
    this.reloadStartedEmpty = false;
    this.timer = 0;
    this.state = this.clipAmmo === 0 ? "empty" : "idle";
  }

  private fire(scene: Scene, cameraRig: CameraRig, effects: Effects): void {
    this.clipAmmo--;
    this.fireCooldown = this.config.fireInterval;
    this.boltKick = 1;
    if (this.clipAmmo === 0) {
      this.state = "empty";
    }

    const recoilSettings = this.isAiming ? this.config.recoilAds : this.config.recoilHip;
    this.visualKickZ = recoilSettings.kickBack;

    effects.playMp44ShootSound();

    const camera = cameraRig.camera;
    const origin = camera.globalPosition.clone();
    const forward = camera.getDirection(Vector3.Forward());
    const right = camera.getDirection(Vector3.Right());
    const up = camera.getDirection(Vector3.Up());

    const adsProgress = this.adsAnimator.getProgress();
    const hipOffset = 1 - adsProgress;
    // At full ADS the muzzle sits 0.05 below the sight line (barrel y=0.121
    // vs sight axis y=0.17); track it so the flash blooms off the barrel,
    // not over the sight picture, and shrink it so the post stays readable.
    const flashPos = origin
      .add(forward.scale(0.86))
      .addInPlace(right.scale(0.06 * hipOffset))
      .addInPlace(up.scale(-0.1 * hipOffset - 0.05 * adsProgress));
    effects.createMuzzleFlash(flashPos, 0.92 - 0.34 * adsProgress);

    fireHitscanRay(scene, camera, effects, origin, forward, right, up, this.config.adsSpread, adsProgress, this.config.damage);

    cameraRig.applyRecoil(recoilSettings.pitch, recoilSettings.yaw, recoilSettings.kickBack);

    if (this.clipAmmo === 0 && this.reserveAmmo > 0) {
      this.startReload();
    }
  }

  private startReload(): void {
    if (this.reserveAmmo <= 0 || this.clipAmmo === this.config.magSize) return;

    this.reloadStartedEmpty = this.clipAmmo === 0;
    this.reloadTotal = this.reloadStartedEmpty ? Mp44.EMPTY_RELOAD_TOTAL : Mp44.RELOAD_TOTAL;
    this.state = "reloading";
    this.timer = this.reloadTotal;

    this.reloadEvents = [
      { time: Mp44.MAG_OUT_AT, kind: "magOut" },
      { time: Mp44.MAG_IN_AT, kind: "magIn" },
    ];
    if (this.reloadStartedEmpty) {
      this.reloadEvents.push({ time: Mp44.CHARGE_START_AT, kind: "charge" });
    }
  }
}
