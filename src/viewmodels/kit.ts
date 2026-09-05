import { Mesh, MeshBuilder, Quaternion, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import type { DynamicTexture, Scene } from "@babylonjs/core";
import { frameQuat } from "../anim/boneMath";

// Shared building blocks for the procedural first-person weapons: primitive
// placement, mesh merging, limb capsules, and the hand-anchor contract the
// skinned ArmsRig grips them by.

export type Vec3Tuple = readonly [number, number, number];

// How a hand holds this weapon: where the wrist sits in weapon space, which
// way the knuckles point, which way the palm faces, and how far each finger
// closes (0 = straight, 1 = fully curled).
export interface HandPose {
  wrist: Vec3Tuple;
  knuckles: Vec3Tuple;
  palm: Vec3Tuple;
  curl: { thumb: number; index: number; middle: number; ring: number; pinky: number };
}

// A grip point the ArmsRig chases. ViewModelRig animates `offset` and
// `altBlend` (the second pose, e.g. the hand lifted onto a bolt handle); the
// rig resolves the final frame every frame.
export interface HandAnchor {
  node: TransformNode; // parented to the weapon root; position = rest + offset
  rest: Vector3;
  offset: Vector3;
  pose: HandPose;
  alt: HandPose | null;
  altBlend: number;
}

export interface WeaponViewModel {
  root: Mesh;
  pivots: Record<string, Mesh>; // animated sub-assemblies by name
  hands: { right: HandAnchor; left: HandAnchor };
}

export function handAnchor(name: string, root: Mesh, pose: HandPose, alt: HandPose | null = null): HandAnchor {
  const node = new TransformNode(name, root.getScene());
  node.parent = root;
  const rest = new Vector3(pose.wrist[0], pose.wrist[1], pose.wrist[2]);
  node.position.copyFrom(rest);
  node.rotationQuaternion = poseFrame(pose, new Quaternion());
  return { node, rest, offset: new Vector3(), pose, alt, altBlend: 0 };
}

// Orientation of a hand pose as a quaternion: +Y = knuckle direction,
// +Z = palm normal (both in weapon space)
export function poseFrame(pose: HandPose, out: Quaternion): Quaternion {
  const y = new Vector3(pose.knuckles[0], pose.knuckles[1], pose.knuckles[2]);
  const z = new Vector3(pose.palm[0], pose.palm[1], pose.palm[2]);
  return frameQuat(y, z, out);
}

// Place a primitive: material, optional rotation/scaling, position, parent.
// The workhorse for the weapons' hundreds of hand-tuned parts.
export function prim(
  mesh: Mesh,
  mat: StandardMaterial | null,
  parent: Mesh,
  pos: Vector3 | Vec3Tuple | null,
  o?: {
    rx?: number;
    ry?: number;
    rz?: number;
    scale?: Vec3Tuple;
    sx?: number;
    sy?: number;
    sz?: number;
  }
): Mesh {
  if (mat) mesh.material = mat;
  if (o) {
    if (o.rx !== undefined) mesh.rotation.x = o.rx;
    if (o.ry !== undefined) mesh.rotation.y = o.ry;
    if (o.rz !== undefined) mesh.rotation.z = o.rz;
    if (o.scale) mesh.scaling.set(o.scale[0], o.scale[1], o.scale[2]);
    if (o.sx !== undefined) mesh.scaling.x = o.sx;
    if (o.sy !== undefined) mesh.scaling.y = o.sy;
    if (o.sz !== undefined) mesh.scaling.z = o.sz;
  }
  if (pos) {
    if (pos instanceof Vector3) mesh.position.copyFrom(pos);
    else mesh.position.set(pos[0], pos[1], pos[2]);
  }
  mesh.parent = parent;
  return mesh;
}

// Merge a weapon's static parts into one mesh per material: ~120 primitives
// (~120 draw calls per frame) collapse to ~20 with pixel-identical output.
// Animated pivot groups stay separate; their children merge within the
// pivot. Must run while the root and pivots' ancestors are still at
// identity, so baked world geometry equals root-local geometry; setParent()
// compensates each pivot's rest offset. Finally marks every mesh unpickable
// so the viewmodel never intercepts the hitscan ray.
export function mergeWeaponParts(parent: Mesh, pivots: Mesh[]): void {
  const mergeByMaterial = (meshes: Mesh[], reparent: (m: Mesh) => void): void => {
    const groups = new Map<unknown, Mesh[]>();
    for (const m of meshes) {
      if (m.getTotalVertices() === 0 || !m.material) continue;
      const list = groups.get(m.material);
      if (list) list.push(m);
      else groups.set(m.material, [m]);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const merged = Mesh.MergeMeshes(list, true, true, undefined, false, false);
      if (merged) reparent(merged);
    }
  };

  const staticParts: Mesh[] = [];
  const pivotParts = new Map<Mesh, Mesh[]>(pivots.map((p) => [p, []]));
  for (const child of parent.getChildMeshes(false)) {
    const m = child as Mesh;
    if (pivots.includes(m)) continue;
    const owner = pivots.find((p) => m.isDescendantOf(p));
    if (owner) pivotParts.get(owner)!.push(m);
    else staticParts.push(m);
  }
  mergeByMaterial(staticParts, (m) => m.setParent(parent));
  for (const [pivot, parts] of pivotParts) {
    mergeByMaterial(parts, (m) => m.setParent(pivot));
  }

  parent.isPickable = false;
  for (const child of parent.getChildMeshes()) {
    child.isPickable = false;
  }
}

export function alignToY(mesh: Mesh, dir: Vector3): void {
  const q = new Quaternion();
  Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir.normalize(), q);
  mesh.rotationQuaternion = q;
}

// Tapered limb: cone trunk + sphere end caps — stock necks and grips that
// thin toward a joint instead of reading as uniform tubes
export function createTaperedLimb(
  name: string,
  scene: Scene,
  parent: Mesh,
  mat: StandardMaterial,
  from: Vector3,
  to: Vector3,
  rFrom: number,
  rTo: number,
  tess: number = 18
): Mesh {
  const dir = to.subtract(from);
  const trunk = MeshBuilder.CreateCylinder(
    name,
    { height: dir.length(), diameterTop: rTo * 2, diameterBottom: rFrom * 2, tessellation: tess },
    scene
  );
  trunk.position.copyFrom(Vector3.Lerp(from, to, 0.5));
  alignToY(trunk, dir);
  trunk.material = mat;
  trunk.parent = parent;
  prim(MeshBuilder.CreateSphere(`${name}_capA`, { diameter: rFrom * 2, segments: 12 }, scene), mat, parent, from);
  prim(MeshBuilder.CreateSphere(`${name}_capB`, { diameter: rTo * 2, segments: 12 }, scene), mat, parent, to);
  return trunk;
}

// Capsule oriented from -> to (rounded ends blend joints smoothly)
export function createLimb(name: string, scene: Scene, from: Vector3, to: Vector3, radius: number): Mesh {
  const dir = to.subtract(from);
  const len = dir.length();
  const limb = MeshBuilder.CreateCapsule(name, { height: len + radius * 2, radius, tessellation: 10, capSubdivisions: 4 }, scene);
  limb.position.copyFrom(from.add(to).scaleInPlace(0.5));
  alignToY(limb, dir);
  return limb;
}

// Scene-cached texture: painted once, shared by every weapon that asks
export function cachedTexture(scene: Scene, name: string, make: () => DynamicTexture): DynamicTexture {
  const existing = scene.getTextureByName(name) as DynamicTexture | null;
  return existing ?? make();
}
