import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/loaders/glTF/2.0/glTFLoader";
import { assetUrl } from "../assets/paths";
import { soldierMaterialFor } from "../bots/SoldierBody";
import type { GraphicsQuality } from "./Settings";

export class StartCharacterPreview {
  private canvas: HTMLCanvasElement | null;
  private engine: Engine | null = null;
  private scene: Scene | null = null;
  private modelRoot: TransformNode | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private loadStarted = false;
  private running = false;
  private disposed = false;
  private visible = false;
  private quality: GraphicsQuality = "high";

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  public start(): void {
    this.visible = true;
    this.syncLoop();
  }

  public setQuality(quality: GraphicsQuality): void {
    this.quality = quality;
    if (this.engine) this.engine.maxFPS = quality === "performance" ? 15 : 30;
  }

  private onVisibilityChange = (): void => this.syncLoop();

  private syncLoop(): void {
    if (!this.visible || document.hidden || this.disposed) {
      this.engine?.stopRenderLoop();
      this.running = false;
      return;
    }
    if (!this.canvas || this.disposed) return;
    this.ensureScene();
    if (!this.engine || !this.scene || this.running) return;
    this.running = true;
    this.engine.performanceMonitor.reset();
    this.engine.runRenderLoop(() => {
      if (!this.scene || this.scene.isDisposed) return;
      if (this.modelRoot) this.modelRoot.rotation.y += Math.min(this.scene.getEngine().getDeltaTime(), 100) * 0.00018;
      this.scene.render();
    });
  }

  public stop(): void {
    this.visible = false;
    this.syncLoop();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.resizeObserver?.disconnect();
    this.scene?.dispose();
    this.engine?.dispose();
    this.resizeObserver = null;
    this.scene = null;
    this.engine = null;
    this.modelRoot = null;
  }

  private ensureScene(): void {
    if (!this.canvas || this.engine || this.scene) return;

    this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: false });
    this.engine.renderEvenInBackground = false;
    this.engine.maxFPS = this.quality === "performance" ? 15 : 30;
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);

    const camera = new ArcRotateCamera("startPreviewCamera", Math.PI / 2, 1.18, 3.7, new Vector3(0, 1.02, 0), this.scene);
    camera.fov = 0.58;
    camera.minZ = 0.05;
    camera.maxZ = 30;

    const hemi = new HemisphericLight("startPreviewHemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.72;
    hemi.diffuse = new Color3(0.76, 0.82, 0.88);
    hemi.groundColor = new Color3(0.14, 0.13, 0.1);

    const key = new DirectionalLight("startPreviewKey", new Vector3(-0.5, -0.8, -0.35), this.scene);
    key.position.set(2.5, 4.5, 2.8);
    key.intensity = 1.45;
    key.diffuse = new Color3(1, 0.86, 0.62);

    const rim = new DirectionalLight("startPreviewRim", new Vector3(0.45, -0.2, 0.9), this.scene);
    rim.position.set(-3, 2.3, -3);
    rim.intensity = 0.75;
    rim.diffuse = new Color3(0.36, 0.95, 0.72);

    this.resizeObserver = new ResizeObserver(() => this.engine?.resize());
    this.resizeObserver.observe(this.canvas);

    this.loadSoldier();
  }

  private loadSoldier(): void {
    if (!this.scene || this.loadStarted) return;
    this.loadStarted = true;

    LoadAssetContainerAsync(assetUrl("models/soldier.glb"), this.scene)
      .then((container) => {
        if (!this.scene || this.scene.isDisposed || this.disposed) {
          container.dispose();
          return;
        }

        container.addAllToScene();
        const root = new TransformNode("startPreviewOperator", this.scene);
        for (const mesh of container.meshes) {
          mesh.isPickable = false;
          if (!mesh.parent) mesh.parent = root;
          // the operator wears exactly what the in-match body and arms wear
          if (mesh.material) {
            mesh.material = soldierMaterialFor(this.scene, "player", mesh.name.toLowerCase().includes("visor"), mesh.material);
          }
        }

        const bounds = root.getHierarchyBoundingVectors(true);
        const center = bounds.min.add(bounds.max).scale(0.5);
        const height = Math.max(0.01, bounds.max.y - bounds.min.y);
        const scale = 1.86 / height;
        root.scaling.setAll(scale);
        root.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
        root.rotation.y = Math.PI * 0.92;
        this.modelRoot = root;

        const idle = container.animationGroups.find((group) => /idle/i.test(group.name)) ?? container.animationGroups[0];
        idle?.start(true, 0.82);
      })
      .catch((err) => {
        console.error("Start screen soldier preview failed to load:", err);
      });
  }
}
