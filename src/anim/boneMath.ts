import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import type { TransformNode } from "@babylonjs/core";

// Skeleton math shared by the soldier bodies and the first-person arms:
// axis-pair frames, joint-local direction lookups, the analytic two-bone
// arm solver, and the "aim this bone's captured frame at these world
// directions" primitive every pose layer is built from.

// Dedicated scratch per routine — these helpers nest (solveTwoBone calls
// setSegment calls frameQuat), so sharing one temp pool would alias.
const TMP_M = new Matrix();
const FQ_Y = new Vector3();
const FQ_Z = new Vector3();
const FQ_T = new Vector3();
const SS_M = new Matrix();
const SS_D = new Vector3();
const SS_B = new Vector3();
const SS_Q1 = new Quaternion();
const SS_Q2 = new Quaternion();
const IK_T = new Vector3();
const IK_DIR = new Vector3();
const IK_PV = new Vector3();
const IK_TMP = new Vector3();
const IK_ELBOW = new Vector3();

// Joint-local representation of a world direction (normalized)
export function dirToLocal(world: Vector3, node: TransformNode, out: Vector3): Vector3 {
  node.getWorldMatrix().invertToRef(TMP_M);
  Vector3.TransformNormalToRef(world, TMP_M, out);
  return out.normalize();
}

// Rotation quaternion from an axis pair: y = primary (bone direction),
// z-ish = secondary (bend/facing reference). Both frames are built
// identically, so mapping one onto the other is always a proper rotation
// even when the surrounding matrix chain is mirrored.
export function frameQuat(y: Vector3, zRef: Vector3, out: Quaternion): Quaternion {
  const yn = FQ_Y.copyFrom(y).normalize();
  const z = FQ_Z.copyFrom(zRef);
  z.subtractInPlace(FQ_T.copyFrom(yn).scaleInPlace(Vector3.Dot(z, yn)));
  if (z.lengthSquared() < 1e-8) z.set(yn.y, yn.z, yn.x); // degenerate ref: any perpendicular
  z.normalize();
  const x = Vector3.Cross(yn, z);
  Quaternion.RotationQuaternionFromAxisToRef(x, yn, z, out);
  return out;
}

// A bone's captured local frame: its axis toward the child (dL) and a bend
// reference (bL), both in the node's own space at bind time
export interface BoneFrame {
  dL: Vector3;
  bL: Vector3;
}

export function captureBoneFrame(node: TransformNode, child: TransformNode, worldRef: Vector3): BoneFrame {
  return {
    dL: child.position.clone().normalize(), // child's local pos IS the bone axis in node space
    bL: dirToLocal(worldRef, node, new Vector3()).clone(),
  };
}

// Rotate a bone node so its captured local axis/bend-ref frame lands on the
// desired world directions. Leaves the node's world matrix stale — callers
// recompute once they are done with the chain.
export function setSegment(node: TransformNode, frame: BoneFrame, dW: Vector3, bW: Vector3): void {
  const parent = node.parent as TransformNode;
  parent.getWorldMatrix().invertToRef(SS_M);
  Vector3.TransformNormalToRef(dW, SS_M, SS_D);
  SS_D.normalize();
  Vector3.TransformNormalToRef(bW, SS_M, SS_B);
  frameQuat(SS_D, SS_B, SS_Q1); // destination frame in parent space
  frameQuat(frame.dL, frame.bL, SS_Q2); // source frame in node space
  SS_Q2.invertInPlace();
  if (!node.rotationQuaternion) node.rotationQuaternion = new Quaternion();
  SS_Q1.multiplyToRef(SS_Q2, node.rotationQuaternion);
}

export interface TwoBoneChain {
  upper: TransformNode;
  fore: TransformNode;
  aLen: number;
  bLen: number;
  upperFrame: BoneFrame;
  foreFrame: BoneFrame;
}

// Analytic two-bone IK: bend the chain so the fore bone's tip reaches
// `target` (world), with the elbow pulled toward `pole` (world). Reach is
// clamped just inside full extension so the elbow never snaps straight.
export function solveTwoBone(chain: TwoBoneChain, target: Vector3, pole: Vector3): void {
  chain.upper.computeWorldMatrix(true);
  const S = chain.upper.getAbsolutePosition();
  IK_DIR.copyFrom(target).subtractInPlace(S);
  let d = IK_DIR.length();
  if (d < 1e-4) return;
  IK_DIR.scaleInPlace(1 / d);
  d = Math.min(chain.aLen + chain.bLen - 0.005, Math.max(Math.abs(chain.aLen - chain.bLen) + 0.005, d));

  // bend plane from the pole
  IK_PV.copyFrom(pole).subtractInPlace(S);
  IK_PV.subtractInPlace(IK_TMP.copyFrom(IK_DIR).scaleInPlace(Vector3.Dot(IK_PV, IK_DIR)));
  if (IK_PV.lengthSquared() < 1e-6) IK_PV.set(0, -1, 0.2);
  IK_PV.normalize();

  const cosS = Math.min(1, Math.max(-1, (chain.aLen * chain.aLen + d * d - chain.bLen * chain.bLen) / (2 * chain.aLen * d)));
  const sinS = Math.sqrt(Math.max(0, 1 - cosS * cosS));
  IK_ELBOW.copyFrom(IK_DIR).scaleInPlace(cosS).addInPlace(IK_TMP.copyFrom(IK_PV).scaleInPlace(sinS)).normalize();

  setSegment(chain.upper, chain.upperFrame, IK_ELBOW, IK_PV);
  chain.upper.computeWorldMatrix(true);
  chain.fore.computeWorldMatrix(true);

  // forearm: from the solved elbow toward the (reach-clamped) target
  IK_T.copyFrom(IK_DIR).scaleInPlace(d).addInPlace(S);
  IK_T.subtractInPlace(chain.fore.getAbsolutePosition()).normalize();
  setSegment(chain.fore, chain.foreFrame, IK_T, IK_PV);
  chain.fore.computeWorldMatrix(true);
}
