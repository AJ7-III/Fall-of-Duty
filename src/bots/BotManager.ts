import { Vector3 } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import { PlayerController } from "../player/PlayerController";
import { BotNav } from "./BotNav";
import { Bot } from "./Bot";
import type { BotContext } from "./Bot";
import { BOT_WEAPONS, TERMINATOR_LEVEL, applyDifficultyLevel, difficultyForLevel } from "./BotConfig";
import type { BotDifficulty } from "./BotConfig";
import type { Effects } from "../rendering/Effects";
import { MatchEvents } from "../ui/MatchEvents";

// Owns the enemy side: builds the nav graph from the map's collision data,
// spawns the opposition, runs their updates, keeps bodies apart, respawns
// the fallen out of the player's sight, and keeps the scoreboard.
// The yard is a duel by default — one enemy, one-on-one.
// Tunable from the address bar (?difficulty=recruit..veteran&bots=1..6) and
// live from the pause menu's 1-10 difficulty slider (persisted to localStorage).
export class BotManager {
  private static readonly RESPAWN_DELAY = 5;
  private static readonly DIFFICULTY_KEY = "fallOfDuty.difficulty";
  private static readonly URL_LEVELS: Record<string, number> = { recruit: 2, regular: 3, hardened: 5, veteran: 8, terminator: 10 };
  // Corner pockets + the two wall pass-through containers
  private static readonly SPAWNS: ReadonlyArray<[number, number]> = [
    [13.5, 13.5], [-13.5, 13.5], [13.5, -13.5], [-13.5, -13.5], [-14.7, 0.6], [14.7, 0.35],
  ];

  public bots: Bot[] = [];
  public playerKills = 0;

  private now = 0;
  private ctx: BotContext;
  // One mutable tuning object shared by every bot — the settings slider
  // writes through it and the whole fleet retunes mid-match
  private difficulty: BotDifficulty;
  private difficultyLevel: number;
  private static readonly TMP_EYE_A = new Vector3();
  private static readonly TMP_EYE_B = new Vector3();

  constructor(scene: Scene, player: PlayerController, effects: Effects) {
    // The graph must be grown after the map registers its obstacles
    BotNav.build();

    const params = new URLSearchParams(location.search);
    const saved = BotManager.readSavedDifficulty();
    const urlLevel = BotManager.URL_LEVELS[params.get("difficulty") ?? ""];
    this.difficultyLevel = Math.max(1, Math.min(10, Number.isFinite(saved) ? saved : urlLevel ?? 5));
    this.difficulty = difficultyForLevel(this.difficultyLevel);
    const count = Math.max(1, Math.min(6, parseInt(params.get("bots") ?? "1", 10) || 1));

    // Hand out spawns farthest from the player first; every third bot
    // carries the bolt rifle so the yard has one patient threat
    const spawns = this.spawnsFarthestFrom(player);
    for (let i = 0; i < count; i++) {
      const [x, z] = spawns[i % spawns.length];
      const primary = i % 3 === 2 ? BOT_WEAPONS.m40a3 : BOT_WEAPONS.mp44;
      const bot = new Bot(scene, this.difficulty, primary, x, z, i);
      bot.reset(x, z, Math.atan2(-x, -z)); // face the center cross
      this.bots.push(bot);
    }
    this.syncTerminator();

    this.ctx = { dt: 0, now: 0, player, effects, playerFired: false };
  }

  public getDifficultyLevel(): number {
    return this.difficultyLevel;
  }

  public setDifficultyLevel(level: number): void {
    this.difficultyLevel = Math.max(1, Math.min(10, Math.round(level)));
    applyDifficultyLevel(this.difficulty, this.difficultyLevel);
    this.syncTerminator();
    try {
      localStorage.setItem(BotManager.DIFFICULTY_KEY, this.difficultyLevel.toString());
    } catch {
      // private browsing — the slider still works for this session
    }
  }

  private static readSavedDifficulty(): number {
    try {
      return parseInt(localStorage.getItem(BotManager.DIFFICULTY_KEY) ?? "", 10);
    } catch {
      return NaN;
    }
  }

  // The liquid-metal skin follows the slider live: cross the Terminator
  // threshold and the whole fleet chromes mid-match; drop below and the
  // cloth comes back. (The matching health bonus lands on each respawn.)
  private syncTerminator(): void {
    const on = this.difficultyLevel >= TERMINATOR_LEVEL;
    for (const bot of this.bots) bot.setTerminator(on);
  }

  private spawnsFarthestFrom(player: PlayerController): Array<[number, number]> {
    return [...BotManager.SPAWNS].sort((a, b) => {
      const da = (a[0] - player.position.x) ** 2 + (a[1] - player.position.z) ** 2;
      const db = (b[0] - player.position.x) ** 2 + (b[1] - player.position.z) ** 2;
      return db - da;
    });
  }

  // Fresh round: zero the board and walk every bot back to a far spawn
  public resetMatch(player: PlayerController): void {
    this.playerKills = 0;
    const spawns = this.spawnsFarthestFrom(player);
    this.bots.forEach((bot, i) => {
      const [x, z] = spawns[i % spawns.length];
      bot.respawnTimer = 0;
      bot.reset(x, z, Math.atan2(-x, -z));
    });
  }

  // The player-side mirror of respawn(): of the player's spawn corners, take
  // the one farthest from any living enemy, with a big bonus for being out
  // of their sight — never wake up staring down a muzzle.
  public pickPlayerSpawn(spawns: ReadonlyArray<[number, number]>): [number, number] {
    let best = spawns[0];
    let bestScore = -Infinity;
    for (const spawn of spawns) {
      let nearest = Infinity;
      let seen = false;
      BotManager.TMP_EYE_A.set(spawn[0], 1.62, spawn[1]);
      for (const bot of this.bots) {
        if (bot.dead) continue;
        const dx = spawn[0] - bot.position.x;
        const dz = spawn[1] - bot.position.z;
        nearest = Math.min(nearest, Math.sqrt(dx * dx + dz * dz));
        if (!seen) {
          BotManager.TMP_EYE_B.set(bot.position.x, bot.position.y + 1.62, bot.position.z);
          seen = !BotNav.losBlocked(BotManager.TMP_EYE_A, BotManager.TMP_EYE_B);
        }
      }
      const score = (nearest === Infinity ? 30 : Math.min(nearest, 30)) + (seen ? 0 : 24) + Math.random() * 2;
      if (score > bestScore) {
        bestScore = score;
        best = spawn;
      }
    }
    return best;
  }

  public update(dt: number, player: PlayerController, playerFired: boolean): void {
    this.now += dt;
    this.ctx.dt = dt;
    this.ctx.now = this.now;
    this.ctx.player = player;
    this.ctx.playerFired = playerFired;

    for (const bot of this.bots) {
      bot.update(this.ctx);
      if (bot.dead) {
        if (!bot.killCounted) {
          bot.killCounted = true;
          this.playerKills++;
          bot.respawnTimer = BotManager.RESPAWN_DELAY;
          MatchEvents.emit("kill", { headshot: bot.lastHitZone >= 2, cause: bot.lastDamageCause });
        } else if ((bot.respawnTimer -= dt) <= 0) {
          this.respawn(bot, player);
        }
      }
    }

    // Soft separation so two bots sharing a lane don't merge into one body
    for (let i = 0; i < this.bots.length; i++) {
      const a = this.bots[i];
      if (a.dead) continue;
      for (let j = i + 1; j < this.bots.length; j++) {
        const b = this.bots[j];
        if (b.dead) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.81 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (0.9 - d) * 0.5;
        a.position.x -= (dx / d) * push;
        a.position.z -= (dz / d) * push;
        b.position.x += (dx / d) * push;
        b.position.z += (dz / d) * push;
      }
    }
  }

  // Back into the fight at the spawn the player is least likely to be
  // watching: farthest away, and hidden from their eyes if possible. The
  // jitter matters — without it a stationary player gets the SAME corner
  // every respawn, and "he always comes from the containers" is a pattern
  // good players farm. Hidden-ness still dominates; ties and near-ties vary.
  private respawn(bot: Bot, player: PlayerController): void {
    BotManager.TMP_EYE_B.set(player.position.x, player.position.y + player.eyeHeight, player.position.z);
    let best = BotManager.SPAWNS[0];
    let bestScore = -Infinity;
    for (const spawn of BotManager.SPAWNS) {
      const dx = spawn[0] - player.position.x;
      const dz = spawn[1] - player.position.z;
      BotManager.TMP_EYE_A.set(spawn[0], 1.62, spawn[1]);
      const hidden = BotNav.losBlocked(BotManager.TMP_EYE_A, BotManager.TMP_EYE_B);
      const score = Math.sqrt(dx * dx + dz * dz) + (hidden ? 30 : 0) + Math.random() * 11;
      if (score > bestScore) {
        bestScore = score;
        best = spawn;
      }
    }
    bot.reset(best[0], best[1], Math.atan2(-best[0], -best[1]));

    // Spawn intuition: the dead remember the fight. Usually (always, at the
    // top of the scale) the respawned soldier re-enters hunting the player's
    // rough neighborhood instead of wandering at random — sharper minds get
    // a tighter fix. Aggression rises monotonically with the slider, so it
    // doubles as the skill proxy here.
    const skill = this.difficulty.aggression;
    if (!player.isDead && Math.random() < 0.45 + skill * 0.55) {
      bot.spawnIntuition(player, 2.5 + (1 - skill) * 9);
    }
  }
}
