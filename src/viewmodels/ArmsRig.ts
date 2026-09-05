import { Quaternion, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import type { AssetContainer, Mesh, Scene } from "@babylonjs/core";
import { whenSoldierModelReady } from "../bots/SoldierAssets";
import { soldierMaterialFor } from "../bots/SoldierBody";
import { captureBoneFrame, dirToLocal, frameQuat, setSegment, solveTwoBone } from "../anim/boneMath";
import type { BoneFrame, TwoBoneChain } from "../anim/boneMath";
import type { HandAnchor, HandPose } from "./kit";

// First-person arms cut from the SAME rigged soldier the third-person body
// uses — same armour plates, same gloves, same normal map — so what you see
// holding the rifle is what you see hit the ground on the death cam.
//
// The shared glTF is instantiated a second time under a camera-parented
// root, the body mesh is trimmed to the triangles the arm/hand bone chains
// own, and the skeleton is posed procedurally every frame: a two-bone IK
// per arm chases the weapon's hand anchors, the wrist is aimed at the
// anchor's grip frame, and the finger joints curl by the anchor's pose.
// Nothing is keyframed, so every weapon animation the rig already drives
// (bolt work, mag swaps, charging handles) moves the hands for free.

export interface ArmsTuning {
  chest: [number, number, number]; // camera-space point the shoulders straddle
  pitch: number; // torso lean (rad)
  yaw: number;
  scale: number; // viewmodel arms run larger than life so they reach
  poleL: [number, number, number]; // camera-space elbow hints
  poleR: [number, number, number];
  curlMax: number; // radians per finger joint at curl = 1
}

interface FingerJoint {
  node: TransformNode;
  base: Quaternion;
  axis: Vector3; // local flex axis (bind-captured)
  weight: number; // share of the curl this joint takes
}

interface Finger {
  key: keyof HandPose["curl"];
  joints: FingerJoint[];
}

interface ArmSide {
  chain: TwoBoneChain;
  baseALen: number; // bone lengths at tuning.scale = 1
  baseBLen: number;
  hand: TransformNode;
  handFrame: BoneFrame;
  fingers: Finger[];
  pole: TransformNode;
}

const SOLDIER_HEIGHT = 1.85;
const ARM_BONE = /^(Left|Right)(Arm|ForeArm|Hand)/;

// Curl is split down the finger: the knuckle does the most, the tip the least
const JOINT_WEIGHTS = [1.0, 0.85, 0.65];
const THUMB_WEIGHTS = [0.55, 0.8, 0.6];

const TMP_Q = new Quaternion();
const TMP_QA = new Quaternion();
const TMP_QB = new Quaternion();
const TMP_V = new Vector3();
const TMP_Y = new Vector3();
const TMP_Z = new Vector3();

export class ArmsRig {
  public readonly root: TransformNode;
  public tuning: ArmsTuning = {
    chest: [0.05, -0.42, 0.3],
    pitch: 0.25,
    yaw: -0.1,
    scale: 1.1,
    poleL: [-0.7, -1.0, 0.15],
    poleR: [0.7, -1.0, 0.0],
    curlMax: 1.35,
  };

  private scene: Scene;
  private instRoot: TransformNode | null = null;
  private sides: { left: ArmSide; right: ArmSide } | null = null;
  private anchors: { left: HandAnchor; right: HandAnchor } | null = null;
  private hidden = false;

  constructor(scene: Scene, pivot: TransformNode) {
    this.scene = scene;
    this.root = new TransformNode("fpArmsRoot", scene);
    this.root.parent = pivot;
    this.root.rotationQuaternion = new Quaternion();
    whenSoldierModelReady(scene, (c) => this.attach(c));
  }

  public get ready(): boolean {
    return this.sides !== null;
  }

  public setAnchors(left: HandAnchor, right: HandAnchor): void {
    this.anchors = { left, right };
  }

  public setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.root.setEnabled(!hidden);
  }

  // ------------------------------------------------------------------ build

  private attach(container: AssetContainer): void {
    if (this.scene.isDisposed) return;
    const inst = container.instantiateModelsToScene((n) => `fpArms_${n}`, false, { doNotInstantiate: true });
    for (const g of inst.animationGroups) g.dispose(); // posed by hand, never by clip
    const instRoot = inst.rootNodes[0] as TransformNode;
    const align = new TransformNode("fpArms_align", this.scene);
    align.parent = this.root;
    instRoot.parent = align;
    this.instRoot = align;

    const computeAll = (): void => {
      this.root.computeWorldMatrix(true);
      align.computeWorldMatrix(true);
      for (const n of align.getDescendants(false)) (n as TransformNode).computeWorldMatrix(true);
    };
    computeAll();

    const joints: Record<string, TransformNode> = {};
    for (const n of align.getDescendants(false)) {
      const i = n.name.indexOf("mixamorig:");
      if (i >= 0) joints[n.name.slice(i + "mixamorig:".length)] = n as TransformNode;
    }
    const j = (key: string): TransformNode => {
      const node = joints[key];
      if (!node) throw new Error(`fp arms rig missing joint ${key}`);
      return node;
    };

    // Face the character down the camera's +Z (toes tell the truth about
    // where the exporter left it looking) and normalize to the soldiers'
    // height so the arm bones match the bodies' proportions
    const toeDir = j("LeftToe_End")
      .getAbsolutePosition()
      .clone()
      .addInPlace(j("RightToe_End").getAbsolutePosition())
      .subtractInPlace(j("LeftToeBase").getAbsolutePosition())
      .subtractInPlace(j("RightToeBase").getAbsolutePosition());
    const invRootQ = this.root.absoluteRotationQuaternion.clone().invertInPlace();
    toeDir.rotateByQuaternionToRef(invRootQ, toeDir);
    align.rotation.y = -Math.atan2(toeDir.x, toeDir.z);
    computeAll();
    const h = Math.max(0.1, j("HeadTop_End").getAbsolutePosition().y - align.getAbsolutePosition().y);
    align.scaling.setAll((SOLDIER_HEIGHT / h) * align.scaling.x);
    computeAll();

    // Slide the whole figure so the shoulder joints straddle the root origin;
    // `tuning.chest` then places that point in camera space
    const mid = j("LeftArm").getAbsolutePosition().add(j("RightArm").getAbsolutePosition()).scaleInPlace(0.5);
    const rootInv = this.root.getWorldMatrix().clone().invert();
    const midLocal = Vector3.TransformCoordinates(mid, rootInv);
    align.position.subtractInPlace(midLocal);
    computeAll();

    this.trimToArms(inst.rootNodes[0] as TransformNode);

    const rootQ = this.root.absoluteRotationQuaternion;
    const back = Vector3.Forward().rotateByQuaternionToRef(rootQ, new Vector3()).scaleInPlace(-1);
    const buildSide = (side: "Left" | "Right"): ArmSide => {
      const upper = j(`${side}Arm`);
      const fore = j(`${side}ForeArm`);
      const hand = j(`${side}Hand`);
      const middle = j(`${side}HandMiddle1`);

      // Palm normal from the hand's own geometry: the finger axis crossed
      // with the knuckle line (index -> pinky) points out of the palm at bind
      const F = j(`${side}HandMiddle2`).getAbsolutePosition().subtract(middle.getAbsolutePosition()).normalize();
      const W = j(`${side}HandPinky1`).getAbsolutePosition().subtract(j(`${side}HandIndex1`).getAbsolutePosition()).normalize();
      const palmW = side === "Right" ? Vector3.Cross(W, F) : Vector3.Cross(F, W);
      palmW.normalize();

      const fingers: Finger[] = [];
      const fingerNames: Array<[keyof HandPose["curl"], string, number[]]> = [
        ["thumb", "Thumb", THUMB_WEIGHTS],
        ["index", "Index", JOINT_WEIGHTS],
        ["middle", "Middle", JOINT_WEIGHTS],
        ["ring", "Ring", JOINT_WEIGHTS],
        ["pinky", "Pinky", JOINT_WEIGHTS],
      ];
      for (const [key, name, weights] of fingerNames) {
        const fj: FingerJoint[] = [];
        for (let k = 1; k <= 3; k++) {
          const node = joints[`${side}Hand${name}${k}`];
          const child = joints[`${side}Hand${name}${k + 1}`];
          if (!node || !child) break;
          const dL = child.position.clone().normalize();
          const pL = dirToLocal(palmW, node, new Vector3()).clone();
          const axis = Vector3.Cross(dL, pL);
          if (axis.lengthSquared() < 1e-8) break;
          axis.normalize();
          if (!node.rotationQuaternion) node.rotationQuaternion = Quaternion.FromEulerVector(node.rotation);
          fj.push({ node, base: node.rotationQuaternion.clone(), axis, weight: weights[k - 1] });
        }
        fingers.push({ key, joints: fj });
      }

      const pole = new TransformNode(`fpArms_pole${side}`, this.scene);
      pole.parent = this.root.parent;

      const aLen = Vector3.Distance(upper.getAbsolutePosition(), fore.getAbsolutePosition());
      const bLen = Vector3.Distance(fore.getAbsolutePosition(), hand.getAbsolutePosition());
      return {
        chain: {
          upper,
          fore,
          aLen,
          bLen,
          upperFrame: captureBoneFrame(upper, fore, back),
          foreFrame: captureBoneFrame(fore, hand, back),
        },
        baseALen: aLen,
        baseBLen: bLen,
        hand,
        handFrame: { dL: middle.position.clone().normalize(), bL: dirToLocal(palmW, hand, new Vector3()).clone() },
        fingers,
        pole,
      };
    };
    this.sides = { left: buildSide("Left"), right: buildSide("Right") };
    this.root.setEnabled(!this.hidden);
  }

  // Keep only the triangles the arm bone chains own: the mesh keeps its
  // vertex buffers and skeleton, just draws a subset of its index buffer
  private trimToArms(instRoot: TransformNode): void {
    for (const mesh of instRoot.getChildMeshes(false) as Mesh[]) {
      const skel = mesh.skeleton;
      if (!skel || mesh.name.toLowerCase().includes("visor")) {
        mesh.dispose();
        continue;
      }
      const armBones = new Set<number>();
      skel.bones.forEach((b, i) => {
        const short = b.name.slice(b.name.indexOf("mixamorig:") + "mixamorig:".length);
        if (ARM_BONE.test(short)) armBones.add(i);
      });
      const mi = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
      const mw = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
      const idx = mesh.getIndices();
      if (!mi || !mw || !idx) continue;
      const n = mesh.getTotalVertices();
      const isArm = new Uint8Array(n);
      for (let v = 0; v < n; v++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (armBones.has(mi[v * 4 + k])) w += mw[v * 4 + k];
        isArm[v] = w >= 0.5 ? 1 : 0;
      }
      const kept: number[] = [];
      for (let t = 0; t + 2 < idx.length; t += 3) {
        if (isArm[idx[t]] && isArm[idx[t + 1]] && isArm[idx[t + 2]]) kept.push(idx[t], idx[t + 1], idx[t + 2]);
      }
      mesh.setIndices(kept, n, true);
      mesh.material = soldierMaterialFor(this.scene, "player", false, mesh.material);
      mesh.isPickable = false;
      mesh.receiveShadows = false;
      mesh.alwaysSelectAsActiveMesh = true; // skinned bounds don't follow the pose
    }
  }

  // ----------------------------------------------------------------- update

  // Called by ViewModelRig after the weapon's transform for this frame is
  // final, so the anchors resolve against where the hands must actually be
  public update(): void {
    if (!this.sides || !this.anchors || !this.instRoot || this.hidden) return;
    const t = this.tuning;
    this.root.position.set(t.chest[0], t.chest[1], t.chest[2]);
    Quaternion.FromEulerAnglesToRef(t.pitch, t.yaw, 0, this.root.rotationQuaternion!);
    this.root.scaling.setAll(t.scale);
    this.sides.left.pole.position.set(t.poleL[0], t.poleL[1], t.poleL[2]);
    this.sides.right.pole.position.set(t.poleR[0], t.poleR[1], t.poleR[2]);
    this.root.computeWorldMatrix(true);
    this.instRoot.computeWorldMatrix(true);

    this.solveSide(this.sides.left, this.anchors.left);
    this.solveSide(this.sides.right, this.anchors.right);
  }

  private solveSide(side: ArmSide, anchor: HandAnchor): void {
    // Bone lengths follow the rig scale (the tuning is live in dev)
    side.chain.aLen = side.baseALen * this.tuning.scale;
    side.chain.bLen = side.baseBLen * this.tuning.scale;

    // Resolve the anchor: rest pose, or a blend toward its alternate grip,
    // plus whatever offset the weapon animation is applying this frame
    const node = anchor.node;
    const a = anchor.pose;
    const b = anchor.alt;
    const k = b ? anchor.altBlend : 0;
    node.position.set(
      a.wrist[0] + (b ? (b.wrist[0] - a.wrist[0]) * k : 0) + anchor.offset.x,
      a.wrist[1] + (b ? (b.wrist[1] - a.wrist[1]) * k : 0) + anchor.offset.y,
      a.wrist[2] + (b ? (b.wrist[2] - a.wrist[2]) * k : 0) + anchor.offset.z
    );
    if (!node.rotationQuaternion) node.rotationQuaternion = new Quaternion();
    ArmsRig.poseQuat(a, TMP_QA);
    if (b && k > 0) {
      ArmsRig.poseQuat(b, TMP_QB);
      Quaternion.SlerpToRef(TMP_QA, TMP_QB, k, node.rotationQuaternion);
    } else {
      node.rotationQuaternion.copyFrom(TMP_QA);
    }
    node.computeWorldMatrix(true);

    // Arm: elbow bends toward the pole, wrist lands on the anchor
    side.pole.computeWorldMatrix(true);
    solveTwoBone(side.chain, node.getAbsolutePosition(), side.pole.getAbsolutePosition());

    // Wrist: the hand's knuckle axis and palm normal take the anchor's frame
    const wm = node.getWorldMatrix();
    Vector3.TransformNormalToRef(Vector3.UpReadOnly, wm, TMP_Y);
    Vector3.TransformNormalToRef(Vector3.LeftHandedForwardReadOnly, wm, TMP_Z);
    setSegment(side.hand, side.handFrame, TMP_Y.normalize(), TMP_Z.normalize());
    side.hand.computeWorldMatrix(true);

    // Fingers: curl each joint about its bind-captured flex axis
    const max = this.tuning.curlMax;
    for (const finger of side.fingers) {
      const curl = a.curl[finger.key] + (b ? (b.curl[finger.key] - a.curl[finger.key]) * k : 0);
      for (const joint of finger.joints) {
        Quaternion.RotationAxisToRef(joint.axis, curl * joint.weight * max, TMP_Q);
        joint.base.multiplyToRef(TMP_Q, joint.node.rotationQuaternion!);
      }
    }
  }

  private static poseQuat(pose: HandPose, out: Quaternion): Quaternion {
    TMP_Y.set(pose.knuckles[0], pose.knuckles[1], pose.knuckles[2]);
    TMP_V.set(pose.palm[0], pose.palm[1], pose.palm[2]);
    return frameQuat(TMP_Y, TMP_V, out);
  }
}
