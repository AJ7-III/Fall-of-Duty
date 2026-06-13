import { Scene, Mesh, Vector3, Ray } from "@babylonjs/core";
import { CameraRig } from "../player/CameraRig";
import { BoltActionSniper } from "../weapons/BoltActionSniper";
import { Mp44 } from "../weapons/Mp44";
import { Pistol } from "../weapons/Pistol";
import type { Weapon, WeaponId } from "../weapons/WeaponTypes";
import { Input } from "../engine/Input";
import { AssetLoader } from "../engine/AssetLoader";

export class ViewModelRig {
  private scene: Scene;
  private cameraRig: CameraRig;

  // Viewmodels live parented to the camera; only one is enabled
  private sniperMesh: Mesh;
  private pistolMesh: Mesh;
  private mp44Mesh: Mesh;
  private weaponMesh: Mesh; // the active one
  private shownId: WeaponId = "m40a3";

  // Sniper animatable parts
  private boltGroup: Mesh | null = null;
  private rightArm: Mesh | null = null;
  private boltBasePos = new Vector3();

  // Pistol animatable parts
  private slideGroup: Mesh | null = null;
  private hammerGroup: Mesh | null = null;
  private magGroup: Mesh | null = null;
  private supportArm: Mesh | null = null;
  private slideBasePos = new Vector3();
  private magBasePos = new Vector3();

  // MP44 animatable parts
  private mp44BoltGroup: Mesh | null = null;
  private mp44MagGroup: Mesh | null = null;
  private mp44SupportArm: Mesh | null = null;
  private mp44BoltBasePos = new Vector3();
  private mp44MagBasePos = new Vector3();

  // Pistol animation constants
  private static readonly SLIDE_TRAVEL = 0.03; // full blowback distance
  private static readonly HAMMER_REST_ROT = -0.55; // carried cocked
  private static readonly HAMMER_KICK_ROT = -0.35; // extra rock under blowback
  // mag exit direction: straight out of the raked grip (rake = +0.3 rad)
  private static readonly MAG_DIR = new Vector3(0, -0.955, -0.296);
  private static readonly MAG_TRAVEL = 0.45; // distance to fully off-hand
  // support-hand anchors during the mag swap
  private static readonly HAND_GRAB = new Vector3(-0.005, -0.045, -0.015); // at the grip heel
  private static readonly HAND_POUCH = new Vector3(-0.05, -0.42, -0.2); // off-screen mag pouch

  private static readonly MP44_BOLT_TRAVEL = 0.045;
  private static readonly MP44_MAG_DIR = new Vector3(0.025, -0.93, -0.32);
  private static readonly MP44_MAG_TRAVEL = 0.5;
  // Group offsets re-anchored for the under-forend rest grip (hand rest pose
  // moved by +0.026/+0.063/+0.028 when the support hand was rebuilt)
  private static readonly MP44_HAND_GRAB = new Vector3(-0.052, -0.135, -0.06);
  private static readonly MP44_HAND_POUCH = new Vector3(-0.121, -0.493, -0.248);
  private static readonly MP44_CHARGE_HANDLE = new Vector3(-0.09, -0.008, -0.008);

  // Death cam / killstreak laptop: the first-person weapon leaves the frame
  private hidden = false;

  // Sway values (mouse look lag)
  private swayX: number = 0;
  private swayY: number = 0;
  private swayRotX: number = 0;
  private swayRotY: number = 0;

  // Bolt poses (rotation around the bolt axis + pull-back travel)
  private static readonly BOLT_REST_ROT = -0.9; // handle down-right
  private static readonly BOLT_OPEN_ROT = 0.15; // handle lifted
  private static readonly BOLT_PULL_Z = -0.085; // travel when cycling

  // Right arm offsets relative to its rest pose
  private static readonly ARM_TO_BOLT = new Vector3(0.025, 0.085, 0.07); // reach up to the handle
  private static readonly ARM_POUCH = new Vector3(0.06, -0.34, -0.16); // down to the chest pouch (off screen)
  private static readonly ARM_PORT = new Vector3(0.015, 0.075, 0.0); // hovering over the open port

  // 0..1 — how far the weapon is tilted inward so the hand work is on screen
  private cycleLift: number = 0;

  // 0..1 — how blocked the muzzle is by world geometry straight ahead
  private blockPull: number = 0;
  private static readonly BLOCK_RAY_RANGE = 1.15; // start reacting inside this distance
  private static readonly BLOCK_RAMP = 0.6; // fully blocked this far inside the range
  private static readonly FORWARD = Vector3.Forward();

  // Reused probe ray — building a Ray + direction vector every frame is GC churn
  private blockRay = new Ray(new Vector3(), new Vector3(0, 0, 1), ViewModelRig.BLOCK_RAY_RANGE);

  // Sprint carry: 0..1 pose blend + stride phase for the pumping motion
  private sprintBlend: number = 0;
  private sprintCycle: number = 0;

  constructor(scene: Scene, cameraRig: CameraRig, loader: AssetLoader) {
    this.scene = scene;
    this.cameraRig = cameraRig;

    // Create procedural viewmodels up front; holstered weapons start disabled
    this.sniperMesh = loader.createSniperMesh(scene);
    this.sniperMesh.parent = cameraRig.camera;

    this.pistolMesh = loader.createPistolMesh(scene);
    this.pistolMesh.parent = cameraRig.camera;
    this.pistolMesh.setEnabled(false);

    this.mp44Mesh = loader.createMp44Mesh(scene);
    this.mp44Mesh.parent = cameraRig.camera;
    this.mp44Mesh.setEnabled(false);

    this.weaponMesh = this.sniperMesh;

    // Find the animatable sub-rigs on each weapon
    for (const child of this.sniperMesh.getChildMeshes()) {
      if (child.name === "boltGroup") {
        this.boltGroup = child as Mesh;
        this.boltBasePos.copyFrom(this.boltGroup.position);
      } else if (child.name === "rightArmGroup") {
        this.rightArm = child as Mesh;
      }
    }

    for (const child of this.pistolMesh.getChildMeshes()) {
      if (child.name === "slideGroup") {
        this.slideGroup = child as Mesh;
        this.slideBasePos.copyFrom(this.slideGroup.position);
      } else if (child.name === "hammerGroup") {
        this.hammerGroup = child as Mesh;
      } else if (child.name === "magGroup") {
        this.magGroup = child as Mesh;
        this.magBasePos.copyFrom(this.magGroup.position);
      } else if (child.name === "supportArmGroup") {
        this.supportArm = child as Mesh;
      }
    }

    for (const child of this.mp44Mesh.getChildMeshes()) {
      if (child.name === "mp44BoltGroup") {
        this.mp44BoltGroup = child as Mesh;
        this.mp44BoltBasePos.copyFrom(this.mp44BoltGroup.position);
      } else if (child.name === "mp44MagGroup") {
        this.mp44MagGroup = child as Mesh;
        this.mp44MagBasePos.copyFrom(this.mp44MagGroup.position);
      } else if (child.name === "mp44SupportArmGroup") {
        this.mp44SupportArm = child as Mesh;
      }
    }
  }

  private static smoothstep(t: number): number {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  // Death cam and the killstreak laptop both take the weapon out of frame.
  // While hidden the rig is not updated, so re-showing re-syncs on the next
  // update call.
  public setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.weaponMesh.setEnabled(!hidden);
  }

  public update(
    deltaTime: number,
    activeWeapon: Weapon,
    input: Input,
    isSprinting: boolean,
    lowerAmount: number = 0
  ): void {
    // 0. Weapon swap: enable the mesh that matches the active weapon
    if (activeWeapon.id !== this.shownId) {
      this.shownId = activeWeapon.id;
      this.weaponMesh.setEnabled(false);
      if (activeWeapon.id === "m40a3") {
        this.weaponMesh = this.sniperMesh;
      } else if (activeWeapon.id === "usp45") {
        this.weaponMesh = this.pistolMesh;
      } else {
        this.weaponMesh = this.mp44Mesh;
      }
      this.weaponMesh.setEnabled(!this.hidden);
    }

    const adsState = activeWeapon.adsAnimator.getInterpolatedState();
    const isPointerLocked = input.getIsPointerLocked();

    // 1. Calculate Weapon Sway based on mouse movement
    let targetSwayX = 0;
    let targetSwayY = 0;
    let targetSwayRotX = 0;
    let targetSwayRotY = 0;

    if (isPointerLocked) {
      const mouseDelta = input.getMouseDelta();

      // Sway is reduced when ADS
      const swayStrength = activeWeapon.isAiming ? 0.02 : 1.0;

      targetSwayX = -mouseDelta.x * 0.00007 * swayStrength;
      targetSwayY = mouseDelta.y * 0.00007 * swayStrength;

      targetSwayRotX = mouseDelta.y * 0.0022 * swayStrength;
      targetSwayRotY = -mouseDelta.x * 0.0022 * swayStrength;
    }

    // Smoothly interpolate sway values using robust exponential decay
    const swaySpeed = activeWeapon.isAiming ? 16 : 22;
    const swayFactor = 1 - Math.exp(-swaySpeed * deltaTime);
    this.swayX += (targetSwayX - this.swayX) * swayFactor;
    this.swayY += (targetSwayY - this.swayY) * swayFactor;
    this.swayRotX += (targetSwayRotX - this.swayRotX) * swayFactor;
    this.swayRotY += (targetSwayRotY - this.swayRotY) * swayFactor;

    // 2. Set Weapon Position
    // Position = ADS interpolated position + Sway + Recoil Kickback Z
    const pos = adsState.position;
    this.weaponMesh.position.set(
      pos[0] + this.swayX,
      pos[1] + this.swayY,
      pos[2] - activeWeapon.visualKickZ // Recoil pushes weapon back
    );

    // 3. Set Weapon Rotation
    // Rotation = ADS interpolated rotation + Sway + Recoil Kickback Pitch
    // Shorter weapons pivot harder around the wrist; the MP44 sits between
    // the pistol snap and the sniper's slower shoulder recoil.
    const rot = adsState.rotation;
    const rotKickFactor = activeWeapon.id === "usp45" ? 1.5 : activeWeapon.id === "mp44" ? 0.78 : 0.4;
    const recoilRotKick = activeWeapon.visualKickZ * rotKickFactor;

    this.weaponMesh.rotation.x = (rot[0] * Math.PI) / 180 + this.swayRotX - recoilRotKick;
    this.weaponMesh.rotation.y = (rot[1] * Math.PI) / 180 + this.swayRotY;
    this.weaponMesh.rotation.z = (rot[2] * Math.PI) / 180;

    // Hide the weapon model once the scope overlay dominates (sniper only —
    // the pistol's irons never raise a scope overlay)
    if (adsState.scopeOpacity >= 0.6) {
      this.weaponMesh.setEnabled(false);
    } else {
      this.weaponMesh.setEnabled(true);
    }

    let liftTarget = 0;

    if (activeWeapon.id === "m40a3") {
      liftTarget = this.updateSniperAnimation(deltaTime, activeWeapon as BoltActionSniper);
    } else if (activeWeapon.id === "mp44") {
      liftTarget = this.updateMp44Animation(deltaTime, activeWeapon as Mp44);
    } else {
      liftTarget = this.updatePistolAnimation(deltaTime, activeWeapon as Pistol);
    }

    // 5. Cycle lift: roll the weapon's working side toward the camera while
    // the hands are busy on it (Fall of Duty weapon handling read)
    this.cycleLift += (liftTarget - this.cycleLift) * (1 - Math.exp(-10 * deltaTime));
    const lift = this.cycleLift;
    if (activeWeapon.id === "m40a3") {
      this.weaponMesh.position.x -= 0.05 * lift;
      this.weaponMesh.position.y += 0.02 * lift;
      this.weaponMesh.position.z -= 0.05 * lift;
      this.weaponMesh.rotation.y += 0.1 * lift; // bring the receiver toward center
      this.weaponMesh.rotation.z += 0.28 * lift; // roll the bolt handle up into view
      this.weaponMesh.rotation.x -= 0.03 * lift; // muzzle tips up slightly
    } else if (activeWeapon.id === "mp44") {
      // MP44 mag swap/charging handle: roll the left-side controls and long mag into view
      this.weaponMesh.position.x -= 0.04 * lift;
      this.weaponMesh.position.y += 0.018 * lift;
      this.weaponMesh.position.z -= 0.045 * lift;
      this.weaponMesh.rotation.y += 0.16 * lift;
      this.weaponMesh.rotation.z += 0.18 * lift;
      this.weaponMesh.rotation.x -= 0.045 * lift;
    } else {
      // pistol mag swap: tip the grip heel toward the camera, muzzle up-left
      this.weaponMesh.position.x -= 0.025 * lift;
      this.weaponMesh.position.y += 0.012 * lift;
      this.weaponMesh.position.z -= 0.03 * lift;
      this.weaponMesh.rotation.y += 0.14 * lift;
      this.weaponMesh.rotation.z += 0.2 * lift;
      this.weaponMesh.rotation.x -= 0.08 * lift;
    }

    // 6. Wall block: probe straight ahead from the camera; when world geometry
    // sits inside the weapon's reach, pull it in and raise the muzzle
    // so it never pokes through obstacles (the viewmodel itself is unpickable,
    // so the ray only sees real scene geometry).
    const camera = this.cameraRig.camera;
    this.blockRay.origin.copyFrom(camera.globalPosition);
    camera.getDirectionToRef(ViewModelRig.FORWARD, this.blockRay.direction);
    const blockHit = this.scene.pickWithRay(this.blockRay);
    let blockTarget = 0;
    if (blockHit && blockHit.hit) {
      blockTarget = Math.min(
        1,
        (ViewModelRig.BLOCK_RAY_RANGE - blockHit.distance) / ViewModelRig.BLOCK_RAMP
      );
    }
    // The pistol is short — it only reacts when the wall is right in the face
    if (activeWeapon.id === "usp45") {
      blockTarget = Math.max(0, blockTarget - 0.45) / 0.55;
    } else if (activeWeapon.id === "mp44") {
      blockTarget *= 0.9;
    }
    // The scope overlay owns the screen during ADS — don't fight the centering
    blockTarget *= 1 - activeWeapon.adsAnimator.getProgress();
    this.blockPull += (blockTarget - this.blockPull) * (1 - Math.exp(-10 * deltaTime));
    const block = this.blockPull;
    this.weaponMesh.position.z -= 0.38 * block; // tuck the weapon in
    this.weaponMesh.position.y -= 0.05 * block;
    this.weaponMesh.rotation.x -= 1.0 * block; // raise the muzzle skyward
    this.weaponMesh.rotation.y += 0.12 * block;

    // 7. Sprint carry: the weapon drops low across the body with
    // the muzzle swung up-left, pumping in rhythm with the stride. Yields to
    // ADS and to the wall-block pose so the layers never over-rotate.
    const sprintTarget = isSprinting ? 1 : 0;
    this.sprintBlend += (sprintTarget - this.sprintBlend) * (1 - Math.exp(-8 * deltaTime));
    const sprint =
      this.sprintBlend * (1 - this.blockPull) * (1 - activeWeapon.adsAnimator.getProgress());
    if (sprint > 0.001) {
      this.sprintCycle += deltaTime * 18.6; // matches the sprint footstep cadence
      const pump = Math.sin(this.sprintCycle) * 0.012; // vertical jolt per step
      const sway = Math.sin(this.sprintCycle * 0.5) * 0.02; // alternating stride sway
      this.weaponMesh.position.x += (-0.055 + sway) * sprint;
      this.weaponMesh.position.y += (-0.115 + pump) * sprint;
      this.weaponMesh.position.z -= 0.16 * sprint;
      this.weaponMesh.rotation.x -= (0.62 - pump * 1.5) * sprint; // muzzle swings up
      this.weaponMesh.rotation.y += 0.38 * sprint; // barrel angles across the body
      this.weaponMesh.rotation.z += 0.3 * sprint; // grip rolls inward
    } else {
      this.sprintCycle = 0;
    }

    // 8. Weapon switch: the whole viewmodel dips below the screen edge while
    // the hands trade weapons, then rises with the next one
    if (lowerAmount > 0.001) {
      const drop = ViewModelRig.smoothstep(lowerAmount);
      this.weaponMesh.position.y -= 0.45 * drop;
      this.weaponMesh.position.z -= 0.08 * drop;
      this.weaponMesh.rotation.x -= 1.0 * drop; // muzzle dips away
      this.weaponMesh.rotation.z += 0.18 * drop;
    }
  }

  // --- Sniper: procedural bolt cycle + bolt-action reload (unchanged) ---
  // Returns the lift target (how far the rifle rolls in toward the camera).
  private updateSniperAnimation(deltaTime: number, activeWeapon: BoltActionSniper): number {
    // Targets computed per state, then either set directly (mid-cycle, already
    // continuous) or eased toward (state transitions) so nothing pops.
    let boltRot = ViewModelRig.BOLT_REST_ROT;
    let boltZ = 0;
    let armX = 0, armY = 0, armZ = 0;
    let animatedDirectly = false;
    let liftTarget = 0;

    if (activeWeapon.state === "cycling") {
      const timer = activeWeapon.timer;
      const total = activeWeapon.config.boltCycleDuration;

      // Hand+bolt work spans from timer = total-0.3 down to 0.3 (0.6s window)
      const cycleStart = total - 0.3;
      const cycleEnd = 0.3;

      if (timer < cycleStart && timer > cycleEnd) {
        const p = (cycleStart - timer) / (cycleStart - cycleEnd); // 0 to 1
        const reach = ViewModelRig.ARM_TO_BOLT;
        const s = ViewModelRig.smoothstep;
        let grab = 0; // how far the hand is from grip (0) to bolt handle (1)

        if (p < 0.18) {
          // Reach up from the grip to the bolt handle
          grab = s(p / 0.18);
        } else if (p < 0.38) {
          // Rotate the bolt open (hand stays on the handle)
          grab = 1;
          const t = s((p - 0.18) / 0.2);
          boltRot = ViewModelRig.BOLT_REST_ROT + (ViewModelRig.BOLT_OPEN_ROT - ViewModelRig.BOLT_REST_ROT) * t;
        } else if (p < 0.56) {
          // Pull the bolt back — ejects the spent case
          grab = 1;
          boltRot = ViewModelRig.BOLT_OPEN_ROT;
          boltZ = ViewModelRig.BOLT_PULL_Z * s((p - 0.38) / 0.18);
        } else if (p < 0.74) {
          // Push forward — chambers the next round
          grab = 1;
          boltRot = ViewModelRig.BOLT_OPEN_ROT;
          boltZ = ViewModelRig.BOLT_PULL_Z * (1 - s((p - 0.56) / 0.18));
        } else {
          // Rotate closed and return the hand to the grip
          const t = s((p - 0.74) / 0.26);
          grab = 1 - t;
          boltRot = ViewModelRig.BOLT_OPEN_ROT + (ViewModelRig.BOLT_REST_ROT - ViewModelRig.BOLT_OPEN_ROT) * t;
        }

        armX = reach.x * grab;
        armY = reach.y * grab;
        armZ = reach.z * grab + boltZ * grab; // hand rides the bolt as it slides
        liftTarget = grab; // rifle tips inward while the hand is on the bolt

        if (this.boltGroup) {
          this.boltGroup.rotation.z = boltRot;
          this.boltGroup.position.set(this.boltBasePos.x, this.boltBasePos.y, this.boltBasePos.z + boltZ);
        }
        if (this.rightArm) {
          this.rightArm.position.set(armX, armY, armZ);
        }
        animatedDirectly = true;
      }
    } else if (activeWeapon.state === "reloading") {
      // Full bolt-action reload: open the bolt, feed rounds one at a time
      // through the open port into the internal magazine, run the bolt home.
      // Mirrors the timeline in BoltActionSniper so sounds/ammo stay in sync.
      const tOpen = BoltActionSniper.RELOAD_OPEN;
      const tPer = BoltActionSniper.RELOAD_PER_ROUND;
      const tClose = BoltActionSniper.RELOAD_CLOSE;
      const elapsed = Math.max(0, activeWeapon.reloadTotal - activeWeapon.timer);
      const feedEnd = activeWeapon.reloadTotal - tClose;
      const s = ViewModelRig.smoothstep;
      const reach = ViewModelRig.ARM_TO_BOLT;
      const pouch = ViewModelRig.ARM_POUCH;
      const port = ViewModelRig.ARM_PORT;

      // Hand anchors: the pulled-back bolt handle, and the press-down point
      // where the round gets pushed into the magazine
      const handleZ = reach.z + ViewModelRig.BOLT_PULL_Z;
      const pressX = port.x;
      const pressY = port.y - 0.025;
      const pressZ = port.z + 0.045;

      if (elapsed < tOpen) {
        // Phase 1 — open the action: reach up, rotate the handle, draw back
        const p = elapsed / tOpen;
        const grab = s(Math.min(1, p / 0.35));
        armX = reach.x * grab;
        armY = reach.y * grab;
        armZ = reach.z * grab;
        if (p >= 0.7) {
          boltRot = ViewModelRig.BOLT_OPEN_ROT;
          boltZ = ViewModelRig.BOLT_PULL_Z * s((p - 0.7) / 0.3);
          armZ += boltZ; // hand rides the bolt back
        } else if (p >= 0.35) {
          boltRot = ViewModelRig.BOLT_REST_ROT +
            (ViewModelRig.BOLT_OPEN_ROT - ViewModelRig.BOLT_REST_ROT) * s((p - 0.35) / 0.35);
        }
        liftTarget = grab;
      } else if (elapsed < feedEnd) {
        // Phase 2 — feed rounds: dip to the pouch, bring the round up to the
        // open port, press it down into the magazine; once per round
        boltRot = ViewModelRig.BOLT_OPEN_ROT;
        boltZ = ViewModelRig.BOLT_PULL_Z;
        liftTarget = 1;

        const sinceFeed = elapsed - tOpen;
        const round = Math.min(activeWeapon.reloadRounds - 1, Math.floor(sinceFeed / tPer));
        const t01 = (sinceFeed - round * tPer) / tPer;
        // First trip leaves from the bolt handle, later trips from the press point
        const fromX = round === 0 ? reach.x : pressX;
        const fromY = round === 0 ? reach.y : pressY;
        const fromZ = round === 0 ? handleZ : pressZ;

        if (t01 < 0.38) {
          const t = s(t01 / 0.38);
          armX = fromX + (pouch.x - fromX) * t;
          armY = fromY + (pouch.y - fromY) * t;
          armZ = fromZ + (pouch.z - fromZ) * t;
        } else if (t01 < 0.72) {
          const t = s((t01 - 0.38) / 0.34);
          armX = pouch.x + (port.x - pouch.x) * t;
          armY = pouch.y + (port.y - pouch.y) * t;
          armZ = pouch.z + (port.z - pouch.z) * t;
        } else if (t01 < 0.88) {
          const t = s((t01 - 0.72) / 0.16);
          armX = port.x + (pressX - port.x) * t;
          armY = port.y + (pressY - port.y) * t;
          armZ = port.z + (pressZ - port.z) * t;
        } else {
          armX = pressX;
          armY = pressY;
          armZ = pressZ;
        }
      } else {
        // Phase 3 — close the action: back to the handle, run the bolt
        // forward, lock the handle down, return to the grip
        const q = Math.min(1, (elapsed - feedEnd) / tClose);
        boltRot = ViewModelRig.BOLT_OPEN_ROT;
        boltZ = ViewModelRig.BOLT_PULL_Z;
        if (q < 0.28) {
          const t = s(q / 0.28);
          armX = pressX + (reach.x - pressX) * t;
          armY = pressY + (reach.y - pressY) * t;
          armZ = pressZ + (handleZ - pressZ) * t;
        } else if (q < 0.55) {
          boltZ = ViewModelRig.BOLT_PULL_Z * (1 - s((q - 0.28) / 0.27));
          armX = reach.x;
          armY = reach.y;
          armZ = reach.z + boltZ;
        } else if (q < 0.8) {
          boltZ = 0;
          boltRot = ViewModelRig.BOLT_OPEN_ROT +
            (ViewModelRig.BOLT_REST_ROT - ViewModelRig.BOLT_OPEN_ROT) * s((q - 0.55) / 0.25);
          armX = reach.x;
          armY = reach.y;
          armZ = reach.z;
        } else {
          boltZ = 0;
          boltRot = ViewModelRig.BOLT_REST_ROT;
          const g = 1 - s((q - 0.8) / 0.2);
          armX = reach.x * g;
          armY = reach.y * g;
          armZ = reach.z * g;
        }
        liftTarget = q < 0.8 ? 1 : 1 - s((q - 0.8) / 0.2);
      }

      if (this.boltGroup) {
        this.boltGroup.rotation.z = boltRot;
        this.boltGroup.position.set(this.boltBasePos.x, this.boltBasePos.y, this.boltBasePos.z + boltZ);
      }
      if (this.rightArm) {
        this.rightArm.position.set(armX, armY, armZ);
      }
      animatedDirectly = true;
    }

    if (!animatedDirectly) {
      // Ease toward the target pose (rest or reload) — smooth, no pops
      const k = 1 - Math.exp(-14 * deltaTime);
      if (this.boltGroup) {
        this.boltGroup.rotation.z += (boltRot - this.boltGroup.rotation.z) * k;
        this.boltGroup.position.z += (this.boltBasePos.z - this.boltGroup.position.z) * k;
      }
      if (this.rightArm) {
        this.rightArm.position.x += (armX - this.rightArm.position.x) * k;
        this.rightArm.position.y += (armY - this.rightArm.position.y) * k;
        this.rightArm.position.z += (armZ - this.rightArm.position.z) * k;
      }
    }

    return liftTarget;
  }

  // --- MP44: reciprocating bolt/charging handle, curved-mag reload, support
  // hand leaving the fore-end to run the magazine and empty-reload charge.
  private updateMp44Animation(deltaTime: number, weapon: Mp44): number {
    const s = ViewModelRig.smoothstep;
    let boltBack = weapon.getBoltBack();
    let armX = 0, armY = 0, armZ = 0;
    let magDist = 0;
    let magVisible = true;
    let liftTarget = 0;
    let animatedDirectly = false;

    if (weapon.state === "reloading") {
      const elapsed = Math.max(0, weapon.reloadTotal - weapon.timer);
      const grab = ViewModelRig.MP44_HAND_GRAB;
      const pouch = ViewModelRig.MP44_HAND_POUCH;
      const charge = ViewModelRig.MP44_CHARGE_HANDLE;
      animatedDirectly = true;

      if (elapsed < Mp44.MAG_OUT_AT) {
        const t = s(elapsed / Mp44.MAG_OUT_AT);
        armX = grab.x * t;
        armY = grab.y * t;
        armZ = grab.z * t;
        liftTarget = 0.7 * t;
      } else if (elapsed < Mp44.MAG_DOWN_AT) {
        const t = s((elapsed - Mp44.MAG_OUT_AT) / (Mp44.MAG_DOWN_AT - Mp44.MAG_OUT_AT));
        armX = grab.x + (pouch.x - grab.x) * t;
        armY = grab.y + (pouch.y - grab.y) * t;
        armZ = grab.z + (pouch.z - grab.z) * t;
        magDist = ViewModelRig.MP44_MAG_TRAVEL * t;
        magVisible = t < 0.82;
        liftTarget = 0.8;
      } else if (elapsed < Mp44.MAG_IN_AT) {
        const t = s((elapsed - Mp44.MAG_DOWN_AT) / (Mp44.MAG_IN_AT - Mp44.MAG_DOWN_AT));
        armX = pouch.x + (grab.x - pouch.x) * t;
        armY = pouch.y + (grab.y - pouch.y) * t;
        armZ = pouch.z + (grab.z - pouch.z) * t;
        magDist = ViewModelRig.MP44_MAG_TRAVEL * (1 - t);
        magVisible = t > 0.18;
        liftTarget = 0.8;
      } else if (weapon.isEmptyReload()) {
        const q = Math.max(0, (elapsed - Mp44.MAG_IN_AT) / (weapon.reloadTotal - Mp44.MAG_IN_AT));
        if (elapsed < Mp44.CHARGE_START_AT) {
          armX = grab.x;
          armY = grab.y;
          armZ = grab.z;
          liftTarget = 0.8;
        } else if (q < 0.34) {
          const t = s(q / 0.34);
          armX = grab.x + (charge.x - grab.x) * t;
          armY = grab.y + (charge.y - grab.y) * t;
          armZ = grab.z + (charge.z - grab.z) * t;
          liftTarget = 0.85;
        } else if (q < 0.62) {
          const t = s((q - 0.34) / 0.28);
          armX = charge.x - 0.015 * t;
          armY = charge.y;
          armZ = charge.z - 0.055 * t;
          boltBack = Math.max(boltBack, t);
          liftTarget = 0.9;
        } else if (q < 0.78) {
          const t = s((q - 0.62) / 0.16);
          armX = charge.x - 0.015 * (1 - t);
          armY = charge.y;
          armZ = charge.z - 0.055 * (1 - t);
          boltBack = Math.max(boltBack, 1 - t);
          liftTarget = 0.85;
        } else {
          const t = s((q - 0.78) / 0.22);
          armX = charge.x * (1 - t);
          armY = charge.y * (1 - t);
          armZ = charge.z * (1 - t);
          liftTarget = 0.85 * (1 - t);
        }
      } else {
        const t = s((elapsed - Mp44.MAG_IN_AT) / (weapon.reloadTotal - Mp44.MAG_IN_AT));
        armX = grab.x * (1 - t);
        armY = grab.y * (1 - t);
        armZ = grab.z * (1 - t);
        liftTarget = 0.75 * (1 - t);
      }
    }

    if (this.mp44BoltGroup) {
      this.mp44BoltGroup.position.set(
        this.mp44BoltBasePos.x,
        this.mp44BoltBasePos.y,
        this.mp44BoltBasePos.z - ViewModelRig.MP44_BOLT_TRAVEL * boltBack
      );
    }

    if (this.mp44MagGroup) {
      this.mp44MagGroup.setEnabled(magVisible);
      this.mp44MagGroup.position.set(
        this.mp44MagBasePos.x + ViewModelRig.MP44_MAG_DIR.x * magDist,
        this.mp44MagBasePos.y + ViewModelRig.MP44_MAG_DIR.y * magDist,
        this.mp44MagBasePos.z + ViewModelRig.MP44_MAG_DIR.z * magDist
      );
    }

    if (this.mp44SupportArm) {
      if (animatedDirectly) {
        this.mp44SupportArm.position.set(armX, armY, armZ);
      } else {
        const k = 1 - Math.exp(-14 * deltaTime);
        this.mp44SupportArm.position.x += (0 - this.mp44SupportArm.position.x) * k;
        this.mp44SupportArm.position.y += (0 - this.mp44SupportArm.position.y) * k;
        this.mp44SupportArm.position.z += (0 - this.mp44SupportArm.position.z) * k;
      }
    }

    return liftTarget;
  }

  // --- Pistol: slide blowback, hammer rock, and the mag-swap reload where
  // the support hand drops the spent mag and slaps a fresh one home.
  // Returns the lift target (how far the pistol rolls in toward the camera).
  private updatePistolAnimation(deltaTime: number, weapon: Pistol): number {
    const s = ViewModelRig.smoothstep;

    // Slide rides its blowback value every frame; the lock-back on an empty
    // mag and the slam home on slide release both come through getSlideBack()
    const slideBack = weapon.getSlideBack();
    if (this.slideGroup) {
      this.slideGroup.position.set(
        this.slideBasePos.x,
        this.slideBasePos.y,
        this.slideBasePos.z - ViewModelRig.SLIDE_TRAVEL * slideBack
      );
    }
    if (this.hammerGroup) {
      this.hammerGroup.rotation.x =
        ViewModelRig.HAMMER_REST_ROT + ViewModelRig.HAMMER_KICK_ROT * slideBack;
    }

    let armX = 0, armY = 0, armZ = 0;
    let magDist = 0;
    let magVisible = true;
    let liftTarget = 0;
    let animatedDirectly = false;

    if (weapon.state === "reloading") {
      const elapsed = Math.max(0, weapon.reloadTotal - weapon.timer);
      const grab = ViewModelRig.HAND_GRAB;
      const pouch = ViewModelRig.HAND_POUCH;
      animatedDirectly = true;

      if (elapsed < Pistol.MAG_OUT_AT) {
        // Phase A — support hand slides from the wrap grip down to the mag
        const t = s(elapsed / Pistol.MAG_OUT_AT);
        armX = grab.x * t;
        armY = grab.y * t;
        armZ = grab.z * t;
        liftTarget = 0.75 * t;
      } else if (elapsed < Pistol.MAG_DOWN_AT) {
        // Phase B — mag release: hand and spent mag drop toward the pouch
        const t = s((elapsed - Pistol.MAG_OUT_AT) / (Pistol.MAG_DOWN_AT - Pistol.MAG_OUT_AT));
        armX = grab.x + (pouch.x - grab.x) * t;
        armY = grab.y + (pouch.y - grab.y) * t;
        armZ = grab.z + (pouch.z - grab.z) * t;
        magDist = ViewModelRig.MAG_TRAVEL * t;
        magVisible = t < 0.8; // gone once it's clearly off the gun
        liftTarget = 0.75;
      } else if (elapsed < Pistol.MAG_IN_AT) {
        // Phase C — fresh mag rides the hand back up and seats in the grip
        const t = s((elapsed - Pistol.MAG_DOWN_AT) / (Pistol.MAG_IN_AT - Pistol.MAG_DOWN_AT));
        armX = pouch.x + (grab.x - pouch.x) * t;
        armY = pouch.y + (grab.y - pouch.y) * t;
        armZ = pouch.z + (grab.z - pouch.z) * t;
        magDist = ViewModelRig.MAG_TRAVEL * (1 - t);
        magVisible = t > 0.2;
        liftTarget = 0.75;
      } else {
        // Phase D — heel of the hand smacks the base, then wraps the grip
        // again (slide release fires inside this window when it was locked)
        const t = s((elapsed - Pistol.MAG_IN_AT) / (weapon.reloadTotal - Pistol.MAG_IN_AT));
        armX = grab.x * (1 - t);
        armY = grab.y * (1 - t);
        armZ = grab.z * (1 - t);
        liftTarget = 0.75 * (1 - t);
      }
    }

    if (this.magGroup) {
      this.magGroup.setEnabled(magVisible);
      this.magGroup.position.set(
        this.magBasePos.x + ViewModelRig.MAG_DIR.x * magDist,
        this.magBasePos.y + ViewModelRig.MAG_DIR.y * magDist,
        this.magBasePos.z + ViewModelRig.MAG_DIR.z * magDist
      );
    }

    if (this.supportArm) {
      if (animatedDirectly) {
        this.supportArm.position.set(armX, armY, armZ);
      } else {
        // Ease back to the two-handed wrap (covers reload cancel on swap)
        const k = 1 - Math.exp(-14 * deltaTime);
        this.supportArm.position.x += (0 - this.supportArm.position.x) * k;
        this.supportArm.position.y += (0 - this.supportArm.position.y) * k;
        this.supportArm.position.z += (0 - this.supportArm.position.z) * k;
      }
    }

    return liftTarget;
  }
}
