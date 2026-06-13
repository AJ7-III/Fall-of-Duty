import { Scene } from "@babylonjs/core";
import { Input } from "../engine/Input";
import { CameraRig } from "../player/CameraRig";
import { PlayerController } from "../player/PlayerController";
import { BoltActionSniper } from "./BoltActionSniper";
import { Mp44 } from "./Mp44";
import { Pistol } from "./Pistol";
import type { Weapon } from "./WeaponTypes";
import { AssetLoader } from "../engine/AssetLoader";
import { Effects } from "../rendering/Effects";

type SwitchPhase = "none" | "lower" | "raise";

export class WeaponManager {
  // X-key swap timing: drop the current weapon, swap meshes at the bottom,
  // raise the next one (Fall of Duty quick draw)
  private static readonly LOWER_TIME = 0.22;
  private static readonly RAISE_TIME = 0.3;

  private weapons: Weapon[];
  private activeIndex: number = 0;

  private switchPhase: SwitchPhase = "none";
  private switchTimer: number = 0;

  // True on any frame the player discharged a round — the bots' hearing.
  // Detected by watching the active clip drain (reloads only ever refill it),
  // so no weapon has to report anything.
  public firedThisFrame: boolean = false;

  constructor(loader: AssetLoader) {
    // MP44 first: the automatic rifle is the base loadout; X cycles to the
    // bolt rifle, then the sidearm
    this.weapons = [new Mp44(loader), new BoltActionSniper(loader), new Pistol(loader)];
  }

  public update(
    deltaTime: number,
    input: Input,
    playerController: PlayerController,
    cameraRig: CameraRig,
    scene: Scene,
    effects: Effects,
    allowInput: boolean = true // false while the killstreak laptop is out — LMB marks, never fires
  ): void {
    // Start a swap: X is accepted any time we're not already mid-swap.
    // A reload in progress is abandoned (rounds already loaded are kept).
    // The dead don't handle weapons — no swap, no trigger, no reload start;
    // timers below still tick so an in-flight animation settles.
    const alive = !playerController.isDead;
    if (allowInput && alive && this.switchPhase === "none" && input.isKeyPressed("KeyX")) {
      this.switchPhase = "lower";
      this.switchTimer = 0;
      this.getActiveWeapon().cancelReload();
      effects.playWeaponSwitchSound();
    }

    if (this.switchPhase === "lower") {
      this.switchTimer += deltaTime;
      if (this.switchTimer >= WeaponManager.LOWER_TIME) {
        // Bottom of the arc — this is where the hands actually trade weapons
        this.activeIndex = (this.activeIndex + 1) % this.weapons.length;
        this.switchPhase = "raise";
        this.switchTimer = 0;
      }
    } else if (this.switchPhase === "raise") {
      this.switchTimer += deltaTime;
      if (this.switchTimer >= WeaponManager.RAISE_TIME) {
        this.switchPhase = "none";
      }
    }

    // While swapping (or dead, or marking an airstrike), the active weapon
    // ignores trigger/ADS/reload input
    const inputEnabled = this.switchPhase === "none" && alive && allowInput;
    const active = this.getActiveWeapon();
    const prevClip = active.clipAmmo;
    active.update(
      deltaTime,
      input,
      playerController,
      cameraRig,
      scene,
      effects,
      inputEnabled
    );
    this.firedThisFrame = active.clipAmmo < prevClip;
  }

  // Player respawn: Fall of Duty hands you a fresh loadout
  public refillAll(): void {
    for (const weapon of this.weapons) {
      weapon.cancelReload();
      weapon.clipAmmo = weapon.config.magSize;
      weapon.reserveAmmo = weapon.config.maxReserveAmmo;
      weapon.state = "idle";
      weapon.onRefill?.();
    }
  }

  // Fresh match: full mags AND back to the base MP44 in hand
  public resetLoadout(): void {
    this.refillAll();
    this.activeIndex = 0;
    this.switchPhase = "none";
    this.switchTimer = 0;
  }

  public getActiveWeapon(): Weapon {
    return this.weapons[this.activeIndex];
  }

  // 0 = fully raised, 1 = fully lowered — ViewModelRig drops the viewmodel by this
  public getLowerAmount(): number {
    if (this.switchPhase === "lower") {
      return Math.min(1, this.switchTimer / WeaponManager.LOWER_TIME);
    }
    if (this.switchPhase === "raise") {
      return Math.max(0, 1 - this.switchTimer / WeaponManager.RAISE_TIME);
    }
    return 0;
  }
}
