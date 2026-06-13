export class ScopeOverlay {
  private scopeEl: HTMLElement | null = null;
  private vignetteEl: HTMLElement | null = null;
  private crosshairEl: HTMLElement | null = null;

  // Last values written to the DOM — opacity writes trigger style recalcs
  // even when the value is unchanged, and these are stable whenever the ADS
  // animation is at rest (i.e. almost every frame)
  private lastCrosshair: number = -1;
  private lastScope: number = -1;
  private lastVignette: number = -1;
  private scopeHidden: boolean = true;

  constructor() {
    this.scopeEl = document.getElementById("scope-overlay");
    this.crosshairEl = document.getElementById("crosshair");

    // Find vignette element if needed
    if (this.scopeEl) {
      this.vignetteEl = this.scopeEl.querySelector(".scope-vignette") as HTMLElement;
    }
  }

  public update(scopeOpacity: number, vignetteOpacity: number, adsProgress: number): void {
    // Hipfire crosshair fades out as the scope comes up
    if (this.crosshairEl) {
      const crosshair = Math.max(0, 1 - adsProgress * 2);
      if (crosshair !== this.lastCrosshair) {
        this.lastCrosshair = crosshair;
        this.crosshairEl.style.opacity = crosshair.toString();
      }
    }

    if (!this.scopeEl) return;

    if (scopeOpacity > 0.01) {
      if (this.scopeHidden) {
        this.scopeHidden = false;
        this.scopeEl.classList.remove("hidden");
      }
      if (scopeOpacity !== this.lastScope) {
        this.lastScope = scopeOpacity;
        this.scopeEl.style.opacity = scopeOpacity.toString();
      }

      // We can offset or warp the vignette based on breathing/sway if desired,
      // or simply scale its blur/blackness based on vignetteOpacity.
      if (this.vignetteEl && vignetteOpacity !== this.lastVignette) {
        this.lastVignette = vignetteOpacity;
        this.vignetteEl.style.opacity = vignetteOpacity.toString();
      }
    } else if (!this.scopeHidden) {
      this.scopeHidden = true;
      this.scopeEl.classList.add("hidden");
    }
  }
}
