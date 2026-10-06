import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "silent",
});
const { DeathPerformance } = await server.ssrLoadModule("/src/anim/DeathPerformance.ts");
const { SoldierBodyController } = await server.ssrLoadModule("/src/bots/SoldierBody.ts");
const engine = new NullEngine();
after(async () => {
  engine.dispose();
  await server.close();
});

// A real TransformNode skeleton under NullEngine exercises the pose mapper
// and ground contact without a browser, asset download, or pointer lock.
function actor() {
  const scene = new Scene(engine);
  const node = (name, parent, x = 0, y = 0, z = 0) => {
    const n = new TransformNode(name, scene);
    n.parent = parent;
    n.position.set(x, y, z);
    return n;
  };
  const root = node("root", null, 2, 3, 4);
  root.rotation.y = 0.4;
  const rig = { root, gunHomePos: new Vector3(0.02, -0.08, 0.3), faceMat: {}, faceShutMat: {}, faceMesh: {} };
  for (const name of ["torso", "head", "gunArm", "armL", "armR", "foreL", "foreR", "hipL", "hipR", "kneeL", "kneeR"])
    rig[name] = node(name, root);
  rig.gunArm.position.set(0, 1.35, 0.12);
  rig.gunArm.rotation.x = 0.5;
  rig.gun = node("gun", rig.gunArm);
  rig.gun.position.copyFrom(rig.gunHomePos);
  const joints = {};
  const joint = (name, parent, x, y, z = 0) => (joints[name] = node(name, parent, x, y, z));
  const hips = joint("Hips", root, 0, 1.0757);
  const spine1 = joint("Spine1", hips, 0, 0.18);
  const spine2 = joint("Spine2", spine1, 0, 0.14);
  const neck = joint("Neck", spine2, 0, 0.16);
  joint("Head", neck, 0, 0.1);
  for (const [side, sign] of [
    ["Left", -1],
    ["Right", 1],
  ]) {
    const upper = joint(`${side}UpLeg`, hips, sign * 0.1, 0);
    const leg = joint(`${side}Leg`, upper, 0, -0.4395);
    const foot = joint(`${side}Foot`, leg, 0, -0.451);
    joint(`${side}ToeBase`, foot, 0, -0.04, 0.1);
    const arm = joint(`${side}Arm`, spine2, sign * 0.24, 0.08);
    const fore = joint(`${side}ForeArm`, arm, sign * 0.25, 0);
    joint(`${side}Hand`, fore, sign * 0.23, 0);
  }
  root.computeWorldMatrix(true);
  for (const n of root.getDescendants()) n.computeWorldMatrix(true);
  const body = Object.assign(Object.create(SoldierBodyController.prototype), {
    scene,
    r: rig,
    loaded: true,
    dying: false,
    joints,
    deathJoints: [],
    deathRest: {},
    deathBlend: 0,
    mirrorSign: 1,
    restHipPosition: new Vector3(),
    deathHipPosition: new Vector3(),
    mountF: null,
  });
  rig.body = body;
  body.captureDeathRestPose();
  return { rig, joints, scene, death: new DeathPerformance(rig) };
}

function begin(actor, variant, cues = {}) {
  const random = Math.random;
  Math.random = () => 0.7;
  try {
    actor.death.begin(cues, variant);
  } finally {
    Math.random = random;
  }
}

function advance(death, end, step) {
  let elapsed = 0;
  while (elapsed < end - 1e-10) {
    const dt = Math.min(step, end - elapsed);
    death.update(dt);
    elapsed += dt;
  }
}

function snapshot(a) {
  const { rig, joints } = a;
  return [
    rig.root.position,
    rig.root.rotation,
    rig.torso.rotation,
    rig.head.rotation,
    rig.gun.position,
    ...Object.values(joints).map((j) => j.getAbsolutePosition()),
  ].flatMap((v) => v.asArray());
}

const contacts = [
  ["Hips", 0.15],
  ["Spine1", 0.17],
  ["Spine2", 0.17],
  ["Head", 0.13],
  ["LeftArm", 0.09],
  ["RightArm", 0.09],
  ["LeftForeArm", 0.065],
  ["RightForeArm", 0.065],
  ["LeftHand", 0.05],
  ["RightHand", 0.05],
  ["LeftLeg", 0.1],
  ["RightLeg", 0.1],
  ["LeftFoot", 0.075],
  ["RightFoot", 0.075],
  ["LeftToeBase", 0.06],
  ["RightToeBase", 0.06],
];

for (const variant of ["back", "forward", "spin"]) {
  test(`${variant} falls extend the legs and settle on the actor's ground height`, () => {
    const a = actor();
    begin(a, variant);
    advance(a.death, 2.5, 1 / 60);
    assert.ok(snapshot(a).every(Number.isFinite));
    const hips = a.joints.Hips.getAbsolutePosition();
    const torso = a.joints.Head.getAbsolutePosition().subtract(hips).normalize();
    for (const side of ["Left", "Right"]) {
      const leg = a.joints[`${side}Foot`].getAbsolutePosition().subtract(hips).normalize();
      assert.ok(Vector3.Dot(torso, leg) < -0.8, `${side} leg folded toward the head`);
    }
    const lowest = Math.min(...contacts.map(([key, radius]) => a.joints[key].getAbsolutePosition().y - radius));
    assert.ok(Math.abs(lowest - 3) < 1e-5, `ground contact=${lowest}`);
    assert.equal(a.rig.gun.parent, null);
    assert.ok(Math.abs(a.rig.gun.position.y - 3.06) < 1e-8, "rifle uses elevated ground height");
    const resting = snapshot(a);
    a.death.update(1);
    assert.deepEqual(snapshot(a), resting, "corpse keeps moving after the settle");
    a.scene.dispose();
  });

  test(`${variant} pose and rifle flight agree across fine frames and a lag spike`, () => {
    const fine = actor();
    const coarse = actor();
    begin(fine, variant);
    begin(coarse, variant);
    advance(fine.death, 2.5, 1 / 120);
    coarse.death.update(2.5);
    const expected = snapshot(fine);
    const actual = snapshot(coarse);
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-5, `component ${i}: ${value} vs ${expected[i]}`));
    assert.ok(Math.abs(Quaternion.Dot(fine.rig.gun.rotationQuaternion, coarse.rig.gun.rotationQuaternion)) > 1 - 1e-6);
    fine.scene.dispose();
    coarse.scene.dispose();
  });
}

test("walking knees blend out instead of being added to the final death pose", () => {
  const standing = actor();
  const walking = actor();
  walking.joints.LeftUpLeg.rotation.x = 0.6;
  walking.joints.LeftLeg.rotation.x = -1.15;
  walking.joints.RightUpLeg.rotation.x = -0.35;
  walking.joints.RightLeg.rotation.x = -0.4;
  walking.rig.hipL.rotation.x = 0.6;
  walking.rig.kneeL.rotation.x = -1.15;
  for (const a of [standing, walking]) {
    begin(a, "back");
    a.death.update(2.5);
  }
  const expected = snapshot(standing);
  snapshot(walking).forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-5));
  standing.scene.dispose();
  walking.scene.dispose();
});

test("cues fire once in time order and reset restores the actor before another death", () => {
  const a = actor();
  const origin = a.rig.root.position.clone();
  const before = Object.fromEntries(
    Object.entries(a.joints).map(([key, j]) => [key, j.rotationQuaternion?.clone() ?? Quaternion.FromEulerVector(j.rotation)])
  );
  const cues = [];
  begin(a, "forward", {
    onGasp: () => cues.push("gasp"),
    onEyesClose: () => cues.push("eyes"),
    onImpact: () => cues.push("impact"),
  });
  a.death.update(3);
  a.death.update(1);
  assert.deepEqual(cues, ["gasp", "eyes", "impact"]);
  a.death.reset();
  assert.equal(a.death.running, false);
  assert.deepEqual(a.rig.root.position.asArray(), origin.asArray());
  assert.equal(a.rig.gun.parent, a.rig.gunArm);
  assert.deepEqual(a.rig.gun.position.asArray(), a.rig.gunHomePos.asArray());
  assert.equal(a.rig.faceMesh.material, a.rig.faceMat);
  for (const [key, j] of Object.entries(a.joints))
    assert.ok(
      Math.abs(Quaternion.Dot(j.rotationQuaternion ?? Quaternion.FromEulerVector(j.rotation), before[key])) > 1 - 1e-6,
      key
    );
  // No intervening animation frame: the previous corpse cannot be the base.
  begin(a, "back");
  a.death.update(2.5);
  const head = a.joints.Head.getAbsolutePosition().subtract(a.joints.Hips.getAbsolutePosition()).normalize();
  const foot = a.joints.LeftFoot.getAbsolutePosition().subtract(a.joints.Hips.getAbsolutePosition()).normalize();
  assert.ok(Vector3.Dot(head, foot) < -0.8);
  a.scene.dispose();
});

test("paused and invalid frame deltas leave the death untouched", () => {
  const a = actor();
  begin(a, "spin");
  const before = snapshot(a);
  for (const dt of [0, -1, NaN, Infinity]) a.death.update(dt);
  assert.deepEqual(snapshot(a), before);
  a.scene.dispose();
});
