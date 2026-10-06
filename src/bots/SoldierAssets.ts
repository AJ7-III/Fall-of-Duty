import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF/2.0/glTFLoader";
import type { AssetContainer, Scene } from "@babylonjs/core";
import { assetUrl } from "../assets/paths";

interface Entry {
  container: AssetContainer | null;
  waiters: Array<(container: AssetContainer) => void>;
  ready: Promise<void>;
}

// Weak scene keys prevent an abandoned game from retaining its model. Preview
// scenes can coexist with the main scene without replacing its pending load.
const entries = new WeakMap<Scene, Entry>();

export function preloadSoldierModel(scene: Scene): Promise<void> {
  const existing = entries.get(scene);
  if (existing) return existing.ready;
  const entry: Entry = { container: null, waiters: [], ready: Promise.resolve() };
  entries.set(scene, entry);
  scene.onDisposeObservable.addOnce(() => {
    entries.delete(scene);
    entry.waiters.length = 0;
    entry.container?.dispose();
    entry.container = null;
  });
  entry.ready = LoadAssetContainerAsync(assetUrl("models/soldier.glb"), scene).then((container) => {
    if (scene.isDisposed) {
      container.dispose();
      return;
    }
    entry.container = container;
    for (const waiter of entry.waiters) waiter(container);
    entry.waiters.length = 0;
  });
  return entry.ready;
}

export function whenSoldierModelReady(scene: Scene, callback: (container: AssetContainer) => void): void {
  const entry = entries.get(scene);
  if (!entry || scene.isDisposed) return;
  if (entry.container) callback(entry.container);
  else entry.waiters.push(callback);
}
