import { Mesh, MeshBuilder, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import { flatMat } from "../rendering/materials/canvas";
import { createTaperedLimb, handAnchor, mergeWeaponParts, prim } from "./kit";
import type { HandPose, WeaponViewModel } from "./kit";
import { knurlTexture, mp44MetalTexture, mp44WoodTexture } from "./weaponTextures";

// MP44 assault rifle: hooded ring front sight, tall rear notch, ribbed
// stamped receiver, dark wet metal, curved magazine. Animated pivots the
// rig drives by name: mp44BoltGroup (reciprocates / charging handle),
// mp44MagGroup (drops and seats during reload).

// Trigger hand on the wooden pistol grip
const RIGHT_GRIP: HandPose = {
  wrist: [0.03, 0.025, -0.232],
  knuckles: [0, -0.35, 0.94],
  palm: [-1, 0, 0],
  curl: { thumb: 0.6, index: 0.4, middle: 1.0, ring: 1.0, pinky: 1.0 },
};

// Support hand cupping the fore-end from below
const LEFT_GRIP: HandPose = {
  wrist: [-0.075, 0.0, 0.1],
  knuckles: [0.9, 0.35, 0.25],
  palm: [-0.35, 0.92, 0.1],
  curl: { thumb: 0.45, index: 0.85, middle: 0.9, ring: 0.95, pinky: 1.0 },
};

export function buildMp44ViewModel(scene: Scene): WeaponViewModel {
  const parent = new Mesh("mp44_root", scene);

  // Physically based metals and wood: the phosphate receiver and barrel,
  // the bare steel of the worn edges and the laminated furniture all take
  // their reflections from the yard environment
  // (the painted phosphate is dark, so the albedo multiplier lifts it back
  // to a gunmetal that still catches the sky)
  const metalMat = flatMat(scene, "mp44MetalMat", {
    albedo: [2.0, 2.02, 2.06],
    rough: 0.46,
    metal: 0.55,
    tex: mp44MetalTexture(scene),
  });
  const darkMat = flatMat(scene, "mp44DarkMat", { albedo: [0.16, 0.17, 0.18], rough: 0.5, metal: 0.6 });
  const edgeMat = flatMat(scene, "mp44WornEdgeMat", { albedo: [0.62, 0.64, 0.66], rough: 0.24, metal: 1 });
  const woodMat = flatMat(scene, "mp44WoodMat", { albedo: [1.35, 1.22, 1.08], rough: 0.42, tex: mp44WoodTexture(scene) });
  const knurlMat = flatMat(scene, "mp44KnurlMat", { albedo: [0.7, 0.7, 0.74], rough: 0.4, metal: 1, tex: knurlTexture(scene) });

  const sightDotMat = flatMat(scene, "mp44SightDotMat", { albedo: [0.72, 0.72, 0.66], rough: 0.6, emissive: [0.32, 0.32, 0.26] });

  const brassMat = flatMat(scene, "mp44BrassMat", { albedo: [0.85, 0.64, 0.3], rough: 0.3, metal: 1 });

  const rubberMat = flatMat(scene, "mp44RubberMat", { albedo: [0.055, 0.055, 0.06], rough: 0.9 });

  // --- Receiver and barrel assembly ---
  prim(
    MeshBuilder.CreateBox("mp44Receiver", { width: 0.062, height: 0.072, depth: 0.34 }, scene),
    metalMat,
    parent,
    [0, 0.103, -0.055]
  );

  // Kept below the y=+0.17 sight axis so nothing crosses the ADS view,
  // and low enough that the rear leaf stays visible over the tube.
  prim(
    MeshBuilder.CreateCylinder("mp44ReceiverTop", { height: 0.31, diameter: 0.05, tessellation: 24 }, scene),
    metalMat,
    parent,
    [0, 0.128, -0.047],
    { rx: Math.PI / 2, sx: 0.74 }
  );

  prim(
    MeshBuilder.CreateBox("mp44LowerFold", { width: 0.067, height: 0.013, depth: 0.31 }, scene),
    darkMat,
    parent,
    [0, 0.064, -0.055]
  );

  for (let i = 0; i < 7; i++) {
    const z = -0.18 + i * 0.046;
    prim(MeshBuilder.CreateBox(`mp44ReceiverRib${i}`, { width: 0.066, height: 0.0045, depth: 0.012 }, scene), edgeMat, parent, [
      0,
      0.1285,
      z,
    ]);
  }

  for (const sx of [-1, 1]) {
    prim(MeshBuilder.CreateBox(`mp44SideStamp${sx}`, { width: 0.003, height: 0.027, depth: 0.19 }, scene), darkMat, parent, [
      0.033 * sx,
      0.111,
      -0.045,
    ]);

    for (let i = 0; i < 6; i++) {
      prim(
        MeshBuilder.CreateCylinder(`mp44Rivet${sx}_${i}`, { height: 0.004, diameter: 0.0062, tessellation: 10 }, scene),
        edgeMat,
        parent,
        [0.035 * sx, 0.077 + (i % 2) * 0.047, -0.178 + i * 0.061],
        { rz: Math.PI / 2 }
      );
    }
  }

  prim(
    MeshBuilder.CreateBox("mp44EjectionPort", { width: 0.004, height: 0.026, depth: 0.068 }, scene),
    darkMat,
    parent,
    [-0.0338, 0.124, 0.025]
  );

  const boltGroup = new Mesh("mp44BoltGroup", scene);
  boltGroup.position.set(-0.037, 0.126, 0.026);
  boltGroup.parent = parent;

  prim(
    MeshBuilder.CreateBox("mp44BoltFace", { width: 0.005, height: 0.02, depth: 0.054 }, scene),
    edgeMat,
    boltGroup,
    [0.001, 0, 0]
  );

  prim(
    MeshBuilder.CreateCylinder("mp44ChargeStem", { height: 0.026, diameter: 0.006, tessellation: 10 }, scene),
    edgeMat,
    boltGroup,
    [-0.014, 0.004, -0.017],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateSphere("mp44ChargeKnob", { diameter: 0.017, segments: 14 }, scene),
    knurlMat,
    boltGroup,
    [-0.031, 0.004, -0.017]
  );

  prim(
    MeshBuilder.CreateCylinder("mp44ChamberRound", { height: 0.03, diameter: 0.0095, tessellation: 12 }, scene),
    brassMat,
    parent,
    [-0.01, 0.126, 0.025],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("mp44GasTube", { height: 0.27, diameter: 0.024, tessellation: 24 }, scene),
    metalMat,
    parent,
    [0, 0.146, 0.18],
    { rx: Math.PI / 2 }
  );

  // gas-block collar where the tube meets the barrel, plus the bleed port
  prim(
    MeshBuilder.CreateCylinder("mp44GasBlock", { height: 0.03, diameter: 0.032, tessellation: 20 }, scene),
    metalMat,
    parent,
    [0, 0.14, 0.318],
    { rx: Math.PI / 2 }
  );
  prim(
    MeshBuilder.CreateCylinder("mp44GasPort", { height: 0.0185, diameter: 0.007, tessellation: 12 }, scene),
    darkMat,
    parent,
    [0, 0.153, 0.318]
  );

  prim(
    MeshBuilder.CreateCylinder(
      "mp44Barrel",
      { height: 0.36, diameterTop: 0.016, diameterBottom: 0.021, tessellation: 24 },
      scene
    ),
    edgeMat,
    parent,
    [0, 0.121, 0.285],
    { rx: Math.PI / 2 }
  );

  for (const z of [0.08, 0.16, 0.255, 0.37]) {
    prim(
      MeshBuilder.CreateCylinder(`mp44BarrelBand${z}`, { height: 0.012, diameter: 0.034, tessellation: 20 }, scene),
      darkMat,
      parent,
      [0, 0.134, z],
      { rx: Math.PI / 2 }
    );
  }

  prim(
    MeshBuilder.CreateCylinder("mp44Muzzle", { height: 0.034, diameter: 0.024, tessellation: 20 }, scene),
    darkMat,
    parent,
    [0, 0.121, 0.475],
    { rx: Math.PI / 2 }
  );

  // chamfered crown ring catches a bright glint off the muzzle face
  prim(
    MeshBuilder.CreateCylinder(
      "mp44MuzzleCrown",
      { height: 0.006, diameterTop: 0.025, diameterBottom: 0.02, tessellation: 20 },
      scene
    ),
    edgeMat,
    parent,
    [0, 0.121, 0.49],
    { rx: -Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("mp44Bore", { height: 0.004, diameter: 0.011, tessellation: 12 }, scene),
    darkMat,
    parent,
    [0, 0.121, 0.494],
    { rx: Math.PI / 2 }
  );

  // Threaded muzzle-nut step behind the crown
  prim(
    MeshBuilder.CreateCylinder("mp44MuzzleNut", { height: 0.011, diameter: 0.0265, tessellation: 20 }, scene),
    knurlMat,
    parent,
    [0, 0.121, 0.458],
    { rx: Math.PI / 2 }
  );

  // --- Iron sights ---
  // Sight axis invariant: x=0, y=+0.17 in weapon space. The final ADS frame
  // raises the weapon to y=-0.17, so the post tip, hood center, and rear
  // notch all sit exactly on the camera axis — rounds land on the sights.
  const sightY = 0.17;

  // Hooded front sight: pyramid block on the barrel, tapered post whose tip
  // reaches the axis, and a ring hood centered on it.
  prim(
    MeshBuilder.CreateCylinder(
      "mp44FrontSightBase",
      { height: 0.032, diameterBottom: 0.036, diameterTop: 0.013, tessellation: 4 },
      scene
    ),
    metalMat,
    parent,
    [0, 0.137, 0.429],
    { ry: Math.PI / 4 }
  );

  prim(
    MeshBuilder.CreateTorus("mp44FrontSightHood", { diameter: 0.046, thickness: 0.004, tessellation: 36 }, scene),
    darkMat,
    parent,
    [0, sightY, 0.429],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder(
      "mp44FrontPost",
      { height: 0.0145, diameterBottom: 0.006, diameterTop: 0.0044, tessellation: 10 },
      scene
    ),
    darkMat,
    parent,
    [0, 0.159, 0.429]
  );

  prim(
    MeshBuilder.CreateCylinder(
      "mp44FrontPostTip",
      { height: 0.0037, diameterBottom: 0.0044, diameterTop: 0.0036, tessellation: 10 },
      scene
    ),
    sightDotMat,
    parent,
    [0, sightY - 0.00185, 0.429]
  );

  // Rear sight: ramped slider base + leaf with a true V-notch. The whole
  // leaf sits BELOW the sight axis (Fall of Duty reference framing) so the full
  // hood ring and post float above it, unobstructed, at full ADS.
  prim(
    MeshBuilder.CreateBox("mp44RearSightRamp", { width: 0.04, height: 0.016, depth: 0.055 }, scene),
    metalMat,
    parent,
    [0, 0.147, -0.148],
    { rx: -0.08 }
  );

  prim(
    MeshBuilder.CreateBox("mp44RearSlider", { width: 0.045, height: 0.007, depth: 0.015 }, scene),
    edgeMat,
    parent,
    [0, 0.1545, -0.138]
  );

  prim(
    MeshBuilder.CreateBox("mp44RearLeaf", { width: 0.044, height: 0.009, depth: 0.0055 }, scene),
    darkMat,
    parent,
    [0, 0.15, -0.168]
  );

  for (const sx of [-1, 1]) {
    prim(
      MeshBuilder.CreateBox(`mp44RearCheek${sx}`, { width: 0.0165, height: 0.011, depth: 0.0055 }, scene),
      darkMat,
      parent,
      [0.0125 * sx, 0.157, -0.168],
      { rz: 0.42 * sx }
    ); // inner edges slope down into the V

    prim(
      MeshBuilder.CreateBox(`mp44RearCheekWear${sx}`, { width: 0.014, height: 0.0016, depth: 0.0058 }, scene),
      edgeMat,
      parent,
      [0.0104 * sx, 0.1621, -0.168],
      { rz: 0.42 * sx }
    );
  }

  // --- Furniture: dark wood stock, pistol grip, fore-end ---
  prim(
    MeshBuilder.CreateBox("mp44ButtPad", { width: 0.07, height: 0.105, depth: 0.028 }, scene),
    rubberMat,
    parent,
    [0, 0.067, -0.46]
  );

  prim(MeshBuilder.CreateSphere("mp44Stock", { diameter: 0.12, segments: 18 }, scene), woodMat, parent, [0, 0.068, -0.345], {
    scale: [0.44, 0.68, 1.55],
  });

  createTaperedLimb(
    "mp44StockNeck",
    scene,
    parent,
    woodMat,
    new Vector3(0, 0.048, -0.27),
    new Vector3(0, 0.082, -0.185),
    0.035,
    0.032,
    18
  );

  prim(
    MeshBuilder.CreateBox("mp44PistolGrip", { width: 0.052, height: 0.13, depth: 0.045 }, scene),
    woodMat,
    parent,
    [0, 0.012, -0.162],
    { rx: 0.36 }
  );

  prim(
    MeshBuilder.CreateBox("mp44GripCap", { width: 0.057, height: 0.011, depth: 0.052 }, scene),
    darkMat,
    parent,
    [0, -0.054, -0.184],
    { rx: 0.36 }
  );

  prim(
    MeshBuilder.CreateCylinder(
      "mp44ForeEnd",
      { height: 0.225, diameterTop: 0.063, diameterBottom: 0.073, tessellation: 22 },
      scene
    ),
    woodMat,
    parent,
    [0, 0.067, 0.106],
    { rx: Math.PI / 2, sx: 0.72 }
  );

  for (let i = 0; i < 4; i++) {
    prim(MeshBuilder.CreateBox(`mp44ForeGroove${i}`, { width: 0.052, height: 0.003, depth: 0.17 }, scene), darkMat, parent, [
      0,
      0.091 + i * 0.006,
      0.112,
    ]);
  }

  prim(
    MeshBuilder.CreateTorus("mp44FrontSlingLoop", { diameter: 0.022, thickness: 0.0025, tessellation: 12 }, scene),
    edgeMat,
    parent,
    [-0.044, 0.073, 0.18],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateTorus("mp44RearSlingLoop", { diameter: 0.021, thickness: 0.0025, tessellation: 12 }, scene),
    edgeMat,
    parent,
    [-0.044, 0.08, -0.3],
    { rz: Math.PI / 2 }
  );

  // Trigger group and controls
  prim(
    MeshBuilder.CreateTorus("mp44TriggerGuard", { diameter: 0.058, thickness: 0.0065, tessellation: 24 }, scene),
    metalMat,
    parent,
    [0, 0.045, -0.12],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateBox("mp44Trigger", { width: 0.007, height: 0.031, depth: 0.011 }, scene),
    edgeMat,
    parent,
    [0, 0.046, -0.105],
    { rx: 0.22 }
  );

  prim(
    MeshBuilder.CreateCylinder("mp44Selector", { height: 0.006, diameter: 0.014, tessellation: 14 }, scene),
    knurlMat,
    parent,
    [-0.035, 0.111, -0.125],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateBox("mp44SelectorLever", { width: 0.004, height: 0.007, depth: 0.032 }, scene),
    edgeMat,
    parent,
    [-0.038, 0.104, -0.108],
    { rx: -0.45 }
  );

  // Push-button cross-bolt safety on the trigger housing (the AUTO/single
  // selector's companion control) — a small in-the-white detail
  prim(
    MeshBuilder.CreateCylinder("mp44SafetyButton", { height: 0.006, diameter: 0.0105, tessellation: 12 }, scene),
    edgeMat,
    parent,
    [-0.034, 0.07, -0.118],
    { rz: Math.PI / 2 }
  );

  // --- Curved stamped magazine group ---
  const magGroup = new Mesh("mp44MagGroup", scene);
  magGroup.position.set(0, 0.028, -0.035);
  magGroup.rotation.x = -0.1;
  magGroup.parent = parent;

  // One smooth banana extrusion curving forward (real StG44 direction),
  // with stamped vertical side ribs built into the cross-section profile.
  const magW = 0.026,
    magD = 0.029,
    magCh = 0.007,
    magRib = 0.0018;
  const magShape = [
    new Vector3(magW, -(magD - magCh), 0),
    new Vector3(magW, -0.013, 0),
    new Vector3(magW + magRib, -0.0095, 0),
    new Vector3(magW, -0.006, 0),
    new Vector3(magW, 0.006, 0),
    new Vector3(magW + magRib, 0.0095, 0),
    new Vector3(magW, 0.013, 0),
    new Vector3(magW, magD - magCh, 0),
    new Vector3(magW - magCh, magD, 0),
    new Vector3(-(magW - magCh), magD, 0),
    new Vector3(-magW, magD - magCh, 0),
    new Vector3(-magW, 0.013, 0),
    new Vector3(-(magW + magRib), 0.0095, 0),
    new Vector3(-magW, 0.006, 0),
    new Vector3(-magW, -0.006, 0),
    new Vector3(-(magW + magRib), -0.0095, 0),
    new Vector3(-magW, -0.013, 0),
    new Vector3(-magW, -(magD - magCh), 0),
    new Vector3(-(magW - magCh), -magD, 0),
    new Vector3(magW - magCh, -magD, 0),
  ];
  const magPath: Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    // start slightly off-vertical so the extrusion frame stays stable
    const a = 0.05 + (i / 10) * 0.34;
    magPath.push(new Vector3(0, 0.012 - 0.5 * (Math.sin(a) - Math.sin(0.05)), 0.004 + 0.5 * (Math.cos(0.05) - Math.cos(a))));
  }
  const magBody = MeshBuilder.ExtrudeShape(
    "mp44MagBody",
    {
      shape: magShape,
      path: magPath,
      closeShape: true,
      cap: Mesh.CAP_ALL,
      sideOrientation: Mesh.DOUBLESIDE,
    },
    scene
  );
  magBody.material = metalMat;
  magBody.parent = magGroup;

  prim(
    MeshBuilder.CreateBox("mp44MagFeedLips", { width: 0.046, height: 0.012, depth: 0.052 }, scene),
    edgeMat,
    magGroup,
    [0, 0.011, 0.002]
  );

  prim(
    MeshBuilder.CreateCylinder("mp44MagTopRound", { height: 0.032, diameter: 0.0095, tessellation: 12 }, scene),
    brassMat,
    magGroup,
    [0, 0.021, 0.006],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateBox("mp44MagBasePlate", { width: 0.058, height: 0.012, depth: 0.066 }, scene),
    darkMat,
    magGroup,
    [0, -0.157, 0.043],
    { rx: -0.39 }
  ); // matches the arc tangent at the bottom

  mergeWeaponParts(parent, [boltGroup, magGroup]);

  const hands = {
    right: handAnchor("mp44_handR", parent, RIGHT_GRIP),
    left: handAnchor("mp44_handL", parent, LEFT_GRIP),
  };

  parent.position.set(0.19, -0.265, 0.55);
  parent.rotation.y = -Math.PI / 38;

  return { root: parent, pivots: { boltGroup, magGroup }, hands };
}
