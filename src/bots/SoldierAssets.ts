import { LoadAssetContainerAsync } from "@babylonjs/core";
import "@babylonjs/loaders/glTF/2.0";
import type { AssetContainer, Scene } from "@babylonjs/core";

// One shared rigged-soldier asset (Mixamo "Vanguard" body, 49-joint rig,
// Idle/Walk/Run clips baked in) loaded once per scene; every SoldierBody
// clones its skeleton out of this container. The load is async — bodies are
// built headless (hitboxes, rifle, proxies) and grow their skin the moment
// the container lands, so Game's synchronous constructor chain never waits.

interface Entry {
  scene: Scene;
  container: AssetContainer | null;
  waiters: Array<(c: AssetContainer) => void>;
}

let entry: Entry | null = null;

export function preloadSoldierModel(scene: Scene): void {
  const e: Entry = { scene, container: null, waiters: [] };
  entry = e;
  LoadAssetContainerAsync("/models/soldier.glb", scene)
    .then((container) => {
      if (entry !== e || scene.isDisposed) return;
      e.container = container;
      for (const w of e.waiters) w(container);
      e.waiters.length = 0;
    })
    .catch((err) => {
      // headless soldiers still play (hitboxes + rifles work) — log loudly
      console.error("Soldier model failed to load:", err);
    });
}

export function whenSoldierModelReady(scene: Scene, cb: (c: AssetContainer) => void): void {
  if (!entry || entry.scene !== scene) return; // preload never kicked off
  if (entry.container) cb(entry.container);
  else entry.waiters.push(cb);
}
