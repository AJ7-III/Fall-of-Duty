export class Time {
  public deltaTime: number = 0;
  public elapsedTime: number = 0;
  public fps: number = 0;
  public fpsUpdates: number = 0; // bumps every time fps is re-measured (once a second)
  public scale: number = 1; // simulation time scale (slow-motion)

  private lastTime: number = 0;
  private fpsFrameCount: number = 0;
  private fpsAccumulator: number = 0;

  constructor() {
    this.reset();
  }

  // Keep simulation time/slow-motion, but discard time spent in a menu or
  // hidden tab so the first resumed frame and FPS sample cannot jump.
  public reset(): void {
    this.lastTime = performance.now();
    this.deltaTime = 0;
    this.fps = 0;
    this.fpsFrameCount = 0;
    this.fpsAccumulator = 0;
  }

  public update(): void {
    const now = performance.now();
    // Delta time in seconds
    const rawDelta = (now - this.lastTime) / 1000.0;
    this.lastTime = now;

    // Clamp delta time to avoid physics/logic explosions during lag spikes (e.g., max 100ms per frame)
    this.deltaTime = Math.min(rawDelta, 0.1) * this.scale;
    this.elapsedTime += this.deltaTime;

    // Calculate FPS
    this.fpsFrameCount++;
    this.fpsAccumulator += rawDelta;
    if (this.fpsAccumulator >= 1.0) {
      this.fps = Math.round(this.fpsFrameCount / this.fpsAccumulator);
      this.fpsUpdates++;
      this.fpsFrameCount = 0;
      this.fpsAccumulator = 0;
    }
  }
}
