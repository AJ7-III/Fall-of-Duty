import { Observable } from "@babylonjs/core";
import type { AbstractMesh } from "@babylonjs/core";

// Registry of the meshes that move and should throw real shadows when the
// quality tier allows it: the soldiers' skinned bodies (bots and the
// player's corpse). Bodies land asynchronously after the glTF loads, so
// they announce themselves here and the map, which owns the shadow map,
// subscribes. Keeps SoldierBody free of any knowledge of the map.

const casters: AbstractMesh[] = [];
export const onDynamicCasterAdded = new Observable<AbstractMesh>();

export function registerDynamicShadowCaster(mesh: AbstractMesh): void {
  casters.push(mesh);
  mesh.onDisposeObservable.addOnce(() => {
    const i = casters.indexOf(mesh);
    if (i >= 0) casters.splice(i, 1);
  });
  onDynamicCasterAdded.notifyObservers(mesh);
}

export function dynamicShadowCasters(): ReadonlyArray<AbstractMesh> {
  return casters;
}

export function resetDynamicShadowCasters(): void {
  casters.length = 0;
  onDynamicCasterAdded.clear();
}
