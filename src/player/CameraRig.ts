import { Scene, FreeCamera, Vector3 } from "@babylonjs/core";

export class CameraRig {
  public camera: FreeCamera;
  
  // Recoil offsets
  public recoilPitch: number = 0;
  public recoilYaw: number = 0;
  public recoilKickback: number = 0;

  // Settle/Recovery speeds (spring-like Fall of Duty feel)
  private recoilRecoverySpeed: number = 10; // rate of recovery
  
  // Sway parameters (idle breathing sway)
  private swayTime: number = 0;
  public swayOffset: Vector3 = new Vector3();

  // Scoped figure-eight sway (slow Lissajous drift while fully ADS, affects aim)
  private scopeSwayTime: number = 0;
  public scopeSwayYaw: number = 0;
  public scopeSwayPitch: number = 0;

  // Bob parameters (walking bobbing)
  private bobTime: number = 0;
  public bobOffset: Vector3 = new Vector3();

  constructor(scene: Scene) {
    // Create the primary FPS camera
    this.camera = new FreeCamera("fpsCamera", new Vector3(0, 1.7, 0), scene);
    this.camera.minZ = 0.01; // Allow very close meshes (weapon viewmodel)
    this.camera.maxZ = 1000;
    
    // Disable Babylon default controls since we control it manually
    this.camera.inputs.clear();
  }

  // pitch/yaw are in degrees (weapon config units); kickback is meters
  public applyRecoil(pitchDegrees: number, yawDegrees: number, kickback: number): void {
    this.recoilPitch += (pitchDegrees * Math.PI) / 180;
    // Small random yaw direction kick
    this.recoilYaw += ((Math.random() - 0.5) * yawDegrees * Math.PI) / 180;
    this.recoilKickback += kickback;
  }

  public update(deltaTime: number, isMoving: boolean, moveSpeedRatio: number, adsProgress: number): void {
    const isAds = adsProgress > 0.6;

    // Settle/Recover recoil over time using robust exponential decay
    const decay = Math.exp(-this.recoilRecoverySpeed * deltaTime);
    this.recoilPitch *= decay;
    this.recoilYaw *= decay;
    this.recoilKickback *= Math.exp(-this.recoilRecoverySpeed * 1.5 * deltaTime);

    // Scoped figure-eight sway: yaw = sin(t), pitch = sin(2t) traces a slow ∞.
    // Amplitude eases in with ADS progress so the transition is seamless.
    this.scopeSwayTime += deltaTime * 0.85; // ~7.4s per full figure-eight
    const swayEase = adsProgress * adsProgress * (3 - 2 * adsProgress);
    const swayAmp = 0.0026 * swayEase; // ~0.15° at full scope — slight
    this.scopeSwayYaw = Math.sin(this.scopeSwayTime) * swayAmp;
    this.scopeSwayPitch = Math.sin(this.scopeSwayTime * 2) * swayAmp * 0.55;

    // 1. Idle Sway (breathing)
    // Reduce sway heavily when ADS (aiming down sight)
    const swayScale = isAds ? 0.05 : 0.2;
    this.swayTime += deltaTime * (isAds ? 1.0 : 1.5);
    
    this.swayOffset.x = Math.sin(this.swayTime * 1.2) * 0.015 * swayScale;
    this.swayOffset.y = Math.cos(this.swayTime * 0.8) * 0.02 * swayScale;
    this.swayOffset.z = 0;

    // 2. Walking Bob
    if (isMoving && !isAds) {
      // Speed up bob depending on how fast we walk; heavier footfalls at sprint
      // speed, gentler while crouched (1.0 at walk speed)
      this.bobTime += deltaTime * 12 * moveSpeedRatio;
      const bobAmp = 0.5 + 0.5 * moveSpeedRatio;
      this.bobOffset.x = Math.sin(this.bobTime * 0.5) * 0.025 * bobAmp;
      this.bobOffset.y = Math.abs(Math.sin(this.bobTime)) * 0.035 * bobAmp;
    } else {
      // Return bob back to zero slowly
      this.bobTime = 0;
      const bobDecay = Math.exp(-10 * deltaTime);
      this.bobOffset.x *= bobDecay;
      this.bobOffset.y *= bobDecay;
    }
  }

  public setFov(fovInDegrees: number): void {
    // Babylon camera FOV is in radians, so convert from degrees
    this.camera.fov = (fovInDegrees * Math.PI) / 180;
  }
}
