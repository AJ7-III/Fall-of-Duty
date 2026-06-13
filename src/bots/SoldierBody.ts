import {
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Color3,
  DynamicTexture,
  RawCubeTexture,
  Texture,
  Constants,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import type {
  AbstractMesh,
  AnimationGroup,
  AssetContainer,
  Observer,
  PBRMaterial,
  Scene,
} from "@babylonjs/core";
import { whenSoldierModelReady } from "./SoldierAssets";

// The one soldier body, shared by every human in the yard — now a real
// skinned glTF character (Mixamo Vanguard rig, Idle/Walk/Run clips) instead
// of the old capsule-and-sphere primitive doll. The asset loads async, so
// each body is born "headless": hitboxes, rifle, shadow and the rig's proxy
// pivots exist immediately and gameplay code never waits; the skin and
// skeleton attach the moment the shared container lands.
//
// Compatibility contract (nothing upstream changed):
//  - rig.parts: invisible boxes that ride the skeleton joints and carry the
//    damage-zone multipliers for the player's hitscan, exactly like the old
//    per-part meshes.
//  - rig.torso/head/gunArm/hips/knees: proxy pivots. Bot's walk code and the
//    whole DeathPerformance choreography keep writing the same Euler poses;
//    the controller maps them onto skeleton joints (alive: spine aim-lean,
//    dead: full body puppeteering with animations stopped).
//  - rig.gun: the procedural rifle, mounted to the chest joint; both hands
//    grip it through analytic two-bone IK, and the dying still drop it.
//  - rig.head proxy rides the head joint, so the death-cam's face tracking
//    and the muzzle math keep their meaning.

export interface SoldierMats {
  key: string; // faction cache key for the skin material
  tint: Color3; // multiplied into the character albedo (OPFOR olive / player tan)
  dark: StandardMaterial;
  wood: StandardMaterial;
  face: StandardMaterial; // dummy pair — keeps the eyes-shut swap and the
  faceShut: StandardMaterial; // terminator face override wired without a painted face
  blob: StandardMaterial;
}

export interface SoldierLook {
  mats: SoldierMats;
  headgear: "wrap" | "beanie"; // kept for callers; the glTF body wears its own helmet
  scarf: boolean;
  sniper: boolean; // long scoped bolt gun instead of the AK silhouette
}

export interface SoldierPart {
  mesh: Mesh;
  zone: number; // damage multiplier the owner bakes into hit metadata
}

export interface SoldierRig {
  root: TransformNode;
  torso: TransformNode; // proxy — bobs with footfalls, arches in the death gasp
  head: TransformNode; // proxy riding the head joint (death-cam tracks it)
  gunArm: TransformNode; // weapon pivot — pitches with the aim, swings in death
  gun: TransformNode; // the rifle alone — detachable so the dying drop it
  gunHomePos: Vector3;
  muzzle: TransformNode;
  hipL: TransformNode;
  hipR: TransformNode;
  kneeL: TransformNode;
  kneeR: TransformNode;
  faceMesh: Mesh;
  faceMat: StandardMaterial;
  faceShutMat: StandardMaterial;
  blobShadow: Mesh;
  parts: SoldierPart[];
  body: SoldierBodyController; // skeleton/animation driver
}

// ---------------------------------------------------------------- materials

// Painted canvas texture (kept for the rifle furniture and gunmetal — the
// rifles stay procedural so they keep matching the first-person viewmodels)
function painted(scene: Scene, name: string, paint: (c: CanvasRenderingContext2D) => void): StandardMaterial {
  let m = scene.getMaterialByName(name) as StandardMaterial | null;
  if (!m) {
    m = new StandardMaterial(name, scene);
    const tex = new DynamicTexture(`${name}Tex`, { width: 128, height: 128 }, scene, false);
    paint(tex.getContext() as CanvasRenderingContext2D);
    tex.update();
    m.diffuseTexture = tex;
    m.specularColor = new Color3(0.04, 0.04, 0.04);
  }
  return m;
}

function mottled(base: string, tones: string[], speckle: string) {
  return (c: CanvasRenderingContext2D): void => {
    c.fillStyle = base;
    c.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 42; i++) {
      c.fillStyle = tones[i % tones.length];
      c.beginPath();
      c.ellipse(Math.random() * 128, Math.random() * 128, 6 + Math.random() * 14, 4 + Math.random() * 9, Math.random() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = speckle;
    for (let i = 0; i < 320; i++) {
      c.fillRect(Math.random() * 128, Math.random() * 128, 1.5, 1.5);
    }
  };
}

function kitMats(scene: Scene): Pick<SoldierMats, "dark" | "wood" | "blob" | "face" | "faceShut"> {
  let blob = scene.getMaterialByName("botBlobMat") as StandardMaterial | null;
  if (!blob) {
    blob = new StandardMaterial("botBlobMat", scene);
    blob.diffuseColor = Color3.Black();
    blob.specularColor = Color3.Black();
    blob.alpha = 0.38;
  }
  let face = scene.getMaterialByName("soldierFaceDummyMat") as StandardMaterial | null;
  if (!face) {
    face = new StandardMaterial("soldierFaceDummyMat", scene);
    face.diffuseColor = new Color3(0.4, 0.32, 0.24);
  }
  return {
    dark: painted(scene, "botDarkMat", mottled("#1e1e20", ["#26262a", "#19191b"], "rgba(60,60,66,0.4)")),
    wood: painted(scene, "botWoodMat", (c) => {
      c.fillStyle = "#6e4a2c";
      c.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 26; i++) {
        c.fillStyle = i % 2 ? "rgba(90,58,32,0.7)" : "rgba(122,86,50,0.6)";
        c.fillRect(0, Math.random() * 128, 128, 1 + Math.random() * 2.5);
      }
    }),
    blob,
    face,
    faceShut: face,
  };
}

// The OPFOR look — the repainted woodland-camo kit, cooled slightly
export function botMaterials(scene: Scene): SoldierMats {
  return { ...kitMats(scene), key: "opfor", tint: new Color3(0.9, 0.95, 0.84) };
}

// The player's corpse: the same kit warmed toward tan desert fatigues so
// the death-cam reads "that's me", not another hostile
export function playerMaterials(scene: Scene): SoldierMats {
  return { ...kitMats(scene), key: "player", tint: new Color3(1.12, 1.04, 0.85) };
}

// ------------------------------------------------ player corpse arm repaint

// The death-cam body must read as the same person as the first-person rig:
// bare tattooed forearms and woven shooting gloves (AssetLoader's viewmodel
// arms), not the Vanguard armour sleeves. The regions are found from the
// mesh's own skin weights — every triangle owned by the ForeArm / Hand bone
// chains — and repainted directly over the fatigues albedo, so no UV-layout
// knowledge is hardcoded.
function playerBodyAlbedo(scene: Scene, meshes: AbstractMesh[]): Texture {
  const existing = scene.getTextureByName("soldierFatiguesPlayerTex") as Texture | null;
  if (existing) return existing;
  const S = 1024; // matches the source albedo
  const tex = new DynamicTexture(
    "soldierFatiguesPlayerTex", { width: S, height: S }, scene,
    true, Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTUREFORMAT_RGBA,
    false // glTF UVs — no Y flip, same as the shared fatigues texture
  );
  const ctx = tex.getContext() as CanvasRenderingContext2D;

  // Texel-space path of every triangle whose corners all ride the given bone
  // chain (the weight threshold keeps elbow/wrist blend triangles out, which
  // leaves a natural rolled-sleeve / glove-cuff boundary).
  const regionPath = (boneKey: string): Path2D | null => {
    const path = new Path2D();
    let any = false;
    for (const mesh of meshes) {
      const skel = mesh.skeleton;
      if (!skel) continue;
      const picks = new Set<number>();
      skel.bones.forEach((b, i) => {
        if (b.name.includes(boneKey)) picks.add(i);
      });
      if (!picks.size) continue;
      const uv = mesh.getVerticesData(VertexBuffer.UVKind);
      const mi = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
      const mw = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
      const idx = mesh.getIndices();
      if (!uv || !mi || !mw || !idx) continue;
      const n = (uv.length / 2) | 0;
      const w = new Float32Array(n);
      for (let v = 0; v < n; v++) {
        for (let k = 0; k < 4; k++) {
          if (picks.has(mi[v * 4 + k])) w[v] += mw[v * 4 + k];
        }
      }
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2];
        if (w[a] < 0.2 || w[b] < 0.2 || w[c] < 0.2) continue;
        path.moveTo(uv[a * 2] * S, uv[a * 2 + 1] * S);
        path.lineTo(uv[b * 2] * S, uv[b * 2 + 1] * S);
        path.lineTo(uv[c * 2] * S, uv[c * 2 + 1] * S);
        path.closePath();
        any = true;
      }
    }
    return any ? path : null;
  };

  const tile = (size: number, paint: (c: CanvasRenderingContext2D, s: number) => void): HTMLCanvasElement => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const c = cv.getContext("2d") as CanvasRenderingContext2D;
    paint(c, size);
    return cv;
  };

  // The viewmodel skin scaled down: dark weathered base, mottled tone, and
  // the blackwork motifs (stripe pair, chevrons, diamond band, dotwork) from
  // AssetLoader's half-sleeve. Base sits a touch cooler than the viewmodel
  // because the player tint (1.12, 1.04, 0.85) warms it back up.
  const skinTile = tile(160, (c, s) => {
    const grad = c.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, "#57382a");
    grad.addColorStop(0.5, "#4c3024");
    grad.addColorStop(1, "#40271c");
    c.fillStyle = grad;
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 90; i++) {
      c.fillStyle = ["rgba(90,57,42,0.3)", "rgba(75,46,33,0.3)", "rgba(104,73,54,0.3)", "rgba(65,38,25,0.3)"][i % 4];
      c.beginPath();
      c.ellipse(Math.random() * s, Math.random() * s, 2 + Math.random() * 8, 1.5 + Math.random() * 5, Math.random() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
    const ink = (a: number): string => `rgba(17,23,26,${a})`;
    c.fillStyle = ink(0.72);
    c.fillRect(0, 26, s, 4);
    c.fillRect(0, 56, s, 4);
    c.fillStyle = ink(0.62);
    for (let x = 0; x < s; x += 20) {
      c.beginPath();
      c.moveTo(x, 54);
      c.lineTo(x + 10, 34);
      c.lineTo(x + 20, 54);
      c.closePath();
      c.fill();
    }
    c.fillStyle = ink(0.66); // solid band with negative-space diamonds
    c.fillRect(0, 86, s, 22);
    c.fillStyle = "#4c3024";
    for (let x = 10; x < s; x += 28) {
      c.save();
      c.translate(x, 97);
      c.rotate(Math.PI / 4);
      c.fillRect(-4.5, -4.5, 9, 9);
      c.restore();
    }
    c.fillStyle = ink(0.6); // dotwork arc + wrist pinstripes
    for (let k = 0; k < 7; k++) {
      c.beginPath();
      c.arc(20 + k * 19, 128 + Math.sin(k * 0.9) * 6, 2.2, 0, Math.PI * 2);
      c.fill();
    }
    c.fillRect(0, 146, s, 2);
    c.fillRect(0, 151, s, 2);
  });

  // The viewmodel's shooting-glove nylon: dark olive cross-hatch weave
  const gloveTile = tile(64, (c, s) => {
    c.fillStyle = "#26261f";
    c.fillRect(0, 0, s, s);
    c.lineWidth = 1;
    for (let p = 0; p < s; p += 4) {
      c.strokeStyle = "rgba(58,58,46,0.55)";
      c.beginPath(); c.moveTo(p, 0); c.lineTo(p, s); c.stroke();
      c.strokeStyle = "rgba(16,16,12,0.6)";
      c.beginPath(); c.moveTo(0, p + 2); c.lineTo(s, p + 2); c.stroke();
    }
    for (let i = 0; i < 18; i++) {
      c.fillStyle = i % 2 ? "rgba(51,51,42,0.3)" : "rgba(28,28,22,0.3)";
      c.beginPath();
      c.ellipse(Math.random() * s, Math.random() * s, 2 + Math.random() * 5, 1 + Math.random() * 3, Math.random() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
  });

  const fillRegion = (path: Path2D, pattern: HTMLCanvasElement): void => {
    const pat = ctx.createPattern(pattern, "repeat");
    if (!pat) return;
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, S, S);
    ctx.restore();
    // dilate past the island edge so bilinear sampling shows no camo halo
    ctx.strokeStyle = pat;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.stroke(path);
  };

  // stand-in tone until the base albedo lands (the corpse stays hidden until
  // the first death, long after this resolves)
  ctx.fillStyle = "#8a7d5f";
  ctx.fillRect(0, 0, S, S);
  tex.update();

  const img = new Image();
  img.onload = (): void => {
    ctx.drawImage(img, 0, 0, S, S);
    const skin = regionPath("ForeArm");
    if (skin) fillRegion(skin, skinTile);
    const glove = regionPath("Hand"); // also catches the finger chains
    if (glove) fillRegion(glove, gloveTile); // after skin: the cuff wins the wrist
    tex.update();
  };
  img.onerror = (): void => console.error("player corpse repaint: fatigues albedo failed to load");
  img.src = "/models/soldier_fatigues.jpg";

  return tex;
}

// The Terminator skin: one shared chrome material for difficulty 9+ —
// unchanged, and it skins perfectly well over the glTF body.
export function terminatorMaterial(scene: Scene): StandardMaterial {
  let m = scene.getMaterialByName("terminatorChromeMat") as StandardMaterial | null;
  if (m) return m;

  const size = 16;
  const shade = (y: number): [number, number, number] => {
    if (y > 0.12) {
      const t = (y - 0.12) / 0.88;
      return [205 - 95 * t, 212 - 87 * t, 222 - 72 * t];
    }
    if (y > -0.08) {
      const t = (y + 0.08) / 0.2;
      return [40 + 165 * t, 44 + 168 * t, 50 + 172 * t];
    }
    const t = Math.min(1, (-y - 0.08) / 0.92);
    return [40 - 22 * t, 44 - 24 * t, 50 - 26 * t];
  };
  const axes: ReadonlyArray<(u: number, v: number) => number> = [
    (_u, v) => -v, (_u, v) => -v,
    () => 1, () => -1,
    (_u, v) => -v, (_u, v) => -v,
  ];
  const faces = axes.map((yOf) => {
    const data = new Uint8Array(size * size * 4);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const u = (2 * (col + 0.5)) / size - 1;
        const v = (2 * (row + 0.5)) / size - 1;
        const y = yOf(u, v) / Math.sqrt(u * u + v * v + 1);
        const [r, g, b] = shade(y);
        const i = (row * size + col) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
    }
    return data;
  });

  m = new StandardMaterial("terminatorChromeMat", scene);
  m.reflectionTexture = new RawCubeTexture(
    scene, faces, size,
    Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT,
    true
  );
  m.diffuseColor = new Color3(0.03, 0.033, 0.04);
  m.specularColor = new Color3(1, 1, 1);
  m.specularPower = 96;
  m.emissiveColor = new Color3(0.02, 0.022, 0.026);
  return m;
}

// ------------------------------------------------------------------ hitboxes

// Joint-segment hitboxes replace the old per-primitive damage zones: each is
// an invisible box (visibility 0 keeps it pickable but never rendered) that
// rides its skeleton joint. Pre-load they stand in a rough humanoid layout
// at the root so a bot is shootable from frame zero.
interface HitboxSpec {
  id: string;
  a: string; // joint the box rides
  b: string; // joint the segment reaches toward
  zone: number;
  thick: number;
  pad: number; // extra length beyond the joint span
  pre: [number, number, number]; // stand-in placement before the skeleton lands
  preH: number;
}

const HITBOXES: ReadonlyArray<HitboxSpec> = [
  { id: "head", a: "Head", b: "HeadTop_End", zone: 2.0, thick: 0.26, pad: 0.08, pre: [0, 1.72, 0], preH: 0.3 },
  { id: "chest", a: "Spine1", b: "Neck", zone: 1.5, thick: 0.38, pad: 0.08, pre: [0, 1.38, 0], preH: 0.46 },
  { id: "pelvis", a: "Hips", b: "Spine1", zone: 1.5, thick: 0.36, pad: 0.1, pre: [0, 1.0, 0], preH: 0.32 },
  { id: "uarmL", a: "LeftArm", b: "LeftForeArm", zone: 1.0, thick: 0.13, pad: 0.04, pre: [-0.26, 1.44, 0], preH: 0.3 },
  { id: "farmL", a: "LeftForeArm", b: "LeftHand", zone: 1.0, thick: 0.11, pad: 0.05, pre: [-0.3, 1.2, 0.1], preH: 0.28 },
  { id: "uarmR", a: "RightArm", b: "RightForeArm", zone: 1.0, thick: 0.13, pad: 0.04, pre: [0.26, 1.44, 0], preH: 0.3 },
  { id: "farmR", a: "RightForeArm", b: "RightHand", zone: 1.0, thick: 0.11, pad: 0.05, pre: [0.3, 1.2, 0.1], preH: 0.28 },
  { id: "thighL", a: "LeftUpLeg", b: "LeftLeg", zone: 1.0, thick: 0.18, pad: 0.05, pre: [-0.1, 0.72, 0], preH: 0.45 },
  { id: "shinL", a: "LeftLeg", b: "LeftFoot", zone: 1.0, thick: 0.15, pad: 0.08, pre: [-0.1, 0.28, 0], preH: 0.44 },
  { id: "thighR", a: "RightUpLeg", b: "RightLeg", zone: 1.0, thick: 0.18, pad: 0.05, pre: [0.1, 0.72, 0], preH: 0.45 },
  { id: "shinR", a: "RightLeg", b: "RightFoot", zone: 1.0, thick: 0.15, pad: 0.08, pre: [0.1, 0.28, 0], preH: 0.44 },
];

const SOLDIER_HEIGHT = 1.85; // matches the bots' collision capsule

// -------------------------------------------------------------------- build

export function buildSoldier(scene: Scene, name: string, look: SoldierLook): SoldierRig {
  const mats = look.mats;
  const parts: SoldierPart[] = [];
  const root = new TransformNode(name, scene);

  // Proxy pivots: Bot's walk bookkeeping and DeathPerformance write the same
  // Euler poses they always did; the controller consumes them as data.
  const proxy = (n: string, y: number): TransformNode => {
    const p = new TransformNode(`${name}_${n}`, scene);
    p.parent = root;
    p.position.y = y;
    return p;
  };
  const torso = proxy("torsoP", 1.25);
  const head = proxy("headP", 1.7);
  const hipL = proxy("hipLP", 0.95);
  const hipR = proxy("hipRP", 0.95);
  const kneeL = proxy("kneeLP", 0.5);
  const kneeR = proxy("kneeRP", 0.5);

  // Weapon mount (the rig's "gunArm"): mountFollower glues to the chest
  // joint once the skeleton lands; gunArm keeps Euler rotation so the owner
  // and DeathPerformance write rotation.x exactly as before.
  const mountFollower = new TransformNode(`${name}_gunMount`, scene);
  mountFollower.parent = root;
  mountFollower.position.set(0.02, 1.34, 0.17);
  const gunArm = new TransformNode(`${name}_gunArm`, scene);
  gunArm.parent = mountFollower;
  gunArm.rotation.x = 0.5;

  const isSniper = look.sniper;
  const gun = new TransformNode(`${name}_gunGroup`, scene);
  gun.parent = gunArm;
  const gunHomePos = gun.position.clone();
  const gunPart = (mesh: Mesh, px: number, py: number, pz: number, mat: StandardMaterial, rx: number = 0): void => {
    mesh.position.set(px, py, pz);
    mesh.rotation.x = rx;
    mesh.material = mat;
    mesh.parent = gun;
    mesh.isPickable = false;
  };
  const box = (n: string, w: number, h: number, d: number): Mesh =>
    MeshBuilder.CreateBox(`${name}_${n}`, { width: w, height: h, depth: d }, scene);
  const tube = (n: string, dia: number, len: number): Mesh =>
    MeshBuilder.CreateCylinder(`${name}_${n}`, { diameter: dia, height: len, tessellation: 10 }, scene);

  gunPart(box("stock", 0.05, isSniper ? 0.12 : 0.1, isSniper ? 0.3 : 0.24), 0.045, -0.05, isSniper ? -0.04 : -0.02, mats.wood);
  gunPart(box("receiver", 0.055, 0.105, 0.42), 0.045, -0.03, 0.28, mats.dark);
  gunPart(box("foregrip", 0.06, 0.075, 0.17), 0.045, -0.045, 0.44, mats.wood);
  gunPart(tube("barrel", 0.032, isSniper ? 0.42 : 0.3), 0.045, -0.015, isSniper ? 0.72 : 0.66, mats.dark, Math.PI / 2);
  gunPart(box("grip", 0.04, 0.1, 0.05), 0.045, -0.115, 0.13, mats.wood, -0.25);
  gunPart(box("frontSight", 0.012, 0.05, 0.012), 0.045, 0.04, isSniper ? 0.84 : 0.6, mats.dark);
  gunPart(box("rearSight", 0.034, 0.028, 0.02), 0.045, 0.038, 0.14, mats.dark);
  if (isSniper) {
    gunPart(tube("scope", 0.05, 0.17), 0.045, 0.075, 0.3, mats.dark, Math.PI / 2);
  } else {
    gunPart(box("mag", 0.045, 0.16, 0.09), 0.045, -0.14, 0.26, mats.dark, 0.35);
  }

  const muzzle = new TransformNode(`${name}_muzzle`, scene);
  muzzle.parent = gunArm;
  muzzle.position.set(0.045, -0.015, isSniper ? 0.95 : 0.82);

  // IK grip points ride the rifle; the hands chase them
  const gripR = new TransformNode(`${name}_gripR`, scene);
  gripR.parent = gun;
  gripR.position.set(0.0, -0.1, 0.12);
  const gripL = new TransformNode(`${name}_gripL`, scene);
  gripL.parent = gun;
  gripL.position.set(0.02, -0.02, 0.42);

  // Eyes-shut face swap is meaningless on a textured head — keep the mesh
  // and material hooks alive (DeathPerformance and the terminator skin use
  // them) as an invisible stub.
  const faceMesh = MeshBuilder.CreateBox(`${name}_face`, { size: 0.01 }, scene);
  faceMesh.parent = head;
  faceMesh.visibility = 0;
  faceMesh.isPickable = false;
  faceMesh.material = mats.face;

  const hitboxes: Array<{ mesh: Mesh; spec: HitboxSpec }> = [];
  for (const spec of HITBOXES) {
    const hb = MeshBuilder.CreateBox(`${name}_hb_${spec.id}`, { size: 1 }, scene);
    hb.scaling.set(spec.thick, spec.preH, spec.thick);
    hb.position.set(spec.pre[0], spec.pre[1], spec.pre[2]);
    hb.parent = root;
    hb.visibility = 0; // never rendered; isVisible stays true so picking works
    parts.push({ mesh: hb, zone: spec.zone });
    hitboxes.push({ mesh: hb, spec });
  }

  const blobShadow = MeshBuilder.CreateDisc(`${name}_blob`, { radius: 0.42, tessellation: 14 }, scene);
  blobShadow.rotation.x = Math.PI / 2;
  blobShadow.position.y = 0.02;
  blobShadow.material = mats.blob;
  blobShadow.parent = root;
  blobShadow.isPickable = false;

  const body = new SoldierBodyController(scene, name, look, {
    root, torso, head, hipL, hipR, kneeL, kneeR,
    mountFollower, gunArm, gripR, gripL, hitboxes,
  });

  return {
    root, torso, head, gunArm, gun, gunHomePos, muzzle,
    hipL, hipR, kneeL, kneeR,
    faceMesh, faceMat: mats.face, faceShutMat: mats.faceShut,
    blobShadow, parts, body,
  };
}

// ---------------------------------------------------------------- controller

interface ControllerRefs {
  root: TransformNode;
  torso: TransformNode;
  head: TransformNode;
  hipL: TransformNode;
  hipR: TransformNode;
  kneeL: TransformNode;
  kneeR: TransformNode;
  mountFollower: TransformNode;
  gunArm: TransformNode;
  gripR: TransformNode;
  gripL: TransformNode;
  hitboxes: Array<{ mesh: Mesh; spec: HitboxSpec }>;
}

// A follower copies a skeleton joint's motion onto a root-space node using
// relations captured at bind time. Pure world-space math — immune to the
// glTF root's mirrored/scaled transform chain.
interface Follower {
  node: TransformNode;
  joint: TransformNode;
  relPos: Vector3; // node position in the joint's (scaled) local space
  relDir: Vector3 | null; // node's Y axis in joint local space (null = keep world rot from relRef pair)
  relRef: Vector3 | null; // node's Z-ish reference axis in joint local space
}

// Death choreography mapping: proxy Euler angles -> joint rotation offsets
// about character-space axes, composed onto the pose captured at the kill.
interface DeathJoint {
  joint: TransformNode;
  base: Quaternion;
  angles: () => { right: number; fwd: number };
}

// Two-bone analytic IK arm gripping the rifle.
interface ArmIK {
  upper: TransformNode;
  fore: TransformNode;
  aLen: number;
  bLen: number;
  dLUpper: Vector3; // bone axis in the node's local frame (toward child)
  bLUpper: Vector3; // bend reference in the node's local frame
  dLFore: Vector3;
  bLFore: Vector3;
  target: TransformNode;
  pole: TransformNode;
}

// Dedicated scratch per routine — these helpers nest (solveArms calls
// setSegment calls frameQuat), so sharing one temp pool would alias.
const TMP_M = new Matrix();
const FQ_Y = new Vector3();
const FQ_Z = new Vector3();
const FQ_T = new Vector3();
const CO_M = new Matrix();
const CO_AXIS_W = new Vector3();
const CO_AXIS_P = new Vector3();
const CO_Q = new Quaternion();
const IK_T = new Vector3();
const IK_DIR = new Vector3();
const IK_PV = new Vector3();
const IK_TMP = new Vector3();
const IK_ELBOW = new Vector3();
const SS_M = new Matrix();
const SS_D = new Vector3();
const SS_B = new Vector3();
const SS_Q1 = new Quaternion();
const SS_Q2 = new Quaternion();
const UF_POS = new Vector3();
const UF_D = new Vector3();
const UF_R = new Vector3();
const UF_Q = new Quaternion();
const UF_INVROOT = new Quaternion();

// joint-local representation of a world direction
function dirToLocal(world: Vector3, node: TransformNode, out: Vector3): Vector3 {
  node.getWorldMatrix().invertToRef(TMP_M);
  Vector3.TransformNormalToRef(world, TMP_M, out);
  return out.normalize();
}

// Rotation quaternion from an axis pair: y = primary (bone direction),
// z-ish = secondary (bend/facing reference). Both frames built identically,
// so mapping one onto the other is always a proper rotation even when the
// surrounding matrix chain is mirrored.
function frameQuat(y: Vector3, zRef: Vector3, out: Quaternion): Quaternion {
  const yn = FQ_Y.copyFrom(y).normalize();
  const z = FQ_Z.copyFrom(zRef);
  z.subtractInPlace(FQ_T.copyFrom(yn).scaleInPlace(Vector3.Dot(z, yn)));
  if (z.lengthSquared() < 1e-8) z.set(yn.y, yn.z, yn.x); // degenerate ref: any perpendicular
  z.normalize();
  const x = Vector3.Cross(yn, z);
  Quaternion.RotationQuaternionFromAxisToRef(x, yn, z, out);
  return out;
}

export class SoldierBodyController {
  private scene: Scene;
  private name: string;
  private look: SoldierLook;
  private r: ControllerRefs;

  private loaded = false;
  private dying = false;

  private joints: Record<string, TransformNode> = {};
  private idleG: AnimationGroup | null = null;
  private walkG: AnimationGroup | null = null;
  private runG: AnimationGroup | null = null;
  private weights = { idle: 1, walk: 0, run: 0 };

  private aimPitch = 0;
  private engaged = false;
  private spineLean = 0; // smoothed aim-pitch share folded into the spine

  private followers: Follower[] = [];
  private mountF: Follower | null = null;
  private arms: ArmIK[] = [];
  private deathJoints: DeathJoint[] = [];
  private gunArmX0 = 0; // gunArm Euler at the moment of death — arm offsets are deltas
  private gunArmZ0 = 0;
  private mirrorSign = 1; // axis-angle handedness flip under the glTF mirror chain

  private readyCbs: Array<() => void> = [];
  private obs: Observer<Scene> | null = null;

  constructor(scene: Scene, name: string, look: SoldierLook, refs: ControllerRefs) {
    this.scene = scene;
    this.name = name;
    this.look = look;
    this.r = refs;
    whenSoldierModelReady(scene, (c) => this.attach(c));
    this.obs = scene.onBeforeRenderObservable.add(() => this.applyPose());
    refs.root.onDisposeObservable.add(() => {
      if (this.obs) scene.onBeforeRenderObservable.remove(this.obs);
      this.obs = null;
    });
  }

  public whenReady(cb: () => void): void {
    if (this.loaded) cb();
    else this.readyCbs.push(cb);
  }

  // ------------------------------------------------------------------ attach

  private attach(container: AssetContainer): void {
    if (this.r.root.isDisposed()) return;
    const inst = container.instantiateModelsToScene((n) => `${this.name}_${n}`, false, { doNotInstantiate: true });
    const instRoot = inst.rootNodes[0] as TransformNode;
    const align = new TransformNode(`${this.name}_align`, this.scene);
    align.parent = this.r.root;
    instRoot.parent = align;

    const computeAll = (): void => {
      align.computeWorldMatrix(true);
      for (const n of align.getDescendants(false)) {
        (n as TransformNode).computeWorldMatrix(true);
      }
    };
    computeAll();

    // joint registry by short Mixamo name
    for (const n of align.getDescendants(false)) {
      const i = n.name.indexOf("mixamorig:");
      if (i >= 0) this.joints[n.name.slice(i + "mixamorig:".length)] = n as TransformNode;
    }
    const j = (key: string): TransformNode => {
      const node = this.joints[key];
      if (!node) throw new Error(`soldier rig missing joint ${key}`);
      return node;
    };

    // Face the character down the rig's +Z: the toes tell us where the
    // model actually looks, whatever the exporter and the RH->LH root did.
    // Measured in root-local space — the root may already be yawed.
    const toeDir = j("LeftToe_End").getAbsolutePosition().clone()
      .addInPlace(j("RightToe_End").getAbsolutePosition())
      .subtractInPlace(j("LeftToeBase").getAbsolutePosition())
      .subtractInPlace(j("RightToeBase").getAbsolutePosition());
    const invRootQ = this.r.root.absoluteRotationQuaternion.clone();
    invRootQ.invertInPlace();
    toeDir.rotateByQuaternionToRef(invRootQ, toeDir);
    align.rotation.y = -Math.atan2(toeDir.x, toeDir.z);

    // Normalize height to the collision capsule
    computeAll();
    const headTopY = j("HeadTop_End").getAbsolutePosition().y;
    const baseY = align.getAbsolutePosition().y;
    const h = Math.max(0.1, headTopY - baseY);
    align.scaling.setAll((SOLDIER_HEIGHT / h) * align.scaling.x);
    computeAll();

    // One sign flip covers the whole skeleton: every joint lives under the
    // same (possibly mirrored) glTF root chain.
    this.mirrorSign = j("Hips").getWorldMatrix().determinant() < 0 ? -1 : 1;

    this.convertMaterials(inst);
    this.buildFollowers(j);
    this.buildArms(j);
    this.setupAnimations(inst.animationGroups);

    this.loaded = true;
    for (const cb of this.readyCbs) cb();
    this.readyCbs.length = 0;
  }

  // The scene is a StandardMaterial world (hemispheric + directional light,
  // linear fog, frozen defines) — swap the glb's PBR for Standard materials
  // sharing its albedo textures, tinted per faction.
  private convertMaterials(inst: { rootNodes: unknown[] }): void {
    const scene = this.scene;
    const tintKey = this.look.mats.key;
    const meshes = (inst.rootNodes[0] as TransformNode).getChildMeshes(false);
    for (const mesh of meshes) {
      mesh.isPickable = false; // hitboxes do the picking
      mesh.alwaysSelectAsActiveMesh = true; // skinned bounds don't track the animation
      const src = mesh.material as PBRMaterial | null;
      if (!src) continue;
      const isVisor = mesh.name.toLowerCase().includes("visor");
      const matName = `soldierSkin_${tintKey}_${isVisor ? "visor" : "body"}`;
      let std = scene.getMaterialByName(matName) as StandardMaterial | null;
      if (!std) {
        std = new StandardMaterial(matName, scene);
        // The repainted albedo: the glb's sci-fi plate beige rebaked into
        // woodland-camo war clothing (scripted palette remap, see repo
        // public/models). glTF UVs — no Y flip. The player corpse instead
        // gets the variant with the viewmodel's bare tattooed forearms and
        // gloves baked over the arm UVs, so the death cam reads as "me".
        let camo: Texture;
        if (tintKey === "player" && !isVisor) {
          camo = playerBodyAlbedo(scene, meshes);
        } else {
          let shared = scene.getTextureByName("soldierFatiguesTex") as Texture | null;
          if (!shared) {
            shared = new Texture("/models/soldier_fatigues.jpg", scene, false, false);
            shared.name = "soldierFatiguesTex";
          }
          camo = shared;
        }
        std.diffuseTexture = camo;
        std.diffuseColor = this.look.mats.tint;
        std.bumpTexture = src.bumpTexture; // keep the glb's normal map detail
        std.invertNormalMapX = src.invertNormalMapX;
        std.invertNormalMapY = src.invertNormalMapY;
        if (isVisor) {
          std.specularColor = new Color3(0.45, 0.48, 0.52);
          std.specularPower = 64;
        } else {
          std.specularColor = new Color3(0.08, 0.08, 0.09);
          std.specularPower = 24;
        }
        std.freeze();
      }
      mesh.material = std;
    }
  }

  private buildFollowers(j: (k: string) => TransformNode): void {
    const root = this.r.root;
    const rootQ = root.absoluteRotationQuaternion;
    const charFwd = Vector3.Forward().rotateByQuaternionToRef(rootQ, new Vector3());
    const charUp = Vector3.Up().rotateByQuaternionToRef(rootQ, new Vector3());

    // glue a root-space node to a joint, keeping its character-frame
    // orientation (captured as joint-local axes at bind)
    const capture = (node: TransformNode, joint: TransformNode): Follower => {
      joint.computeWorldMatrix(true).invertToRef(TMP_M);
      const relPos = Vector3.TransformCoordinates(node.getAbsolutePosition(), TMP_M);
      const relDir = dirToLocal(charUp, joint, new Vector3()).clone();
      const relRef = dirToLocal(charFwd, joint, new Vector3()).clone();
      return { node, joint, relPos, relDir, relRef };
    };

    // hitboxes: position at the segment midpoint, length to span it
    for (const { mesh, spec } of this.r.hitboxes) {
      const a = j(spec.a);
      const b = j(spec.b);
      const pa = a.getAbsolutePosition().clone();
      const pb = b.getAbsolutePosition().clone();
      const len = Vector3.Distance(pa, pb) + spec.pad;
      mesh.scaling.set(spec.thick, len, spec.thick);
      mesh.position.copyFrom(pa.add(pb).scaleInPlace(0.5));
      // capture: midpoint + bone axis
      a.computeWorldMatrix(true).invertToRef(TMP_M);
      const relPos = Vector3.TransformCoordinates(mesh.position, TMP_M);
      // mesh is a child of root: convert current world placement later each frame
      const segW = pb.subtract(pa).normalize();
      const refW = Math.abs(segW.y) > 0.85 ? Vector3.Forward() : Vector3.Up();
      this.followers.push({
        node: mesh,
        joint: a,
        relPos,
        relDir: dirToLocal(segW, a, new Vector3()).clone(),
        relRef: dirToLocal(refW, a, new Vector3()).clone(),
      });
    }

    // proxies ride their joints so getAbsolutePosition keeps meaning
    this.followers.push(capture(this.r.head, j("Head")));
    this.followers.push(capture(this.r.torso, j("Spine1")));
    this.followers.push(capture(this.r.hipL, j("LeftUpLeg")));
    this.followers.push(capture(this.r.hipR, j("RightUpLeg")));
    this.followers.push(capture(this.r.kneeL, j("LeftLeg")));
    this.followers.push(capture(this.r.kneeR, j("RightLeg")));

    // Weapon mount follows the chest sway in POSITION only. Inheriting the
    // joint's orientation drags the bind→idle pose delta along with it —
    // that pitches the rifle ~26° down and sinks the muzzle ~0.35m below
    // where gunArm.rotation.x says it points. Root-upright, rotation.x IS
    // the barrel's true pitch and the shouldered muzzle can sit on the
    // combat model's fire line (Bot's MUZZLE_HEIGHT).
    this.mountF = capture(this.r.mountFollower, j("Spine2"));
    this.mountF.relDir = null;
    this.mountF.relRef = null;
    this.followers.push(this.mountF);
  }

  private buildArms(j: (k: string) => TransformNode): void {
    const root = this.r.root;
    const rootQ = root.absoluteRotationQuaternion;
    const back = Vector3.Forward().rotateByQuaternionToRef(rootQ, new Vector3()).scaleInPlace(-1);

    const buildSide = (side: "Left" | "Right", target: TransformNode): void => {
      const upper = j(`${side}Arm`);
      const fore = j(`${side}ForeArm`);
      const hand = j(`${side}Hand`);
      const pole = new TransformNode(`${this.name}_pole${side}`, this.scene);
      pole.parent = root;
      // elbows tuck down and back, slightly outboard
      pole.position.set(side === "Left" ? -0.45 : 0.45, 0.78, -0.38);

      const captureSeg = (node: TransformNode, child: TransformNode): { dL: Vector3; bL: Vector3 } => {
        const dL = child.position.clone().normalize(); // child's local pos IS the bone axis in node space
        const bL = dirToLocal(back, node, new Vector3()).clone();
        return { dL, bL };
      };
      const u = captureSeg(upper, fore);
      const f = captureSeg(fore, hand);
      this.arms.push({
        upper, fore,
        aLen: Vector3.Distance(upper.getAbsolutePosition(), fore.getAbsolutePosition()),
        bLen: Vector3.Distance(fore.getAbsolutePosition(), hand.getAbsolutePosition()),
        dLUpper: u.dL, bLUpper: u.bL,
        dLFore: f.dL, bLFore: f.bL,
        target, pole,
      });
    };
    buildSide("Right", this.r.gripR);
    buildSide("Left", this.r.gripL);
  }

  private setupAnimations(groups: AnimationGroup[]): void {
    for (const g of groups) {
      if (g.name.endsWith("Idle")) this.idleG = g;
      else if (g.name.endsWith("Walk")) this.walkG = g;
      else if (g.name.endsWith("Run")) this.runG = g;
      else g.stop(); // TPose
    }
    this.startGroups();
  }

  private startGroups(): void {
    this.weights = { idle: 1, walk: 0, run: 0 };
    this.idleG?.start(true, 1.0);
    this.walkG?.start(true, 1.0);
    this.runG?.start(true, 1.0);
    this.idleG?.setWeightForAllAnimatables(1);
    this.walkG?.setWeightForAllAnimatables(0.0001);
    this.runG?.setWeightForAllAnimatables(0.0001);
  }

  // ------------------------------------------------------------ owner inputs

  // Locomotion blend, called from the owner's per-frame update with the
  // measured horizontal speed (m/s)
  public update(dt: number, speed: number): void {
    if (!this.loaded || this.dying) return;
    const target = speed < 0.4 ? "idle" : speed < 3.1 ? "walk" : "run";
    const k = 1 - Math.exp(-10 * dt);
    const w = this.weights;
    w.idle += ((target === "idle" ? 1 : 0) - w.idle) * k;
    w.walk += ((target === "walk" ? 1 : 0) - w.walk) * k;
    w.run += ((target === "run" ? 1 : 0) - w.run) * k;
    this.idleG?.setWeightForAllAnimatables(Math.max(w.idle, 0.0001));
    this.walkG?.setWeightForAllAnimatables(Math.max(w.walk, 0.0001));
    this.runG?.setWeightForAllAnimatables(Math.max(w.run, 0.0001));
    // playback rate tracks ground speed so the feet don't skate
    if (this.walkG) this.walkG.speedRatio = Math.min(1.8, Math.max(0.6, speed / 1.55));
    if (this.runG) this.runG.speedRatio = Math.min(1.5, Math.max(0.75, speed / 4.6));

    const lean = this.engaged ? this.aimPitch * 0.35 : 0;
    this.spineLean += (lean - this.spineLean) * (1 - Math.exp(-9 * dt));
  }

  public setAim(pitch: number, engaged: boolean): void {
    this.aimPitch = pitch;
    this.engaged = engaged;
  }

  // ------------------------------------------------------------------- death

  // DeathPerformance calls these from begin()/reset(): stop the clips, hand
  // the skeleton to the proxy choreography; restart the clips on respawn.
  public beginDeath(): void {
    if (this.dying) return;
    this.dying = true;
    if (!this.loaded) return;
    this.idleG?.stop();
    this.walkG?.stop();
    this.runG?.stop();
    this.captureDeathPose();
  }

  public endDeath(): void {
    this.dying = false;
    this.deathJoints.length = 0;
    if (!this.loaded) return;
    this.startGroups();
  }

  private captureDeathPose(): void {
    const r = this.r;
    const J = this.joints;
    this.gunArmX0 = r.gunArm.rotation.x;
    this.gunArmZ0 = r.gunArm.rotation.z;
    this.deathJoints.length = 0;
    const add = (key: string, angles: () => { right: number; fwd: number }): void => {
      const joint = J[key];
      if (!joint) return;
      const base = joint.rotationQuaternion ? joint.rotationQuaternion.clone() : Quaternion.FromEulerVector(joint.rotation);
      this.deathJoints.push({ joint, base, angles });
    };
    // ordered parent-first so each offset composes on settled ancestors
    add("Spine1", () => ({ right: r.torso.rotation.x * 0.65, fwd: 0 }));
    add("Spine2", () => ({ right: r.torso.rotation.x * 0.55, fwd: 0 }));
    add("Neck", () => ({ right: r.head.rotation.x * 0.45, fwd: r.head.rotation.z * 0.4 }));
    add("Head", () => ({ right: r.head.rotation.x * 0.65, fwd: r.head.rotation.z * 0.6 }));
    const armAngles = (): { right: number; fwd: number } => ({
      right: r.gunArm.rotation.x - this.gunArmX0,
      fwd: r.gunArm.rotation.z - this.gunArmZ0,
    });
    add("LeftArm", armAngles);
    add("RightArm", armAngles);
    add("LeftUpLeg", () => ({ right: r.hipL.rotation.x, fwd: 0 }));
    add("RightUpLeg", () => ({ right: r.hipR.rotation.x, fwd: 0 }));
    add("LeftLeg", () => ({ right: r.kneeL.rotation.x, fwd: 0 }));
    add("RightLeg", () => ({ right: r.kneeR.rotation.x, fwd: 0 }));
  }

  // -------------------------------------------------------------- pose layer

  // Runs after Babylon evaluates the animation clips each frame: spine aim
  // overlay (alive) or proxy-driven death pose (dead), then arm IK onto the
  // rifle grips, then the hitbox/proxy/mount followers.
  private applyPose(): void {
    if (!this.loaded || !this.r.root.isEnabled()) return;

    if (this.dying) {
      this.applyDeathPose();
    } else if (this.scene.animationsEnabled) {
      this.applyAimOverlay();
    }

    if (this.mountF) {
      this.updateFollower(this.mountF);
      this.r.mountFollower.computeWorldMatrix(true);
    }

    if (!this.dying) this.solveArms();

    for (const f of this.followers) {
      if (f === this.mountF) continue;
      this.updateFollower(f);
    }
  }

  // offset rotation about a character-space axis, composed in parent-local
  // space onto a base quaternion
  private composeOffset(joint: TransformNode, base: Quaternion, rightAngle: number, fwdAngle: number): void {
    const parent = joint.parent as TransformNode;
    parent.computeWorldMatrix(true).invertToRef(CO_M);
    const rootQ = this.r.root.absoluteRotationQuaternion;
    if (!joint.rotationQuaternion) joint.rotationQuaternion = new Quaternion();
    const out = joint.rotationQuaternion;
    if (out !== base) out.copyFrom(base);
    const apply = (worldAxis: Vector3, angle: number): void => {
      if (angle === 0) return;
      worldAxis.rotateByQuaternionToRef(rootQ, CO_AXIS_W);
      Vector3.TransformNormalToRef(CO_AXIS_W, CO_M, CO_AXIS_P);
      CO_AXIS_P.normalize();
      Quaternion.RotationAxisToRef(CO_AXIS_P, angle * this.mirrorSign, CO_Q);
      CO_Q.multiplyToRef(out, out);
    };
    apply(Vector3.RightReadOnly, rightAngle);
    apply(Vector3.LeftHandedForwardReadOnly, fwdAngle);
    joint.computeWorldMatrix(true);
  }

  private applyAimOverlay(): void {
    // aim pitch + the sprint lean Bot writes into the torso proxy
    const angle = this.spineLean + this.r.torso.rotation.x * 0.8;
    if (Math.abs(angle) < 0.002) return;
    for (const key of ["Spine1", "Spine2"]) {
      const joint = this.joints[key];
      if (!joint || !joint.rotationQuaternion) continue;
      this.composeOffset(joint, joint.rotationQuaternion, angle * 0.5, 0);
    }
  }

  private applyDeathPose(): void {
    for (const dj of this.deathJoints) {
      const a = dj.angles();
      this.composeOffset(dj.joint, dj.base, a.right, a.fwd);
    }
  }

  private solveArms(): void {
    for (const arm of this.arms) {
      arm.target.computeWorldMatrix(true);
      arm.pole.computeWorldMatrix(true);
      arm.upper.computeWorldMatrix(true);

      const S = arm.upper.getAbsolutePosition();
      IK_DIR.copyFrom(arm.target.getAbsolutePosition()).subtractInPlace(S);
      let d = IK_DIR.length();
      if (d < 1e-4) continue;
      IK_DIR.scaleInPlace(1 / d);
      d = Math.min(arm.aLen + arm.bLen - 0.005, Math.max(Math.abs(arm.aLen - arm.bLen) + 0.005, d));

      // bend plane from the pole
      IK_PV.copyFrom(arm.pole.getAbsolutePosition()).subtractInPlace(S);
      IK_PV.subtractInPlace(IK_TMP.copyFrom(IK_DIR).scaleInPlace(Vector3.Dot(IK_PV, IK_DIR)));
      if (IK_PV.lengthSquared() < 1e-6) IK_PV.set(0, -1, 0.2);
      IK_PV.normalize();

      const cosS = Math.min(1, Math.max(-1, (arm.aLen * arm.aLen + d * d - arm.bLen * arm.bLen) / (2 * arm.aLen * d)));
      const sinS = Math.sqrt(Math.max(0, 1 - cosS * cosS));
      IK_ELBOW.copyFrom(IK_DIR).scaleInPlace(cosS)
        .addInPlace(IK_TMP.copyFrom(IK_PV).scaleInPlace(sinS)).normalize();

      this.setSegment(arm.upper, arm.dLUpper, arm.bLUpper, IK_ELBOW, IK_PV);
      arm.upper.computeWorldMatrix(true);
      arm.fore.computeWorldMatrix(true);

      // forearm: from the solved elbow toward the (reach-clamped) target
      IK_T.copyFrom(IK_DIR).scaleInPlace(d).addInPlace(S);
      IK_T.subtractInPlace(arm.fore.getAbsolutePosition()).normalize();
      this.setSegment(arm.fore, arm.dLFore, arm.bLFore, IK_T, IK_PV);
      arm.fore.computeWorldMatrix(true);
    }
  }

  // rotate a bone node so its captured local bone-axis/bend-ref frame lands
  // on the desired world directions
  private setSegment(node: TransformNode, dL: Vector3, bL: Vector3, dW: Vector3, bW: Vector3): void {
    const parent = node.parent as TransformNode;
    parent.getWorldMatrix().invertToRef(SS_M);
    Vector3.TransformNormalToRef(dW, SS_M, SS_D);
    SS_D.normalize();
    Vector3.TransformNormalToRef(bW, SS_M, SS_B);
    frameQuat(SS_D, SS_B, SS_Q1); // destination frame in parent space
    frameQuat(dL, bL, SS_Q2); // source frame in node space
    SS_Q2.invertInPlace();
    if (!node.rotationQuaternion) node.rotationQuaternion = new Quaternion();
    SS_Q1.multiplyToRef(SS_Q2, node.rotationQuaternion);
  }

  private updateFollower(f: Follower): void {
    f.joint.computeWorldMatrix(true);
    const wm = f.joint.getWorldMatrix();
    const root = this.r.root;
    UF_INVROOT.copyFrom(root.absoluteRotationQuaternion);
    UF_INVROOT.invertInPlace();
    // world position of the captured joint-local anchor -> root-local
    Vector3.TransformCoordinatesToRef(f.relPos, wm, UF_POS);
    UF_POS.subtractInPlace(root.getAbsolutePosition());
    UF_POS.rotateByQuaternionToRef(UF_INVROOT, f.node.position);

    if (f.relDir && f.relRef) {
      Vector3.TransformNormalToRef(f.relDir, wm, UF_D);
      Vector3.TransformNormalToRef(f.relRef, wm, UF_R);
      frameQuat(UF_D.normalize(), UF_R, UF_Q);
      if (!f.node.rotationQuaternion) f.node.rotationQuaternion = new Quaternion();
      UF_INVROOT.multiplyToRef(UF_Q, f.node.rotationQuaternion);
    }
  }
}
