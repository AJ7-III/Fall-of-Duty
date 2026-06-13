import type { Weapon } from "../weapons/WeaponTypes";
import { Input } from "../engine/Input";
import type { PlayerController } from "../player/PlayerController";

export class Hud {
  private ammoClipEl: HTMLElement | null = null;
  private ammoReserveEl: HTMLElement | null = null;
  private ammoContainerEl: HTMLElement | null = null;
  private promptEl: HTMLElement | null = null;
  private vignetteEl: HTMLElement | null = null;
  private damageDirEl: HTMLElement | null = null;

  // Last values written to the DOM — innerText/classList writes invalidate
  // style/layout even when the value is unchanged, so only write on change
  private lastPrompt: "hidden" | "unlock" | "dead" | null = null;
  private lastClip: number = -1;
  private lastReserve: number = -1;
  private lastWeapon: Weapon | null = null;
  private lastVignette: number = -1;
  private lastDamageDir: number = -1;
  private everLocked = false; // after the first capture, unlocks open the pause menu instead

  constructor(canvas: HTMLCanvasElement) {
    this.ammoClipEl = document.getElementById("ammo-clip");
    this.ammoReserveEl = document.getElementById("ammo-reserve");
    this.ammoContainerEl = document.getElementById("hud-ammo");
    this.promptEl = document.getElementById("hud-prompt");
    this.vignetteEl = document.getElementById("damage-vignette");
    this.damageDirEl = document.getElementById("damage-indicator");

    if (this.promptEl) {
      this.promptEl.innerText = "Click Screen to Capture Mouse";
      this.promptEl.addEventListener("click", () => {
        // Pointer lock can reject during the browser's post-Escape cooldown
        try {
          const result = canvas.requestPointerLock() as unknown;
          if (result instanceof Promise) {
            result.catch(() => {});
          }
        } catch {
          // ignore — clicking again after the cooldown will succeed
        }
      });
    }
  }

  // Pause/end overlays own the screen — drop any center prompt under them
  public hidePrompt(): void {
    this.lastPrompt = "hidden";
    this.promptEl?.classList.add("hidden");
  }

  public update(weapon: Weapon, input: Input, player: PlayerController): void {
    // Weapon swap: force the ammo readout to repaint even if counts match
    if (weapon !== this.lastWeapon) {
      this.lastWeapon = weapon;
      this.lastClip = -1;
      this.lastReserve = -1;
    }

    // 1. Center prompt: the death banner, or the first-ever capture hint.
    // (Later unlocks open the pause menu, so the old "capture mouse" state
    // only exists before the first click.)
    if (input.getIsPointerLocked()) this.everLocked = true;
    const prompt = player.isDead ? "dead" : !input.getIsPointerLocked() && !this.everLocked ? "unlock" : "hidden";
    if (this.promptEl && prompt !== this.lastPrompt) {
      this.lastPrompt = prompt;
      if (prompt === "hidden") {
        this.promptEl.classList.add("hidden");
      } else {
        this.promptEl.classList.remove("hidden");
        this.promptEl.innerText = prompt === "dead" ? "You were killed — respawning" : "Click Screen to Capture Mouse";
      }
    }

    // 1.5 Damage feedback: blood vignette from recent hits and low health
    // (a steady floor below 55hp that regen visibly clears), plus the
    // directional arc pointing at the last shooter, both quantized so a
    // style write only happens when the value moves a visible step
    if (this.vignetteEl) {
      const lowHealth = player.health < 55 ? (1 - player.health / 55) * 0.75 : 0;
      // Dead: just a rim of red — the third-person death cam is the show now,
      // and a full-strength blood wash would drown the whole performance
      const vignette = player.isDead ? 0.22 : Math.min(1, Math.max(player.damageFlash, lowHealth));
      const quantized = Math.round(vignette * 40) / 40;
      if (quantized !== this.lastVignette) {
        this.lastVignette = quantized;
        this.vignetteEl.style.opacity = quantized.toString();
      }
    }
    if (this.damageDirEl) {
      // screen-relative: world direction to the shooter minus where we look
      const strength = player.isDead ? 0 : Math.min(1, player.damageFlash * 1.6);
      const angle = strength > 0.04 ? Math.round(((player.damageFromYaw - player.yaw) * 180) / Math.PI) : 0;
      const quantized = strength > 0.04 ? Math.round(strength * 20) / 20 + angle * 1000 : 0;
      if (quantized !== this.lastDamageDir) {
        this.lastDamageDir = quantized;
        this.damageDirEl.style.opacity = strength > 0.04 ? Math.min(1, strength + 0.15).toString() : "0";
        this.damageDirEl.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
      }
    }

    // 2. Update Ammo Text and CSS styling (only when the count changes)
    if (this.ammoClipEl && this.ammoReserveEl && this.ammoContainerEl) {
      const clip = weapon.clipAmmo;
      const reserve = weapon.reserveAmmo;

      if (clip !== this.lastClip) {
        this.lastClip = clip;
        this.ammoClipEl.innerText = clip.toString();

        // Low/no ammo styling depends only on the clip count
        this.ammoContainerEl.classList.remove("low-ammo", "no-ammo");
        if (clip === 0) {
          this.ammoContainerEl.classList.add("no-ammo");
        } else if (clip === 1) {
          this.ammoContainerEl.classList.add("low-ammo");
        }
      }

      if (reserve !== this.lastReserve) {
        this.lastReserve = reserve;
        this.ammoReserveEl.innerText = reserve.toString();
      }
    }
  }
}
