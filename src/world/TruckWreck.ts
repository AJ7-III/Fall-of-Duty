import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh, PickingInfo, Scene, Mesh, Material, ParticleSystem } from "@babylonjs/core";
import type { WorldMaterials } from "./materials/WorldMaterials";
import type { Effects } from "../rendering/Effects";
import type { GlassPane } from "./wreckShared";
import { VehicleParts } from "./VehicleParts";
import { getOrCreateColorMat, applyLaminatedGlass, addTemperedPane, createGlassShardSystem, hitGlassPane } from "./wreckShared";

// Abandoned cab-over box truck, built to the same standard as CarWreck: the
// body is static dressing merged with the map, the cab is a real cavity with
// a bench, dash and wheel visible through the glass, and every window is its
// own pickable pane on the weapons' hitscan (metadata.type "carGlass" so the
// existing routing applies) — laminated windshield webs then collapses,
// tempered door glass bursts, shards spray either way.
export class TruckWreck {
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

    this.root = new TransformNode("truckRoot", scene);
    this.root.position.copyFrom(position);
    this.root.rotation.y = yaw;

    // --- Materials (trim/steel/lamp shared with the car wreck by name) ---
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
    const { plastic, rubber, cloth, carpet, recess, amber, cabPaint: cabMat, cargoPaint: boxMat } = parts.mats;

    // --- Chassis ---
    for (const side of [-1, 1]) box(`truck_frameRail${side}`, 6.0, 0.18, 0.13, -0.1, 0.62, 0.62 * side, darkMat);
    for (let i = 0; i < 5; i++) box(`truck_frameCross${i}`, 0.09, 0.13, 1.2, -2.5 + i * 1.15, 0.62, 0, darkMat);
    parts.rod("truck_frontAxle", [2.45, 0.4, -0.9], [2.45, 0.4, 0.9], 0.055, darkMat);
    parts.rod("truck_rearAxle", [-1.95, 0.4, -1.02], [-1.95, 0.4, 1.02], 0.065, darkMat);
    parts.soft("truck_differential", 0.24, 0.22, 0.3, -1.95, 0.42, 0, darkMat, 0.08);
    parts.rod("truck_driveShaft", [-1.85, 0.46, 0], [1.5, 0.56, 0], 0.035, darkMat);
    const tank = MeshBuilder.CreateCylinder("truck_fuelTank", { height: 0.95, diameter: 0.42, tessellation: 14 }, scene);
    tank.position.set(0.7, 0.46, 0.92);
    tank.rotation.z = Math.PI / 2; // lies along the frame
    stat(tank, steelMat);
    for (const x of [0.37, 1.03]) {
      const strap = MeshBuilder.CreateTorus(`truck_tankStrap${x}`, { diameter: 0.42, thickness: 0.022, tessellation: 20 }, scene);
      strap.position.set(x, 0.46, 0.92);
      strap.rotation.z = Math.PI / 2;
      stat(strap, darkMat);
      parts.rod(`truck_tankBracket${x}`, [x, 0.61, 0.62], [x, 0.61, 0.92], 0.025, darkMat);
    }
    box("truck_battBox", 0.55, 0.3, 0.25, 0.7, 0.45, -0.95, darkMat);

    // --- Cab: a real cavity (floor, door walls, rear wall, roof) so the
    // glass reads depth — COE flat face, no hood ---
    box("truck_cabFloor", 1.5, 0.1, 2.0, 2.3, 0.66, 0, darkMat);
    parts.soft("truck_cabFront", 0.1, 0.95, 2.05, 3.0, 1.02, 0, cabMat, 0.04);
    box("truck_cabRear", 0.09, 1.72, 2.05, 1.58, 1.5, 0, cabMat);
    parts.soft("truck_cabRoof", 1.56, 0.07, 2.1, 2.3, 2.36, 0, cabMat, 0.03);
    // A-pillars frame the windshield; B-pillars close the door glass
    for (const side of [-1, 1]) {
      parts.soft(`truck_doorUpper${side}`, 1.46, 0.7, 0.09, 2.28, 1.23, 0.98 * side, cabMat, 0.025);
      const span = parts.arch(`truck_arch${side}`, 2.45, 0.4, 1.025 * side, 0.45, 0.71, 0.89, side, cabMat);
      const rearW = 2.45 - span - 1.55;
      const frontW = 3.01 - 2.45 - span;
      box(`truck_doorLowerRear${side}`, rearW, 0.18, 0.09, 1.55 + rearW / 2, 0.8, 0.98 * side, cabMat);
      box(`truck_doorLowerFront${side}`, frontW, 0.18, 0.09, 3.01 - frontW / 2, 0.8, 0.98 * side, cabMat);
      box(`truck_pillarA${side}`, 0.07, 0.92, 0.08, 3.0, 1.92, 0.98 * side, cabMat, -0.06);
      box(`truck_pillarB${side}`, 0.07, 0.92, 0.07, 1.62, 1.9, 0.98 * side, cabMat);
      // beltline sill the door glass sits on
      box(`truck_sill${side}`, 1.46, 0.06, 0.05, 2.28, 1.56, 0.99 * side, cabMat);
    }

    // --- Cab interior (visible through the glass) ---
    box("truck_cabCarpet", 1.43, 0.015, 1.88, 2.3, 0.718, 0, carpet);
    parts.soft("truck_headliner", 1.43, 0.018, 1.94, 2.3, 2.313, 0, cloth, 0.008);
    parts.soft("truck_dash", 0.36, 0.18, 1.87, 2.78, 1.42, 0, plastic, 0.055);
    parts.soft("truck_dashTop", 0.39, 0.035, 1.9, 2.78, 1.515, 0, plastic, 0.015);
    parts.instruments("truck_instruments", 2.58, 1.442, 0.55, 0.43);
    parts.steering("truck_steering", [2.4, 1.43, 0.55], 0.42, 0.95, steelMat, 0.3);
    parts.soft("truck_columnMount", 0.18, 0.12, 0.12, 2.67, 1.28, 0.55, plastic, 0.025);
    for (const z of [-0.57, 0, 0.57]) parts.seat(`truck_seat${z}`, 2.0, 1.04, z, 0.51, 0.726, steelMat);
    parts.soft("truck_gearBoot", 0.15, 0.09, 0.15, 2.25, 0.775, 0.15, rubber, 0.025);
    parts.rod("truck_gearLever", [2.25, 0.8, 0.15], [2.36, 1.18, 0.15], 0.012, steelMat);
    parts.soft("truck_gearKnob", 0.055, 0.06, 0.055, 2.36, 1.18, 0.15, plastic, 0.025);
    parts.soft("truck_engineTunnel", 0.9, 0.2, 0.3, 2.31, 0.82, 0, plastic, 0.06);
    for (const side of [-1, 1]) {
      parts.door(`truck_door${side}`, 2.28, 1.255, 0.919 * side, 1.28, 0.48, side, steelMat);
      box(`truck_floorMat${side}`, 0.49, 0.016, 0.5, 2.64, 0.738, 0.55 * side, rubber);
      box(`truck_parkedSeatbelt${side}`, 0.032, 0.94, 0.014, 1.665, 1.58, 0.905 * side, recess);
      parts.soft(`truck_beltAnchor${side}`, 0.075, 0.08, 0.03, 1.665, 2.04, 0.9 * side, plastic, 0.015);
      parts.soft(`truck_visor${side}`, 0.26, 0.03, 0.64, 2.76, 2.295, 0.53 * side, cloth, 0.013);
    }
    for (const z of [0.42, 0.56, 0.72]) parts.soft(`truck_pedal${z}`, 0.04, 0.1, 0.085, 2.77, 0.87, z, rubber, 0.015, -0.3);
    parts.soft("truck_rearview", 0.05, 0.09, 0.28, 2.89, 2.19, 0, plastic, 0.02);
    box("truck_rearviewLens", 0.005, 0.066, 0.24, 2.862, 2.19, 0, steelMat);
    parts.rod("truck_rearviewStem", [2.89, 2.22, 0], [2.87, 2.32, 0], 0.01, darkMat);
    box("truck_radio", 0.015, 0.13, 0.29, 2.586, 1.39, 0.03, recess);
    box("truck_radioDisplay", 0.008, 0.032, 0.15, 2.574, 1.42, 0.03, parts.mats.stitch);
    for (const z of [-0.08, 0.14]) parts.rod(`truck_radioKnob${z}`, [2.563, 1.38, z], [2.58, 1.38, z], 0.021, plastic);
    parts.soft("truck_gloveBox", 0.014, 0.12, 0.52, 2.587, 1.385, -0.54, plastic, 0.006);
    box("truck_gloveLatch", 0.009, 0.02, 0.075, 2.575, 1.42, -0.54, steelMat);
    for (const z of [-0.85, -0.23, 0.83]) {
      box(`truck_dashVent${z}`, 0.015, 0.05, 0.1, 2.583, 1.47, z, recess);
      for (let i = 0; i < 4; i++) box(`truck_ventSlat${z}_${i}`, 0.01, 0.005, 0.09, 2.572, 1.45 + i * 0.012, z, plastic);
    }

    // --- Cab dressing ---
    parts.soft("truck_bumperF", 0.2, 0.34, 2.2, 3.12, 0.5, 0, darkMat, 0.055);
    box("truck_grille", 0.04, 0.3, 1.1, 3.06, 0.95, 0, darkMat);
    for (let i = 0; i < 7; i++) box(`truck_grilleSlat${i}`, 0.01, 0.012, 1.02, 3.086, 0.829 + i * 0.04, 0, steelMat);
    parts.plate("truck_plateF", 3.224, 0.51, 0.4, true, "SBX 312");
    for (const side of [-1, 1]) {
      parts.soft(`truck_lampHousing${side}`, 0.07, 0.23, 0.39, 3.07, 0.78, 0.72 * side, plastic, 0.025);
      box(`truck_headlamp${side}`, 0.025, 0.17, 0.32, 3.115, 0.78, 0.72 * side, lampMat);
      box(`truck_indicator${side}`, 0.03, 0.075, 0.2, 3.1, 1.145, 0.78 * side, amber);
      // big west-coast mirrors on arms
      box(`truck_mirrorArm${side}`, 0.05, 0.05, 0.34, 2.95, 2.05, 1.16 * side, steelMat);
      box(`truck_mirror${side}`, 0.06, 0.5, 0.16, 2.95, 1.78, 1.32 * side, darkMat);
      box(`truck_mirrorLens${side}`, 0.008, 0.44, 0.125, 2.915, 1.78, 1.32 * side, steelMat);
      box(`truck_handle${side}`, 0.16, 0.03, 0.025, 1.95, 1.42, 1.035 * side, steelMat);
      // entry steps under the doors
      box(`truck_step${side}`, 0.48, 0.06, 0.26, 1.83, 0.41, 1.04 * side, darkMat);
      box(`truck_stepUpper${side}`, 0.42, 0.045, 0.18, 1.83, 0.59, 1.02 * side, darkMat);
      box(`truck_stepBracket${side}`, 0.15, 0.3, 0.06, 1.83, 0.53, 0.88 * side, darkMat);
      for (let i = 0; i < 4; i++)
        box(`truck_stepGrip${side}_${i}`, 0.44, 0.008, 0.012, 1.83, 0.445, (0.96 + i * 0.05) * side, rubber);
      parts.rod(`truck_wiperArm${side}`, [3.075, 1.55, 0.5 * side], [3.079, 1.65, 0.42 * side], 0.008, darkMat);
      parts.soft(`truck_wiperBlade${side}`, 0.012, 0.015, 0.48, 3.079, 1.65, 0.42 * side, recess, 0.005);
      parts.rod(`truck_glassGasket${side}`, [3.027, 1.535, 0.905 * side], [3.086, 2.344, 0.905 * side], 0.012, rubber);
      parts.rod(`truck_doorGap${side}`, [1.69, 0.93, 1.028 * side], [1.69, 1.55, 1.028 * side], 0.004, recess);
    }
    parts.rod("truck_windshieldBottomSeal", [3.027, 1.535, -0.905], [3.027, 1.535, 0.905], 0.012, rubber);
    parts.rod("truck_windshieldTopSeal", [3.086, 2.344, -0.905], [3.086, 2.344, 0.905], 0.012, rubber);
    // marker lights across the cab roof leading edge
    for (const mz of [-0.6, -0.2, 0.2, 0.6]) {
      box(`truck_marker${mz}`, 0.05, 0.05, 0.12, 2.98, 2.42, mz, amber);
    }
    const antenna = MeshBuilder.CreateCylinder("truck_antenna", { height: 0.5, diameter: 0.015, tessellation: 8 }, scene);
    antenna.position.set(1.75, 2.62, -0.85);
    stat(antenna, steelMat);
    // vertical exhaust stack tucked behind the cab corner
    const stack = MeshBuilder.CreateCylinder("truck_exhaust", { height: 1.9, diameter: 0.11, tessellation: 10 }, scene);
    stack.position.set(1.52, 1.6, -1.02);
    stat(stack, steelMat);

    // --- Cargo box (corrugated white, slightly wider than the cab) ---
    box("truck_boxWallL", 4.5, 2.0, 0.08, -0.8, 1.95, 1.06, boxMat);
    box("truck_boxWallR", 4.5, 2.0, 0.08, -0.8, 1.95, -1.06, boxMat);
    box("truck_boxFront", 0.08, 2.0, 2.04, 1.41, 1.95, 0, boxMat);
    box("truck_boxRoof", 4.56, 0.07, 2.2, -0.8, 2.95, 0, boxMat); // headglitch shelf
    box("truck_boxFloor", 4.5, 0.1, 2.04, -0.8, 0.9, 0, darkMat);
    // rear roll-up door: recessed steel panel with slat ribs
    box("truck_rollDoor", 0.05, 1.9, 1.96, -3.02, 1.92, 0, steelMat);
    for (let r = 0; r < 9; r++) {
      box(`truck_rollRib${r}`, 0.014, 0.016, 1.96, -3.052, 1.13 + r * 0.2, 0, darkMat);
    }
    for (const side of [-1, 1]) {
      box(`truck_boxPost${side}`, 0.1, 2.05, 0.1, -3.0, 1.95, 1.0 * side, boxMat);
      box(`truck_taillamp${side}`, 0.05, 0.12, 0.3, -3.1, 0.82, 0.82 * side, tailMat);
      // mud flaps behind the rear duals
      box(`truck_flap${side}`, 0.03, 0.34, 0.32, -2.6, 0.42, 0.86 * side, darkMat);
      for (const y of [1.0, 2.92]) box(`truck_boxRail${side}_${y}`, 4.42, 0.035, 0.025, -0.8, y, 1.11 * side, steelMat);
      for (const x of [-3.0, 1.41]) box(`truck_boxCorner${side}_${x}`, 0.045, 1.96, 0.025, x, 1.96, 1.11 * side, steelMat);
    }
    box("truck_bumperR", 0.14, 0.26, 2.0, -3.12, 0.48, 0, darkMat);
    parts.plate("truck_plateR", -3.196, 0.48, 0.4, false, "SBX 312");
    box("truck_rollDoorHandle", 0.04, 0.035, 0.28, -3.067, 1.18, 0, darkMat);
    parts.rod("truck_doorLatch", [-3.078, 1.12, 0], [-3.078, 1.36, 0], 0.013, steelMat);

    // --- Running gear: single front axle, dual rears ---
    const wheelAt = (name: string, wx: number, wz: number, width: number): void => {
      parts.wheel(name, wx, 0.4, wz, 0.8, width, Math.sign(wz), steelMat);
    };
    for (const side of [-1, 1]) {
      wheelAt(`truck_wheelF${side}`, 2.45, 0.88 * side, 0.3);
      wheelAt(`truck_wheelR1${side}`, -1.95, 0.76 * side, 0.24); // inner dual
      wheelAt(`truck_wheelR2${side}`, -1.95, 1.02 * side, 0.24); // outer dual
    }

    // --- Glass (interactive, NOT merged) ---
    this.addWindshield("truck_windshield", 3.04, 1.94, 0.82, 1.78, -0.07);
    for (const side of [-1, 1]) {
      // tucked into the pillars and roof so no slits open around the pane
      this.addSidePane(`truck_glassDoor${side}`, 1.4, 0.74, 2.28, 1.94, 1.0 * side);
    }

    // --- Shard burst (shared, manual-emit) ---
    this.shards = createGlassShardSystem(scene, materials, "truckGlassShards", this.shardAnchor);
  }

  // Laminated windshield: near-vertical slab with its own crack texture
  private addWindshield(name: string, x: number, y: number, h: number, span: number, rotZ: number): void {
    const pane = MeshBuilder.CreateBox(name, { width: 0.028, height: h, depth: span }, this.scene);
    pane.position.set(x, y, 0);
    pane.rotation.z = rotZ;
    pane.parent = this.root;

    const tex = applyLaminatedGlass(this.scene, pane, name);

    pane.metadata = { type: "carGlass", instance: this };
    this.panes.set(pane, { mesh: pane, broken: false, crackTex: tex, hits: 0 });
  }

  // Tempered door pane: shares the car's clean glass material, shatters outright
  private addSidePane(name: string, w: number, h: number, x: number, y: number, z: number): void {
    addTemperedPane(this.scene, this.root, this, this.panes, name, w, h, x, y, z);
  }

  // Called by the weapons' hitscan when a round lands on a pane
  public hitGlass(mesh: AbstractMesh, pick: PickingInfo, effects: Effects): void {
    hitGlassPane(this.panes, this.shards, this.shardAnchor, mesh, pick, effects);
  }
}
