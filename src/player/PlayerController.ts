import { Vector3 } from "@babylonjs/core";
import { Input } from "../engine/Input";
import { CameraRig } from "./CameraRig";

export class PlayerController {
  // Spawn in the SW corner of the yard, facing the center cross
  public position: Vector3 = new Vector3(-13.5, 0, -13.5);
  public velocity: Vector3 = new Vector3(0, 0, 0);

  public yaw: number = 0.785;
  public pitch: number = 0;

  // Movement limits (meters per second). Static and public: bots move through
  // the same solver below, so they share the exact same speed envelope.
  public static readonly WALK_SPEED = 4.0;
  public static readonly SPRINT_SPEED = 6.2;
  public static readonly CROUCH_SPEED = 2.0;
  public static readonly PRONE_SPEED = 0.9;
  public static readonly GRAVITY = -15.0;
  private jumpForce: number = 5.0;

  // Heights
  private standEyeHeight: number = 1.7;
  private crouchEyeHeight: number = 0.95;
  private proneEyeHeight: number = 0.42;
  private currentEyeHeight: number = 1.7;
  private static readonly PRONE_HOLD_SECONDS = 0.32;

  private isGrounded: boolean = true;
  public isCrouching: boolean = false;
  public isProne: boolean = false;
  public isSprinting: boolean = false;
  private crouchToggled: boolean = false;
  private stanceInputWasDown: boolean = false;
  private stanceHoldTime: number = 0;
  private stanceHoldTriggeredProne: boolean = false;

  // --- Health (Fall of Duty-style: no bar — screen blood, regen after a quiet spell) ---
  public static readonly MAX_HEALTH = 100;
  private static readonly REGEN_DELAY = 4.0; // seconds without damage before regen
  private static readonly REGEN_RATE = 40; // hp per second once regenerating
  // Long enough for the third-person death performance to play out fully
  // (clutch, gasp, fall, eyes close, settle) plus a beat of stillness
  private static readonly RESPAWN_DELAY = 3.7;
  private static readonly SPAWNS: ReadonlyArray<[number, number]> = [
    [-13.5, -13.5], [13.5, 13.5], [-13.5, 13.5], [13.5, -13.5],
  ];

  public health: number = PlayerController.MAX_HEALTH;
  public isDead: boolean = false;
  public deaths: number = 0;
  // Killstreak laptop: while it's out, the mouse drives the targeting cursor
  // instead of the view.
  public lookLocked: boolean = false;
  // Wired by Game to BotManager.pickPlayerSpawn so respawns land far from
  // (and out of sight of) living enemies instead of on a random corner
  public spawnPicker: ((spawns: ReadonlyArray<[number, number]>) => [number, number]) | null = null;
  // Hud feedback: a 0..1 spike that decays after each hit, plus the world yaw
  // toward the most recent shooter for the directional damage indicator
  public damageFlash: number = 0;
  public damageFromYaw: number = 0;
  private gameTime: number = 0;
  private lastDamageAt: number = -Infinity;
  private respawnTimer: number = 0;
  private invulnUntil: number = 0; // brief spawn protection
  private justRespawned: boolean = false;

  private input: Input;
  private cameraRig: CameraRig;

  // Reused temp vectors (avoid per-frame allocations in the update hot path)
  private tmpPrevPos: Vector3 = new Vector3();
  private tmpNextPos: Vector3 = new Vector3();
  private tmpCameraPos: Vector3 = new Vector3();

  // Mouse settings (0.002 base raised 15%)
  public lookSensitivity: number = 0.0023;

  // Collision map boundaries (must match the ShipBoxMap walls)
  public static readonly MAP_MIN_X = -15.6;
  public static readonly MAP_MAX_X = 15.6;
  public static readonly MAP_MIN_Z = -15.6;
  public static readonly MAP_MAX_Z = 15.6;

  // Collision boxes. Stored as center + half extents + yaw so rotated props
  // (angled containers, the car wreck, skewed crates) collide along their
  // visible faces instead of a fat axis-aligned box around them.
  private static obstacles: Array<{
    cx: number;
    cz: number;
    hw: number; // half extent along local x
    hd: number; // half extent along local z
    minY: number;
    maxY: number;
    yaw: number;
    cos: number;
    sin: number;
  }> = [];

  constructor(input: Input, cameraRig: CameraRig) {
    this.input = input;
    this.cameraRig = cameraRig;
  }

  // Axis-aligned box (yaw 0) — the common case for walls and straight props
  public static registerObstacle(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number
  ): void {
    this.registerObstacleOBB(
      (minX + maxX) / 2,
      (minZ + maxZ) / 2,
      (maxX - minX) / 2,
      (maxZ - minZ) / 2,
      minY,
      maxY,
      0
    );
  }

  // Oriented box: yaw matches the mesh's rotation.y (local +x maps to world
  // (cos yaw, -sin yaw), same convention Babylon uses for the visuals)
  public static registerObstacleOBB(
    cx: number,
    cz: number,
    hw: number,
    hd: number,
    minY: number,
    maxY: number,
    yaw: number
  ): void {
    this.obstacles.push({ cx, cz, hw, hd, minY, maxY, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw) });
  }

  public static clearObstacles(): void {
    this.obstacles = [];
  }

  // Shared kinematic solver: integrates velocity over dt, clamps to the map
  // bounds, resolves horizontal collisions against every registered OBB (with
  // velocity slide along faces), then vertical collisions and the floor.
  // Mutates nextPos AND velocity; returns whether the body ended grounded.
  // The player and every bot move through this one function, so bots obey
  // exactly the movement physics the player does.
  public static moveAndCollide(
    prevPos: Vector3,
    velocity: Vector3,
    deltaTime: number,
    height: number,
    radius: number,
    nextPos: Vector3
  ): boolean {
    nextPos.copyFrom(prevPos);

    // Apply X and Z movement first
    nextPos.x += velocity.x * deltaTime;
    nextPos.z += velocity.z * deltaTime;

    // Map boundary collisions
    nextPos.x = Math.max(PlayerController.MAP_MIN_X, Math.min(PlayerController.MAP_MAX_X, nextPos.x));
    nextPos.z = Math.max(PlayerController.MAP_MIN_Z, Math.min(PlayerController.MAP_MAX_Z, nextPos.z));

    // Resolve X and Z horizontal collisions. Each obstacle is solved in its
    // own local frame (rotate the body in by -yaw, clamp against the box,
    // rotate the correction back out) so angled props block exactly along
    // their visible faces.
    for (const obs of PlayerController.obstacles) {
      // Check if body Y overlaps with the obstacle Y
      const yOverlap = prevPos.y < obs.maxY && prevPos.y + height > obs.minY;
      if (!yOverlap) continue;

      // world -> obstacle local (inverse of the mesh's rotation.y)
      const dx = nextPos.x - obs.cx;
      const dz = nextPos.z - obs.cz;
      const lx = obs.cos * dx - obs.sin * dz;
      const lz = obs.sin * dx + obs.cos * dz;

      const limX = obs.hw + radius;
      const limZ = obs.hd + radius;
      if (Math.abs(lx) >= limX || Math.abs(lz) >= limZ) continue;

      // Push out along the shallower local axis
      const penX = limX - Math.abs(lx);
      const penZ = limZ - Math.abs(lz);
      let nx: number; // local-frame push normal
      let nz: number;
      let clampedX = lx;
      let clampedZ = lz;
      if (penX < penZ) {
        nx = lx < 0 ? -1 : 1;
        nz = 0;
        clampedX = nx * limX;
      } else {
        nx = 0;
        nz = lz < 0 ? -1 : 1;
        clampedZ = nz * limZ;
      }

      // obstacle local -> world (local +x maps to (cos, -sin), +z to (sin, cos))
      nextPos.x = obs.cx + obs.cos * clampedX + obs.sin * clampedZ;
      nextPos.z = obs.cz - obs.sin * clampedX + obs.cos * clampedZ;

      // Kill the velocity component into the face, keep the tangential part
      // so the body slides along angled walls instead of sticking
      const wnx = obs.cos * nx + obs.sin * nz;
      const wnz = -obs.sin * nx + obs.cos * nz;
      const vDotN = velocity.x * wnx + velocity.z * wnz;
      if (vDotN < 0) {
        velocity.x -= wnx * vDotN;
        velocity.z -= wnz * vDotN;
      }
    }

    // Now apply Y movement (vertical physics)
    nextPos.y += velocity.y * deltaTime;

    let onGround = false;

    // Resolve vertical collisions
    for (const obs of PlayerController.obstacles) {
      // Check X/Z overlap with resolved nextPos (in the obstacle's frame)
      const dx = nextPos.x - obs.cx;
      const dz = nextPos.z - obs.cz;
      const lx = obs.cos * dx - obs.sin * dz;
      const lz = obs.sin * dx + obs.cos * dz;
      const xzOverlap = Math.abs(lx) < obs.hw + radius && Math.abs(lz) < obs.hd + radius;

      if (xzOverlap) {
        // Falling down onto the obstacle
        if (velocity.y < 0 && prevPos.y >= obs.maxY - 0.05 && nextPos.y < obs.maxY) {
          nextPos.y = obs.maxY;
          velocity.y = 0;
          onGround = true;
        }
        // Jumping up into obstacle ceiling
        else if (velocity.y > 0 && prevPos.y + height <= obs.minY + 0.05 && nextPos.y + height > obs.minY) {
          nextPos.y = obs.minY - height;
          velocity.y = 0;
        }
      }
    }

    // Floor collision
    if (nextPos.y <= 0) {
      nextPos.y = 0;
      velocity.y = 0;
      onGround = true;
    }

    return onGround;
  }

  public get eyeHeight(): number {
    return this.currentEyeHeight;
  }

  // fromPos: the shooter's position — drives the directional damage indicator
  // and a small camera flinch so getting hit reads physically
  public takeDamage(amount: number, fromPos: Vector3): void {
    if (this.isDead || this.gameTime < this.invulnUntil) return;
    this.health -= amount;
    this.lastDamageAt = this.gameTime;
    this.damageFlash = Math.min(1, this.damageFlash + amount / 45);
    this.damageFromYaw = Math.atan2(fromPos.x - this.position.x, fromPos.z - this.position.z);
    this.cameraRig.applyRecoil(0.55, 1.4, 0.012); // hit flinch
    if (this.health <= 0) {
      this.health = 0;
      this.isDead = true;
      this.deaths++;
      this.respawnTimer = PlayerController.RESPAWN_DELAY;
    }
  }

  private respawn(): void {
    const [x, z] = this.spawnPicker
      ? this.spawnPicker(PlayerController.SPAWNS)
      : PlayerController.SPAWNS[(Math.random() * PlayerController.SPAWNS.length) | 0];
    this.position.set(x, 0, z);
    this.velocity.setAll(0);
    this.yaw = Math.atan2(-x, -z); // face the center cross
    this.pitch = 0;
    this.health = PlayerController.MAX_HEALTH;
    this.isDead = false;
    this.resetStance();
    this.invulnUntil = this.gameTime + 1.0;
    this.justRespawned = true;
  }

  // Fresh match (Play Again): back to the opening corner with a clean sheet.
  // The bots are re-placed relative to this position right after, so the
  // far-spawn guarantee holds for round two as well.
  public resetForMatch(): void {
    this.position.set(-13.5, 0, -13.5);
    this.velocity.setAll(0);
    this.yaw = Math.atan2(13.5, 13.5);
    this.pitch = 0;
    this.health = PlayerController.MAX_HEALTH;
    this.isDead = false;
    this.resetStance();
    this.deaths = 0;
    this.damageFlash = 0;
    this.respawnTimer = 0;
    this.invulnUntil = this.gameTime + 1.0;
    this.justRespawned = false;
  }

  // True exactly once per respawn — Game uses it to hand back a fresh loadout
  public consumeRespawn(): boolean {
    const r = this.justRespawned;
    this.justRespawned = false;
    return r;
  }

  private resetStance(): void {
    this.crouchToggled = false;
    this.isCrouching = false;
    this.isProne = false;
    this.currentEyeHeight = this.standEyeHeight;
    this.stanceInputWasDown = false;
    this.stanceHoldTime = 0;
    this.stanceHoldTriggeredProne = false;
  }

  // Read-only access for systems that draw the world top-down (minimap)
  public static getObstacles(): ReadonlyArray<{
    cx: number;
    cz: number;
    hw: number;
    hd: number;
    minY: number;
    maxY: number;
    yaw: number;
  }> {
    return this.obstacles;
  }

  public update(deltaTime: number, adsSensitivityMultiplier: number, adsProgress: number): void {
    this.gameTime += deltaTime;

    // 0. Health: blood overlay decays, regen kicks in after a quiet spell,
    // and death freezes the body (and the camera with it) until respawn
    this.damageFlash *= Math.exp(-1.6 * deltaTime);
    if (this.isDead) {
      this.respawnTimer -= deltaTime;
      if (this.respawnTimer > 0) return;
      this.respawn();
    } else if (this.health < PlayerController.MAX_HEALTH && this.gameTime - this.lastDamageAt > PlayerController.REGEN_DELAY) {
      this.health = Math.min(PlayerController.MAX_HEALTH, this.health + PlayerController.REGEN_RATE * deltaTime);
    }

    // 1. Mouse Look (only if pointer is locked, and not feeding the laptop cursor)
    if (this.input.getIsPointerLocked() && !this.lookLocked) {
      const mouseDelta = this.input.getMouseDelta();
      
      // Apply sensitivity multiplier when ADS (aiming down sight)
      const currentSensitivity = this.lookSensitivity * adsSensitivityMultiplier;
      
      this.yaw += mouseDelta.x * currentSensitivity;
      this.pitch += mouseDelta.y * currentSensitivity;
      
      // Clamp pitch to avoid flipping upside down (-85 to +85 degrees)
      const pitchLimit = (85 * Math.PI) / 180;
      this.pitch = Math.max(-pitchLimit, Math.min(pitchLimit, this.pitch));
    }

    // 2. Stance input: tap C/Ctrl to toggle crouch; hold to drop prone.
    const stanceInputDown =
      this.input.isKeyDown("KeyC") ||
      this.input.isKeyDown("ControlLeft") ||
      this.input.isKeyDown("ControlRight");
    const stancePressed = stanceInputDown && !this.stanceInputWasDown;
    const stanceReleased = !stanceInputDown && this.stanceInputWasDown;

    if (stancePressed) {
      this.stanceHoldTime = 0;
      this.stanceHoldTriggeredProne = false;
    }
    if (stanceInputDown) {
      this.stanceHoldTime += deltaTime;
      if (!this.stanceHoldTriggeredProne && this.stanceHoldTime >= PlayerController.PRONE_HOLD_SECONDS) {
        this.isProne = true;
        this.stanceHoldTriggeredProne = true;
      }
    } else if (stanceReleased) {
      if (this.stanceHoldTriggeredProne) {
        this.isProne = false;
      } else {
        this.crouchToggled = !this.crouchToggled;
      }
    }
    this.stanceInputWasDown = stanceInputDown;
    this.isCrouching = this.crouchToggled && !this.isProne;
    
    // Smoothly interpolate eye height using robust exponential decay
    const targetEyeHeight = this.isProne
      ? this.proneEyeHeight
      : this.isCrouching
        ? this.crouchEyeHeight
        : this.standEyeHeight;
    const eyeLerpFactor = 1 - Math.exp(-15 * deltaTime);
    this.currentEyeHeight += (targetEyeHeight - this.currentEyeHeight) * eyeLerpFactor;

    // 3. Movement Physics
    // Get input directions (WASD)
    let moveForward = 0;
    let moveSide = 0;
    if (this.input.isKeyDown("KeyW")) moveForward += 1;
    if (this.input.isKeyDown("KeyS")) moveForward -= 1;
    if (this.input.isKeyDown("KeyA")) moveSide -= 1;
    if (this.input.isKeyDown("KeyD")) moveSide += 1;

    // Sprint (hold Shift): forward movement only, cancelled by crouch and by ADS
    this.isSprinting =
      (this.input.isKeyDown("ShiftLeft") || this.input.isKeyDown("ShiftRight")) &&
      moveForward > 0 &&
      !this.isCrouching &&
      !this.isProne &&
      adsProgress < 0.1;

    // Determine speed
    const currentSpeed = this.isProne
      ? PlayerController.PRONE_SPEED
      : this.isCrouching
        ? PlayerController.CROUCH_SPEED
        : this.isSprinting
          ? PlayerController.SPRINT_SPEED
          : PlayerController.WALK_SPEED;

    // Calculate move direction relative to Yaw
    const forwardX = Math.sin(this.yaw);
    const forwardZ = Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);

    let moveDirectionX = forwardX * moveForward + rightX * moveSide;
    let moveDirectionZ = forwardZ * moveForward + rightZ * moveSide;

    // Normalize movement vector to avoid diagonal speed boost
    const mag = Math.sqrt(moveDirectionX * moveDirectionX + moveDirectionZ * moveDirectionZ);
    if (mag > 0.001) {
      moveDirectionX /= mag;
      moveDirectionZ /= mag;
    }

    // Apply movement velocities
    this.velocity.x = moveDirectionX * currentSpeed;
    this.velocity.z = moveDirectionZ * currentSpeed;

    // Jump Input (Z — Space is the zoom key)
    if (this.input.isKeyPressed("KeyZ") && this.isGrounded && !this.isCrouching && !this.isProne) {
      this.velocity.y = this.jumpForce;
      this.isGrounded = false;
    }

    // Apply gravity
    if (!this.isGrounded) {
      this.velocity.y += PlayerController.GRAVITY * deltaTime;
    }

    // 4. Position update & collisions through the shared solver
    const prevPos = this.tmpPrevPos.copyFrom(this.position);
    const nextPos = this.tmpNextPos;
    this.isGrounded = PlayerController.moveAndCollide(
      prevPos,
      this.velocity,
      deltaTime,
      this.currentEyeHeight + 0.15,
      0.4,
      nextPos
    );
    this.position.copyFrom(nextPos);

    // 5. Update Camera Rig
    const isMoving = mag > 0.001;
    const speedRatio = currentSpeed / PlayerController.WALK_SPEED;
    this.cameraRig.update(deltaTime, isMoving, speedRatio, adsProgress);

    // Apply positions to camera:
    // Eye height + Bobbing + Sway offsets
    const cameraTargetPos = this.tmpCameraPos.copyFrom(this.position);
    cameraTargetPos.y += this.currentEyeHeight;
    cameraTargetPos.addInPlace(this.cameraRig.bobOffset);
    cameraTargetPos.addInPlace(this.cameraRig.swayOffset);

    // Apply kickback along the look direction
    // Direction vector of the camera:
    const lookDirX = Math.sin(this.yaw) * Math.cos(-this.pitch);
    const lookDirY = Math.sin(-this.pitch);
    const lookDirZ = Math.cos(this.yaw) * Math.cos(-this.pitch);
    
    cameraTargetPos.x -= lookDirX * this.cameraRig.recoilKickback;
    cameraTargetPos.y -= lookDirY * this.cameraRig.recoilKickback;
    cameraTargetPos.z -= lookDirZ * this.cameraRig.recoilKickback;

    this.cameraRig.camera.position.copyFrom(cameraTargetPos);
    
    // Camera Rotation: pitch/yaw + recoil (subtract recoilPitch to kick camera UP)
    // + scoped figure-eight sway (affects the actual aim, like holding breath-less)
    this.cameraRig.camera.rotation.x = this.pitch - this.cameraRig.recoilPitch + this.cameraRig.scopeSwayPitch;
    this.cameraRig.camera.rotation.y = this.yaw + this.cameraRig.recoilYaw + this.cameraRig.scopeSwayYaw;
    this.cameraRig.camera.rotation.z = 0;
  }
}
