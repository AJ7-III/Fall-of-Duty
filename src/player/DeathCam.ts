import { Vector3 } from "@babylonjs/core";
import type { FreeCamera, Scene } from "@babylonjs/core";
import { buildSoldier, playerMaterials } from "../bots/SoldierBody";
import type { SoldierRig } from "../bots/SoldierBody";
import { DeathPerformance } from "../anim/DeathPerformance";
import { BotNav } from "../bots/BotNav";
import type { PlayerController } from "./PlayerController";
import type { Effects } from "../rendering/Effects";

// When the player dies the camera leaves their eyes: time slows, a
// third-person body — the same soldier as the first-person arms, in the
// player's tan kit — collapses where they stood, and the camera swings out
// to a seat that can actually see it: low, close, and never inside a wall.
// PlayerController freezes all camera writes while dead, so this owns the
// camera completely until respawn hands control back.
export class DeathCam {
  private static readonly SWING_TIME = 1.1; // game seconds from the eyes to the seat
  private static readonly SLOW_SCALE = 0.5; // time scale through the fall
  private static readonly ORBIT_RATE = 0.16; // rad/s drift around the body once seated

  // Candidate seats around the body, as (yaw offset from the facing, distance,
  // height). The body falls along its facing axis, so the first choices look
  // in from the front quarter where the face and the collapse both read.
  private static readonly SEATS: ReadonlyArray<[number, number, number]> = [
    [0.6, 2.4, 1.25],
    [-0.6, 2.4, 1.25],
    [1.35, 2.3, 1.2],
    [-1.35, 2.3, 1.2],
    [0.15, 2.7, 1.5],
    [2.4, 2.4, 1.3],
    [-2.4, 2.4, 1.3],
    [Math.PI, 2.6, 1.45],
  ];
  private static readonly WALL_MARGIN = 0.45; // keep the lens this far off any wall

  private rig: SoldierRig;
  private death: DeathPerformance;
  private active = false;
  private t = 0;

  private startPos = new Vector3();
  private startRot = new Vector3();
  private seatYaw = 0;
  private seatDist = 2.4;
  private seatHeight = 1.25;
  private liveDist = 2.4; // seat distance after this frame's wall clamp (smoothed)
  private bodyPos = new Vector3();
  private seatPos = new Vector3();
  private tmpDir = new Vector3();
  private tmpPoint = new Vector3();
  private tmpNormal = new Vector3();
  private tmpTarget = new Vector3();

  private setTimeScale: (s: number) => void;

  constructor(scene: Scene, setTimeScale: (s: number) => void) {
    this.setTimeScale = setTimeScale;
    this.rig = buildSoldier(scene, "playerCorpse", {
      mats: playerMaterials(scene),
      headgear: "beanie",
      scarf: false,
      sniper: false,
    });
    for (const part of this.rig.parts) part.mesh.isPickable = false; // scenery, not a target
    this.rig.blobShadow.setEnabled(false);
    this.rig.root.setEnabled(false);
    this.death = new DeathPerformance(this.rig);
  }

  public get running(): boolean {
    return this.active;
  }

  public begin(player: PlayerController, camera: FreeCamera, effects: Effects): void {
    this.active = true;
    this.t = 0;

    // Stand the actor where the player died, facing where they were looking
    this.death.reset();
    this.rig.root.setEnabled(true);
    this.rig.root.position.set(player.position.x, player.position.y, player.position.z);
    this.rig.root.rotation.set(0, player.yaw, 0);
    this.bodyPos.copyFrom(player.position);
    this.death.begin({
      onGasp: () => effects.playPlayerDeathSound(),
      onImpact: () => effects.playBodyFallSound(1),
    });
    this.setTimeScale(DeathCam.SLOW_SCALE);

    this.startPos.copyFrom(camera.position);
    this.startRot.copyFrom(camera.rotation);
    this.pickSeat(player.yaw);
  }

  // First seat with a clear line from the chest wins; if the yard boxes
  // every one of them in, take the least obstructed and pull in short of
  // the wall. Never lower than knee height.
  private pickSeat(facing: number): void {
    const chestY = this.bodyPos.y + 1.0;
    let best: [number, number, number] | null = null;
    let bestClear = -1;
    for (const seat of DeathCam.SEATS) {
      const clear = this.clearDistance(facing + seat[0], seat[1], seat[2], chestY);
      if (clear >= seat[1] + DeathCam.WALL_MARGIN) {
        best = seat;
        bestClear = clear;
        break;
      }
      if (clear > bestClear) {
        best = seat;
        bestClear = clear;
      }
    }
    const seat = best ?? DeathCam.SEATS[0];
    this.seatYaw = facing + seat[0];
    this.seatDist = Math.max(0.9, Math.min(seat[1], bestClear - DeathCam.WALL_MARGIN));
    this.seatHeight = Math.max(0.5, seat[2] * (this.seatDist / seat[1]));
    this.liveDist = this.seatDist;
  }

  // How far the chest -> seat ray travels before world geometry stops it
  private clearDistance(yaw: number, dist: number, height: number, chestY: number): number {
    this.seatFor(yaw, dist, height, this.seatPos);
    this.tmpDir.set(this.seatPos.x - this.bodyPos.x, this.seatPos.y - chestY, this.seatPos.z - this.bodyPos.z);
    const len = this.tmpDir.length();
    if (len < 0.001) return 0;
    this.tmpDir.scaleInPlace(1 / len);
    this.tmpTarget.set(this.bodyPos.x, chestY, this.bodyPos.z);
    const hit = BotNav.rayHitWorld(this.tmpTarget, this.tmpDir, len + 0.4, this.tmpPoint, this.tmpNormal);
    return Math.min(hit, len + 0.4);
  }

  private seatFor(yaw: number, dist: number, height: number, out: Vector3): Vector3 {
    out.set(this.bodyPos.x + Math.sin(yaw) * dist, this.bodyPos.y + height, this.bodyPos.z + Math.cos(yaw) * dist);
    return out;
  }

  public update(dt: number, camera: FreeCamera): void {
    if (!this.active) return;
    this.t += dt;
    this.rig.body.update(dt, 0); // corpse never walks; keeps blend state sane
    this.death.update(dt);

    // Time: slow through the collapse, back to speed once the body is down
    const impact = 1.35;
    const scale =
      this.t < impact
        ? DeathCam.SLOW_SCALE
        : DeathCam.SLOW_SCALE + (1 - DeathCam.SLOW_SCALE) * Math.min(1, (this.t - impact) / 0.5);
    this.setTimeScale(scale);

    // Seat: ease out from the eyes, then keep drifting around the body and
    // easing in — a slow handheld orbit, never a locked-off tripod
    const k = Math.min(1, this.t / DeathCam.SWING_TIME);
    const s = k * k * (3 - 2 * k);
    const drift = Math.max(0, this.t - DeathCam.SWING_TIME);
    const yaw = this.seatYaw + drift * DeathCam.ORBIT_RATE;
    const wantDist = this.seatDist - Math.min(0.5, drift * 0.12);
    const height = Math.max(0.6, this.seatHeight - Math.min(0.35, drift * 0.1));
    // the orbit must not carry the lens into a wall: re-probe every frame
    // and ease the distance in behind whatever the ray finds
    const clear = this.clearDistance(yaw, wantDist, height, this.bodyPos.y + 1.0);
    const allowed = Math.max(0.8, Math.min(wantDist, clear - DeathCam.WALL_MARGIN));
    this.liveDist += (allowed - this.liveDist) * (1 - Math.exp(-8 * dt));
    if (allowed < this.liveDist) this.liveDist = allowed; // never lag INTO the wall
    this.seatFor(yaw, this.liveDist, height, this.seatPos);
    // handheld: a breath of sway once seated
    this.seatPos.x += Math.sin(this.t * 1.7) * 0.02 * s;
    this.seatPos.y += Math.sin(this.t * 1.1) * 0.015 * s;

    camera.position.set(
      this.startPos.x + (this.seatPos.x - this.startPos.x) * s,
      this.startPos.y + (this.seatPos.y - this.startPos.y) * s,
      this.startPos.z + (this.seatPos.z - this.startPos.z) * s
    );

    // Track the actor: the head while it stands, settling on the chest as
    // it goes down so the whole body stays framed
    this.rig.head.computeWorldMatrix(true);
    this.tmpTarget.copyFrom(this.rig.head.getAbsolutePosition());
    const chestBlend = Math.min(1, Math.max(0, (this.t - 0.6) / 0.9));
    this.tmpTarget.y = this.tmpTarget.y * (1 - chestBlend) + (this.bodyPos.y + 0.45) * chestBlend;
    const dx = this.tmpTarget.x - camera.position.x;
    const dy = this.tmpTarget.y - camera.position.y;
    const dz = this.tmpTarget.z - camera.position.z;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const lookYaw = Math.atan2(dx, dz);
    const lookPitch = -Math.atan2(dy, Math.max(horiz, 0.001));
    // the look finds the body well before the dolly finishes, so the actor
    // is framed through the swing instead of sliding in from the edge
    const kl = Math.min(1, this.t / 0.45);
    const sl = kl * kl * (3 - 2 * kl);
    camera.rotation.x = this.startRot.x + (lookPitch - this.startRot.x) * sl;
    camera.rotation.y = this.startRot.y + DeathCam.angDelta(this.startRot.y, lookYaw) * sl;
    camera.rotation.z = 0;
  }

  // Curtain: hide the actor and hand the camera back to the living player
  public end(): void {
    if (!this.active) return;
    this.active = false;
    this.setTimeScale(1);
    this.rig.root.setEnabled(false);
  }

  private static angDelta(from: number, to: number): number {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
}
