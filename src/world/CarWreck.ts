import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh, PickingInfo, Scene, Mesh, Material, ParticleSystem } from "@babylonjs/core";
import type { WorldMaterials } from "./materials/WorldMaterials";
import type { Effects } from "../rendering/Effects";
import type { GlassPane } from "./wreckShared";
import { VehicleParts } from "./VehicleParts";
import { getOrCreateColorMat, applyLaminatedGlass, addTemperedQuad, createGlassShardSystem, hitGlassPane } from "./wreckShared";

// Weathered abandoned car. The body is static dressing (merged with the rest
// of the map via the registerStatic callback), but every window is its own
// pickable pane wired into the weapons' hitscan: laminated front/rear glass
// webs at the impact UV and collapses on the third hit, tempered side glass
// bursts immediately — shards spray from the opening either way.
export class CarWreck {
  private scene: Scene;
  private root: TransformNode;
  private panes = new Map<AbstractMesh, GlassPane>();
  private shards: ParticleSystem;
  private shardAnchor = new Vector3();

  constructor(
    scene: Scene,
    materials: WorldMaterials,
    position: Vector3,
    yaw: number,
    registerStatic: (mat: Material, mesh: Mesh) => void
  ) {
    this.scene = scene;

    this.root = new TransformNode("carRoot", scene);
    this.root.position.copyFrom(position);
    this.root.rotation.y = yaw;

    // --- Materials ---
    const paintMat = materials.createCarBodyMaterial();

    const darkMat = getOrCreateColorMat(scene, "carTrimDarkMat", new Color3(0.07, 0.07, 0.08), new Color3(0.06, 0.06, 0.07), 16);
    const steelMat = getOrCreateColorMat(scene, "carSteelMat", new Color3(0.42, 0.44, 0.47), new Color3(0.5, 0.52, 0.55), 48);
    const lampMat = getOrCreateColorMat(
      scene,
      "carLampMat",
      new Color3(0.75, 0.78, 0.72),
      new Color3(0.6, 0.6, 0.6),
      64,
      new Color3(0.12, 0.12, 0.1)
    );
    const tailMat = getOrCreateColorMat(
      scene,
      "carTailLampMat",
      new Color3(0.45, 0.08, 0.07),
      new Color3(0.4, 0.3, 0.3),
      48,
      new Color3(0.1, 0.015, 0.012)
    );

    // Local frame before yaw: +x is the nose, z spans the width.
    const parts = new VehicleParts(scene, this.root, registerStatic);
    const { stat, box } = parts;
    const { plastic, cloth, carpet, rubber, recess, amber } = parts.mats;

    // --- Body shell. The cabin is a real cavity: door walls either side,
    // solid engine bay ahead of the firewall, solid trunk behind the seats,
    // and a low floor pan between them — looking through any window reads
    // depth and the far glass, not a closed deck. ---
    for (const side of [-1, 1]) {
      parts.soft(`car_shoulder${side}`, 4.28, 0.24, 0.16, 0, 0.8, 0.77 * side, paintMat, 0.025);
      const span = parts.arch(`car_archF${side}`, 1.45, 0.31, 0.85 * side, 0.36, 0.34, 0.69, side, paintMat);
      parts.arch(`car_archR${side}`, -1.45, 0.31, 0.85 * side, 0.36, 0.34, 0.69, side, paintMat);
      box(`car_lowerDoor${side}`, (1.45 - span) * 2, 0.35, 0.16, 0, 0.515, 0.77 * side, paintMat);
      for (const end of [-1, 1]) {
        const endW = 2.14 - 1.45 - span;
        box(`car_lowerEnd${side}_${end}`, endW, 0.35, 0.16, (2.14 - endW / 2) * end, 0.515, 0.77 * side, paintMat);
        const well = MeshBuilder.CreateCylinder(
          `car_wheelWell${side}_${end}`,
          { height: 0.012, diameter: 0.72, tessellation: 24 },
          scene
        );
        well.position.set(1.45 * end, 0.31, 0.704 * side);
        well.rotation.x = Math.PI / 2;
        stat(well, recess);
      }
    }
    parts.soft("car_nose", 1.6, 0.58, 1.38, 1.34, 0.63, 0, paintMat, 0.065);
    parts.soft("car_tail", 0.56, 0.58, 1.38, -1.86, 0.63, 0, paintMat, 0.045);
    box("car_floorPan", 2.12, 0.1, 1.38, -0.52, 0.39, 0, darkMat); // cabin floor
    box("car_skirtL", 2.1, 0.1, 0.045, 0, 0.37, 0.86, darkMat);
    box("car_skirtR", 2.1, 0.1, 0.045, 0, 0.37, -0.86, darkMat);
    parts.soft("car_hood", 1.55, 0.06, 1.58, 1.28, 0.93, 0, paintMat, 0.022, -0.045);
    box("car_cowl", 0.14, 0.035, 1.5, 0.49, 0.945, 0, darkMat); // wiper well
    parts.soft("car_trunk", 0.52, 0.06, 1.58, -1.88, 0.94, 0, paintMat, 0.02, 0.03);
    parts.soft("car_roof", 1.78, 0.05, 1.5, -0.55, 1.41, 0, paintMat, 0.02);

    // Pillars framing the glass openings. A pillar's long axis is vertical,
    // so its lean is the complement of the glass slab's rotation: A-pillars
    // rake back parallel to the windshield, C-pillars forward to match the
    // rear glass.
    for (const side of [-1, 1]) {
      box(`car_pillarA${side}`, 0.06, 0.6, 0.07, 0.41, 1.16, 0.725 * side, paintMat, 0.62);
      box(`car_pillarB${side}`, 0.055, 0.48, 0.05, -0.52, 1.15, 0.755 * side, paintMat);
      box(`car_pillarC${side}`, 0.06, 0.56, 0.07, -1.5, 1.16, 0.71 * side, paintMat, -0.52);
    }

    // --- Running gear ---
    for (const [wx, wz] of [
      [1.45, 0.84],
      [1.45, -0.84],
      [-1.45, 0.84],
      [-1.45, -0.84],
    ]) {
      parts.wheel(`car_wheel_${wx}_${wz}`, wx, 0.31, wz, 0.62, 0.24, Math.sign(wz), steelMat);
    }

    // --- Nose / tail dressing ---
    const bumperF = MeshBuilder.CreateCapsule(
      "car_bumperF",
      { radius: 0.075, height: 1.78, tessellation: 12, capSubdivisions: 4 },
      scene
    );
    bumperF.position.set(2.18, 0.5, 0);
    bumperF.rotation.x = Math.PI / 2; // lie across the nose
    stat(bumperF, darkMat);

    const bumperR = bumperF.clone("car_bumperR");
    bumperR.position.set(-2.18, 0.5, 0);
    stat(bumperR as Mesh, darkMat);

    box("car_grille", 0.025, 0.16, 1.0, 2.15, 0.74, 0, recess);
    for (let i = 0; i < 5; i++) box(`car_grilleSlat${i}`, 0.012, 0.009, 0.92, 2.168, 0.683 + i * 0.028, 0, steelMat);
    for (const side of [-1, 1]) {
      const lamp = MeshBuilder.CreateCylinder(`car_headlamp${side}`, { height: 0.035, diameter: 0.17, tessellation: 20 }, scene);
      lamp.position.set(2.17, 0.78, 0.56 * side);
      lamp.rotation.z = Math.PI / 2; // face forward
      stat(lamp, lampMat);
      const bezel = MeshBuilder.CreateTorus(
        `car_lampBezel${side}`,
        { diameter: 0.19, thickness: 0.018, tessellation: 24 },
        scene
      );
      bezel.position.set(2.16, 0.78, 0.56 * side);
      bezel.rotation.z = Math.PI / 2;
      stat(bezel, steelMat);

      box(`car_taillamp${side}`, 0.035, 0.1, 0.3, -2.15, 0.78, 0.58 * side, tailMat);
      parts.soft(`car_mirror${side}`, 0.11, 0.075, 0.15, 0.45, 1.04, 0.91 * side, plastic, 0.025);
      box(`car_mirrorLens${side}`, 0.006, 0.052, 0.11, 0.391, 1.04, 0.91 * side, steelMat);
      parts.rod(`car_mirrorStalk${side}`, [0.49, 0.98, 0.81 * side], [0.45, 1.02, 0.9 * side], 0.012, darkMat);
      box(`car_handleWellF${side}`, 0.16, 0.047, 0.009, 0.12, 0.87, 0.853 * side, recess);
      box(`car_handleWellR${side}`, 0.16, 0.047, 0.009, -0.78, 0.87, 0.853 * side, recess);
      box(`car_handleF${side}`, 0.12, 0.02, 0.019, 0.12, 0.87, 0.865 * side, steelMat);
      box(`car_handleR${side}`, 0.12, 0.02, 0.019, -0.78, 0.87, 0.865 * side, steelMat);
      box(`car_indicator${side}`, 0.03, 0.055, 0.11, 2.158, 0.63, 0.62 * side, amber);
      box(`car_beltline${side}`, 4.1, 0.018, 0.013, 0, 0.7, 0.856 * side, darkMat);
      box(`car_windowSill${side}`, 1.94, 0.02, 0.022, -0.54, 0.927, 0.752 * side, darkMat);
      for (const x of [0.46, -0.52, -1.43]) {
        parts.rod(`car_doorGap${side}_${x}`, [x, x < -1 ? 0.7 : 0.43, 0.853 * side], [x, 0.912, 0.853 * side], 0.003, recess);
      }
      parts.rod(`car_wiperArm${side}`, [0.614, 0.919, 0.34 * side], [0.542, 1.006, 0.38 * side], 0.006, darkMat);
      parts.soft(`car_wiperBlade${side}`, 0.013, 0.01, 0.34, 0.542, 1.006, 0.38 * side, recess, 0.004);
    }
    parts.plate("car_plateF", 2.261, 0.51, 0.34, true, "SBX 074");
    parts.plate("car_plateR", -2.261, 0.51, 0.34, false, "SBX 074");

    const exhaust = MeshBuilder.CreateCylinder("car_exhaust", { height: 0.14, diameter: 0.07, tessellation: 10 }, scene);
    exhaust.position.set(-2.12, 0.28, 0.45);
    exhaust.rotation.z = Math.PI / 2;
    stat(exhaust, steelMat);

    // --- Interior (visible through the glass, shootable once it breaks) ---
    box("car_carpet", 2.1, 0.015, 1.33, -0.52, 0.448, 0, carpet);
    parts.soft("car_headliner", 1.68, 0.012, 1.38, -0.55, 1.378, 0, cloth, 0.005);
    parts.soft("car_dash", 0.3, 0.15, 1.35, 0.4, 0.86, 0, plastic, 0.045);
    parts.soft("car_dashTop", 0.32, 0.035, 1.37, 0.4, 0.94, 0, plastic, 0.015);
    parts.instruments("car_instruments", 0.228, 0.914, 0.4, 0.34);
    parts.soft("car_console", 0.65, 0.21, 0.19, -0.08, 0.56, 0, plastic, 0.035);
    parts.soft("car_rearShelf", 0.24, 0.04, 1.35, -1.52, 0.88, 0, carpet, 0.015);
    parts.soft("car_mirror", 0.04, 0.065, 0.22, 0.32, 1.27, 0, plastic, 0.015);
    box("car_rearviewLens", 0.005, 0.045, 0.18, 0.296, 1.27, 0, steelMat);
    parts.rod("car_mirrorStem", [0.32, 1.29, 0], [0.29, 1.365, 0], 0.009, darkMat);
    parts.steering("car_steering", [0.1, 0.93, 0.42], 0.34, 1.15, steelMat);

    for (const side of [-1, 1]) {
      parts.seat(`car_frontSeat${side}`, -0.25, 0.63, 0.42 * side, 0.48, 0.456, steelMat);
      parts.door(`car_doorF${side}`, -0.02, 0.735, 0.677 * side, 0.88, 0.3, side, steelMat);
      parts.door(`car_doorR${side}`, -1.0, 0.735, 0.677 * side, 0.79, 0.3, side, steelMat);
      box(`car_floorMat${side}`, 0.55, 0.015, 0.4, 0.15, 0.465, 0.42 * side, rubber);
      box(`car_parkedSeatbelt${side}`, 0.027, 0.6, 0.012, -0.52, 0.94, 0.686 * side, recess);
      parts.soft(`car_beltAnchor${side}`, 0.06, 0.07, 0.025, -0.52, 1.23, 0.68 * side, plastic, 0.01);
      parts.soft(`car_visor${side}`, 0.22, 0.026, 0.41, 0.09, 1.365, 0.39 * side, cloth, 0.012);
    }
    parts.soft("car_benchBase", 0.55, 0.19, 1.32, -1.0, 0.6, 0, cloth, 0.065);
    parts.soft("car_benchBack", 0.15, 0.48, 1.32, -1.28, 0.95, 0, cloth, 0.05, 0.18);
    for (const z of [-0.43, 0, 0.43]) {
      parts.soft(`car_benchInsert${z}`, 0.025, 0.34, 0.32, -1.2, 0.95, z, parts.mats.insert, 0.01, 0.18);
    }
    for (const z of [0.32, 0.43, 0.54]) parts.soft(`car_pedal${z}`, 0.035, 0.07, 0.065, 0.32, 0.56, z, rubber, 0.01, -0.28);
    parts.soft("car_gearBoot", 0.12, 0.06, 0.11, -0.05, 0.685, 0, rubber, 0.025);
    parts.rod("car_gearLever", [-0.05, 0.7, 0], [-0.1, 0.8, 0], 0.009, steelMat);
    parts.soft("car_gearKnob", 0.045, 0.045, 0.045, -0.1, 0.8, 0, plastic, 0.02);
    parts.rod("car_handbrake", [-0.41, 0.66, -0.1], [-0.25, 0.7, -0.1], 0.015, rubber);
    box("car_radioFace", 0.012, 0.085, 0.25, 0.243, 0.859, -0.06, recess);
    box("car_radioDisplay", 0.006, 0.025, 0.12, 0.233, 0.873, -0.05, parts.mats.stitch);
    for (const z of [-0.145, 0.025]) parts.rod(`car_radioKnob${z}`, [0.225, 0.857, z], [0.24, 0.857, z], 0.014, plastic);
    for (let i = 0; i < 5; i++) box(`car_radioButton${i}`, 0.009, 0.009, 0.022, 0.233, 0.833, -0.115 + i * 0.033, plastic);
    parts.soft("car_gloveBox", 0.012, 0.085, 0.4, 0.243, 0.851, -0.43, plastic, 0.005);
    box("car_gloveLatch", 0.008, 0.015, 0.06, 0.233, 0.879, -0.43, steelMat);
    for (const vz of [-0.6, -0.22, 0.17, 0.61]) {
      box(`car_vent${vz}`, 0.012, 0.035, 0.075, 0.236, 0.912, vz, recess);
      for (let i = 0; i < 3; i++) box(`car_ventSlat${vz}_${i}`, 0.008, 0.004, 0.065, 0.227, 0.9 + i * 0.011, vz, plastic);
    }

    const antenna = MeshBuilder.CreateCylinder("car_antenna", { height: 0.42, diameter: 0.014, tessellation: 8 }, scene);
    antenna.position.set(0.42, 1.2, -0.78);
    stat(antenna, steelMat);

    // --- Glass (interactive, NOT merged) ---
    this.addPane("car_windshield", 0.66, 1.42, 0.42, 1.16, 0, -0.95, true);
    this.addPane("car_rearGlass", 0.52, 1.38, -1.52, 1.17, 0, 1.05, true);
    for (const side of [-1, 1]) {
      // The front and rear trapezoids follow the A- and C-pillars and
      // taper inward toward the roof. Leave room for the rubber seals.
      const corner = (x: number, y: number): Vector3 => new Vector3(x, y, side * (0.752 - ((y - 0.941) / 0.434) * 0.017));
      const front = [corner(-0.484, 0.941), corner(0.523, 0.941), corner(0.216, 1.375), corner(-0.484, 1.375)];
      const rear = [corner(-1.584, 0.941), corner(-0.556, 0.941), corner(-0.556, 1.375), corner(-1.339, 1.375)];
      for (const [name, corners] of [
        [`car_glassF${side}`, front],
        [`car_glassR${side}`, rear],
      ] as const) {
        addTemperedQuad(scene, this.root, this, this.panes, name, corners);
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          parts.rod(`${name}_seal${i}`, [a.x, a.y, a.z + side * 0.003], [b.x, b.y, b.z + side * 0.003], 0.008, rubber);
        }
      }
    }

    // --- Shard burst (shared, manual-emit) ---
    this.shards = createGlassShardSystem(scene, materials, "carGlassShards", this.shardAnchor);
  }

  // Laminated pane: thin slab with its own crack texture
  private addPane(name: string, w: number, d: number, x: number, y: number, z: number, rotZ: number, laminated: boolean): void {
    const pane = MeshBuilder.CreateBox(name, { width: w, height: 0.028, depth: d }, this.scene);
    pane.position.set(x, y, z);
    pane.rotation.z = rotZ;
    pane.parent = this.root;

    const tex = applyLaminatedGlass(this.scene, pane, name);

    pane.metadata = { type: "carGlass", instance: this };
    this.panes.set(pane, { mesh: pane, broken: false, crackTex: laminated ? tex : null, hits: 0 });
  }

  // Called by the weapons' hitscan when a round lands on a pane
  public hitGlass(mesh: AbstractMesh, pick: PickingInfo, effects: Effects): void {
    hitGlassPane(this.panes, this.shards, this.shardAnchor, mesh, pick, effects);
  }
}
