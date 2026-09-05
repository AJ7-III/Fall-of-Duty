import { Quaternion, Vector3 } from "@babylonjs/core";
import type { SoldierRig } from "../bots/SoldierBody";

// The death: a body giving out, not a plank tipping over. Three staged
// collapses, picked at random so no two deaths read the same:
//
//   back     the hit folds them forward, the knees go, the hips drop
//            straight down, then the whole crouched body topples backward
//            over the heels — knees still bent — and bounces once
//   forward  they buckle to their knees clutching the wound, hang there a
//            beat, then pitch face-first over the knees
//   spin     the impact spins them a quarter turn as the legs fail; they
//            fall sideways onto a shoulder
//
// Every variant is built on the same mechanics: a planted-feet leg solve
// (hip height in, thigh/shin angles out, so the feet never leave the ground
// as the knees bend), a root that sinks with the hips, and a fall that
// pivots about the feet or knees rather than the model origin. Pure
// procedural choreography over the SoldierRig's proxy pivots — the owner
// (a Bot, or the player's death-cam corpse) calls update(dt) while dead
// and reset() on respawn. Timed cues fire sound/face hooks exactly once.

export interface DeathCues {
  onGasp?: () => void; // the last breath, as the collapse begins
  onEyesClose?: () => void; // face swap moment (handled here) — extra hook
  onImpact?: () => void; // body meets the ground
}

export type DeathVariant = "back" | "forward" | "spin";

interface Cue {
  at: number;
  fn: () => void;
  fired: boolean;
}

// Per-variant timeline (seconds from the hit)
interface Timeline {
  sinkStart: number;
  sinkEnd: number;
  sinkTo: number; // hip height at the bottom of the collapse (m)
  tipStart: number;
  tipEnd: number;
  gunDropAt: number;
  gaspAt: number;
}

const TIMELINES: Record<DeathVariant, Timeline> = {
  back: { sinkStart: 0.12, sinkEnd: 0.72, sinkTo: 0.52, tipStart: 0.5, tipEnd: 1.32, gunDropAt: 0.22, gaspAt: 0.3 },
  forward: { sinkStart: 0.08, sinkEnd: 0.68, sinkTo: 0.47, tipStart: 0.98, tipEnd: 1.62, gunDropAt: 0.42, gaspAt: 0.32 },
  spin: { sinkStart: 0.18, sinkEnd: 0.8, sinkTo: 0.58, tipStart: 0.62, tipEnd: 1.3, gunDropAt: 0.18, gaspAt: 0.26 },
};

const GRAVITY = -15.0;
const LIE_OFFSET: Record<DeathVariant, number> = { back: 0.13, forward: 0.17, spin: 0.16 };

const TMP_Q = new Quaternion();
const TMP_P = new Vector3();
const TMP_RP = new Vector3();

function smooth(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

// felled-tree acceleration: slow start, fast finish
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

  // every death is staged slightly differently
  private sideTilt = 0; // roll while falling (back/forward) or the fall side (spin)
  private spinDir = 1;
  private legBias = 0; // which knee gives first

  // leg geometry captured at the kill (rest defaults until the skin lands)
  private hipRest = 0.95;
  private thigh = 0.45;
  private shin = 0.42;

  // root transform at the kill — everything is an offset from here
  private baseY = 0;
  private baseYaw = 0;
  private baseX = 0;
  private baseZ = 0;

  // rifle free-fall once it leaves the hands
  private gunDropped = false;
  private gunLanded = false;
  private gunVel = new Vector3();
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

  public begin(cues: DeathCues = {}, variant?: DeathVariant): void {
    const r = this.rig;
    // hand the skeleton over: clips stop, the proxy choreography takes it
    r.body.beginDeath();
    const legs = r.body.legMetrics();
    this.hipRest = legs.hip;
    this.thigh = legs.thigh;
    this.shin = legs.shin;

    this.active = true;
    this.t = 0;
    this.variant = variant ?? (["back", "forward", "spin"] as DeathVariant[])[(Math.random() * 3) | 0];
    this.tl = TIMELINES[this.variant];
    this.sideTilt = (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.25);
    this.spinDir = Math.random() < 0.5 ? -1 : 1;
    this.legBias = Math.random() < 0.5 ? -1 : 1;
    this.baseY = r.root.position.y;
    this.baseX = r.root.position.x;
    this.baseZ = r.root.position.z;
    this.baseYaw = r.root.rotation.y;
    this.gunDropped = false;
    this.gunLanded = false;

    const impactAt = this.tl.tipEnd;
    this.cues = [
      { at: this.tl.gunDropAt, fired: false, fn: () => this.dropGun() },
      { at: this.tl.gaspAt, fired: false, fn: () => cues.onGasp?.() },
      {
        at: impactAt - 0.12, // lids fall as the ground rushes up
        fired: false,
        fn: () => {
          r.faceMesh.material = r.faceShutMat;
          cues.onEyesClose?.();
        },
      },
      { at: impactAt, fired: false, fn: () => cues.onImpact?.() },
    ];
  }

  // exponential approach — frame-rate independent ease toward a pose
  private static app(cur: number, target: number, rate: number, dt: number): number {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }

  // Planted-feet collapse: hip height -> thigh angle forward of vertical
  // (phi) and shin angle behind vertical (psi), with the ankle kept under
  // the hip. Bisection on phi: the height is monotonic in it.
  private solveLegs(h: number): { phi: number; psi: number } {
    const a = this.thigh;
    const b = this.shin;
    const clamped = Math.max(Math.abs(a - b) + 0.02, Math.min(a + b - 0.005, h));
    let lo = 0;
    let hi = Math.PI / 2;
    for (let i = 0; i < 18; i++) {
      const phi = (lo + hi) / 2;
      const sinPsi = Math.min(1, (a / b) * Math.sin(phi));
      const height = a * Math.cos(phi) + b * Math.sqrt(1 - sinPsi * sinPsi);
      if (height > clamped) lo = phi;
      else hi = phi;
    }
    const phi = (lo + hi) / 2;
    return { phi, psi: Math.asin(Math.min(1, (a / b) * Math.sin(phi))) };
  }

  public update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    const r = this.rig;
    const tl = this.tl;
    const app = DeathPerformance.app;

    for (const cue of this.cues) {
      if (!cue.fired && t >= cue.at) {
        cue.fired = true;
        cue.fn();
      }
    }

    // ---- collapse: hips sink, legs fold
    const sinkK = smooth((t - tl.sinkStart) / (tl.sinkEnd - tl.sinkStart));
    const tipK = fell((t - tl.tipStart) / (tl.tipEnd - tl.tipStart));
    const down = t >= tl.tipEnd;
    const bt = down ? t - tl.tipEnd : 0;
    const bounce = down ? Math.exp(-6 * bt) * Math.sin(bt * 18) * 0.05 : 0;
    const lead = this.legBias > 0 ? 1 : -1;
    const stagger = 0.12 * sinkK;

    let hipH: number;
    let phi: number; // thigh forward of vertical
    let psi: number; // shin behind vertical
    if (this.variant === "forward") {
      // Drop to the knees: the shins fold flat behind (the feet slide back),
      // the thighs stay near vertical; through the pitch-over the legs
      // straighten so the shins stay on the ground instead of kicking up
      phi = 0.14 * sinkK * (1 - tipK);
      psi = (Math.PI / 2) * 0.95 * sinkK * (1 - tipK * 0.85);
      hipH = this.thigh * Math.cos(phi) + this.shin * Math.cos(psi);
    } else {
      // Squat straight down with the feet planted: hip height in, angles out
      hipH = this.hipRest + (tl.sinkTo - this.hipRest) * sinkK;
      const legs = this.solveLegs(hipH);
      phi = legs.phi;
      psi = legs.psi;
    }
    // one knee gives first: it folds a touch further, the other lags
    r.hipL.rotation.x = phi * (1 + (lead > 0 ? stagger : -stagger * 0.5));
    r.hipR.rotation.x = phi * (1 + (lead < 0 ? stagger : -stagger * 0.5));
    r.kneeL.rotation.x = -(phi + psi) * (1 + (lead > 0 ? stagger : 0));
    r.kneeR.rotation.x = -(phi + psi) * (1 + (lead < 0 ? stagger : 0));
    const sink = this.hipRest - hipH;

    // ---- fall: the whole body tips about the feet (or the knees)
    let pitch = 0;
    let roll = 0;
    let yaw = 0;
    let pivotY = sink; // root-local height of the planted feet
    let pivotZ = 0.04;
    if (this.variant === "back") {
      pitch = -tipK * (Math.PI / 2 - 0.06) - bounce;
      roll = this.sideTilt * 0.35 * tipK;
    } else if (this.variant === "forward") {
      pitch = tipK * (Math.PI / 2 - 0.1) + bounce * 0.6;
      roll = this.sideTilt * 0.25 * tipK;
      // pivot at the knees: a thigh-length below the hips, on the ground
      pivotZ = this.thigh * Math.sin(0.14);
      pivotY = this.hipRest - this.thigh * Math.cos(0.14);
    } else {
      const spinK = smooth((t - 0.1) / 0.7);
      yaw = this.spinDir * 1.15 * spinK;
      roll = Math.sign(this.sideTilt) * tipK * (Math.PI / 2 - 0.14) + bounce * Math.sign(this.sideTilt);
      pitch = -0.25 * tipK;
    }
    r.root.rotation.set(pitch, this.baseYaw + yaw, roll);

    // root position: sink with the hips, keep the pivot fixed through the
    // fall, and come to rest a body-thickness above the ground
    Quaternion.RotationYawPitchRollToRef(this.baseYaw + yaw, pitch, roll, TMP_Q);
    TMP_P.set(0, pivotY, pivotZ);
    TMP_P.rotateByQuaternionToRef(TMP_Q, TMP_RP);
    const lie = LIE_OFFSET[this.variant] * tipK;
    r.root.position.set(
      this.baseX + (TMP_P.x - TMP_RP.x),
      this.baseY - sink + (TMP_P.y - TMP_RP.y) + lie,
      this.baseZ + (TMP_P.z - TMP_RP.z)
    );

    // ---- upper body: the hit, the gasp, the reach, the settle
    let torsoX: number;
    let headX: number;
    let headZ = 0;
    let armX: number; // shared arm swing (via gunArm): + = down/forward, - = up
    let armL = 0;
    let armR = 0;
    let flopL = 0;
    let flopR = 0;
    let foreL = 0;
    let foreR = 0;
    const settled = down ? Math.min(1, bt / 0.9) : 0;

    if (this.variant === "back") {
      torsoX = t < 0.25 ? 0.42 : down ? -0.1 : -0.42;
      headX = t < 0.22 ? 0.4 : down ? -0.2 : -0.85;
      headZ = down ? this.sideTilt * 1.6 : 0;
      armX = t < 0.75 ? -0.7 : down ? -0.3 : -1.5; // clutch, then reach skyward, then flop
      flopL = down ? 1.0 : 0.12;
      flopR = down ? 0.7 : 0.12;
      foreL = down ? 0.2 : -0.9;
      foreR = down ? 0.35 : -1.1;
    } else if (this.variant === "forward") {
      torsoX = t < 0.2 ? 0.55 : t < tl.tipStart ? 0.35 : 0.15;
      headX = t < 0.2 ? 0.5 : t < tl.tipStart ? 0.2 : 0.35;
      headZ = down ? this.sideTilt * 1.4 : 0;
      armX = t < tl.tipStart ? -0.15 : -0.9; // hands at the belly, then thrown ahead
      armL = t < tl.tipStart ? 0.35 : 0;
      armR = t < tl.tipStart ? 0.15 : 0;
      flopL = down ? 0.9 : 0.3;
      flopR = down ? 0.75 : 0.25;
      foreL = t < tl.tipStart ? -1.3 : down ? -0.25 : -0.5;
      foreR = t < tl.tipStart ? -1.5 : down ? -0.3 : -0.4;
    } else {
      torsoX = t < 0.2 ? 0.35 : -0.15;
      headX = t < 0.2 ? 0.3 : -0.35;
      headZ = down ? this.sideTilt * 1.2 : -Math.sign(this.sideTilt) * 0.4 * tipK;
      armX = t < 0.7 ? -0.4 : -1.2;
      flopL = down ? 0.6 : 0.4;
      flopR = down ? 0.9 : 0.15;
      foreL = down ? 0.1 : -0.7;
      foreR = down ? 0.35 : -0.9;
    }

    const fast = t < 0.3 ? 13 : 5;
    r.torso.rotation.x = app(r.torso.rotation.x, torsoX, fast, dt);
    r.head.rotation.x = app(r.head.rotation.x, headX, t < 0.3 ? 12 : 4.5, dt);
    r.head.rotation.z = app(r.head.rotation.z, headZ, 3.5, dt);
    r.gunArm.rotation.x = app(r.gunArm.rotation.x, armX, t < 1.6 ? 7 : 4, dt);
    r.gunArm.rotation.z = app(r.gunArm.rotation.z, this.sideTilt * 0.4, 4, dt);
    r.armL.rotation.x = app(r.armL.rotation.x, armL, 6, dt);
    r.armR.rotation.x = app(r.armR.rotation.x, armR, 6, dt);
    r.armL.rotation.z = app(r.armL.rotation.z, flopL, down ? 3 : 6, dt);
    r.armR.rotation.z = app(r.armR.rotation.z, flopR, down ? 3 : 6, dt);
    r.foreL.rotation.x = app(r.foreL.rotation.x, foreL, 7, dt);
    r.foreR.rotation.x = app(r.foreR.rotation.x, foreR, 7, dt);

    // the last twitch: a small dying tremor in the torso that fades out
    if (down && settled < 1) {
      r.torso.rotation.x += Math.sin(bt * 22) * 0.04 * (1 - settled);
    }

    // The dropped rifle falls free and clatters to rest
    if (this.gunDropped && !this.gunLanded) {
      this.gunVel.y += GRAVITY * dt;
      r.gun.position.addInPlace(this.gunVel.scale(dt));
      r.gun.rotate(Vector3.Right(), this.gunSpin * dt);
      if (r.gun.position.y <= 0.06) {
        r.gun.position.y = 0.06;
        this.gunLanded = true;
      }
    }
  }

  // The rifle slips out of the hands: detach at the current world transform
  // and let it tumble under gravity
  private dropGun(): void {
    const r = this.rig;
    r.gun.setParent(null); // preserves world position/rotation
    this.gunDropped = true;
    this.gunVel.set((Math.random() * 2 - 1) * 0.4, 0.4, (Math.random() * 2 - 1) * 0.4);
    this.gunSpin = 2.5 + Math.random() * 3;
  }

  // Back to the living pose — called from the owner's respawn path
  public reset(): void {
    const r = this.rig;
    if (this.active) {
      r.root.position.set(this.baseX, this.baseY, this.baseZ);
      r.root.rotation.set(0, this.baseYaw, 0);
    }
    this.active = false;
    this.t = 0;
    this.cues = [];
    r.torso.rotation.set(0, 0, 0);
    r.torso.position.y = 0;
    r.head.rotation.set(0, 0, 0);
    r.gunArm.rotation.set(0.5, 0, 0); // the lowered patrol carry; owners retake it
    r.armL.rotation.set(0, 0, 0);
    r.armR.rotation.set(0, 0, 0);
    r.foreL.rotation.set(0, 0, 0);
    r.foreR.rotation.set(0, 0, 0);
    r.hipL.rotation.set(0, 0, 0);
    r.hipR.rotation.set(0, 0, 0);
    r.kneeL.rotation.set(0, 0, 0);
    r.kneeR.rotation.set(0, 0, 0);
    r.root.rotation.x = 0;
    r.root.rotation.z = 0;
    // hands take the rifle back
    r.gun.rotationQuaternion = null;
    r.gun.parent = r.gunArm;
    r.gun.position.copyFrom(r.gunHomePos);
    r.gun.rotation.set(0, 0, 0);
    r.faceMesh.material = r.faceMat;
    this.gunDropped = false;
    this.gunLanded = false;
    r.body.endDeath(); // clips restart; the proxies go quiet again
  }
}
