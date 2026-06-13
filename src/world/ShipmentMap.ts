import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Color3,
  Color4,
  Matrix,
  Quaternion,
  HemisphericLight,
  DirectionalLight,
  StandardMaterial,
  ShadowGenerator,
  RenderTargetTexture,
  ParticleSystem,
} from "@babylonjs/core";
import { AssetLoader } from "../engine/AssetLoader";
import { Target } from "./Target";
import { CarWreck } from "./CarWreck";
import { TruckWreck } from "./TruckWreck";
import { PlayerController } from "../player/PlayerController";

// Shipment-style container yard, scaled off the overhead reference: a 32m
// walled square (x/z -16..16) where the four center blocks leave only
// ~2.5-3m lanes between them. Set on rain-soaked grass under an overcast
// sky, with stone walkways tracing the lanes and the wall footing.
//   - Center blocks are closed EXCEPT the NW one, which holds a single
//     HALF-OPEN container (one mouth onto the cross) per the diagram; you move
//     through the lanes between the blocks; NW/SE double-stacked, NE/SW paired
//   - East/west edges (the two "across" the map): the container AGAINST the
//     wall is OPEN at BOTH ends (true walk-through, bare mouths); a closed
//     one sits second in from the wall
//   - North/south edges (90° from those): a HALF-OPEN inner container (one
//     mouth open, sealed at the far end) backed by a closed outer one
//   - Corners: abandoned car w/ breakable glass (SW), white box truck
//     parked diagonally (NE), pallets, crates
//   - Past the walls (visual only): warehouses, stacks, water tower, lamps
export class ShipmentMap {
  private scene: Scene;
  private loader: AssetLoader;
  private shadowGen: ShadowGenerator | null = null;
  private shadowMap: RenderTargetTexture | null = null;

  // Static props collected during build, then merged into one mesh per
  // material before play starts (scene draw calls drop ~5x, output identical)
  private casterParts = new Map<StandardMaterial, Mesh[]>();

  // The rain volume tracks the player so a modest particle budget always
  // fills the sky overhead (update() copies the camera x/z in here)
  private rainAnchor = new Vector3(0, 11, 0);

  public targets: Target[] = [];

  constructor(scene: Scene, loader: AssetLoader) {
    this.scene = scene;
    this.loader = loader;

    PlayerController.clearObstacles();

    this.createLighting();
    this.createEnvironment();
    this.createCenterBlocks();
    this.createEdgeStructures();
    this.createCornerClutter();
    this.createOutOfBounds();
    this.mergeStaticParts();
    this.createLongGrass();
    this.createRain();
    this.freezeShadows();
  }

  private createLighting(): void {
    // Overcast rain light: a high flat ambient does most of the work, the
    // "sun" is just a weak cool key so the shadows stay readable but soft
    const ambientLight = new HemisphericLight("ambientLight", new Vector3(0, 1, 0), this.scene);
    ambientLight.intensity = 0.95;
    ambientLight.diffuse = new Color3(0.76, 0.8, 0.86);
    ambientLight.groundColor = new Color3(0.24, 0.25, 0.24);

    const sunLight = new DirectionalLight("sunLight", new Vector3(-0.45, -0.9, 0.35), this.scene);
    sunLight.position = new Vector3(25, 45, -25);
    sunLight.intensity = 0.62;
    sunLight.diffuse = new Color3(0.74, 0.78, 0.84);

    this.shadowGen = new ShadowGenerator(2048, sunLight);
    this.shadowGen.usePercentageCloserFiltering = true;
    this.shadowGen.bias = 0.0006;
    this.shadowGen.setDarkness(0.45); // diffuse skylight lifts the shadows

    // The yard is only 32m across: rain haze starts past the walls and
    // swallows the warehouse skyline sooner than the old clear-day fog
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogStart = 32;
    this.scene.fogEnd = 140;
    this.scene.fogColor = new Color3(0.5, 0.53, 0.56);

    const sky = MeshBuilder.CreateSphere("skyDome", { diameter: 600, segments: 12, sideOrientation: 1 }, this.scene);
    sky.material = this.loader.createSkyMaterial(this.scene);
    sky.isPickable = false;
    sky.freezeWorldMatrix();
  }

  private createEnvironment(): void {
    // Rain-soaked lawn: the yard plus the out-of-bounds surround
    const floor = MeshBuilder.CreateGround("floor", { width: 100, height: 100 }, this.scene);
    floor.material = this.loader.createGrassMaterial(this.scene, 12, 12);
    floor.receiveShadows = true;
    floor.freezeWorldMatrix();

    // Stone walkways: a cross tracing the center lanes out to the tunnel
    // mouths, plus a footing path ringing the inside of the walls. Thin
    // raised slabs, cosmetic only — no collision, and the segments are laid
    // edge-to-edge (never stacked) so the tops can't z-fight.
    const walkway = (name: string, w: number, d: number, cx: number, cz: number, u: number, v: number) => {
      const slab = MeshBuilder.CreateBox(name, { width: w, height: 0.04, depth: d }, this.scene);
      slab.position.set(cx, 0.02, cz);
      const mat = this.loader.createStoneWalkwayMaterial(this.scene, u, v);
      slab.material = mat;
      this.collectStatic(mat, slab);
    };
    walkway("walkNS", 2.9, 28.2, 0.15, 0, 2, 19); // north-south lane
    walkway("walkEW_w", 12.8, 2.6, -7.7, 0.25, 9, 2); // east-west lane, west leg
    walkway("walkEW_e", 12.5, 2.6, 7.85, 0.25, 9, 2); // east-west lane, east leg
    walkway("walkRingN", 31.8, 1.8, 0, 15.0, 21, 1); // wall-footing ring
    walkway("walkRingS", 31.8, 1.8, 0, -15.0, 21, 1);
    walkway("walkRingE", 1.8, 28.2, 15.0, 0, 1, 21);
    walkway("walkRingW", 1.8, 28.2, -15.0, 0, 1, 21);

    // Perimeter: concrete walls plastered in graffiti, concrete cap, barbed wire
    const wallMat = this.loader.createGraffitiWallMaterial(this.scene, 6, 1);
    const capMat = this.loader.createConcreteMaterial(this.scene, 12, 1);
    const metalMat = this.loader.createMetalMaterial(this.scene);

    const wallH = 2.55;
    const sides: Array<[string, number, number, number, number]> = [
      // name, cx, cz, width(x), depth(z)
      ["wallN", 0, 16.3, 33.8, 0.6],
      ["wallS", 0, -16.3, 33.8, 0.6],
      ["wallE", 16.3, 0, 0.6, 33.8],
      ["wallW", -16.3, 0, 0.6, 33.8],
    ];
    for (const [name, cx, cz, w, d] of sides) {
      this.box(name, w, wallH, d, cx, cz, wallMat, 0, false);
      this.box(`${name}_cap`, w + 0.16, 0.15, d + 0.16, cx, cz, capMat, wallH, false);

      // barbed-wire posts + two wire runs along the cap
      const alongX = w > d;
      for (let k = 0; k < 7; k++) {
        const t = -16.1 + k * 5.37;
        this.box(`${name}_post${k}`, 0.07, 0.55, 0.07, alongX ? t : cx, alongX ? cz : t, metalMat, wallH + 0.15, false);
      }
      for (const wy of [0.32, 0.52]) {
        this.box(`${name}_wire${wy}`, alongX ? 33 : 0.035, 0.035, alongX ? 0.035 : 33, cx, cz, metalMat, wallH + 0.15 + wy, false);
      }
    }

  }

  private addCaster(mesh: Mesh): void {
    if (this.shadowGen) {
      this.shadowGen.addShadowCaster(mesh, true);
    }
  }

  private collectStatic(mat: StandardMaterial, mesh: Mesh): void {
    const list = this.casterParts.get(mat);
    if (list) {
      list.push(mesh);
    } else {
      this.casterParts.set(mat, [mesh]);
    }
  }

  private mergeStaticParts(): void {
    for (const parts of this.casterParts.values()) {
      const merged =
        parts.length > 1 ? Mesh.MergeMeshes(parts, true, true, undefined, false, false) : parts[0];
      if (!merged) continue;
      merged.receiveShadows = true;
      merged.freezeWorldMatrix();
      this.addCaster(merged);
    }
    this.casterParts.clear();
  }

  // The freeze must wait for the depth shaders: they compile in parallel,
  // and a RENDER_ONCE pass taken before they're ready skips every caster
  // and bakes an empty (shadowless) map forever.
  private freezeShadows(): void {
    if (!this.shadowGen) return;
    this.shadowMap = this.shadowGen.getShadowMap();
    this.shadowGen.forceCompilationAsync().then(() => {
      if (this.shadowMap) {
        this.shadowMap.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      }
    });
  }

  // Box helper: builds the mesh, registers its AABB, casts/receives shadows
  private box(
    name: string,
    w: number, h: number, d: number,
    x: number, z: number,
    mat: StandardMaterial,
    yBase: number = 0,
    collide: boolean = true
  ): Mesh {
    const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
    m.position.set(x, yBase + h / 2, z);
    m.material = mat;
    this.collectStatic(mat, m);
    if (collide) {
      PlayerController.registerObstacle(x - w / 2, x + w / 2, yBase, yBase + h, z - d / 2, z + d / 2);
    }
    return m;
  }

  private barrel(name: string, x: number, z: number, mat: StandardMaterial): void {
    const b = MeshBuilder.CreateCylinder(name, { height: 0.95, diameter: 0.62, tessellation: 14 }, this.scene);
    b.position.set(x, 0.475, z);
    b.material = mat;
    this.collectStatic(mat, b);
    PlayerController.registerObstacle(x - 0.31, x + 0.31, 0, 0.95, z - 0.31, z + 0.31);
  }

  // 20ft container (6.1 x 2.6 x 2.5), long axis along x before yaw.
  // doorSide: which local-x end gets the lock-rod door face (0 = none).
  // roll: rotation about the long axis. Every in-bounds container now sits
  // square (roll 0) — the overhead shows no derelict/tilted boxes.
  private container(
    name: string,
    cx: number, cz: number,
    yaw: number,
    mat: StandardMaterial,
    doorMat: StandardMaterial | null,
    doorSide: 1 | -1 | 0,
    yBase: number = 0,
    roll: number = 0,
    collide: boolean = true
  ): void {
    const cosR = Math.cos(roll);
    const sinR = Math.abs(Math.sin(roll));
    const cy = yBase + 1.3 * cosR + 1.25 * sinR; // low long-edge stays grounded

    const body = MeshBuilder.CreateBox(name, { width: 6.1, height: 2.6, depth: 2.5 }, this.scene);
    body.position.set(cx, cy, cz);
    body.rotation.set(roll, yaw, 0);
    body.computeWorldMatrix(true);
    body.material = mat;
    this.collectStatic(mat, body);

    if (doorMat && doorSide !== 0) {
      // local +x maps to world (cos yaw, -sin yaw)
      const dx = Math.cos(yaw) * 3.08 * doorSide;
      const dz = -Math.sin(yaw) * 3.08 * doorSide;
      const door = MeshBuilder.CreateBox(`${name}_door`, { width: 0.07, height: 2.44, depth: 2.4 }, this.scene);
      door.position.set(cx + dx, cy, cz + dz);
      door.rotation.set(roll, yaw, 0);
      door.computeWorldMatrix(true);
      door.material = doorMat;
      this.collectStatic(doorMat, door);
    }

    if (collide) {
      const crossHalf = 1.25 * cosR + 1.3 * sinR;
      PlayerController.registerObstacleOBB(
        cx, cz,
        3.05 + 0.05, crossHalf + 0.05,
        yBase, yBase + 2 * (1.3 * cosR + 1.25 * sinR),
        yaw
      );
    }
  }

  // Open container shell: two side walls, roof, end headers, plywood floor.
  // Mouths are BARE — no door leaves on any open crate (per the poster).
  // closedEnd 0 = open both ends, walk straight through; ±1 seals that end
  // with a full wall so it becomes a one-mouth half-open pocket.
  private openContainer(
    name: string,
    cx: number, cz: number,
    axis: "x" | "z",
    mat: StandardMaterial,
    closedEnd: 1 | -1 | 0 = 0
  ): void {
    const len = 6.1;
    const alongX = axis === "x";
    const woodMat = this.loader.createWoodCrateMaterial(this.scene);

    if (alongX) {
      this.box(`${name}_w1`, len, 2.6, 0.1, cx, cz - 1.2, mat);
      this.box(`${name}_w2`, len, 2.6, 0.1, cx, cz + 1.2, mat);
      this.box(`${name}_roof`, len, 0.16, 2.5, cx, cz, mat, 2.44, false);
      this.box(`${name}_hdrA`, 0.14, 0.3, 2.5, cx - len / 2 + 0.07, cz, mat, 2.3, false);
      this.box(`${name}_hdrB`, 0.14, 0.3, 2.5, cx + len / 2 - 0.07, cz, mat, 2.3, false);
      // floor base sits 6mm proud of the stone walkway slabs (no coplanar tops)
      this.box(`${name}_floor`, len - 0.1, 0.04, 2.4, cx, cz, woodMat, 0.006, false);
      PlayerController.registerObstacle(cx - len / 2, cx + len / 2, 2.44, 2.6, cz - 1.25, cz + 1.25);
    } else {
      this.box(`${name}_w1`, 0.1, 2.6, len, cx - 1.2, cz, mat);
      this.box(`${name}_w2`, 0.1, 2.6, len, cx + 1.2, cz, mat);
      this.box(`${name}_roof`, 2.5, 0.16, len, cx, cz, mat, 2.44, false);
      this.box(`${name}_hdrA`, 2.5, 0.3, 0.14, cx, cz - len / 2 + 0.07, mat, 2.3, false);
      this.box(`${name}_hdrB`, 2.5, 0.3, 0.14, cx, cz + len / 2 - 0.07, mat, 2.3, false);
      this.box(`${name}_floor`, 2.4, 0.04, len - 0.1, cx, cz, woodMat, 0.006, false);
      PlayerController.registerObstacle(cx - 1.25, cx + 1.25, 2.44, 2.6, cz - len / 2, cz + len / 2);
    }

    // half-open: seal one end with a full-height wall (collides, so the
    // pocket has a solid back) — leaves the other end as the only mouth
    if (closedEnd !== 0) {
      const off = closedEnd * (len / 2 - 0.05);
      if (alongX) {
        this.box(`${name}_cap`, 0.1, 2.44, 2.3, cx + off, cz, mat);
      } else {
        this.box(`${name}_cap`, 2.3, 2.44, 0.1, cx, cz + off, mat);
      }
    }
  }

  // Stack of shipping pallets (rough boards, ~0.65m high)
  private pallet(cx: number, cz: number, yaw: number): void {
    const woodMat = this.loader.createWoodCrateMaterial(this.scene);
    for (let i = 0; i < 4; i++) {
      const p = MeshBuilder.CreateBox(`pallet_${cx}_${cz}_${i}`, { width: 1.6, height: 0.13, depth: 1.3 }, this.scene);
      p.position.set(cx, 0.065 + i * 0.165, cz);
      p.rotation.y = yaw + (i % 2) * 0.07;
      p.computeWorldMatrix(true);
      p.material = woodMat;
      this.collectStatic(woodMat, p);
    }
    PlayerController.registerObstacleOBB(cx, cz, 0.84, 0.69, 0, 0.63, yaw);
  }

  private crate(cx: number, cz: number, size: number, yaw: number): void {
    const woodMat = this.loader.createWoodCrateMaterial(this.scene);
    const c = MeshBuilder.CreateBox(`crate_${cx}_${cz}`, { width: size, height: size, depth: size }, this.scene);
    c.position.set(cx, size / 2, cz);
    c.rotation.y = yaw;
    c.computeWorldMatrix(true);
    c.material = woodMat;
    this.collectStatic(woodMat, c);
    const h = size / 2 + 0.03;
    PlayerController.registerObstacleOBB(cx, cz, h, h, 0, size, yaw);
  }

  // Abandoned car: full CarWreck build — shaped body and pillars merged with
  // the static map, plus individually shootable window panes
  private carWreck(cx: number, cz: number, yaw: number): void {
    new CarWreck(
      this.scene,
      this.loader,
      new Vector3(cx, 0, cz),
      yaw,
      (mat, mesh) => this.collectStatic(mat, mesh)
    );
    PlayerController.registerObstacleOBB(cx, cz, 2.2, 0.94, 0, 1.5, yaw);
  }

  // Abandoned box truck: full TruckWreck build — cavity cab with interior,
  // breakable windshield/door glass on the weapons' hitscan, dual rear
  // wheels, roll-up door — merged with the static map like the car.
  private truckWreck(cx: number, cz: number, yaw: number): void {
    new TruckWreck(
      this.scene,
      this.loader,
      new Vector3(cx, 0, cz),
      yaw,
      (mat, mesh) => this.collectStatic(mat, mesh)
    );
    PlayerController.registerObstacleOBB(cx, cz, 3.25, 1.2, 0, 2.95, yaw);
  }

  // ---------------- layout (coordinates traced from the overhead) ----------------

  private createCenterBlocks(): void {
    const green = this.loader.createContainerMaterial(this.scene, "green", "#4a5d44", "#3c4d38");
    const rust = this.loader.createContainerMaterial(this.scene, "rust", "#7d4a32", "#6a3e2a");
    const blue = this.loader.createContainerMaterial(this.scene, "blue", "#3a566e", "#2f4759");
    const red = this.loader.createContainerMaterial(this.scene, "red", "#71382e", "#5e2e26");
    const gray = this.loader.createContainerMaterial(this.scene, "gray", "#878a82", "#74776f");
    const greenDoor = this.loader.createContainerDoorMaterial(this.scene, "green", "#4a5d44", "#41523c");
    const blueDoor = this.loader.createContainerDoorMaterial(this.scene, "blue", "#3a566e", "#334b60");
    const redDoor = this.loader.createContainerDoorMaterial(this.scene, "red", "#71382e", "#633129");
    const rustDoor = this.loader.createContainerDoorMaterial(this.scene, "rust", "#7d4a32", "#6e412c");
    const grayDoor = this.loader.createContainerDoorMaterial(this.scene, "gray", "#878a82", "#7a7d74");
    const metalMat = this.loader.createMetalMaterial(this.scene);

    // NW: green stack. North column is a closed double-high pair. The south
    // container is the ONE HALF-OPEN center box (per the diagram's yellow mark
    // on the top-left block) — its east mouth opens onto the cross, far end
    // sealed — with a closed unit stacked above it to keep the block's height.
    this.container("nwN_lo", -4.3, 5.16, 0, green, greenDoor, 1);
    this.container("nwN_hi", -4.3, 5.16, 0, green, greenDoor, 1, 2.6);
    this.openContainer("nwOpen", -4.3, 2.64, "x", green, -1); // mouth east, sealed west
    this.container("nwS_hi", -4.3, 2.64, 0, green, greenDoor, 1, 2.6);
    this.barrel("barrelNW1", -7.8, 5.6, metalMat);
    this.barrel("barrelNW2", -7.9, 4.5, metalMat);

    // NE: two CLOSED containers (the poster's center blocks are all solid —
    // you move through the lanes between them, not through the boxes).
    // Barrels flank the mouths (the circle pairs on the overhead).
    this.container("neBack", 4.6, 5.26, 0, blue, blueDoor, -1);
    this.container("neFront", 4.6, 2.74, 0, rust, rustDoor, -1);
    this.barrel("barrelNE1", 0.9, 6.1, metalMat);
    this.barrel("barrelNE2", 0.9, 4.7, metalMat);
    this.barrel("barrelNE3", 7.95, 6.05, metalMat);
    this.barrel("barrelNE4", 7.95, 4.6, metalMat);
    this.crate(9.2, 4.6, 1.3, 0.18);

    // SW: two CLOSED containers (gray on the cross, blue behind it)
    this.container("swFront", -4.5, -2.14, 0, gray, grayDoor, 1);
    this.container("swClosed", -4.5, -4.66, 0, blue, blueDoor, 1);

    // SE: the red double stack
    for (const rz of [-2.34, -4.86]) {
      this.container(`seLo${rz}`, 4.6, rz, 0, red, redDoor, -1);
      this.container(`seHi${rz}`, 4.6, rz, 0, red, redDoor, -1, 2.6);
    }
    this.barrel("barrelSE1", 7.95, -5.3, metalMat);
  }

  private createEdgeStructures(): void {
    const rust = this.loader.createContainerMaterial(this.scene, "rust", "#7d4a32", "#6a3e2a");
    const blue = this.loader.createContainerMaterial(this.scene, "blue", "#3a566e", "#2f4759");
    const gray = this.loader.createContainerMaterial(this.scene, "gray", "#878a82", "#74776f");
    const grayDoor = this.loader.createContainerDoorMaterial(this.scene, "gray", "#878a82", "#7a7d74");
    const blueDoor = this.loader.createContainerDoorMaterial(this.scene, "blue", "#3a566e", "#334b60");

    // North edge: a HALF-OPEN inner container (one mouth open — walk-in pocket,
    // sealed at the far end) backed by a closed outer one against the wall.
    // This is the pair 90° from the E/W pass-throughs: one side open, not both.
    this.openContainer("nInner", 0, 11.4, "x", rust, 1); // open west, sealed east
    this.container("nOuter", 0, 13.9, 0, gray, grayDoor, -1);

    // South edge: mirrored — half-open inner (open east), closed outer; the
    // overhead's small crates sit by the pair (two SW, one at the east mouth)
    this.openContainer("sInner", 0, -11.3, "x", blue, -1); // open east, sealed west
    this.container("sOuter", 0, -13.8, 0, gray, grayDoor, 1);
    this.crate(-7.1, -13.85, 1.25, 0.08);
    this.crate(-5.7, -13.85, 1.25, -0.06);
    this.crate(4.6, -13.9, 1.25, 0.12);

    // West edge: the fully-open pass-through is the container AGAINST the
    // wall (both mouths bare); the closed one sits second in from the wall
    this.openContainer("wOpen", -14.7, 0.6, "z", gray);
    this.container("wClosed", -12.35, 0.75, Math.PI / 2, gray, grayDoor, -1);

    // East edge: mirrored — open pass-through at the wall, closed beside it
    this.openContainer("eOpen", 14.7, 0.35, "z", blue);
    this.container("eClosed", 12.15, 0.6, Math.PI / 2, blue, blueDoor, -1);
  }

  private createCornerClutter(): void {
    const metalMat = this.loader.createMetalMaterial(this.scene);

    // NW: pallet + crate at skewed angles
    this.pallet(-10.1, 9.6, 0.5);
    this.crate(-6.6, 10.0, 1.3, -0.3);

    // NE: the white box truck — shifted 90° from the old facing so its long
    // axis runs NW-SE (the poster's "\" orientation), nose toward the
    // south-east lane mouth. Pocket behind it stays walkable.
    this.truckWreck(9.9, 10.2, -0.6 + Math.PI / 2);

    // SW: the abandoned car + barrels
    this.carWreck(-10.9, -9.9, 0.65);
    this.barrel("barrelSW1", -8.4, -11.2, metalMat);
    this.barrel("barrelSW2", -7.9, -11.8, metalMat);

    // SE: pallets at the lane mouths
    this.pallet(11.4, -10.5, 0.55);
    this.pallet(11.8, -6.6, -0.3);
  }

  // Everything past the walls is set dressing: no collision, fog does the rest
  private createOutOfBounds(): void {
    const concreteMat = this.loader.createConcreteMaterial(this.scene, 8, 2);
    const concreteTall = this.loader.createConcreteMaterial(this.scene, 6, 3);
    const metalMat = this.loader.createMetalMaterial(this.scene);
    const windowMat = this.loader.createWindowBandMaterial(this.scene);
    const green = this.loader.createContainerMaterial(this.scene, "green", "#4a5d44", "#3c4d38");
    const rust = this.loader.createContainerMaterial(this.scene, "rust", "#7d4a32", "#6a3e2a");
    const blue = this.loader.createContainerMaterial(this.scene, "blue", "#3a566e", "#2f4759");
    const gray = this.loader.createContainerMaterial(this.scene, "gray", "#878a82", "#74776f");

    let darkMat = this.scene.getMaterialByName("wreckDarkMat") as StandardMaterial | null;
    if (!darkMat) {
      darkMat = new StandardMaterial("wreckDarkMat", this.scene);
      darkMat.diffuseColor = new Color3(0.1, 0.1, 0.11);
      darkMat.specularColor = new Color3(0.05, 0.05, 0.05);
    }

    // -- NORTH warehouse: wider, taller, with loading bay details --
    this.box("warehouseN", 30, 10, 12, -2, 27, concreteTall, 0, false);
    // two rows of windows
    this.box("warehouseN_win1", 22, 1.6, 0.12, -2, 20.96, windowMat, 5.2, false);
    this.box("warehouseN_win2", 14, 1.2, 0.12, -2, 20.96, windowMat, 7.8, false);
    // loading dock door (recessed dark panel)
    this.box("warehouseN_door1", 3.4, 3.8, 0.12, -6, 20.97, darkMat, 0, false);
    this.box("warehouseN_door2", 3.4, 3.8, 0.12, 3, 20.97, darkMat, 0, false);
    // dock bump-stops (small raised sills below each door)
    this.box("warehouseN_sill1", 3.6, 0.25, 0.6, -6, 20.7, concreteMat, 0, false);
    this.box("warehouseN_sill2", 3.6, 0.25, 0.6, 3, 20.7, concreteMat, 0, false);
    // parapet / roof edge
    this.box("warehouseN_parapet", 30.4, 0.6, 0.3, -2, 21.14, concreteMat, 10, false);
    // ventilation boxes on roof
    this.box("warehouseN_vent1", 2.2, 1.2, 1.8, -8, 25, metalMat, 10, false);
    this.box("warehouseN_vent2", 2.2, 1.2, 1.8, 4, 25, metalMat, 10, false);
    // vent hoods (trapezoidal top – faked with a flat cap)
    this.box("warehouseN_ventcap1", 2.6, 0.18, 2.2, -8, 25, concreteMat, 11.2, false);
    this.box("warehouseN_ventcap2", 2.6, 0.18, 2.2, 4, 25, concreteMat, 11.2, false);
    // exhaust pipe
    const exhaust1 = MeshBuilder.CreateCylinder("exhaust1", { height: 2.2, diameter: 0.35, tessellation: 10 }, this.scene);
    exhaust1.position.set(-12, 11.1, 24.5);
    exhaust1.material = metalMat;
    this.collectStatic(metalMat, exhaust1);

    // -- WEST warehouse: taller with fire-escape ladder --
    this.box("warehouseW", 12, 9, 28, -28, 1, concreteTall, 0, false);
    this.box("warehouseW_win1", 0.12, 1.5, 22, -22.0, 1, windowMat, 4.5, false);
    this.box("warehouseW_win2", 0.12, 1.0, 14, -22.0, 1, windowMat, 7.2, false);
    this.box("warehouseW_door", 0.12, 3.5, 3.0, -22.0, -6, darkMat, 0, false);
    this.box("warehouseW_parapet", 0.3, 0.55, 28.4, -22.14, 1, concreteMat, 9, false);
    // fire-escape landing + rungs
    this.box("warehouseW_esc_plat", 0.12, 0.08, 2.4, -22.0, -2, metalMat, 4.5, false);
    for (let r = 0; r < 8; r++) {
      this.box(`warehouseW_rung${r}`, 0.08, 0.06, 0.45, -22.0, -1.2, metalMat, 0.5 + r * 0.56, false);
    }
    // ac unit on side wall
    this.box("warehouseW_ac", 0.25, 0.7, 1.1, -22.1, 4, metalMat, 3, false);

    // -- EAST warehouse --
    this.box("warehouseE", 12, 9, 26, 28, -2, concreteTall, 0, false);
    this.box("warehouseE_win1", 0.12, 1.5, 20, 22.0, -2, windowMat, 4.5, false);
    this.box("warehouseE_win2", 0.12, 1.0, 12, 22.0, -2, windowMat, 7.2, false);
    this.box("warehouseE_door", 0.12, 3.5, 3.0, 22.0, 4, darkMat, 0, false);
    this.box("warehouseE_parapet", 0.3, 0.55, 26.4, 22.14, -2, concreteMat, 9, false);
    // signage panel
    this.box("warehouseE_sign", 0.1, 1.0, 4.5, 22.06, -8, darkMat, 6, false);
    // exhaust pipe
    const exhaust2 = MeshBuilder.CreateCylinder("exhaust2", { height: 2.8, diameter: 0.4, tessellation: 10 }, this.scene);
    exhaust2.position.set(24.5, 10.4, -10);
    exhaust2.material = metalMat;
    this.collectStatic(metalMat, exhaust2);

    // -- Container stacks: more layers and variation --
    this.container("oobStackS1a", 6, -23, 0.15, green, null, 0, 0, 0, false);
    this.container("oobStackS1b", 6, -23, 0.15, green, null, 0, 2.6, 0, false);
    this.container("oobStackS1c", 6.3, -23, 0.15, rust, null, 0, 5.2, 0, false);
    this.container("oobStackS2a", -9, -24, -0.2, blue, null, 0, 0, 0, false);
    this.container("oobStackS2b", -8.8, -24.1, -0.18, gray, null, 0, 2.6, 0, false);
    this.container("oobStackS3", 16, -22, 0.05, rust, null, 0, 0, 0, false);
    this.container("oobStackE1a", 21, 8, 0.1, rust, null, 0, 0, 0, false);
    this.container("oobStackE1b", 21, 8, 0.1, rust, null, 0, 2.6, 0, false);
    this.container("oobStackE1c", 21.2, 8.1, 0.12, blue, null, 0, 5.2, 0, false);
    this.container("oobStackE2", 24, 1, -0.05, green, null, 0, 0, 0, false);
    this.container("oobStackW1a", -24, -8, 0.08, gray, null, 0, 0, 0, false);
    this.container("oobStackW1b", -24, -8, 0.08, blue, null, 0, 2.6, 0, false);

    // Dumpsters near south / east walls
    this.box("dumpsterS1", 2.0, 1.3, 1.0, 14, -19, darkMat, 0, false);
    this.box("dumpsterS1_lid", 2.1, 0.08, 1.1, 14, -19, metalMat, 1.3, false);
    this.box("dumpsterE1", 1.0, 1.3, 2.0, 20, 12, darkMat, 0, false);
    this.box("dumpsterE1_lid", 1.1, 0.08, 2.1, 20, 12, metalMat, 1.3, false);

    // Forklift silhouette near north warehouse
    this.box("fork_body", 2.4, 1.4, 1.4, -14, 21.5, metalMat, 0, false);
    this.box("fork_mast", 0.14, 3.2, 0.3, -12.8, 21.5, metalMat, 0, false);
    this.box("fork_arm1", 1.4, 0.1, 0.08, -13.5, 21.2, metalMat, 1.8, false);
    this.box("fork_arm2", 1.4, 0.1, 0.08, -13.5, 21.8, metalMat, 1.8, false);

    // -- Water tower (north-east, taller version) --
    const tx = 10, tz = 30;
    for (const [lx, lz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) {
      this.box(`tower_leg_${lx}_${lz}`, 0.22, 13, 0.22, tx + lx, tz + lz, metalMat, 0, false);
    }
    // diagonal cross-braces on two faces
    for (const bz of [-1.6, 1.6]) {
      this.box(`tower_brace_lo_${bz}`, 3.6, 0.14, 0.14, tx, tz + bz, metalMat, 3.2, false);
      this.box(`tower_brace_hi_${bz}`, 3.6, 0.14, 0.14, tx, tz + bz, metalMat, 7.4, false);
      this.box(`tower_brace_mid_${bz}`, 3.6, 0.14, 0.14, tx, tz + bz, metalMat, 5.4, false);
    }
    for (const bx of [-1.6, 1.6]) {
      this.box(`tower_brace2_lo_${bx}`, 0.14, 0.14, 3.6, tx + bx, tz, metalMat, 3.2, false);
      this.box(`tower_brace2_hi_${bx}`, 0.14, 0.14, 3.6, tx + bx, tz, metalMat, 7.4, false);
    }
    const tank = MeshBuilder.CreateCylinder("tower_tank", { height: 3.8, diameter: 5.0, tessellation: 18 }, this.scene);
    tank.position.set(tx, 14.9, tz);
    tank.material = metalMat;
    this.collectStatic(metalMat, tank);
    const cone = MeshBuilder.CreateCylinder("tower_cone", { height: 1.8, diameterTop: 0.5, diameterBottom: 5.2, tessellation: 18 }, this.scene);
    cone.position.set(tx, 17.7, tz);
    cone.material = metalMat;
    this.collectStatic(metalMat, cone);
    // tank bands (two ring hoops)
    for (const ry of [13.6, 15.8]) {
      const hoop = MeshBuilder.CreateTorus(`tower_hoop_${ry}`, { diameter: 5.1, thickness: 0.12, tessellation: 28 }, this.scene);
      hoop.position.set(tx, ry, tz);
      hoop.material = metalMat;
      this.collectStatic(metalMat, hoop);
    }
    // overflow pipe on side of tank
    this.box("tower_pipe", 0.1, 4.0, 0.1, tx + 2.6, tz, metalMat, 10, false);

    // -- Yard light poles --
    let lampMat = this.scene.getMaterialByName("lampHeadMat") as StandardMaterial | null;
    if (!lampMat) {
      lampMat = new StandardMaterial("lampHeadMat", this.scene);
      lampMat.diffuseColor = new Color3(0.2, 0.2, 0.2);
      lampMat.emissiveColor = new Color3(0.55, 0.58, 0.52);
    }
    const poles: Array<[number, number, number, number]> = [
      [-20, 11, 1, 0],
      [22, -1, -1, 0],
      [7, 23, 0, -1],
      [-18, -14, 0.7, 0.7],  // extra SW lamp
    ];
    for (const [px, pz, dx, dz] of poles) {
      const pole = MeshBuilder.CreateCylinder(`lamp_${px}_${pz}`, { height: 8.5, diameter: 0.22, tessellation: 10 }, this.scene);
      pole.position.set(px, 4.25, pz);
      pole.material = metalMat;
      this.collectStatic(metalMat, pole);
      // base collar
      const collar = MeshBuilder.CreateCylinder(`lamp_collar_${px}_${pz}`, { height: 0.4, diameterTop: 0.32, diameterBottom: 0.56, tessellation: 10 }, this.scene);
      collar.position.set(px, 0.2, pz);
      collar.material = metalMat;
      this.collectStatic(metalMat, collar);
      const arm = MeshBuilder.CreateBox(`lamp_arm_${px}_${pz}`, { width: 1.6, height: 0.12, depth: 0.12 }, this.scene);
      arm.position.set(px + dx * 0.8, 8.35, pz + dz * 0.8);
      arm.rotation.y = Math.atan2(-dz, dx);
      arm.computeWorldMatrix(true);
      arm.material = metalMat;
      this.collectStatic(metalMat, arm);
      const head = MeshBuilder.CreateBox(`lamp_head_${px}_${pz}`, { width: 0.62, height: 0.18, depth: 0.32 }, this.scene);
      head.position.set(px + dx * 1.55, 8.22, pz + dz * 1.55);
      head.rotation.y = Math.atan2(-dz, dx);
      head.computeWorldMatrix(true);
      head.material = lampMat;
      this.collectStatic(lampMat, head);
    }

    // -- Utility pipes running along the south exterior wall face --
    for (let pi = 0; pi < 3; pi++) {
      const pipe = MeshBuilder.CreateCylinder(`wallpipe_${pi}`, { height: 34, diameter: 0.18, tessellation: 8 }, this.scene);
      pipe.rotation.z = Math.PI / 2;
      pipe.computeWorldMatrix(true);
      pipe.position.set(0, 0.55 + pi * 0.38, -16.85);
      pipe.material = metalMat;
      this.collectStatic(metalMat, pipe);
    }
    // junction box on south wall
    this.box("junctionBox", 0.55, 0.55, 0.1, -8, -16.8, metalMat, 1.4, false);

    // Billboards — the two yard murals promoted to full hoarding size, mounted
    // flush with the roofline of the nearest warehouses facing the play area.
    const billH = 5.0;
    const billFrame = 0.7; // backing taller than image on all sides

    // Mural 1 (3:4 portrait) on the north warehouse south face (z ≈ 21, roof y=10)
    const b1YBase = 10.0 - (billH + billFrame); // top of backing flush with roof
    const b1Mat = this.loader.createBillboardMuralMaterial(this.scene, 1);
    this.box("billN_back", 4.3, billH + billFrame, 0.14, -5, 20.93, darkMat, b1YBase, false);
    const b1 = MeshBuilder.CreatePlane(
      "billN_img",
      { width: billH * 0.75, height: billH, sideOrientation: Mesh.DOUBLESIDE },
      this.scene
    );
    b1.position.set(-5, b1YBase + (billH + billFrame) / 2, 20.82);
    b1.material = b1Mat;
    b1.receiveShadows = true;
    b1.freezeWorldMatrix();

    // Mural 2 (452×768) on the east warehouse west face (x ≈ 22, roof y=9)
    const b2YBase = 9.0 - (billH + billFrame); // top of backing flush with roof
    const b2Mat = this.loader.createBillboardMuralMaterial(this.scene, 2);
    this.box("billE_back", 0.14, billH + billFrame, 3.3, 21.93, 2, darkMat, b2YBase, false);
    const b2 = MeshBuilder.CreatePlane(
      "billE_img",
      { width: billH * (452 / 768), height: billH, sideOrientation: Mesh.DOUBLESIDE },
      this.scene
    );
    b2.position.set(21.82, b2YBase + (billH + billFrame) / 2, 2);
    b2.rotation.y = Math.PI / 2;
    b2.computeWorldMatrix(true);
    b2.material = b2Mat;
    b2.receiveShadows = true;
    b2.freezeWorldMatrix();
  }

  // Long grass: thousands of crossed-quad blade tufts pushed through one
  // thin-instanced mesh (a single draw call). Dense inside the walls, a
  // sparser meadow rolling out past them; skips the walkways, every prop
  // footprint, the open-container floors and the OOB buildings.
  private createLongGrass(): void {
    const mat = new StandardMaterial("grassTuftMat", this.scene);
    mat.diffuseTexture = this.loader.createGrassBladeTexture(this.scene);
    const bladeMask = this.loader.createGrassBladeMaskTexture(this.scene);
    bladeMask.getAlphaFromRGB = true;
    mat.opacityTexture = bladeMask;
    mat.transparencyMode = 1; // alpha-test cutout — no sorting, no halos
    // mip-averaged mask values sit well below the default 0.4 cutoff — the
    // low threshold keeps distant blades from vanishing into chunky stubs
    mat.alphaCutOff = 0.02;
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    mat.specularColor = new Color3(0.05, 0.06, 0.05);
    // vertical quads catch little of the hemispheric sky light — this fakes
    // the overcast skylight wrapping through the blades
    mat.emissiveColor = new Color3(0.13, 0.15, 0.11);

    const quadA = MeshBuilder.CreatePlane("tuftA", { width: 0.72, height: 0.62 }, this.scene);
    quadA.position.y = 0.31;
    const quadB = quadA.clone("tuftB");
    quadB.rotation.y = Math.PI / 2;
    const tuft = Mesh.MergeMeshes([quadA, quadB], true, true, undefined, false, false);
    if (!tuft) return;
    tuft.material = mat;
    tuft.isPickable = false; // bullets fly through grass
    tuft.alwaysSelectAsActiveMesh = true; // instance bounds are never recomputed
    tuft.receiveShadows = false;

    // keep-clear rects [minX, maxX, minZ, maxZ]
    const clear: Array<[number, number, number, number]> = [
      [-1.3, 1.6, -14.1, 14.1], // NS walkway
      [-14.1, 14.1, -1.05, 1.55], // EW walkway
      [-15.9, 15.9, 14.1, 15.9], // wall-footing ring
      [-15.9, 15.9, -15.9, -14.1],
      [14.1, 15.9, -14.1, 14.1],
      [-15.9, -14.1, -14.1, 14.1],
      [-15.95, -11.1, -2.9, 3.85], // west pass-through container floor
      [11.15, 15.95, -2.8, 3.85], // east pass-through container floor
      [-3.1, 3.1, 10.1, 12.7], // north walk-in container floor
      [-3.1, 3.1, -12.6, -10.0], // south walk-in container floor
      [-7.4, -1.2, 1.35, 3.95], // NW center half-open container floor
      [-15, 9, 21, 31], // OOB warehouses
      [-32, -22, -10, 14],
      [22, 32, -14, 8],
      [2, 10, -25.5, -20.5], // OOB container stacks
      [-12.5, -5.5, -26, -22],
      [17.5, 24.5, 5.5, 10.5],
    ];
    const obstacles = PlayerController.getObstacles();

    const open = (x: number, z: number): boolean => {
      for (const [a, b, c, d] of clear) {
        if (x > a && x < b && z > c && z < d) return false;
      }
      for (const obs of obstacles) {
        if (obs.minY > 0.5) continue; // roofs don't shade the ground
        const dx = x - obs.cx;
        const dz = z - obs.cz;
        const cos = Math.cos(obs.yaw);
        const sin = Math.sin(obs.yaw);
        if (
          Math.abs(cos * dx - sin * dz) < obs.hw + 0.12 &&
          Math.abs(sin * dx + cos * dz) < obs.hd + 0.12
        ) {
          return false;
        }
      }
      return true;
    };

    const matrices: number[] = [];
    const tmpMat = new Matrix();
    const tmpScale = new Vector3();
    const tmpPos = new Vector3();
    const drop = (px: number, pz: number): void => {
      const sy = 0.78 + Math.random() * 0.85; // blades 0.5m..1m tall
      const sxz = 0.8 + Math.random() * 0.55;
      tmpScale.set(sxz, sy, sxz);
      tmpPos.set(px, 0, pz);
      Matrix.ComposeToRef(
        tmpScale,
        Quaternion.RotationYawPitchRoll(Math.random() * Math.PI, (Math.random() - 0.5) * 0.12, 0),
        tmpPos,
        tmpMat
      );
      for (let i = 0; i < 16; i++) matrices.push(tmpMat.m[i]);
    };

    // dense carpet inside the walls
    for (let gx = -15.7; gx <= 15.7; gx += 0.62) {
      for (let gz = -15.7; gz <= 15.7; gz += 0.62) {
        if (Math.random() < 0.18) continue; // natural patchiness
        const px = gx + (Math.random() - 0.5) * 0.5;
        const pz = gz + (Math.random() - 0.5) * 0.5;
        if (open(px, pz)) drop(px, pz);
      }
    }
    // sparser meadow past the walls, fading into the fog
    for (let gx = -40; gx <= 40; gx += 1.3) {
      for (let gz = -40; gz <= 40; gz += 1.3) {
        if (Math.abs(gx) < 16.4 && Math.abs(gz) < 16.4) continue;
        if (Math.random() < 0.3) continue;
        const px = gx + (Math.random() - 0.5) * 1.0;
        const pz = gz + (Math.random() - 0.5) * 1.0;
        if (open(px, pz)) drop(px, pz);
      }
    }

    tuft.thinInstanceSetBuffer("matrix", new Float32Array(matrices), 16, true);
  }

  // Steady rain: stretched streak billboards falling through a volume that
  // rides above the player. updateSpeed = 1/60 makes emitPower read as
  // meters/second and lifetimes read as seconds at any frame rate.
  private createRain(): void {
    const rain = new ParticleSystem("rain", 3000, this.scene);
    rain.particleTexture = this.loader.createRainStreakTexture(this.scene);
    rain.emitter = this.rainAnchor;
    rain.minEmitBox = new Vector3(-11, 0, -11);
    rain.maxEmitBox = new Vector3(11, 2.5, 11);
    rain.direction1 = new Vector3(-0.07, -1, -0.03); // light wind slant
    rain.direction2 = new Vector3(-0.04, -1, -0.01);
    rain.minEmitPower = 11.5;
    rain.maxEmitPower = 14;
    rain.updateSpeed = 1 / 60;
    rain.minLifeTime = 1.0;
    rain.maxLifeTime = 1.1;
    rain.emitRate = 2600;
    rain.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
    rain.minScaleX = 0.025; // streak width (m)
    rain.maxScaleX = 0.04;
    rain.minScaleY = 0.9; // streak length along the fall
    rain.maxScaleY = 1.3;
    rain.color1 = new Color4(0.85, 0.9, 0.97, 0.6);
    rain.color2 = new Color4(0.7, 0.76, 0.85, 0.48);
    rain.colorDead = new Color4(0.7, 0.76, 0.85, 0);
    rain.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    rain.preWarmCycles = 90; // already raining on the first frame
    rain.preWarmStepOffset = 2;
    rain.start();
  }

  public update(deltaTime: number): void {
    // Keep the rain volume over the player's head
    const cam = this.scene.activeCamera;
    if (cam) {
      this.rainAnchor.x = cam.globalPosition.x;
      this.rainAnchor.z = cam.globalPosition.z;
    }

    let animating = false;
    for (const target of this.targets) {
      target.update(deltaTime);
      if (target.isAnimating) animating = true;
    }
    if (animating && this.shadowMap) {
      this.shadowMap.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    }
  }
}
