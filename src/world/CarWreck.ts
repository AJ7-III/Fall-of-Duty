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
    loader: AssetLoader,
    position: Vector3,
    yaw: number,
    registerStatic: (mat: StandardMaterial, mesh: Mesh) => void
  ) {
    this.scene = scene;

    this.root = new TransformNode("carRoot", scene);
    this.root.position.copyFrom(position);
    this.root.rotation.y = yaw;

    // --- Materials ---
    const paintMat = loader.createCarBodyMaterial(scene);

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

    // Local frame before yaw: +x is the nose, z spans the width.
    const { stat, box } = makeStaticHelpers(scene, this.root, registerStatic);

    // --- Body shell. The cabin is a real cavity: door walls either side,
    // solid engine bay ahead of the firewall, solid trunk behind the seats,
    // and a low floor pan between them — looking through any window reads
    // depth and the far glass, not a closed deck. ---
    box("car_sideL", 4.28, 0.58, 0.16, 0, 0.63, 0.77, paintMat); // door walls, seams in the texture
    box("car_sideR", 4.28, 0.58, 0.16, 0, 0.63, -0.77, paintMat);
    box("car_nose", 1.6, 0.58, 1.38, 1.34, 0.63, 0, paintMat); // engine bay under the hood
    box("car_tail", 0.56, 0.58, 1.38, -1.86, 0.63, 0, paintMat); // trunk tub
    box("car_floorPan", 2.12, 0.1, 1.38, -0.52, 0.39, 0, darkMat); // cabin floor
    box("car_skirtL", 4.0, 0.12, 0.05, 0, 0.37, 0.86, darkMat); // rocker trim
    box("car_skirtR", 4.0, 0.12, 0.05, 0, 0.37, -0.86, darkMat);
    box("car_hood", 1.55, 0.06, 1.58, 1.28, 0.93, 0, paintMat, -0.045); // nose drops slightly
    box("car_cowl", 0.14, 0.035, 1.5, 0.49, 0.945, 0, darkMat); // wiper well
    box("car_trunk", 0.52, 0.06, 1.58, -1.88, 0.94, 0, paintMat, 0.03); // lid ends at the rear glass base
    box("car_roof", 1.78, 0.05, 1.5, -0.55, 1.41, 0, paintMat);

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
    for (const [wx, wz] of [[1.45, 0.84], [1.45, -0.84], [-1.45, 0.84], [-1.45, -0.84]]) {
      const tire = MeshBuilder.CreateCylinder(`car_tire_${wx}_${wz}`, { height: 0.24, diameter: 0.62, tessellation: 18 }, scene);
      tire.position.set(wx, 0.31, wz);
      tire.rotation.x = Math.PI / 2;
      stat(tire, darkMat);

      const rim = MeshBuilder.CreateCylinder(`car_rim_${wx}_${wz}`, { height: 0.25, diameter: 0.34, tessellation: 14 }, scene);
      rim.position.set(wx, 0.31, wz);
      rim.rotation.x = Math.PI / 2;
      stat(rim, steelMat);
    }

    // --- Nose / tail dressing ---
    const bumperF = MeshBuilder.CreateCapsule("car_bumperF", { radius: 0.075, height: 1.78, tessellation: 12, capSubdivisions: 4 }, scene);
    bumperF.position.set(2.18, 0.5, 0);
    bumperF.rotation.x = Math.PI / 2; // lie across the nose
    stat(bumperF, darkMat);

    const bumperR = bumperF.clone("car_bumperR");
    bumperR.position.set(-2.18, 0.5, 0);
    stat(bumperR as Mesh, darkMat);

    box("car_grille", 0.04, 0.16, 1.0, 2.12, 0.74, 0, darkMat);
    for (const side of [-1, 1]) {
      const lamp = MeshBuilder.CreateCylinder(`car_headlamp${side}`, { height: 0.035, diameter: 0.17, tessellation: 14 }, scene);
      lamp.position.set(2.13, 0.78, 0.56 * side);
      lamp.rotation.z = Math.PI / 2; // face forward
      stat(lamp, lampMat);

      box(`car_taillamp${side}`, 0.035, 0.1, 0.3, -2.15, 0.78, 0.58 * side, tailMat);
      box(`car_mirror${side}`, 0.06, 0.045, 0.1, 0.55, 1.06, 0.92 * side, darkMat);
      box(`car_handleF${side}`, 0.12, 0.025, 0.02, 0.12, 0.95, 0.865 * side, steelMat);
      box(`car_handleR${side}`, 0.12, 0.025, 0.02, -0.78, 0.95, 0.865 * side, steelMat);
    }

    const exhaust = MeshBuilder.CreateCylinder("car_exhaust", { height: 0.14, diameter: 0.07, tessellation: 10 }, scene);
    exhaust.position.set(-2.12, 0.28, 0.45);
    exhaust.rotation.z = Math.PI / 2;
    stat(exhaust, steelMat);

    // --- Interior (visible through the glass, shootable once it breaks) ---
    const seatMat = getOrCreateColorMat(
      scene, "carSeatMat",
      new Color3(0.17, 0.155, 0.14), // worn cloth
      new Color3(0.02, 0.02, 0.02), 8
    );

    box("car_dash", 0.3, 0.14, 1.38, 0.4, 0.86, 0, darkMat); // tucked under the windshield base
    box("car_console", 0.55, 0.22, 0.16, -0.08, 0.55, 0, darkMat); // runs down to the floor pan
    box("car_rearShelf", 0.24, 0.04, 1.38, -1.52, 0.88, 0, darkMat); // parcel shelf tucked behind the bench
    box("car_mirror", 0.04, 0.05, 0.22, 0.32, 1.27, 0, darkMat); // rearview at the windshield header

    // steering column + wheel on the driver's side
    const column = MeshBuilder.CreateCylinder("car_steerColumn", { height: 0.24, diameter: 0.035, tessellation: 10 }, scene);
    column.position.set(0.22, 0.86, 0.42);
    column.rotation.z = 1.15; // rakes up out of the dash
    stat(column, darkMat);

    const wheel = MeshBuilder.CreateTorus("car_steerWheel", { diameter: 0.34, thickness: 0.035, tessellation: 18 }, scene);
    wheel.position.set(0.1, 0.93, 0.42);
    wheel.rotation.z = 1.15; // face the driver, matching the column rake
    stat(wheel, darkMat);

    // front buckets + rear bench, bases grounded on the floor pan,
    // backrests raked with the cabin
    for (const side of [-1, 1]) {
      box(`car_seatBase${side}`, 0.5, 0.3, 0.48, -0.25, 0.6, 0.42 * side, seatMat);
      box(`car_seatBack${side}`, 0.14, 0.55, 0.48, -0.52, 0.99, 0.42 * side, seatMat, 0.18);
      box(`car_headrest${side}`, 0.12, 0.14, 0.24, -0.6, 1.31, 0.42 * side, seatMat, 0.18);
    }
    box("car_benchBase", 0.55, 0.3, 1.38, -1.0, 0.6, 0, seatMat);
    box("car_benchBack", 0.14, 0.5, 1.38, -1.28, 0.98, 0, seatMat, 0.22);

    const antenna = MeshBuilder.CreateCylinder("car_antenna", { height: 0.42, diameter: 0.014, tessellation: 8 }, scene);
    antenna.position.set(0.42, 1.2, -0.78);
    stat(antenna, steelMat);

    // --- Glass (interactive, NOT merged) ---
    this.addPane("car_windshield", 0.66, 1.42, 0.42, 1.16, 0, -0.95, true);
    this.addPane("car_rearGlass", 0.52, 1.38, -1.52, 1.17, 0, 1.05, true);
    for (const side of [-1, 1]) {
      // panes drop to the beltline so no slit opens above the door walls
      this.addSidePane(`car_glassF${side}`, 0.74, 0.44, -0.06, 1.13, 0.745 * side);
      this.addSidePane(`car_glassR${side}`, 0.8, 0.42, -1.0, 1.13, 0.735 * side);
    }

    // --- Shard burst (shared, manual-emit) ---
    this.shards = createGlassShardSystem(scene, loader, "carGlassShards", this.shardAnchor);
  }

  // Laminated pane: thin slab with its own crack texture
  private addPane(
    name: string,
    w: number, d: number,
    x: number, y: number, z: number,
    rotZ: number,
    laminated: boolean
  ): void {
    const pane = MeshBuilder.CreateBox(name, { width: w, height: 0.028, depth: d }, this.scene);
    pane.position.set(x, y, z);
    pane.rotation.z = rotZ;
    pane.parent = this.root;

    const tex = applyLaminatedGlass(this.scene, pane, name);

    pane.metadata = { type: "carGlass", instance: this };
    this.panes.set(pane, { mesh: pane, broken: false, crackTex: laminated ? tex : null, hits: 0 });
  }

  // Tempered side pane: shares one clean glass material, shatters outright
  private addSidePane(name: string, w: number, h: number, x: number, y: number, z: number): void {
    addTemperedPane(this.scene, this.root, this, this.panes, name, w, h, x, y, z);
  }

  // Called by the weapons' hitscan when a round lands on a pane
  public hitGlass(mesh: AbstractMesh, pick: PickingInfo, effects: Effects): void {
    hitGlassPane(this.panes, this.shards, this.shardAnchor, mesh, pick, effects);
  }
}
