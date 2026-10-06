import type { Vector3 } from "@babylonjs/core";
import { BotNav } from "./BotNav";
import { rand } from "./BotConfig";

// Route history belongs to navigation, independent of perception and gunplay.
export class BotRouteMemory {
  private recentDestNodes = new Int32Array(7).fill(-1);
  private recentDestCursor = 0;
  private recentDestCount = 0;
  public reset(): void {
    this.recentDestNodes.fill(-1);
    this.recentDestCursor = 0;
    this.recentDestCount = 0;
  }
  public penalty(node: number, destNode: number, previousDestNode: number, lastPatrolNode: number): number {
    let penalty = 1;
    if (node === destNode || node === previousDestNode || node === lastPatrolNode) penalty *= 0.22;
    for (let i = 0; i < this.recentDestCount; i++) {
      const recent = this.recentDestNodes[i];
      if (recent < 0) continue;
      if (node === recent) {
        penalty *= 0.12;
      } else {
        const dx = BotNav.xs[node] - BotNav.xs[recent];
        const dz = BotNav.zs[node] - BotNav.zs[recent];
        if (dx * dx + dz * dz < 2.8 * 2.8) penalty *= 0.55;
      }
    }
    if (previousDestNode >= 0) {
      const dx = BotNav.xs[node] - BotNav.xs[previousDestNode];
      const dz = BotNav.zs[node] - BotNav.zs[previousDestNode];
      if (dx * dx + dz * dz < 2.6 * 2.6) penalty *= 0.45;
    }
    return penalty;
  }

  public remember(node: number): void {
    if (node < 0) return;
    const prevIndex = (this.recentDestCursor + this.recentDestNodes.length - 1) % this.recentDestNodes.length;
    if (this.recentDestCount > 0 && this.recentDestNodes[prevIndex] === node) return;
    this.recentDestNodes[this.recentDestCursor] = node;
    this.recentDestCursor = (this.recentDestCursor + 1) % this.recentDestNodes.length;
    this.recentDestCount = Math.min(this.recentDestCount + 1, this.recentDestNodes.length);
  }
}

export function selectSearchNode(
  position: Vector3,
  likely: { x: number; z: number },
  raw: Vector3,
  sweepRadius: number,
  penalty: (node: number) => number
): number {
  const currentToLikelyX = likely.x - position.x;
  const currentToLikelyZ = likely.z - position.z;
  const currentToLikely = Math.sqrt(currentToLikelyX * currentToLikelyX + currentToLikelyZ * currentToLikelyZ);
  let best = -1;
  let bestScore = 0;

  for (let i = 0; i < BotNav.count; i++) {
    if (!BotNav.walkable[i]) continue;
    const nx = BotNav.xs[i];
    const nz = BotNav.zs[i];
    const runX = nx - position.x;
    const runZ = nz - position.z;
    const runDist = Math.sqrt(runX * runX + runZ * runZ);
    if (runDist < 1.8) continue;

    const predX = nx - likely.x;
    const predZ = nz - likely.z;
    const predDist = Math.sqrt(predX * predX + predZ * predZ);
    if (predDist > sweepRadius) continue;

    const toward =
      currentToLikely > 0.001 && runDist > 0.001
        ? Math.max(0, (currentToLikelyX * runX + currentToLikelyZ * runZ) / (currentToLikely * runDist))
        : 0.5;
    const pressure = currentToLikely > 0.001 ? 0.75 + 0.45 * Math.max(0, (currentToLikely - predDist) / currentToLikely) : 1;
    const proximity = 1 / (1 + predDist * 0.38);
    const stretch = Math.min(1, runDist / 5);
    const cover = BotNav.cover[i] ? 1.12 : 1;
    const score = proximity * stretch * (0.65 + 0.35 * toward) * pressure * cover * penalty(i) * rand(0.9, 1.1);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  if (best >= 0) return best;
  const led = BotNav.nearestNode(likely.x, likely.z);
  if (led >= 0) return led;
  return BotNav.nearestNode(raw.x, raw.z);
}

export function selectPatrolNode(
  position: Vector3,
  yaw: number,
  lastPatrolNode: number,
  previousDestNode: number,
  coverPreference: number,
  suspicion: Vector3 | null,
  penalty: (node: number) => number
): number {
  let best = -1;
  let bestScore = 0;
  for (let attempt = 0; attempt < 18; attempt++) {
    const n = BotNav.randomNodeNear(position.x, position.z, 13);
    if (n < 0 || n === lastPatrolNode || n === previousDestNode) continue;
    const dx = BotNav.xs[n] - position.x;
    const dz = BotNav.zs[n] - position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 3.4) continue; // a shuffle, not a patrol leg
    const stretch = Math.min(1, dist / 8);
    const ahead = 0.55 + 0.45 * ((Math.sin(yaw) * dx + Math.cos(yaw) * dz) / dist);
    const centerDist = Math.sqrt(BotNav.xs[n] * BotNav.xs[n] + BotNav.zs[n] * BotNav.zs[n]);
    const central = 1.15 - 0.3 * Math.min(1, centerDist / 15);
    const cover = BotNav.cover[n] ? 1 + coverPreference * 0.35 : 1;
    let suspicionBias = 1;
    if (suspicion) {
      const currentX = suspicion.x - position.x;
      const currentZ = suspicion.z - position.z;
      const candX = suspicion.x - BotNav.xs[n];
      const candZ = suspicion.z - BotNav.zs[n];
      const currentDist = Math.sqrt(currentX * currentX + currentZ * currentZ);
      const candDist = Math.sqrt(candX * candX + candZ * candZ);
      suspicionBias = 0.8 + Math.max(-0.2, Math.min(0.6, (currentDist - candDist) / Math.max(1, currentDist)));
    }
    const score = stretch * ahead * central * cover * suspicionBias * penalty(n) * rand(0.85, 1.15);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  // boxed into a corner where every sample failed: take anything walkable
  return best >= 0 ? best : BotNav.randomNodeNear(position.x, position.z, 12);
}
