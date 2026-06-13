// Bot tuning as data. Difficulty changes HUMAN limits — reaction delay, aim
// error, burst discipline, awareness — never bullet-sponge health or aimbot
// accuracy. damageScale is the one COD-style concession: harder enemies hit
// for more, like the campaign difficulties do.

export interface BotDifficulty {
  reactionTimeMs: number; // target confirmed -> first trigger pull
  aimErrorDegrees: number; // angular miss re-rolled per burst, decaying as they settle
  aimSettleSpeed: number; // 1/s — how fast the aim error and pursuit converge
  burstLength: [number, number]; // rounds per burst (auto weapons)
  burstCooldown: [number, number]; // seconds of re-aiming between bursts
  aggression: number; // 0..1: push vs hold, suppressive fire, late retreats
  coverPreference: number; // 0..1: weight of cover-adjacent attack positions
  flankChance: number; // chance a reposition swings wide of the player axis
  weaponSwitchSkill: number; // 0..1: quickswap to the pistol instead of reloading in your face
  reloadDiscipline: number; // 0..1: chance to top up the mag during lulls
  visionRange: number; // meters
  hearingRange: number; // meters — gunshots inside give a PRECISE fix; farther shots are heard map-wide but the fix blurs with distance
  sightMinExposure: number; // 0..1 — fraction of the player's silhouette samples that must be unoccluded to count as contact; recruits need most of a man, veterans engage a knee poking past a car
  damageScale: number; // multiplies bot weapon damage against the player
  healthScale: number; // multiplies bot max health — the ONE bullet-sponge concession, reserved for the Terminator tiers
}

export const BOT_DIFFICULTIES: Record<string, BotDifficulty> = {
  recruit: {
    reactionTimeMs: 850, aimErrorDegrees: 6.0, aimSettleSpeed: 2.2,
    burstLength: [2, 4], burstCooldown: [0.5, 1.1],
    aggression: 0.3, coverPreference: 0.8, flankChance: 0.08,
    weaponSwitchSkill: 0.25, reloadDiscipline: 0.35,
    visionRange: 18, hearingRange: 12, sightMinExposure: 0.55, damageScale: 0.5, healthScale: 1,
  },
  regular: {
    reactionTimeMs: 650, aimErrorDegrees: 4.0, aimSettleSpeed: 3.0,
    burstLength: [2, 5], burstCooldown: [0.35, 0.9],
    aggression: 0.45, coverPreference: 0.75, flankChance: 0.15,
    weaponSwitchSkill: 0.4, reloadDiscipline: 0.5,
    visionRange: 22, hearingRange: 16, sightMinExposure: 0.4, damageScale: 0.65, healthScale: 1,
  },
  hardened: {
    reactionTimeMs: 480, aimErrorDegrees: 2.6, aimSettleSpeed: 4.2,
    burstLength: [3, 6], burstCooldown: [0.3, 0.7],
    aggression: 0.6, coverPreference: 0.65, flankChance: 0.25,
    weaponSwitchSkill: 0.6, reloadDiscipline: 0.7,
    visionRange: 26, hearingRange: 20, sightMinExposure: 0.21, damageScale: 0.8, healthScale: 1,
  },
  veteran: {
    reactionTimeMs: 320, aimErrorDegrees: 1.6, aimSettleSpeed: 5.5,
    burstLength: [4, 8], burstCooldown: [0.22, 0.55],
    aggression: 0.75, coverPreference: 0.55, flankChance: 0.35,
    weaponSwitchSkill: 0.8, reloadDiscipline: 0.85,
    visionRange: 30, hearingRange: 26, sightMinExposure: 0.12, damageScale: 1.0, healthScale: 1,
  },
  terminator: {
    reactionTimeMs: 210, aimErrorDegrees: 1.05, aimSettleSpeed: 7.2,
    burstLength: [5, 10], burstCooldown: [0.16, 0.38],
    aggression: 0.92, coverPreference: 0.45, flankChance: 0.52,
    weaponSwitchSkill: 0.95, reloadDiscipline: 0.95,
    visionRange: 34, hearingRange: 30, sightMinExposure: 0.08, damageScale: 1.08, healthScale: 1,
  },
};

// The settings menu offers a 1–10 slider instead of four named presets.
// Levels interpolate between the presets (1=recruit, 3=regular, 5=hardened,
// 8=veteran) so every notch is a real, monotonic skill step. The top end
// pushes from veteran into TERMINATOR: faster contact, tighter aim settling,
// shorter pauses, wider flanks, sharper hearing/vision and a small damage
// bump. Durability remains a separate 9/10 rule so it is easy to tune.
const LEVEL_ANCHORS: ReadonlyArray<[number, BotDifficulty]> = [
  [1, BOT_DIFFICULTIES.recruit],
  [3, BOT_DIFFICULTIES.regular],
  [5, BOT_DIFFICULTIES.hardened],
  [8, BOT_DIFFICULTIES.veteran],
  [10, BOT_DIFFICULTIES.terminator],
];

// Levels at or above this get the liquid-metal body and the health bonus
export const TERMINATOR_LEVEL = 9;

export function difficultyLevelName(level: number): string {
  return level <= 2 ? "Recruit"
    : level <= 4 ? "Regular"
    : level <= 7 ? "Hardened"
    : level <= 8 ? "Veteran"
    : "TERMINATOR";
}

// Writes the interpolated tuning INTO target: every live bot holds a
// reference to the manager's single difficulty object, so writing through
// it retunes the whole fleet mid-match with no rewiring.
export function applyDifficultyLevel(target: BotDifficulty, level: number): void {
  const L = Math.max(1, Math.min(10, level));
  let lo = LEVEL_ANCHORS[0];
  let hi = LEVEL_ANCHORS[LEVEL_ANCHORS.length - 1];
  for (let i = 0; i < LEVEL_ANCHORS.length - 1; i++) {
    if (L >= LEVEL_ANCHORS[i][0] && L <= LEVEL_ANCHORS[i + 1][0]) {
      lo = LEVEL_ANCHORS[i];
      hi = LEVEL_ANCHORS[i + 1];
      break;
    }
  }
  const t = hi[0] === lo[0] ? 0 : (L - lo[0]) / (hi[0] - lo[0]);
  const mix = (a: number, b: number): number => a + (b - a) * t;
  const a = lo[1];
  const b = hi[1];
  target.reactionTimeMs = mix(a.reactionTimeMs, b.reactionTimeMs);
  target.aimErrorDegrees = mix(a.aimErrorDegrees, b.aimErrorDegrees);
  target.aimSettleSpeed = mix(a.aimSettleSpeed, b.aimSettleSpeed);
  target.burstLength = [mix(a.burstLength[0], b.burstLength[0]), mix(a.burstLength[1], b.burstLength[1])];
  target.burstCooldown = [mix(a.burstCooldown[0], b.burstCooldown[0]), mix(a.burstCooldown[1], b.burstCooldown[1])];
  target.aggression = mix(a.aggression, b.aggression);
  target.coverPreference = mix(a.coverPreference, b.coverPreference);
  target.flankChance = mix(a.flankChance, b.flankChance);
  target.weaponSwitchSkill = mix(a.weaponSwitchSkill, b.weaponSwitchSkill);
  target.reloadDiscipline = mix(a.reloadDiscipline, b.reloadDiscipline);
  target.visionRange = mix(a.visionRange, b.visionRange);
  target.hearingRange = mix(a.hearingRange, b.hearingRange);
  target.sightMinExposure = mix(a.sightMinExposure, b.sightMinExposure);
  target.damageScale = mix(a.damageScale, b.damageScale);
  // Terminator durability is a level rule, not a preset: +10% at 9, +20% at 10
  target.healthScale = L >= 10 ? 1.2 : L >= TERMINATOR_LEVEL ? 1.1 : 1;
}

export function difficultyForLevel(level: number): BotDifficulty {
  const d: BotDifficulty = {
    ...BOT_DIFFICULTIES.regular,
    burstLength: [...BOT_DIFFICULTIES.regular.burstLength],
    burstCooldown: [...BOT_DIFFICULTIES.regular.burstCooldown],
  };
  applyDifficultyLevel(d, level);
  return d;
}

export interface BotWeaponProfile {
  id: "mp44" | "usp45" | "m40a3";
  damage: number; // per hit, before the difficulty damageScale
  fireInterval: number; // seconds between rounds inside a burst
  spreadDeg: number; // per-shot cone on top of the aim-error model
  magSize: number;
  reloadTime: number;
  range: [number, number, number, number]; // rangeCurve keys (trapezoid)
  // Bolt rifle overrides: one round per "burst", long deliberate re-aim
  burstLength?: [number, number];
  burstCooldown?: [number, number];
}

export const BOT_WEAPONS: Record<"mp44" | "usp45" | "m40a3", BotWeaponProfile> = {
  mp44: { id: "mp44", damage: 32, fireInterval: 0.1, spreadDeg: 1.4, magSize: 30, reloadTime: 2.4, range: [-1, 0, 12, 30] },
  usp45: { id: "usp45", damage: 24, fireInterval: 0.26, spreadDeg: 1.1, magSize: 12, reloadTime: 2.0, range: [-1, 0, 6, 16] },
  m40a3: {
    id: "m40a3", damage: 70, fireInterval: 1.45, spreadDeg: 0.25, magSize: 5, reloadTime: 3.2,
    range: [3, 9, 45, 90], burstLength: [1, 1], burstCooldown: [1.2, 2.0],
  },
};

// Trapezoid utility curve: 0.05 below a / above d, 1.0 between b and c.
// The floor is deliberate — the wrong gun for the range still shoots.
export function rangeCurve(x: number, [a, b, c, d]: [number, number, number, number]): number {
  if (x <= a || x >= d) return 0.05;
  if (x < b) return 0.05 + 0.95 * ((x - a) / (b - a));
  if (x > c) return 0.05 + 0.95 * ((d - x) / (d - c));
  return 1;
}

export function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

export const DEG = Math.PI / 180;
