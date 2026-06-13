import { Mesh, TransformNode, Vector3 } from "@babylonjs/core";
import type { AbstractMesh, Material, Nullable, Scene, StandardMaterial } from "@babylonjs/core";
import { PlayerController } from "../player/PlayerController";
import { BotNav } from "./BotNav";
import { BOT_WEAPONS, rangeCurve, rand, DEG } from "./BotConfig";
import type { BotDifficulty, BotWeaponProfile } from "./BotConfig";
import { buildSoldier, botMaterials, terminatorMaterial } from "./SoldierBody";
import type { SoldierRig } from "./SoldierBody";
import { DeathPerformance } from "../anim/DeathPerformance";
import type { Effects } from "../rendering/Effects";
import { MatchEvents } from "../ui/MatchEvents";

// One enemy soldier: a procedural body the player's hitscan can hit, a
// perception model feeding a blackboard, a behavior tree choosing what to do,
// utility scoring choosing where and with what, and a virtual controller
// that moves through PlayerController.moveAndCollide — the bot plays by the
// player's movement rules and shoots through the same occlusion world.
//
// Behavior tree (priority selector, ticked at ~8Hz):
//   Dead
//   SelfPreserve   retreat when shot up; break sight to reload; quickswap
//   Combat         choose weapon (utility) -> attack position (utility)
//                  -> smoothed aim with re-rolled error -> burst fire
//   Search         move to last-known position, sweep, give up
//   Patrol         wander the yard, gun lowered
//
// The aim is deliberately human: a reaction delay on contact, an angular
// error re-rolled each burst that settles while tracking, per-shot spread
// that worsens on the move, and recoil that walks long bursts off target.

export interface BotContext {
  dt: number;
  now: number;
  player: PlayerController;
  effects: Effects;
  playerFired: boolean;
}

type BotMode = "dead" | "reload" | "retreat" | "combat" | "search" | "hunt" | "patrol";

const EYE_HEIGHT = 1.62;
const BODY_HEIGHT = 1.85;
const BODY_RADIUS = 0.4;
const THINK_INTERVAL = 0.12;
const MAX_SHOT_RANGE = 60;
// The height the combat model fires from: hasLineOfFire rays, the aim-sample
// re-pick, and the pitch solution all assume the muzzle sits on this line.
// The rig must agree — SHOULDER_RAISE lifts the gunArm while engaged so the
// real muzzle (rig muzzle node, chest-mount height when level) comes up to
// it; otherwise rounds spawn ~0.4m below the model and eat the cover lip
// the model said was clear.
const MUZZLE_HEIGHT = EYE_HEIGHT * 0.88;
const SHOULDER_RAISE = 0.27;

// Silhouette samples for sight and aim. A single eye-to-eye ray meant a car
// hood clipping that one line made the player fully invisible; sampling the
// body turns "visible" into a fraction that sightMinExposure can threshold.
// h is a fraction of the player's CURRENT eye height (crouching shrinks the
// silhouette for free); lat is meters across the bot's sight line, kept
// inside the 0.42 body cylinder so shots aimed there can land. aimRank picks
// which visible point to shoot: chest first, shins as a last resort.
const SIGHT_SAMPLES: ReadonlyArray<{ h: number; lat: number; aimRank: number }> = [
  { h: 1.0, lat: 0, aimRank: 3 }, // head
  { h: 0.8, lat: 0, aimRank: 0 }, // chest (the old aim point)
  { h: 0.74, lat: -0.3, aimRank: 1 }, // shoulders — catch a sideways peek
  { h: 0.74, lat: 0.3, aimRank: 2 },
  { h: 0.45, lat: 0, aimRank: 4 }, // pelvis
  { h: 0.14, lat: 0, aimRank: 5 }, // shins showing under a car
];

export class Bot {
  public position: Vector3;
  public yaw = 0;
  public health = 100;
  public dead = false;
  public radarTimer = 0; // minimap blip lingers ~2s after firing (COD radar rule)
  public killCounted = false; // BotManager scoreboard bookkeeping
  public lastHitZone = 1; // zoneMult of the most recent hit — headshot kill detection
  public lastDamageCause: "player" | "airstrike" | "apache" = "player"; // kill feed attribution
  public respawnTimer = 0;

  // Blackboard — the bot's working memory: perception writes, the tree reads
  public bb = {
    canSeePlayer: false,
    lastKnownValid: false,
    distanceToPlayer: Infinity,
    hasLineOfFire: false,
    threatLevel: 0,
    timeSinceSeen: Infinity,
    detection: 0, // 0..1 sight meter — distance, stance and sprint feed it
    mode: "patrol" as BotMode,
  };
  private lastKnown = new Vector3();
  private lastKnownVel = new Vector3(); // player velocity at last contact — search leads the run
  private seenAt = -Infinity;
  private intelAt = -Infinity; // most recent intel of ANY kind (sight, sound, pain)
  private freshIntel = false; // new intel since the last think — restart the hunt now
  private pendingAlert = false; // set by takeDamage; resolved next perceive
  private hurtFlash = 0;

  // Virtual weapons (bots carry the data, not the player's Weapon machinery)
  private weapons: Array<{ profile: BotWeaponProfile; clip: number }>;
  private weaponIndex = 0;
  private reloadTimer = 0;
  private switchTimer = 0;
  private weaponEvalAt = 0;

  // Aim model
  private aimYaw = 0;
  private aimPitch = 0;
  private desiredYaw = 0;
  private desiredPitch = 0;
  private errYaw = 0; // re-rolled per burst, decays at aimSettleSpeed
  private errPitch = 0;
  private reactionTimer = 0;
  private burstLeft = 0;
  private burstTimer = 0;
  private fireTimer = 0;
  private aimSample = 1; // SIGHT_SAMPLES index combat shoots at — best-ranked visible point

  // Movement / navigation
  private velocity = new Vector3();
  private path: number[] = [];
  private pathIndex = 0;
  private destNode = -1;
  private reachedDest = false;
  private previousDestNode = -1; // recent target memory; discourages instant backtracking
  private recentDestNodes = new Int32Array(7).fill(-1);
  private recentDestCursor = 0;
  private recentDestCount = 0;
  private wantSprint = false;
  private moveSpeed = 0; // actual horizontal speed, for animation + shot spread
  private holdUntil = 0; // combat: route freshness deadline, not a stand-still hold
  private retreatUntil = 0;
  private patrolNextAt = 0;
  private lastPatrolNode = -1; // don't immediately re-walk the leg just finished
  private scanUntil = 0; // search: look-around sweep at the last-known spot
  private scanBaseYaw = 0;
  private searchStopsLeft = 0; // expanding search: nearby pockets to sweep before giving up
  private flankRoll = false;
  private evalPlayerX = 0; // player position at the last attack-node pick
  private evalPlayerZ = 0;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private lastMoveDirX = 0;
  private lastMoveDirZ = 0;
  private suspicion = new Vector3(); // noisy no-contact guess of where the player probably is
  private suspicionVel = new Vector3();
  private suspicionValid = false;
  private suspicionAt = -Infinity;
  private nextSuspicionAt = 0;
  private thinkAccum: number;
  private lastNow = 0; // stamped each update; lets reset() schedule relative to game time
  private idleYawBase = 0; // facing when the feet stopped — idle scan pivots here
  private idleStopAt = 0;
  private wasMoving = false;

  // Body (shared SoldierBody rig + the theatrical death that drives it)
  private rig: SoldierRig;
  private root: TransformNode;
  private torsoGroup: TransformNode; // bobs with footfalls, leans at a sprint
  private gunArm: TransformNode;
  private muzzle: TransformNode;
  private hipL: TransformNode;
  private hipR: TransformNode;
  private kneeL: TransformNode;
  private kneeR: TransformNode;
  private blobShadow: Mesh;
  private hitParts: Mesh[] = [];
  private death: DeathPerformance;
  private fx: Effects | null = null; // stashed each update for the death cue sounds
  private walkPhase = 0;
  private walkAmp = 0;
  private gunPitch = 0.5;
  private shoulderBlend = 0; // 0 = patrol carry, 1 = stock at the shoulder

  // Terminator skin bookkeeping: the cloth each mesh wore before the chrome
  public isTerminator = false;
  private savedMats = new Map<AbstractMesh, Nullable<Material>>();
  private savedFaceMats: [StandardMaterial, StandardMaterial] | null = null;

  private difficulty: BotDifficulty;

  // Shared scratch (single-threaded update — no per-frame allocations)
  private static readonly TMP_A = new Vector3();
  private static readonly TMP_B = new Vector3();
  private static readonly TMP_DIR = new Vector3();
  private static readonly TMP_POINT = new Vector3();
  private static readonly TMP_NORMAL = new Vector3();
  private tmpPrev = new Vector3();
  private tmpNext = new Vector3();

  constructor(scene: Scene, difficulty: BotDifficulty, primary: BotWeaponProfile, x: number, z: number, index: number) {
    this.difficulty = difficulty;
    this.weapons = [
      { profile: primary, clip: primary.magSize },
      { profile: BOT_WEAPONS.usp45, clip: BOT_WEAPONS.usp45.magSize },
    ];
    this.position = new Vector3(x, 0, z);
    this.thinkAccum = index * 0.04; // stagger the fleet's decision ticks

    // One shared anatomy (SoldierBody) in the OPFOR uniform. Every body part
    // gets { type:"bot", instance, zoneMult } metadata so the player's shared
    // hitscan resolves zone damage with zero extra code, and the rig's pivots
    // hand straight to the theatrical DeathPerformance when this one falls.
    const rig = buildSoldier(scene, `bot${index}`, {
      mats: botMaterials(scene),
      headgear: "wrap",
      scarf: true,
      sniper: primary.id === "m40a3",
    });
    this.rig = rig;
    this.root = rig.root;
    this.root.position = this.position; // root shares the vector — one write
    this.torsoGroup = rig.torso;
    this.gunArm = rig.gunArm;
    this.muzzle = rig.muzzle;
    this.hipL = rig.hipL;
    this.hipR = rig.hipR;
    this.kneeL = rig.kneeL;
    this.kneeR = rig.kneeR;
    this.blobShadow = rig.blobShadow;
    for (const part of rig.parts) {
      part.mesh.metadata = { type: "bot", instance: this, zoneMult: part.zone };
      this.hitParts.push(part.mesh);
    }
    this.death = new DeathPerformance(rig);
    // The skinned body lands async: if the chrome skin was applied while the
    // soldier was still headless, re-sweep so the new meshes get it too.
    rig.body.whenReady(() => {
      if (this.isTerminator) {
        this.setTerminator(false);
        this.setTerminator(true);
      }
    });
  }

  // ---------------------------------------------------------- terminator skin

  // Difficulty 9+: the whole body (rifle included) turns liquid-metal chrome;
  // dropping the slider hands every mesh its original cloth back. The rig's
  // face materials are overridden too, so the death performance's eyes-shut
  // swap doesn't paint flesh back onto a chrome face mid-fall.
  public setTerminator(on: boolean): void {
    if (this.isTerminator === on) return;
    this.isTerminator = on;
    if (on) {
      const chrome = terminatorMaterial(this.root.getScene());
      // the gun group detaches from the rig while a corpse's rifle lies on
      // the ground, so sweep it explicitly alongside the body
      const meshes = new Set<AbstractMesh>([
        ...this.root.getChildMeshes(false),
        ...this.rig.gun.getChildMeshes(false),
      ]);
      for (const mesh of meshes) {
        if (mesh === this.blobShadow) continue;
        this.savedMats.set(mesh, mesh.material);
        mesh.material = chrome;
      }
      this.savedFaceMats = [this.rig.faceMat, this.rig.faceShutMat];
      this.rig.faceMat = chrome;
      this.rig.faceShutMat = chrome;
    } else {
      for (const [mesh, mat] of this.savedMats) mesh.material = mat;
      this.savedMats.clear();
      if (this.savedFaceMats) {
        [this.rig.faceMat, this.rig.faceShutMat] = this.savedFaceMats;
        this.savedFaceMats = null;
        this.rig.faceMesh.material = this.dead ? this.rig.faceShutMat : this.rig.faceMat;
      }
    }
  }

  // ------------------------------------------------------------------ damage

  // Returns true when this hit was the kill (drives the red hitmarker).
  // cause: who gets the kill-feed credit — the player's gun, or a streak.
  public takeDamage(amount: number, cause: "player" | "airstrike" | "apache" = "player"): boolean {
    if (this.dead) return false;
    this.health -= amount;
    this.hurtFlash = Math.min(1, this.hurtFlash + 0.6);
    this.pendingAlert = true; // they now know roughly where that came from
    this.lastDamageCause = cause;
    if (cause !== "player") this.lastHitZone = 1; // streak kills are never "headshots"
    if (this.health <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  private die(): void {
    this.dead = true;
    this.health = 0;
    this.bb.mode = "dead";
    this.radarTimer = 0;
    this.burstLeft = 0;
    this.velocity.setAll(0);
    this.blobShadow.setEnabled(false);
    for (const p of this.hitParts) p.isPickable = false; // corpses don't soak rounds
    // The stage death: clutch the heart, gasp, topple backwards, eyes shut.
    // Cue sounds scale with how close the player is standing.
    const vol = (): number => Math.min(1, 1.7 / (1 + this.bb.distanceToPlayer * 0.12));
    this.death.begin({
      onGasp: () => this.fx?.playDeathGaspSound(vol()),
      onImpact: () => this.fx?.playBodyFallSound(vol()),
    });
  }

  public reset(x: number, z: number, yaw: number): void {
    this.death.reset(); // stand the body back up, take the rifle back, open the eyes
    this.position.set(x, 0, z);
    this.velocity.setAll(0);
    this.yaw = yaw;
    this.aimYaw = yaw;
    this.aimPitch = 0;
    // DeathPerformance.reset restores the gunArm rotation but not the
    // shoulder raise — drop the stock back to the patrol carry ourselves
    this.shoulderBlend = 0;
    this.gunArm.position.y = 0;
    this.health = 100 * this.difficulty.healthScale; // Terminator tiers soak more
    this.dead = false;
    this.killCounted = false;
    this.lastHitZone = 1;
    this.lastDamageCause = "player";
    this.root.rotation.set(0, yaw, 0);
    this.blobShadow.setEnabled(true);
    for (const p of this.hitParts) p.isPickable = true;
    for (const w of this.weapons) w.clip = w.profile.magSize;
    this.weaponIndex = 0;
    this.reloadTimer = 0;
    this.switchTimer = 0;
    this.burstLeft = 0;
    this.path.length = 0;
    this.pathIndex = 0;
    this.destNode = -1;
    this.reachedDest = false;
    this.previousDestNode = -1;
    this.recentDestNodes.fill(-1);
    this.recentDestCursor = 0;
    this.recentDestCount = 0;
    this.scanUntil = 0;
    this.searchStopsLeft = 0;
    this.retreatUntil = 0;
    this.reverseTimer = 0;
    this.lastMoveDirX = 0;
    this.lastMoveDirZ = 0;
    this.suspicion.setAll(0);
    this.suspicionVel.setAll(0);
    this.suspicionValid = false;
    this.suspicionAt = -Infinity;
    this.nextSuspicionAt = this.lastNow + rand(0.15, 0.4);
    this.idleYawBase = yaw;
    this.idleStopAt = this.lastNow;
    this.wasMoving = false;
    // Start hunting quickly after spawn; long spawn holds read as indecision.
    this.patrolNextAt = this.lastNow + rand(0.1, 0.35);
    this.weaponEvalAt = this.lastNow + 1;
    const bb = this.bb;
    bb.canSeePlayer = false;
    bb.lastKnownValid = false;
    bb.detection = 0;
    bb.threatLevel = 0;
    bb.timeSinceSeen = Infinity;
    bb.mode = "patrol";
    this.seenAt = -Infinity;
    this.intelAt = -Infinity;
    this.freshIntel = false;
    this.lastKnownVel.setAll(0);
    this.pendingAlert = false;
    this.hurtFlash = 0;
  }

  // A respawn is not a blank slate: this soldier just died to someone, and a
  // person walks back in knowing roughly which part of the yard the threat
  // owns. Seed the blackboard with a deliberately blurred fix (errMeters of
  // slop) so the bot opens with a purposeful hunt toward the action instead
  // of a coin-flip patrol leg — and backdate the intel so the hunt is warm
  // but only sometimes sprint-out-of-the-gate hot. The blur keeps it honest:
  // they know the neighborhood, never the address.
  public spawnIntuition(player: PlayerController, errMeters: number): void {
    this.lastKnown.set(
      player.position.x + rand(-errMeters, errMeters),
      player.position.y,
      player.position.z + rand(-errMeters, errMeters)
    );
    this.lastKnownVel.setAll(0);
    this.bb.lastKnownValid = true;
    this.bb.detection = 0.45; // wary, not locked on
    this.intelAt = this.lastNow - rand(1.5, 7);
    this.suspicion.copyFrom(this.lastKnown);
    this.suspicionVel.copyFrom(this.lastKnownVel);
    this.suspicionValid = true;
    this.suspicionAt = this.intelAt;
    this.nextSuspicionAt = this.lastNow + rand(2.5, 4);
    this.freshIntel = true;
  }

  // ------------------------------------------------------------------ update

  public update(ctx: BotContext): void {
    const dt = ctx.dt;
    this.lastNow = ctx.now;
    this.fx = ctx.effects;
    this.radarTimer = Math.max(0, this.radarTimer - dt);

    if (this.dead) {
      // the death performance plays out, then the body lies there until
      // the manager respawns us
      this.death.update(dt);
      return;
    }

    // Weapon timers (reload completes a full mag — bots carry bottomless reserves)
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        const w = this.weapons[this.weaponIndex];
        w.clip = w.profile.magSize;
      }
    }
    if (this.switchTimer > 0) this.switchTimer -= dt;
    this.fireTimer -= dt;
    this.burstTimer -= dt;

    this.perceive(ctx);

    this.thinkAccum -= dt;
    if (this.thinkAccum <= 0) {
      this.thinkAccum = THINK_INTERVAL;
      this.think(ctx);
    }

    this.updateCombat(ctx, dt);
    this.motor(ctx, dt);
    this.animate(dt);
  }

  // -------------------------------------------------------------- perception

  private perceive(ctx: BotContext): void {
    const bb = this.bb;
    const d = this.difficulty;
    const p = ctx.player;

    // Taking a hit is perfect information about being in a fight, and decent
    // information about where from — and holding still under fire is how
    // bots die, so any held position is forfeited.
    if (this.pendingAlert) {
      this.pendingAlert = false;
      if (!p.isDead) {
        bb.detection = 1;
        this.lastKnown.copyFrom(p.position);
        this.lastKnownVel.copyFrom(p.velocity);
        bb.lastKnownValid = true;
        this.suspicion.copyFrom(this.lastKnown);
        this.suspicionVel.copyFrom(this.lastKnownVel);
        this.suspicionValid = true;
        this.suspicionAt = ctx.now;
        this.nextSuspicionAt = ctx.now + rand(2.5, 4);
        this.intelAt = ctx.now;
        this.freshIntel = true;
        this.holdUntil = 0;
      }
    }

    const dx = p.position.x - this.position.x;
    const dz = p.position.z - this.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    bb.distanceToPlayer = dist;

    // Sight: range + facing cone + occlusion, feeding a detection meter so
    // distant or crouched targets take longer to register (perfect knowledge
    // feels awful). The cone widens once the bot is already on edge.
    // Occlusion samples the whole silhouette: exposure is the fraction of
    // body points with a clear line, and skill (sightMinExposure) decides
    // how much of a man it takes to count as contact.
    let visible = false;
    let exposure = 0;
    if (!p.isDead && dist < d.visionRange && dist > 0.001) {
      const alert = bb.detection > 0.5 || bb.timeSinceSeen < 6;
      const coneCos = Math.cos(alert ? 1.31 : 0.96); // 75 deg / 55 deg half-angle
      const facingDot = (Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dz) / dist;
      if (facingDot > coneCos) {
        Bot.TMP_A.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
        let seenCount = 0;
        let bestRank = Infinity;
        for (let i = 0; i < SIGHT_SAMPLES.length; i++) {
          this.bodySample(p, i, Bot.TMP_B);
          if (BotNav.losBlocked(Bot.TMP_A, Bot.TMP_B)) continue;
          seenCount++;
          if (SIGHT_SAMPLES[i].aimRank < bestRank) {
            bestRank = SIGHT_SAMPLES[i].aimRank;
            this.aimSample = i;
          }
        }
        exposure = seenCount / SIGHT_SAMPLES.length;
        visible = exposure >= d.sightMinExposure;
      }
    }

    if (visible) {
      let fillRate = 1.9 - 1.5 * (dist / d.visionRange);
      if (p.isSprinting) fillRate *= 1.6;
      else if (p.isProne) fillRate *= 0.35;
      else if (p.isCrouching) fillRate *= 0.55;
      // a sliver of a man registers slower than a full silhouette
      fillRate *= 0.45 + 0.55 * exposure;
      // mid-fight re-acquisition is near-instant — the slow burn is for
      // first contact, not for someone peeking the same corner twice
      if (bb.timeSinceSeen < 6) fillRate *= 4;
      bb.detection = Math.min(1, bb.detection + fillRate * ctx.dt);
    } else {
      bb.detection = Math.max(0, bb.detection - 0.5 * ctx.dt);
    }

    const hadContact = bb.canSeePlayer;
    bb.canSeePlayer = visible && bb.detection >= 1;
    if (bb.canSeePlayer) {
      if (!hadContact) {
        // fresh contact: human reaction delay before the first trigger pull,
        // and a deliberately bad opening aim that settles in. Re-contact in
        // an ongoing fight reacts much faster — they were already waiting.
        const recontact = bb.timeSinceSeen < 6 ? 0.35 : 1;
        this.reactionTimer = (d.reactionTimeMs / 1000) * rand(0.8, 1.3) * recontact;
        this.rerollError(recontact === 1 ? 1.5 : 0.8);
      }
      this.lastKnown.copyFrom(p.position);
      this.lastKnownVel.copyFrom(p.velocity);
      bb.lastKnownValid = true;
      this.suspicion.copyFrom(this.lastKnown);
      this.suspicionVel.copyFrom(this.lastKnownVel);
      this.suspicionValid = true;
      this.suspicionAt = ctx.now;
      this.nextSuspicionAt = ctx.now + rand(2.5, 4);
      this.seenAt = ctx.now;
      this.intelAt = ctx.now;
    }
    bb.timeSinceSeen = ctx.now - this.seenAt;

    // Hearing: gunshots carry across the whole yard — the map is small, and
    // a shot fired ANYWHERE should start the hunt. Inside hearingRange the
    // fix is precise; past it the bot only gets the neighborhood, with the
    // positional error growing by distance (skill keeps its meaning: veteran
    // ears pin you, recruit ears send them to the right corner).
    if (ctx.playerFired && !p.isDead) {
      const over = Math.max(0, dist - d.hearingRange);
      const err = Math.min(5, over * 0.25);
      this.lastKnown.set(
        p.position.x + rand(-err, err),
        p.position.y,
        p.position.z + rand(-err, err)
      );
      this.lastKnownVel.copyFrom(p.velocity);
      bb.lastKnownValid = true;
      this.suspicion.copyFrom(this.lastKnown);
      this.suspicionVel.copyFrom(this.lastKnownVel);
      this.suspicionValid = true;
      this.suspicionAt = ctx.now;
      this.nextSuspicionAt = ctx.now + rand(2.5, 4);
      bb.detection = Math.max(bb.detection, over > 0 ? 0.55 : 0.75);
      this.intelAt = ctx.now;
      this.freshIntel = true; // mid-search, this restarts the hunt at the new fix
    }

    this.hurtFlash *= Math.exp(-1.2 * ctx.dt);
    bb.threatLevel = (bb.canSeePlayer ? 1 - dist / d.visionRange : 0) + this.hurtFlash;
  }

  // ----------------------------------------------------- behavior tree (8Hz)

  private think(ctx: BotContext): void {
    const bb = this.bb;
    const d = this.difficulty;

    this.considerWeapon(ctx);
    this.refreshSuspicion(ctx);

    // Priority selector — the first open branch claims the tick
    const prevMode = bb.mode;
    const retreatHP = 38 * (1 - d.aggression * 0.55); // aggressive bots fight hurt
    let mode: BotMode;
    if (this.reloadTimer > 0 && bb.canSeePlayer) mode = "reload";
    else if ((this.health < retreatHP && bb.threatLevel > 0.4) || ctx.now < this.retreatUntil) mode = "retreat";
    else if (bb.canSeePlayer || bb.timeSinceSeen < 6) mode = "combat";
    else if (bb.lastKnownValid) mode = "search";
    else if (!ctx.player.isDead) mode = "hunt";
    else mode = "patrol";
    bb.mode = mode;
    const entered = mode !== prevMode;

    if (mode === "reload" || mode === "retreat") {
      // SelfPreserve: break the sight line, hug cover, come back angry
      if (mode === "retreat" && entered) {
        this.retreatUntil = ctx.now + rand(3.5, 6.5);
        this.destNode = -1;
      }
      if (this.destNode < 0 || (this.reachedDest && !this.coveredHere(ctx))) {
        this.goTo(this.pickHiddenNode(ctx));
      }
      this.wantSprint = true;
    } else if (mode === "combat") {
      const px = bb.canSeePlayer ? ctx.player.position.x : this.lastKnown.x;
      const pz = bb.canSeePlayer ? ctx.player.position.z : this.lastKnown.z;
      const refMovedX = px - this.evalPlayerX;
      const refMovedZ = pz - this.evalPlayerZ;
      const stale =
        this.destNode < 0 ||
        this.reachedDest ||
        refMovedX * refMovedX + refMovedZ * refMovedZ > 3.2 * 3.2 ||
        (ctx.now > this.holdUntil && this.pathIndex >= Math.max(0, this.path.length - 2));
      if (stale) {
        this.flankRoll = Math.random() < d.flankChance;
        this.evalPlayerX = px;
        this.evalPlayerZ = pz;
        const attack = this.pickAttackNode(ctx, px, pz);
        this.goTo(attack >= 0 ? attack : this.pickSearchNode(ctx));
        this.holdUntil = ctx.now + rand(1.0, 1.8);
      }
      // sprint only while out of contact — nobody shoots well at a dead run
      this.wantSprint = !bb.canSeePlayer && d.aggression > 0.25;
    } else if (mode === "search") {
      // The hunt. Path to the last-known fix led by the player's escape
      // direction (chase where they WENT, not where they WERE), and any
      // fresh intel — a gunshot heard, a round taken — drops the current
      // route and re-paths to the new fix immediately.
      if (entered || this.freshIntel) {
        this.scanUntil = 0;
        this.searchStopsLeft = 5;
        this.goTo(this.pickSearchNode(ctx));
      } else if (this.destNode < 0 || this.reachedDest) {
        this.scanUntil = 0;
        if (this.reachedDest && this.searchStopsLeft > 0) this.searchStopsLeft--;
        const coldTrail = ctx.now - this.intelAt > 24 && this.searchStopsLeft <= 0;
        if (coldTrail) {
          bb.lastKnownValid = false; // searched it out — back to patrol
        } else {
          const next = this.pickSearchNode(ctx);
          if (next >= 0) this.goTo(next);
          else bb.lastKnownValid = false;
        }
      }
      if (ctx.now - this.intelAt > 32) bb.lastKnownValid = false; // cold trail
      this.wantSprint = ctx.now - this.intelAt < 12 || d.aggression > 0.45; // chase hard
    } else if (mode === "hunt") {
      // No confirmed contact yet, but no soldier should pace in a vacuum.
      // Keep a noisy hypothesis of the player's likely neighborhood and keep
      // taking fresh lanes toward it until real sight/sound intel overrides it.
      const staleRoute = this.destNode < 0 || this.reachedDest || ctx.now > this.holdUntil;
      if (entered || staleRoute) {
        if (entered || this.reachedDest) this.refreshSuspicion(ctx, true);
        this.goTo(this.pickHuntNode(ctx));
        this.holdUntil = ctx.now + rand(1.5, 2.8);
      }
      const sx = this.suspicion.x - this.position.x;
      const sz = this.suspicion.z - this.position.z;
      const suspicionDist = Math.sqrt(sx * sx + sz * sz);
      this.wantSprint = suspicionDist > 8 && d.aggression > 0.4;
    } else {
      // Patrol: keep drifting between useful lanes, weapon low. No long
      // stand-and-look waits; arriving at one waypoint immediately queues the
      // next leg so the soldier keeps feeling alive.
      if ((this.destNode < 0 && ctx.now > this.patrolNextAt) || this.reachedDest) {
        this.lastPatrolNode = this.pickPatrolNode(ctx);
        this.goTo(this.lastPatrolNode);
        this.patrolNextAt = ctx.now + rand(0.2, 0.6);
      }
      this.wantSprint = false;
    }
    this.freshIntel = false; // intel is consumed by whichever branch ran
  }

  // Where to hunt: the last-known fix plus a short lead along the player's
  // last movement direction — converts "where they were" into "where
  // they're headed". Falls back to the raw fix if the led point is off-mesh.
  private refreshSuspicion(ctx: BotContext, force = false): void {
    if (ctx.player.isDead || (this.bb.lastKnownValid && !force)) return;
    if (this.suspicionValid && !force && ctx.now < this.nextSuspicionAt) return;

    const d = this.difficulty;
    const p = ctx.player;
    const dx = p.position.x - this.position.x;
    const dz = p.position.z - this.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const uncertainty = Math.max(3.5, 10 - d.aggression * 5 + Math.min(3, dist * 0.12));
    this.suspicion.set(
      p.position.x + rand(-uncertainty, uncertainty),
      p.position.y,
      p.position.z + rand(-uncertainty, uncertainty)
    );
    this.suspicionVel.copyFrom(p.velocity).scaleInPlace(0.45 + d.aggression * 0.35);
    this.suspicionValid = true;
    this.suspicionAt = ctx.now;
    this.nextSuspicionAt = ctx.now + rand(2.0, 3.8) * (1.25 - d.aggression * 0.45);
  }

  private predictedEnemyPosition(ctx: BotContext, maxLead: number): { x: number; z: number } {
    const visible = this.bb.canSeePlayer && !ctx.player.isDead;
    const hasIntel = this.bb.lastKnownValid;
    const base = visible
      ? ctx.player.position
      : hasIntel
        ? this.lastKnown
        : this.suspicionValid
          ? this.suspicion
          : ctx.player.position;
    const vel = visible
      ? ctx.player.velocity
      : hasIntel
        ? this.lastKnownVel
        : this.suspicionVel;
    const vx = vel.x;
    const vz = vel.z;
    const speed = Math.sqrt(vx * vx + vz * vz);
    let x = base.x;
    let z = base.z;
    if (speed > 0.8) {
      const intelAge = visible ? 0 : Math.max(0, ctx.now - (hasIntel ? this.intelAt : this.suspicionAt));
      const lead = Math.min(maxLead, speed * (0.5 + Math.min(intelAge, 4) * 0.22));
      x += (vx / speed) * lead;
      z += (vz / speed) * lead;
    }
    return { x, z };
  }

  private routeMemoryPenalty(node: number): number {
    let penalty = 1;
    if (node === this.destNode || node === this.previousDestNode || node === this.lastPatrolNode) penalty *= 0.22;
    for (let i = 0; i < this.recentDestCount; i++) {
      const recent = this.recentDestNodes[i];
      if (recent < 0) continue;
      if (node === recent) {
        penalty *= 0.12;
      } else {
        const dx = BotNav.xs[node] - BotNav.xs[recent];
        const dz = BotNav.zs[node] - BotNav.zs[recent];
        if (dx * dx + dz * dz < 2.8 * 2.8) penalty *= 0.55;
      }
    }
    if (this.previousDestNode >= 0) {
      const dx = BotNav.xs[node] - BotNav.xs[this.previousDestNode];
      const dz = BotNav.zs[node] - BotNav.zs[this.previousDestNode];
      if (dx * dx + dz * dz < 2.6 * 2.6) penalty *= 0.45;
    }
    return penalty;
  }

  private rememberDestination(node: number): void {
    if (node < 0) return;
    const prevIndex = (this.recentDestCursor + this.recentDestNodes.length - 1) % this.recentDestNodes.length;
    if (this.recentDestCount > 0 && this.recentDestNodes[prevIndex] === node) return;
    this.recentDestNodes[this.recentDestCursor] = node;
    this.recentDestCursor = (this.recentDestCursor + 1) % this.recentDestNodes.length;
    this.recentDestCount = Math.min(this.recentDestCount + 1, this.recentDestNodes.length);
  }

  private pickSearchNode(ctx: BotContext, baseRadius = 3.2, maxRadius = 10): number {
    const likely = this.predictedEnemyPosition(ctx, 6.5);
    const currentToLikelyX = likely.x - this.position.x;
    const currentToLikelyZ = likely.z - this.position.z;
    const currentToLikely = Math.sqrt(currentToLikelyX * currentToLikelyX + currentToLikelyZ * currentToLikelyZ);
    const ageSource = this.bb.lastKnownValid ? this.intelAt : this.suspicionAt;
    const age = Math.max(0, ctx.now - ageSource);
    const sweepRadius = Math.min(maxRadius, baseRadius + age * 0.32 + (5 - Math.max(0, this.searchStopsLeft)) * 0.8);
    let best = -1;
    let bestScore = 0;

    for (let i = 0; i < BotNav.count; i++) {
      if (!BotNav.walkable[i]) continue;
      const nx = BotNav.xs[i];
      const nz = BotNav.zs[i];
      const runX = nx - this.position.x;
      const runZ = nz - this.position.z;
      const runDist = Math.sqrt(runX * runX + runZ * runZ);
      if (runDist < 1.8) continue;

      const predX = nx - likely.x;
      const predZ = nz - likely.z;
      const predDist = Math.sqrt(predX * predX + predZ * predZ);
      if (predDist > sweepRadius) continue;

      const toward =
        currentToLikely > 0.001 && runDist > 0.001
          ? Math.max(0, (currentToLikelyX * runX + currentToLikelyZ * runZ) / (currentToLikely * runDist))
          : 0.5;
      const pressure = currentToLikely > 0.001 ? 0.75 + 0.45 * Math.max(0, (currentToLikely - predDist) / currentToLikely) : 1;
      const proximity = 1 / (1 + predDist * 0.38);
      const stretch = Math.min(1, runDist / 5);
      const cover = BotNav.cover[i] ? 1.12 : 1;
      const score =
        proximity *
        stretch *
        (0.65 + 0.35 * toward) *
        pressure *
        cover *
        this.routeMemoryPenalty(i) *
        rand(0.9, 1.1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    if (best >= 0) return best;
    const led = BotNav.nearestNode(likely.x, likely.z);
    if (led >= 0) return led;
    const raw = this.bb.lastKnownValid ? this.lastKnown : this.suspicion;
    return BotNav.nearestNode(raw.x, raw.z);
  }

  private pickHuntNode(ctx: BotContext): number {
    this.refreshSuspicion(ctx);
    return this.pickSearchNode(ctx, 5.5, 13);
  }

  // Where to wander: patrol like a person walking a yard, not a particle.
  // Uniform random nodes produced the "stupid" legs — two-step shuffles,
  // unmotivated about-faces, dead-corner dawdling. Sample a handful of
  // candidates and score for what a human would actually do: cover a real
  // stretch of ground, keep roughly the heading the body already has, drift
  // toward the middle where the action lives, hug lanes with cover nearby,
  // and don't re-walk the leg just finished. The jitter keeps two bots (or
  // two visits) from ever choosing identically.
  private pickPatrolNode(ctx: BotContext): number {
    let best = -1;
    let bestScore = 0;
    const hasSuspicion = this.suspicionValid && !ctx.player.isDead;
    for (let attempt = 0; attempt < 18; attempt++) {
      const n = BotNav.randomNodeNear(this.position.x, this.position.z, 13);
      if (n < 0 || n === this.lastPatrolNode || n === this.previousDestNode) continue;
      const dx = BotNav.xs[n] - this.position.x;
      const dz = BotNav.zs[n] - this.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 3.4) continue; // a shuffle, not a patrol leg
      const stretch = Math.min(1, dist / 8);
      const ahead = 0.55 + 0.45 * ((Math.sin(this.yaw) * dx + Math.cos(this.yaw) * dz) / dist);
      const centerDist = Math.sqrt(BotNav.xs[n] * BotNav.xs[n] + BotNav.zs[n] * BotNav.zs[n]);
      const central = 1.15 - 0.3 * Math.min(1, centerDist / 15);
      const cover = BotNav.cover[n] ? 1 + this.difficulty.coverPreference * 0.35 : 1;
      let suspicionBias = 1;
      if (hasSuspicion) {
        const currentX = this.suspicion.x - this.position.x;
        const currentZ = this.suspicion.z - this.position.z;
        const candX = this.suspicion.x - BotNav.xs[n];
        const candZ = this.suspicion.z - BotNav.zs[n];
        const currentDist = Math.sqrt(currentX * currentX + currentZ * currentZ);
        const candDist = Math.sqrt(candX * candX + candZ * candZ);
        suspicionBias = 0.8 + Math.max(-0.2, Math.min(0.6, (currentDist - candDist) / Math.max(1, currentDist)));
      }
      const score = stretch * ahead * central * cover * suspicionBias * this.routeMemoryPenalty(n) * rand(0.85, 1.15);
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    // boxed into a corner where every sample failed: take anything walkable
    return best >= 0 ? best : BotNav.randomNodeNear(this.position.x, this.position.z, 12);
  }

  // Weapon selection / reload discipline — the utility scorer of the spec:
  // score every carried gun for the current range, bias the sidearm up when
  // the primary runs dry, and demand a margin before swapping so low-skill
  // bots stick with what they hold.
  private considerWeapon(ctx: BotContext): void {
    const bb = this.bb;
    const d = this.difficulty;
    if (this.reloadTimer > 0 || this.switchTimer > 0) return;

    const current = this.weapons[this.weaponIndex];
    if (current.clip === 0) {
      const other = this.weapons[1 - this.weaponIndex];
      // dry in someone's face: the trained move is the quickswap, not the reload
      if (bb.canSeePlayer && bb.distanceToPlayer < 9 && other.clip > 0 && Math.random() < d.weaponSwitchSkill) {
        this.startSwitch(1 - this.weaponIndex);
      } else {
        this.reloadTimer = current.profile.reloadTime;
      }
      return;
    }

    // lull top-up (reloadDiscipline is per-think, so ~a few seconds of quiet)
    if (!bb.canSeePlayer && bb.timeSinceSeen > 3 && current.clip < current.profile.magSize * 0.45 && Math.random() < d.reloadDiscipline * 0.25) {
      this.reloadTimer = current.profile.reloadTime;
      return;
    }

    if (ctx.now < this.weaponEvalAt) return;
    this.weaponEvalAt = ctx.now + 1.5;

    const dist = bb.canSeePlayer || bb.lastKnownValid ? bb.distanceToPlayer : 10;
    const primaryDry = this.weapons[0].clip === 0 ? 1.8 : 1;
    const scores = this.weapons.map((w, i) => {
      const ammo = 0.3 + 0.7 * (w.clip / w.profile.magSize);
      const sidearmBonus = i === 1 ? primaryDry * 0.75 : 1;
      return rangeCurve(dist, w.profile.range) * ammo * sidearmBonus;
    });
    const best = scores[0] >= scores[1] ? 0 : 1;
    const margin = 1 + (1 - d.weaponSwitchSkill) * 0.9;
    if (best !== this.weaponIndex && scores[best] > scores[this.weaponIndex] * margin) {
      this.startSwitch(best);
    }
  }

  private startSwitch(index: number): void {
    this.weaponIndex = index;
    this.switchTimer = 0.6;
    this.burstLeft = 0;
  }

  // ------------------------------------------------- position utility scores

  private coveredHere(ctx: BotContext): boolean {
    Bot.TMP_A.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
    Bot.TMP_B.set(ctx.player.position.x, ctx.player.position.y + ctx.player.eyeHeight, ctx.player.position.z);
    return BotNav.losBlocked(Bot.TMP_A, Bot.TMP_B);
  }

  // Attack position: a node the current weapon likes the range from, with
  // line of sight, ideally beside cover, not too far a run, occasionally on
  // the player's flank. (The Killzone "dynamic tactical position" idea over
  // the auto-derived node set.)
  private pickAttackNode(ctx: BotContext, px: number, pz: number): number {
    const d = this.difficulty;
    const profile = this.weapons[this.weaponIndex].profile;
    const eyeY = ctx.player.position.y + ctx.player.eyeHeight * 0.8;
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < BotNav.count; i++) {
      if (!BotNav.walkable[i]) continue;
      const nx = BotNav.xs[i];
      const nz = BotNav.zs[i];
      const toBotX = nx - this.position.x;
      const toBotZ = nz - this.position.z;
      const runDist = Math.sqrt(toBotX * toBotX + toBotZ * toBotZ);
      if (runDist > 15) continue;
      if (runDist < 1.8) continue;

      const toPlayerX = nx - px;
      const toPlayerZ = nz - pz;
      const fightDist = Math.sqrt(toPlayerX * toPlayerX + toPlayerZ * toPlayerZ);
      if (fightDist < 2.5) continue; // never plan a position inside the player

      // standoff: muzzle-hugging positions score down even when the weapon's
      // range curve is flat up close — soldiers fight from arm's length out
      const currentFightX = this.position.x - px;
      const currentFightZ = this.position.z - pz;
      const currentFightDist = Math.sqrt(currentFightX * currentFightX + currentFightZ * currentFightZ);
      const towardPlayer =
        currentFightDist > 0.001 && runDist > 0.001
          ? Math.max(0, ((px - this.position.x) * toBotX + (pz - this.position.z) * toBotZ) / (currentFightDist * runDist))
          : 0.5;
      const closesGap = currentFightDist > 0.001 ? (currentFightDist - fightDist) / currentFightDist : 0;
      let score =
        rangeCurve(fightDist, profile.range) *
        Math.min(1, fightDist / 6) *
        (1 / (1 + runDist * 0.1)) *
        (0.72 + 0.35 * towardPlayer) *
        (0.85 + Math.max(-0.25, closesGap) * 0.45);
      if (score < bestScore * 0.25) continue; // skip the LOS ray when hopeless

      Bot.TMP_A.set(nx, EYE_HEIGHT, nz);
      Bot.TMP_B.set(px, eyeY, pz);
      if (BotNav.losBlocked(Bot.TMP_A, Bot.TMP_B)) score *= 0.06;
      if (BotNav.cover[i]) score *= 1 + d.coverPreference * 0.9;
      score *= this.routeMemoryPenalty(i);
      if (this.flankRoll) {
        // reward swinging wide of the player->bot axis
        const a1 = Math.atan2(this.position.x - px, this.position.z - pz);
        const a2 = Math.atan2(nx - px, nz - pz);
        const swing = Math.abs(Bot.angDelta(a1, a2));
        score *= swing > 0.9 && swing < 2.3 ? 1.4 : 0.75;
      }
      score *= rand(0.85, 1.15); // never metronomic
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  // Retreat / reload bolt-hole: hidden from the player, beside cover, close
  // to the bot, with some distance from the threat
  private pickHiddenNode(ctx: BotContext): number {
    const p = ctx.player;
    const eyeY = p.position.y + p.eyeHeight;
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < BotNav.count; i++) {
      if (!BotNav.walkable[i]) continue;
      const nx = BotNav.xs[i];
      const nz = BotNav.zs[i];
      const toBotX = nx - this.position.x;
      const toBotZ = nz - this.position.z;
      const runDist = Math.sqrt(toBotX * toBotX + toBotZ * toBotZ);
      if (runDist > 18) continue;

      const toPlayerX = nx - p.position.x;
      const toPlayerZ = nz - p.position.z;
      const threatDist = Math.sqrt(toPlayerX * toPlayerX + toPlayerZ * toPlayerZ);

      Bot.TMP_A.set(nx, EYE_HEIGHT, nz);
      Bot.TMP_B.set(p.position.x, eyeY, p.position.z);
      const hidden = BotNav.losBlocked(Bot.TMP_A, Bot.TMP_B);
      const score =
        (hidden ? 1.4 : 0.15) *
        (BotNav.cover[i] ? 1.5 : 0.7) *
        (1 / (1 + runDist * 0.1)) *
        (0.4 + Math.min(threatDist, 16) / 16) *
        rand(0.9, 1.1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  private goTo(node: number): void {
    const oldDest = this.destNode;
    this.destNode = node;
    this.reachedDest = false;
    this.path.length = 0;
    this.pathIndex = 0;
    if (node < 0) return;
    const from = BotNav.nearestNode(this.position.x, this.position.z);
    if (!BotNav.findPath(from, node, this.path)) {
      this.destNode = -1;
    } else if (oldDest >= 0 && oldDest !== node) {
      this.previousDestNode = oldDest;
      this.rememberDestination(node);
      this.reverseTimer = 0;
    } else {
      this.rememberDestination(node);
      this.reverseTimer = 0;
    }
  }

  private recoverRoute(ctx: BotContext): void {
    const bb = this.bb;
    this.stuckTimer = 0;
    this.reverseTimer = 0;
    this.path.length = 0;
    this.pathIndex = 0;
    this.destNode = -1;
    this.reachedDest = false;

    let next = -1;
    if (bb.mode === "reload" || bb.mode === "retreat") {
      next = this.pickHiddenNode(ctx);
    } else if (bb.mode === "combat") {
      const px = bb.canSeePlayer ? ctx.player.position.x : this.lastKnown.x;
      const pz = bb.canSeePlayer ? ctx.player.position.z : this.lastKnown.z;
      next = this.pickAttackNode(ctx, px, pz);
      if (next < 0) next = this.pickSearchNode(ctx);
    } else if (bb.mode === "search") {
      next = this.pickSearchNode(ctx);
    } else if (bb.mode === "hunt") {
      this.refreshSuspicion(ctx, true);
      next = this.pickHuntNode(ctx);
      this.holdUntil = ctx.now + rand(1.2, 2.2);
    } else {
      next = this.pickPatrolNode(ctx);
    }
    if (next >= 0) this.goTo(next);
  }

  // ------------------------------------------------------- aim model + firing

  private rerollError(scale: number): void {
    const e = this.difficulty.aimErrorDegrees * DEG * scale;
    this.errYaw = rand(-e, e);
    this.errPitch = rand(-e * 0.7, e * 0.7);
  }

  private updateCombat(ctx: BotContext, dt: number): void {
    const bb = this.bb;
    const d = this.difficulty;

    // Aim error always settles toward zero while tracking — the "smoothing
    // model" of the research: early shots stray, later shots arrive
    const settle = Math.exp(-d.aimSettleSpeed * dt);
    this.errYaw *= settle;
    this.errPitch *= settle;

    const engaged = bb.canSeePlayer || (bb.lastKnownValid && bb.timeSinceSeen < 2.8);
    if (!engaged || ctx.player.isDead) {
      this.burstLeft = 0;
      bb.hasLineOfFire = false;
      // muzzle drifts back to where the feet are going
      this.aimYaw += Bot.angDelta(this.aimYaw, this.yaw) * (1 - Math.exp(-6 * dt));
      this.aimPitch *= Math.exp(-6 * dt);
      return;
    }

    // Target: the best visible piece of the player — chest when it's clear,
    // else whatever the cover leaves out (a head over a car hood, shins
    // under it) — or the remembered spot otherwise (suppression fire pins
    // the lane they vanished from). The pick is re-rayed from MUZZLE height,
    // not eye height: the eyes ride higher than the gun, and a piece the eye
    // sees over a car lip can be unreachable from the barrel. If the gun can
    // reach no sample, the perception pick stands and the burst gate holds.
    const p = ctx.player;
    let tx: number;
    let ty: number;
    let tz: number;
    if (bb.canSeePlayer) {
      Bot.TMP_A.set(this.position.x, this.position.y + MUZZLE_HEIGHT, this.position.z);
      let bestRank = Infinity;
      for (let i = 0; i < SIGHT_SAMPLES.length; i++) {
        if (SIGHT_SAMPLES[i].aimRank >= bestRank) continue;
        this.bodySample(p, i, Bot.TMP_B);
        if (BotNav.losBlocked(Bot.TMP_A, Bot.TMP_B)) continue;
        bestRank = SIGHT_SAMPLES[i].aimRank;
        this.aimSample = i;
      }
      this.bodySample(p, this.aimSample, Bot.TMP_B);
      tx = Bot.TMP_B.x;
      ty = Bot.TMP_B.y;
      tz = Bot.TMP_B.z;
    } else {
      tx = this.lastKnown.x;
      ty = this.lastKnown.y + 1.3;
      tz = this.lastKnown.z;
    }
    const dx = tx - this.position.x;
    const dy = ty - (this.position.y + MUZZLE_HEIGHT);
    const dz = tz - this.position.z;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    this.desiredYaw = Math.atan2(dx, dz);
    this.desiredPitch = -Math.atan2(dy, horiz);

    // Smoothed pursuit of (target + human error)
    const chase = 1 - Math.exp(-d.aimSettleSpeed * 2.2 * dt);
    this.aimYaw += Bot.angDelta(this.aimYaw, this.desiredYaw + this.errYaw) * chase;
    this.aimPitch += (this.desiredPitch + this.errPitch - this.aimPitch) * chase;

    Bot.TMP_A.set(this.position.x, this.position.y + MUZZLE_HEIGHT, this.position.z);
    Bot.TMP_B.set(tx, ty, tz);
    bb.hasLineOfFire = !BotNav.losBlocked(Bot.TMP_A, Bot.TMP_B);

    if (this.reactionTimer > 0) {
      this.reactionTimer -= dt;
      return;
    }
    if (this.reloadTimer > 0 || this.switchTimer > 0) return;

    const w = this.weapons[this.weaponIndex];
    if (w.clip === 0) return; // considerWeapon resolves this next think

    const onTarget = Math.abs(Bot.angDelta(this.aimYaw, this.desiredYaw)) < 8 * DEG;
    if (this.burstLeft > 0) {
      if (this.fireTimer <= 0 && onTarget) this.fire(ctx);
    } else if (this.burstTimer <= 0 && onTarget && bb.hasLineOfFire) {
      // Commit to a burst. Without sight this is suppression — aggression
      // decides whether they hose the corner or hold the shot.
      if (bb.canSeePlayer || Math.random() < d.aggression * 0.55) {
        const [lo, hi] = w.profile.burstLength ?? d.burstLength;
        this.burstLeft = Math.round(rand(lo, hi));
        this.rerollError(1); // each burst opens with fresh, settling error
      } else {
        this.burstTimer = 0.4; // passed on the shot; reconsider shortly
      }
    }
  }

  private fire(ctx: BotContext): void {
    const w = this.weapons[this.weaponIndex];
    const profile = w.profile;
    const d = this.difficulty;
    w.clip--;
    this.burstLeft--;
    this.fireTimer = profile.fireInterval;
    this.radarTimer = 2; // firing paints the radar, COD-style
    if (this.burstLeft <= 0 || w.clip === 0) {
      const [lo, hi] = profile.burstCooldown ?? d.burstCooldown;
      this.burstTimer = rand(lo, hi);
    }

    // Per-shot dispersion on top of the aim error; running and a strafing
    // target both make everyone worse
    const p = ctx.player;
    const targetStrafe = Math.abs(p.velocity.x) + Math.abs(p.velocity.z) > 3 ? 1.25 : 1;
    const spread = profile.spreadDeg * DEG * (this.moveSpeed > 0.5 ? 1.6 : 1) * targetStrafe;
    const shotYaw = this.aimYaw + rand(-spread, spread);
    const shotPitch = this.aimPitch + rand(-spread, spread) * 0.75;
    const cosP = Math.cos(shotPitch);
    const dir = Bot.TMP_DIR.set(Math.sin(shotYaw) * cosP, Math.sin(-shotPitch), Math.cos(shotYaw) * cosP);

    this.muzzle.computeWorldMatrix(true);
    const muzzlePos = Bot.TMP_A.copyFrom(this.muzzle.getAbsolutePosition());

    // Resolve the round: nearest of world geometry vs the player's capsule
    const tWorld = BotNav.rayHitWorld(muzzlePos, dir, MAX_SHOT_RANGE, Bot.TMP_POINT, Bot.TMP_NORMAL);
    const tPlayer = p.isDead ? Infinity : Bot.rayVsBody(muzzlePos, dir, p);

    const tracerEnd = Bot.TMP_B;
    if (tPlayer < tWorld) {
      const wasDead = p.isDead;
      p.takeDamage(profile.damage * d.damageScale, this.position);
      if (!wasDead && p.isDead) {
        MatchEvents.emit("playerDeath", { weaponId: profile.id }); // kill feed + score
      }
      ctx.effects.playPlayerHitSound();
      tracerEnd.copyFrom(dir).scaleInPlace(tPlayer).addInPlace(muzzlePos);
    } else {
      // near-miss snap if the streak passes the player's head
      if (!p.isDead) {
        const ex = p.position.x - muzzlePos.x;
        const ey = p.position.y + p.eyeHeight - muzzlePos.y;
        const ez = p.position.z - muzzlePos.z;
        const tc = ex * dir.x + ey * dir.y + ez * dir.z;
        if (tc > 0 && tc < Math.min(tWorld, MAX_SHOT_RANGE)) {
          const mx = ex - dir.x * tc;
          const my = ey - dir.y * tc;
          const mz = ez - dir.z * tc;
          if (mx * mx + my * my + mz * mz < 1.0) ctx.effects.playBulletWhizSound();
        }
      }
      if (tWorld !== Infinity) {
        ctx.effects.createBulletImpact(Bot.TMP_POINT, Bot.TMP_NORMAL);
        tracerEnd.copyFrom(Bot.TMP_POINT);
      } else {
        tracerEnd.copyFrom(dir).scaleInPlace(MAX_SHOT_RANGE).addInPlace(muzzlePos);
      }
    }

    ctx.effects.createTracer(muzzlePos, tracerEnd);
    ctx.effects.createMuzzleFlash(muzzlePos, 0.75);
    ctx.effects.playBotShootSound(profile.id, this.bb.distanceToPlayer);

    // Recoil feeds the error model so long automatic bursts climb off target
    this.errPitch -= 0.35 * DEG * (profile.id === "m40a3" ? 3 : 1);
    this.errYaw += rand(-0.18, 0.18) * DEG;
  }

  // World position of silhouette sample i: a fraction of the player's current
  // eye height plus a lateral offset perpendicular to this bot's sight line
  // (so the "shoulder" points straddle whatever edge the player peeks).
  private bodySample(p: PlayerController, i: number, out: Vector3): void {
    const s = SIGHT_SAMPLES[i];
    let rx = 0;
    let rz = 0;
    if (s.lat !== 0) {
      const dx = p.position.x - this.position.x;
      const dz = p.position.z - this.position.z;
      const h = Math.sqrt(dx * dx + dz * dz);
      if (h > 1e-4) {
        rx = dz / h;
        rz = -dx / h;
      }
    }
    out.set(
      p.position.x + rx * s.lat,
      p.position.y + p.eyeHeight * s.h,
      p.position.z + rz * s.lat
    );
  }

  // Segment vs the player's vertical cylinder (radius matches the collision
  // solver's). Returns the hit distance or Infinity.
  private static rayVsBody(origin: Vector3, dir: Vector3, p: PlayerController): number {
    const rx = origin.x - p.position.x;
    const rz = origin.z - p.position.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a < 1e-8) return Infinity;
    const b = 2 * (rx * dir.x + rz * dir.z);
    const r = 0.42;
    const c = rx * rx + rz * rz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    let t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) {
      // Muzzle already inside the cylinder (point-blank): take the exit
      // root so contact shots still land instead of passing clean through
      t = (-b + Math.sqrt(disc)) / (2 * a);
      if (t < 0) return Infinity;
    }
    const y = origin.y + dir.y * t;
    if (y < p.position.y || y > p.position.y + p.eyeHeight + 0.15) return Infinity;
    return t;
  }

  // ----------------------------------------------------------------- motor

  private motor(ctx: BotContext, dt: number): void {
    const bb = this.bb;

    // Follow the path with light string-pulling: skip waypoints while the
    // straight line to the next-next one is walkable
    let intendedSpeed = 0;
    let moveYaw = this.yaw;
    if (this.destNode >= 0 && this.pathIndex < this.path.length) {
      while (
        this.pathIndex + 1 < this.path.length &&
        !BotNav.walkBlocked(this.position.x, this.position.z, BotNav.xs[this.path[this.pathIndex + 1]], BotNav.zs[this.path[this.pathIndex + 1]])
      ) {
        this.pathIndex++;
      }
      const wx = BotNav.xs[this.path[this.pathIndex]];
      const wz = BotNav.zs[this.path[this.pathIndex]];
      const dx = wx - this.position.x;
      const dz = wz - this.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.55) {
        this.pathIndex++;
        if (this.pathIndex >= this.path.length) this.reachedDest = true;
      } else {
        intendedSpeed =
          this.wantSprint && !bb.canSeePlayer
            ? PlayerController.SPRINT_SPEED
            : bb.mode === "patrol"
              ? PlayerController.WALK_SPEED * 0.6
              : PlayerController.WALK_SPEED;
        moveYaw = Math.atan2(dx, dz);
        this.velocity.x = (dx / dist) * intendedSpeed;
        this.velocity.z = (dz / dist) * intendedSpeed;
      }
    }
    if (intendedSpeed === 0) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    // Facing: square up to the fight when engaged; face the move otherwise.
    // Standing still, nobody stares at one spot — a slow shoulder-check sweep
    // keeps stopped bots aware (and watchable). Search sweeps harder.
    const engaged = bb.canSeePlayer || (bb.lastKnownValid && bb.timeSinceSeen < 2.8);
    if (this.wasMoving && intendedSpeed === 0) {
      this.idleYawBase = this.yaw;
      this.idleStopAt = ctx.now;
    }
    this.wasMoving = intendedSpeed > 0;
    let targetYaw: number;
    if (engaged) targetYaw = this.aimYaw;
    else if (intendedSpeed > 0) targetYaw = moveYaw;
    else targetYaw = this.idleYawBase + Math.sin((ctx.now - this.idleStopAt) * 0.55) * 1.2;
    if (bb.mode === "search" && this.scanUntil > ctx.now) {
      targetYaw = this.scanBaseYaw + Math.sin((this.scanUntil - ctx.now) * 2.4) * 1.25;
    }
    this.yaw += Bot.angDelta(this.yaw, targetYaw) * (1 - Math.exp(-(engaged ? 11 : 7) * dt));

    // Same gravity, same solver, same limits as the player
    this.velocity.y += PlayerController.GRAVITY * dt;
    PlayerController.moveAndCollide(this.tmpPrev.copyFrom(this.position), this.velocity, dt, BODY_HEIGHT, BODY_RADIUS, this.tmpNext);
    const movedX = this.tmpNext.x - this.position.x;
    const movedZ = this.tmpNext.z - this.position.z;
    this.position.copyFrom(this.tmpNext);
    this.moveSpeed = Math.sqrt(movedX * movedX + movedZ * movedZ) / Math.max(dt, 1e-6);

    // Wedged or pacing: throw away the route now, not after a visible
    // back-and-forth dance. Stalls usually mean the grid leg clipped an
    // inflated obstacle; repeated reversal means the scorer picked the lane
    // it just came from. Both recover into a freshly scored pressure route.
    let recovered = false;
    if (intendedSpeed > 0 && this.moveSpeed < intendedSpeed * 0.25) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.42) {
        this.recoverRoute(ctx);
        recovered = true;
      }
    } else {
      this.stuckTimer = 0;
    }
    if (!recovered && intendedSpeed > 0 && this.moveSpeed > 0.35) {
      const movedLen = Math.sqrt(movedX * movedX + movedZ * movedZ);
      if (movedLen > 1e-5) {
        const dirX = movedX / movedLen;
        const dirZ = movedZ / movedLen;
        const hasHistory = this.lastMoveDirX * this.lastMoveDirX + this.lastMoveDirZ * this.lastMoveDirZ > 0.1;
        const dot = hasHistory ? dirX * this.lastMoveDirX + dirZ * this.lastMoveDirZ : 1;
        const canBreakLoop = bb.mode === "hunt" || bb.mode === "patrol" || bb.mode === "search";
        if (canBreakLoop && dot < -0.78) {
          this.reverseTimer += dt;
          if (this.reverseTimer > 0.32) {
            this.recoverRoute(ctx);
            recovered = true;
          }
        } else {
          this.reverseTimer = Math.max(0, this.reverseTimer - dt * 2.5);
        }
        if (!recovered) {
          this.lastMoveDirX = this.lastMoveDirX * 0.55 + dirX * 0.45;
          this.lastMoveDirZ = this.lastMoveDirZ * 0.55 + dirZ * 0.45;
          const histLen = Math.sqrt(this.lastMoveDirX * this.lastMoveDirX + this.lastMoveDirZ * this.lastMoveDirZ);
          if (histLen > 1e-5) {
            this.lastMoveDirX /= histLen;
            this.lastMoveDirZ /= histLen;
          }
        }
      }
    } else if (intendedSpeed === 0) {
      this.reverseTimer = 0;
    }

    this.root.rotation.y = this.yaw; // root.position aliases this.position
  }

  private animate(dt: number): void {
    const ratio = Math.min(1, this.moveSpeed / PlayerController.WALK_SPEED);
    const targetAmp = this.moveSpeed > 0.3 ? 0.5 * Math.max(0.55, ratio) : 0;
    this.walkAmp += (targetAmp - this.walkAmp) * (1 - Math.exp(-10 * dt));
    if (this.walkAmp > 0.01) {
      this.walkPhase += dt * 7.5 * Math.max(0.6, ratio * 1.4);
    }
    // Hips swing opposed; each knee flexes while its leg lifts through the
    // swing, and the torso dips on every footfall — a gait, not stilts
    const swing = Math.sin(this.walkPhase) * this.walkAmp;
    this.hipL.rotation.x = swing;
    this.hipR.rotation.x = -swing;
    this.kneeL.rotation.x = -Math.max(0, Math.sin(this.walkPhase + 1.1)) * 0.85 * this.walkAmp;
    this.kneeR.rotation.x = -Math.max(0, Math.sin(this.walkPhase + 1.1 + Math.PI)) * 0.85 * this.walkAmp;
    this.torsoGroup.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.04 * this.walkAmp;

    // Lean into a dead run
    const lean = this.moveSpeed > PlayerController.WALK_SPEED * 1.2 ? 0.14 : 0;
    this.torsoGroup.rotation.x += (lean - this.torsoGroup.rotation.x) * (1 - Math.exp(-6 * dt));

    // Rifle tracks the aim pitch in a fight, hangs low on patrol — and comes
    // up to the shoulder, putting the muzzle on the MUZZLE_HEIGHT line the
    // combat model fires from
    const engaged = this.bb.canSeePlayer || (this.bb.lastKnownValid && this.bb.timeSinceSeen < 4);
    const targetGun = engaged ? this.aimPitch : 0.5;
    this.gunPitch += (targetGun - this.gunPitch) * (1 - Math.exp(-9 * dt));
    this.gunArm.rotation.x = this.gunPitch;
    this.shoulderBlend += ((engaged ? 1 : 0) - this.shoulderBlend) * (1 - Math.exp(-9 * dt));
    this.gunArm.position.y = SHOULDER_RAISE * this.shoulderBlend;

    // The skinned body: idle/walk/run clip blending from the measured speed,
    // and the spine leans into the aim while engaged
    this.rig.body.setAim(this.gunPitch, engaged);
    this.rig.body.update(dt, this.moveSpeed);
  }

  private static angDelta(from: number, to: number): number {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
}
