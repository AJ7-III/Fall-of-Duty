import { Vector3 } from "@babylonjs/core";
import type { SoldierRig } from "../bots/SoldierBody";

// The theatrical death the brief asked for: an actor at a play. The hit
// lands and the soldier hunches; his rifle slips from his hands; he clutches
// his heart, arches back gasping at the sky; his knees buckle and he topples
// backwards off his feet, arms reaching upward in one last grasp — eyes
// closing just before he hits the ground, bounces once, and is still.
//
// Pure procedural choreography over a SoldierRig's pivots, eased from
// whatever pose the walk cycle left so there is never a snap at the moment
// of death. The owner (a Bot, or the player's death-cam corpse) calls
// update(dt) while dead and reset() on respawn. Timed cues fire sound/face
// hooks exactly once per performance.

export interface DeathCues {
  onGasp?: () => void; // the last breath, as the arch begins
  onEyesClose?: () => void; // face swap moment (handled here) — extra hook
  onImpact?: () => void; // body meets the ground
}

const FALL_START = 0.62; // when the topple begins
const FALL_TIME = 0.9; // feet-to-flat duration
const IMPACT_AT = FALL_START + FALL_TIME;
const GRAVITY = -15.0;

interface Cue {
  at: number;
  fn: () => void;
  fired: boolean;
}

export class DeathPerformance {
  private rig: SoldierRig;
  private t = 0;
  private cues: Cue[] = [];
  private active = false;

  // every death is staged slightly differently
  private sideTilt = 0;

  // rifle free-fall once it leaves the hands
  private gunDropped = false;
  private gunLanded = false;
  private gunVel = new Vector3();
  private gunSpin = 0;

  constructor(rig: SoldierRig) {
    this.rig = rig;
  }

  public begin(cues: DeathCues = {}): void {
    // hand the skeleton over: clips stop, the proxy choreography takes it
    this.rig.body.beginDeath();
    this.active = true;
    this.t = 0;
    this.sideTilt = (Math.random() * 2 - 1) * 0.3;
    this.gunDropped = false;
    this.gunLanded = false;
    this.cues = [
      { at: 0.2, fired: false, fn: () => this.dropGun() },
      { at: 0.3, fired: false, fn: () => cues.onGasp?.() },
      {
        at: IMPACT_AT - 0.12, // lids fall as the ground rushes up
        fired: false,
        fn: () => {
          this.rig.faceMesh.material = this.rig.faceShutMat;
          cues.onEyesClose?.();
        },
      },
      { at: IMPACT_AT, fired: false, fn: () => cues.onImpact?.() },
    ];
  }

  public get running(): boolean {
    return this.active;
  }

  // exponential approach — frame-rate independent ease toward a pose
  private static app(cur: number, target: number, rate: number, dt: number): number {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }

  public update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    const r = this.rig;
    const app = DeathPerformance.app;

    for (const cue of this.cues) {
      if (!cue.fired && t >= cue.at) {
        cue.fired = true;
        cue.fn();
      }
    }

    // Arms: fly to the chest clutching the heart, then stretch skyward in
    // the falling grasp, then drop limp across the body once it's down
    const armX = t < 0.85 ? -0.62 : t < IMPACT_AT ? -1.45 : -1.05;
    r.gunArm.rotation.x = app(r.gunArm.rotation.x, armX, t < 1.6 ? 7 : 4, dt);
    r.gunArm.rotation.z = app(r.gunArm.rotation.z, this.sideTilt * 0.5, 4, dt);

    // Torso: a hunch on impact, the long arching gasp, then settling flat
    const torsoX = t < 0.28 ? 0.3 : t < IMPACT_AT ? -0.38 : -0.12;
    r.torso.rotation.x = app(r.torso.rotation.x, torsoX, t < 0.3 ? 13 : 5, dt);

    // Head: snaps forward with the hit, tips back gasping at the sky,
    // lolls to one side at rest
    const headX = t < 0.25 ? 0.35 : t < IMPACT_AT ? -0.8 : -0.25;
    r.head.rotation.x = app(r.head.rotation.x, headX, t < 0.3 ? 12 : 4.5, dt);
    r.head.rotation.z = app(r.head.rotation.z, t > IMPACT_AT ? this.sideTilt * 0.9 : 0, 3.5, dt);

    // Knees buckle — the legs stop carrying him; asymmetric so the collapse
    // reads as a body giving out, not a hinge closing
    const buckle = t > 0.5 ? 1 : 0;
    r.kneeL.rotation.x = app(r.kneeL.rotation.x, -1.15 * buckle, 6, dt);
    r.kneeR.rotation.x = app(r.kneeR.rotation.x, -0.85 * buckle, 6, dt);
    r.hipL.rotation.x = app(r.hipL.rotation.x, 0.5 * buckle, 5, dt);
    r.hipR.rotation.x = app(r.hipR.rotation.x, 0.32 * buckle, 5, dt);

    // The backwards topple, pivoting at the feet: accelerates like a felled
    // tree, with one small rebound when the back meets the ground
    if (t > FALL_START) {
      const ft = Math.min(1, (t - FALL_START) / FALL_TIME);
      const eased = ft * ft * (1.6 - 0.6 * ft);
      let rot = -eased * (Math.PI / 2 - 0.07);
      if (ft >= 1) {
        const bt = t - IMPACT_AT;
        rot -= Math.exp(-6 * bt) * Math.sin(bt * 18) * 0.05;
      }
      r.root.rotation.x = rot;
      r.root.rotation.z = app(r.root.rotation.z, this.sideTilt * 0.4, 3, dt);
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

  // The rifle slips out of his hands: detach at the current world transform
  // and let it tumble under gravity
  private dropGun(): void {
    const r = this.rig;
    r.gun.setParent(null); // preserves world position/rotation
    this.gunDropped = true;
    this.gunVel.set(
      (Math.random() * 2 - 1) * 0.4,
      0.4,
      (Math.random() * 2 - 1) * 0.4
    );
    this.gunSpin = 2.5 + Math.random() * 3;
  }

  // Back to the living pose — called from the owner's respawn path
  public reset(): void {
    this.active = false;
    this.t = 0;
    this.cues = [];
    const r = this.rig;
    r.torso.rotation.set(0, 0, 0);
    r.torso.position.y = 0;
    r.head.rotation.set(0, 0, 0);
    r.gunArm.rotation.set(0.5, 0, 0); // the lowered patrol carry; owners retake it
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
