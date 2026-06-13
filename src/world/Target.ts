import { Scene, Mesh, MeshBuilder, Vector3, Vector2, DynamicTexture } from "@babylonjs/core";
import { AssetLoader } from "../engine/AssetLoader";

export class Target {
  public mesh: Mesh;

  // Each target owns its board texture so bullet holes can be painted
  // straight into the paper at the hit UV: permanent, rides the board when
  // it tips, and costs nothing per frame (one canvas draw + texture upload
  // at the moment of impact).
  private boardTex: DynamicTexture | null = null;

  private isHit: boolean = false;
  private rotationAngle: number = 0; // current tip angle (radians)
  private targetRotationAngle: number = 0; // target tip angle (radians)
  private resetTimer: number = 0;
  private resetDelay: number = 2.0; // reset target after 2 seconds

  constructor(position: Vector3, scene: Scene, loader: AssetLoader) {
    // Create target group/root
    this.mesh = new Mesh("target_root", scene);
    this.mesh.position.copyFrom(position);

    // Target Stand/Post (ground to target base)
    const post = MeshBuilder.CreateCylinder("target_post", { height: 1.2, diameter: 0.05, tessellation: 8 }, scene);
    post.material = loader.createMetalMaterial(scene);
    post.position.set(0, -0.6, 0);
    post.parent = this.mesh;

    // Printed paper bullseye board — per-target material instance so this
    // board's holes don't appear on every other target
    const board = MeshBuilder.CreateBox("target_board", { width: 0.8, height: 1.0, depth: 0.03 }, scene);
    const boardMat = loader.createTargetBoardMaterial(scene);
    board.material = boardMat;
    this.boardTex = boardMat.diffuseTexture as DynamicTexture;
    board.position.set(0, 0.4, 0);
    board.parent = this.mesh;

    // Register this Target in the root mesh metadata for easy raycast identification
    this.mesh.metadata = { type: "target", instance: this };
    board.metadata = { type: "target", instance: this };
  }

  // Whether the target is currently tipped over (used by the minimap blips)
  public get isDown(): boolean {
    return this.isHit;
  }

  // Whether the board is mid-tip — the frozen shadow map only re-renders
  // while some target is actually moving
  public get isAnimating(): boolean {
    return Math.abs(this.rotationAngle - this.targetRotationAngle) > 0.002;
  }

  public hit(uv: Vector2 | null = null): void {
    // Paint the bullet hole even if the board is already tipping — paper
    // accumulates holes no matter the pose
    if (uv) {
      this.paintHole(uv.x, uv.y);
    }

    if (this.isHit) return;

    this.isHit = true;
    this.targetRotationAngle = Math.PI / 2; // Tip 90 degrees backwards
    this.resetTimer = this.resetDelay;
  }

  // Punch a permanent hole into the printed paper at the given UV
  private paintHole(u: number, v: number): void {
    if (!this.boardTex) return;

    const size = this.boardTex.getSize().width;
    const ctx = this.boardTex.getContext() as CanvasRenderingContext2D;
    const x = u * size;
    const y = (1 - v) * size; // canvas y runs down, UV v runs up

    // torn paper rim
    ctx.fillStyle = "rgba(196,186,158,0.9)";
    ctx.beginPath();
    ctx.arc(x, y, 4.6, 0, Math.PI * 2);
    ctx.fill();
    // ragged tears around the rim
    ctx.fillStyle = "rgba(120,110,88,0.55)";
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * 3.4, y + Math.sin(a) * 3.4, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // dark puncture
    ctx.fillStyle = "#171310";
    ctx.beginPath();
    ctx.arc(x, y, 3.0, 0, Math.PI * 2);
    ctx.fill();

    this.boardTex.update();
  }

  public update(deltaTime: number): void {
    // Smoothly tip over using robust exponential decay
    if (this.rotationAngle !== this.targetRotationAngle) {
      const tipFactor = 1 - Math.exp(-12 * deltaTime);
      this.rotationAngle += (this.targetRotationAngle - this.rotationAngle) * tipFactor;

      // Rotate around the bottom of the target board (y = 0 relative to root)
      this.mesh.rotation.x = this.rotationAngle;
    }

    // Reset countdown
    if (this.isHit) {
      this.resetTimer -= deltaTime;
      if (this.resetTimer <= 0) {
        this.reset();
      }
    }
  }

  public reset(): void {
    this.isHit = false;
    this.targetRotationAngle = 0;
  }
}
