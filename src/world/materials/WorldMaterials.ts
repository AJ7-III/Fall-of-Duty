import { Color3, DynamicTexture, StandardMaterial } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";
import { canvasMat, makeCanvasTexture, paintNoise, stdMat } from "../../rendering/materials/canvas";

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
  public createConcreteMaterial(uScale: number = 4, vScale: number = 4): StandardMaterial {
    return canvasMat(
      this.scene,
      `concreteMat_${uScale}_${vScale}`,
      512,
      { spec: [0.04, 0.04, 0.04], power: 8, bump: 1.4, u: uScale, v: vScale },
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
  public createMetalMaterial(): StandardMaterial {
    return canvasMat(this.scene, "metalPanelMat", 512, { spec: [0.22, 0.24, 0.27], power: 28, bump: 1.6 }, (ctx, s) => {
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
  public createTargetBoardMaterial(): StandardMaterial {
    const id = this.targetBoardCount++;
    const tex = new DynamicTexture(`targetBoardTex_${id}`, { width: 256, height: 256 }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.drawImage(this.getTargetBoardBase(), 0, 0);
    tex.update();

    const mat = stdMat(this.scene, `targetBoardMat_${id}`, { tex: tex, spec: [0.03, 0.03, 0.03] });
    return mat;
  }

  // Painted corrugated shipping-container steel, tinted per container
  public createContainerMaterial(key: string, base: string, shade: string): StandardMaterial {
    return canvasMat(this.scene, `containerMat_${key}`, 512, { spec: [0.15, 0.16, 0.17], power: 24, bump: 2.4 }, (ctx, s) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, s, s);

      // vertical corrugation ribs
      for (let x = 0; x < s; x += 24) {
        const g = ctx.createLinearGradient(x, 0, x + 24, 0);
        g.addColorStop(0, "rgba(0,0,0,0.28)");
        g.addColorStop(0.35, "rgba(255,255,255,0.10)");
        g.addColorStop(0.6, "rgba(0,0,0,0.05)");
        g.addColorStop(1, "rgba(0,0,0,0.30)");
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, 24, s);
      }

      paintNoise(ctx, s, [shade], 90, 8, 40, 0.25);

      // rust streaks bleeding down from the top rail
      for (let i = 0; i < 10; i++) {
        ctx.globalAlpha = 0.1 + Math.random() * 0.15;
        ctx.fillStyle = "#6b4226";
        ctx.fillRect(Math.random() * s, Math.random() * s * 0.3, 3 + Math.random() * 9, 40 + Math.random() * 140);
      }

      // top/bottom frame rails
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, s, 14);
      ctx.fillRect(0, s - 14, s, 14);
      ctx.globalAlpha = 1;
    });
  }

  // Rough plank wood for crates and tower steps
  public createWoodCrateMaterial(): StandardMaterial {
    return canvasMat(this.scene, "woodCrateMat", 256, { spec: [0.04, 0.04, 0.03], power: 10, bump: 1.6 }, (ctx, s) => {
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

  public createGrassMaterial(uScale: number = 10, vScale: number = 10): StandardMaterial {
    return canvasMat(
      this.scene,
      `grassMat_${uScale}_${vScale}`,
      512,
      { spec: [0.08, 0.09, 0.08], power: 22, bump: 0.7, u: uScale, v: vScale },
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

  // Wet flagstone pavers for the walkways: jittered cobbles with domed
  // shading over dark mortar, moss creeping into the gaps
  public createStoneWalkwayMaterial(uScale: number = 2, vScale: number = 2): StandardMaterial {
    return canvasMat(
      this.scene,
      `stoneWalkMat_${uScale}_${vScale}`,
      512,
      { spec: [0.13, 0.14, 0.15], power: 34, bump: 2.6, u: uScale, v: vScale },
      (ctx, s) => {
        // rain-slick stone
        ctx.fillStyle = "#3b3a37"; // wet mortar
        ctx.fillRect(0, 0, s, s);
        paintNoise(ctx, s, ["#34332f", "#42413d"], 120, 4, 16, 0.4);

        // staggered rows of rounded stones, each domed with its own gradient
        const tones = ["#73716a", "#67665f", "#7c7a71", "#5d5c56", "#6f6c62", "#666258"];
        const rows = 5;
        const cell = s / rows;
        for (let row = 0; row < rows; row++) {
          const xOff = (row % 2) * (cell / 2);
          for (let col = -1; col <= rows; col++) {
            const cx = col * cell + xOff + cell / 2 + (Math.random() - 0.5) * 8;
            const cy = row * cell + cell / 2 + (Math.random() - 0.5) * 8;
            const rx = cell * (0.39 + Math.random() * 0.07);
            const ry = cell * (0.36 + Math.random() * 0.07);
            const rot = (Math.random() - 0.5) * 0.5;

            const g = ctx.createRadialGradient(cx - rx * 0.3, cy - ry * 0.35, 2, cx, cy, rx * 1.25);
            const tone = tones[(Math.random() * tones.length) | 0];
            g.addColorStop(0, "#8a887f");
            g.addColorStop(0.35, tone);
            g.addColorStop(1, "#403f3b");
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // chips, grime and a few wet glints
        paintNoise(ctx, s, ["#4a4944", "#3e3d39"], 140, 1, 4, 0.4);
        paintNoise(ctx, s, ["#8d8b82", "#96948b"], 60, 1, 3, 0.35);
        // moss creeping into the joints
        paintNoise(ctx, s, ["#46503a", "#3e4834"], 40, 2, 7, 0.3);
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
      for (let i = 0; i < 11; i++) {
        this.grassBladeLayout.push({
          baseX: s * 0.06 + (s * 0.88 * i) / 10 + (Math.random() - 0.5) * 12,
          baseW: 8 + Math.random() * 7,
          tipX: (Math.random() - 0.5) * 70,
          tipY: s * (0.02 + Math.random() * 0.3),
          tone: (Math.random() * 4) | 0,
        });
      }
    }
    return this.grassBladeLayout;
  }

  private paintGrassBlades(ctx: CanvasRenderingContext2D, s: number, colored: boolean): void {
    const tones: Array<[string, string]> = [
      ["#43543a", "#7d8e64"],
      ["#4a5c40", "#87986e"],
      ["#3e4f36", "#71825a"],
      ["#52644a", "#93a378"],
    ];
    for (const blade of this.getGrassBladeLayout(s)) {
      const tipX = blade.baseX + blade.tipX;
      const ctrlX = blade.baseX + (tipX - blade.baseX) * 0.25;
      const ctrlY = s * 0.55;
      if (colored) {
        const [lo, hi] = tones[blade.tone];
        const g = ctx.createLinearGradient(0, s, 0, blade.tipY);
        g.addColorStop(0, lo);
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

    return makeCanvasTexture(this.scene, "grassBladeTex", 256, (ctx, s) => {
      ctx.fillStyle = "#42523a"; // opaque grass bed behind the blades
      ctx.fillRect(0, 0, s, s);
      this.paintGrassBlades(ctx, s, true);
    });
  }

  public createGrassBladeMaskTexture(): DynamicTexture {
    const cached = this.scene.getTextureByName("grassBladeMaskTex");
    if (cached) return cached as DynamicTexture;

    return makeCanvasTexture(this.scene, "grassBladeMaskTex", 256, (ctx, s) => {
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

  public createContainerDoorMaterial(key: string, base: string, shade: string): StandardMaterial {
    return canvasMat(this.scene, `containerDoorMat_${key}`, 256, { spec: [0.15, 0.16, 0.17], power: 24, bump: 2.0 }, (ctx, s) => {
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
  public createWindowBandMaterial(): StandardMaterial {
    return canvasMat(this.scene, "windowBandMat", 256, { spec: [0.25, 0.27, 0.3], power: 48, u: 8, v: 1 }, (ctx, s) => {
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
  public createCarBodyMaterial(): StandardMaterial {
    return canvasMat(this.scene, "carBodyMat", 256, { spec: [0.28, 0.3, 0.33], power: 52, bump: 0.9 }, (ctx, s) => {
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

  public createSkyMaterial(): StandardMaterial {
    const tex = makeCanvasTexture(this.scene, "skyTex", 256, (ctx, s) => {
      const grad = ctx.createLinearGradient(0, 0, 0, s);
      grad.addColorStop(0.0, "#39414e");
      grad.addColorStop(0.45, "#5d6671");
      grad.addColorStop(0.68, "#8b9298");
      grad.addColorStop(0.78, "#9aa0a3"); // bright horizon band
      grad.addColorStop(1.0, "#565a5e");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);
      // faint cloud streaks
      for (let i = 0; i < 26; i++) {
        ctx.globalAlpha = 0.05 + Math.random() * 0.06;
        ctx.fillStyle = "#aab0b6";
        const y = Math.random() * s * 0.6;
        ctx.beginPath();
        ctx.ellipse(Math.random() * s, y, 40 + Math.random() * 80, 5 + Math.random() * 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });

    const mat = new StandardMaterial("skyMat", this.scene);
    mat.emissiveTexture = tex;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.fogEnabled = false;
    return mat;
  }

  public createGraffitiWallMaterial(uScale: number = 6, vScale: number = 1): StandardMaterial {
    return canvasMat(
      this.scene,
      `graffitiWallMat_${uScale}_${vScale}`,
      1024,
      { spec: [0.03, 0.03, 0.03], power: 8, bump: 0.8, u: uScale, v: vScale },
      (ctx, s) => {
        // -- Concrete base --
        ctx.fillStyle = "#8c8a84";
        ctx.fillRect(0, 0, s, s);
        paintNoise(ctx, s, ["#858380", "#93918c", "#7e7c78", "#9b9993"], 500, 6, 55, 0.45);
        paintNoise(ctx, s, ["#6e6c68", "#62605c"], 200, 2, 9, 0.38);
        paintNoise(ctx, s, ["#a6a4a0", "#9e9c98"], 100, 1, 5, 0.32);

        // vertical grime and damp streaks
        for (let i = 0; i < 22; i++) {
          ctx.globalAlpha = 0.04 + Math.random() * 0.07;
          ctx.fillStyle = "#3a3835";
          ctx.fillRect(Math.random() * s, 0, 3 + Math.random() * 22, s);
        }
        // hairline cracks
        ctx.globalAlpha = 0.38;
        ctx.strokeStyle = "#6a6864";
        ctx.lineWidth = 1;
        for (let i = 0; i < 10; i++) {
          ctx.beginPath();
          let x = Math.random() * s,
            y = Math.random() * s;
          ctx.moveTo(x, y);
          for (let j = 0; j < 7; j++) {
            x += (Math.random() - 0.5) * 90;
            y += (Math.random() - 0.5) * 60;
            ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        const drawOverspray = (cx: number, cy: number, w: number, h: number, colors: string[], count: number, alpha: number) => {
          for (let i = 0; i < count; i++) {
            const ang = Math.random() * Math.PI * 2;
            const radius = Math.sqrt(Math.random());
            const px = cx + Math.cos(ang) * radius * w * 0.5 + (Math.random() - 0.5) * 18;
            const py = cy + Math.sin(ang) * radius * h * 0.5 + (Math.random() - 0.5) * 18;
            ctx.globalAlpha = alpha * (0.35 + Math.random() * 0.65);
            ctx.fillStyle = colors[(Math.random() * colors.length) | 0];
            ctx.beginPath();
            ctx.arc(px, py, 0.5 + Math.random() * 2.4, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        };

        const drawDrip = (x: number, y: number, len: number, color: string, width: number) => {
          ctx.save();
          ctx.globalAlpha = 0.78;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x - width * 0.5, y);
          ctx.bezierCurveTo(x - width * 0.2, y + len * 0.26, x - width * 0.42, y + len * 0.72, x, y + len);
          ctx.bezierCurveTo(x + width * 0.44, y + len * 0.72, x + width * 0.2, y + len * 0.28, x + width * 0.5, y);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y + len, width * 0.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        };

        const drawBuffPatch = (x: number, y: number, w: number, h: number, color: string, angle: number) => {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(angle);
          ctx.globalAlpha = 0.48;
          ctx.fillStyle = color;
          ctx.fillRect(-w * 0.5, -h * 0.5, w, h);
          ctx.globalAlpha = 0.18;
          ctx.strokeStyle = "#f0eee5";
          ctx.lineWidth = 2;
          for (let i = 0; i < 5; i++) {
            const yy = -h * 0.44 + (i / 4) * h + (Math.random() - 0.5) * 4;
            ctx.beginPath();
            ctx.moveTo(-w * 0.48, yy);
            ctx.lineTo(w * 0.48, yy + (Math.random() - 0.5) * 7);
            ctx.stroke();
          }
          ctx.restore();
          ctx.globalAlpha = 1;
        };

        const drawMarkerTag = (
          text: string,
          x: number,
          y: number,
          sizePx: number,
          color: string,
          angle: number,
          underline: boolean
        ) => {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(angle);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.textBaseline = "middle";
          ctx.font = `italic 900 ${sizePx}px "Brush Script MT", "Segoe Script", cursive`;
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = "rgba(10,10,10,0.75)";
          ctx.lineWidth = Math.max(3, sizePx * 0.08);
          ctx.strokeText(text, 2, 3);
          ctx.globalAlpha = 0.92;
          ctx.fillStyle = color;
          ctx.fillText(text, 0, 0);
          if (underline) {
            const lineW = text.length * sizePx * 0.42;
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(2, sizePx * 0.045);
            ctx.beginPath();
            ctx.moveTo(sizePx * 0.05, sizePx * 0.38);
            ctx.bezierCurveTo(lineW * 0.3, sizePx * 0.6, lineW * 0.7, sizePx * 0.2, lineW, sizePx * 0.48);
            ctx.stroke();
          }
          ctx.restore();
          ctx.globalAlpha = 1;
        };

        const drawThrowie = (
          word: string,
          x: number,
          y: number,
          fontPx: number,
          fillTop: string,
          fillBottom: string,
          outline: string,
          forcefield: string,
          angle: number,
          scaleX: number
        ) => {
          const width = word.length * fontPx * 0.62 * scaleX;
          const height = fontPx * 1.05;
          drawOverspray(x, y, width * 1.18, height * 1.28, [fillTop, fillBottom, outline], 220, 0.13);

          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(angle);
          ctx.scale(scaleX, 1);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.miterLimit = 2;
          ctx.font = `900 ${fontPx}px Impact, "Arial Black", sans-serif`;

          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = "rgba(18,18,15,0.72)";
          ctx.lineWidth = fontPx * 0.36;
          ctx.strokeText(word, fontPx * 0.04, fontPx * 0.06);

          ctx.globalAlpha = 0.96;
          ctx.strokeStyle = forcefield;
          ctx.lineWidth = fontPx * 0.3;
          ctx.strokeText(word, 0, 0);
          ctx.strokeStyle = "#161514";
          ctx.lineWidth = fontPx * 0.2;
          ctx.strokeText(word, 0, 0);
          ctx.strokeStyle = outline;
          ctx.lineWidth = fontPx * 0.105;
          ctx.strokeText(word, 0, 0);

          const grad = ctx.createLinearGradient(0, -fontPx * 0.52, 0, fontPx * 0.52);
          grad.addColorStop(0, fillTop);
          grad.addColorStop(0.56, fillBottom);
          grad.addColorStop(1, fillTop);
          ctx.fillStyle = grad;
          ctx.fillText(word, 0, 0);

          ctx.globalAlpha = 0.45;
          ctx.strokeStyle = "rgba(255,255,255,0.72)";
          ctx.lineWidth = Math.max(2, fontPx * 0.035);
          ctx.strokeText(word, -fontPx * 0.03, -fontPx * 0.09);
          ctx.globalAlpha = 1;
          ctx.restore();

          const dripCount = Math.max(4, Math.floor(width / 52));
          for (let i = 0; i < dripCount; i++) {
            const px = x - width * 0.43 + i * ((width * 0.86) / (dripCount - 1)) + (Math.random() - 0.5) * 18;
            const py = y + height * 0.38 + Math.random() * 18;
            drawDrip(px, py, 18 + Math.random() * 48, i % 2 === 0 ? fillBottom : outline, 3 + Math.random() * 3);
          }
        };

        const drawBurner = () => {
          const x = s * 0.53;
          const y = s * 0.54;
          const fontPx = s * 0.2;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(-0.045);
          ctx.transform(1, -0.08, -0.22, 1, 0, 0);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.font = `900 ${fontPx}px Impact, "Arial Black", sans-serif`;

          ctx.globalAlpha = 0.9;
          ctx.fillStyle = "#10100f";
          for (const [ax, ay, rot] of [
            [-fontPx * 1.4, -fontPx * 0.28, -0.28],
            [fontPx * 1.45, -fontPx * 0.16, 0.25],
            [fontPx * 0.8, fontPx * 0.36, 0.52],
          ] as const) {
            ctx.save();
            ctx.translate(ax, ay);
            ctx.rotate(rot);
            ctx.beginPath();
            ctx.moveTo(-fontPx * 0.36, -fontPx * 0.08);
            ctx.lineTo(fontPx * 0.38, -fontPx * 0.22);
            ctx.lineTo(fontPx * 0.12, fontPx * 0.16);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }

          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = "rgba(45,15,10,0.8)";
          ctx.lineWidth = fontPx * 0.34;
          ctx.strokeText("RIFT", fontPx * 0.09, fontPx * 0.12);
          ctx.globalAlpha = 0.98;
          ctx.strokeStyle = "#f2e6d0";
          ctx.lineWidth = fontPx * 0.25;
          ctx.strokeText("RIFT", 0, 0);
          ctx.strokeStyle = "#15110e";
          ctx.lineWidth = fontPx * 0.16;
          ctx.strokeText("RIFT", 0, 0);
          ctx.strokeStyle = "#b8161b";
          ctx.lineWidth = fontPx * 0.075;
          ctx.strokeText("RIFT", 0, 0);

          const grad = ctx.createLinearGradient(0, -fontPx * 0.5, 0, fontPx * 0.5);
          grad.addColorStop(0, "#ffd840");
          grad.addColorStop(0.47, "#f15f20");
          grad.addColorStop(1, "#ffe76b");
          ctx.fillStyle = grad;
          ctx.fillText("RIFT", 0, 0);

          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = "#f7f0da";
          ctx.lineWidth = fontPx * 0.028;
          ctx.strokeText("RIFT", -fontPx * 0.04, -fontPx * 0.1);
          ctx.restore();
          ctx.globalAlpha = 1;

          drawOverspray(x, y, s * 0.86, fontPx * 1.6, ["#ffd840", "#f15f20", "#b8161b", "#f2e6d0"], 360, 0.08);
          for (let i = 0; i < 10; i++) {
            drawDrip(
              s * 0.2 + i * s * 0.07,
              s * 0.64 + Math.random() * 14,
              14 + Math.random() * 34,
              i % 3 === 0 ? "#b8161b" : "#f15f20",
              2.5 + Math.random() * 3
            );
          }
        };

        // Old paint ghosts and buffed rectangles underneath the newer pieces.
        drawBuffPatch(s * 0.2, s * 0.25, s * 0.34, s * 0.22, "#77746d", -0.03);
        drawBuffPatch(s * 0.78, s * 0.42, s * 0.28, s * 0.18, "#9a968b", 0.04);
        drawBuffPatch(s * 0.55, s * 0.82, s * 0.38, s * 0.12, "#6f6b64", 0.01);
        drawMarkerTag("NOVA", s * 0.12, s * 0.18, s * 0.08, "#302d2a", -0.12, true);
        drawMarkerTag("VEX", s * 0.68, s * 0.18, s * 0.07, "#4a1c68", 0.08, true);

        // Newer wall pieces: readable tags and throw-ups instead of decorative streaks.
        drawThrowie("KENO", s * 0.23, s * 0.36, s * 0.17, "#9ff1ff", "#267dde", "#081f53", "#efe9d5", -0.08, 1.03);
        drawBurner();
        drawThrowie("NOX", s * 0.78, s * 0.77, s * 0.18, "#f6b4ff", "#b326c9", "#4a0a57", "#10100e", 0.07, 0.96);

        // Handstyle tags layered over the pieces.
        drawMarkerTag("aces", s * 0.07, s * 0.88, s * 0.075, "#f3f0df", -0.08, true);
        drawMarkerTag("ksr", s * 0.34, s * 0.1, s * 0.065, "#11100f", 0.05, false);
        drawMarkerTag("milo", s * 0.54, s * 0.91, s * 0.07, "#3be4a9", -0.06, true);
        drawMarkerTag("echo", s * 0.75, s * 0.26, s * 0.064, "#ffefe8", 0.11, true);
        drawMarkerTag("87", s * 0.89, s * 0.59, s * 0.075, "#10100f", -0.16, false);

        // Torn wheat-paste leftovers and sticker ghosts sit on top in places.
        for (let i = 0; i < 7; i++) {
          const rx = 40 + Math.random() * (s - 120);
          const ry = 20 + Math.random() * (s - 90);
          const rw = 44 + Math.random() * 58;
          const rh = 24 + Math.random() * 44;
          ctx.save();
          ctx.translate(rx, ry);
          ctx.rotate((Math.random() - 0.5) * 0.34);
          ctx.globalAlpha = 0.2 + Math.random() * 0.16;
          ctx.fillStyle = "#e8e0d0";
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(rw * (0.72 + Math.random() * 0.22), Math.random() * 8);
          ctx.lineTo(rw, rh * (0.55 + Math.random() * 0.38));
          ctx.lineTo(rw * (0.18 + Math.random() * 0.18), rh);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        // Cap-control scatter and worn-away paint chips.
        for (let i = 0; i < 520; i++) {
          ctx.globalAlpha = 0.045 + Math.random() * 0.1;
          const speckColors = ["#ffd840", "#f15f20", "#9ff1ff", "#267dde", "#f6b4ff", "#3be4a9", "#f3f0df", "#15110e"];
          ctx.fillStyle = speckColors[(Math.random() * speckColors.length) | 0];
          const sx2 = Math.random() * s,
            sy2 = Math.random() * s;
          ctx.beginPath();
          ctx.arc(sx2, sy2, 0.4 + Math.random() * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    );
  }

  // Hoarding posters — original artwork painted here (no photos, nothing to
  // license): a freight-line advert and a dockside radio poster, weathered
  // in place so the print reads as pasted up years ago, not bolted in fresh.
  public createBillboardMuralMaterial(id: 1 | 2): StandardMaterial {
    const name = `billboardMuralMat_${id}`;
    const cached = this.scene.getMaterialByName(name);
    if (cached) return cached as StandardMaterial;

    const w = id === 1 ? 768 : 452;
    const h = id === 1 ? 1024 : 768;
    const tex = new DynamicTexture(`billboardMuralTex_${id}`, { width: w, height: h }, this.scene, true);
    tex.anisotropicFilteringLevel = 8;
    const ctx = tex.getContext() as CanvasRenderingContext2D;

    if (id === 1) WorldMaterials.paintFreightPoster(ctx, w, h);
    else WorldMaterials.paintRadioPoster(ctx, w, h);
    WorldMaterials.weatherPoster(ctx, w, h);
    tex.update();

    const mat = new StandardMaterial(name, this.scene);
    mat.diffuseTexture = tex;
    // The print sits back in the overcast scene instead of outshining it;
    // the tiny emissive lift only keeps it legible at distance
    mat.diffuseColor = new Color3(0.55, 0.56, 0.58);
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(0.05, 0.05, 0.052);
    mat.specularColor = new Color3(0.04, 0.04, 0.04);
    mat.specularPower = 8;
    return mat;
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
