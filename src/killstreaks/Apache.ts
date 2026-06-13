import { Mesh, MeshBuilder, StandardMaterial, Color3, TransformNode, Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import { BotNav } from "../bots/BotNav";
import type { Bot } from "../bots/Bot";
import type { Effects } from "../rendering/Effects";

// The 7-kill reward: an attack helicopter that thunders in from outside the
// wall, takes station over the yard and hunts the OPFOR — and only the
// OPFOR. It orbits its current mark, walks chin-gun bursts onto anyone its
// gun can see, and flies home when its time is up. Built from primitives
// like everything else here; the rotors really spin, the body leans into
// its velocity, and every round resolves through the same OBB world the
// infantry's bullets use, so containers are genuine hard cover from it.

type ApachePhase = "off" | "enter" | "hunt" | "leave";

const DURATION = 40; // seconds on station
const ALTITUDE = 12.5; // above the lamp tops, below the fog
const SPEED = 9.5;
const ORBIT_RADIUS = 8.5;
const GUN_DAMAGE = 9;
const GUN_INTERVAL = 0.07;
const BURST_ROUNDS = 10;
const GUN_RANGE = 80;
const SPREAD = 0.02; // radians — a gun platform, not a sniper

export interface ApacheRadarContact {
  x: number;
  z: number;
  yaw: number;
}

export class Apache {
  private root: TransformNode;
  private body: TransformNode; // pitch/roll lean, separate from yaw
  private mainRotor: TransformNode;
  private tailRotor: TransformNode;
  private gun: TransformNode;

  private phase: ApachePhase = "off";
  private until = 0;
  private velocity = new Vector3();
  private orbitAngle = 0;
  private yaw = 0;

  private target: Bot | null = null;
  private retargetAt = 0;
  private burstLeft = 0;
  private fireTimer = 0;
  private burstAt = 0;
  private radarContact: ApacheRadarContact = { x: 0, z: 0, yaw: 0 };

  // scratch
  private static readonly TMP_GUN = new Vector3();
  private static readonly TMP_AIM = new Vector3();
  private static readonly TMP_DIR = new Vector3();
  private static readonly TMP_POINT = new Vector3();
  private static readonly TMP_NORMAL = new Vector3();
  private static readonly TMP_END = new Vector3();

  constructor(scene: Scene) {
    const hull = new StandardMaterial("apacheHullMat", scene);
    hull.diffuseColor = new Color3(0.18, 0.21, 0.18);
    hull.specularColor = new Color3(0.05, 0.05, 0.05);
    const glass = new StandardMaterial("apacheGlassMat", scene);
    glass.diffuseColor = new Color3(0.06, 0.1, 0.12);
    glass.emissiveColor = new Color3(0.04, 0.09, 0.11);
    glass.specularColor = new Color3(0.25, 0.25, 0.25);
    const dark = new StandardMaterial("apacheDarkMat", scene);
    dark.diffuseColor = new Color3(0.07, 0.07, 0.08);
    dark.specularColor = Color3.Black();

    this.root = new TransformNode("apache", scene);
    this.body = new TransformNode("apacheBody", scene);
    this.body.parent = this.root;

    const piece = (m: Mesh, mat: StandardMaterial, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, parent: TransformNode = this.body): Mesh => {
      m.material = mat;
      m.parent = parent;
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.isPickable = false;
      return m;
    };

    // Fuselage: slim attack-helo profile — narrow body, stepped canopy,
    // stub wings with rocket pods, boom out to the tail fin
    const fuselage = MeshBuilder.CreateCapsule("apacheFuselage", {
      radius: 0.52, height: 3.4, tessellation: 12, capSubdivisions: 4, orientation: new Vector3(0, 0, 1),
    }, scene);
    fuselage.scaling.set(0.72, 0.82, 1);
    piece(fuselage, hull, 0, 0, 0.1);
    const canopy = MeshBuilder.CreateSphere("apacheCanopy", { diameter: 0.78, segments: 8 }, scene);
    canopy.scaling.set(0.62, 0.62, 1.25);
    piece(canopy, glass, 0, 0.3, 0.78);
    piece(MeshBuilder.CreateBox("apacheNose", { width: 0.34, height: 0.3, depth: 0.5 }, scene), hull, 0, -0.18, 1.7);
    piece(MeshBuilder.CreateBox("apacheWings", { width: 2.4, height: 0.07, depth: 0.46 }, scene), hull, 0, -0.05, 0.25);
    for (const side of [-1, 1]) {
      const pod = MeshBuilder.CreateCylinder("apachePod" + side, { diameter: 0.24, height: 0.78, tessellation: 10 }, scene);
      piece(pod, dark, side * 1.1, -0.16, 0.25, Math.PI / 2);
    }
    piece(MeshBuilder.CreateCylinder("apacheBoom", { diameterTop: 0.18, diameterBottom: 0.34, height: 2.5, tessellation: 10 }, scene), hull, 0, 0.06, -2.55, Math.PI / 2);
    piece(MeshBuilder.CreateBox("apacheFin", { width: 0.06, height: 0.78, depth: 0.42 }, scene), hull, 0, 0.3, -3.6);
    piece(MeshBuilder.CreateBox("apacheTailPlane", { width: 0.9, height: 0.05, depth: 0.3 }, scene), hull, 0, 0.12, -3.3);

    // Chin gun under the nose — the muzzle reference for every round
    this.gun = new TransformNode("apacheGun", scene);
    this.gun.parent = this.body;
    this.gun.position.set(0, -0.52, 1.35);
    piece(MeshBuilder.CreateCylinder("apacheGunBarrel", { diameter: 0.1, height: 0.75, tessellation: 8 }, scene), dark, 0, 0, 0.18, Math.PI / 2, 0, 0, this.gun);

    // Rotors: a two-blade cross up top, small disc on the tail — they spin
    // every frame the airframe exists, which is most of what sells "helicopter"
    this.mainRotor = new TransformNode("apacheRotor", scene);
    this.mainRotor.parent = this.body;
    this.mainRotor.position.set(0, 0.86, 0);
    piece(MeshBuilder.CreateCylinder("apacheHub", { diameter: 0.22, height: 0.18, tessellation: 8 }, scene), dark, 0, -0.04, 0, 0, 0, 0, this.mainRotor);
    piece(MeshBuilder.CreateBox("apacheBladeA", { width: 0.17, height: 0.025, depth: 5.4 }, scene), dark, 0, 0, 0, 0, 0, 0, this.mainRotor);
    piece(MeshBuilder.CreateBox("apacheBladeB", { width: 0.17, height: 0.025, depth: 5.4 }, scene), dark, 0, 0, 0, 0, Math.PI / 2, 0, this.mainRotor);
    this.tailRotor = new TransformNode("apacheTailRotor", scene);
    this.tailRotor.parent = this.body;
    this.tailRotor.position.set(0.14, 0.3, -3.62);
    piece(MeshBuilder.CreateBox("apacheTailBladeA", { width: 0.03, height: 1.05, depth: 0.1 }, scene), dark, 0, 0, 0, 0, 0, 0, this.tailRotor);
    piece(MeshBuilder.CreateBox("apacheTailBladeB", { width: 0.03, height: 0.1, depth: 1.05 }, scene), dark, 0, 0, 0, 0, 0, 0, this.tailRotor);

    this.root.setEnabled(false);
  }

  public get active(): boolean {
    return this.phase !== "off";
  }

  public getRadarContact(): ApacheRadarContact | null {
    if (this.phase === "off") return null;
    this.radarContact.x = this.root.position.x;
    this.radarContact.z = this.root.position.z;
    this.radarContact.yaw = this.yaw;
    return this.radarContact;
  }

  public deploy(now: number): void {
    this.phase = "enter";
    this.until = now + DURATION;
    this.root.position.set(38, 19, 38); // thunder in over the corner
    this.velocity.setAll(0);
    this.yaw = Math.atan2(-38, -38);
    this.orbitAngle = Math.random() * Math.PI * 2;
    this.target = null;
    this.burstLeft = 0;
    this.root.setEnabled(true);
  }

  public despawnImmediate(effects: Effects): void {
    this.phase = "off";
    this.root.setEnabled(false);
    effects.stopRotorLoop();
  }

  public update(dt: number, now: number, bots: ReadonlyArray<Bot>, playerPos: Vector3, effects: Effects): void {
    if (this.phase === "off") return;

    // rotors never stop
    this.mainRotor.rotation.y += 30 * dt;
    this.tailRotor.rotation.x += 46 * dt;

    const pos = this.root.position;

    // ---------------------------------------------------------- target pick
    if (this.phase === "hunt" && (now >= this.retargetAt || (this.target && this.target.dead))) {
      this.retargetAt = now + 0.7;
      this.gun.computeWorldMatrix(true);
      const gunPos = Apache.TMP_GUN.copyFrom(this.gun.getAbsolutePosition());
      let best: Bot | null = null;
      let bestD = Infinity;
      for (const bot of bots) {
        if (bot.dead) continue;
        const dx = bot.position.x - pos.x;
        const dz = bot.position.z - pos.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        Apache.TMP_AIM.set(bot.position.x, bot.position.y + 1.3, bot.position.z);
        const seen = !BotNav.losBlocked(gunPos, Apache.TMP_AIM);
        // visible targets always beat hidden ones; among peers take the nearest
        const score = d + (seen ? 0 : 1000);
        if (score < bestD) {
          bestD = score;
          best = bot;
        }
      }
      this.target = best;
    }

    // ------------------------------------------------------------- steering
    let desiredX: number;
    let desiredY = ALTITUDE + Math.sin(now * 0.8) * 0.5; // a live hover, not a rail
    let desiredZ: number;
    if (this.phase === "leave") {
      desiredX = 46;
      desiredY = 24;
      desiredZ = -46;
    } else if (this.target && !this.target.dead) {
      // circle the mark and keep the nose on it
      this.orbitAngle += 0.32 * dt;
      desiredX = this.target.position.x + Math.sin(this.orbitAngle) * ORBIT_RADIUS;
      desiredZ = this.target.position.z + Math.cos(this.orbitAngle) * ORBIT_RADIUS;
    } else {
      // nothing visible: patrol the yard's center ring
      this.orbitAngle += 0.22 * dt;
      desiredX = Math.sin(this.orbitAngle) * 11;
      desiredZ = Math.cos(this.orbitAngle) * 11;
    }

    Apache.TMP_DIR.set(desiredX - pos.x, desiredY - pos.y, desiredZ - pos.z);
    const dist = Apache.TMP_DIR.length();
    if (dist > 0.01) {
      const speed = this.phase === "leave" ? SPEED * 1.8 : Math.min(SPEED, dist * 0.9);
      Apache.TMP_DIR.scaleInPlace(speed / dist);
    }
    const steer = 1 - Math.exp(-1.7 * dt);
    this.velocity.x += (Apache.TMP_DIR.x - this.velocity.x) * steer;
    this.velocity.y += (Apache.TMP_DIR.y - this.velocity.y) * steer;
    this.velocity.z += (Apache.TMP_DIR.z - this.velocity.z) * steer;
    pos.addInPlace(this.velocity.scale(dt));

    if (this.phase === "enter" && Math.abs(pos.x) < 18 && Math.abs(pos.z) < 18) {
      this.phase = "hunt";
      this.retargetAt = 0;
    }

    // nose: on the target when hunting, into the velocity otherwise
    let wantYaw: number;
    if (this.phase === "hunt" && this.target && !this.target.dead) {
      wantYaw = Math.atan2(this.target.position.x - pos.x, this.target.position.z - pos.z);
    } else if (this.velocity.lengthSquared() > 0.5) {
      wantYaw = Math.atan2(this.velocity.x, this.velocity.z);
    } else {
      wantYaw = this.yaw;
    }
    const yawDelta = Apache.angDelta(this.yaw, wantYaw);
    this.yaw += yawDelta * (1 - Math.exp(-2.2 * dt));
    this.root.rotation.y = this.yaw;
    // lean: pitch into forward speed, roll out of the turn
    const fwdSpeed = this.velocity.x * Math.sin(this.yaw) + this.velocity.z * Math.cos(this.yaw);
    this.body.rotation.x += (Math.max(-0.22, Math.min(0.22, fwdSpeed * 0.022)) - this.body.rotation.x) * (1 - Math.exp(-3 * dt));
    this.body.rotation.z += (Math.max(-0.3, Math.min(0.3, -yawDelta * 0.5)) - this.body.rotation.z) * (1 - Math.exp(-3 * dt));

    // ---------------------------------------------------------------- gun
    this.fireTimer -= dt;
    if (this.phase === "hunt" && this.target && !this.target.dead) {
      this.gun.computeWorldMatrix(true);
      const gunPos = Apache.TMP_GUN.copyFrom(this.gun.getAbsolutePosition());
      Apache.TMP_AIM.set(this.target.position.x, this.target.position.y + 1.2, this.target.position.z);
      const clear = !BotNav.losBlocked(gunPos, Apache.TMP_AIM);
      if (this.burstLeft > 0) {
        if (this.fireTimer <= 0) {
          this.fireRound(gunPos, bots, playerPos, effects);
          this.fireTimer = GUN_INTERVAL;
          this.burstLeft--;
          if (this.burstLeft === 0) this.burstAt = now + 0.9 + Math.random() * 0.6;
        }
      } else if (clear && now >= this.burstAt) {
        this.burstLeft = BURST_ROUNDS;
      }
    } else {
      this.burstLeft = 0;
    }

    // rotor wash in the player's ears, by distance
    const pd = Math.sqrt(
      (pos.x - playerPos.x) ** 2 + (pos.y - playerPos.y) ** 2 + (pos.z - playerPos.z) ** 2
    );
    effects.setRotorVolume(Math.min(0.55, 1.5 / (1 + pd * 0.055)));

    // ----------------------------------------------------------- time's up
    if (this.phase === "hunt" && now >= this.until) {
      this.phase = "leave";
      this.target = null;
    }
    if (this.phase === "leave" && (Math.abs(pos.x) > 44 || Math.abs(pos.z) > 44)) {
      this.despawnImmediate(effects);
    }
  }

  // One chin-gun round: aimed at the current target's chest with platform
  // spread, resolved against the OBB world and EVERY living bot's body
  // cylinder — never against the player. The reward hunts the enemy only.
  private fireRound(gunPos: Vector3, bots: ReadonlyArray<Bot>, playerPos: Vector3, effects: Effects): void {
    const target = this.target;
    if (!target) return;
    Apache.TMP_DIR.set(
      target.position.x - gunPos.x + (Math.random() - 0.5) * 2 * SPREAD * 20,
      target.position.y + 1.1 - gunPos.y + (Math.random() - 0.5) * 2 * SPREAD * 14,
      target.position.z - gunPos.z + (Math.random() - 0.5) * 2 * SPREAD * 20
    );
    Apache.TMP_DIR.normalize();

    const tWorld = BotNav.rayHitWorld(gunPos, Apache.TMP_DIR, GUN_RANGE, Apache.TMP_POINT, Apache.TMP_NORMAL);
    let tBot = Infinity;
    let hitBot: Bot | null = null;
    for (const bot of bots) {
      if (bot.dead) continue;
      const t = Apache.rayVsBotBody(gunPos, Apache.TMP_DIR, bot);
      if (t < tBot) {
        tBot = t;
        hitBot = bot;
      }
    }

    const end = Apache.TMP_END;
    if (hitBot && tBot < tWorld) {
      hitBot.takeDamage(GUN_DAMAGE, "apache");
      end.copyFrom(Apache.TMP_DIR).scaleInPlace(tBot).addInPlace(gunPos);
    } else if (tWorld !== Infinity) {
      effects.createBulletImpact(Apache.TMP_POINT, Apache.TMP_NORMAL);
      end.copyFrom(Apache.TMP_POINT);
    } else {
      end.copyFrom(Apache.TMP_DIR).scaleInPlace(GUN_RANGE).addInPlace(gunPos);
    }

    effects.createTracer(gunPos, end);
    effects.createMuzzleFlash(gunPos, 0.9);
    const pd = Math.sqrt(
      (gunPos.x - playerPos.x) ** 2 + (gunPos.y - playerPos.y) ** 2 + (gunPos.z - playerPos.z) ** 2
    );
    effects.playApacheGunSound(Math.min(1, 1.6 / (1 + pd * 0.07)));
  }

  // Segment vs a bot's vertical cylinder (same approximation the bots use
  // against the player, pointed the other way)
  private static rayVsBotBody(origin: Vector3, dir: Vector3, bot: Bot): number {
    const rx = origin.x - bot.position.x;
    const rz = origin.z - bot.position.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a < 1e-8) return Infinity;
    const r = 0.45;
    const b = 2 * (rx * dir.x + rz * dir.z);
    const c = rx * rx + rz * rz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    let t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) {
      t = (-b + Math.sqrt(disc)) / (2 * a);
      if (t < 0) return Infinity;
    }
    const y = origin.y + dir.y * t;
    if (y < bot.position.y || y > bot.position.y + 1.95) return Infinity;
    return t;
  }

  private static angDelta(from: number, to: number): number {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
}
