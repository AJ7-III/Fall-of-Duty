import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { SoldierRig } from "../bots/SoldierBody";

// A shallow, asymmetric buckle, one unsuccessful recovery, then a fall.
// The legs release as the body tips: keeping the crouch through impact made
// the skinned soldier fold in half. Poses are sampled from elapsed time so a
// slow frame cannot change the choreography or the rifle's flight.
export interface DeathCues {
  onGasp?: () => void;
  onEyesClose?: () => void;
  onImpact?: () => void;
}

export type DeathVariant = "back" | "forward" | "spin";

interface Cue {
  at: number;
  fn: () => void;
  fired: boolean;
}

interface Timeline {
  sinkStart: number;
  sinkEnd: number;
  tipStart: number;
  tipEnd: number;
  gunDropAt: number;
  gaspAt: number;
}

const TIMELINES: Record<DeathVariant, Timeline> = {
  back: { sinkStart: 0.12, sinkEnd: 0.72, tipStart: 0.5, tipEnd: 1.32, gunDropAt: 0.22, gaspAt: 0.3 },
  forward: { sinkStart: 0.08, sinkEnd: 0.68, tipStart: 0.98, tipEnd: 1.62, gunDropAt: 0.42, gaspAt: 0.32 },
  spin: { sinkStart: 0.18, sinkEnd: 0.8, tipStart: 0.62, tipEnd: 1.3, gunDropAt: 0.18, gaspAt: 0.26 },
};

const GRAVITY = -15;
const LIE_OFFSET: Record<DeathVariant, number> = { back: 0.16, forward: 0.17, spin: 0.2 };
const TMP_Q = new Quaternion();
const TMP_P = new Vector3();
const TMP_RP = new Vector3();

function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function fell(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (1.6 - 0.6 * c);
}

export class DeathPerformance {
  private rig: SoldierRig;
  private t = 0;
  private cues: Cue[] = [];
  private active = false;
  private variant: DeathVariant = "back";
  private tl: Timeline = TIMELINES.back;
  private sideTilt = 0;
  private spinDir = 1;
  private legBias = 1;
  private hipRest = 0.95;
  private thigh = 0.45;
  private shin = 0.42;
  private baseY = 0;
  private baseYaw = 0;
  private baseX = 0;
  private baseZ = 0;
  private armStart = 0;
  private gunDropped = false;
  private gunLanded = false;
  private gunVel = new Vector3();
  private gunStart = new Vector3();
  private gunRotation = new Quaternion();
  private gunSpin = 0;

  constructor(rig: SoldierRig) {
    this.rig = rig;
  }

  public get running(): boolean {
    return this.active;
  }

  public get currentVariant(): DeathVariant {
    return this.variant;
  }

  public get impactTime(): number {
    return this.tl.tipEnd;
  }

  public begin(cues: DeathCues = {}, variant?: DeathVariant): void {
    const r = this.rig;
    r.body.beginDeath();
    const legs = r.body.legMetrics();
    this.hipRest = legs.hip;
    this.thigh = legs.thigh;
    this.shin = legs.shin;
    this.active = true;
    this.t = 0;
    this.variant = variant ?? (["back", "forward", "spin"] as DeathVariant[])[(Math.random() * 3) | 0];
    this.tl = TIMELINES[this.variant];
    this.sideTilt = (Math.random() < 0.5 ? -1 : 1) * (0.1 + Math.random() * 0.12);
    this.spinDir = Math.random() < 0.5 ? -1 : 1;
    this.legBias = Math.random() < 0.5 ? -1 : 1;
    this.baseY = r.root.position.y;
    this.baseX = r.root.position.x;
    this.baseZ = r.root.position.z;
    this.baseYaw = r.root.rotation.y;
    this.armStart = r.gunArm.rotation.x;
    this.gunDropped = false;
    this.gunLanded = false;
    this.gunVel.set((Math.random() * 2 - 1) * 0.4, 0.4, (Math.random() * 2 - 1) * 0.4);
    this.gunSpin = 2.5 + Math.random() * 3;

    // The kill-time skeleton already contains walk/aim offsets. The death
    // proxies start at zero rather than adding those offsets a second time.
    for (const p of [r.torso, r.head, r.hipL, r.hipR, r.kneeL, r.kneeR, r.armL, r.armR, r.foreL, r.foreR]) {
      p.rotation.set(0, 0, 0);
    }
    this.cues = [
      { at: this.tl.gunDropAt, fired: false, fn: () => this.dropGun() },
      { at: this.tl.gaspAt, fired: false, fn: () => cues.onGasp?.() },
      {
        at: this.tl.tipEnd - 0.12,
        fired: false,
        fn: () => {
          r.faceMesh.material = r.faceShutMat;
          cues.onEyesClose?.();
        },
      },
      { at: this.tl.tipEnd, fired: false, fn: () => cues.onImpact?.() },
    ].sort((a, b) => a.at - b.at);
  }

  public update(dt: number): void {
    if (!this.active || dt <= 0 || !Number.isFinite(dt)) return;
    const next = this.t + dt;
    // Evaluate at crossed cue times, especially the rifle release. Otherwise
    // a lag spike detaches it from an earlier pose and advances it a full dt.
    for (const cue of this.cues) {
      if (!cue.fired && next >= cue.at) {
        this.poseAt(cue.at);
        cue.fired = true;
        cue.fn();
      }
    }
    this.t = next;
    this.poseAt(next);
    if (this.gunDropped && !this.gunLanded) this.updateGun(next - this.tl.gunDropAt);
  }

  private poseAt(t: number): void {
    const r = this.rig;
    const tl = this.tl;
    const sinkK = smooth((t - tl.sinkStart) / (tl.sinkEnd - tl.sinkStart));
    const tipK = fell((t - tl.tipStart) / (tl.tipEnd - tl.tipStart));
    const release = smooth((t - tl.tipStart) / (tl.tipEnd - tl.tipStart));
    const bt = Math.max(0, t - tl.tipEnd);
    const down = t >= tl.tipEnd;
    const landing = smooth((tipK - 0.72) / 0.28);
    const hit = smooth(t / 0.08) * (1 - smooth((t - 0.15) / 0.22));
    const recovery = smooth((t - 0.24) / 0.2) * (1 - smooth((t - 0.55) / 0.25));
    const bounce = down ? Math.sin(Math.min(1, bt / 0.24) * Math.PI) * Math.exp(-7 * bt) * 0.035 : 0;
    // A boot catches up just after the body lands, then stays still.
    const boot = down ? Math.sin(Math.min(1, bt / 0.4) * Math.PI) * Math.exp(-5 * bt) * 0.2 : 0;
    const bend = 0.74 * sinkK * (1 - release) + (this.variant === "spin" ? 0.16 : 0.08) * release;
    const phi = (bend * this.shin) / (this.thigh + this.shin);
    const leadL = this.legBias > 0;
    r.hipL.rotation.set(phi * (leadL ? 1.12 : 0.88), 0, -0.07 * release);
    r.hipR.rotation.set(phi * (leadL ? 0.88 : 1.12), 0, 0.09 * release);
    r.kneeL.rotation.x = -bend * (leadL ? 1.12 : 0.88) - boot * (leadL ? 1 : 0.3);
    r.kneeR.rotation.x = -bend * (leadL ? 0.88 : 1.12) - boot * (leadL ? 0.3 : 1);
    const sink = this.thigh * (1 - Math.cos(phi)) + this.shin * (1 - Math.cos(bend - phi));

    let pitch = 0;
    let roll = this.sideTilt * 0.28 * tipK;
    let yaw = 0;
    let driftX = 0;
    let driftZ = 0;
    const angle = tipK * (Math.PI / 2 - 0.035);
    if (this.variant === "back") {
      pitch = -angle;
      driftZ = -(this.hipRest - sink) * Math.sin(angle) * 0.68;
    } else if (this.variant === "forward") {
      pitch = angle;
      driftZ = (this.hipRest - sink) * Math.sin(angle) * 0.68;
    } else {
      yaw = this.spinDir * 0.85 * smooth((t - 0.1) / 0.8);
      roll = Math.sign(this.sideTilt) * angle;
      pitch = -0.08 * tipK;
      driftX = -Math.sign(this.sideTilt) * (this.hipRest - sink) * Math.sin(angle) * 0.6;
    }
    r.root.rotation.set(pitch, this.baseYaw + yaw, roll);
    // Rotate about the hips, then lower that anatomical point to the floor.
    // Rotating a positive foot pivot around the model origin instead left
    // the prone variant suspended above the ground.
    Quaternion.RotationYawPitchRollToRef(this.baseYaw + yaw, pitch, roll, TMP_Q);
    TMP_P.set(0, this.hipRest, 0);
    TMP_P.rotateByQuaternionToRef(TMP_Q, TMP_RP);
    const hipY = (this.hipRest - sink) * Math.cos(angle) + LIE_OFFSET[this.variant] * Math.sin(angle) + bounce;
    const rotatedHipX = TMP_RP.x;
    const rotatedHipY = TMP_RP.y;
    const rotatedHipZ = TMP_RP.z;
    Quaternion.RotationYawPitchRollToRef(this.baseYaw + yaw, 0, 0, TMP_Q);
    TMP_P.set(driftX, 0, driftZ);
    TMP_P.rotateByQuaternionToRef(TMP_Q, TMP_RP);
    r.root.position.set(
      this.baseX + TMP_RP.x - rotatedHipX,
      this.baseY + hipY - rotatedHipY,
      this.baseZ + TMP_RP.z - rotatedHipZ
    );

    // Small spine/head bends sell the hit; the root carries the actual fall.
    r.torso.rotation.x = 0.16 * hit + (this.variant === "forward" ? 0.1 * sinkK : -0.09 * tipK) * (1 - landing * 0.7);
    r.head.rotation.x = 0.15 * hit + (this.variant === "back" ? -0.12 : 0.1) * tipK;
    r.head.rotation.z = this.sideTilt * 0.65 * tipK;

    let armX: number;
    let spreadL: number;
    let spreadR: number;
    if (this.variant === "back") {
      armX = -0.35 - 0.6 * recovery - 1.1 * release + 1.3 * landing;
      spreadL = 0.12 + 0.55 * release - 0.42 * landing;
      spreadR = 0.08 + 0.3 * release - 0.15 * landing;
    } else if (this.variant === "forward") {
      armX = -0.3 - 1.25 * release - 1.5 * landing;
      spreadL = 0.1 + 0.35 * release;
      spreadR = 0.08 + 0.24 * release;
    } else {
      armX = -0.4 - 0.65 * release + 0.75 * landing;
      spreadL = 0.12 + (this.sideTilt > 0 ? 0.1 : 0.38) * release;
      spreadR = 0.1 + (this.sideTilt > 0 ? 0.38 : 0.1) * release;
    }
    r.gunArm.rotation.x = this.armStart + (armX - this.armStart) * smooth(t / 0.25);
    r.gunArm.rotation.z = this.sideTilt * 0.3 * release;
    // One hand tries to save it a fraction later: the little comic beat.
    r.armL.rotation.x = -0.16 * recovery - 0.12 * release * (1 - landing);
    r.armR.rotation.x = 0.18 * recovery + 0.1 * release * (1 - landing);
    r.armL.rotation.z = spreadL;
    r.armR.rotation.z = spreadR;
    r.foreL.rotation.x = -0.55 * (1 - release) - (this.variant === "forward" ? 0.02 : 0.12) * release;
    r.foreR.rotation.x = -0.7 * (1 - release) - (this.variant === "forward" ? 0.04 : 0.18) * release;

    r.body.setDeathBlend(smooth(t / 0.65));
    r.body.placeDeathOnGround(this.baseY, down ? smooth(bt / 0.3) : 0);
  }

  private dropGun(): void {
    const gun = this.rig.gun;
    gun.setParent(null);
    this.gunStart.copyFrom(gun.position);
    this.gunRotation.copyFrom(gun.rotationQuaternion ?? Quaternion.FromEulerVector(gun.rotation));
    this.gunDropped = true;
  }

  private updateGun(elapsed: number): void {
    const gun = this.rig.gun;
    const floor = this.baseY + 0.06;
    const height = Math.max(0, this.gunStart.y - floor);
    const landingTime = (this.gunVel.y + Math.sqrt(this.gunVel.y * this.gunVel.y - 2 * GRAVITY * height)) / -GRAVITY;
    const t = Math.min(elapsed, landingTime);
    gun.position.set(
      this.gunStart.x + this.gunVel.x * t,
      Math.max(floor, this.gunStart.y + this.gunVel.y * t + 0.5 * GRAVITY * t * t),
      this.gunStart.z + this.gunVel.z * t
    );
    Quaternion.RotationAxisToRef(Vector3.RightReadOnly, this.gunSpin * t, TMP_Q);
    if (!gun.rotationQuaternion) gun.rotationQuaternion = new Quaternion();
    TMP_Q.multiplyToRef(this.gunRotation, gun.rotationQuaternion);
    this.gunLanded = elapsed >= landingTime;
  }

  public reset(): void {
    const r = this.rig;
    if (this.active) {
      r.root.position.set(this.baseX, this.baseY, this.baseZ);
      r.root.rotation.set(0, this.baseYaw, 0);
    }
    this.active = false;
    this.t = 0;
    this.cues = [];
    for (const p of [r.torso, r.head, r.armL, r.armR, r.foreL, r.foreR, r.hipL, r.hipR, r.kneeL, r.kneeR])
      p.rotation.set(0, 0, 0);
    r.torso.position.y = 0;
    r.gunArm.rotation.set(0.5, 0, 0);
    r.root.rotation.x = 0;
    r.root.rotation.z = 0;
    r.gun.rotationQuaternion = null;
    r.gun.parent = r.gunArm;
    r.gun.position.copyFrom(r.gunHomePos);
    r.gun.rotation.set(0, 0, 0);
    r.faceMesh.material = r.faceMat;
    this.gunDropped = false;
    this.gunLanded = false;
    r.body.endDeath();
  }
}
