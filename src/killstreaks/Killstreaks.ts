import { MeshBuilder, StandardMaterial, Color3, TransformNode, Vector3 } from "@babylonjs/core";
import type { FreeCamera, Mesh, Scene } from "@babylonjs/core";
import type { PlayerController } from "../player/PlayerController";
import type { CameraRig } from "../player/CameraRig";
import { BotNav } from "../bots/BotNav";
import type { BotManager } from "../bots/BotManager";
import type { Effects } from "../rendering/Effects";
import type { Input } from "../engine/Input";
import { MatchEvents } from "../ui/MatchEvents";
import { AirstrikeLaptop } from "./AirstrikeLaptop";
import { Apache } from "./Apache";
import type { ApacheRadarContact } from "./Apache";
import { ApacheTransmitter } from "./ApacheTransmitter";

// The Fall of Duty ladder: 3 kills = UAV (the minimap lights up
// and pulses with every living hostile for 30s), 5 kills = airstrike (press
// C, the laptop comes up, mark the map, three F-15 passes walk bombs across
// the mark), 7 kills = Apache ready (press C, thumb the transmitter, then
// the helicopter takes station and hunts the enemy — only the enemy — for
// 40 seconds).
//
// Streak rules: dying resets the count, but an earned,
// unused airstrike survives death; streak kills (airstrike, apache) feed
// the next streak, which is how a good airstrike buys the helicopter.
export class Killstreaks {
  private static readonly UAV_TIME = 30;
  private static readonly BLAST_RADIUS = 5.6;
  private static readonly BLAST_DAMAGE = 165;

  private streak = 0;
  private now = 0;
  private uavUntil = -1;
  private airstrikeReady = false;
  private apacheReady = false;

  private laptop: AirstrikeLaptop;
  private transmitter: ApacheTransmitter;
  private apache: Apache;

  // scheduled ordnance + the jets that deliver it
  private bombs: Array<{ at: number; x: number; z: number }> = [];
  private jetRuns: Array<{ at: number; x: number; z: number; dirX: number; dirZ: number; alt: number }> = [];
  private jets: Array<{ root: TransformNode; life: number; dirX: number; dirZ: number }> = [];

  private hintEl: HTMLElement | null;
  private lastHint = "";

  private input: Input;
  private player: PlayerController;
  private botManager: BotManager;
  private effects: Effects;
  private cameraRig: CameraRig;

  private static readonly TMP_BLAST = new Vector3();
  private static readonly TMP_EYE = new Vector3();

  constructor(
    scene: Scene,
    camera: FreeCamera,
    input: Input,
    player: PlayerController,
    botManager: BotManager,
    effects: Effects,
    cameraRig: CameraRig
  ) {
    this.input = input;
    this.player = player;
    this.botManager = botManager;
    this.effects = effects;
    this.cameraRig = cameraRig;
    this.hintEl = document.getElementById("streak-hint");

    this.laptop = new AirstrikeLaptop(scene, camera);
    this.transmitter = new ApacheTransmitter(scene, camera);
    this.apache = new Apache(scene);
    this.buildJets(scene);

    MatchEvents.on("kill", () => this.onKill());
    MatchEvents.on("playerDeath", () => {
      this.streak = 0;
      this.laptop.close(); // killed mid-mark: the laptop drops, the strike stays earned
      if (this.transmitter.isOut && !this.apache.active) this.apacheReady = true;
      this.transmitter.forceClose();
    });
  }

  public get uavActive(): boolean {
    return this.now < this.uavUntil;
  }

  public get laptopOut(): boolean {
    return this.laptop.isOut;
  }

  public get handheldOut(): boolean {
    return this.laptop.isOut || this.transmitter.isOut;
  }

  public getApacheRadarContact(): ApacheRadarContact | null {
    return this.apache.getRadarContact();
  }

  private onKill(): void {
    this.streak++;
    if (this.streak === 3) {
      this.uavUntil = this.now + Killstreaks.UAV_TIME;
      this.effects.playUavOnlineSound();
    } else if (this.streak === 5) {
      this.airstrikeReady = true; // yours until you spend it, even through a death
    } else if (this.streak === 7 && !this.apache.active) {
      this.apacheReady = true;
    }
  }

  public update(dt: number): void {
    this.now += dt;
    const player = this.player;

    // C: Apache transmitter first, then the airstrike laptop. If both rewards
    // are banked, the higher streak gets the first press and the airstrike
    // stays ready for the next one.
    if (this.input.isKeyPressed("KeyC")) {
      if (this.apacheReady && !player.isDead && !this.laptop.isOut && !this.transmitter.isOut) {
        this.transmitter.open();
        this.effects.playLaptopOpenSound();
      } else if (this.laptop.isOut) {
        this.laptop.close();
        this.effects.playLaptopCloseSound();
      } else if (this.airstrikeReady && !player.isDead && !this.transmitter.isOut) {
        this.laptop.open();
        this.effects.playLaptopOpenSound();
      }
    }
    if (player.isDead && this.laptop.isOut) this.laptop.close();
    if (player.isDead && this.transmitter.isOut) {
      if (!this.apache.active) this.apacheReady = true;
      this.transmitter.forceClose();
    }

    const mark = this.laptop.update(dt, this.input, player, this.botManager.bots, this.uavActive);
    if (mark) {
      this.airstrikeReady = false;
      this.laptop.close();
      this.effects.playLaptopCloseSound();
      this.effects.playAirstrikeConfirmSound();
      this.scheduleStrike(mark.x, mark.z);
    }

    if (this.transmitter.update(dt)) {
      this.apacheReady = false;
      this.apache.deploy(this.now);
      this.effects.playAirstrikeConfirmSound();
    }

    // the laptop borrows the mouse; any banked handheld reward borrows C
    player.lookLocked = this.laptop.isOut;
    player.crouchKeyCaptured = this.airstrikeReady || this.apacheReady || this.laptop.isOut || this.transmitter.isOut;

    // jets first (they announce the bombs), then the bombs themselves
    for (let i = this.jetRuns.length - 1; i >= 0; i--) {
      const run = this.jetRuns[i];
      if (this.now < run.at) continue;
      this.jetRuns.splice(i, 1);
      this.launchJet(run);
    }
    for (const jet of this.jets) {
      if (jet.life <= 0) continue;
      jet.life -= dt;
      jet.root.position.x += jet.dirX * 72 * dt;
      jet.root.position.z += jet.dirZ * 72 * dt;
      if (jet.life <= 0) jet.root.setEnabled(false);
    }
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const bomb = this.bombs[i];
      if (this.now < bomb.at) continue;
      this.bombs.splice(i, 1);
      this.explode(bomb.x, bomb.z);
    }

    this.apache.update(dt, this.now, this.botManager.bots, player.position, this.effects);

    // bottom-center hint: one DOM write per state change
    const hint = this.laptop.isOut
      ? "LMB — MARK TARGET · C — CLOSE"
      : this.transmitter.isOut
        ? "TRANSMITTING APACHE AUTH"
      : this.bombs.length > 0 || this.jetRuns.length > 0
        ? "AIRSTRIKE INBOUND"
        : this.apacheReady && !player.isDead
          ? "APACHE READY — PRESS C"
        : this.airstrikeReady && !player.isDead
          ? "AIRSTRIKE READY — PRESS C"
          : "";
    if (hint !== this.lastHint) {
      this.lastHint = hint;
      if (this.hintEl) {
        this.hintEl.innerText = hint;
        this.hintEl.classList.toggle("hidden", hint === "");
      }
    }
  }

  // ----------------------------------------------------------- the airstrike

  // Three fast movers, ~0.8s apart, each walking three bombs along the run-in
  // line through the mark. Lanes sit side by side so the spread blankets the
  // area without turning the whole yard into a kill box.
  private scheduleStrike(x: number, z: number): void {
    const angle = Math.random() * Math.PI * 2;
    const alongX = Math.sin(angle);
    const alongZ = Math.cos(angle);
    const perpX = Math.cos(angle);
    const perpZ = -Math.sin(angle);
    for (let pass = 0; pass < 3; pass++) {
      const passAt = this.now + 2.5 + pass * 0.8;
      const lane = (pass - 1) * 2.7;
      const laneX = x + perpX * lane;
      const laneZ = z + perpZ * lane;
      this.jetRuns.push({
        at: passAt - 1.0, // the flyby leads its bombs
        x: laneX - alongX * 60,
        z: laneZ - alongZ * 60,
        dirX: alongX,
        dirZ: alongZ,
        alt: 26 + pass * 2.5,
      });
      for (let j = 0; j < 3; j++) {
        this.bombs.push({
          at: passAt + j * 0.14,
          x: laneX + alongX * (-3.4 + j * 3.4) + (Math.random() - 0.5) * 1.6,
          z: laneZ + alongZ * (-3.4 + j * 3.4) + (Math.random() - 0.5) * 1.6,
        });
      }
    }
  }

  private explode(x: number, z: number): void {
    const blast = Killstreaks.TMP_BLAST.set(x, 0, z);
    this.effects.createExplosion(blast);

    const player = this.player;
    const pdx = player.position.x - x;
    const pdz = player.position.z - z;
    const playerDist = Math.sqrt(pdx * pdx + pdz * pdz);
    this.effects.playExplosionSound(playerDist);
    // the whole yard rocks; close ones rock harder
    this.cameraRig.applyRecoil(
      Math.min(2.6, 7 / (1 + playerDist * 0.7)),
      4,
      Math.min(0.055, 0.16 / (1 + playerDist * 0.5))
    );

    // Bots: inside the radius and not behind hard cover (containers protect)
    const eye = Killstreaks.TMP_EYE.set(x, 1.1, z);
    for (const bot of this.botManager.bots) {
      if (bot.dead) continue;
      const dx = bot.position.x - x;
      const dz = bot.position.z - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > Killstreaks.BLAST_RADIUS) continue;
      Killstreaks.TMP_BLAST.set(bot.position.x, bot.position.y + 1.3, bot.position.z);
      if (BotNav.losBlocked(eye, Killstreaks.TMP_BLAST)) continue;
      bot.takeDamage(Killstreaks.BLAST_DAMAGE * (1 - d / (Killstreaks.BLAST_RADIUS + 1.2)), "airstrike");
    }

    // The caller is not exempt: stand in your own strike, eat it
    if (!player.isDead && playerDist <= Killstreaks.BLAST_RADIUS) {
      Killstreaks.TMP_BLAST.set(player.position.x, player.position.y + player.eyeHeight, player.position.z);
      if (!BotNav.losBlocked(eye, Killstreaks.TMP_BLAST)) {
        const wasDead = player.isDead;
        player.takeDamage(
          Killstreaks.BLAST_DAMAGE * (1 - playerDist / (Killstreaks.BLAST_RADIUS + 1.2)),
          Killstreaks.TMP_EYE.set(x, 0, z)
        );
        if (!wasDead && player.isDead) {
          MatchEvents.emit("playerDeath", { weaponId: "airstrike", self: true });
        }
      }
    }
  }

  // ------------------------------------------------------------------- jets

  private buildJets(scene: Scene): void {
    const gray = new StandardMaterial("jetMat", scene);
    gray.diffuseColor = new Color3(0.24, 0.26, 0.29);
    gray.specularColor = new Color3(0.1, 0.1, 0.1);
    for (let i = 0; i < 3; i++) {
      const root = new TransformNode(`jet${i}`, scene);
      const piece = (m: Mesh, x: number, y: number, z: number, ry = 0): void => {
        m.material = gray;
        m.parent = root;
        m.position.set(x, y, z);
        m.rotation.y = ry;
        m.isPickable = false;
      };
      const fuselage = MeshBuilder.CreateCapsule(`jet${i}_body`, {
        radius: 0.4, height: 4.6, tessellation: 8, capSubdivisions: 3, orientation: new Vector3(0, 0, 1),
      }, scene);
      fuselage.scaling.set(0.8, 0.7, 1);
      piece(fuselage, 0, 0, 0);
      piece(MeshBuilder.CreateBox(`jet${i}_wings`, { width: 4.4, height: 0.1, depth: 1.5 }, scene), 0, -0.05, -0.4);
      piece(MeshBuilder.CreateBox(`jet${i}_tail`, { width: 1.7, height: 0.08, depth: 0.7 }, scene), 0, 0.05, -2.0);
      piece(MeshBuilder.CreateBox(`jet${i}_fin`, { width: 0.07, height: 0.85, depth: 0.8 }, scene), 0, 0.4, -1.9);
      root.setEnabled(false);
      this.jets.push({ root, life: 0, dirX: 0, dirZ: 1 });
    }
  }

  private launchJet(run: { x: number; z: number; dirX: number; dirZ: number; alt: number }): void {
    const jet = this.jets.find((j) => j.life <= 0);
    if (!jet) return;
    jet.life = 2.0; // 60m run-in + the overflight at 72 m/s
    jet.dirX = run.dirX;
    jet.dirZ = run.dirZ;
    jet.root.position.set(run.x, run.alt, run.z);
    jet.root.rotation.y = Math.atan2(run.dirX, run.dirZ);
    jet.root.setEnabled(true);
    this.effects.playJetFlybySound();
  }

  // ------------------------------------------------------------- match flow

  public setPaused(paused: boolean): void {
    this.effects.setRotorMuted(paused);
  }

  // End screen: silence the rotor and give the player their keys back
  public onMatchEnd(): void {
    this.laptop.forceClose();
    this.transmitter.forceClose();
    this.player.lookLocked = false;
    this.player.crouchKeyCaptured = false;
    if (this.apache.active) this.apache.despawnImmediate(this.effects);
    if (this.hintEl) this.hintEl.classList.add("hidden");
    this.lastHint = "";
  }

  public resetMatch(): void {
    this.onMatchEnd();
    this.streak = 0;
    this.uavUntil = -1;
    this.airstrikeReady = false;
    this.apacheReady = false;
    this.bombs.length = 0;
    this.jetRuns.length = 0;
    for (const jet of this.jets) {
      jet.life = 0;
      jet.root.setEnabled(false);
    }
  }
}
