import { Mesh, MeshBuilder, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import { flatMat } from "../rendering/materials/canvas";
import { createLimb, handAnchor, mergeWeaponParts, prim } from "./kit";
import type { HandPose, WeaponViewModel } from "./kit";
import { knurlTexture, polymerTexture, stippleTexture } from "./weaponTextures";

// USP .45 service pistol. Layout: +z is the muzzle direction; the sight line
// runs at y = +0.146 so the final ADS frame (root at y = -0.141) centers the
// sights on camera. Animated pivots the rig drives by name: slideGroup
// (blowback / lock-back), hammerGroup (rocks with the slide), magGroup
// (drops during reload).

// Firing hand high on the backstrap, thumb along the near flank
const RIGHT_GRIP: HandPose = {
  wrist: [0.02, 0.038, -0.132],
  knuckles: [0, -0.296, 0.955],
  palm: [-1, 0, 0],
  curl: { thumb: 0.45, index: 0.35, middle: 1.0, ring: 1.0, pinky: 1.0 },
};

// Support hand wrapped over the firing hand's fingers
const LEFT_GRIP: HandPose = {
  wrist: [-0.039, 0.015, -0.127],
  knuckles: [0.15, -0.25, 0.95],
  palm: [0.97, 0.1, -0.15],
  curl: { thumb: 0.4, index: 0.9, middle: 0.95, ring: 1.0, pinky: 1.0 },
};

export function buildPistolViewModel(scene: Scene): WeaponViewModel {
  const parent = new Mesh("usp45_root", scene);

  // --- Materials ---
  const polymerMat = flatMat(scene, "uspPolymerMat", { albedo: [1, 1, 1], rough: 0.58, tex: polymerTexture(scene) });

  const stippleMat = flatMat(scene, "uspStippleMat", { albedo: [1, 1, 1], rough: 0.75, tex: stippleTexture(scene) });

  // Metals are physically based now: blued slide steel, in-the-white
  // controls and brass all mirror the yard environment
  const slideMat = flatMat(scene, "uspSlideMat", { albedo: [0.32, 0.34, 0.4], rough: 0.32, metal: 1 });
  const steelMat = flatMat(scene, "uspSteelMat", { albedo: [0.55, 0.57, 0.6], rough: 0.28, metal: 1 });
  const darkTrimMat = flatMat(scene, "uspDarkTrimMat", { albedo: [0.06, 0.06, 0.07], rough: 0.55, metal: 0.8 });
  const knurlMat = flatMat(scene, "uspKnurlMat", { albedo: [0.7, 0.7, 0.74], rough: 0.4, metal: 1, tex: knurlTexture(scene) });
  const dotMat = flatMat(scene, "uspSightDotMat", { albedo: [0.85, 0.85, 0.8], rough: 0.6, emissive: [0.5, 0.5, 0.45] }); // 3-dot sights

  const brassMat = flatMat(scene, "uspBrassMat", { albedo: [0.85, 0.64, 0.3], rough: 0.3, metal: 1 }); // chambered round

  // --- Slide group (pivot on the slide axis so blowback is a pure z slide) ---
  const slideGroup = new Mesh("slideGroup", scene);
  slideGroup.position.set(0, 0.118, 0);
  slideGroup.parent = parent;

  prim(MeshBuilder.CreateBox("slideBody", { width: 0.034, height: 0.034, depth: 0.205 }, scene), slideMat, slideGroup, null);

  // rounded top spine kills the boxy roofline
  prim(
    MeshBuilder.CreateCylinder("slideSpine", { height: 0.19, diameter: 0.026, tessellation: 20 }, scene),
    slideMat,
    slideGroup,
    [0, 0.011, 0],
    { rx: Math.PI / 2 }
  );

  // cocking serrations front + rear, both flanks
  for (const [sx, sz, nm] of [
    [-0.0178, -0.072, "serRL"],
    [0.0178, -0.072, "serRR"],
    [-0.0178, 0.058, "serFL"],
    [0.0178, 0.058, "serFR"],
  ] as const) {
    prim(MeshBuilder.CreateBox(nm, { width: 0.0015, height: 0.026, depth: 0.042 }, scene), knurlMat, slideGroup, [
      sx,
      -0.001,
      sz,
    ]);
  }

  // ejection port cut on the right flank + extractor bar behind it
  prim(
    MeshBuilder.CreateBox("ejectionPort", { width: 0.004, height: 0.018, depth: 0.052 }, scene),
    darkTrimMat,
    slideGroup,
    [0.0162, 0.006, 0.025]
  );

  prim(
    MeshBuilder.CreateBox("extractor", { width: 0.003, height: 0.005, depth: 0.03 }, scene),
    steelMat,
    slideGroup,
    [0.0168, 0.009, -0.012]
  );

  // machining line along each flank
  for (const ex of [-0.0172, 0.0172]) {
    prim(
      MeshBuilder.CreateBox(`slideEtch${ex < 0 ? "L" : "R"}`, { width: 0.0008, height: 0.002, depth: 0.18 }, scene),
      darkTrimMat,
      slideGroup,
      [ex, -0.009, 0]
    );
  }

  // rear sight: two dovetail ears with a true notch between them, a white
  // dot on each ear. Sights ride proud of the slide spine so the ADS eye
  // line (y = +0.146 in weapon space) sees the front post in the notch.
  for (const ex of [-0.00825, 0.00825]) {
    prim(
      MeshBuilder.CreateBox(`rearSightEar${ex < 0 ? "L" : "R"}`, { width: 0.0085, height: 0.009, depth: 0.013 }, scene),
      slideMat,
      slideGroup,
      [ex, 0.0245, -0.094]
    );
  }
  prim(
    MeshBuilder.CreateBox("rearSightBase", { width: 0.025, height: 0.004, depth: 0.013 }, scene),
    slideMat,
    slideGroup,
    [0, 0.019, -0.094]
  );

  for (const dx of [-0.0075, 0.0075]) {
    prim(
      MeshBuilder.CreateCylinder(`rearDot${dx < 0 ? "L" : "R"}`, { height: 0.0015, diameter: 0.0035, tessellation: 10 }, scene),
      dotMat,
      slideGroup,
      [dx, 0.0255, -0.1008],
      { rx: Math.PI / 2 }
    );
  }

  // front sight post with the third white dot facing the shooter
  prim(
    MeshBuilder.CreateBox("frontSight", { width: 0.007, height: 0.011, depth: 0.014 }, scene),
    slideMat,
    slideGroup,
    [0, 0.024, 0.092]
  );

  prim(
    MeshBuilder.CreateCylinder("frontDot", { height: 0.0015, diameter: 0.0035, tessellation: 10 }, scene),
    dotMat,
    slideGroup,
    [0, 0.027, 0.0845],
    { rx: Math.PI / 2 }
  );

  // muzzle: barrel proud of the slide face, bushing ring, dark bore
  prim(
    MeshBuilder.CreateCylinder("pistolBarrel", { height: 0.014, diameter: 0.0205, tessellation: 18 }, scene),
    steelMat,
    slideGroup,
    [0, -0.0005, 0.108],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("muzzleBushing", { height: 0.006, diameter: 0.027, tessellation: 18 }, scene),
    darkTrimMat,
    slideGroup,
    [0, -0.0005, 0.1045],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("pistolBore", { height: 0.003, diameter: 0.012, tessellation: 12 }, scene),
    darkTrimMat,
    slideGroup,
    [0, -0.0005, 0.1155],
    { rx: Math.PI / 2 }
  );

  // rear plate (breech face cover)
  prim(
    MeshBuilder.CreateBox("slideRearPlate", { width: 0.03, height: 0.028, depth: 0.004 }, scene),
    darkTrimMat,
    slideGroup,
    [0, -0.001, -0.1035]
  );

  // chambered round peeking through the port (visible when the slide rides back)
  prim(
    MeshBuilder.CreateCylinder("chamberBrass", { height: 0.024, diameter: 0.0115, tessellation: 12 }, scene),
    brassMat,
    parent,
    [0.004, 0.112, 0.022],
    { rx: Math.PI / 2 }
  ); // frame-level: stays put as the slide moves

  // --- Frame (polymer) ---
  prim(
    MeshBuilder.CreateBox("frameBody", { width: 0.03, height: 0.032, depth: 0.135 }, scene),
    polymerMat,
    parent,
    [0, 0.09, -0.012]
  );

  // rail edge where slide meets frame
  prim(
    MeshBuilder.CreateBox("frameRailEdge", { width: 0.032, height: 0.003, depth: 0.135 }, scene),
    darkTrimMat,
    parent,
    [0, 0.1035, -0.012]
  );

  // dust cover accessory rail with grooves
  prim(
    MeshBuilder.CreateBox("accessoryRail", { width: 0.03, height: 0.014, depth: 0.052 }, scene),
    polymerMat,
    parent,
    [0, 0.083, 0.052]
  );

  for (const gy of [0.0795, 0.0865]) {
    prim(MeshBuilder.CreateBox(`railGroove${gy}`, { width: 0.031, height: 0.0022, depth: 0.052 }, scene), darkTrimMat, parent, [
      0,
      gy,
      0.052,
    ]);
  }

  // trigger guard: round rear ring + squared front face
  prim(
    MeshBuilder.CreateTorus("pistolTriggerGuard", { diameter: 0.054, thickness: 0.0065, tessellation: 24 }, scene),
    polymerMat,
    parent,
    [0, 0.063, -0.018],
    { rz: Math.PI / 2 }
  ); // vertical ring

  prim(
    MeshBuilder.CreateBox("guardFront", { width: 0.0065, height: 0.026, depth: 0.0065 }, scene),
    polymerMat,
    parent,
    [0, 0.052, 0.0095],
    { rx: 0.15 }
  );

  prim(
    MeshBuilder.CreateBox("pistolTrigger", { width: 0.006, height: 0.025, depth: 0.009 }, scene),
    steelMat,
    parent,
    [0, 0.063, -0.008],
    { rx: 0.28 }
  );

  // --- Grip (raked back ~17°): core + stipple panels + straps ---
  const GRIP_RAKE = 0.3;
  prim(
    MeshBuilder.CreateBox("gripCore", { width: 0.031, height: 0.105, depth: 0.044 }, scene),
    polymerMat,
    parent,
    [0, 0.026, -0.075],
    { rx: GRIP_RAKE }
  );

  prim(
    MeshBuilder.CreateBox("gripPanels", { width: 0.0335, height: 0.075, depth: 0.04 }, scene),
    stippleMat,
    parent,
    [0, 0.022, -0.0765],
    { rx: GRIP_RAKE }
  );

  prim(
    createLimb("backstrap", scene, new Vector3(0, 0.078, -0.094), new Vector3(0, -0.018, -0.108), 0.0105),
    polymerMat,
    parent,
    null
  );

  prim(
    createLimb("frontstrap", scene, new Vector3(0, 0.07, -0.052), new Vector3(0, -0.022, -0.078), 0.01),
    stippleMat,
    parent,
    null
  );

  // beavertail shelf over the web of the hand
  prim(MeshBuilder.CreateSphere("beavertail", { diameter: 0.022, segments: 12 }, scene), polymerMat, parent, [0, 0.085, -0.112], {
    scale: [1, 0.5, 1.3],
  });

  // --- Controls: mag release, slide release, safety, takedown pin, lanyard ---
  prim(
    MeshBuilder.CreateCylinder("magRelease", { height: 0.005, diameter: 0.0095, tessellation: 12 }, scene),
    steelMat,
    parent,
    [-0.0175, 0.07, -0.043],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateBox("slideRelease", { width: 0.0025, height: 0.0065, depth: 0.046 }, scene),
    steelMat,
    parent,
    [-0.0168, 0.1, -0.035]
  );

  prim(
    MeshBuilder.CreateCylinder("slideReleasePin", { height: 0.004, diameter: 0.0065, tessellation: 10 }, scene),
    steelMat,
    parent,
    [-0.0168, 0.1, -0.013],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateBox("safetyLever", { width: 0.0025, height: 0.012, depth: 0.018 }, scene),
    steelMat,
    parent,
    [-0.0168, 0.103, -0.083],
    { rx: -0.5 }
  );

  prim(
    MeshBuilder.CreateCylinder("takedownPin", { height: 0.004, diameter: 0.0065, tessellation: 10 }, scene),
    steelMat,
    parent,
    [0.0162, 0.094, -0.02],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateTorus("lanyardLoop", { diameter: 0.01, thickness: 0.002, tessellation: 12 }, scene),
    steelMat,
    parent,
    [0, -0.03, -0.105],
    { rx: Math.PI / 2 }
  );

  // --- Hammer group (pivot at the hammer pin; rocks back with the slide).
  // USP-style exposed ring hammer: the pivot sits at the frame tang so the
  // cocked spur stands clearly proud of the slide's rear plate — the
  // signature "pin" silhouette on the back of the gun. Spur top stays
  // under the rear-sight notch (eye line y = +0.146) in every pose. ---
  const hammerGroup = new Mesh("hammerGroup", scene);
  hammerGroup.position.set(0, 0.1, -0.098);
  hammerGroup.parent = parent;

  prim(
    MeshBuilder.CreateBox("hammerBody", { width: 0.011, height: 0.028, depth: 0.007 }, scene),
    steelMat,
    hammerGroup,
    [0, 0.008, -0.002]
  );

  // ring spur: wide drum with a dark through-hole suggested on both faces
  prim(
    MeshBuilder.CreateCylinder("hammerSpur", { height: 0.009, diameter: 0.019, tessellation: 14 }, scene),
    steelMat,
    hammerGroup,
    [0, 0.0235, -0.008],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("hammerHole", { height: 0.0096, diameter: 0.0085, tessellation: 12 }, scene),
    darkTrimMat,
    hammerGroup,
    [0, 0.0235, -0.008],
    { rz: Math.PI / 2 }
  );

  hammerGroup.rotation.x = -0.55; // carried cocked

  prim(
    MeshBuilder.CreateCylinder("hammerPin", { height: 0.036, diameter: 0.006, tessellation: 10 }, scene),
    steelMat,
    parent,
    [0, 0.1, -0.098],
    { rz: Math.PI / 2 }
  );

  // --- Magazine group (pivot at the grip heel; slides out along the rake) ---
  const magGroup = new Mesh("magGroup", scene);
  magGroup.position.set(0, -0.022, -0.091);
  magGroup.rotation.x = GRIP_RAKE;
  magGroup.parent = parent;

  prim(
    MeshBuilder.CreateBox("magBody", { width: 0.0245, height: 0.055, depth: 0.034 }, scene),
    steelMat,
    magGroup,
    [0, 0.024, 0]
  );

  prim(
    MeshBuilder.CreateBox("magBasePlate", { width: 0.0315, height: 0.011, depth: 0.046 }, scene),
    polymerMat,
    magGroup,
    [0, -0.004, -0.001]
  );

  prim(
    MeshBuilder.CreateCylinder("magTopRound", { height: 0.022, diameter: 0.0115, tessellation: 12 }, scene),
    brassMat,
    magGroup,
    [0, 0.055, 0.002],
    { rx: Math.PI / 2 }
  );

  mergeWeaponParts(parent, [slideGroup, hammerGroup, magGroup]);

  const hands = {
    right: handAnchor("usp45_handR", parent, RIGHT_GRIP),
    left: handAnchor("usp45_handL", parent, LEFT_GRIP),
  };

  parent.position.set(0.155, -0.235, 0.46);
  parent.rotation.y = -Math.PI / 40;

  return { root: parent, pivots: { slideGroup, hammerGroup, magGroup }, hands };
}
