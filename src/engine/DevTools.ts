import {
  Color3,
  DynamicTexture,
  EngineInstrumentation,
  Matrix,
  MeshBuilder,
  PBRMaterial,
  SceneInstrumentation,
  StandardMaterial,
  Vector3,
  Vector4,
} from "@babylonjs/core";
import type { Scene, TransformNode } from "@babylonjs/core";
import type { Game } from "./Game";
import type { WeaponId } from "../weapons/WeaponTypes";
import type { HandPose } from "../viewmodels/kit";
import type { ArmsTuning } from "../viewmodels/ArmsRig";

// Console tooling for development builds only (main.ts installs it under
// import.meta.env.DEV). Everything hangs off `window.fod`:
//
//   fod.game                the live Game instance
//   fod.freeze()            stop the render loop; drive frames by hand
//   fod.step(n, dt)         advance n frames of dt seconds (default 3 @ 1/60)
//   fod.shot(name)          save a full-res PNG of one frame to ./.screenshots
//   fod.weapon(id)          switch the player's weapon ("mp44" | "m40a3" | "usp45")
//   fod.arms(patch)         tweak the first-person arm rig tuning live
//   fod.pose(id, side, p)   tweak a weapon's hand pose live
//   fod.teleport(x, z, yaw) move the player
//   fod.kill()              kill the player (plays the death cam)
//   fod.slowmo(factor)      time scale for the live loop
//   fod.perf(frames)        step N frames and report CPU/GPU frame time + draw calls
//   fod.lib                 a few Babylon classes for console experiments
//   fod.inspect(yaw, pitch, focus, center)  orbit the whole first-person rig
//                           around a camera-space point (default: the weapon)
//                           to see the hands from another angle, optionally
//                           bringing that point to the screen centre;
//                           inspect() resets
//
// These exist so animation, arm poses and bot behaviour can be inspected
// frame by frame without a pointer lock — the same hooks the automated
// screenshot checks use.

export interface DevApi {
  game: Game;
  lib: {
    MeshBuilder: typeof MeshBuilder;
    Vector3: typeof Vector3;
    Vector4: typeof Vector4;
    Color3: typeof Color3;
    DynamicTexture: typeof DynamicTexture;
    StandardMaterial: typeof StandardMaterial;
    PBRMaterial: typeof PBRMaterial;
  };
  freeze(): void;
  resume(): void;
  step(frames?: number, dt?: number): string;
  shot(name: string): Promise<string>;
  weapon(id: WeaponId): string;
  arms(patch: Partial<ArmsTuning>): ArmsTuning;
  pose(id: WeaponId, side: "left" | "right", patch: Partial<HandPose> & { curl?: Partial<HandPose["curl"]> }): HandPose;
  teleport(x: number, z: number, yaw?: number, pitch?: number): void;
  kill(): void;
  slowmo(factor: number): void;
  inspect(yaw?: number, pitch?: number, focus?: [number, number, number], center?: boolean): void;
  perf(frames?: number): Promise<{ cpuMs: number; gpuMs: number; drawCalls: number; activeMeshes: number; fpsEstimate: number }>;
}

export function installDevTools(game: Game): DevApi {
  const g = game as unknown as {
    engine: { stopRenderLoop(): void };
    startLoop(): void;
    startMatch(): void;
    matchState: string;
    weaponManager: { activeIndex: number; getActiveWeapon(): { id: string } };
    viewModelRig: {
      arms: { tuning: ArmsTuning };
      models: Record<WeaponId, { hands: Record<"left" | "right", { pose: HandPose }> }>;
      pivot: TransformNode;
    };
    player: {
      position: { set(x: number, y: number, z: number): void };
      yaw: number;
      pitch: number;
      invulnUntil: number;
      takeDamage(a: number, from: unknown): void;
    };
    time: { scale: number };
    scene: Scene;
  };
  const ORDER: WeaponId[] = ["mp44", "m40a3", "usp45"];
  const api: DevApi = {
    game,
    lib: { MeshBuilder, Vector3, Vector4, Color3, DynamicTexture, StandardMaterial, PBRMaterial },
    freeze() {
      if (g.matchState === "start") g.startMatch();
      if (document.pointerLockElement) document.exitPointerLock();
      g.engine.stopRenderLoop();
    },
    resume() {
      g.startLoop();
    },
    step(frames = 3, dt = 1 / 60) {
      game.stepFrames(frames, dt);
      return g.matchState;
    },
    async shot(name) {
      // Shaders compile on the GPU process between JS tasks: keep yielding
      // and stepping until every visible mesh is ready, so a capture taken
      // right after a state change never lands on a half-compiled frame
      const scene = g.scene;
      for (let i = 0; i < 60; i++) {
        game.stepFrames(1, 1 / 60);
        const pending = scene.meshes.some((m) => m.isEnabled() && m.isVisible && !m.isReady(true));
        if (!pending) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      return game.captureFrame(name);
    },
    weapon(id) {
      g.weaponManager.activeIndex = ORDER.indexOf(id);
      game.stepFrames(3, 1 / 60);
      return g.weaponManager.getActiveWeapon().id;
    },
    arms(patch) {
      Object.assign(g.viewModelRig.arms.tuning, patch);
      game.stepFrames(3, 1 / 60);
      return g.viewModelRig.arms.tuning;
    },
    pose(id, side, patch) {
      const pose = g.viewModelRig.models[id].hands[side].pose;
      const { curl, ...rest } = patch;
      Object.assign(pose, rest);
      if (curl) Object.assign(pose.curl, curl as HandPose["curl"]);
      game.stepFrames(3, 1 / 60);
      return pose;
    },
    teleport(x, z, yaw = 0, pitch = 0) {
      g.player.position.set(x, 0, z);
      g.player.yaw = yaw;
      g.player.pitch = pitch;
      game.stepFrames(2, 1 / 60);
    },
    kill() {
      g.player.invulnUntil = 0;
      g.player.takeDamage(1e6, { x: 0, y: 0, z: 0 });
    },
    slowmo(factor) {
      g.time.scale = factor;
    },
    async perf(frames = 120) {
      // GPU timing needs the disjoint timer query extension; when the
      // browser withholds it the gpuMs field stays at 0
      const engineI = new EngineInstrumentation(g.scene.getEngine());
      engineI.captureGPUFrameTime = true;
      const sceneI = new SceneInstrumentation(g.scene);
      sceneI.captureFrameTime = true;
      game.stepFrames(10, 1 / 60); // warm the counters
      await new Promise((r) => setTimeout(r, 50));
      engineI.gpuFrameTimeCounter.fetchNewFrame();
      sceneI.frameTimeCounter.fetchNewFrame();
      const t0 = performance.now();
      game.stepFrames(frames, 1 / 60);
      const cpuMs = (performance.now() - t0) / frames;
      await new Promise((r) => setTimeout(r, 100));
      game.stepFrames(1, 1 / 60);
      const gpuMs = engineI.gpuFrameTimeCounter.average / 1e6;
      const result = {
        cpuMs: +cpuMs.toFixed(2),
        gpuMs: +gpuMs.toFixed(2),
        drawCalls: sceneI.drawCallsCounter.current,
        activeMeshes: g.scene.getActiveMeshes().length,
        fpsEstimate: Math.round(1000 / Math.max(cpuMs, gpuMs, 0.1)),
      };
      engineI.dispose();
      sceneI.dispose();
      return result;
    },
    inspect(yaw = 0, pitch = 0, focus = [0.19, -0.265, 0.55], center = false) {
      const pivot = g.viewModelRig.pivot;
      pivot.rotation.set(pitch, yaw, 0);
      // keep the focus point where it was (or bring it to the screen
      // centre at the same distance): position = C - R * P
      const rot = Matrix.RotationYawPitchRoll(yaw, pitch, 0);
      const p = new Vector3(focus[0], focus[1], focus[2]);
      const c = center ? new Vector3(0, 0, p.length()) : p;
      pivot.position.copyFrom(c.subtract(Vector3.TransformCoordinates(p, rot)));
      game.stepFrames(2, 1 / 60);
    },
  };
  (window as unknown as { fod: DevApi }).fod = api;
  return api;
}
