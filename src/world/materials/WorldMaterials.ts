import { Color3 } from "@babylonjs/core/Maths/math.color";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { PBRMaterial, Scene } from "@babylonjs/core";
import { canvasMat, flatMat, makeCanvasTexture, normalMapFromHeight, paintNoise } from "../../rendering/materials/canvas";

// Every surface of the Ship Box yard, painted procedurally at load time.
// Materials are cached by name on the scene, so the map, the wrecks and the
// targets can ask for the same finish without duplicating textures.
export class WorldMaterials {
  private scene: Scene;

  // Shared bullseye artwork, painted once and blitted into each target's
  // own texture (per-target textures let bullet holes be painted per board)
  private targetBoardBase: HTMLCanvasElement | null = null;
  private targetBoardCount = 0;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  // Weathered poured concrete with pocks, chips, grime streaks and cracks
  public createConcreteMaterial(uScale: number = 4, vScale: number = 4): PBRMaterial {
    return canvasMat(
      this.scene,
      `concreteMat_${uScale}_${vScale}`,
      512,
      { rough: 0.86, wet: 0.45, roughVar: 0.3, bump: 1.4, u: uScale, v: vScale },
      (ctx, s) => {
        ctx.fillStyle = "#97948c";
        ctx.fillRect(0, 0, s, s);
        paintNoise(ctx, s, ["#8f8c84", "#a3a098", "#878680", "#9c9991"], 260, 12, 60, 0.5);
        paintNoise(ctx, s, ["#7b7872", "#6d6a65"], 110, 2, 7, 0.5); // pock marks
        paintNoise(ctx, s, ["#b0ada5", "#a8a59d"], 80, 1, 4, 0.55); // light chips

        // vertical grime streaks
        for (let i = 0; i < 14; i++) {
          ctx.globalAlpha = 0.05 + Math.random() * 0.07;
          ctx.fillStyle = "#4d4b46";
          ctx.fillRect(Math.random() * s, 0, 6 + Math.random() * 30, s);
        }

        // expansion joints (tile seams)
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = "#5f5d58";
        ctx.lineWidth = 3;
        ctx.strokeRect(1, 1, s - 2, s - 2);

        // hairline cracks
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = "#67645f";
        ctx.lineWidth = 1;
        for (let i = 0; i < 7; i++) {
          ctx.beginPath();
          let x = Math.random() * s;
          let y = Math.random() * s;
          ctx.moveTo(x, y);
          for (let j = 0; j < 6; j++) {
            x += (Math.random() - 0.5) * 70;
            y += (Math.random() - 0.5) * 70;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    );
  }

  // Industrial painted-steel panels with seams, rivets, scratches and rust
  public createMetalMaterial(): PBRMaterial {
    return canvasMat(this.scene, "metalPanelMat", 512, { rough: 0.5, metal: 0.55, wet: 0.55, bump: 1.6 }, (ctx, s) => {
      ctx.fillStyle = "#3d434b";
      ctx.fillRect(0, 0, s, s);
      paintNoise(ctx, s, ["#363c44", "#434a53", "#3a4049"], 200, 10, 50, 0.5);

      // panel seams (2x2 grid)
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = "#21252b";
      ctx.lineWidth = 4;
      for (const p of [0, s / 2, s]) {
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, s);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, p);
        ctx.lineTo(s, p);
        ctx.stroke();
      }

      // rivets along seams
      ctx.globalAlpha = 0.9;
      for (const line of [8, s / 2 - 8, s / 2 + 8, s - 8]) {
        for (let i = 24; i < s; i += 48) {
          ctx.fillStyle = "#565e68";
          ctx.beginPath();
          ctx.arc(line, i, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#565e68";
          ctx.beginPath();
          ctx.arc(i, line, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // scratches
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#6f7782";
      ctx.lineWidth = 1;
      for (let i = 0; i < 22; i++) {
        const x = Math.random() * s,
          y = Math.random() * s,
          a = Math.random() * Math.PI;
        const len = 10 + Math.random() * 50;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }

      // rust specks
      paintNoise(ctx, s, ["#6e4a2f", "#7d5436", "#5c3e28"], 60, 1, 5, 0.5);
      ctx.globalAlpha = 1;
    });
  }

  // Bullseye artwork painted once into an offscreen canvas
  private getTargetBoardBase(): HTMLCanvasElement {
    if (this.targetBoardBase) return this.targetBoardBase;

    const s = 256;
    const canvas = document.createElement("canvas");
    canvas.width = s;
    canvas.height = s;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

    ctx.fillStyle = "#ded6bf"; // aged paper
    ctx.fillRect(0, 0, s, s);
    paintNoise(ctx, s, ["#d2cab3", "#e6dec8", "#c9c1ab"], 70, 6, 26, 0.4);

    const cx = s / 2,
      cy = s / 2;
    // printed scoring rings
    ctx.strokeStyle = "#2c2c2a";
    ctx.lineWidth = 3;
    for (const r of [104, 84, 64, 44]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // red center
    ctx.fillStyle = "#bf3a2b";
    ctx.beginPath();
    ctx.arc(cx, cy, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#7e2018";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 24, 0, Math.PI * 2);
    ctx.stroke();

    // crosshair tick marks
    ctx.strokeStyle = "#2c2c2a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 116, cy);
    ctx.lineTo(cx - 108, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 108, cy);
    ctx.lineTo(cx + 116, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - 116);
    ctx.lineTo(cx, cy - 108);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy + 108);
    ctx.lineTo(cx, cy + 116);
    ctx.stroke();

    // weathering over the print
    paintNoise(ctx, s, ["#b5ad97", "#a89f8a"], 30, 2, 9, 0.35);

    this.targetBoardBase = canvas;
    return canvas;
  }

  // Printed paper bullseye for the target boards. Each call returns a fresh
  // material whose texture is a private copy of the shared artwork, so the
  // bullet holes painted into one board never show up on the others.
  public createTargetBoardMaterial(): PBRMaterial {
    const id = this.targetBoardCount++;
    const tex = new DynamicTexture(`targetBoardTex_${id}`, { width: 256, height: 256 }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.drawImage(this.getTargetBoardBase(), 0, 0);
    tex.update();

    const mat = flatMat(this.scene, `targetBoardMat_${id}`, { albedo: [1, 1, 1], rough: 0.85, tex });
    return mat;
  }

  // Corrugation profile shared by the container albedo and its height map:
  // 1024 px across a 12.2 m side works out to ~40 ribs, each a trapezoid
  // with a flat crown and sloped flanks like the real pressing
  private static readonly RIB = 26;

  private static ribProfile(x: number): number {
    const t = (x % WorldMaterials.RIB) / WorldMaterials.RIB;
    if (t < 0.12) return t / 0.12; // rising flank
    if (t < 0.5) return 1; // crown
    if (t < 0.62) return 1 - (t - 0.5) / 0.12; // falling flank
    return 0; // valley
  }

  // Dedicated height field: ribs, the recessed frame rails, weld seams and
  // the corner castings — clean relief instead of luminance guesswork
  private static paintContainerHeight(ctx: CanvasRenderingContext2D, s: number): void {
    const img = ctx.createImageData(s, s);
    const d = img.data;
    for (let y = 0; y < s; y++) {
      const rail = y < 22 || y > s - 22 ? 0.35 : 1; // top/bottom rails sit back
      for (let x = 0; x < s; x++) {
        const v = (0.35 + 0.65 * WorldMaterials.ribProfile(x)) * rail;
        const i = (y * s + x) * 4;
        const c = v * 255;
        d[i] = c;
        d[i + 1] = c;
        d[i + 2] = c;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // vertical weld seams every quarter panel, and the corner castings
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    for (const x of [s * 0.25, s * 0.5, s * 0.75]) ctx.fillRect(x - 1.5, 0, 3, s);
    ctx.fillStyle = "#e8e8e8";
    for (const [x, y] of [
      [0, 0],
      [s - 44, 0],
      [0, s - 44],
      [s - 44, s - 44],
    ]) {
      ctx.fillRect(x, y, 44, 44);
    }
  }

  // Painted corrugated shipping-container steel, tinted per container:
  // shaded ribs, a weathered paint job with chips and rust runs, panel
  // seams, corner castings, and a stencilled owner code and placard
  public createContainerMaterial(key: string, base: string, shade: string): PBRMaterial {
    return canvasMat(
      this.scene,
      `containerMat_${key}`,
      1024,
      { rough: 0.48, metal: 0.3, wet: 0.65, roughVar: 0.2, bump: 2.2, height: WorldMaterials.paintContainerHeight },
      (ctx, s) => {
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, s, s);

        // rib shading — light catches the crowns and the rising flanks
        const rib = WorldMaterials.RIB;
        for (let x = 0; x < s; x += rib) {
          const g = ctx.createLinearGradient(x, 0, x + rib, 0);
          g.addColorStop(0, "rgba(0,0,0,0.3)");
          g.addColorStop(0.12, "rgba(255,255,255,0.12)");
          g.addColorStop(0.5, "rgba(255,255,255,0.04)");
          g.addColorStop(0.62, "rgba(0,0,0,0.22)");
          g.addColorStop(1, "rgba(0,0,0,0.32)");
          ctx.fillStyle = g;
          ctx.fillRect(x, 0, rib, s);
        }

        // sun-faded and re-painted patches, general grime
        paintNoise(ctx, s, [shade], 160, 14, 70, 0.22);
        paintNoise(ctx, s, ["rgba(255,255,255,1)"], 40, 20, 90, 0.05);
        paintNoise(ctx, s, ["#2a2622", "#1e1c19"], 260, 1, 3, 0.35); // paint chips

        // rust: runs bleeding down from the top rail and the seams, blooms
        // low where water sits
        const rustRun = (x: number, y: number, w: number, len: number, a: number): void => {
          const g = ctx.createLinearGradient(0, y, 0, y + len);
          g.addColorStop(0, `rgba(122,68,34,${a})`);
          g.addColorStop(0.5, `rgba(96,52,26,${a * 0.6})`);
          g.addColorStop(1, "rgba(96,52,26,0)");
          ctx.fillStyle = g;
          ctx.fillRect(x, y, w, len);
        };
        for (let i = 0; i < 18; i++)
          rustRun(
            Math.random() * s,
            18 + Math.random() * 30,
            2 + Math.random() * 8,
            60 + Math.random() * 280,
            0.35 + Math.random() * 0.3
          );
        for (const x of [s * 0.25, s * 0.5, s * 0.75]) {
          for (let i = 0; i < 4; i++)
            rustRun(x - 4 + Math.random() * 6, Math.random() * s * 0.6, 3 + Math.random() * 5, 80 + Math.random() * 200, 0.3);
        }
        paintNoise(ctx, s, ["#6b3f22", "#7d4a28", "#53301a"], 90, 3, 12, 0.35);
        ctx.globalAlpha = 0.28;
        for (let i = 0; i < 12; i++) {
          const g = ctx.createRadialGradient(Math.random() * s, s - 40 - Math.random() * 120, 2, s * 0.5, s - 60, 160);
          g.addColorStop(0, "rgba(110,60,30,0.6)");
          g.addColorStop(1, "rgba(110,60,30,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, s - 220, s, 220);
        }
        ctx.globalAlpha = 1;

        // vertical weld seams between the pressed panels
        for (const x of [s * 0.25, s * 0.5, s * 0.75]) {
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fillRect(x - 2, 0, 4, s);
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.fillRect(x + 2, 0, 1.5, s);
        }

        // owner code and serial, stencilled high on the panel, and a
        // placard low — the marks every box in a yard carries
        const codes = ["MRDN", "TQLU", "HGSU", "BSLU", "CRXU", "PKGU"];
        const code = codes[(key.length * 7 + key.charCodeAt(0)) % codes.length];
        const serial = `${((key.charCodeAt(0) * 31) % 900) + 100} ${((key.length * 173) % 900) + 100} ${key.charCodeAt(key.length - 1) % 10}`;
        ctx.fillStyle = "rgba(240,240,236,0.82)";
        ctx.font = `700 ${Math.round(s * 0.052)}px "Arial Narrow", Arial, sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillText(code, s * 0.06, s * 0.08);
        ctx.fillText(serial, s * 0.06, s * 0.14);
        ctx.font = `700 ${Math.round(s * 0.028)}px Arial, sans-serif`;
        ctx.fillText("22G1", s * 0.06, s * 0.2);
        ctx.fillText("MAX GROSS 30 480 KG · TARE 2 250 KG", s * 0.06, s * 0.86);
        // placard frame
        ctx.strokeStyle = "rgba(240,240,236,0.5)";
        ctx.lineWidth = 3;
        ctx.strokeRect(s * 0.72, s * 0.76, s * 0.2, s * 0.14);
        ctx.fillStyle = "rgba(240,240,236,0.6)";
        ctx.font = `700 ${Math.round(s * 0.024)}px Arial, sans-serif`;
        ctx.fillText("CSC SAFETY", s * 0.735, s * 0.775);
        ctx.fillText("APPROVAL", s * 0.735, s * 0.805);
        ctx.fillText("GB/L/1874/03", s * 0.735, s * 0.845);
        // grime over the lettering so it reads as old paint, not a decal
        paintNoise(ctx, s, [shade], 40, 10, 40, 0.18);

        // top/bottom frame rails and corner castings
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(0, 0, s, 22);
        ctx.fillRect(0, s - 22, s, 22);
        ctx.fillStyle = "#3a3a3c";
        for (const [x, y] of [
          [0, 0],
          [s - 44, 0],
          [0, s - 44],
          [s - 44, s - 44],
        ]) {
          ctx.fillRect(x, y, 44, 44);
          ctx.fillStyle = "#1c1c1e";
          ctx.fillRect(x + 12, y + 12, 20, 20); // the casting's oval hole
          ctx.fillStyle = "#3a3a3c";
        }
      }
    );
  }

  // Rough plank wood for crates and tower steps
  public createWoodCrateMaterial(): PBRMaterial {
    return canvasMat(this.scene, "woodCrateMat", 512, { rough: 0.8, wet: 0.3, bump: 1.6 }, (ctx, s) => {
      ctx.fillStyle = "#8f6f48";
      ctx.fillRect(0, 0, s, s);

      // horizontal planks with seams and grain
      for (let y = 0; y < s; y += 52) {
        ctx.fillStyle = `rgba(${60 + Math.random() * 30}, ${40 + Math.random() * 20}, ${20 + Math.random() * 12}, 0.25)`;
        ctx.fillRect(0, y, s, 52);
        ctx.fillStyle = "rgba(40, 26, 14, 0.8)";
        ctx.fillRect(0, y, s, 3);
        // grain strokes
        ctx.strokeStyle = "rgba(70, 50, 28, 0.35)";
        ctx.lineWidth = 1;
        for (let i = 0; i < 5; i++) {
          const gy = y + 8 + Math.random() * 38;
          ctx.beginPath();
          ctx.moveTo(0, gy);
          ctx.bezierCurveTo(s * 0.3, gy + (Math.random() - 0.5) * 8, s * 0.7, gy + (Math.random() - 0.5) * 8, s, gy);
          ctx.stroke();
        }
      }
      // knots
      paintNoise(ctx, s, ["#5c3f24", "#4e3520"], 8, 2, 5, 0.7);
      // crate frame border
      ctx.strokeStyle = "rgba(48, 32, 16, 0.85)";
      ctx.lineWidth = 14;
      ctx.strokeRect(7, 7, s - 14, s - 14);
    });
  }

  public createGrassMaterial(uScale: number = 10, vScale: number = 10): PBRMaterial {
    return canvasMat(
      this.scene,
      `grassMat_${uScale}_${vScale}`,
      512,
      { rough: 0.78, wet: 0.85, roughVar: 0.2, bump: 0.7, u: uScale, v: vScale },
      (ctx, s) => {
        // wet sheen
        ctx.fillStyle = "#42523a";
        ctx.fillRect(0, 0, s, s);
        paintNoise(ctx, s, ["#3a4a34", "#48583e", "#37452f", "#4d5c42"], 320, 8, 42, 0.5);
        paintNoise(ctx, s, ["#2e3c2a", "#334030"], 200, 2, 6, 0.4); // shadow clumps

        // blade flecks — short leaning strokes
        for (let i = 0; i < 900; i++) {
          ctx.globalAlpha = 0.22 + Math.random() * 0.3;
          ctx.strokeStyle = ["#55654a", "#4a5a40", "#5e6c50", "#3f4f36"][(Math.random() * 4) | 0];
          ctx.lineWidth = 1;
          const x = Math.random() * s;
          const y = Math.random() * s;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + (Math.random() - 0.5) * 3, y - (2 + Math.random() * 5));
          ctx.stroke();
        }

        // mud worn through + standing water
        paintNoise(ctx, s, ["#4a4136", "#3e362c", "#52483a"], 24, 6, 22, 0.3);
        paintNoise(ctx, s, ["#2c352e", "#28302c"], 16, 10, 30, 0.28);
        ctx.globalAlpha = 1;
      }
    );
  }

  // Flagstone lay for the walkways: an irregular grid of flat polygonal
  // slabs with tight dark joints, each slab its own tone, worn corners and
  // moss in the gaps. The height field is flat slabs over sunken joints so
  // the relief is edges, not domes.
  private stoneLayout: Array<{ pts: Array<[number, number]>; tone: number; wear: number }> | null = null;

  private getStoneLayout(s: number): Array<{ pts: Array<[number, number]>; tone: number; wear: number }> {
    if (this.stoneLayout) return this.stoneLayout;
    const cols = 6;
    const cell = s / cols;
    const jitter = cell * 0.22;
    // jittered lattice corners shared between neighbours so slabs interlock
    const corner = (i: number, j: number): [number, number] => {
      const seedX = ((i * 73 + j * 151) % 97) / 97;
      const seedZ = ((i * 31 + j * 17) % 89) / 89;
      return [i * cell + (seedX - 0.5) * jitter, j * cell + (seedZ - 0.5) * jitter];
    };
    const slabs: Array<{ pts: Array<[number, number]>; tone: number; wear: number }> = [];
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < cols; i++) {
        const stagger = j % 2 ? 0.5 : 0; // running bond
        const pts: Array<[number, number]> = [
          corner(i + stagger, j),
          corner(i + 1 + stagger, j),
          corner(i + 1 + stagger, j + 1),
          corner(i + stagger, j + 1),
        ];
        slabs.push({ pts, tone: (i * 7 + j * 3) % 6, wear: ((i * 13 + j * 29) % 10) / 10 });
      }
    }
    this.stoneLayout = slabs;
    return slabs;
  }

  private static tracePoly(
    ctx: CanvasRenderingContext2D,
    pts: Array<[number, number]>,
    ox: number,
    oy: number,
    inset: number
  ): void {
    // shrink toward the centroid for the joint gap
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    ctx.beginPath();
    pts.forEach(([x, y], k) => {
      const dx = x - cx;
      const dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const px = x - (dx / len) * inset + ox;
      const py = y - (dy / len) * inset + oy;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
  }

  public createStoneWalkwayMaterial(uScale: number = 2, vScale: number = 2): PBRMaterial {
    const slabs = this.getStoneLayout(512);
    const wrapOffsets: Array<[number, number]> = [
      [-512, -512],
      [0, -512],
      [512, -512],
      [-512, 0],
      [0, 0],
      [512, 0],
      [-512, 512],
      [0, 512],
      [512, 512],
    ];
    return canvasMat(
      this.scene,
      `stoneWalkMat_${uScale}_${vScale}`,
      512,
      {
        rough: 0.62,
        wet: 0.8,
        roughVar: 0.2,
        bump: 1.6,
        u: uScale,
        v: vScale,
        height: (ctx, s) => {
          ctx.fillStyle = "#2a2a2a"; // joints sit low
          ctx.fillRect(0, 0, s, s);
          for (const slab of slabs) {
            const lift = 200 + slab.wear * 40; // slabs sit a little unevenly
            ctx.fillStyle = `rgb(${lift},${lift},${lift})`;
            for (const [ox, oy] of wrapOffsets) {
              WorldMaterials.tracePoly(ctx, slab.pts, ox, oy, 5);
              ctx.fill();
            }
          }
          paintNoise(ctx, s, ["#9a9a9a", "#b8b8b8"], 400, 1, 3, 0.35); // pitting
        },
      },
      (ctx, s) => {
        ctx.fillStyle = "#2f2e2b"; // wet mortar
        ctx.fillRect(0, 0, s, s);
        paintNoise(ctx, s, ["#3a3a36", "#282825"], 120, 4, 16, 0.4);
        const tones = ["#6e6c66", "#63625c", "#77756d", "#5c5b55", "#6a675f", "#615e57"];
        for (const slab of slabs) {
          for (const [ox, oy] of wrapOffsets) {
            WorldMaterials.tracePoly(ctx, slab.pts, ox, oy, 5);
            ctx.fillStyle = tones[slab.tone];
            ctx.fill();
            // a darker rim where the worn edge falls away toward the joint
            ctx.strokeStyle = "rgba(30,30,28,0.45)";
            ctx.lineWidth = 3;
            ctx.stroke();
          }
        }
        // grime, chips, wet glints and moss in the joints
        paintNoise(ctx, s, ["#4a4944", "#3e3d39"], 180, 1, 5, 0.35);
        paintNoise(ctx, s, ["#8d8b82", "#96948b"], 70, 1, 3, 0.3);
        paintNoise(ctx, s, ["#46503a", "#3e4834"], 50, 2, 7, 0.3);
      }
    );
  }

  // Long-grass tuft textures. The cutout cannot live in the diffuse alpha:
  // canvas transparency stores black RGB, and mip/bilinear filtering bleeds
  // that black into the blade colors. So the diffuse is fully opaque
  // (blades over a grass-green bed) and the cutout comes from a separate
  // white-on-black mask used as an opacity texture (getAlphaFromRGB). Both
  // are painted from one shared blade layout so they align texel-perfect.
  private grassBladeLayout: Array<{
    baseX: number;
    baseW: number;
    tipX: number;
    tipY: number;
    tone: number;
  }> | null = null;

  private getGrassBladeLayout(s: number) {
    if (!this.grassBladeLayout) {
      this.grassBladeLayout = [];
      // a bunch of thin blades: a few tall ones, more short ones behind
      for (let i = 0; i < 17; i++) {
        const tall = Math.random() < 0.45;
        this.grassBladeLayout.push({
          baseX: s * 0.05 + (s * 0.9 * i) / 16 + (Math.random() - 0.5) * (s * 0.05),
          baseW: s * (0.02 + Math.random() * 0.02),
          tipX: (Math.random() - 0.5) * s * 0.3,
          tipY: s * (tall ? 0.02 + Math.random() * 0.2 : 0.35 + Math.random() * 0.3),
          tone: (Math.random() * 4) | 0,
        });
      }
    }
    return this.grassBladeLayout;
  }

  private paintGrassBlades(ctx: CanvasRenderingContext2D, s: number, colored: boolean): void {
    // dark, shaded base rising to a lighter, slightly yellowed tip — the
    // way a wet meadow reads with the light behind the deck
    const tones: Array<[string, string, string]> = [
      ["#1f2b1a", "#3d4f32", "#6b7d4e"],
      ["#22301d", "#455739", "#748558"],
      ["#1c2718", "#394a2f", "#647748"],
      ["#26331f", "#4a5c3d", "#7b8b5c"],
    ];
    for (const blade of this.getGrassBladeLayout(s)) {
      const tipX = blade.baseX + blade.tipX;
      const ctrlX = blade.baseX + (tipX - blade.baseX) * 0.25;
      const ctrlY = s * 0.55;
      if (colored) {
        const [lo, mid, hi] = tones[blade.tone];
        const g = ctx.createLinearGradient(0, s, 0, blade.tipY);
        g.addColorStop(0, lo);
        g.addColorStop(0.55, mid);
        g.addColorStop(1, hi);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = "#ffffff";
      }
      ctx.beginPath();
      ctx.moveTo(blade.baseX - blade.baseW / 2, s);
      ctx.quadraticCurveTo(ctrlX - blade.baseW * 0.2, ctrlY, tipX, blade.tipY);
      ctx.quadraticCurveTo(ctrlX + blade.baseW * 0.2, ctrlY + 10, blade.baseX + blade.baseW / 2, s);
      ctx.closePath();
      ctx.fill();
    }
  }

  public createGrassBladeTexture(): DynamicTexture {
    const cached = this.scene.getTextureByName("grassBladeTex");
    if (cached) return cached as DynamicTexture;

    return makeCanvasTexture(this.scene, "grassBladeTex", 512, (ctx, s) => {
      ctx.fillStyle = "#2a3824"; // opaque grass bed behind the blades (bleeds at the cutout edge)
      ctx.fillRect(0, 0, s, s);
      this.paintGrassBlades(ctx, s, true);
      // a central vein highlight down each blade sells the fold
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = "#9aab74";
      ctx.lineWidth = 1.2;
      for (const blade of this.getGrassBladeLayout(s)) {
        ctx.beginPath();
        ctx.moveTo(blade.baseX, s);
        ctx.quadraticCurveTo(blade.baseX + blade.tipX * 0.25, s * 0.55, blade.baseX + blade.tipX, blade.tipY + 12);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  public createGrassBladeMaskTexture(): DynamicTexture {
    const cached = this.scene.getTextureByName("grassBladeMaskTex");
    if (cached) return cached as DynamicTexture;

    return makeCanvasTexture(this.scene, "grassBladeMaskTex", 512, (ctx, s) => {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, s, s);
      this.paintGrassBlades(ctx, s, false);
    });
  }

  // Soft vertical streak for the rain particles (transparent background)
  public createRainStreakTexture(): DynamicTexture {
    const cached = this.scene.getTextureByName("rainStreakTex");
    if (cached) return cached as DynamicTexture;

    const tex = makeCanvasTexture(this.scene, "rainStreakTex", 64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      const g = ctx.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, "rgba(215,228,240,0)");
      g.addColorStop(0.35, "rgba(215,228,240,0.5)");
      g.addColorStop(0.65, "rgba(225,236,246,0.85)");
      g.addColorStop(1, "rgba(215,228,240,0)");
      ctx.fillStyle = g;
      ctx.fillRect(s * 0.42, 0, s * 0.16, s);
    });
    tex.hasAlpha = true;
    return tex;
  }

  public createContainerDoorMaterial(key: string, base: string, shade: string): PBRMaterial {
    return canvasMat(this.scene, `containerDoorMat_${key}`, 512, { rough: 0.5, metal: 0.3, wet: 0.65, bump: 2.0 }, (ctx, s) => {
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, s, s);

      // shallow horizontal door corrugation
      for (let y = 0; y < s; y += 22) {
        const g = ctx.createLinearGradient(0, y, 0, y + 22);
        g.addColorStop(0, "rgba(0,0,0,0.22)");
        g.addColorStop(0.4, "rgba(255,255,255,0.07)");
        g.addColorStop(1, "rgba(0,0,0,0.24)");
        ctx.fillStyle = g;
        ctx.fillRect(0, y, s, 22);
      }
      paintNoise(ctx, s, [base], 60, 6, 26, 0.18);

      // center seam between the two door leaves
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(s / 2 - 2, 0, 4, s);

      // four vertical lock rods with keeper brackets
      for (const fx of [0.16, 0.4, 0.6, 0.84]) {
        const x = fx * s;
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = "#9aa0a4";
        ctx.fillRect(x - 3, 8, 6, s - 16);
        ctx.fillStyle = "#5d6367";
        ctx.fillRect(x - 2, 8, 2, s - 16);
        ctx.fillStyle = "#74797d";
        for (let y = 30; y < s - 20; y += 60) {
          ctx.fillRect(x - 6, y, 12, 10); // brackets
        }
        // handle bars at waist height
        ctx.fillStyle = "#8b9094";
        ctx.fillRect(x - 3, s * 0.6, fx < 0.5 ? 26 : -20, 7);
      }

      // shipping placard, top right
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#cfd3cd";
      ctx.fillRect(s * 0.66, 18, 44, 30);
      ctx.fillStyle = "#41464a";
      ctx.fillRect(s * 0.66 + 5, 24, 34, 4);
      ctx.fillRect(s * 0.66 + 5, 32, 26, 3);
      ctx.fillRect(s * 0.66 + 5, 39, 30, 3);

      // rust bleeding off the hardware
      for (let i = 0; i < 8; i++) {
        ctx.globalAlpha = 0.1 + Math.random() * 0.14;
        ctx.fillStyle = "#6b4226";
        ctx.fillRect(Math.random() * s, Math.random() * s * 0.4, 3 + Math.random() * 6, 30 + Math.random() * 90);
      }

      // frame rails
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, s, 10);
      ctx.fillRect(0, s - 10, s, 10);
      ctx.fillRect(0, 0, 8, s);
      ctx.fillRect(s - 8, 0, 8, s);
      ctx.globalAlpha = 1;
    });
  }

  // Industrial window band for the out-of-bounds warehouse facades
  public createWindowBandMaterial(): PBRMaterial {
    return canvasMat(this.scene, "windowBandMat", 256, { rough: 0.3, metal: 0.2, u: 8, v: 1 }, (ctx, s) => {
      ctx.fillStyle = "#252b31";
      ctx.fillRect(0, 0, s, s);
      // panes with a faint sky-reflection gradient, some broken/dark
      for (let x = 0; x < s; x += 32) {
        for (let y = 0; y < s; y += 64) {
          const g = ctx.createLinearGradient(0, y, 0, y + 64);
          const broken = Math.random() < 0.18;
          g.addColorStop(0, broken ? "#1b1f23" : "#5a656d");
          g.addColorStop(1, broken ? "#15181b" : "#39424a");
          ctx.fillStyle = g;
          ctx.fillRect(x + 2, y + 3, 28, 58);
        }
      }
      // mullions
      ctx.fillStyle = "#8e979d";
      for (let x = 0; x <= s; x += 32) ctx.fillRect(x - 1, 0, 3, s);
      ctx.fillRect(0, s / 2 - 2, s, 4);
      paintNoise(ctx, s, ["#23282c"], 40, 2, 8, 0.25);
    });
  }

  // Weathered factory paint for the abandoned car: faded petrol blue with
  // door seams, chipped edges, rust freckles and rain-streak grime
  public createCarBodyMaterial(): PBRMaterial {
    return canvasMat(this.scene, "carBodyMat", 512, { rough: 0.32, metal: 0.55, wet: 0.5, bump: 0.9 }, (ctx, s) => {
      // wet clear-coat glint
      ctx.fillStyle = "#3f5560";
      ctx.fillRect(0, 0, s, s);
      paintNoise(ctx, s, ["#445a66", "#3a4f59", "#48606b", "#374a53"], 150, 8, 30, 0.4);

      // clear-coat sheen band along the shoulder line
      const sheen = ctx.createLinearGradient(0, 0, 0, s);
      sheen.addColorStop(0, "rgba(255,255,255,0.10)");
      sheen.addColorStop(0.35, "rgba(255,255,255,0.02)");
      sheen.addColorStop(1, "rgba(0,0,0,0.16)");
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, s, s);

      // door seams + wheel-arch shadows read as panel breaks
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = "#22313a";
      ctx.lineWidth = 2;
      for (const x of [s * 0.33, s * 0.62, s * 0.88]) {
        ctx.beginPath();
        ctx.moveTo(x, s * 0.1);
        ctx.lineTo(x, s);
        ctx.stroke();
      }

      // rust freckles concentrated low + chipped bright primer specks
      paintNoise(ctx, s, ["#6e4a2f", "#5c3e28"], 50, 1, 4, 0.45);
      paintNoise(ctx, s, ["#8da0a8", "#9fb1b8"], 30, 1, 2, 0.4);

      // rain-streak grime running down
      for (let i = 0; i < 12; i++) {
        ctx.globalAlpha = 0.06 + Math.random() * 0.08;
        ctx.fillStyle = "#1f2c33";
        ctx.fillRect(Math.random() * s, Math.random() * s * 0.3, 3 + Math.random() * 8, 40 + Math.random() * 120);
      }
      ctx.globalAlpha = 1;
    });
  }

  // Overcast sky: a low cloud deck with real structure — layered soft
  // blotches at three scales over the gradient, darker undersides, a
  // brighter horizon where the light leaks in under the cloud base
  // Overcast: a stratus deck built from 3D fractal noise evaluated on the
  // sphere's direction vectors — seamless around the dome, no pinch at the
  // zenith, low contrast like a real grey day. The deck brightens toward
  // the horizon where the light leaks in under it, thins near a soft sun
  // patch, and carries a slow large-scale drift of darker rain cells.
  public createSkyMaterial(): StandardMaterial {
    const S = 512;
    // hashed 3D value noise
    const hash = (x: number, y: number, z: number): number => {
      let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
      h = ((h ^ (h >>> 13)) * 1274126177) | 0;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    };
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    const noise = (x: number, y: number, z: number): number => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const zi = Math.floor(z);
      const fx = smooth(x - xi);
      const fy = smooth(y - yi);
      const fz = smooth(z - zi);
      const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
      const c00 = lerp(hash(xi, yi, zi), hash(xi + 1, yi, zi), fx);
      const c10 = lerp(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), fx);
      const c01 = lerp(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), fx);
      const c11 = lerp(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), fx);
      return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
    };
    const fbm = (x: number, y: number, z: number, octaves: number): number => {
      let sum = 0;
      let amp = 0.5;
      let f = 1;
      for (let i = 0; i < octaves; i++) {
        sum += amp * noise(x * f + 11.3 * i, y * f + 7.1 * i, z * f + 3.7 * i);
        amp *= 0.5;
        f *= 2.1;
      }
      return sum;
    };

    const tex = new DynamicTexture("skyTex", { width: S, height: S }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const img = ctx.createImageData(S, S);
    const d = img.data;
    // palette: cloud base, lit cloud, horizon haze, rain cell
    const base = [96, 102, 110];
    const lit = [168, 174, 180];
    const haze = [186, 190, 194];
    const rain = [70, 76, 84];
    const sunDir = [0.62, 0.34, 0.71]; // low, off to one side
    for (let row = 0; row < S; row++) {
      // canvas is uploaded flipped: row S is the zenith, row S/2 the horizon
      const v = row / S;
      const elevation = (v - 0.5) * Math.PI; // -90° (nadir) .. +90° (zenith)
      const ce = Math.cos(elevation);
      const se = Math.sin(elevation);
      for (let col = 0; col < S; col++) {
        const az = (col / S) * Math.PI * 2;
        const dx = Math.sin(az) * ce;
        const dy = se;
        const dz = Math.cos(az) * ce;
        // cloud deck lives on a flat plane above the viewer: project the ray
        // onto it so the texture reads as an overhead layer, not a painted ball
        const h = Math.max(0.08, dy);
        const px = (dx / h) * 1.6;
        const pz = (dz / h) * 1.6;
        const fade = Math.min(1, Math.max(0, (dy - 0.02) / 0.35)); // haze swallows the deck at the horizon
        const n = fbm(px, pz, 0.7, 5); // 0..~1
        const cells = fbm(px * 0.35 + 40, pz * 0.35 + 40, 2.1, 3); // big dark rain cells
        const dot = dx * sunDir[0] + dy * sunDir[1] + dz * sunDir[2];
        const sun = Math.pow(Math.max(0, dot), 6) * 0.55; // broad glow through the deck
        let t = n * 0.85 + sun - (cells - 0.5) * 0.5; // lit vs base mix
        t = Math.min(1, Math.max(0, t));
        const i = (row * S + col) * 4;
        for (let c = 0; c < 3; c++) {
          let deck = base[c] + (lit[c] - base[c]) * t;
          deck = deck + (rain[c] - deck) * Math.max(0, cells - 0.62) * 1.4;
          d[i + c] = deck + (haze[c] - deck) * (1 - fade);
        }
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    tex.update();

    const mat = new StandardMaterial("skyMat", this.scene);
    mat.emissiveTexture = tex;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.fogEnabled = false;
    return mat;
  }

  // Four wall strips share one atlas. Each strip has four curated pieces
  // rather than repeating the same square stamp six times along every wall.
  // The long faces choose a strip in ShipBoxMap; the small faces sample its
  // quiet left margin. 8px vertical gutters keep neighbouring walls out of
  // the filtered UVs. A 2MP albedo plus tiny concrete normal costs less than
  // the old three 1MP maps, and all four wall meshes can still merge.
  public createGraffitiWallMaterial(): PBRMaterial {
    const name = "graffitiWallAtlasMat";
    const cached = this.scene.getMaterialByName(name);
    if (cached) return cached as PBRMaterial;

    const tex = new DynamicTexture("graffitiWallAtlasTex", { width: 2048, height: 1024 }, this.scene, true);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8;
    WorldMaterials.paintGraffitiAtlas(tex.getContext() as CanvasRenderingContext2D);
    tex.update();

    // Concrete grain alone supplies relief. Deriving normals from the
    // coloured artwork made pale outlines swell and dark ink look carved.
    const normalSize = 256;
    const height = new Float32Array(normalSize * normalSize);
    for (let y = 0; y < normalSize; y++) {
      for (let x = 0; x < normalSize; x++) {
        const grain = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        height[y * normalSize + x] = 0.5 + (grain - Math.floor(grain) - 0.5) * 0.045;
      }
    }
    const bump = normalMapFromHeight(this.scene, "graffitiWallConcreteTex_n", height, normalSize, 1.0);
    return flatMat(this.scene, name, { albedo: [1, 1, 1], rough: 0.87, tex, bump });
  }

  private static paintGraffitiAtlas(ctx: CanvasRenderingContext2D): void {
    // The artwork is laid out in wall proportions (8.45m × 2.55m per
    // panel). The atlas compresses x to 512px, so letters retain their
    // intended proportions when those UVs cover the real wall geometry.
    const panelW = 800;
    const panelH = 256;
    let seed = 0x51f15e;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // Hand-drawn closed glyphs and marker strokes avoid platform fonts and
    // give the broad pieces, round throw-ups and small signatures distinct
    // silhouettes. Counters are filled with the even-odd rule.
    const blocks: Record<string, string> = {
      A: "M0 118L24 4L63 0L91 114L65 120L57 87L27 89L22 119Z M35 67L53 65L44 28Z",
      C: "M84 5L80 29L32 26L25 87L78 87L88 112L11 120L0 100L5 19L23 0Z",
      D: "M8 4L64 0L88 22L84 96L66 117L0 120Z M30 28L25 92L55 90L62 76L64 40L54 27Z",
      E: "M8 4L87 0L81 27L33 30L31 48L73 45L68 71L28 72L26 94L85 87L79 115L0 120Z",
      F: "M8 3L90 0L82 29L34 28L31 49L74 44L69 73L28 74L24 118L0 120Z",
      H: "M7 4L34 0L30 44L61 42L66 0L90 7L81 118L56 120L59 72L28 74L24 119L0 115Z",
      I: "M7 4L85 0L83 26L59 30L55 91L84 89L78 115L0 120L4 96L27 93L32 30L5 32Z",
      K: "M9 3L35 0L31 46L67 0L94 10L55 59L88 110L61 120L28 77L23 116L0 120Z",
      L: "M9 3L36 0L27 92L85 86L82 114L0 120Z",
      M: "M7 6L34 0L47 44L68 2L94 7L88 119L62 116L66 54L46 84L29 53L25 120L0 117Z",
      N: "M8 4L32 0L61 66L68 0L93 5L82 119L59 120L29 55L24 115L0 119Z",
      O: "M22 0L71 3L91 24L84 99L66 118L16 120L0 99L6 21Z M32 29L27 89L55 91L63 79L67 32Z",
      R: "M8 4L72 0L91 20L83 63L62 76L90 110L63 120L34 80L27 80L23 116L0 120Z M34 28L30 54L59 50L64 28Z",
      S: "M23 0L88 4L80 31L33 28L29 47L70 49L89 66L80 102L64 119L0 116L5 88L55 92L59 74L18 71L2 53L9 16Z",
      T: "M4 6L94 0L87 31L60 32L53 118L27 120L34 35L0 36Z",
      U: "M9 3L35 0L27 89L57 92L67 1L94 5L84 98L65 119L15 120L0 100Z",
      V: "M0 8L28 0L41 79L65 0L94 7L56 115L29 120Z",
      W: "M0 7L27 0L32 76L49 33L64 73L77 0L103 6L80 115L55 120L44 85L31 119L9 115Z",
      X: "M1 9L28 0L47 38L69 0L96 8L65 59L89 110L62 120L44 82L21 120L0 111L27 59Z",
      Y: "M0 9L27 0L45 38L69 0L96 8L57 69L52 116L25 120L30 71Z",
    };
    const strokes: Record<string, string> = {
      A: "M4 110L38 5Q42 -3 48 7L78 110M19 67L67 62",
      C: "M78 15Q32 -15 13 23Q-3 54 9 94Q23 128 77 102",
      D: "M13 111L17 8Q79 -6 80 53Q82 110 13 111",
      E: "M78 9L18 14L9 109L77 102M15 59L64 55",
      F: "M11 110L20 13L79 8M16 58L67 53",
      H: "M16 9L8 111M77 5L69 108M12 61L72 54",
      I: "M10 12L75 6M43 11L35 109M4 113L70 105",
      K: "M18 8L9 112M81 3L14 64L77 107",
      L: "M20 7L10 110L79 103",
      M: "M7 111L16 10L42 66L72 7L76 110",
      N: "M9 111L17 8L70 104L78 3",
      O: "M43 6Q2 8 7 66Q6 117 46 111Q84 106 81 51Q82 -1 43 6Z",
      R: "M10 112L18 11Q80 -6 78 36Q76 63 15 61M38 59L77 106",
      S: "M79 15Q37 -11 15 19Q-6 49 43 59Q94 69 70 101Q49 125 5 101",
      T: "M4 15L85 5M48 11L36 113",
      U: "M17 7L9 82Q7 123 45 111Q76 105 78 4",
      V: "M6 10L31 110L80 3",
      W: "M4 10L17 109L45 49L63 106L88 2",
      X: "M8 13L74 104M79 2L4 116",
      Y: "M6 10L39 56L81 2M39 56L30 113",
      "2": "M7 28Q38 -14 72 10Q97 37 12 107L82 102",
      "3": "M7 13Q73 -7 78 30Q80 52 39 57Q91 50 78 91Q66 122 4 102",
      "6": "M73 8Q18 14 9 76Q1 125 55 108Q89 101 74 64Q65 39 13 69",
      "7": "M4 16L84 7L27 112M18 58L61 53",
      "9": "M71 59Q15 86 9 35Q6 -5 58 8Q92 18 71 83L47 113",
    };

    type Piece = {
      word: string;
      style: "angular" | "bubble" | "marker";
      x: number;
      y: number;
      size: number;
      angle: number;
      top: string;
      bottom: string;
      edge: string;
      accent?: string;
    };
    const pieces: Piece[] = [
      {
        word: "RIFT",
        style: "angular",
        x: 365,
        y: 142,
        size: 132,
        angle: -0.055,
        top: "#e9ad61",
        bottom: "#b85b38",
        edge: "#eee0bf",
        accent: "76",
      },
      {
        word: "VEX",
        style: "marker",
        x: 445,
        y: 151,
        size: 48,
        angle: -0.12,
        top: "#393b37",
        bottom: "#393b37",
        edge: "#a5a197",
      },
      {
        word: "ECHO",
        style: "bubble",
        x: 402,
        y: 135,
        size: 130,
        angle: 0.025,
        top: "#9ebcb1",
        bottom: "#3d7b7e",
        edge: "#ded7c2",
        accent: "93",
      },
      {
        word: "SILO",
        style: "angular",
        x: 354,
        y: 143,
        size: 112,
        angle: -0.045,
        top: "#d2d0c3",
        bottom: "#899192",
        edge: "#343e46",
      },
      {
        word: "KENO",
        style: "bubble",
        x: 412,
        y: 137,
        size: 126,
        angle: -0.04,
        top: "#a8bacc",
        bottom: "#4c719d",
        edge: "#e2ddc7",
        accent: "SOL",
      },
      {
        word: "YARD",
        style: "marker",
        x: 280,
        y: 146,
        size: 44,
        angle: 0.035,
        top: "#d8d1b9",
        bottom: "#d8d1b9",
        edge: "#696e65",
      },
      {
        word: "WAVE",
        style: "angular",
        x: 408,
        y: 134,
        size: 136,
        angle: -0.02,
        top: "#789bb0",
        bottom: "#3d617e",
        edge: "#c8caba",
        accent: "27",
      },
      {
        word: "SOL",
        style: "marker",
        x: 510,
        y: 154,
        size: 58,
        angle: -0.11,
        top: "#323631",
        bottom: "#323631",
        edge: "#aaa69b",
      },
      {
        word: "NOX",
        style: "angular",
        x: 319,
        y: 141,
        size: 141,
        angle: 0.05,
        top: "#b8a5b7",
        bottom: "#79627e",
        edge: "#dbd1bc",
        accent: "VEX",
      },
      {
        word: "LARK",
        style: "bubble",
        x: 426,
        y: 145,
        size: 113,
        angle: -0.055,
        top: "#bbb996",
        bottom: "#7f865e",
        edge: "#d9d4bb",
      },
      {
        word: "DRFT",
        style: "marker",
        x: 318,
        y: 155,
        size: 47,
        angle: -0.07,
        top: "#353a36",
        bottom: "#353a36",
        edge: "#96998c",
      },
      {
        word: "HOME",
        style: "angular",
        x: 443,
        y: 136,
        size: 129,
        angle: 0.035,
        top: "#d7d0b9",
        bottom: "#a39a83",
        edge: "#405c64",
        accent: "69",
      },
      {
        word: "NOVA",
        style: "marker",
        x: 388,
        y: 135,
        size: 40,
        angle: -0.08,
        top: "#5b6258",
        bottom: "#5b6258",
        edge: "#b5b2a5",
      },
      {
        word: "HUSH",
        style: "bubble",
        x: 373,
        y: 142,
        size: 124,
        angle: -0.02,
        top: "#c7a293",
        bottom: "#9b6056",
        edge: "#d6d0b8",
        accent: "LARK",
      },
      {
        word: "DOCK",
        style: "angular",
        x: 429,
        y: 131,
        size: 131,
        angle: 0.045,
        top: "#ceb875",
        bottom: "#978349",
        edge: "#36474b",
      },
      {
        word: "NOVA",
        style: "marker",
        x: 507,
        y: 150,
        size: 55,
        angle: 0.02,
        top: "#d5d0bc",
        bottom: "#d5d0bc",
        edge: "#4c554f",
      },
    ];

    const drawWord = (piece: Piece): void => {
      const marker = piece.style === "marker";
      const round = piece.style === "bubble";
      const source = marker || round ? strokes : blocks;
      const word = new Path2D();
      const step = marker ? 69 : 89;
      const wordW = (piece.word.length - 1) * step + 88;
      for (let i = 0; i < piece.word.length; i++) {
        const glyph = new Path2D(source[piece.word[i]] ?? source.X);
        const tilt = [0.02, -0.015, 0.035, -0.025][i % 4];
        word.addPath(glyph, new DOMMatrix([1, tilt, -0.055, 1, i * step - wordW / 2, -59 + [0, 3, -2, 1][i % 4]]));
      }

      ctx.save();
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.angle);
      ctx.scale(piece.size / 120, piece.size / 120);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (marker) {
        ctx.transform(1, 0, -0.22, 1, 0, 0);
        ctx.globalAlpha = 0.33;
        ctx.strokeStyle = piece.edge;
        ctx.lineWidth = 9;
        ctx.stroke(word);
        ctx.globalAlpha = 0.84;
        ctx.strokeStyle = piece.top;
        ctx.lineWidth = 5;
        ctx.stroke(word);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-wordW * 0.58, 73);
        ctx.bezierCurveTo(-wordW * 0.08, 57, wordW * 0.4, 91, wordW * 0.66, 62);
        ctx.moveTo(wordW * 0.5, -50);
        ctx.lineTo(wordW * 0.58, -64);
        ctx.moveTo(wordW * 0.6, -47);
        ctx.lineTo(wordW * 0.68, -61);
        ctx.stroke();
      } else {
        const fill = ctx.createLinearGradient(0, -70, 18, 65);
        fill.addColorStop(0, piece.top);
        fill.addColorStop(0.6, piece.bottom);
        fill.addColorStop(1, piece.top);
        ctx.save();
        ctx.translate(6, 9);
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = "#303632";
        ctx.lineWidth = round ? 58 : 23;
        ctx.stroke(word);
        if (!round) {
          ctx.fillStyle = "#303632";
          ctx.fill(word, "evenodd");
        }
        ctx.restore();
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = piece.edge;
        ctx.lineWidth = round ? 58 : 24;
        ctx.stroke(word);
        ctx.strokeStyle = "#252d2b";
        ctx.lineWidth = round ? 45 : 13;
        ctx.stroke(word);
        if (round) {
          ctx.strokeStyle = fill;
          ctx.lineWidth = 31;
          ctx.stroke(word);
        } else {
          ctx.fillStyle = fill;
          ctx.fill(word, "evenodd");
          // One broken horizontal shine reads as paint, not a bevel.
          ctx.globalAlpha = 0.27;
          ctx.strokeStyle = "#f0e6ce";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(-wordW * 0.44, -39);
          ctx.lineTo(-wordW * 0.13, -42);
          ctx.moveTo(wordW * 0.06, -45);
          ctx.lineTo(wordW * 0.36, -43);
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    for (let row = 0; row < 4; row++) {
      ctx.save();
      ctx.translate(0, row * panelH);
      ctx.beginPath();
      ctx.rect(0, 0, 2048, panelH);
      ctx.clip();
      ctx.fillStyle = ["#92958b", "#8e948a", "#999b90", "#91978c"][row];
      ctx.fillRect(0, 0, 2048, panelH);
      for (let i = 0; i < 420; i++) {
        ctx.globalAlpha = 0.035 + random() * 0.06;
        ctx.fillStyle = i % 3 ? "#616d64" : "#c5c5b3";
        ctx.beginPath();
        ctx.ellipse(random() * 2048, random() * panelH, 3 + random() * 37, 2 + random() * 14, random(), 0, Math.PI * 2);
        ctx.fill();
      }
      // Damp footing and runoff anchor the paint to the wall surface.
      ctx.globalAlpha = 1;
      const damp = ctx.createLinearGradient(0, 181, 0, panelH);
      damp.addColorStop(0, "rgba(54,70,55,0)");
      damp.addColorStop(1, "rgba(54,70,55,0.3)");
      ctx.fillStyle = damp;
      ctx.fillRect(0, 0, 2048, panelH);
      for (let i = 0; i < 25; i++) {
        const x = 40 + random() * 1968;
        ctx.globalAlpha = 0.025 + random() * 0.035;
        ctx.fillStyle = "#35433a";
        ctx.fillRect(x, 8, 1 + random() * 7, 65 + random() * 180);
      }

      for (let col = 0; col < 4; col++) {
        const piece = pieces[row * 4 + col];
        ctx.save();
        ctx.translate(col * 512, 0);
        ctx.scale(512 / panelW, 1);
        // Buff paint and an almost-erased older signature sit behind the
        // new piece. Their off-centre placements leave useful empty wall.
        ctx.globalAlpha = piece.style === "marker" ? 0.3 : 0.17;
        ctx.fillStyle = col % 2 ? "#b2b1a3" : "#757e72";
        ctx.beginPath();
        const bx = 125 + ((row * 97 + col * 43) % 180);
        ctx.moveTo(bx, 65);
        ctx.lineTo(bx + 303, 61 + col * 4);
        ctx.lineTo(bx + 294, 184);
        ctx.lineTo(bx - 7, 179);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.12;
        ctx.strokeStyle = "#ddd7c3";
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(bx + 8, 73);
        ctx.lineTo(bx + 288, 68);
        ctx.stroke();

        if (piece.style !== "marker") {
          // Local, restrained overspray; none of the full-wall confetti
          // that made the old repeated stamp noisy at medium distance.
          for (let i = 0; i < 95; i++) {
            const a = random() * Math.PI * 2;
            const r = Math.sqrt(random());
            ctx.globalAlpha = 0.04 + random() * 0.05;
            ctx.fillStyle = i % 2 ? piece.top : piece.bottom;
            ctx.fillRect(piece.x + Math.cos(a) * r * 230, piece.y + Math.sin(a) * r * 76, 1 + random() * 2, 1);
          }
        }
        drawWord(piece);

        // A few gravity-led paint runs, placed below the actual lettering.
        if (piece.style !== "marker") {
          for (let i = 0; i < 3; i++) {
            const x = piece.x - 115 + i * 105 + random() * 20;
            const y = piece.y + piece.size * 0.39;
            const len = 9 + random() * 18;
            ctx.globalAlpha = 0.62;
            ctx.strokeStyle = i % 2 ? piece.bottom : "#303830";
            ctx.lineCap = "round";
            ctx.lineWidth = 1.2 + random();
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 0.8, Math.min(237, y + len));
            ctx.stroke();
          }
        }
        if (piece.accent) {
          drawWord({
            ...piece,
            word: piece.accent,
            style: "marker",
            x: 651,
            y: 61,
            size: 25,
            angle: -0.09,
            top: "#343c34",
            edge: "#a4a99a",
          });
        }
        // Flaked paint, concrete pinholes and one hairline crack unify the
        // layers without turning every letter into a distressed blur.
        for (let i = 0; i < 130; i++) {
          ctx.globalAlpha = 0.08 + random() * 0.16;
          ctx.fillStyle = i % 4 ? "#9ca193" : "#525f52";
          ctx.fillRect(62 + random() * 698, 27 + random() * 210, 1 + random() * 3, 0.7 + random() * 1.4);
        }
        if ((row + col) % 3 === 0) {
          ctx.globalAlpha = 0.23;
          ctx.strokeStyle = "#4d5b4f";
          ctx.lineWidth = 0.65;
          ctx.beginPath();
          ctx.moveTo(727, 10);
          ctx.lineTo(715, 64);
          ctx.lineTo(725, 88);
          ctx.lineTo(701, 150);
          ctx.lineTo(707, 203);
          ctx.stroke();
        }
        ctx.restore();
      }
      // Keep the atlas sampling margins free of lettering; box ends use
      // the first 24px, and filtered long faces omit the top/bottom 8px.
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = "#969c8f";
      ctx.fillRect(0, 0, 32, panelH);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // Hoarding posters — original artwork painted here (no photos, nothing to
  // license): a freight-line advert and a dockside radio poster, weathered
  // in place so the print reads as pasted up years ago, not bolted in fresh.
  public createBillboardMuralMaterial(id: 1 | 2): PBRMaterial {
    const name = `billboardMuralMat_${id}`;
    const cached = this.scene.getMaterialByName(name);
    if (cached) return cached as PBRMaterial;

    const w = id === 1 ? 768 : 452;
    const h = id === 1 ? 1024 : 768;
    const tex = new DynamicTexture(`billboardMuralTex_${id}`, { width: w, height: h }, this.scene, true);
    tex.anisotropicFilteringLevel = 8;
    const ctx = tex.getContext() as CanvasRenderingContext2D;

    if (id === 1) WorldMaterials.paintFreightPoster(ctx, w, h);
    else WorldMaterials.paintRadioPoster(ctx, w, h);
    WorldMaterials.weatherPoster(ctx, w, h);
    tex.update();

    // Pasted paper: matte, a little sheen where the rain has hit it
    return flatMat(this.scene, name, { albedo: [0.7, 0.71, 0.73], rough: 0.78, tex });
  }

  // "MERIDIAN FREIGHT" — a container-line advert: bold diagonal stripe, a
  // stacked-container silhouette under a crane, heavy grotesque lettering
  private static paintFreightPoster(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = "#d8cfb8";
    ctx.fillRect(0, 0, w, h);
    // paper grain
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = i % 2 ? "rgba(90,80,60,0.08)" : "rgba(255,250,235,0.1)";
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    // diagonal brand stripe
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-0.42);
    ctx.fillStyle = "#b8352b";
    ctx.fillRect(-w, -h * 0.07, w * 2, h * 0.14);
    ctx.fillStyle = "#1f2a35";
    ctx.fillRect(-w, h * 0.075, w * 2, h * 0.025);
    ctx.restore();

    // container stack silhouette
    const stackX = w * 0.12;
    const stackY = h * 0.52;
    const cw = w * 0.28;
    const ch = h * 0.075;
    const colors = ["#2c5d7a", "#8a4a2c", "#3f6b3a", "#5d5d63", "#a8722e"];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 2; col++) {
        const x = stackX + col * (cw + 6) + (row % 2) * 18;
        const y = stackY + row * (ch + 4);
        ctx.fillStyle = colors[(row * 2 + col) % colors.length];
        ctx.fillRect(x, y, cw, ch);
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        for (let rib = 0; rib < 9; rib++) ctx.fillRect(x + 8 + rib * (cw / 9), y + 4, 3, ch - 8);
      }
    }
    // gantry crane
    ctx.strokeStyle = "#1f2a35";
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(w * 0.7, h * 0.86);
    ctx.lineTo(w * 0.7, h * 0.42);
    ctx.lineTo(w * 0.2, h * 0.42);
    ctx.moveTo(w * 0.86, h * 0.86);
    ctx.lineTo(w * 0.86, h * 0.42);
    ctx.lineTo(w * 1.02, h * 0.42);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(w * 0.7, h * 0.5);
    ctx.lineTo(w * 0.86, h * 0.78);
    ctx.moveTo(w * 0.86, h * 0.5);
    ctx.lineTo(w * 0.7, h * 0.78);
    ctx.stroke();
    ctx.fillStyle = "#1f2a35";
    ctx.fillRect(w * 0.46, h * 0.44, w * 0.06, h * 0.05); // trolley
    ctx.fillRect(w * 0.485, h * 0.49, w * 0.01, h * 0.09); // hoist cable
    ctx.fillStyle = "#b8352b";
    ctx.fillRect(w * 0.42, h * 0.58, w * 0.14, h * 0.05); // lifted box

    // lettering
    ctx.fillStyle = "#1f2a35";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = `900 ${Math.round(h * 0.11)}px "Arial Black", Impact, sans-serif`;
    ctx.fillText("MERIDIAN", w * 0.06, h * 0.17);
    ctx.fillText("FREIGHT", w * 0.06, h * 0.28);
    ctx.fillStyle = "#b8352b";
    ctx.font = `700 ${Math.round(h * 0.034)}px Arial, sans-serif`;
    ctx.fillText("PORT TO PORT · RAIN OR SHINE", w * 0.06, h * 0.33);
    ctx.fillStyle = "#1f2a35";
    ctx.font = `700 ${Math.round(h * 0.03)}px Arial, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText("EST. 1974", w * 0.94, h * 0.95);
    ctx.textAlign = "left";
    ctx.fillText("40' HIGH-CUBE · REEFER · FLAT RACK", w * 0.06, h * 0.95);
  }

  // "SIGNAL 98.3" — a dockside radio poster: halftone sunburst, a bold
  // numeral, and a broadcast mast throwing rings
  private static paintRadioPoster(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#1b2233");
    sky.addColorStop(0.65, "#3a4f6b");
    sky.addColorStop(1, "#c9a45c");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    // sunburst rays
    ctx.save();
    ctx.translate(w / 2, h * 0.72);
    for (let i = 0; i < 24; i++) {
      ctx.rotate(Math.PI / 12);
      ctx.fillStyle = i % 2 ? "rgba(233,190,92,0.22)" : "rgba(233,190,92,0.06)";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-h * 0.09, -h * 1.2);
      ctx.lineTo(h * 0.09, -h * 1.2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // halftone field low on the sheet
    for (let y = h * 0.5; y < h; y += 14) {
      for (let x = 0; x < w; x += 14) {
        const t = (y - h * 0.5) / (h * 0.5);
        ctx.fillStyle = "rgba(20,24,34,0.55)";
        ctx.beginPath();
        ctx.arc(x, y, 1 + t * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // mast + rings
    ctx.strokeStyle = "#f2e6c8";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(w * 0.5, h * 0.74);
    ctx.lineTo(w * 0.5, h * 0.36);
    ctx.stroke();
    ctx.lineWidth = 3;
    for (let r = 1; r <= 4; r++) {
      ctx.globalAlpha = 1 - r * 0.18;
      ctx.beginPath();
      ctx.arc(w * 0.5, h * 0.36, r * w * 0.075, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // numeral and name
    ctx.fillStyle = "#f2e6c8";
    ctx.textAlign = "center";
    ctx.font = `900 ${Math.round(h * 0.2)}px "Arial Black", Impact, sans-serif`;
    ctx.fillText("98.3", w * 0.5, h * 0.9);
    ctx.font = `900 ${Math.round(h * 0.07)}px "Arial Black", Impact, sans-serif`;
    ctx.fillStyle = "#e9be5c";
    ctx.fillText("SIGNAL", w * 0.5, h * 0.2);
    ctx.font = `700 ${Math.round(h * 0.026)}px Arial, sans-serif`;
    ctx.fillStyle = "#f2e6c8";
    ctx.fillText("ALL NIGHT · ALL WEATHER · DOCKSIDE", w * 0.5, h * 0.25);
  }

  // Rain-yard weathering shared by both prints: desaturate toward the
  // overcast palette, darken the edges, drip streaks, grime, paste seams
  private static weatherPoster(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.globalCompositeOperation = "saturation";
    ctx.fillStyle = "rgba(128, 128, 128, 0.4)";
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = "multiply";
    const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.72);
    vig.addColorStop(0, "#ffffff");
    vig.addColorStop(1, "#969c9a");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < 24; i++) {
      const sx = Math.random() * w;
      const sw = 3 + Math.random() * 11;
      const sl = h * (0.25 + Math.random() * 0.75);
      const drip = ctx.createLinearGradient(0, 0, 0, sl);
      drip.addColorStop(0, "rgba(92, 96, 92, 0.45)");
      drip.addColorStop(1, "rgba(92, 96, 92, 0)");
      ctx.fillStyle = drip;
      ctx.fillRect(sx, 0, sw, sl);
    }
    for (let i = 0; i < 12; i++) {
      const bx = Math.random() * w;
      const by = Math.random() * h;
      const br = h * 0.03 + Math.random() * h * 0.11;
      const blot = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      blot.addColorStop(0, "rgba(86, 84, 76, 0.22)");
      blot.addColorStop(1, "rgba(86, 84, 76, 0)");
      ctx.fillStyle = blot;
      ctx.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    // paste-sheet seams — hoardings go up in panels
    ctx.fillStyle = "rgba(70, 72, 70, 0.28)";
    ctx.fillRect(0, h * 0.34, w, 2);
    ctx.fillRect(0, h * 0.67, w, 2);
    ctx.fillRect(w * 0.5, 0, 2, h);
    // torn corner
    ctx.fillStyle = "#4a4d4b";
    ctx.beginPath();
    ctx.moveTo(w, h);
    ctx.lineTo(w - w * 0.16, h);
    ctx.lineTo(w - w * 0.05, h - h * 0.06);
    ctx.lineTo(w, h - h * 0.11);
    ctx.closePath();
    ctx.fill();

    ctx.globalCompositeOperation = "screen";
    const wash = ctx.createLinearGradient(0, 0, 0, h * 0.3);
    wash.addColorStop(0, "rgba(140, 148, 150, 0.16)");
    wash.addColorStop(1, "rgba(140, 148, 150, 0)");
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h * 0.3);
    ctx.globalCompositeOperation = "source-over";
  }
}
