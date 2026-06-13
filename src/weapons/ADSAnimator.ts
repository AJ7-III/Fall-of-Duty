import type { ADSAnimationData, ADSFrame } from "./WeaponTypes";

export class ADSAnimator {
  private frames: ADSFrame[];
  private maxFrame: number;

  public currentFrame: number = 0; // floating point frame index [0, maxFrame]

  // Reused state object: getInterpolatedState() is read by several systems
  // every frame, so it must not allocate per call.
  private cachedState: ADSFrame;

  constructor(animationData: ADSAnimationData) {
    this.frames = animationData.frames;
    this.maxFrame = this.frames.length - 1;

    const f0 = this.frames[0];
    this.cachedState = {
      frame: 0,
      position: [f0.position[0], f0.position[1], f0.position[2]],
      rotation: [f0.rotation[0], f0.rotation[1], f0.rotation[2]],
      fov: f0.fov,
      scopeOpacity: f0.scopeOpacity,
      sensitivityMultiplier: f0.sensitivityMultiplier,
      vignetteOpacity: f0.vignetteOpacity,
    };
  }

  public update(deltaTime: number, isAiming: boolean, canAds: boolean): void {
    // Stepping speed: fixed at 60 fps
    const frameSpeed = 60; // frames per second
    const deltaFrames = deltaTime * frameSpeed;

    if (isAiming && canAds) {
      this.currentFrame = Math.min(this.maxFrame, this.currentFrame + deltaFrames);
    } else {
      this.currentFrame = Math.max(0, this.currentFrame - deltaFrames);
    }

    this.writeInterpolatedState();
  }

  public getProgress(): number {
    return this.currentFrame / this.maxFrame;
  }

  public getInterpolatedState(): ADSFrame {
    return this.cachedState;
  }

  private writeInterpolatedState(): void {
    const floorIndex = Math.floor(this.currentFrame);
    const ceilIndex = Math.min(this.maxFrame, Math.ceil(this.currentFrame));

    const f0 = this.frames[floorIndex];
    const f1 = this.frames[ceilIndex];
    const t = floorIndex === ceilIndex ? 0 : this.currentFrame - floorIndex;

    // Linearly interpolate each property between the two discrete frames
    const s = this.cachedState;
    s.frame = this.currentFrame;
    s.position[0] = f0.position[0] + (f1.position[0] - f0.position[0]) * t;
    s.position[1] = f0.position[1] + (f1.position[1] - f0.position[1]) * t;
    s.position[2] = f0.position[2] + (f1.position[2] - f0.position[2]) * t;
    s.rotation[0] = f0.rotation[0] + (f1.rotation[0] - f0.rotation[0]) * t;
    s.rotation[1] = f0.rotation[1] + (f1.rotation[1] - f0.rotation[1]) * t;
    s.rotation[2] = f0.rotation[2] + (f1.rotation[2] - f0.rotation[2]) * t;
    s.fov = f0.fov + (f1.fov - f0.fov) * t;
    s.scopeOpacity = f0.scopeOpacity + (f1.scopeOpacity - f0.scopeOpacity) * t;
    s.sensitivityMultiplier = f0.sensitivityMultiplier + (f1.sensitivityMultiplier - f0.sensitivityMultiplier) * t;
    s.vignetteOpacity = f0.vignetteOpacity + (f1.vignetteOpacity - f0.vignetteOpacity) * t;
  }
}
