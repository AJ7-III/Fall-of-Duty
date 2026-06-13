export class Time {
  public deltaTime: number = 0;
  public elapsedTime: number = 0;
  public fps: number = 0;

  private lastTime: number = 0;
  private fpsFrameCount: number = 0;
  private fpsAccumulator: number = 0;

  constructor() {
    this.lastTime = performance.now();
  }

  public update(): void {
    const now = performance.now();
    // Delta time in seconds
    let rawDelta = (now - this.lastTime) / 1000.0;
    this.lastTime = now;

    // Clamp delta time to avoid physics/logic explosions during lag spikes (e.g., max 100ms per frame)
    this.deltaTime = Math.min(rawDelta, 0.1);
    this.elapsedTime += this.deltaTime;

    // Calculate FPS
    this.fpsFrameCount++;
    this.fpsAccumulator += rawDelta;
    if (this.fpsAccumulator >= 1.0) {
      this.fps = Math.round(this.fpsFrameCount / this.fpsAccumulator);
      this.fpsFrameCount = 0;
      this.fpsAccumulator = 0;
    }
  }
}
