import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { PlayerController } from "../player/PlayerController";
import type { BotDifficulty } from "./BotConfig";
import { BotNav } from "./BotNav";

export const SIGHT_SAMPLES: ReadonlyArray<{ h: number; lat: number; aimRank: number }> = [
  { h: 1.0, lat: 0, aimRank: 3 }, // head
  { h: 0.8, lat: 0, aimRank: 0 }, // chest (the old aim point)
  { h: 0.74, lat: -0.3, aimRank: 1 }, // shoulders — catch a sideways peek
  { h: 0.74, lat: 0.3, aimRank: 2 },
  { h: 0.45, lat: 0, aimRank: 4 }, // pelvis
  { h: 0.14, lat: 0, aimRank: 5 }, // shins showing under a car
];

export function samplePlayerBody(position: Vector3, p: PlayerController, i: number, out: Vector3): void {
  const s = SIGHT_SAMPLES[i];
  let rx = 0;
  let rz = 0;
  if (s.lat !== 0) {
    const dx = p.position.x - position.x;
    const dz = p.position.z - position.z;
    const h = Math.sqrt(dx * dx + dz * dz);
    if (h > 1e-4) {
      rx = dz / h;
      rz = -dx / h;
    }
  }
  out.set(p.position.x + rx * s.lat, p.position.y + p.eyeHeight * s.h, p.position.z + rz * s.lat);
}

export interface SightObservation {
  visible: boolean;
  exposure: number;
  aimSample: number;
}
const eye = new Vector3();
const sample = new Vector3();

// Reuses caller-owned results and scratch vectors on the single game thread.
export function observePlayer(
  position: Vector3,
  yaw: number,
  player: PlayerController,
  difficulty: BotDifficulty,
  alert: boolean,
  out: SightObservation
): void {
  out.visible = false;
  out.exposure = 0;
  const dx = player.position.x - position.x;
  const dz = player.position.z - position.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (player.isDead || dist >= difficulty.visionRange || dist <= 0.001) return;
  const coneCos = Math.cos(alert ? 1.31 : 0.96);
  if ((Math.sin(yaw) * dx + Math.cos(yaw) * dz) / dist <= coneCos) return;
  eye.set(position.x, position.y + 1.62, position.z);
  let seenCount = 0;
  let bestRank = Infinity;
  for (let i = 0; i < SIGHT_SAMPLES.length; i++) {
    samplePlayerBody(position, player, i, sample);
    if (BotNav.losBlocked(eye, sample)) continue;
    seenCount++;
    if (SIGHT_SAMPLES[i].aimRank < bestRank) {
      bestRank = SIGHT_SAMPLES[i].aimRank;
      out.aimSample = i;
    }
  }
  out.exposure = seenCount / SIGHT_SAMPLES.length;
  out.visible = out.exposure >= difficulty.sightMinExposure;
}
