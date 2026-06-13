import { PlayerController } from "../player/PlayerController";
import { ShipmentMap } from "../world/ShipmentMap";
import type { Bot } from "../bots/Bot";
import type { ApacheRadarContact } from "../killstreaks/Apache";

// Rotating top-down radar (CoD style): the player sits fixed at the center
// facing up, and the world rotates around them. Draws the arena bounds, the
// collision obstacles registered by ShipmentMap, and target blips.
export class Minimap {
  private canvas: HTMLCanvasElement | null;
  private ctx: CanvasRenderingContext2D | null = null;
  private map: ShipmentMap;

  // World meters visible from center to the map edge
  private viewRadius: number = 22;

  // Static world layer (boundary + obstacles) and the player wedge are baked
  // once: per frame they become two drawImage blits instead of ~50 path/rect
  // operations and a shadowBlur rasterization. Output is pixel-identical.
  private staticLayer: HTMLCanvasElement | null = null;
  private static readonly LAYER_PAD = 4; // keeps the boundary stroke inside the bake
  private wedgeSprite: HTMLCanvasElement | null = null;

  constructor(map: ShipmentMap) {
    this.map = map;
    this.canvas = document.getElementById("minimap") as HTMLCanvasElement | null;
    if (this.canvas) {
      this.ctx = this.canvas.getContext("2d");
    }
  }

  private getStaticLayer(scale: number): HTMLCanvasElement {
    if (this.staticLayer) return this.staticLayer;

    const pad = Minimap.LAYER_PAD;
    const wWorld = PlayerController.MAP_MAX_X - PlayerController.MAP_MIN_X;
    const dWorld = PlayerController.MAP_MAX_Z - PlayerController.MAP_MIN_Z;
    const layer = document.createElement("canvas");
    layer.width = Math.ceil(wWorld * scale) + pad * 2;
    layer.height = Math.ceil(dWorld * scale) + pad * 2;
    const ctx = layer.getContext("2d") as CanvasRenderingContext2D;

    // world (x, z) -> layer px; +z points up on the radar so z flips
    const lx = (worldX: number) => (worldX - PlayerController.MAP_MIN_X) * scale + pad;
    const ly = (worldZ: number) => (PlayerController.MAP_MAX_Z - worldZ) * scale + pad;

    // Arena boundary
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 3;
    ctx.strokeRect(lx(PlayerController.MAP_MIN_X), ly(PlayerController.MAP_MAX_Z), wWorld * scale, dWorld * scale);

    // Obstacles (crates, containers, barriers, tower) from the collision
    // data. Oriented boxes: rotate(yaw) in canvas space matches the world
    // yaw because the z-flip of the radar cancels in the symmetric rect.
    ctx.fillStyle = "rgba(200, 210, 220, 0.45)";
    for (const obs of PlayerController.getObstacles()) {
      ctx.save();
      ctx.translate(lx(obs.cx), ly(obs.cz));
      ctx.rotate(obs.yaw);
      ctx.fillRect(-obs.hw * scale, -obs.hd * scale, obs.hw * 2 * scale, obs.hd * 2 * scale);
      ctx.restore();
    }

    this.staticLayer = layer;
    return layer;
  }

  private getWedgeSprite(): HTMLCanvasElement {
    if (this.wedgeSprite) return this.wedgeSprite;

    // Wedge path spans x -7..7, y -10..8; the 4px shadow blur needs margin
    const sprite = document.createElement("canvas");
    sprite.width = 24;
    sprite.height = 28;
    const ctx = sprite.getContext("2d") as CanvasRenderingContext2D;
    ctx.translate(12, 14);
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 3);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fillStyle = "#f0f3f6";
    ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
    ctx.shadowBlur = 4;
    ctx.fill();

    this.wedgeSprite = sprite;
    return sprite;
  }

  // uavActive: the 3-kill streak reward — every living hostile pulses on the
  // radar for the duration, sold by a slow sweep line. uavTime drives the
  // pulse phase (game time, so the pause menu freezes the throb mid-beat).
  public update(
    player: PlayerController,
    bots: ReadonlyArray<Bot>,
    uavActive: boolean = false,
    uavTime: number = 0,
    apache: ApacheRadarContact | null = null
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    this.canvas.classList.toggle("uav", uavActive);
    this.canvas.classList.toggle("apache", apache !== null);

    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const scale = cx / this.viewRadius; // backing-store px per meter

    ctx.clearRect(0, 0, w, h);

    // Clip everything to the rounded map frame (matches the CSS border-radius)
    ctx.save();
    const r = 16;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    ctx.arcTo(0, 0, w, 0, r);
    ctx.closePath();
    ctx.clip();

    // Rotate the world so the player's facing direction points up.
    // World (x, z) maps to pre-rotation canvas (x, -z); rotating by -yaw then
    // keeps forward = (sin yaw, cos yaw) glued to screen-up.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-player.yaw);

    const px = player.position.x;
    const pz = player.position.z;
    const toMapX = (worldX: number) => (worldX - px) * scale;
    const toMapY = (worldZ: number) => -(worldZ - pz) * scale;

    // Arena boundary + obstacles: pre-baked layer, one rotated blit
    ctx.drawImage(
      this.getStaticLayer(scale),
      toMapX(PlayerController.MAP_MIN_X) - Minimap.LAYER_PAD,
      toMapY(PlayerController.MAP_MAX_Z) - Minimap.LAYER_PAD
    );

    // Target blips: red when standing, dim gray while tipped over
    for (const target of this.map.targets) {
      const tx = toMapX(target.mesh.position.x);
      const ty = toMapY(target.mesh.position.z);
      ctx.beginPath();
      ctx.arc(tx, ty, 5, 0, Math.PI * 2);
      ctx.fillStyle = target.isDown ? "rgba(120, 120, 120, 0.5)" : "#ff3b30";
      ctx.fill();
    }

    // Bot blips, COD radar rule: firing paints you for a couple of seconds,
    // silent enemies stay off the map — unless the UAV is overhead, which
    // paints EVERYONE alive, pulsing so the reveal reads as live recon
    if (uavActive) {
      const throb = 0.5 + 0.5 * Math.sin(uavTime * 5.5);
      ctx.save();
      ctx.fillStyle = "#ff3b30";
      ctx.shadowColor = "rgba(255, 80, 60, 0.9)";
      ctx.shadowBlur = 6 + throb * 9;
      for (const bot of bots) {
        if (bot.dead) continue;
        ctx.beginPath();
        ctx.arc(toMapX(bot.position.x), toMapY(bot.position.z), 4.2 + throb * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // the sweep: a green second hand with a fading wake, spinning over the world
      const sweepA = uavTime * 1.8;
      const sweepR = Math.SQRT2 * cx;
      ctx.save();
      ctx.fillStyle = "rgba(110, 240, 150, 0.09)";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, sweepR, sweepA - 0.85, sweepA);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(140, 255, 170, 0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(sweepA) * sweepR, Math.sin(sweepA) * sweepR);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = "#ff3b30";
      for (const bot of bots) {
        if (bot.dead || bot.radarTimer <= 0) continue;
        ctx.beginPath();
        ctx.arc(toMapX(bot.position.x), toMapY(bot.position.z), 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (apache) {
      const hx = toMapX(apache.x);
      const hy = toMapY(apache.z);
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(apache.yaw);
      ctx.strokeStyle = "rgba(255, 210, 77, 0.95)";
      ctx.fillStyle = "rgba(255, 210, 77, 0.9)";
      ctx.shadowColor = "rgba(255, 210, 77, 0.85)";
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-10, -1);
      ctx.lineTo(10, -1);
      ctx.moveTo(0, -12);
      ctx.lineTo(0, -17);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // North marker on the rim toward world +z, drawn unrotated so the glyph
    // stays upright while it orbits as the player turns
    const northDist = cx - 22;
    const nx = cx - Math.sin(player.yaw) * northDist;
    const ny = cy - Math.cos(player.yaw) * northDist;
    ctx.fillStyle = "rgba(240, 243, 246, 0.8)";
    ctx.font = "bold 22px 'Outfit', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", nx, ny);

    // Player wedge, fixed at center pointing up (baked sprite — rasterizing
    // a shadowBlur every frame is the most expensive op on this canvas)
    ctx.drawImage(this.getWedgeSprite(), cx - 12, cy - 14);

    ctx.restore();
  }
}
