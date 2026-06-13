import { Vector3 } from "@babylonjs/core";
import type { FreeCamera, Scene } from "@babylonjs/core";
import { buildSoldier, playerMaterials } from "../bots/SoldierBody";
import type { SoldierRig } from "../bots/SoldierBody";
import { DeathPerformance } from "../anim/DeathPerformance";
import { BotNav } from "../bots/BotNav";
import type { PlayerController } from "./PlayerController";
import type { Effects } from "../rendering/Effects";

// When the player dies the camera leaves their eyes: it pulls up, back and
// around to the front while a third-person body — same anatomy as the bots,
// wearing the player's tan fatigues, beanie and bare tattooed arms — plays
// the full stage death where they stood: heart clutched, last gasp, the
// backwards fall, eyes closing on the way down. PlayerController freezes all
// camera writes while dead, so this owns the camera completely until respawn.
export class DeathCam {
  private static readonly SWING_TIME = 1.3; // camera travel to the front-row seat

  private rig: SoldierRig;
  private death: DeathPerformance;
  private active = false;
  private t = 0;

  private startPos = new Vector3();
  private startRot = new Vector3();
  private endPos = new Vector3();
  private tmpDir = new Vector3();
  private tmpPoint = new Vector3();
  private tmpNormal = new Vector3();
  private tmpTarget = new Vector3();

  constructor(scene: Scene) {
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
    this.death.begin({
      onGasp: () => effects.playPlayerDeathSound(),
      onImpact: () => effects.playBodyFallSound(1),
    });

    // Camera: from the eyes to a front-row seat. The body falls backwards
    // AWAY from this point, so the swing never passes through the actor and
    // the face — and the eyes closing — stay in frame.
    this.startPos.copyFrom(camera.position);
    this.startRot.copyFrom(camera.rotation);
    const facingX = Math.sin(player.yaw);
    const facingZ = Math.cos(player.yaw);
    const rightX = Math.cos(player.yaw);
    const rightZ = -Math.sin(player.yaw);
    // High and forward — a crane shot looking down over the map's tall grass,
    // not a knee-level view buried in it
    this.endPos.set(
      player.position.x + facingX * 3.5 + rightX * 1.1,
      player.position.y + 2.45,
      player.position.z + facingZ * 3.5 + rightZ * 1.1
    );

    // Don't put the seat inside a container wall: cast chest -> seat through
    // the same collision world the bullets use and pull in short of any hit
    const chestX = player.position.x;
    const chestY = player.position.y + 1.0;
    const chestZ = player.position.z;
    this.tmpDir.set(this.endPos.x - chestX, this.endPos.y - chestY, this.endPos.z - chestZ);
    const dist = this.tmpDir.length();
    if (dist > 0.001) {
      this.tmpDir.scaleInPlace(1 / dist);
      const hit = BotNav.rayHitWorld(
        new Vector3(chestX, chestY, chestZ),
        this.tmpDir,
        dist + 0.4,
        this.tmpPoint,
        this.tmpNormal
      );
      if (hit < dist + 0.35) {
        const pulled = Math.max(0.9, hit - 0.45);
        this.endPos.set(chestX + this.tmpDir.x * pulled, chestY + this.tmpDir.y * pulled, chestZ + this.tmpDir.z * pulled);
      }
    }
    if (this.endPos.y < 0.5) this.endPos.y = 0.5;
  }

  public update(dt: number, camera: FreeCamera): void {
    if (!this.active) return;
    this.t += dt;
    this.rig.body.update(dt, 0); // corpse never walks; keeps blend state sane
    this.death.update(dt);

    // Ease out to the seat, then keep drifting up a touch — a slow crane
    const k = Math.min(1, this.t / DeathCam.SWING_TIME);
    const s = k * k * (3 - 2 * k);
    const drift = Math.max(0, this.t - DeathCam.SWING_TIME) * 0.22;
    camera.position.set(
      this.startPos.x + (this.endPos.x - this.startPos.x) * s,
      this.startPos.y + (this.endPos.y - this.startPos.y) * s + Math.min(0.5, drift),
      this.startPos.z + (this.endPos.z - this.startPos.z) * s
    );

    // Track the actor's head through the whole fall
    this.rig.head.computeWorldMatrix(true);
    this.tmpTarget.copyFrom(this.rig.head.getAbsolutePosition());
    this.tmpTarget.y += 0.08;
    const dx = this.tmpTarget.x - camera.position.x;
    const dy = this.tmpTarget.y - camera.position.y;
    const dz = this.tmpTarget.z - camera.position.z;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const lookYaw = Math.atan2(dx, dz);
    const lookPitch = -Math.atan2(dy, Math.max(horiz, 0.001));
    // blend the look in with the same ease so the cut from first person is soft
    camera.rotation.x = this.startRot.x + (lookPitch - this.startRot.x) * s;
    camera.rotation.y = this.startRot.y + DeathCam.angDelta(this.startRot.y, lookYaw) * s;
    camera.rotation.z = 0;
  }

  // Curtain: hide the actor and hand the camera back to the living player
  public end(): void {
    if (!this.active) return;
    this.active = false;
    this.rig.root.setEnabled(false);
  }

  private static angDelta(from: number, to: number): number {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
}
