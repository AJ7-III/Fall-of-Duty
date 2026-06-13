import type { Effects } from "../rendering/Effects";
import { MatchEvents } from "./MatchEvents";
import { TERMINATOR_LEVEL, difficultyLevelName } from "../bots/BotConfig";
import { StartCharacterPreview } from "./StartCharacterPreview";
import { RIVAL_DISPLAY_NAME, USER_DISPLAY_NAME } from "./MatchNames";
import { Settings } from "./Settings";

// All the "game" around the gunplay: the YOU/OPFOR scoreboard, kill banners
// and floating score popups, killstreak callouts, the kill feed, the pause
// menu (with the 1-10 enemy difficulty slider) and the match-end screen.
// Listens on MatchEvents so gameplay code never touches the DOM.

export type MatchResult = "victory" | "defeat" | "draw";

export interface MatchUICallbacks {
  onStart: () => void;
  onResume: () => void;
  onEndMatch: () => void;
  onPlayAgain: () => void;
  onDifficultyChange: (level: number) => void;
  onToggleTrashTalk: (muted: boolean) => void;
}

const WEAPON_NAMES: Record<string, string> = {
  mp44: "MP44", usp45: "USP .45", m40a3: "M40A3",
  airstrike: "AIRSTRIKE", apache: "APACHE",
};

// Streak callouts — the Fall of Duty reward ladder (Killstreaks delivers the goods;
// these are the announcements): [streak length, label, fanfare tier]
const STREAK_CALLS: ReadonlyArray<[number, string, number]> = [
  [3, "UAV RECON ONLINE", 1],
  [5, "AIRSTRIKE READY — PRESS C", 2],
  [7, "APACHE READY — PRESS C", 3],
];

export class MatchUI {
  private youEl = document.getElementById("sb-you");
  private enemyEl = document.getElementById("sb-enemy");
  private scoreboardEl = document.getElementById("scoreboard");
  private feedEl = document.getElementById("killfeed");
  private bannerEl = document.getElementById("kill-banner");
  private bannerTitleEl = document.getElementById("kill-banner-title");
  private bannerSubEl = document.getElementById("kill-banner-sub");
  private streakEl = document.getElementById("streak-banner");
  private pointsEl = document.getElementById("points-layer");

  private hudRootEl = document.getElementById("hud-root");
  private startEl = document.getElementById("start-overlay");
  private startDiffSlider = document.getElementById("start-diff-slider") as HTMLInputElement | null;
  private startDiffValueEl = document.getElementById("start-diff-value");
  private startDiffNameEl = document.getElementById("start-diff-name");
  private startPreview = new StartCharacterPreview("start-character-preview");

  private pauseEl = document.getElementById("menu-overlay");
  private pauseScoreEl = document.getElementById("pause-score");
  private endEl = document.getElementById("end-overlay");
  private endPanelEl = document.getElementById("end-panel");
  private endEmblemEl = document.getElementById("end-emblem");
  private endTitleEl = document.getElementById("end-title");
  private endSubtitleEl = document.getElementById("end-subtitle");
  private endScoreEl = document.getElementById("end-score");
  private endVerdictEl = document.getElementById("end-verdict");
  private endStatsEl = document.getElementById("end-stats");
  private countUpRafs: number[] = [];
  private diffSlider = document.getElementById("diff-slider") as HTMLInputElement | null;
  private diffValueEl = document.getElementById("diff-value");
  private diffNameEl = document.getElementById("diff-name");

  // "Mute Trash Talk" toggles — one on the start menu, one in the pause menu;
  // both reflect (and write) the same persisted setting.
  private trashToggleEls = [
    document.getElementById("btn-trash-start"),
    document.getElementById("btn-trash-pause"),
  ];
  private trashTalkMuted = Settings.getTrashTalkMuted();

  private lastYou = -1;
  private lastEnemy = -1;

  // Match stats for the end screen
  private streak = 0;
  private bestStreak = 0;
  private headshots = 0;
  private totalScore = 0;

  private effects: Effects;
  private getPlayerWeaponId: () => string;

  // Result emblems for the end screen. They inherit the result color via
  // `currentColor`, so the victory gold / defeat red theming flows straight in.
  private static readonly EMBLEMS: Record<MatchResult, string> = {
    victory: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">
        <path d="M16 7 L22 22" opacity="0.85"/><path d="M48 7 L42 22" opacity="0.85"/>
        <circle cx="32" cy="34" r="18" fill="currentColor" fill-opacity="0.12"/>
        <path d="M32 21 l3.7 7.7 8.3 1.1 -6.1 5.8 1.5 8.3 -7.4 -4 -7.4 4 1.5 -8.3 -6.1 -5.8 8.3 -1.1 Z" fill="currentColor" fill-opacity="0.95" stroke="none"/>
      </svg>`,
    defeat: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">
        <circle cx="32" cy="32" r="19" fill="currentColor" fill-opacity="0.1"/>
        <path d="M32 13 v22" /><path d="M32 35 l-9 12" opacity="0.6"/><path d="M32 35 l9 12" opacity="0.6"/>
        <circle cx="32" cy="44" r="2.6" fill="currentColor" stroke="none"/>
      </svg>`,
    draw: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
        <circle cx="32" cy="32" r="19" fill="currentColor" fill-opacity="0.08"/>
        <path d="M22 27 h20" /><path d="M22 37 h20" />
      </svg>`,
  };

  constructor(effects: Effects, getPlayerWeaponId: () => string, callbacks: MatchUICallbacks) {
    this.effects = effects;
    this.getPlayerWeaponId = getPlayerWeaponId;
    document.getElementById("btn-start")?.addEventListener("click", () => callbacks.onStart());
    document.getElementById("btn-resume")?.addEventListener("click", () => callbacks.onResume());
    document.getElementById("btn-end")?.addEventListener("click", () => callbacks.onEndMatch());
    document.getElementById("btn-again")?.addEventListener("click", () => callbacks.onPlayAgain());

    this.startDiffSlider?.addEventListener("input", () => {
      const level = parseInt(this.startDiffSlider!.value, 10);
      this.renderDifficulty(level);
      callbacks.onDifficultyChange(level);
    });

    this.diffSlider?.addEventListener("input", () => {
      const level = parseInt(this.diffSlider!.value, 10);
      this.renderDifficulty(level);
      callbacks.onDifficultyChange(level);
    });

    for (const el of this.trashToggleEls) {
      el?.addEventListener("click", () => {
        this.trashTalkMuted = !this.trashTalkMuted;
        Settings.setTrashTalkMuted(this.trashTalkMuted);
        this.renderTrashTalk();
        callbacks.onToggleTrashTalk(this.trashTalkMuted);
      });
    }
    this.renderTrashTalk();

    MatchEvents.on("kill", (e) => this.onKill(e.headshot, e.cause));
    MatchEvents.on("playerDeath", (e) => this.onPlayerDeath(e.weaponId, e.self ?? false));
  }

  // ------------------------------------------------------------- scoreboard

  public setScore(you: number, enemy: number): void {
    if (you === this.lastYou && enemy === this.lastEnemy) return;
    const youChanged = you !== this.lastYou && this.lastYou >= 0;
    const enemyChanged = enemy !== this.lastEnemy && this.lastEnemy >= 0;
    this.lastYou = you;
    this.lastEnemy = enemy;
    if (this.youEl) this.youEl.innerText = you.toString();
    if (this.enemyEl) this.enemyEl.innerText = enemy.toString();
    if (youChanged && this.youEl?.parentElement) this.pulse(this.youEl.parentElement, "sb-pulse");
    if (enemyChanged && this.enemyEl?.parentElement) this.pulse(this.enemyEl.parentElement, "sb-pulse");
    // the leading side glows
    this.scoreboardEl?.classList.toggle("you-lead", you > enemy);
    this.scoreboardEl?.classList.toggle("enemy-lead", enemy > you);
  }

  // ------------------------------------------------------------ kill events

  private onKill(headshot: boolean, cause: "player" | "airstrike" | "apache"): void {
    this.streak++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    if (headshot) this.headshots++;
    const points = headshot ? 150 : 100;
    this.totalScore += points;

    // streak kills credit the streak in the feed, not whatever gun is in hand
    const weapon = cause === "player" ? WEAPON_NAMES[this.getPlayerWeaponId()] ?? "—" : WEAPON_NAMES[cause];
    this.banner(headshot ? "HEADSHOT" : "ENEMY DOWN", headshot);
    this.floatPoints(`+${points}`, headshot);
    this.addFeedRow("YOU", weapon, "OPFOR", false);
    this.effects.playKillSound(headshot);

    for (const [count, label, tier] of STREAK_CALLS) {
      if (this.streak === count) {
        this.streakCall(`${label} · ${count}`);
        this.effects.playStreakSound(tier);
      }
    }
  }

  private onPlayerDeath(weaponId: string, self: boolean): void {
    this.streak = 0;
    this.addFeedRow(self ? "YOU" : "OPFOR", WEAPON_NAMES[weaponId] ?? "—", "YOU", true);
  }

  // --------------------------------------------------------------- juice bits

  // Restart a CSS animation on an element that may still be mid-animation
  private pulse(el: HTMLElement, klass: string): void {
    el.classList.remove(klass);
    void el.offsetWidth; // reflow resets the animation clock
    el.classList.add(klass);
  }

  private banner(title: string, headshot: boolean): void {
    if (!this.bannerEl || !this.bannerTitleEl || !this.bannerSubEl) return;
    this.bannerTitleEl.innerText = title;
    this.bannerSubEl.innerText = this.streak > 1 ? `KILLSTREAK ×${this.streak}` : "";
    this.bannerEl.classList.toggle("headshot", headshot);
    this.bannerEl.classList.remove("hidden");
    this.pulse(this.bannerEl, "play");
  }

  private streakCall(text: string): void {
    if (!this.streakEl) return;
    this.streakEl.innerText = text;
    this.streakEl.classList.remove("hidden");
    this.pulse(this.streakEl, "play");
  }

  private floatPoints(text: string, headshot: boolean): void {
    if (!this.pointsEl) return;
    const span = document.createElement("span");
    span.className = headshot ? "pt headshot" : "pt";
    span.innerText = text;
    span.style.setProperty("--drift", `${(Math.random() * 56 - 28).toFixed(0)}px`);
    this.pointsEl.appendChild(span);
    span.addEventListener("animationend", () => span.remove());
  }

  private addFeedRow(left: string, weapon: string, right: string, enemyKill: boolean): void {
    if (!this.feedEl) return;
    const row = document.createElement("div");
    row.className = enemyKill ? "kf-row enemy" : "kf-row";
    row.innerHTML = `<b>${left}</b><span class="kf-weapon">[ ${weapon} ]</span><b>${right}</b>`;
    this.feedEl.prepend(row);
    while (this.feedEl.children.length > 5) this.feedEl.lastElementChild?.remove();
    setTimeout(() => row.remove(), 5000);
  }

  // ----------------------------------------------------------- pause + end

  public showStart(level: number): void {
    this.renderDifficulty(level);
    this.hudRootEl?.classList.add("start-screen-active");
    this.startEl?.classList.remove("hidden");
    this.startPreview.start();
  }

  public hideStart(): void {
    this.hudRootEl?.classList.remove("start-screen-active");
    this.startEl?.classList.add("hidden");
    this.startPreview.stop();
  }

  public showPause(you: number, enemy: number, level: number): void {
    if (this.pauseScoreEl) this.pauseScoreEl.innerText = `YOU ${you} — ${enemy} OPFOR`;
    if (this.diffSlider) this.diffSlider.value = level.toString();
    this.renderDifficulty(level);
    this.pauseEl?.classList.remove("hidden");
  }

  public hidePause(): void {
    this.pauseEl?.classList.add("hidden");
  }

  public showEnd(result: MatchResult, you: number, enemy: number): void {
    this.hidePause();
    this.cancelCountUps();

    const youWon = result === "victory";
    const enemyWon = result === "defeat";

    if (this.endPanelEl) this.endPanelEl.className = `end-panel result-${result}`;
    if (this.endEmblemEl) this.endEmblemEl.innerHTML = MatchUI.EMBLEMS[result];

    if (this.endTitleEl) {
      this.endTitleEl.innerText = result === "victory" ? "VICTORY" : result === "defeat" ? "DEFEATED" : "DRAW";
      this.endTitleEl.className = result;
    }

    if (this.endSubtitleEl) {
      this.endSubtitleEl.innerText =
        result === "victory" ? "ENEMY FORCE ELIMINATED"
        : result === "defeat" ? "YOU WERE ELIMINATED"
        : "STALEMATE — NO WINNER";
    }

    // Winner pill rides whichever side took the match
    const youBadge = youWon ? `<span class="end-winner">WINNER</span>` : "";
    const enemyBadge = enemyWon ? `<span class="end-winner">WINNER</span>` : "";
    if (this.endScoreEl) {
      this.endScoreEl.innerHTML = `
        <div class="end-score-row end-score-head">
          <span>OPERATOR</span>
          <span>SCORE</span>
        </div>
        <div class="end-score-row you${youWon ? " is-winner" : ""}">
          <span class="end-username">${USER_DISPLAY_NAME}${youBadge}</span>
          <span class="end-score-num" data-count="${you}">0</span>
        </div>
        <div class="end-score-row enemy${enemyWon ? " is-winner" : ""}">
          <span class="end-username">${RIVAL_DISPLAY_NAME}${enemyBadge}</span>
          <span class="end-score-num" data-count="${enemy}">0</span>
        </div>
      `;
    }

    if (this.endVerdictEl) {
      this.endVerdictEl.innerText =
        result === "victory" ? `You outgunned ${RIVAL_DISPLAY_NAME}.`
        : result === "defeat" ? `${RIVAL_DISPLAY_NAME} got the better of you.`
        : `Neither side broke.`;
    }

    const kd = enemy === 0 ? you.toFixed(2) : (you / enemy).toFixed(2);
    if (this.endStatsEl) {
      this.endStatsEl.innerHTML = ([
        ["KILLS", you, 0],
        ["DEATHS", enemy, 0],
        ["K / D", kd, 2],
        ["HEADSHOTS", this.headshots, 0],
        ["BEST STREAK", this.bestStreak, 0],
        ["SCORE", this.totalScore, 0],
      ] as ReadonlyArray<[string, number | string, number]>)
        .map(([k, v, d]) =>
          `<div class="stat"><span class="stat-v" data-count="${v}" data-decimals="${d}">${d ? (0).toFixed(d) : 0}</span><span class="stat-k">${k}</span></div>`
        )
        .join("");
    }

    this.endEl?.classList.remove("hidden");
    // Roll every numeric readout up from zero once the panel is on screen
    this.startCountUps();

    if (result === "victory") this.effects.playVictorySound();
    else this.effects.playDefeatSound();
  }

  // Animate all [data-count] readouts inside the end screen from 0 to target.
  private startCountUps(): void {
    const els = this.endEl?.querySelectorAll<HTMLElement>("[data-count]");
    if (!els) return;
    const DURATION = 850;
    els.forEach((el, i) => {
      const target = parseFloat(el.dataset.count ?? "0");
      const decimals = parseInt(el.dataset.decimals ?? "0", 10);
      if (!isFinite(target)) return;
      const start = performance.now() + i * 45; // slight stagger down the list
      const tick = (now: number): void => {
        const t = Math.min(1, Math.max(0, (now - start) / DURATION));
        // easeOutCubic for a quick-then-settle count
        const eased = 1 - Math.pow(1 - t, 3);
        const val = target * eased;
        el.textContent = decimals ? val.toFixed(decimals) : Math.round(val).toString();
        if (t < 1) this.countUpRafs.push(requestAnimationFrame(tick));
      };
      this.countUpRafs.push(requestAnimationFrame(tick));
    });
  }

  private cancelCountUps(): void {
    for (const id of this.countUpRafs) cancelAnimationFrame(id);
    this.countUpRafs = [];
  }

  public resetMatch(): void {
    this.streak = 0;
    this.bestStreak = 0;
    this.headshots = 0;
    this.totalScore = 0;
    this.lastYou = -1;
    this.lastEnemy = -1;
    this.setScore(0, 0);
    if (this.feedEl) this.feedEl.innerHTML = "";
    this.bannerEl?.classList.add("hidden");
    this.streakEl?.classList.add("hidden");
    this.cancelCountUps();
    this.endEl?.classList.add("hidden");
    this.hideStart();
    this.hidePause();
  }

  public dispose(): void {
    this.startPreview.dispose();
  }

  private renderTrashTalk(): void {
    for (const el of this.trashToggleEls) {
      if (!el) continue;
      el.setAttribute("aria-pressed", this.trashTalkMuted ? "true" : "false");
      const stateEl = el.querySelector(".trash-toggle-state");
      if (stateEl) stateEl.textContent = this.trashTalkMuted ? "ON" : "OFF";
    }
  }

  private renderDifficulty(level: number): void {
    const name = difficultyLevelName(level);
    if (this.diffSlider) this.diffSlider.value = level.toString();
    if (this.startDiffSlider) this.startDiffSlider.value = level.toString();
    if (this.diffValueEl) this.diffValueEl.innerText = level.toString();
    if (this.startDiffValueEl) this.startDiffValueEl.innerText = level.toString();
    for (const el of [this.diffNameEl, this.startDiffNameEl]) {
      if (!el) continue;
      el.innerText = name;
      // the top tiers get the liquid-metal sheen in the menu too
      el.classList.toggle("terminator", level >= TERMINATOR_LEVEL);
    }
  }
}
