import { Vector3 } from "@babylonjs/core";
import { PlayerController } from "../player/PlayerController";

// Spatial intelligence for the bots, derived entirely from the SAME oriented
// collision boxes the player collides with (PlayerController's registry):
//   - line-of-sight / bullet occlusion (3D segment-vs-OBB slab tests)
//   - a walkable waypoint grid + A*, built once at startup
// One source of truth: if a prop blocks the player, it blocks bot sight and
// bot pathing identically. No navmesh asset, no hand-traced graph to rot
// when the map changes — rebuilding the level rebuilds the bots' brains.

interface NavBox {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  minY: number;
  maxY: number;
  cos: number;
  sin: number;
}

// 1.2m spacing matters: the NS lane narrows to ~1m between the NW block and
// the center barrels, and a coarser grid drops every node in that throat —
// severing the center cross from the graph and exiling bots to the ring
const GRID_STEP = 1.2;
const GRID_HALF = 15.0; // node band inside the walls
const BODY_RADIUS = 0.42; // bot capsule + a sliver of skin for pathing
const WALK_BAND_LO = 0.15; // obstacles overlapping this y-band block walking...
const WALK_BAND_HI = 1.75; // ...anything fully above it (container roofs) does not
const COVER_MIN_HEIGHT = 1.2; // adjacent blockers at least this tall count as cover

class BotNavSystem {
  private boxes: NavBox[] = [];

  // Grid nodes (column-major: index = ix * side + iz)
  private side = 0;
  public count = 0;
  public xs!: Float32Array;
  public zs!: Float32Array;
  public walkable!: Uint8Array;
  public cover!: Uint8Array; // node sits beside something tall enough to duck behind
  private edges: number[][] = [];

  // A* scratch, allocated once
  private g!: Float32Array;
  private came!: Int32Array;
  private state!: Uint8Array; // 0 unseen, 1 open, 2 closed

  // Snapshot the obstacle registry and grow the waypoint graph over it.
  // Call once, after the map has registered all of its collision boxes.
  public build(): void {
    this.boxes = PlayerController.getObstacles().map((o) => ({
      cx: o.cx, cz: o.cz, hw: o.hw, hd: o.hd, minY: o.minY, maxY: o.maxY,
      cos: Math.cos(o.yaw), sin: Math.sin(o.yaw),
    }));

    this.side = Math.round((GRID_HALF * 2) / GRID_STEP) + 1;
    this.count = this.side * this.side;
    this.xs = new Float32Array(this.count);
    this.zs = new Float32Array(this.count);
    this.walkable = new Uint8Array(this.count);
    this.cover = new Uint8Array(this.count);
    this.edges = new Array(this.count);
    this.g = new Float32Array(this.count);
    this.came = new Int32Array(this.count);
    this.state = new Uint8Array(this.count);

    for (let ix = 0; ix < this.side; ix++) {
      for (let iz = 0; iz < this.side; iz++) {
        const i = ix * this.side + iz;
        this.xs[i] = -GRID_HALF + ix * GRID_STEP;
        this.zs[i] = -GRID_HALF + iz * GRID_STEP;
        this.walkable[i] = this.walkBlocked(this.xs[i], this.zs[i], this.xs[i], this.zs[i]) ? 0 : 1;
      }
    }

    for (let ix = 0; ix < this.side; ix++) {
      for (let iz = 0; iz < this.side; iz++) {
        const i = ix * this.side + iz;
        const list: number[] = [];
        let coverAdj = false;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            const nx = ix + dx;
            const nz = iz + dz;
            if (nx < 0 || nz < 0 || nx >= this.side || nz >= this.side) continue;
            const n = nx * this.side + nz;
            if (this.walkable[i] && this.walkable[n] && !this.walkBlocked(this.xs[i], this.zs[i], this.xs[n], this.zs[n])) {
              list.push(n);
            }
            if (!this.walkable[n] && this.tallAt(this.xs[n], this.zs[n])) {
              coverAdj = true;
            }
          }
        }
        this.edges[i] = list;
        this.cover[i] = this.walkable[i] && coverAdj ? 1 : 0;
      }
    }
  }

  // Is there a chest-high blocker at this spot? (cover detection)
  private tallAt(x: number, z: number): boolean {
    for (const b of this.boxes) {
      if (b.maxY < COVER_MIN_HEIGHT || b.minY > 0.6) continue;
      const dx = x - b.cx;
      const dz = z - b.cz;
      const lx = b.cos * dx - b.sin * dz;
      const lz = b.sin * dx + b.cos * dz;
      if (Math.abs(lx) < b.hw + BODY_RADIUS && Math.abs(lz) < b.hd + BODY_RADIUS) return true;
    }
    return false;
  }

  // 2D capsule-ish walk test: the segment (or point, when both ends match)
  // against every box inflated by the body radius, filtered to boxes that
  // actually overlap the walking height band. Low pallets block movement
  // here even though eye-level sight passes straight over them.
  public walkBlocked(x0: number, z0: number, x1: number, z1: number): boolean {
    for (const b of this.boxes) {
      if (b.minY > WALK_BAND_HI || b.maxY < WALK_BAND_LO) continue;

      // segment into the box's local frame
      const px = b.cos * (x0 - b.cx) - b.sin * (z0 - b.cz);
      const pz = b.sin * (x0 - b.cx) + b.cos * (z0 - b.cz);
      const qx = b.cos * (x1 - b.cx) - b.sin * (z1 - b.cz);
      const qz = b.sin * (x1 - b.cx) + b.cos * (z1 - b.cz);
      const dx = qx - px;
      const dz = qz - pz;
      const limX = b.hw + BODY_RADIUS;
      const limZ = b.hd + BODY_RADIUS;

      let t0 = 0;
      let t1 = 1;
      if (Math.abs(dx) < 1e-8) {
        if (Math.abs(px) >= limX) continue;
      } else {
        let ta = (-limX - px) / dx;
        let tb = (limX - px) / dx;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-8) {
        if (Math.abs(pz) >= limZ) continue;
      } else {
        let ta = (-limZ - pz) / dz;
        let tb = (limZ - pz) / dz;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }
      return true;
    }
    return false;
  }

  // True 3D occlusion between two points (eye-to-eye sight, muzzle-to-chest
  // fire lanes). No inflation: you can see exactly what physically clears.
  public losBlocked(from: Vector3, to: Vector3): boolean {
    return this.segmentHit(from.x, from.y, from.z, to.x - from.x, to.y - from.y, to.z - from.z, 1) !== Infinity;
  }

  // Where does a bullet stop? Nearest OBB entry or the ground plane within
  // maxDist; fills outPoint/outNormal and returns the distance, or Infinity.
  public rayHitWorld(origin: Vector3, dir: Vector3, maxDist: number, outPoint: Vector3, outNormal: Vector3): number {
    let best = this.segmentHit(origin.x, origin.y, origin.z, dir.x * maxDist, dir.y * maxDist, dir.z * maxDist, 1, outNormal);
    if (best !== Infinity) best *= maxDist;

    // ground plane
    if (dir.y < -1e-6) {
      const tFloor = -origin.y / dir.y;
      if (tFloor < best && tFloor <= maxDist) {
        best = tFloor;
        outNormal.set(0, 1, 0);
      }
    }
    if (best === Infinity) return Infinity;
    outPoint.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
    return best;
  }

  // Core 3D slab test: segment (p, d) over t in [0, tMax] against every box.
  // Returns the smallest entry t (or Infinity) and, if a normal receiver is
  // given, the world-space normal of the face that was entered.
  private segmentHit(
    px: number, py: number, pz: number,
    dx: number, dy: number, dz: number,
    tMax: number,
    outNormal?: Vector3
  ): number {
    let best = Infinity;
    for (const b of this.boxes) {
      // into the box's local frame (y is shared — boxes only yaw)
      const ox = b.cos * (px - b.cx) - b.sin * (pz - b.cz);
      const oz = b.sin * (px - b.cx) + b.cos * (pz - b.cz);
      const ldx = b.cos * dx - b.sin * dz;
      const ldz = b.sin * dx + b.cos * dz;

      let t0 = 0;
      let t1 = tMax;
      let axis = -1; // which slab produced the entry (0 x, 1 y, 2 z)
      let sign = 0;

      // x slab
      if (Math.abs(ldx) < 1e-9) {
        if (Math.abs(ox) >= b.hw) continue;
      } else {
        let ta = (-b.hw - ox) / ldx;
        let tb = (b.hw - ox) / ldx;
        let s = ldx > 0 ? -1 : 1;
        if (ta > tb) { const w = ta; ta = tb; tb = w; }
        if (ta > t0) { t0 = ta; axis = 0; sign = s; }
        t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }
      // y slab
      const cy = (b.minY + b.maxY) / 2;
      const hy = (b.maxY - b.minY) / 2;
      if (Math.abs(dy) < 1e-9) {
        if (Math.abs(py - cy) >= hy) continue;
      } else {
        let ta = (cy - hy - py) / dy;
        let tb = (cy + hy - py) / dy;
        let s = dy > 0 ? -1 : 1;
        if (ta > tb) { const w = ta; ta = tb; tb = w; }
        if (ta > t0) { t0 = ta; axis = 1; sign = s; }
        t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }
      // z slab
      if (Math.abs(ldz) < 1e-9) {
        if (Math.abs(oz) >= b.hd) continue;
      } else {
        let ta = (-b.hd - oz) / ldz;
        let tb = (b.hd - oz) / ldz;
        let s = ldz > 0 ? -1 : 1;
        if (ta > tb) { const w = ta; ta = tb; tb = w; }
        if (ta > t0) { t0 = ta; axis = 2; sign = s; }
        t1 = Math.min(t1, tb);
        if (t0 > t1) continue;
      }

      if (t0 < best && t0 > 0 && axis >= 0) {
        best = t0;
        if (outNormal) {
          // local face normal back out to world
          if (axis === 0) outNormal.set(b.cos * sign, 0, -b.sin * sign);
          else if (axis === 1) outNormal.set(0, sign, 0);
          else outNormal.set(b.sin * sign, 0, b.cos * sign);
        }
      }
    }
    return best;
  }

  // Snap a world position to the closest walkable node (expanding ring
  // search handles positions hugging an obstacle's inflated skin)
  public nearestNode(x: number, z: number): number {
    const ix = Math.round((x + GRID_HALF) / GRID_STEP);
    const iz = Math.round((z + GRID_HALF) / GRID_STEP);
    for (let r = 0; r <= 3; r++) {
      let bestNode = -1;
      let bestD2 = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
          const nx = ix + dx;
          const nz = iz + dz;
          if (nx < 0 || nz < 0 || nx >= this.side || nz >= this.side) continue;
          const n = nx * this.side + nz;
          if (!this.walkable[n]) continue;
          const ddx = this.xs[n] - x;
          const ddz = this.zs[n] - z;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < bestD2) { bestD2 = d2; bestNode = n; }
        }
      }
      if (bestNode >= 0) return bestNode;
    }
    return -1;
  }

  // A random walkable node within the radius — patrol destinations
  public randomNodeNear(x: number, z: number, radius: number): number {
    for (let attempt = 0; attempt < 14; attempt++) {
      const n = (Math.random() * this.count) | 0;
      if (!this.walkable[n]) continue;
      const dx = this.xs[n] - x;
      const dz = this.zs[n] - z;
      if (dx * dx + dz * dz < radius * radius) return n;
    }
    return -1;
  }

  // A* over the grid (euclidean heuristic). Small graph, so a linear scan
  // of the open list beats heap bookkeeping. Fills `out` start..goal.
  public findPath(start: number, goal: number, out: number[]): boolean {
    out.length = 0;
    if (start < 0 || goal < 0 || !this.walkable[start] || !this.walkable[goal]) return false;
    if (start === goal) {
      out.push(start);
      return true;
    }

    this.g.fill(Infinity);
    this.state.fill(0);
    const open: number[] = [start];
    this.g[start] = 0;
    this.state[start] = 1;
    const gx = this.xs[goal];
    const gz = this.zs[goal];

    while (open.length > 0) {
      // pull the lowest f = g + h
      let bestIdx = 0;
      let bestF = Infinity;
      for (let k = 0; k < open.length; k++) {
        const n = open[k];
        const hx = this.xs[n] - gx;
        const hz = this.zs[n] - gz;
        const f = this.g[n] + Math.sqrt(hx * hx + hz * hz);
        if (f < bestF) { bestF = f; bestIdx = k; }
      }
      const current = open[bestIdx];
      open[bestIdx] = open[open.length - 1];
      open.pop();
      this.state[current] = 2;

      if (current === goal) {
        let n = goal;
        while (n !== start) {
          out.push(n);
          n = this.came[n];
        }
        out.push(start);
        out.reverse();
        return true;
      }

      for (const n of this.edges[current]) {
        if (this.state[n] === 2) continue;
        const ex = this.xs[n] - this.xs[current];
        const ez = this.zs[n] - this.zs[current];
        const cost = this.g[current] + Math.sqrt(ex * ex + ez * ez);
        if (cost < this.g[n]) {
          this.g[n] = cost;
          this.came[n] = current;
          if (this.state[n] !== 1) {
            this.state[n] = 1;
            open.push(n);
          }
        }
      }
    }
    return false;
  }
}

// Single shared instance — the same pattern as PlayerController's static
// obstacle registry it is built from
export const BotNav = new BotNavSystem();
