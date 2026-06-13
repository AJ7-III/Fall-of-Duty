import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  TransformNode,
  ParticleSystem,
} from "@babylonjs/core";
import type { AbstractMesh, PickingInfo } from "@babylonjs/core";
import { AssetLoader } from "../engine/AssetLoader";
import { Effects } from "../rendering/Effects";
import type { GlassPane } from "./wreckShared";
import {
  getOrCreateColorMat,
  makeStaticHelpers,
  applyLaminatedGlass,
  addTemperedPane,
  createGlassShardSystem,
  hitGlassPane,
} from "./wreckShared";

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
    loader: AssetLoader,
    position: Vector3,
    yaw: number,
    registerStatic: (mat: StandardMaterial, mesh: Mesh) => void
  ) {
    this.scene = scene;

    this.root = new TransformNode("truckRoot", scene);
    this.root.position.copyFrom(position);
    this.root.rotation.y = yaw;

    // --- Materials (trim/steel/lamp shared with the car wreck by name) ---
    const boxMat = loader.createContainerMaterial(scene, "truckbox", "#cfd3cc", "#b9bdb6");

    const cabMat = getOrCreateColorMat(
      scene, "truckCabMat",
      new Color3(0.78, 0.79, 0.76), // dirtier white than the box
      new Color3(0.22, 0.23, 0.24), 32
    );
    const darkMat = getOrCreateColorMat(
      scene, "carTrimDarkMat",
      new Color3(0.07, 0.07, 0.08), new Color3(0.06, 0.06, 0.07), 16
    );
    const steelMat = getOrCreateColorMat(
      scene, "carSteelMat",
      new Color3(0.42, 0.44, 0.47), new Color3(0.5, 0.52, 0.55), 48
    );
    const lampMat = getOrCreateColorMat(
      scene, "carLampMat",
      new Color3(0.75, 0.78, 0.72), new Color3(0.6, 0.6, 0.6), 64,
      new Color3(0.12, 0.12, 0.1)
    );
    const tailMat = getOrCreateColorMat(
      scene, "carTailLampMat",
      new Color3(0.45, 0.08, 0.07), new Color3(0.4, 0.3, 0.3), 48,
      new Color3(0.1, 0.015, 0.012)
    );
    const seatMat = getOrCreateColorMat(
      scene, "carSeatMat",
      new Color3(0.17, 0.155, 0.14), new Color3(0.02, 0.02, 0.02), 8
    );

    // Local frame before yaw: +x is the nose, z spans the width.
    const { stat, box } = makeStaticHelpers(scene, this.root, registerStatic);

    // --- Chassis ---
    box("truck_frame", 6.0, 0.18, 1.5, -0.1, 0.62, 0, darkMat); // ladder rails
    const tank = MeshBuilder.CreateCylinder("truck_fuelTank", { height: 0.95, diameter: 0.42, tessellation: 14 }, scene);
    tank.position.set(0.7, 0.46, 0.92);
    tank.rotation.z = Math.PI / 2; // lies along the frame
    stat(tank, steelMat);
    box("truck_battBox", 0.55, 0.3, 0.25, 0.7, 0.45, -0.95, darkMat);

    // --- Cab: a real cavity (floor, door walls, rear wall, roof) so the
    // glass reads depth — COE flat face, no hood ---
    box("truck_cabFloor", 1.5, 0.1, 2.0, 2.3, 0.66, 0, darkMat);
    box("truck_cabFront", 0.1, 0.95, 2.05, 3.0, 1.02, 0, cabMat); // flat nose below the windshield
    box("truck_cabDoorL", 1.46, 0.86, 0.09, 2.28, 1.14, 0.98, cabMat);
    box("truck_cabDoorR", 1.46, 0.86, 0.09, 2.28, 1.14, -0.98, cabMat);
    box("truck_cabRear", 0.09, 1.72, 2.05, 1.58, 1.5, 0, cabMat);
    box("truck_cabRoof", 1.56, 0.07, 2.1, 2.3, 2.36, 0, cabMat);
    // A-pillars frame the windshield; B-pillars close the door glass
    for (const side of [-1, 1]) {
      box(`truck_pillarA${side}`, 0.07, 0.92, 0.08, 3.0, 1.92, 0.98 * side, cabMat, -0.06);
      box(`truck_pillarB${side}`, 0.07, 0.92, 0.07, 1.62, 1.9, 0.98 * side, cabMat);
      // beltline sill the door glass sits on
      box(`truck_sill${side}`, 1.46, 0.06, 0.05, 2.28, 1.56, 0.99 * side, cabMat);
    }

    // --- Cab interior (visible through the glass) ---
    box("truck_dash", 0.36, 0.18, 1.9, 2.78, 1.42, 0, darkMat);
    box("truck_bench", 0.62, 0.3, 1.8, 1.98, 0.92, 0, seatMat);
    box("truck_benchBack", 0.14, 0.62, 1.8, 1.74, 1.36, 0, seatMat, 0.16);
    const column = MeshBuilder.CreateCylinder("truck_steerColumn", { height: 0.3, diameter: 0.04, tessellation: 10 }, scene);
    column.position.set(2.62, 1.32, 0.55);
    column.rotation.z = 0.95;
    stat(column, darkMat);
    const wheel = MeshBuilder.CreateTorus("truck_steerWheel", { diameter: 0.42, thickness: 0.04, tessellation: 18 }, scene);
    wheel.position.set(2.5, 1.42, 0.55);
    wheel.rotation.z = 0.95; // truck wheels sit flatter than a car's
    stat(wheel, darkMat);
    const stick = MeshBuilder.CreateCylinder("truck_gearStick", { height: 0.3, diameter: 0.025, tessellation: 8 }, scene);
    stick.position.set(2.32, 0.92, 0.12);
    stick.rotation.x = 0.2;
    stat(stick, darkMat);

    // --- Cab dressing ---
    box("truck_bumperF", 0.2, 0.34, 2.2, 3.12, 0.5, 0, darkMat);
    box("truck_grille", 0.04, 0.3, 1.1, 3.06, 0.95, 0, darkMat);
    for (const side of [-1, 1]) {
      box(`truck_headlamp${side}`, 0.05, 0.18, 0.34, 3.07, 0.78, 0.72 * side, lampMat);
      // big west-coast mirrors on arms
      box(`truck_mirrorArm${side}`, 0.05, 0.05, 0.34, 2.95, 2.05, 1.16 * side, steelMat);
      box(`truck_mirror${side}`, 0.06, 0.5, 0.16, 2.95, 1.78, 1.32 * side, darkMat);
      box(`truck_handle${side}`, 0.16, 0.03, 0.025, 1.95, 1.42, 1.035 * side, steelMat);
      // entry steps under the doors
      box(`truck_step${side}`, 0.6, 0.06, 0.3, 2.45, 0.34, 0.98 * side, darkMat);
    }
    // marker lights across the cab roof leading edge
    for (const mz of [-0.6, -0.2, 0.2, 0.6]) {
      box(`truck_marker${mz}`, 0.05, 0.05, 0.12, 2.98, 2.42, mz, tailMat);
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
    for (let r = 0; r < 5; r++) {
      box(`truck_rollRib${r}`, 0.025, 0.04, 1.96, -3.05, 1.16 + r * 0.38, 0, darkMat);
    }
    for (const side of [-1, 1]) {
      box(`truck_boxPost${side}`, 0.1, 2.05, 0.1, -3.0, 1.95, 1.0 * side, boxMat);
      box(`truck_taillamp${side}`, 0.05, 0.12, 0.3, -3.1, 0.82, 0.82 * side, tailMat);
      // mud flaps behind the rear duals
      box(`truck_flap${side}`, 0.03, 0.34, 0.32, -2.6, 0.42, 0.86 * side, darkMat);
    }
    box("truck_bumperR", 0.14, 0.26, 2.0, -3.12, 0.48, 0, darkMat);

    // --- Running gear: single front axle, dual rears ---
    const wheelAt = (name: string, wx: number, wz: number, width: number): void => {
      const tire = MeshBuilder.CreateCylinder(`${name}_tire`, { height: width, diameter: 0.8, tessellation: 18 }, scene);
      tire.position.set(wx, 0.4, wz);
      tire.rotation.x = Math.PI / 2;
      stat(tire, darkMat);
      const rim = MeshBuilder.CreateCylinder(`${name}_rim`, { height: width + 0.01, diameter: 0.42, tessellation: 14 }, scene);
      rim.position.set(wx, 0.4, wz);
      rim.rotation.x = Math.PI / 2;
      stat(rim, steelMat);
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
    this.shards = createGlassShardSystem(scene, loader, "truckGlassShards", this.shardAnchor);
  }

  // Laminated windshield: near-vertical slab with its own crack texture
  private addWindshield(
    name: string,
    x: number, y: number,
    h: number, span: number,
    rotZ: number
  ): void {
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
