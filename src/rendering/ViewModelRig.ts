import { Ray, TransformNode, Vector3 } from "@babylonjs/core";
import type { Scene, Mesh } from "@babylonjs/core";
import type { CameraRig } from "../player/CameraRig";
import { BoltActionSniper } from "../weapons/BoltActionSniper";
import { Mp44 } from "../weapons/Mp44";
import { Pistol } from "../weapons/Pistol";
import type { Weapon, WeaponId } from "../weapons/WeaponTypes";
import type { Input } from "../engine/Input";
import { buildSniperViewModel } from "../viewmodels/SniperViewModel";
import { buildPistolViewModel } from "../viewmodels/PistolViewModel";
import { buildMp44ViewModel } from "../viewmodels/Mp44ViewModel";
import { ArmsRig } from "../viewmodels/ArmsRig";
import type { WeaponViewModel } from "../viewmodels/kit";

// The first-person presentation layer: places the active weapon under the
// camera (ADS keyframes + mouse sway + recoil + sprint carry + wall block +
// swap dip), drives each weapon's mechanical parts through its state
// machine, and moves the hand anchors the skinned arms chase — so a reload
// animation is "where do the hands go", and the arms follow.
export class ViewModelRig {
  private scene: Scene;
  private cameraRig: CameraRig;
  private models: Record<WeaponId, WeaponViewModel>;
  private shown: WeaponViewModel;
  private shownId: WeaponId = "m40a3";
  public readonly arms: ArmsRig;
  // Everything first-person hangs off this camera-parented pivot. It sits at
  // identity in play; dev tooling turns it to inspect the hands from the side.
  public readonly pivot: TransformNode;

  // Bolt-rifle pivots (rest offsets captured at build)
  private boltBasePos = new Vector3();
  // Pistol pivots
  private slideBasePos = new Vector3();
  private magBasePos = new Vector3();
  // MP44 pivots
  private mp44BoltBasePos = new Vector3();
  private mp44MagBasePos = new Vector3();

  // Pistol animation constants
  private static readonly SLIDE_TRAVEL = 0.03; // full blowback distance
  private static readonly HAMMER_REST_ROT = -0.55; // carried cocked
  private static readonly HAMMER_KICK_ROT = -0.35; // extra rock under blowback
  // mag exit direction: straight out of the raked grip (rake = +0.3 rad)
  private static readonly MAG_DIR = new Vector3(0, -0.955, -0.296);
  private static readonly MAG_TRAVEL = 0.45; // distance to fully off-hand
  // support-hand travel during the mag swap (offsets from its wrap grip)
  private static readonly HAND_GRAB = new Vector3(-0.005, -0.045, -0.015); // at the grip heel
  private static readonly HAND_POUCH = new Vector3(-0.05, -0.42, -0.2); // off-screen mag pouch

  private static readonly MP44_BOLT_TRAVEL = 0.045;
  private static readonly MP44_MAG_DIR = new Vector3(0.025, -0.93, -0.32);
  private static readonly MP44_MAG_TRAVEL = 0.5;
  private static readonly MP44_HAND_GRAB = new Vector3(-0.052, -0.135, -0.06);
  private static readonly MP44_HAND_POUCH = new Vector3(-0.121, -0.493, -0.248);
  private static readonly MP44_CHARGE_HANDLE = new Vector3(-0.09, -0.008, -0.008);

  // Bolt poses (rotation around the bolt axis + pull-back travel)
  private static readonly BOLT_REST_ROT = -0.9; // handle down-right
  private static readonly BOLT_OPEN_ROT = 0.15; // handle lifted
  private static readonly BOLT_PULL_Z = -0.085; // travel when cycling

  // Trigger-hand travel while working the bolt: the anchor's alternate pose
  // puts the hand on the handle; these are the extra offsets from there
  private static readonly ARM_POUCH = new Vector3(0.06, -0.34, -0.16); // down to the chest pouch (off screen)
  private static readonly ARM_PORT = new Vector3(0.015, 0.075, 0.0); // hovering over the open port

  // Death cam / killstreak laptop: the first-person weapon leaves the frame
  private hidden = false;

  // Sway values (mouse look lag)
  private swayX = 0;
  private swayY = 0;
  private swayRotX = 0;
  private swayRotY = 0;

  // 0..1 — how far the weapon is tilted inward so the hand work is on screen
  private cycleLift = 0;

  // 0..1 — how blocked the muzzle is by world geometry straight ahead
  private blockPull = 0;
  private static readonly BLOCK_RAY_RANGE = 1.15; // start reacting inside this distance
  private static readonly BLOCK_RAMP = 0.6; // fully blocked this far inside the range
  private static readonly FORWARD = Vector3.Forward();

  // Reused probe ray — building a Ray + direction vector every frame is GC churn
  private blockRay = new Ray(new Vector3(), new Vector3(0, 0, 1), ViewModelRig.BLOCK_RAY_RANGE);

  // Sprint carry: 0..1 pose blend + stride phase for the pumping motion
  private sprintBlend = 0;
  private sprintCycle = 0;

  constructor(scene: Scene, cameraRig: CameraRig) {
    this.scene = scene;
    this.cameraRig = cameraRig;

    this.pivot = new TransformNode("viewmodelPivot", scene);
    this.pivot.parent = cameraRig.camera;
    this.models = {
      m40a3: buildSniperViewModel(scene),
      usp45: buildPistolViewModel(scene),
      mp44: buildMp44ViewModel(scene),
    };
    for (const vm of Object.values(this.models)) {
      vm.root.parent = this.pivot;
      vm.root.setEnabled(false);
    }
    this.shown = this.models.m40a3;
    this.shown.root.setEnabled(true);

    this.boltBasePos.copyFrom(this.models.m40a3.pivots.boltGroup.position);
    this.slideBasePos.copyFrom(this.models.usp45.pivots.slideGroup.position);
    this.magBasePos.copyFrom(this.models.usp45.pivots.magGroup.position);
    this.mp44BoltBasePos.copyFrom(this.models.mp44.pivots.boltGroup.position);
    this.mp44MagBasePos.copyFrom(this.models.mp44.pivots.magGroup.position);

    this.arms = new ArmsRig(scene, this.pivot);
    this.arms.setAnchors(this.shown.hands.left, this.shown.hands.right);
  }

  private static smoothstep(t: number): number {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  private get weaponMesh(): Mesh {
    return this.shown.root;
  }

  // Death cam and the killstreak laptop both take the weapon out of frame.
  // While hidden the rig is not updated, so re-showing re-syncs on the next
  // update call.
  public setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.weaponMesh.setEnabled(!hidden);
    this.arms.setHidden(hidden);
  }

  public update(deltaTime: number, activeWeapon: Weapon, input: Input, isSprinting: boolean, lowerAmount: number = 0): void {
    // 0. Weapon swap: enable the model that matches the active weapon
    if (activeWeapon.id !== this.shownId) {
      this.shownId = activeWeapon.id;
      this.shown.root.setEnabled(false);
      this.shown = this.models[activeWeapon.id];
      this.shown.root.setEnabled(!this.hidden);
      this.arms.setAnchors(this.shown.hands.left, this.shown.hands.right);
    }
    const weaponMesh = this.weaponMesh;

    const adsState = activeWeapon.adsAnimator.getInterpolatedState();
    const isPointerLocked = input.getIsPointerLocked();

    // 1. Weapon sway from mouse movement (reduced while aiming)
    let targetSwayX = 0;
    let targetSwayY = 0;
    let targetSwayRotX = 0;
    let targetSwayRotY = 0;
    if (isPointerLocked) {
      const mouseDelta = input.getMouseDelta();
      const swayStrength = activeWeapon.isAiming ? 0.02 : 1.0;
      targetSwayX = -mouseDelta.x * 0.00007 * swayStrength;
      targetSwayY = mouseDelta.y * 0.00007 * swayStrength;
      targetSwayRotX = mouseDelta.y * 0.0022 * swayStrength;
      targetSwayRotY = -mouseDelta.x * 0.0022 * swayStrength;
    }
    const swaySpeed = activeWeapon.isAiming ? 16 : 22;
    const swayFactor = 1 - Math.exp(-swaySpeed * deltaTime);
    this.swayX += (targetSwayX - this.swayX) * swayFactor;
    this.swayY += (targetSwayY - this.swayY) * swayFactor;
    this.swayRotX += (targetSwayRotX - this.swayRotX) * swayFactor;
    this.swayRotY += (targetSwayRotY - this.swayRotY) * swayFactor;

    // 2. Position = ADS keyframe + sway + recoil kickback
    const pos = adsState.position;
    weaponMesh.position.set(pos[0] + this.swayX, pos[1] + this.swayY, pos[2] - activeWeapon.visualKickZ);

    // 3. Rotation = ADS keyframe + sway + recoil pitch. Shorter weapons pivot
    // harder around the wrist; the MP44 sits between the pistol snap and the
    // sniper's slower shoulder recoil.
    const rot = adsState.rotation;
    const rotKickFactor = activeWeapon.id === "usp45" ? 1.5 : activeWeapon.id === "mp44" ? 0.78 : 0.4;
    const recoilRotKick = activeWeapon.visualKickZ * rotKickFactor;
    weaponMesh.rotation.x = (rot[0] * Math.PI) / 180 + this.swayRotX - recoilRotKick;
    weaponMesh.rotation.y = (rot[1] * Math.PI) / 180 + this.swayRotY;
    weaponMesh.rotation.z = (rot[2] * Math.PI) / 180;

    // Hide the weapon once the scope overlay dominates (sniper only — the
    // pistol's irons never raise a scope overlay)
    const scoped = adsState.scopeOpacity >= 0.6;
    weaponMesh.setEnabled(!scoped);
    this.arms.setHidden(this.hidden || scoped);

    // 4. Mechanical animation per weapon; returns how far to roll the
    // working side toward the camera
    let liftTarget = 0;
    if (activeWeapon.id === "m40a3") {
      liftTarget = this.updateSniperAnimation(deltaTime, activeWeapon as BoltActionSniper);
    } else if (activeWeapon.id === "mp44") {
      liftTarget = this.updateMp44Animation(deltaTime, activeWeapon as Mp44);
    } else {
      liftTarget = this.updatePistolAnimation(deltaTime, activeWeapon as Pistol);
    }

    // 5. Cycle lift: roll the weapon's working side toward the camera while
    // the hands are busy on it
    this.cycleLift += (liftTarget - this.cycleLift) * (1 - Math.exp(-10 * deltaTime));
    const lift = this.cycleLift;
    if (activeWeapon.id === "m40a3") {
      weaponMesh.position.x -= 0.05 * lift;
      weaponMesh.position.y += 0.02 * lift;
      weaponMesh.position.z -= 0.05 * lift;
      weaponMesh.rotation.y += 0.1 * lift; // bring the receiver toward center
      weaponMesh.rotation.z += 0.28 * lift; // roll the bolt handle up into view
      weaponMesh.rotation.x -= 0.03 * lift; // muzzle tips up slightly
    } else if (activeWeapon.id === "mp44") {
      weaponMesh.position.x -= 0.04 * lift;
      weaponMesh.position.y += 0.018 * lift;
      weaponMesh.position.z -= 0.045 * lift;
      weaponMesh.rotation.y += 0.16 * lift;
      weaponMesh.rotation.z += 0.18 * lift;
      weaponMesh.rotation.x -= 0.045 * lift;
    } else {
      weaponMesh.position.x -= 0.025 * lift;
      weaponMesh.position.y += 0.012 * lift;
      weaponMesh.position.z -= 0.03 * lift;
      weaponMesh.rotation.y += 0.14 * lift;
      weaponMesh.rotation.z += 0.2 * lift;
      weaponMesh.rotation.x -= 0.08 * lift;
    }

    // 6. Wall block: probe straight ahead from the camera; when world geometry
    // sits inside the weapon's reach, pull it in and raise the muzzle so it
    // never pokes through obstacles (the viewmodel itself is unpickable, so
    // the ray only sees real scene geometry)
    const camera = this.cameraRig.camera;
    this.blockRay.origin.copyFrom(camera.globalPosition);
    camera.getDirectionToRef(ViewModelRig.FORWARD, this.blockRay.direction);
    const blockHit = this.scene.pickWithRay(this.blockRay);
    let blockTarget = 0;
    if (blockHit && blockHit.hit) {
      blockTarget = Math.min(1, (ViewModelRig.BLOCK_RAY_RANGE - blockHit.distance) / ViewModelRig.BLOCK_RAMP);
    }
    if (activeWeapon.id === "usp45") {
      blockTarget = Math.max(0, blockTarget - 0.45) / 0.55; // short gun: only right in the face
    } else if (activeWeapon.id === "mp44") {
      blockTarget *= 0.9;
    }
    blockTarget *= 1 - activeWeapon.adsAnimator.getProgress(); // the scope owns the screen during ADS
    this.blockPull += (blockTarget - this.blockPull) * (1 - Math.exp(-10 * deltaTime));
    const block = this.blockPull;
    weaponMesh.position.z -= 0.38 * block;
    weaponMesh.position.y -= 0.05 * block;
    weaponMesh.rotation.x -= 1.0 * block; // raise the muzzle skyward
    weaponMesh.rotation.y += 0.12 * block;

    // 7. Sprint carry: the weapon drops low across the body with the muzzle
    // swung up-left, pumping in rhythm with the stride. Yields to ADS and to
    // the wall-block pose so the layers never over-rotate.
    const sprintTarget = isSprinting ? 1 : 0;
    this.sprintBlend += (sprintTarget - this.sprintBlend) * (1 - Math.exp(-8 * deltaTime));
    const sprint = this.sprintBlend * (1 - this.blockPull) * (1 - activeWeapon.adsAnimator.getProgress());
    if (sprint > 0.001) {
      this.sprintCycle += deltaTime * 18.6; // matches the sprint footstep cadence
      const pump = Math.sin(this.sprintCycle) * 0.012;
      const sway = Math.sin(this.sprintCycle * 0.5) * 0.02;
      weaponMesh.position.x += (-0.055 + sway) * sprint;
      weaponMesh.position.y += (-0.115 + pump) * sprint;
      weaponMesh.position.z -= 0.16 * sprint;
      weaponMesh.rotation.x -= (0.62 - pump * 1.5) * sprint;
      weaponMesh.rotation.y += 0.38 * sprint;
      weaponMesh.rotation.z += 0.3 * sprint;
    } else {
      this.sprintCycle = 0;
    }

    // 8. Weapon switch: the whole viewmodel dips below the screen edge while
    // the hands trade weapons, then rises with the next one
    if (lowerAmount > 0.001) {
      const drop = ViewModelRig.smoothstep(lowerAmount);
      weaponMesh.position.y -= 0.45 * drop;
      weaponMesh.position.z -= 0.08 * drop;
      weaponMesh.rotation.x -= 1.0 * drop;
      weaponMesh.rotation.z += 0.18 * drop;
    }

    // 9. The arms chase wherever the hands ended up this frame
    weaponMesh.computeWorldMatrix(true);
    this.arms.update();
  }

  // --- Sniper: procedural bolt cycle + bolt-action reload. Returns the lift
  // target (how far the rifle rolls in toward the camera).
  private updateSniperAnimation(deltaTime: number, activeWeapon: BoltActionSniper): number {
    const vm = this.models.m40a3;
    const bolt = vm.pivots.boltGroup;
    const hand = vm.hands.right;

    // Targets computed per state, then either set directly (mid-cycle, already
    // continuous) or eased toward (state transitions) so nothing pops.
    let boltRot = ViewModelRig.BOLT_REST_ROT;
    let boltZ = 0;
    let grab = 0; // 0 = on the grip, 1 = on the bolt handle
    let armX = 0,
      armY = 0,
      armZ = 0; // extra travel beyond the handle pose
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
        const s = ViewModelRig.smoothstep;

        if (p < 0.18) {
          grab = s(p / 0.18); // reach up from the grip to the handle
        } else if (p < 0.38) {
          grab = 1; // rotate the bolt open
          const t = s((p - 0.18) / 0.2);
          boltRot = ViewModelRig.BOLT_REST_ROT + (ViewModelRig.BOLT_OPEN_ROT - ViewModelRig.BOLT_REST_ROT) * t;
        } else if (p < 0.56) {
          grab = 1; // pull back — ejects the spent case
          boltRot = ViewModelRig.BOLT_OPEN_ROT;
          boltZ = ViewModelRig.BOLT_PULL_Z * s((p - 0.38) / 0.18);
        } else if (p < 0.74) {
          grab = 1; // push forward — chambers the next round
          boltRot = ViewModelRig.BOLT_OPEN_ROT;
          boltZ = ViewModelRig.BOLT_PULL_Z * (1 - s((p - 0.56) / 0.18));
        } else {
          const t = s((p - 0.74) / 0.26); // close and return to the grip
          grab = 1 - t;
          boltRot = ViewModelRig.BOLT_OPEN_ROT + (ViewModelRig.BOLT_REST_ROT - ViewModelRig.BOLT_OPEN_ROT) * t;
        }
        armZ = boltZ * grab; // hand rides the bolt as it slides
        liftTarget = grab;
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
      const pouch = ViewModelRig.ARM_POUCH;
      const port = ViewModelRig.ARM_PORT;

      // Hand anchors relative to the handle pose: the pulled-back handle,
      // and the press-down point where the round gets pushed into the magazine
      const handleZ = ViewModelRig.BOLT_PULL_Z;
      const pressX = port.x;
      const pressY = port.y - 0.025;
      const pressZ = port.z + 0.045;

      if (elapsed < tOpen) {
        // Phase 1 — open the action: reach up, rotate the handle, draw back
        const p = elapsed / tOpen;
        grab = s(Math.min(1, p / 0.35));
        if (p >= 0.7) {
          boltRot = ViewModelRig.BOLT_OPEN_ROT;
          boltZ = ViewModelRig.BOLT_PULL_Z * s((p - 0.7) / 0.3);
          armZ = boltZ; // hand rides the bolt back
        } else if (p >= 0.35) {
          boltRot = ViewModelRig.BOLT_REST_ROT + (ViewModelRig.BOLT_OPEN_ROT - ViewModelRig.BOLT_REST_ROT) * s((p - 0.35) / 0.35);
        }
        liftTarget = grab;
      } else if (elapsed < feedEnd) {
        // Phase 2 — feed rounds: dip to the pouch, bring the round up to the
        // open port, press it down into the magazine; once per round
        boltRot = ViewModelRig.BOLT_OPEN_ROT;
        boltZ = ViewModelRig.BOLT_PULL_Z;
        grab = 1;
        liftTarget = 1;

        const sinceFeed = elapsed - tOpen;
        const round = Math.min(activeWeapon.reloadRounds - 1, Math.floor(sinceFeed / tPer));
        const t01 = (sinceFeed - round * tPer) / tPer;
        // First trip leaves from the bolt handle, later trips from the press point
        const fromX = round === 0 ? 0 : pressX;
        const fromY = round === 0 ? 0 : pressY;
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
        grab = 1;
        if (q < 0.28) {
          const t = s(q / 0.28);
          armX = pressX * (1 - t);
          armY = pressY * (1 - t);
          armZ = pressZ + (handleZ - pressZ) * t;
        } else if (q < 0.55) {
          boltZ = ViewModelRig.BOLT_PULL_Z * (1 - s((q - 0.28) / 0.27));
          armZ = boltZ;
        } else if (q < 0.8) {
          boltZ = 0;
          boltRot = ViewModelRig.BOLT_OPEN_ROT + (ViewModelRig.BOLT_REST_ROT - ViewModelRig.BOLT_OPEN_ROT) * s((q - 0.55) / 0.25);
        } else {
          boltZ = 0;
          boltRot = ViewModelRig.BOLT_REST_ROT;
          grab = 1 - s((q - 0.8) / 0.2);
        }
        liftTarget = q < 0.8 ? 1 : 1 - s((q - 0.8) / 0.2);
      }
      animatedDirectly = true;
    }

    if (animatedDirectly) {
      bolt.rotation.z = boltRot;
      bolt.position.set(this.boltBasePos.x, this.boltBasePos.y, this.boltBasePos.z + boltZ);
      hand.offset.set(armX, armY, armZ);
      hand.altBlend = grab;
    } else {
      // Ease toward the rest pose — smooth, no pops (covers cancelled reloads)
      const k = 1 - Math.exp(-14 * deltaTime);
      bolt.rotation.z += (boltRot - bolt.rotation.z) * k;
      bolt.position.z += (this.boltBasePos.z - bolt.position.z) * k;
      hand.offset.scaleInPlace(1 - k);
      hand.altBlend += (0 - hand.altBlend) * k;
    }

    return liftTarget;
  }

  // --- MP44: reciprocating bolt/charging handle, curved-mag reload, support
  // hand leaving the fore-end to run the magazine and empty-reload charge.
  private updateMp44Animation(deltaTime: number, weapon: Mp44): number {
    const vm = this.models.mp44;
    const s = ViewModelRig.smoothstep;
    let boltBack = weapon.getBoltBack();
    let armX = 0,
      armY = 0,
      armZ = 0;
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

    const bolt = vm.pivots.boltGroup;
    bolt.position.set(
      this.mp44BoltBasePos.x,
      this.mp44BoltBasePos.y,
      this.mp44BoltBasePos.z - ViewModelRig.MP44_BOLT_TRAVEL * boltBack
    );

    const mag = vm.pivots.magGroup;
    mag.setEnabled(magVisible);
    mag.position.set(
      this.mp44MagBasePos.x + ViewModelRig.MP44_MAG_DIR.x * magDist,
      this.mp44MagBasePos.y + ViewModelRig.MP44_MAG_DIR.y * magDist,
      this.mp44MagBasePos.z + ViewModelRig.MP44_MAG_DIR.z * magDist
    );

    this.settleHand(vm.hands.left.offset, animatedDirectly, armX, armY, armZ, deltaTime);
    return liftTarget;
  }

  // --- Pistol: slide blowback, hammer rock, and the mag-swap reload where
  // the support hand drops the spent mag and slaps a fresh one home.
  private updatePistolAnimation(deltaTime: number, weapon: Pistol): number {
    const vm = this.models.usp45;
    const s = ViewModelRig.smoothstep;

    // Slide rides its blowback value every frame; the lock-back on an empty
    // mag and the slam home on slide release both come through getSlideBack()
    const slideBack = weapon.getSlideBack();
    vm.pivots.slideGroup.position.set(
      this.slideBasePos.x,
      this.slideBasePos.y,
      this.slideBasePos.z - ViewModelRig.SLIDE_TRAVEL * slideBack
    );
    vm.pivots.hammerGroup.rotation.x = ViewModelRig.HAMMER_REST_ROT + ViewModelRig.HAMMER_KICK_ROT * slideBack;

    let armX = 0,
      armY = 0,
      armZ = 0;
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

    const mag = vm.pivots.magGroup;
    mag.setEnabled(magVisible);
    mag.position.set(
      this.magBasePos.x + ViewModelRig.MAG_DIR.x * magDist,
      this.magBasePos.y + ViewModelRig.MAG_DIR.y * magDist,
      this.magBasePos.z + ViewModelRig.MAG_DIR.z * magDist
    );

    this.settleHand(vm.hands.left.offset, animatedDirectly, armX, armY, armZ, deltaTime);
    return liftTarget;
  }

  // Hand offset: written directly while an animation owns it, eased back to
  // the grip otherwise (covers reload cancel on swap)
  private settleHand(offset: Vector3, direct: boolean, x: number, y: number, z: number, deltaTime: number): void {
    if (direct) {
      offset.set(x, y, z);
    } else {
      offset.scaleInPlace(Math.exp(-14 * deltaTime));
    }
  }
}
