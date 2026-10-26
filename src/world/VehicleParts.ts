import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Material, Scene, TransformNode } from "@babylonjs/core";
import { canvasMat, flatMat } from "../rendering/materials/canvas";
import { makeStaticHelpers } from "./wreckShared";

type Point = readonly [number, number, number];

// Small, scene-cached surfaces shared by both wrecks. Interior finishes stay
// matte; the weathered bodywork and bare hardware catch the yard reflections.
export function vehicleMaterials(scene: Scene) {
  let seed = 0x8af135;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const cloth = canvasMat(scene, "vehicleClothMat", 256, { rough: 0.96, bump: 0.28 }, (ctx, s) => {
    ctx.fillStyle = "#655c50";
    ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 3) {
      ctx.fillStyle = y % 2 ? "#5c554b" : "#756b5c";
      ctx.fillRect(0, y, s, 1);
    }
    for (let x = 0; x < s; x += 3) {
      ctx.fillStyle = "rgba(34,32,28,0.17)";
      ctx.fillRect(x, 0, 1, s);
    }
    for (let i = 0; i < 22; i++) {
      ctx.fillStyle = i % 2 ? "rgba(28,26,22,0.09)" : "rgba(185,172,143,0.1)";
      ctx.beginPath();
      ctx.ellipse(random() * s, random() * s, 4 + random() * 22, 3 + random() * 13, random(), 0, Math.PI * 2);
      ctx.fill();
    }
  });
  const plastic = canvasMat(scene, "vehicleDashMat", 128, { rough: 0.84, bump: 0.16 }, (ctx, s) => {
    ctx.fillStyle = "#343736";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 3200; i++) {
      ctx.fillStyle = i % 2 ? "rgba(118,122,113,0.18)" : "rgba(7,12,10,0.2)";
      ctx.fillRect(random() * s, random() * s, 1, 1);
    }
  });
  const rubber = canvasMat(scene, "vehicleRubberMat", 128, { rough: 0.95, bump: 0.45 }, (ctx, s) => {
    ctx.fillStyle = "#222625";
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = "#111614";
    ctx.lineWidth = 2;
    for (let y = -16; y < s + 16; y += 12) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(s / 2, y + 9);
      ctx.lineTo(s, y);
      ctx.stroke();
    }
  });
  const carpet = canvasMat(scene, "vehicleCarpetMat", 128, { rough: 1, bump: 0.25 }, (ctx, s) => {
    ctx.fillStyle = "#3a3932";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 5000; i++) {
      ctx.fillStyle = i % 2 ? "rgba(124,116,94,0.2)" : "rgba(10,13,11,0.25)";
      ctx.fillRect(random() * s, random() * s, 1, 2);
    }
  });
  const paint = (name: string, base: string) =>
    canvasMat(scene, name, 256, { rough: 0.54, metal: 0.28, wet: 0.2, bump: 0.05 }, (ctx, s) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 18; i++) {
        const x = random() * s;
        const g = ctx.createLinearGradient(0, 0, 0, s);
        g.addColorStop(0, "rgba(50,48,35,0.05)");
        g.addColorStop(1, "rgba(50,48,35,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, 0.8 + random() * 1.2, s);
      }
      for (let i = 0; i < 100; i++) {
        ctx.fillStyle = i % 3 ? "rgba(103,77,49,0.22)" : "rgba(232,231,214,0.35)";
        ctx.fillRect(random() * s, random() * s, 1 + random() * 3, 1 + random() * 2);
      }
    });
  return {
    cloth,
    plastic,
    rubber,
    carpet,
    cabPaint: paint("truckCabPaintMat", "#aaa99c"),
    cargoPaint: paint("truckCargoPaintMat", "#b8bcb5"),
    insert: flatMat(scene, "vehicleSeatInsertMat", { albedo: [0.19, 0.18, 0.15], rough: 0.96, tex: cloth.albedoTexture }),
    stitch: flatMat(scene, "vehicleStitchMat", { albedo: [0.38, 0.34, 0.27], rough: 1 }),
    recess: flatMat(scene, "vehicleRecessMat", { albedo: [0.025, 0.032, 0.03], rough: 0.95 }),
    buckle: flatMat(scene, "vehicleBuckleMat", { albedo: [0.32, 0.075, 0.045], rough: 0.8 }),
    amber: flatMat(scene, "vehicleAmberMat", { albedo: [0.64, 0.27, 0.055], rough: 0.36 }),
  };
}

// Rounded cuboids use a small grid on each face, with the edge vertices
// projected around an inner box. This gives cushions, plastic mouldings and
// sheet-metal corners real highlights without subdivision-sized meshes.
function roundedBox(scene: Scene, name: string, w: number, h: number, d: number, radius: number, tilesPerMeter: number): Mesh {
  const half = [w / 2, h / 2, d / 2];
  const r = Math.min(radius, Math.min(...half) * 0.9);
  const inner = half.map((v) => v - r);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (const sign of [-1, 1]) {
      const start = positions.length / 3;
      const us = [-half[u], -inner[u], inner[u], half[u]];
      const vs = [-half[v], -inner[v], inner[v], half[v]];
      for (const py of vs) {
        for (const px of us) {
          const p = [0, 0, 0];
          p[axis] = sign * half[axis];
          p[u] = px;
          p[v] = py;
          const c = p.map((value, i) => Math.max(-inner[i], Math.min(inner[i], value)));
          const n = p.map((value, i) => value - c[i]);
          const length = Math.hypot(...n);
          positions.push(...c.map((value, i) => value + (n[i] / length) * r));
          normals.push(...n.map((value) => value / length));
          uvs.push(
            tilesPerMeter ? (px + half[u]) * tilesPerMeter : (px + half[u]) / (2 * half[u]),
            tilesPerMeter ? (py + half[v]) * tilesPerMeter : (py + half[v]) / (2 * half[v])
          );
        }
      }
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          const a = start + y * 4 + x;
          if (sign > 0) indices.push(a, a + 4, a + 1, a + 1, a + 4, a + 5);
          else indices.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
        }
      }
    }
  }
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  Object.assign(data, { positions, normals, uvs, indices });
  data.applyToMesh(mesh);
  return mesh;
}

export class VehicleParts {
  private scene: Scene;
  public readonly stat: ReturnType<typeof makeStaticHelpers>["stat"];
  public readonly box: ReturnType<typeof makeStaticHelpers>["box"];
  public readonly mats: ReturnType<typeof vehicleMaterials>;

  constructor(scene: Scene, root: TransformNode, registerStatic: (mat: Material, mesh: Mesh) => void) {
    this.scene = scene;
    const helpers = makeStaticHelpers(scene, root, registerStatic);
    this.stat = helpers.stat;
    this.box = helpers.box;
    this.mats = vehicleMaterials(scene);
  }

  public soft(
    name: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: Material,
    radius = 0.03,
    tilt = 0
  ): Mesh {
    const mesh = roundedBox(this.scene, name, w, h, d, radius, mat.name.startsWith("vehicle") ? 3 : 0);
    mesh.position.set(x, y, z);
    mesh.rotation.z = tilt;
    return this.stat(mesh, mat);
  }

  public rod(name: string, from: Point, to: Point, radius: number, mat: Material): Mesh {
    const a = Vector3.FromArray(from);
    const b = Vector3.FromArray(to);
    const direction = b.subtract(a);
    const mesh = MeshBuilder.CreateCylinder(
      name,
      { height: direction.length(), diameter: radius * 2, tessellation: 8 },
      this.scene
    );
    mesh.position.copyFrom(a.add(b).scaleInPlace(0.5));
    mesh.rotationQuaternion = new Quaternion();
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), direction.normalize(), mesh.rotationQuaternion);
    return this.stat(mesh, mat);
  }

  public wheel(
    name: string,
    x: number,
    y: number,
    z: number,
    diameter: number,
    width: number,
    side: number,
    steel: Material
  ): void {
    const tire = MeshBuilder.CreateCylinder(`${name}_tire`, { height: width, diameter, tessellation: 28 }, this.scene);
    tire.position.set(x, y, z);
    tire.rotation.x = Math.PI / 2;
    this.stat(tire, this.mats.rubber);
    const face = z + side * (width / 2 + 0.004);
    const disc = (part: string, r: number, px: number, py: number, pz: number, mat: Material): void => {
      const mesh = MeshBuilder.CreateCylinder(
        `${name}_${part}`,
        // Lug nuts are hexagonal; tiny vent recesses don't need rim-sized rings.
        { height: 0.012, diameter: r * 2, tessellation: r < 0.012 ? 6 : r < diameter * 0.05 ? 8 : 16 },
        this.scene
      );
      mesh.position.set(px, py, pz);
      mesh.rotation.x = Math.PI / 2;
      this.stat(mesh, mat);
    };
    const shoulder = MeshBuilder.CreateTorus(
      `${name}_shoulder`,
      { diameter: diameter * 0.84, thickness: diameter * 0.12, tessellation: 28 },
      this.scene
    );
    shoulder.position.set(x, y, face - side * diameter * 0.065);
    shoulder.rotation.x = Math.PI / 2;
    this.stat(shoulder, this.mats.rubber);
    disc("rim", diameter * 0.29, x, y, face, steel);
    disc("dish", diameter * 0.225, x, y, face + side * 0.008, this.mats.plastic);
    disc("hub", diameter * 0.105, x, y, face + side * 0.023, steel);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      disc(
        `vent${i}`,
        diameter * 0.035,
        x + Math.cos(angle) * diameter * 0.185,
        y + Math.sin(angle) * diameter * 0.185,
        face + side * 0.014,
        this.mats.recess
      );
      disc(
        `lug${i}`,
        0.009,
        x + Math.cos(angle) * diameter * 0.075,
        y + Math.sin(angle) * diameter * 0.075,
        face + side * 0.033,
        steel
      );
    }
  }

  // The upper half of a wheel opening, with actual depth and a rolled lip.
  // The remaining lower door panels meet this curve at floorY.
  public arch(
    name: string,
    x: number,
    y: number,
    z: number,
    radius: number,
    floorY: number,
    topY: number,
    side: number,
    paint: Material
  ): number {
    const start = Math.asin((floorY - y) / radius);
    const outside: Vector3[] = [];
    const inside: Vector3[] = [];
    const top: Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = start + ((Math.PI - 2 * start) * i) / 16;
      const px = x + Math.cos(a) * radius;
      const py = y + Math.sin(a) * radius;
      outside.push(new Vector3(px, py, z));
      inside.push(new Vector3(px, py, z - side * 0.15));
      top.push(new Vector3(px, topY, z));
    }
    this.stat(
      MeshBuilder.CreateRibbon(`${name}_panel`, { pathArray: [outside, top], sideOrientation: Mesh.DOUBLESIDE }, this.scene),
      paint
    );
    this.stat(
      MeshBuilder.CreateRibbon(`${name}_liner`, { pathArray: [outside, inside], sideOrientation: Mesh.DOUBLESIDE }, this.scene),
      this.mats.recess
    );
    this.stat(MeshBuilder.CreateTube(`${name}_lip`, { path: outside, radius: 0.011, tessellation: 6 }, this.scene), paint);
    return Math.sqrt(radius * radius - (floorY - y) ** 2);
  }

  public seat(name: string, x: number, y: number, z: number, width: number, floorY: number, steel: Material): void {
    const { cloth, insert, stitch, plastic, recess, buckle } = this.mats;
    for (const side of [-1, 1])
      this.box(`${name}_rail${side}`, 0.49, 0.025, 0.035, x, floorY + 0.018, z + side * width * 0.32, steel);
    const pedestalH = y - 0.075 - floorY - 0.035;
    this.soft(`${name}_pedestal`, 0.36, pedestalH, width * 0.72, x, floorY + 0.035 + pedestalH / 2, z, plastic);
    this.soft(`${name}_cushion`, 0.51, 0.15, width, x, y, z, cloth, 0.055);
    this.soft(`${name}_insert`, 0.37, 0.025, width * 0.68, x + 0.025, y + 0.075, z, insert, 0.01);
    const backX = x - 0.25;
    const backY = y + 0.33;
    this.soft(`${name}_back`, 0.15, 0.52, width, backX, backY, z, cloth, 0.05, 0.14);
    this.soft(`${name}_backInsert`, 0.028, 0.4, width * 0.65, backX + 0.075, backY, z, insert, 0.012, 0.14);
    for (const side of [-1, 1]) {
      this.rod(
        `${name}_cushionStitch${side}`,
        [x - 0.17, y + 0.09, z + side * width * 0.35],
        [x + 0.2, y + 0.09, z + side * width * 0.35],
        0.002,
        stitch
      );
      this.rod(
        `${name}_backStitch${side}`,
        [backX + 0.107, backY - 0.19, z + side * width * 0.34],
        [backX + 0.053, backY + 0.19, z + side * width * 0.34],
        0.002,
        stitch
      );
      this.rod(
        `${name}_headPost${side}`,
        [backX - 0.035, backY + 0.23, z + side * width * 0.17],
        [backX - 0.035, backY + 0.31, z + side * width * 0.17],
        0.009,
        steel
      );
    }
    this.soft(`${name}_headrest`, 0.14, 0.14, width * 0.57, backX - 0.045, backY + 0.34, z, cloth, 0.04, 0.14);
    this.soft(
      `${name}_beltBuckle`,
      0.06,
      0.065,
      0.035,
      x - 0.06,
      y + 0.075,
      z - Math.sign(z) * (width / 2 + 0.025),
      recess,
      0.01,
      -0.2
    );
    this.box(`${name}_release`, 0.035, 0.008, 0.027, x - 0.06, y + 0.111, z - Math.sign(z) * (width / 2 + 0.025), buckle);
  }

  public steering(name: string, center: Point, diameter: number, tilt: number, steel: Material, columnLength = 0.21): void {
    const [x, y, z] = center;
    const rim = MeshBuilder.CreateTorus(`${name}_rim`, { diameter, thickness: 0.026, tessellation: 28 }, this.scene);
    rim.position.set(x, y, z);
    rim.rotation.z = tilt;
    this.stat(rim, this.mats.plastic);
    const hub = MeshBuilder.CreateCylinder(`${name}_hub`, { height: 0.045, diameter: 0.085, tessellation: 16 }, this.scene);
    hub.position.set(x, y, z);
    hub.rotation.z = tilt;
    this.stat(hub, this.mats.plastic);
    for (const [i, a] of [Math.PI / 2, Math.PI * 1.5, Math.PI].entries()) {
      const r = diameter * 0.43;
      this.rod(
        `${name}_spoke${i}`,
        center,
        [x + Math.cos(tilt) * Math.cos(a) * r, y + Math.sin(tilt) * Math.cos(a) * r, z + Math.sin(a) * r],
        0.01,
        steel
      );
    }
    this.rod(
      `${name}_column`,
      [x + Math.sin(tilt) * 0.025, y - Math.cos(tilt) * 0.025, z],
      [x + Math.sin(tilt) * columnLength, y - Math.cos(tilt) * columnLength, z],
      0.022,
      this.mats.plastic
    );
    this.rod(`${name}_indicator`, [x + 0.065, y - 0.04, z + 0.025], [x + 0.07, y - 0.025, z + 0.15], 0.007, this.mats.recess);
  }

  public instruments(name: string, x: number, y: number, z: number, width: number): void {
    const truck = name.startsWith("truck");
    const matName = truck ? "truckInstrumentsMat" : "carInstrumentsMat";
    let mat = this.scene.getMaterialByName(matName);
    if (!mat) {
      const tex = new DynamicTexture(`${matName}_tex`, { width: 512, height: 192 }, this.scene, true);
      const ctx = tex.getContext() as CanvasRenderingContext2D;
      ctx.fillStyle = "#171d1b";
      ctx.fillRect(0, 0, 512, 192);
      const gauge = (cx: number, cy: number, r: number, label: string, max: number): void => {
        ctx.fillStyle = "#858c80";
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#0c1210";
        ctx.beginPath();
        ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i <= 24; i++) {
          const a = Math.PI * (0.75 + (i / 24) * 1.5);
          ctx.strokeStyle = "#c4c5ae";
          ctx.lineWidth = i % 3 === 0 ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8));
          ctx.lineTo(cx + Math.cos(a) * (r - (i % 3 === 0 ? 19 : 13)), cy + Math.sin(a) * (r - (i % 3 === 0 ? 19 : 13)));
          ctx.stroke();
          if (i % 6 === 0) {
            ctx.font = "12px Arial";
            ctx.fillStyle = "#b7bca8";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String((i / 24) * max), cx + Math.cos(a) * (r - 29), cy + Math.sin(a) * (r - 29));
          }
        }
        ctx.strokeStyle = "#b46c43";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx + 7, cy - 7);
        ctx.lineTo(cx - r * 0.55, cy + r * 0.55);
        ctx.stroke();
        ctx.fillStyle = "#575e51";
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#a4ac96";
        ctx.font = "11px Arial";
        ctx.textAlign = "center";
        ctx.fillText(label, cx, cy + r * 0.53);
      };
      gauge(100, 91, 75, "km/h", truck ? 120 : 160);
      gauge(267, 91, 75, "RPM x1000", truck ? 4 : 8);
      gauge(415, 70, 42, "FUEL", 1);
      ctx.fillStyle = "#626c59";
      ctx.fillRect(365, 129, 105, 25);
      ctx.fillStyle = "#242c23";
      ctx.font = "18px monospace";
      ctx.fillText(truck ? "312406" : "184206", 418, 147);
      tex.update();
      mat = flatMat(this.scene, matName, { albedo: [1, 1, 1], rough: 0.5, tex });
    }
    const height = width * (192 / 512);
    this.soft(`${name}_binnacle`, 0.09, height + 0.034, width + 0.04, x + 0.03, y, z, this.mats.plastic, 0.025);
    const panel = MeshBuilder.CreatePlane(`${name}_dials`, { width, height }, this.scene);
    panel.position.set(x - 0.017, y, z);
    panel.rotation.y = Math.PI / 2;
    this.stat(panel, mat);
  }

  public door(name: string, x: number, y: number, z: number, width: number, height: number, side: number, steel: Material): void {
    const { plastic, cloth, recess } = this.mats;
    this.soft(`${name}_liner`, width, height, 0.035, x, y, z, plastic, 0.016);
    this.soft(`${name}_cloth`, width * 0.6, height * 0.48, 0.012, x - 0.07, y, z - side * 0.023, cloth, 0.005);
    this.soft(`${name}_armrest`, width * 0.45, 0.045, 0.065, x, y + height * 0.2, z - side * 0.045, plastic, 0.018);
    this.box(`${name}_handleWell`, 0.13, 0.045, 0.009, x + width * 0.24, y + height * 0.25, z - side * 0.025, recess);
    this.rod(
      `${name}_handle`,
      [x + width * 0.19, y + height * 0.25, z - side * 0.035],
      [x + width * 0.28, y + height * 0.25, z - side * 0.035],
      0.007,
      steel
    );
    this.rod(
      `${name}_crank`,
      [x - width * 0.22, y - height * 0.03, z - side * 0.035],
      [x - width * 0.16, y - height * 0.19, z - side * 0.035],
      0.006,
      steel
    );
    this.soft(`${name}_crankKnob`, 0.025, 0.025, 0.025, x - width * 0.16, y - height * 0.19, z - side * 0.047, plastic, 0.01);
    this.soft(`${name}_speaker`, 0.12, 0.09, 0.012, x + width * 0.27, y - height * 0.25, z - side * 0.025, recess, 0.02);
    for (let i = 0; i < 4; i++)
      this.box(
        `${name}_speakerRib${i}`,
        0.096,
        0.006,
        0.005,
        x + width * 0.27,
        y - height * 0.25 - 0.028 + i * 0.018,
        z - side * 0.034,
        plastic
      );
  }

  public plate(name: string, x: number, y: number, width: number, front: boolean, registration: string): void {
    const matName = `vehiclePlateMat_${registration}`;
    let mat = this.scene.getMaterialByName(matName);
    if (!mat) {
      const tex = new DynamicTexture(`${matName}_tex`, { width: 256, height: 96 }, this.scene, true);
      const ctx = tex.getContext() as CanvasRenderingContext2D;
      ctx.fillStyle = "#b8b59e";
      ctx.fillRect(0, 0, 256, 96);
      ctx.strokeStyle = "#53594e";
      ctx.lineWidth = 4;
      ctx.strokeRect(5, 5, 246, 86);
      ctx.fillStyle = "#252f29";
      ctx.textAlign = "center";
      ctx.font = "bold 44px monospace";
      ctx.fillText(registration, 128, 66);
      for (const sx of [17, 239]) {
        ctx.beginPath();
        ctx.arc(sx, 15, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      tex.update();
      mat = flatMat(this.scene, matName, { albedo: [1, 1, 1], rough: 0.65, tex });
    }
    const plate = MeshBuilder.CreatePlane(name, { width, height: width * (96 / 256) }, this.scene);
    plate.position.set(x, y, 0);
    plate.rotation.y = front ? -Math.PI / 2 : Math.PI / 2;
    this.stat(plate, mat);
  }
}
