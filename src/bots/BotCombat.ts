import type { Vector3 } from "@babylonjs/core";
import type { PlayerController } from "../player/PlayerController";
import { rangeCurve } from "./BotConfig";
import type { BotWeaponProfile } from "./BotConfig";

export function rayVsPlayerBody(origin: Vector3, dir: Vector3, p: PlayerController): number {
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

export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function selectWeapon(
  weapons: ReadonlyArray<{ clip: number; profile: BotWeaponProfile }>,
  active: number,
  distance: number,
  skill: number
): number {
  const primaryDry = weapons[0].clip === 0 ? 1.8 : 1;
  const scores = weapons.map((weapon, i) => {
    const ammo = 0.3 + 0.7 * (weapon.clip / weapon.profile.magSize);
    return rangeCurve(distance, weapon.profile.range) * ammo * (i === 1 ? primaryDry * 0.75 : 1);
  });
  const best = scores[0] >= scores[1] ? 0 : 1;
  return best !== active && scores[best] > scores[active] * (1 + (1 - skill) * 0.9) ? best : active;
}
