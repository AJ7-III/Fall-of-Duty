import { Color3, FresnelParameters, Mesh, MeshBuilder, StandardMaterial, Texture, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import { flatMat, makeCanvasTexture, stdMat } from "../rendering/materials/canvas";
import { createLimb, createTaperedLimb, handAnchor, mergeWeaponParts, prim } from "./kit";
import type { HandPose, WeaponViewModel } from "./kit";
import { camoTexture, knurlTexture } from "./weaponTextures";

// M40A3 bolt-action rifle. Layout: +z is the muzzle direction. The scope
// tube axis sits at exactly y = +0.17 / x = 0 so the final ADS frame (root
// at y = -0.17) centers it on camera. Animated pivot the rig drives by name:
// boltGroup (rotates open, pulls back, runs home).

// Trigger hand wrapped around the grip neck; index laid along the trigger
// (The soldier's hand runs 0.163 m from wrist to middle knuckle at rig scale, so
// each wrist sits that far back from where the knuckles must land.)
const RIGHT_GRIP: HandPose = {
  wrist: [0.04, 0.098, -0.365],
  knuckles: [0, -0.6, 0.8],
  palm: [-1, 0, 0],
  curl: { thumb: 0.1, index: [0.1, 0.9, 0.5], middle: 1.0, ring: 1.0, pinky: 1.0 },
};

// Same hand lifted onto the bolt handle from above, fingers around the ball
const RIGHT_BOLT: HandPose = {
  wrist: [0.157, 0.139, -0.26], // a hand-length back from the ball along the reach
  knuckles: [-0.75, -0.35, 0.55],
  palm: [-0.3, -0.85, -0.4],
  curl: { thumb: 0.6, index: 0.8, middle: 0.9, ring: 0.9, pinky: 0.9 },
};

// Support hand cupping the fore-end from below, fingers over the far side
const LEFT_GRIP: HandPose = {
  wrist: [-0.117, -0.007, 0.089],
  knuckles: [0.9, 0.35, 0.25],
  palm: [-0.35, 0.92, 0.1],
  curl: { thumb: 0.35, index: 0.85, middle: 0.9, ring: 0.95, pinky: 1.0 },
};

export function buildSniperViewModel(scene: Scene): WeaponViewModel {
  // Create a parent mesh for the rifle viewmodel.
  // Layout: +z is the muzzle direction. The scope tube axis sits at exactly
  // y = +0.17 / x = 0 so the final ADS frame (root at y = -0.17) centers it on camera.
  const parent = new Mesh("m40a3_root", scene);

  // --- Materials ---
  const stockMat = flatMat(scene, "sniperStockMat", { albedo: [1, 1, 1], rough: 0.55, tex: camoTexture(scene) });

  // blued steel and anodised scope tube: physically based metals that mirror
  // the yard environment; the lenses keep their coated-glass Fresnel look
  const metalMat = flatMat(scene, "sniperMetalMat", { albedo: [0.3, 0.32, 0.38], rough: 0.3, metal: 1 });

  // Reflection map for the lens glass and metal sheen — sky gradient with a
  // hot sun glint, sampled in spherical mode so it slides across the curved
  // surfaces as the view turns (reads as a real coated optic)
  const lensReflTex = makeCanvasTexture(scene, "lensReflTex", 256, (ctx, s) => {
    const grad = ctx.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0.0, "#dcebf7");
    grad.addColorStop(0.45, "#94aabf");
    grad.addColorStop(0.6, "#eef6fb"); // bright horizon band
    grad.addColorStop(0.68, "#62788c");
    grad.addColorStop(1.0, "#27333f");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
    const sun = ctx.createRadialGradient(s * 0.68, s * 0.22, 2, s * 0.68, s * 0.22, 46);
    sun.addColorStop(0, "rgba(255,255,248,0.95)");
    sun.addColorStop(1, "rgba(255,255,248,0)");
    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(s * 0.68, s * 0.22, 46, 0, Math.PI * 2);
    ctx.fill();
  });
  lensReflTex.coordinatesMode = Texture.SPHERICAL_MODE;

  const scopeMat = flatMat(scene, "sniperScopeMat", { albedo: [0.1, 0.1, 0.11], rough: 0.45, metal: 0.9 });

  const knurlMat = flatMat(scene, "sniperKnurlMat", { albedo: [0.7, 0.7, 0.74], rough: 0.4, metal: 1, tex: knurlTexture(scene) });

  const darkTrimMat = flatMat(scene, "sniperDarkTrimMat", { albedo: [0.06, 0.06, 0.07], rough: 0.55, metal: 0.8 });

  const markMat = flatMat(scene, "sniperMarkMat", { albedo: [0.8, 0.8, 0.75], rough: 0.6, emissive: [0.4, 0.4, 0.36] }); // turret witness dots

  const rubberMat = flatMat(scene, "sniperRubberMat", { albedo: [0.055, 0.055, 0.06], rough: 0.9 }); // recoil pad / eyecup

  const lensMat = new StandardMaterial("sniperLensMat", scene);
  lensMat.diffuseColor = new Color3(0.01, 0.015, 0.02);
  lensMat.reflectionTexture = lensReflTex;
  lensMat.reflectionFresnelParameters = new FresnelParameters();
  lensMat.reflectionFresnelParameters.bias = 0.25;
  lensMat.reflectionFresnelParameters.power = 1.4;
  // multicoated glass: teal facing the camera, violet shift at the edges
  lensMat.emissiveColor = new Color3(0.38, 0.45, 0.5);
  lensMat.emissiveFresnelParameters = new FresnelParameters();
  lensMat.emissiveFresnelParameters.bias = 0.12;
  lensMat.emissiveFresnelParameters.power = 2.2;
  lensMat.emissiveFresnelParameters.leftColor = new Color3(0.45, 0.24, 0.6);
  lensMat.emissiveFresnelParameters.rightColor = new Color3(0.08, 0.3, 0.36);
  lensMat.specularColor = new Color3(1, 1, 1);
  lensMat.specularPower = 128;

  const lensRearMat = stdMat(scene, "sniperLensRearMat", {
    diffuse: [0.01, 0.01, 0.015],
    spec: [0.6, 0.65, 0.7],
    emissive: [0.03, 0.05, 0.06],
  });
  lensRearMat.reflectionTexture = lensReflTex;
  lensRearMat.reflectionFresnelParameters = new FresnelParameters();
  lensRearMat.reflectionFresnelParameters.bias = 0.06; // only glancing glints
  lensRearMat.reflectionFresnelParameters.power = 3;

  // --- Stock — smooth fiberglass sporter profile built from rounded
  // primitives: no hard box edges anywhere on the silhouette. The comb sits
  // low (top y = 0.131) so it never crowds the scope's eye line at 0.17 ---
  prim(
    MeshBuilder.CreateCapsule("stockButtPad", { height: 0.115, radius: 0.027, tessellation: 16, capSubdivisions: 6 }, scene),
    rubberMat,
    parent,
    [0, 0.05, -0.473],
    { sz: 0.62 }
  ); // flatten into a recoil pad

  prim(MeshBuilder.CreateSphere("stockButt", { diameter: 0.1, segments: 20 }, scene), stockMat, parent, [0, 0.05, -0.385], {
    scale: [0.62, 1.22, 1.85],
  });

  prim(MeshBuilder.CreateSphere("stockComb", { diameter: 0.1, segments: 20 }, scene), stockMat, parent, [0, 0.098, -0.355], {
    scale: [0.55, 0.66, 1.45],
  });

  // grip neck — the slim wrist between butt and receiver
  createTaperedLimb(
    "stockGripNeck",
    scene,
    parent,
    stockMat,
    new Vector3(0, 0.005, -0.3),
    new Vector3(0, 0.062, -0.205),
    0.032,
    0.035,
    20
  );

  prim(
    MeshBuilder.CreateCylinder("stockBody", { height: 0.26, diameter: 0.078, tessellation: 24 }, scene),
    stockMat,
    parent,
    [0, 0.068, -0.06],
    { rx: Math.PI / 2, sx: 0.8 }
  ); // oval cross-section

  prim(
    MeshBuilder.CreateCylinder(
      "stockForend",
      { height: 0.14, diameterTop: 0.058, diameterBottom: 0.078, tessellation: 24 },
      scene
    ),
    stockMat,
    parent,
    [0, 0.069, 0.14],
    { rx: Math.PI / 2, sx: 0.8 }
  );

  prim(
    MeshBuilder.CreateSphere("stockForendTip", { diameter: 0.058, segments: 16 }, scene),
    stockMat,
    parent,
    [0, 0.069, 0.208],
    { scale: [0.8, 1, 0.75] }
  );

  // --- Action / barrel (blued steel, trimmed length) ---
  prim(
    MeshBuilder.CreateCylinder("receiver", { height: 0.24, diameter: 0.05, tessellation: 24 }, scene),
    metalMat,
    parent,
    [0, 0.115, -0.1],
    { rx: Math.PI / 2 }
  );

  // bolt shroud tapers off the back of the receiver
  prim(
    MeshBuilder.CreateCylinder(
      "boltShroud",
      { height: 0.04, diameterTop: 0.034, diameterBottom: 0.026, tessellation: 16 },
      scene
    ),
    metalMat,
    parent,
    [0, 0.115, -0.24],
    { rx: Math.PI / 2 }
  );

  prim(MeshBuilder.CreateSphere("boltShroudCap", { diameter: 0.026, segments: 12 }, scene), metalMat, parent, [0, 0.115, -0.259]);

  prim(
    MeshBuilder.CreateCylinder("barrel", { height: 0.26, diameterTop: 0.022, diameterBottom: 0.035, tessellation: 24 }, scene),
    metalMat,
    parent,
    [0, 0.115, 0.15],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("muzzle", { height: 0.02, diameter: 0.0255, tessellation: 16 }, scene),
    scopeMat,
    parent,
    [0, 0.115, 0.288],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("muzzleBore", { height: 0.004, diameter: 0.013, tessellation: 12 }, scene),
    darkTrimMat,
    parent,
    [0, 0.115, 0.299],
    { rx: Math.PI / 2 }
  );

  // floorplate: thin strip tucked flush against the stock belly so it reads
  // as an inletted plate, not a bar hanging under the trigger section
  prim(createLimb("magPlate", scene, new Vector3(0, 0.03, -0.15), new Vector3(0, 0.03, -0.06), 0.016), metalMat, parent, null, {
    sz: 0.5,
  }); // local z is world y here: flatten against the wood

  prim(
    MeshBuilder.CreateTorus("triggerGuard", { diameter: 0.055, thickness: 0.007, tessellation: 24 }, scene),
    metalMat,
    parent,
    [0, -0.004, -0.21],
    { rz: Math.PI / 2 }
  ); // vertical ring

  prim(
    MeshBuilder.CreateBox("trigger", { width: 0.007, height: 0.028, depth: 0.01 }, scene),
    metalMat,
    parent,
    [0, 0.004, -0.206],
    { rx: 0.25 }
  );

  // --- Scope rail & ring mounts ---
  prim(
    MeshBuilder.CreateBox("scopeRail", { width: 0.022, height: 0.01, depth: 0.18 }, scene),
    scopeMat,
    parent,
    [0, 0.142, -0.07]
  );

  const mountF = prim(
    MeshBuilder.CreateBox("scopeMountF", { width: 0.018, height: 0.026, depth: 0.024 }, scene),
    scopeMat,
    parent,
    [0, 0.152, 0.0]
  );

  prim(mountF.clone("scopeMountR"), null, parent, [0, 0.152, -0.14]);

  // ring clamps wrap the tube above each mount
  const ringClampF = prim(
    MeshBuilder.CreateCylinder("scopeRingClampF", { height: 0.016, diameter: 0.041, tessellation: 20 }, scene),
    scopeMat,
    parent,
    [0, 0.17, 0.0],
    { rx: Math.PI / 2 }
  );

  prim(ringClampF.clone("scopeRingClampR"), null, parent, [0, 0.17, -0.14]);

  // clamp screws on the camera-facing flank
  const screwF = prim(
    MeshBuilder.CreateCylinder("scopeScrewF", { height: 0.006, diameter: 0.007, tessellation: 10 }, scene),
    metalMat,
    parent,
    [-0.0215, 0.156, 0.0],
    { rz: Math.PI / 2 }
  );

  prim(screwF.clone("scopeScrewR"), null, parent, [-0.0215, 0.156, -0.14]);

  // --- Scope: tube, turret saddle with three knurled knobs, objective bell,
  // sunshade, eyepiece with rubber eyecup --- (axis exactly at y = +0.17)
  const SCOPE_Y = 0.17;

  prim(
    MeshBuilder.CreateCylinder("scopeTube", { height: 0.24, diameter: 0.034, tessellation: 24 }, scene),
    scopeMat,
    parent,
    [0, SCOPE_Y, -0.09],
    { rx: Math.PI / 2 }
  );

  // machined detail rings on the tube
  for (const [ringName, ringZ] of [
    ["scopeEtchF", 0.018],
    ["scopeEtchR", -0.185],
  ] as const) {
    prim(
      MeshBuilder.CreateCylinder(ringName, { height: 0.003, diameter: 0.0348, tessellation: 24 }, scene),
      darkTrimMat,
      parent,
      [0, SCOPE_Y, ringZ],
      { rx: Math.PI / 2 }
    );
  }

  // turret saddle (the thicker mid-section)
  prim(
    MeshBuilder.CreateCylinder("scopeSaddle", { height: 0.08, diameter: 0.047, tessellation: 24 }, scene),
    scopeMat,
    parent,
    [0, SCOPE_Y, -0.05],
    { rx: Math.PI / 2 }
  );

  // elevation turret (top): base, knurled knob, cap, witness dot
  prim(
    MeshBuilder.CreateCylinder("turretTopBase", { height: 0.012, diameter: 0.036, tessellation: 16 }, scene),
    scopeMat,
    parent,
    [0, SCOPE_Y + 0.029, -0.05]
  );

  prim(MeshBuilder.CreateCylinder("turretTop", { height: 0.022, diameter: 0.031, tessellation: 16 }, scene), knurlMat, parent, [
    0,
    SCOPE_Y + 0.046,
    -0.05,
  ]);

  prim(
    MeshBuilder.CreateCylinder("turretTopCap", { height: 0.005, diameter: 0.031, tessellation: 16 }, scene),
    scopeMat,
    parent,
    [0, SCOPE_Y + 0.0595, -0.05]
  );

  prim(
    MeshBuilder.CreateCylinder("turretTopDot", { height: 0.002, diameter: 0.0045, tessellation: 8 }, scene),
    markMat,
    parent,
    [0, SCOPE_Y + 0.046, -0.0338],
    { rx: Math.PI / 2 }
  );

  // windage turret (right side)
  prim(
    MeshBuilder.CreateCylinder("turretSideBase", { height: 0.012, diameter: 0.036, tessellation: 16 }, scene),
    scopeMat,
    parent,
    [0.0295, SCOPE_Y, -0.05],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("turretSide", { height: 0.022, diameter: 0.031, tessellation: 16 }, scene),
    knurlMat,
    parent,
    [0.0465, SCOPE_Y, -0.05],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("turretSideCap", { height: 0.005, diameter: 0.031, tessellation: 16 }, scene),
    scopeMat,
    parent,
    [0.06, SCOPE_Y, -0.05],
    { rz: Math.PI / 2 }
  );

  // parallax/side-focus knob (left side — the camera-facing flank)
  prim(
    MeshBuilder.CreateCylinder("parallaxBase", { height: 0.012, diameter: 0.038, tessellation: 16 }, scene),
    scopeMat,
    parent,
    [-0.0295, SCOPE_Y, -0.05],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("parallaxKnob", { height: 0.026, diameter: 0.036, tessellation: 16 }, scene),
    knurlMat,
    parent,
    [-0.048, SCOPE_Y, -0.05],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("parallaxCap", { height: 0.005, diameter: 0.036, tessellation: 16 }, scene),
    scopeMat,
    parent,
    [-0.0635, SCOPE_Y, -0.05],
    { rz: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("parallaxDot", { height: 0.002, diameter: 0.0045, tessellation: 8 }, scene),
    markMat,
    parent,
    [-0.048, SCOPE_Y, -0.0685],
    { rx: Math.PI / 2 }
  );

  // objective bell — flares out to the big front lens
  prim(
    MeshBuilder.CreateCylinder(
      "scopeObjBell",
      { height: 0.07, diameterTop: 0.066, diameterBottom: 0.036, tessellation: 24 },
      scene
    ),
    scopeMat,
    parent,
    [0, SCOPE_Y, 0.065],
    { rx: Math.PI / 2 }
  );

  // sunshade tube ahead of the bell
  prim(
    MeshBuilder.CreateCylinder("scopeSunshade", { height: 0.036, diameter: 0.068, tessellation: 24 }, scene),
    scopeMat,
    parent,
    [0, SCOPE_Y, 0.118],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("scopeFrontRim", { height: 0.012, diameter: 0.072, tessellation: 24 }, scene),
    knurlMat,
    parent,
    [0, SCOPE_Y, 0.142],
    { rx: Math.PI / 2 }
  );

  // dark backing disc occludes the tube interior behind the curved glass
  prim(
    MeshBuilder.CreateCylinder("scopeLensBacking", { height: 0.004, diameter: 0.06, tessellation: 20 }, scene),
    lensRearMat,
    parent,
    [0, SCOPE_Y, 0.136],
    { rx: Math.PI / 2 }
  );

  // curved objective lens — flattened glass dome bulging out of the bell
  prim(
    MeshBuilder.CreateSphere("scopeLensFront", { diameter: 0.058, segments: 16, slice: 0.55 }, scene),
    lensMat,
    parent,
    [0, SCOPE_Y, 0.14],
    { rx: Math.PI / 2, sy: 0.45 }
  ); // flatten the dome into a lens profile // bulge faces out of the muzzle (+z)

  // ocular bell + fast-focus ring + eyecup + rear lens
  prim(
    MeshBuilder.CreateCylinder(
      "scopeOcular",
      { height: 0.06, diameterTop: 0.036, diameterBottom: 0.05, tessellation: 24 },
      scene
    ),
    scopeMat,
    parent,
    [0, SCOPE_Y, -0.24],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("scopeFocusRing", { height: 0.024, diameter: 0.054, tessellation: 24 }, scene),
    knurlMat,
    parent,
    [0, SCOPE_Y, -0.282],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateCylinder("scopeEyeRim", { height: 0.008, diameter: 0.05, tessellation: 24 }, scene),
    scopeMat,
    parent,
    [0, SCOPE_Y, -0.297],
    { rx: Math.PI / 2 }
  );

  prim(
    MeshBuilder.CreateTorus("scopeEyecup", { diameter: 0.044, thickness: 0.0065, tessellation: 24 }, scene),
    rubberMat,
    parent,
    [0, SCOPE_Y, -0.3],
    { rx: Math.PI / 2 }
  );

  // curved ocular lens — shallow dome facing the shooter
  prim(
    MeshBuilder.CreateSphere("scopeLensRear", { diameter: 0.042, segments: 12, slice: 0.55 }, scene),
    lensRearMat,
    parent,
    [0, SCOPE_Y, -0.301],
    { rx: -Math.PI / 2, sy: 0.35 }
  ); // bulge faces back toward the eye (-z)

  // --- Bolt assembly (own pivot group so the rig can rotate/pull it) ---
  const boltGroup = new Mesh("boltGroup", scene);
  boltGroup.position.set(0, 0.125, -0.16); // pivot on the bolt axis
  boltGroup.parent = parent;

  prim(
    MeshBuilder.CreateCylinder("boltShaft", { height: 0.1, diameter: 0.018, tessellation: 16 }, scene),
    metalMat,
    boltGroup,
    [0, 0, 0.01],
    { rx: Math.PI / 2 }
  );

  // handle arm tapers toward the ball knob
  prim(
    MeshBuilder.CreateCylinder("boltArm", { height: 0.05, diameterTop: 0.011, diameterBottom: 0.015, tessellation: 12 }, scene),
    metalMat,
    boltGroup,
    [0.027, 0, -0.01],
    { rz: -Math.PI / 2 }
  ); // points +x, thin end outboard

  prim(MeshBuilder.CreateSphere("boltBall", { diameter: 0.028, segments: 12 }, scene), metalMat, boltGroup, [0.055, 0, -0.01]);

  // Rest pose: handle angled down-right (ViewModelRig owns the animation)
  boltGroup.rotation.z = -0.9;

  mergeWeaponParts(parent, [boltGroup]);

  const hands = {
    right: handAnchor("m40a3_handR", parent, RIGHT_GRIP, RIGHT_BOLT),
    left: handAnchor("m40a3_handL", parent, LEFT_GRIP),
  };

  // Hip-fire rest: bottom-right of the frame, angled slightly inward
  parent.position.set(0.25, -0.3, 0.6);
  parent.rotation.y = -Math.PI / 36;

  return { root: parent, pivots: { boltGroup }, hands };
}
