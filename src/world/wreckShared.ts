import { MeshBuilder, PBRMaterial, DynamicTexture, Color3, Color4, Vector3, ParticleSystem } from "@babylonjs/core";
import { flatMat } from "../rendering/materials/canvas";
import type { AbstractMesh, Material, PickingInfo, Scene, Mesh, TransformNode } from "@babylonjs/core";
import type { WorldMaterials } from "./materials/WorldMaterials";
import type { Effects } from "../rendering/Effects";

// Plumbing shared by CarWreck and TruckWreck. The two wrecks build different
// shells but use the same scene-cached trim materials, the same static-mesh
// helpers and identical breakable glass: laminated panes web at the hit UV
// and collapse after several rounds, tempered panes burst outright, shards
// spray from the opening either way.

export type GlassPane = {
  mesh: Mesh;
  broken: boolean;
  // Laminated panes (windshield/rear) crack at the hit point and only let
  // go after several hits; tempered side/door glass has no crackTex and
  // explodes on the first round.
  crackTex: DynamicTexture | null;
  hits: number;
};

const LAMINATED_HITS_TO_BREAK = 3;

// One get-or-create for the wrecks' flat-color trim materials. They are
// shared by name through the scene's material cache so every wreck instance
// merges into the same static buckets; values only apply on first creation.
// The legacy (diffuse, specular, power) description maps onto the physically
// based kit: a bright specular means bare steel, a high power a tight sheen.
export function getOrCreateColorMat(
  scene: Scene,
  name: string,
  diffuse: Color3,
  specular: Color3,
  power: number,
  emissive?: Color3
): PBRMaterial {
  const specAvg = (specular.r + specular.g + specular.b) / 3;
  return flatMat(scene, name, {
    albedo: [diffuse.r, diffuse.g, diffuse.b],
    rough: Math.max(0.2, Math.min(0.9, 1 - Math.log2(Math.max(2, power)) / 9)),
    metal: specAvg > 0.4 ? 0.75 : 0,
    emissive: emissive ? [emissive.r, emissive.g, emissive.b] : undefined,
  });
}

// Rain-streaked glass shared by the wrecks: a translucent PBR pane with a
// glossy film, reflecting the yard environment
function glassMat(scene: Scene, name: string, tex: DynamicTexture | null, alpha: number): PBRMaterial {
  const cached = scene.getMaterialByName(name) as PBRMaterial | null;
  if (cached) return cached;
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = tex ? new Color3(1, 1, 1) : new Color3(0.14, 0.17, 0.2);
  if (tex) mat.albedoTexture = tex;
  mat.alpha = alpha;
  mat.metallic = 0;
  mat.roughness = 0.18;
  mat.environmentIntensity = 0.45; // a tint of sky in the glass, not a mirror
  mat.backFaceCulling = false;
  mat.emissiveColor = new Color3(0.02, 0.03, 0.04);
  return mat;
}

// Static-dressing helpers: stat() parents a mesh under the wreck root,
// assigns the material and hands it to the map's merger via registerStatic;
// box() is the shorthand for the slab-built bodywork.
export function makeStaticHelpers(
  scene: Scene,
  root: TransformNode,
  registerStatic: (mat: Material, mesh: Mesh) => void
): {
  stat: (mesh: Mesh, mat: Material) => Mesh;
  box: (name: string, w: number, h: number, d: number, x: number, y: number, z: number, mat: Material, rotZ?: number) => Mesh;
} {
  const stat = (mesh: Mesh, mat: Material): Mesh => {
    mesh.parent = root;
    mesh.material = mat;
    mesh.computeWorldMatrix(true);
    registerStatic(mat, mesh);
    return mesh;
  };
  const box = (
    name: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: Material,
    rotZ: number = 0
  ): Mesh => {
    // wrap keeps painted textures upright on every side (the default box
    // mapping turns them 90 degrees on the x faces)
    const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d, wrap: true }, scene);
    m.position.set(x, y, z);
    m.rotation.z = rotZ;
    return stat(m, mat);
  };
  return { stat, box };
}

// Weathered laminated glazing: gives the pane its own DynamicTexture (base
// wash now, crack webs later) on a translucent material. Returns the texture
// so the caller can wire it into the pane's crack state.
export function applyLaminatedGlass(scene: Scene, pane: Mesh, name: string): DynamicTexture {
  const tex = new DynamicTexture(`${name}_tex`, { width: 256, height: 128 }, scene, true);
  paintGlassBase(tex);

  pane.material = glassMat(scene, `${name}_mat`, tex, 0.42);

  return tex;
}

// Tempered pane (car sides, truck doors): shares one clean scene-cached
// glass material, no crackTex, shatters outright on the first round.
export function addTemperedPane(
  scene: Scene,
  root: TransformNode,
  instance: unknown,
  panes: Map<AbstractMesh, GlassPane>,
  name: string,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number
): void {
  const mat = glassMat(scene, "carSideGlassMat", null, 0.34); // clear enough that the cabin reads through it

  const pane = MeshBuilder.CreateBox(name, { width: w, height: h, depth: 0.022 }, scene);
  pane.position.set(x, y, z);
  pane.parent = root;
  pane.material = mat;
  pane.metadata = { type: "carGlass", instance };
  panes.set(pane, { mesh: pane, broken: false, crackTex: null, hits: 0 });
}

function paintGlassBase(tex: DynamicTexture): void {
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const w = 256,
    h = 128;
  // dark tinted laminate: the sheen comes from the material's reflection,
  // not from a pale wash in the paint
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#3a4850");
  g.addColorStop(0.55, "#2c383f");
  g.addColorStop(1, "#22292e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // rain rivulets
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = "#c9d6dc";
  ctx.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * w;
    ctx.beginPath();
    ctx.moveTo(x, Math.random() * 30);
    ctx.lineTo(x + (Math.random() - 0.5) * 8, h - Math.random() * 20);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  tex.update();
}

// Radial crack web painted at the hit UV — rides the pane like the target
// boards' bullet holes
function paintCrack(tex: DynamicTexture, u: number, v: number): void {
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const x = u * 256;
  const y = (1 - v) * 128;

  ctx.strokeStyle = "rgba(235, 243, 248, 0.85)";
  const rays = 7 + ((Math.random() * 3) | 0);
  for (let i = 0; i < rays; i++) {
    const a = (Math.PI * 2 * i) / rays + Math.random() * 0.5;
    const len = 18 + Math.random() * 30;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    // cracks wander as they travel
    const midA = a + (Math.random() - 0.5) * 0.4;
    ctx.lineTo(x + Math.cos(a) * len * 0.45, y + Math.sin(a) * len * 0.45);
    ctx.lineTo(x + Math.cos(midA) * len, y + Math.sin(midA) * len);
    ctx.stroke();
  }
  // concentric stress rings
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(220, 230, 238, 0.55)";
  for (const r of [6, 12]) {
    ctx.beginPath();
    ctx.arc(x, y, r + Math.random() * 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  // bright impact core
  ctx.fillStyle = "rgba(245, 250, 252, 0.9)";
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
  tex.update();
}

// Shard burst shared by every pane of a wreck: manual-emit only, parked on a
// movable anchor that hitGlassPane drags to whichever pane just broke.
export function createGlassShardSystem(scene: Scene, materials: WorldMaterials, name: string, anchor: Vector3): ParticleSystem {
  const shards = new ParticleSystem(name, 400, scene);
  shards.particleTexture = materials.createRainStreakTexture(); // small pale sliver reads as glass
  shards.emitter = anchor;
  shards.minEmitBox = new Vector3(-0.4, -0.18, -0.4);
  shards.maxEmitBox = new Vector3(0.4, 0.18, 0.4);
  shards.direction1 = new Vector3(-0.6, 0.25, -0.6);
  shards.direction2 = new Vector3(0.6, 1.0, 0.6);
  shards.minEmitPower = 0.8;
  shards.maxEmitPower = 2.4;
  shards.updateSpeed = 1 / 60;
  shards.gravity = new Vector3(0, -9.8, 0);
  shards.minLifeTime = 0.45;
  shards.maxLifeTime = 0.85;
  shards.minSize = 0.02;
  shards.maxSize = 0.055;
  shards.minAngularSpeed = -8;
  shards.maxAngularSpeed = 8;
  shards.color1 = new Color4(0.82, 0.88, 0.94, 0.95);
  shards.color2 = new Color4(0.6, 0.7, 0.78, 0.85);
  shards.colorDead = new Color4(0.6, 0.7, 0.78, 0);
  shards.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  shards.emitRate = 0; // bursts only
  shards.start();
  return shards;
}

// Core of the wrecks' public hitGlass(): crack laminated panes until they
// give, shatter tempered panes outright, spray shards from the opening.
export function hitGlassPane(
  panes: Map<AbstractMesh, GlassPane>,
  shards: ParticleSystem,
  shardAnchor: Vector3,
  mesh: AbstractMesh,
  pick: PickingInfo,
  effects: Effects
): void {
  const pane = panes.get(mesh);
  if (!pane || pane.broken) return;

  pane.hits++;
  if (pane.crackTex && pane.hits < LAMINATED_HITS_TO_BREAK) {
    const uv = pick.getTextureCoordinates();
    paintCrack(pane.crackTex, uv ? uv.x : 0.5, uv ? uv.y : 0.5);
    effects.playGlassCrackSound();
    return;
  }

  // Shatter: the pane vanishes and shards spray from the opening
  pane.broken = true;
  mesh.setEnabled(false);
  mesh.isPickable = false;
  shardAnchor.copyFrom(mesh.absolutePosition);
  shards.manualEmitCount = 70;
  effects.playGlassBreakSound();
}
