import {
  Scene,
  StandardMaterial,
  Color3,
  Mesh,
  MeshBuilder,
  DynamicTexture,
  Vector3,
  Quaternion,
  Texture,
  FresnelParameters,
  type BaseTexture,
} from "@babylonjs/core";
import type { WeaponConfig, ADSAnimationData } from "../weapons/WeaponTypes";
import m40a3Config from "../data/weapons/m40a3_style.json";
import m40a3AdsFrames from "../data/animations/m40a3_ads_frames.json";
import usp45Config from "../data/weapons/usp45_style.json";
import usp45AdsFrames from "../data/animations/usp45_ads_frames.json";
import mp44Config from "../data/weapons/mp44_style.json";
import mp44AdsFrames from "../data/animations/mp44_ads_frames.json";

export class AssetLoader {
  // Shared bullseye artwork, painted once and blitted into each target's
  // own texture (per-target textures let bullet holes be painted per board)
  private targetBoardBase: HTMLCanvasElement | null = null;
  private targetBoardCount = 0;

  public loadWeaponConfig(): WeaponConfig {
    return m40a3Config as WeaponConfig;
  }

  public loadAdsAnimation(): ADSAnimationData {
    return m40a3AdsFrames as ADSAnimationData;
  }

  public loadPistolConfig(): WeaponConfig {
    return usp45Config as WeaponConfig;
  }

  public loadPistolAdsAnimation(): ADSAnimationData {
    return usp45AdsFrames as ADSAnimationData;
  }

  public loadMp44Config(): WeaponConfig {
    return mp44Config as WeaponConfig;
  }

  public loadMp44AdsAnimation(): ADSAnimationData {
    return mp44AdsFrames as ADSAnimationData;
  }

  // ------------------------------------------------------------------
  // Procedural texture helpers — everything is painted at load time on
  // canvas (zero external assets, zero copyrighted content).
  // ------------------------------------------------------------------

  private makeCanvasTexture(
    scene: Scene,
    name: string,
    size: number,
    paint: (ctx: CanvasRenderingContext2D, size: number) => void
  ): DynamicTexture {
    const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    paint(ctx, size);
    tex.update();
    return tex;
  }

  // Scatter soft elliptical blotches — the workhorse for surface grime/variation
  private paintNoise(
    ctx: CanvasRenderingContext2D,
    size: number,
    colors: string[],
    count: number,
    minR: number,
    maxR: number,
    alpha: number
  ): void {
    for (let i = 0; i < count; i++) {
      ctx.globalAlpha = alpha * (0.4 + Math.random() * 0.6);
      ctx.fillStyle = colors[(Math.random() * colors.length) | 0];
      const r = minR + Math.random() * (maxR - minR);
      ctx.beginPath();
      ctx.ellipse(
        Math.random() * size,
        Math.random() * size,
        r,
        r * (0.6 + Math.random() * 0.8),
        Math.random() * Math.PI,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // StandardMaterial with the common settings applied in one call
  private stdMat(
    scene: Scene,
    name: string,
    o: {
      tex?: BaseTexture | null;
      diffuse?: readonly [number, number, number];
      spec?: readonly [number, number, number];
      power?: number;
      emissive?: readonly [number, number, number];
    }
  ): StandardMaterial {
    const mat = new StandardMaterial(name, scene);
    if (o.tex) mat.diffuseTexture = o.tex;
    if (o.diffuse) mat.diffuseColor = new Color3(o.diffuse[0], o.diffuse[1], o.diffuse[2]);
    if (o.spec) mat.specularColor = new Color3(o.spec[0], o.spec[1], o.spec[2]);
    if (o.power !== undefined) mat.specularPower = o.power;
    if (o.emissive) mat.emissiveColor = new Color3(o.emissive[0], o.emissive[1], o.emissive[2]);
    return mat;
  }

  // Cached canvas-painted material: scene-cache lookup -> paint -> material.
  // The texture name is derived from the material name ("fooMat" -> "fooTex").
  private canvasMat(
    scene: Scene,
    name: string,
    size: number,
    o: { spec: readonly [number, number, number]; power?: number; u?: number; v?: number },
    paint: (ctx: CanvasRenderingContext2D, size: number) => void
  ): StandardMaterial {
    const cached = scene.getMaterialByName(name);
    if (cached) return cached as StandardMaterial;
    const tex = this.makeCanvasTexture(scene, name.replace("Mat", "Tex"), size, paint);
    if (o.u !== undefined) tex.uScale = o.u;
    if (o.v !== undefined) tex.vScale = o.v;
    return this.stdMat(scene, name, { tex, spec: o.spec, power: o.power });
  }

  // Place a primitive: material, optional rotation/scaling, position, parent.
  // The workhorse for the weapon viewmodels' hundreds of hand-tuned parts.
  private prim(
    mesh: Mesh,
    mat: StandardMaterial | null,
    parent: Mesh,
    pos: Vector3 | readonly [number, number, number] | null,
    o?: {
      rx?: number;
      ry?: number;
      rz?: number;
      scale?: readonly [number, number, number];
      sx?: number;
      sy?: number;
      sz?: number;
    }
  ): Mesh {
    if (mat) mesh.material = mat;
    if (o) {
      if (o.rx !== undefined) mesh.rotation.x = o.rx;
      if (o.ry !== undefined) mesh.rotation.y = o.ry;
      if (o.rz !== undefined) mesh.rotation.z = o.rz;
      if (o.scale) mesh.scaling.set(o.scale[0], o.scale[1], o.scale[2]);
      if (o.sx !== undefined) mesh.scaling.x = o.sx;
      if (o.sy !== undefined) mesh.scaling.y = o.sy;
      if (o.sz !== undefined) mesh.scaling.z = o.sz;
    }
    if (pos) {
      if (pos instanceof Vector3) mesh.position.copyFrom(pos);
      else mesh.position.set(pos[0], pos[1], pos[2]);
    }
    mesh.parent = parent;
    return mesh;
  }

  // Merge a weapon's static parts into one mesh per material: ~120 primitives
  // (~120 draw calls per frame) collapse to ~20 with pixel-identical output.
  // Animated pivot groups stay separate; their children merge within the
  // pivot. Must run while the root and pivots' ancestors are still at
  // identity, so baked world geometry equals root-local geometry; setParent()
  // compensates each pivot's rest offset. Finally marks every mesh unpickable
  // so the viewmodel never intercepts the hitscan ray.
  private mergeWeaponParts(parent: Mesh, pivots: Mesh[]): void {
    const mergeByMaterial = (meshes: Mesh[], reparent: (m: Mesh) => void): void => {
      const groups = new Map<unknown, Mesh[]>();
      for (const m of meshes) {
        if (m.getTotalVertices() === 0 || !m.material) continue;
        const list = groups.get(m.material);
        if (list) {
          list.push(m);
        } else {
          groups.set(m.material, [m]);
        }
      }
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        const merged = Mesh.MergeMeshes(list, true, true, undefined, false, false);
        if (merged) reparent(merged);
      }
    };

    const staticParts: Mesh[] = [];
    const pivotParts = new Map<Mesh, Mesh[]>(pivots.map((p) => [p, []]));
    for (const child of parent.getChildMeshes(false)) {
      const m = child as Mesh;
      if (pivots.includes(m)) continue;
      const owner = pivots.find((p) => m.isDescendantOf(p));
      if (owner) {
        pivotParts.get(owner)!.push(m);
      } else {
        staticParts.push(m);
      }
    }
    mergeByMaterial(staticParts, (m) => m.setParent(parent));
    for (const [pivot, parts] of pivotParts) {
      mergeByMaterial(parts, (m) => m.setParent(pivot));
    }

    parent.isPickable = false;
    for (const child of parent.getChildMeshes()) {
      child.isPickable = false;
    }
  }

  // Weathered poured concrete with pocks, chips, grime streaks and cracks
  public createConcreteMaterial(scene: Scene, uScale: number = 4, vScale: number = 4): StandardMaterial {
    return this.canvasMat(scene, `concreteMat_${uScale}_${vScale}`, 512, { spec: [0.04, 0.04, 0.04], power: 8, u: uScale, v: vScale }, (ctx, s) => {
      ctx.fillStyle = "#97948c";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#8f8c84", "#a3a098", "#878680", "#9c9991"], 260, 12, 60, 0.5);
      this.paintNoise(ctx, s, ["#7b7872", "#6d6a65"], 110, 2, 7, 0.5); // pock marks
      this.paintNoise(ctx, s, ["#b0ada5", "#a8a59d"], 80, 1, 4, 0.55); // light chips

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
    });
  }

  // Industrial painted-steel panels with seams, rivets, scratches and rust
  public createMetalMaterial(scene: Scene): StandardMaterial {
    return this.canvasMat(scene, "metalPanelMat", 512, { spec: [0.22, 0.24, 0.27], power: 28 }, (ctx, s) => {
      ctx.fillStyle = "#3d434b";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#363c44", "#434a53", "#3a4049"], 200, 10, 50, 0.5);

      // panel seams (2x2 grid)
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = "#21252b";
      ctx.lineWidth = 4;
      for (const p of [0, s / 2, s]) {
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
      }

      // rivets along seams
      ctx.globalAlpha = 0.9;
      for (const line of [8, s / 2 - 8, s / 2 + 8, s - 8]) {
        for (let i = 24; i < s; i += 48) {
          ctx.fillStyle = "#565e68";
          ctx.beginPath(); ctx.arc(line, i, 3, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#565e68";
          ctx.beginPath(); ctx.arc(i, line, 3, 0, Math.PI * 2); ctx.fill();
        }
      }

      // scratches
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#6f7782";
      ctx.lineWidth = 1;
      for (let i = 0; i < 22; i++) {
        const x = Math.random() * s, y = Math.random() * s, a = Math.random() * Math.PI;
        const len = 10 + Math.random() * 50;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }

      // rust specks
      this.paintNoise(ctx, s, ["#6e4a2f", "#7d5436", "#5c3e28"], 60, 1, 5, 0.5);
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
    this.paintNoise(ctx, s, ["#d2cab3", "#e6dec8", "#c9c1ab"], 70, 6, 26, 0.4);

    const cx = s / 2, cy = s / 2;
    // printed scoring rings
    ctx.strokeStyle = "#2c2c2a";
    ctx.lineWidth = 3;
    for (const r of [104, 84, 64, 44]) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    // red center
    ctx.fillStyle = "#bf3a2b";
    ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#7e2018";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2); ctx.stroke();

    // crosshair tick marks
    ctx.strokeStyle = "#2c2c2a";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - 116, cy); ctx.lineTo(cx - 108, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 108, cy); ctx.lineTo(cx + 116, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 116); ctx.lineTo(cx, cy - 108); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + 108); ctx.lineTo(cx, cy + 116); ctx.stroke();

    // weathering over the print
    this.paintNoise(ctx, s, ["#b5ad97", "#a89f8a"], 30, 2, 9, 0.35);

    this.targetBoardBase = canvas;
    return canvas;
  }

  // Printed paper bullseye for the target boards. Each call returns a fresh
  // material whose texture is a private copy of the shared artwork, so the
  // bullet holes painted into one board never show up on the others.
  public createTargetBoardMaterial(scene: Scene): StandardMaterial {
    const id = this.targetBoardCount++;
    const tex = new DynamicTexture(`targetBoardTex_${id}`, { width: 256, height: 256 }, scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.drawImage(this.getTargetBoardBase(), 0, 0);
    tex.update();

    const mat = this.stdMat(scene, `targetBoardMat_${id}`, { tex: tex, spec: [0.03, 0.03, 0.03] });
    return mat;
  }

  // Painted corrugated shipping-container steel, tinted per container
  public createContainerMaterial(scene: Scene, key: string, base: string, shade: string): StandardMaterial {
    return this.canvasMat(scene, `containerMat_${key}`, 512, { spec: [0.15, 0.16, 0.17], power: 24 }, (ctx, s) => {
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

      this.paintNoise(ctx, s, [shade], 90, 8, 40, 0.25);

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
  public createWoodCrateMaterial(scene: Scene): StandardMaterial {
    return this.canvasMat(scene, "woodCrateMat", 256, { spec: [0.04, 0.04, 0.03], power: 10 }, (ctx, s) => {
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
      this.paintNoise(ctx, s, ["#5c3f24", "#4e3520"], 8, 2, 5, 0.7);
      // crate frame border
      ctx.strokeStyle = "rgba(48, 32, 16, 0.85)";
      ctx.lineWidth = 14;
      ctx.strokeRect(7, 7, s - 14, s - 14);
    });
  }

  // Stacked burlap sandbags for the firing-line cover
  public createSandbagMaterial(scene: Scene): StandardMaterial {
    return this.canvasMat(scene, "sandbagMat", 256, { spec: [0.02, 0.02, 0.02], power: 8 }, (ctx, s) => {
      ctx.fillStyle = "#837a5e";
      ctx.fillRect(0, 0, s, s);

      // staggered rows of bag bulges
      const bagW = 64, bagH = 32;
      for (let row = 0; row * bagH < s; row++) {
        const xOff = (row % 2) * (bagW / 2);
        for (let col = -1; col * bagW < s; col++) {
          const x = col * bagW + xOff;
          const y = row * bagH;
          const g = ctx.createRadialGradient(x + bagW / 2, y + bagH * 0.35, 4, x + bagW / 2, y + bagH / 2, bagW * 0.6);
          g.addColorStop(0, "rgba(174, 162, 128, 0.65)");
          g.addColorStop(0.7, "rgba(120, 110, 82, 0.3)");
          g.addColorStop(1, "rgba(58, 52, 38, 0.75)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.ellipse(x + bagW / 2, y + bagH / 2, bagW * 0.52, bagH * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // burlap speckle
      this.paintNoise(ctx, s, ["#6e6549", "#968b68"], 220, 1, 3, 0.3);
    });
  }

  // Diagonal yellow/black hazard stripes (accent strips on edges/platforms)
  public createHazardStripeMaterial(scene: Scene): StandardMaterial {
    return this.canvasMat(scene, "hazardMat", 256, { spec: [0.05, 0.05, 0.05] }, (ctx, s) => {
      ctx.fillStyle = "#15151a";
      ctx.fillRect(0, 0, s, s);
      ctx.save();
      ctx.translate(s / 2, s / 2);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#d8a400";
      for (let i = -s * 1.5; i < s * 1.5; i += 56) {
        ctx.fillRect(i, -s, 28, s * 2);
      }
      ctx.restore();
      // grime so it doesn't look freshly painted
      this.paintNoise(ctx, s, ["#3a3a36", "#26261f"], 70, 3, 14, 0.25);
    });
  }

  // Cracked shipping-yard asphalt: pebble grain, big slab seams, oil
  // stains and weeds pushing through the expansion joints
  public createAsphaltMaterial(scene: Scene, uScale: number = 8, vScale: number = 8): StandardMaterial {
    return this.canvasMat(scene, `asphaltMat_${uScale}_${vScale}`, 512, { spec: [0.03, 0.03, 0.03], power: 8, u: uScale, v: vScale }, (ctx, s) => {
      ctx.fillStyle = "#56554f";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#4e4d48", "#5e5d56", "#525049", "#5a5952"], 300, 10, 55, 0.5);
      this.paintNoise(ctx, s, ["#3f3e3a", "#454440"], 160, 1, 4, 0.5); // pebble grain
      this.paintNoise(ctx, s, ["#6a6960", "#62615a"], 90, 1, 3, 0.5); // light aggregate

      // oil stains
      this.paintNoise(ctx, s, ["#33322f", "#2c2b29"], 14, 14, 44, 0.3);

      // slab seams: border + center cross (10m texture tile -> 5m slabs)
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = "#3a3935";
      ctx.lineWidth = 4;
      ctx.strokeRect(1, 1, s - 2, s - 2);
      ctx.beginPath(); ctx.moveTo(s / 2, 0); ctx.lineTo(s / 2, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();

      // weeds growing along the joints
      ctx.globalAlpha = 1;
      const joints = [2, s / 2, s - 2];
      for (let i = 0; i < 60; i++) {
        ctx.globalAlpha = 0.12 + Math.random() * 0.16;
        ctx.fillStyle = ["#49523a", "#3e4733", "#525a40"][(Math.random() * 3) | 0];
        const alongX = Math.random() < 0.5;
        const j = joints[(Math.random() * 3) | 0] + (Math.random() - 0.5) * 14;
        const t = Math.random() * s;
        const r = 3 + Math.random() * 9;
        ctx.beginPath();
        ctx.ellipse(alongX ? t : j, alongX ? j : t, r, r * 0.7, Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      // scattered weed patches out in the open
      this.paintNoise(ctx, s, ["#46503a", "#3e4834"], 26, 4, 12, 0.18);

      // hairline cracks
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = "#42413c";
      ctx.lineWidth = 1;
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        let x = Math.random() * s;
        let y = Math.random() * s;
        ctx.moveTo(x, y);
        for (let j = 0; j < 6; j++) {
          x += (Math.random() - 0.5) * 80;
          y += (Math.random() - 0.5) * 80;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  // Rain-soaked turf: cool overcast greens, blade flecks, mud worn through
  // where the routes run, waterlogged dark pools in the low spots
  public createGrassMaterial(scene: Scene, uScale: number = 10, vScale: number = 10): StandardMaterial {
    return this.canvasMat(scene, `grassMat_${uScale}_${vScale}`, 512, { spec: [0.08, 0.09, 0.08], power: 22, u: uScale, v: vScale }, (ctx, s) => { // wet sheen
      ctx.fillStyle = "#42523a";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#3a4a34", "#48583e", "#37452f", "#4d5c42"], 320, 8, 42, 0.5);
      this.paintNoise(ctx, s, ["#2e3c2a", "#334030"], 200, 2, 6, 0.4); // shadow clumps

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
      this.paintNoise(ctx, s, ["#4a4136", "#3e362c", "#52483a"], 24, 6, 22, 0.3);
      this.paintNoise(ctx, s, ["#2c352e", "#28302c"], 16, 10, 30, 0.28);
      ctx.globalAlpha = 1;
    });
  }

  // Wet flagstone pavers for the walkways: jittered cobbles with domed
  // shading over dark mortar, moss creeping into the gaps
  public createStoneWalkwayMaterial(scene: Scene, uScale: number = 2, vScale: number = 2): StandardMaterial {
    return this.canvasMat(scene, `stoneWalkMat_${uScale}_${vScale}`, 512, { spec: [0.13, 0.14, 0.15], power: 34, u: uScale, v: vScale }, (ctx, s) => { // rain-slick stone
      ctx.fillStyle = "#3b3a37"; // wet mortar
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#34332f", "#42413d"], 120, 4, 16, 0.4);

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
      this.paintNoise(ctx, s, ["#4a4944", "#3e3d39"], 140, 1, 4, 0.4);
      this.paintNoise(ctx, s, ["#8d8b82", "#96948b"], 60, 1, 3, 0.35);
      // moss creeping into the joints
      this.paintNoise(ctx, s, ["#46503a", "#3e4834"], 40, 2, 7, 0.3);
    });
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

  public createGrassBladeTexture(scene: Scene): DynamicTexture {
    const cached = scene.getTextureByName("grassBladeTex");
    if (cached) return cached as DynamicTexture;

    return this.makeCanvasTexture(scene, "grassBladeTex", 256, (ctx, s) => {
      ctx.fillStyle = "#42523a"; // opaque grass bed behind the blades
      ctx.fillRect(0, 0, s, s);
      this.paintGrassBlades(ctx, s, true);
    });
  }

  public createGrassBladeMaskTexture(scene: Scene): DynamicTexture {
    const cached = scene.getTextureByName("grassBladeMaskTex");
    if (cached) return cached as DynamicTexture;

    return this.makeCanvasTexture(scene, "grassBladeMaskTex", 256, (ctx, s) => {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, s, s);
      this.paintGrassBlades(ctx, s, false);
    });
  }

  // Soft vertical streak for the rain particles (transparent background)
  public createRainStreakTexture(scene: Scene): DynamicTexture {
    const cached = scene.getTextureByName("rainStreakTex");
    if (cached) return cached as DynamicTexture;

    const tex = this.makeCanvasTexture(scene, "rainStreakTex", 64, (ctx, s) => {
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

  // Weathered red-brick perimeter wall (running bond, grimy mortar)
  public createBrickMaterial(scene: Scene, uScale: number = 8, vScale: number = 1): StandardMaterial {
    return this.canvasMat(scene, `brickMat_${uScale}_${vScale}`, 512, { spec: [0.02, 0.02, 0.02], power: 8, u: uScale, v: vScale }, (ctx, s) => {
      ctx.fillStyle = "#6b655c"; // mortar
      ctx.fillRect(0, 0, s, s);

      const bw = 64, bh = 26;
      const tones = ["#6e4639", "#7a4f3f", "#5f3c30", "#835842", "#67423a"];
      for (let row = 0; row * bh < s; row++) {
        const xOff = (row % 2) * (bw / 2);
        for (let col = -1; col * bw < s + bw; col++) {
          ctx.fillStyle = tones[(Math.random() * tones.length) | 0];
          ctx.fillRect(col * bw + xOff + 2, row * bh + 2, bw - 4, bh - 4);
        }
      }
      // grime, soot and efflorescence over the coursework
      this.paintNoise(ctx, s, ["#3c332e", "#332b27"], 80, 4, 18, 0.25);
      this.paintNoise(ctx, s, ["#8d8478", "#7c7468"], 50, 2, 8, 0.2);
      // vertical drip streaks
      for (let i = 0; i < 12; i++) {
        ctx.globalAlpha = 0.06 + Math.random() * 0.08;
        ctx.fillStyle = "#2f2a26";
        ctx.fillRect(Math.random() * s, 0, 4 + Math.random() * 16, s);
      }
      ctx.globalAlpha = 1;
    });
  }

  // Container door end: split panels, vertical lock rods, handles, placard
  public createContainerDoorMaterial(scene: Scene, key: string, base: string, shade: string): StandardMaterial {
    return this.canvasMat(scene, `containerDoorMat_${key}`, 256, { spec: [0.15, 0.16, 0.17], power: 24 }, (ctx, s) => {
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
      this.paintNoise(ctx, s, [base], 60, 6, 26, 0.18);

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
  public createWindowBandMaterial(scene: Scene): StandardMaterial {
    return this.canvasMat(scene, "windowBandMat", 256, { spec: [0.25, 0.27, 0.3], power: 48, u: 8, v: 1 }, (ctx, s) => {
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
      this.paintNoise(ctx, s, ["#23282c"], 40, 2, 8, 0.25);
    });
  }

  // Weathered factory paint for the abandoned car: faded petrol blue with
  // door seams, chipped edges, rust freckles and rain-streak grime
  public createCarBodyMaterial(scene: Scene): StandardMaterial {
    return this.canvasMat(scene, "carBodyMat", 256, { spec: [0.28, 0.3, 0.33], power: 52 }, (ctx, s) => { // wet clear-coat glint
      ctx.fillStyle = "#3f5560";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#445a66", "#3a4f59", "#48606b", "#374a53"], 150, 8, 30, 0.4);

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
      this.paintNoise(ctx, s, ["#6e4a2f", "#5c3e28"], 50, 1, 4, 0.45);
      this.paintNoise(ctx, s, ["#8da0a8", "#9fb1b8"], 30, 1, 2, 0.4);

      // rain-streak grime running down
      for (let i = 0; i < 12; i++) {
        ctx.globalAlpha = 0.06 + Math.random() * 0.08;
        ctx.fillStyle = "#1f2c33";
        ctx.fillRect(Math.random() * s, Math.random() * s * 0.3, 3 + Math.random() * 8, 40 + Math.random() * 120);
      }
      ctx.globalAlpha = 1;
    });
  }

  // Faded, soot-stained paint for the burnt-out car wreck
  public createCarPaintMaterial(scene: Scene): StandardMaterial {
    return this.canvasMat(scene, "carPaintMat", 256, { spec: [0.08, 0.08, 0.07], power: 16 }, (ctx, s) => {
      ctx.fillStyle = "#837c54";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#8d8660", "#776f4b", "#928a62"], 120, 6, 24, 0.4);
      // scorch blooms spreading from the top edge (engine fire)
      for (let i = 0; i < 26; i++) {
        ctx.globalAlpha = 0.18 + Math.random() * 0.3;
        ctx.fillStyle = ["#1f1d1a", "#2b2823", "#171513"][(Math.random() * 3) | 0];
        const r = 10 + Math.random() * 34;
        ctx.beginPath();
        ctx.ellipse(Math.random() * s, Math.random() * s * 0.55, r, r * 0.8, Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      // rust chew
      this.paintNoise(ctx, s, ["#6e4a2f", "#5c3e28"], 70, 2, 7, 0.5);
      // scratches
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = "#9b9474";
      ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const x = Math.random() * s, y = Math.random() * s, a = Math.random() * Math.PI;
        const len = 12 + Math.random() * 40;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  // Overcast industrial sky gradient (applied to an inverted dome)
  public createSkyMaterial(scene: Scene): StandardMaterial {
    const tex = this.makeCanvasTexture(scene, "skyTex", 256, (ctx, s) => {
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

    const mat = new StandardMaterial("skyMat", scene);
    mat.emissiveTexture = tex;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.fogEnabled = false;
    return mat;
  }

  // Procedurally painted camo (original pattern, generated at load — no image assets)
  private createCamoTexture(scene: Scene): DynamicTexture {
    return this.makeCanvasTexture(scene, "camoTex", 256, (ctx) => {
      ctx.fillStyle = "#b1a384";
      ctx.fillRect(0, 0, 256, 256);

      const blotchColors = ["#8d7f63", "#75705a", "#a09a7e", "#5f5c4a", "#c2b694"];
      for (let i = 0; i < 55; i++) {
        ctx.fillStyle = blotchColors[i % blotchColors.length];
        ctx.beginPath();
        ctx.ellipse(
          Math.random() * 256,
          Math.random() * 256,
          8 + Math.random() * 26,
          6 + Math.random() * 18,
          Math.random() * Math.PI,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      // fine speckle grain
      for (let i = 0; i < 350; i++) {
        ctx.fillStyle = i % 2 === 0 ? "rgba(60,56,44,0.35)" : "rgba(205,196,168,0.3)";
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
    });
  }

  // Dark, weathered skin with subsurface vein shading and a geometric
  // blackwork tattoo half-sleeve. Wraps around limb capsules: horizontal
  // features in the canvas become rings around the arm.
  private createSkinTexture(scene: Scene): DynamicTexture {
    return this.makeCanvasTexture(scene, "skinArmTex", 512, (ctx, s) => {
      const grad = ctx.createLinearGradient(0, 0, 0, s);
      grad.addColorStop(0, "#5e3d2b");
      grad.addColorStop(0.45, "#523426");
      grad.addColorStop(1, "#452a1d");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);

      // mottled tone, sheen patches, pores
      this.paintNoise(ctx, s, ["#5a392a", "#4b2e21", "#684936", "#412619"], 260, 8, 36, 0.3);
      this.paintNoise(ctx, s, ["#6f4d3a", "#7a5642"], 80, 3, 14, 0.14);
      this.paintNoise(ctx, s, ["#36200f", "#2d1a0e"], 520, 1, 2, 0.22);

      // subcutaneous veins — dark green-grey channel + warm highlight ridge
      for (let i = 0; i < 6; i++) {
        const pts: [number, number][] = [];
        let x = 20 + i * 85 + Math.random() * 30;
        let y = s * 0.15 + Math.random() * 50;
        pts.push([x, y]);
        for (let j = 0; j < 5; j++) {
          x += (Math.random() - 0.5) * 38;
          y += 56 + Math.random() * 26;
          pts.push([x, y]);
        }
        const trace = (off: number) => {
          ctx.beginPath();
          ctx.moveTo(pts[0][0] + off, pts[0][1]);
          for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0] + off, pts[j][1]);
          ctx.stroke();
        };
        ctx.strokeStyle = "rgba(56,70,62,0.4)";
        ctx.lineWidth = 3.5;
        trace(0);
        ctx.strokeStyle = "rgba(150,118,95,0.3)"; // light ridge = raised read
        ctx.lineWidth = 1.4;
        trace(-2.2);
      }

      // tattoo half-sleeve — ink reads low-contrast on dark skin
      const ink = (a: number) => `rgba(17,23,26,${a})`;
      ctx.fillStyle = ink(0.72);
      ctx.fillRect(0, 118, s, 7);
      ctx.fillRect(0, 170, s, 7);
      ctx.fillStyle = ink(0.62);
      for (let x = 0; x < s; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 168);
        ctx.lineTo(x + 16, 132);
        ctx.lineTo(x + 32, 168);
        ctx.closePath();
        ctx.fill();
      }
      // solid band with negative-space diamonds
      ctx.fillStyle = ink(0.66);
      ctx.fillRect(0, 238, s, 34);
      ctx.fillStyle = "#523426";
      for (let x = 18; x < s; x += 44) {
        ctx.save();
        ctx.translate(x, 255);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-6.5, -6.5, 13, 13);
        ctx.restore();
      }
      // triquetra knots + dotwork arc
      ctx.strokeStyle = ink(0.7);
      ctx.lineCap = "round";
      const triquetra = (cx: number, cy: number, r: number, lw: number) => {
        // three circles of radius r in a Venn arrangement (centers form an
        // equilateral triangle of side r) — stroke only the lens arcs
        ctx.lineWidth = lw;
        const cR = r / Math.sqrt(3);
        const centers: [number, number][] = [];
        for (let k = 0; k < 3; k++) {
          const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
          centers.push([cx + Math.cos(a) * cR, cy + Math.sin(a) * cR]);
        }
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            if (i === j) continue;
            const [ax, ay] = centers[i];
            const toward = Math.atan2(centers[j][1] - ay, centers[j][0] - ax);
            ctx.beginPath();
            ctx.arc(ax, ay, r, toward - Math.PI / 3, toward + Math.PI / 3);
            ctx.stroke();
          }
        }
      };
      triquetra(150, 352, 34, 6.5);
      triquetra(388, 372, 22, 5);
      ctx.fillStyle = ink(0.6);
      for (let k = 0; k < 9; k++) {
        const a = Math.PI * (0.15 + 0.09 * k);
        ctx.beginPath();
        ctx.arc(270 + Math.cos(a) * 70, 380 + Math.sin(a) * 44, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // wrist pinstripes
      ctx.fillStyle = ink(0.6);
      ctx.fillRect(0, 418, s, 3);
      ctx.fillRect(0, 426, s, 3);

      // crease shadowing toward the joints (texture ends)
      const ends = ctx.createLinearGradient(0, 0, 0, s);
      ends.addColorStop(0, "rgba(40,22,14,0.35)");
      ends.addColorStop(0.12, "rgba(40,22,14,0)");
      ends.addColorStop(0.88, "rgba(40,22,14,0)");
      ends.addColorStop(1, "rgba(40,22,14,0.4)");
      ctx.fillStyle = ends;
      ctx.fillRect(0, 0, s, s);
    });
  }

  // Back-of-hand skin: knuckle creases and a faint fan of veins
  private createHandTexture(scene: Scene): DynamicTexture {
    return this.makeCanvasTexture(scene, "skinHandTex", 256, (ctx, s) => {
      ctx.fillStyle = "#523322";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#5a392a", "#4a2d1f", "#674834"], 140, 5, 22, 0.3);
      this.paintNoise(ctx, s, ["#36200f", "#2d1a0e"], 260, 1, 2, 0.25);

      // knuckle creases — short stacked arcs in two rows
      ctx.strokeStyle = "rgba(44,26,16,0.55)";
      ctx.lineWidth = 2;
      for (const row of [s * 0.3, s * 0.62]) {
        for (let x = 18; x < s; x += 44) {
          for (let c = 0; c < 3; c++) {
            ctx.beginPath();
            ctx.arc(x + 10, row + c * 5, 11, Math.PI * 0.15, Math.PI * 0.85);
            ctx.stroke();
          }
        }
      }
      // faint fan of veins toward the knuckles
      ctx.strokeStyle = "rgba(56,70,62,0.32)";
      ctx.lineWidth = 2.5;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(s / 2 + i * 8, s);
        ctx.quadraticCurveTo(s / 2 + i * 26, s * 0.6, s / 2 + i * 44, s * 0.18);
        ctx.stroke();
      }
      this.paintNoise(ctx, s, ["#7d5742"], 24, 4, 9, 0.2);
    });
  }

  // Woven dark-olive nylon for the fingerless shooting gloves
  private createGloveTexture(scene: Scene): DynamicTexture {
    return this.makeCanvasTexture(scene, "gloveTex", 128, (ctx, s) => {
      ctx.fillStyle = "#26261f";
      ctx.fillRect(0, 0, s, s);
      // cross-hatch weave
      ctx.lineWidth = 1;
      for (let p = 0; p < s; p += 4) {
        ctx.strokeStyle = "rgba(58,58,46,0.55)";
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
        ctx.strokeStyle = "rgba(16,16,12,0.6)";
        ctx.beginPath(); ctx.moveTo(0, p + 2); ctx.lineTo(s, p + 2); ctx.stroke();
      }
      // worn patches and dust scuffs
      this.paintNoise(ctx, s, ["#33332a", "#1c1c16"], 40, 4, 14, 0.3);
      this.paintNoise(ctx, s, ["#4a4639"], 14, 2, 6, 0.25);
    });
  }

  // Fine axial ridges for knurled scope rings/turret caps (u wraps the ring)
  private createKnurlTexture(scene: Scene): DynamicTexture {
    const tex = this.makeCanvasTexture(scene, "knurlTex", 128, (ctx, s) => {
      ctx.fillStyle = "#131418";
      ctx.fillRect(0, 0, s, s);
      for (let x = 0; x < s; x += 8) {
        ctx.fillStyle = "#373b42"; // lit ridge
        ctx.fillRect(x, 0, 2, s);
        ctx.fillStyle = "#07080a"; // groove
        ctx.fillRect(x + 4, 0, 2, s);
      }
      this.paintNoise(ctx, s, ["#23252b"], 40, 2, 6, 0.18);
    });
    tex.uScale = 8;
    return tex;
  }

  private static alignToY(mesh: Mesh, dir: Vector3): void {
    const q = new Quaternion();
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir.normalize(), q);
    mesh.rotationQuaternion = q;
  }

  // Tapered limb: cone trunk + sphere end caps — muscle segments that thin
  // toward the joint instead of reading as uniform sausages
  private createTaperedLimb(
    name: string,
    scene: Scene,
    parent: Mesh,
    mat: StandardMaterial,
    from: Vector3,
    to: Vector3,
    rFrom: number,
    rTo: number,
    tess: number = 18
  ): Mesh {
    const dir = to.subtract(from);
    const trunk = MeshBuilder.CreateCylinder(
      name,
      { height: dir.length(), diameterTop: rTo * 2, diameterBottom: rFrom * 2, tessellation: tess },
      scene
    );
    trunk.position.copyFrom(Vector3.Lerp(from, to, 0.5));
    AssetLoader.alignToY(trunk, dir);
    trunk.material = mat;
    trunk.parent = parent;

    this.prim(MeshBuilder.CreateSphere(`${name}_capA`, { diameter: rFrom * 2, segments: 12 }, scene), mat, parent, from);

    this.prim(MeshBuilder.CreateSphere(`${name}_capB`, { diameter: rTo * 2, segments: 12 }, scene), mat, parent, to);
    return trunk;
  }

  // Ellipsoid muscle mass oriented along the limb, pushed slightly off-axis
  private addMuscleBulge(
    name: string,
    scene: Scene,
    parent: Mesh,
    mat: StandardMaterial,
    from: Vector3,
    to: Vector3,
    t: number,
    width: number,
    length: number,
    depth: number,
    push: Vector3
  ): void {
    const bulge = MeshBuilder.CreateSphere(name, { diameter: 1, segments: 16 }, scene);
    bulge.scaling.set(width, length, depth);
    AssetLoader.alignToY(bulge, to.subtract(from));
    bulge.position.copyFrom(Vector3.Lerp(from, to, t).addInPlace(push));
    bulge.material = mat;
    bulge.parent = parent;
  }

  // Rolled fabric cuff wrapped around a limb
  private addCuff(
    name: string,
    scene: Scene,
    parent: Mesh,
    mat: StandardMaterial,
    from: Vector3,
    to: Vector3,
    t: number,
    diameter: number,
    height: number
  ): void {
    const cuff = MeshBuilder.CreateCylinder(name, { height, diameter, tessellation: 20 }, scene);
    AssetLoader.alignToY(cuff, to.subtract(from));
    cuff.position.copyFrom(Vector3.Lerp(from, to, t));
    cuff.material = mat;
    cuff.parent = parent;
  }

  // Raised vein: a polyline of thin capsules hugging the muscle surface,
  // shrinking slightly toward the wrist
  private addVein(
    name: string,
    scene: Scene,
    parent: Mesh,
    mat: StandardMaterial,
    points: Vector3[],
    radius: number
  ): void {
    for (let i = 0; i < points.length - 1; i++) {
      this.prim(this.createLimb(`${name}_${i}`, scene, points[i], points[i + 1], radius * (1 - i * 0.12)), mat, parent, null);
    }
  }

  // Capsule oriented from -> to (rounded ends blend limb joints smoothly)
  private createLimb(name: string, scene: Scene, from: Vector3, to: Vector3, radius: number): Mesh {
    const dir = to.subtract(from);
    const len = dir.length();
    const limb = MeshBuilder.CreateCapsule(
      name,
      { height: len + radius * 2, radius, tessellation: 10, capSubdivisions: 4 },
      scene
    );
    limb.position.copyFrom(from.add(to).scaleInPlace(0.5));
    const q = new Quaternion();
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), dir.normalize(), q);
    limb.rotationQuaternion = q;
    return limb;
  }

  public createSniperMesh(scene: Scene): Mesh {
    // Create a parent mesh for the rifle viewmodel.
    // Layout: +z is the muzzle direction. The scope tube axis sits at exactly
    // y = +0.17 / x = 0 so the final ADS frame (root at y = -0.17) centers it on camera.
    const parent = new Mesh("m40a3_root", scene);

    // --- Materials ---
    const stockMat = this.stdMat(scene, "sniperStockMat", { tex: this.createCamoTexture(scene), spec: [0.08, 0.08, 0.07], power: 12 });

    const sleeveMat = this.stdMat(scene, "sleeveMat", { tex: stockMat.diffuseTexture, diffuse: [0.78, 0.78, 0.76], spec: [0.02, 0.02, 0.02] }); // slightly darker fabric read

    const metalMat = this.stdMat(scene, "sniperMetalMat", { diffuse: [0.09, 0.1, 0.13], spec: [0.35, 0.38, 0.45], power: 48 }); // blued steel

    // Reflection map for the lens glass and metal sheen — sky gradient with a
    // hot sun glint, sampled in spherical mode so it slides across the curved
    // surfaces as the view turns (reads as a real coated optic)
    const lensReflTex = this.makeCanvasTexture(scene, "lensReflTex", 256, (ctx, s) => {
      const grad = ctx.createLinearGradient(0, 0, 0, s);
      grad.addColorStop(0.0, "#dcebf7");
      grad.addColorStop(0.45, "#94aabf");
      grad.addColorStop(0.6, "#eef6fb"); // bright horizon band
      grad.addColorStop(0.68, "#62788c");
      grad.addColorStop(1.0, "#27333f");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);
      const sun = ctx.createRadialGradient(s * 0.68, s * 0.22, 2, s * 0.68, s * 0.22, 46);
      sun.addColorStop(0, "rgba(255,255,248,0.95)");
      sun.addColorStop(1, "rgba(255,255,248,0)");
      ctx.fillStyle = sun;
      ctx.beginPath();
      ctx.arc(s * 0.68, s * 0.22, 46, 0, Math.PI * 2);
      ctx.fill();
    });
    lensReflTex.coordinatesMode = Texture.SPHERICAL_MODE;

    const scopeMat = this.stdMat(scene, "sniperScopeMat", { diffuse: [0.05, 0.05, 0.06], spec: [0.25, 0.25, 0.28], power: 32 }); // matte black
    // grazing-angle sky sheen — the anodized tube catches rim light
    scopeMat.reflectionTexture = lensReflTex;
    scopeMat.reflectionFresnelParameters = new FresnelParameters();
    scopeMat.reflectionFresnelParameters.bias = 0.02;
    scopeMat.reflectionFresnelParameters.power = 5;
    scopeMat.reflectionFresnelParameters.leftColor = new Color3(0.42, 0.44, 0.48);
    scopeMat.reflectionFresnelParameters.rightColor = Color3.Black();

    const knurlMat = this.stdMat(scene, "sniperKnurlMat", { tex: this.createKnurlTexture(scene), spec: [0.4, 0.4, 0.45], power: 64 });

    const darkTrimMat = this.stdMat(scene, "sniperDarkTrimMat", { diffuse: [0.02, 0.02, 0.025], spec: [0.12, 0.12, 0.14], power: 24 });

    const markMat = this.stdMat(scene, "sniperMarkMat", { diffuse: [0.8, 0.8, 0.75], emissive: [0.3, 0.3, 0.27] }); // turret witness dots

    const rubberMat = this.stdMat(scene, "sniperRubberMat", { diffuse: [0.055, 0.055, 0.06], spec: [0.03, 0.03, 0.03], power: 10 }); // recoil pad / eyecup

    const lensMat = new StandardMaterial("sniperLensMat", scene);
    lensMat.diffuseColor = new Color3(0.01, 0.015, 0.02);
    lensMat.reflectionTexture = lensReflTex;
    lensMat.reflectionFresnelParameters = new FresnelParameters();
    lensMat.reflectionFresnelParameters.bias = 0.25;
    lensMat.reflectionFresnelParameters.power = 1.4;
    // multicoated glass: teal facing the camera, violet shift at the edges
    lensMat.emissiveColor = new Color3(0.38, 0.45, 0.5);
    lensMat.emissiveFresnelParameters = new FresnelParameters();
    lensMat.emissiveFresnelParameters.bias = 0.12;
    lensMat.emissiveFresnelParameters.power = 2.2;
    lensMat.emissiveFresnelParameters.leftColor = new Color3(0.45, 0.24, 0.6);
    lensMat.emissiveFresnelParameters.rightColor = new Color3(0.08, 0.3, 0.36);
    lensMat.specularColor = new Color3(1, 1, 1);
    lensMat.specularPower = 128;

    const lensRearMat = this.stdMat(scene, "sniperLensRearMat", { diffuse: [0.01, 0.01, 0.015], spec: [0.6, 0.65, 0.7], emissive: [0.03, 0.05, 0.06] });
    lensRearMat.reflectionTexture = lensReflTex;
    lensRearMat.reflectionFresnelParameters = new FresnelParameters();
    lensRearMat.reflectionFresnelParameters.bias = 0.06; // only glancing glints
    lensRearMat.reflectionFresnelParameters.power = 3;

    const skinTex = this.createSkinTexture(scene);
    const skinMat = this.stdMat(scene, "skinArmMat", { tex: skinTex, spec: [0.16, 0.13, 0.1], power: 24 }); // light sweat sheen

    const handMat = this.stdMat(scene, "skinHandMat", { tex: this.createHandTexture(scene), spec: [0.14, 0.11, 0.09], power: 22 });

    // fingerless shooting gloves: woven body, bare finger tips/thumb tip
    const gloveMat = this.stdMat(scene, "gloveMat", { tex: this.createGloveTexture(scene), spec: [0.05, 0.05, 0.045], power: 12 });

    const veinMat = this.stdMat(scene, "skinVeinMat", { tex: skinTex, diffuse: [0.82, 0.88, 0.95], spec: [0.18, 0.16, 0.14], power: 30 }); // cooler raised veins

    // --- Stock — smooth fiberglass sporter profile built from rounded
    // primitives: no hard box edges anywhere on the silhouette. The comb sits
    // low (top y = 0.131) so it never crowds the scope's eye line at 0.17 ---
    this.prim(MeshBuilder.CreateCapsule("stockButtPad", { height: 0.115, radius: 0.027, tessellation: 16, capSubdivisions: 6 }, scene),
      rubberMat, parent, [0, 0.05, -0.473], { sz: 0.62 }); // flatten into a recoil pad

    this.prim(MeshBuilder.CreateSphere("stockButt", { diameter: 0.1, segments: 20 }, scene),
      stockMat, parent, [0, 0.05, -0.385], { scale: [0.62, 1.22, 1.85] });

    this.prim(MeshBuilder.CreateSphere("stockComb", { diameter: 0.1, segments: 20 }, scene),
      stockMat, parent, [0, 0.098, -0.355], { scale: [0.55, 0.66, 1.45] });

    // grip neck — the slim wrist between butt and receiver
    this.createTaperedLimb(
      "stockGripNeck", scene, parent, stockMat,
      new Vector3(0, 0.005, -0.3), new Vector3(0, 0.062, -0.205),
      0.032, 0.035, 20
    );

    this.prim(MeshBuilder.CreateCylinder("stockBody", { height: 0.26, diameter: 0.078, tessellation: 24 }, scene),
      stockMat, parent, [0, 0.068, -0.06], { rx: Math.PI / 2, sx: 0.8 }); // oval cross-section

    this.prim(MeshBuilder.CreateCylinder("stockForend", { height: 0.14, diameterTop: 0.058, diameterBottom: 0.078, tessellation: 24 }, scene),
      stockMat, parent, [0, 0.069, 0.14], { rx: Math.PI / 2, sx: 0.8 });

    this.prim(MeshBuilder.CreateSphere("stockForendTip", { diameter: 0.058, segments: 16 }, scene),
      stockMat, parent, [0, 0.069, 0.208], { scale: [0.8, 1, 0.75] });

    // --- Action / barrel (blued steel, trimmed length) ---
    this.prim(MeshBuilder.CreateCylinder("receiver", { height: 0.24, diameter: 0.05, tessellation: 24 }, scene),
      metalMat, parent, [0, 0.115, -0.1], { rx: Math.PI / 2 });

    // bolt shroud tapers off the back of the receiver
    this.prim(MeshBuilder.CreateCylinder("boltShroud", { height: 0.04, diameterTop: 0.034, diameterBottom: 0.026, tessellation: 16 }, scene),
      metalMat, parent, [0, 0.115, -0.24], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateSphere("boltShroudCap", { diameter: 0.026, segments: 12 }, scene), metalMat, parent, [0, 0.115, -0.259]);

    this.prim(MeshBuilder.CreateCylinder("barrel", { height: 0.26, diameterTop: 0.022, diameterBottom: 0.035, tessellation: 24 }, scene),
      metalMat, parent, [0, 0.115, 0.15], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("muzzle", { height: 0.02, diameter: 0.0255, tessellation: 16 }, scene),
      scopeMat, parent, [0, 0.115, 0.288], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("muzzleBore", { height: 0.004, diameter: 0.013, tessellation: 12 }, scene),
      darkTrimMat, parent, [0, 0.115, 0.299], { rx: Math.PI / 2 });

    // floorplate: thin strip tucked flush against the stock belly so it reads
    // as an inletted plate, not a bar hanging under the trigger section
    this.prim(this.createLimb("magPlate", scene, new Vector3(0, 0.03, -0.15), new Vector3(0, 0.03, -0.06), 0.016),
      metalMat, parent, null, { sz: 0.5 }); // local z is world y here: flatten against the wood

    this.prim(MeshBuilder.CreateTorus("triggerGuard", { diameter: 0.055, thickness: 0.007, tessellation: 24 }, scene),
      metalMat, parent, [0, -0.004, -0.21], { rz: Math.PI / 2 }); // vertical ring

    this.prim(MeshBuilder.CreateBox("trigger", { width: 0.007, height: 0.028, depth: 0.01 }, scene),
      metalMat, parent, [0, 0.004, -0.206], { rx: 0.25 });

    // --- Scope rail & ring mounts ---
    this.prim(MeshBuilder.CreateBox("scopeRail", { width: 0.022, height: 0.01, depth: 0.18 }, scene), scopeMat, parent, [0, 0.142, -0.07]);

    const mountF = this.prim(MeshBuilder.CreateBox("scopeMountF", { width: 0.018, height: 0.026, depth: 0.024 }, scene),
      scopeMat, parent, [0, 0.152, 0.0]);

    this.prim(mountF.clone("scopeMountR"), null, parent, [0, 0.152, -0.14]);

    // ring clamps wrap the tube above each mount
    const ringClampF = this.prim(MeshBuilder.CreateCylinder("scopeRingClampF", { height: 0.016, diameter: 0.041, tessellation: 20 }, scene),
      scopeMat, parent, [0, 0.17, 0.0], { rx: Math.PI / 2 });

    this.prim(ringClampF.clone("scopeRingClampR"), null, parent, [0, 0.17, -0.14]);

    // clamp screws on the camera-facing flank
    const screwF = this.prim(MeshBuilder.CreateCylinder("scopeScrewF", { height: 0.006, diameter: 0.007, tessellation: 10 }, scene),
      metalMat, parent, [-0.0215, 0.156, 0.0], { rz: Math.PI / 2 });

    this.prim(screwF.clone("scopeScrewR"), null, parent, [-0.0215, 0.156, -0.14]);

    // --- Scope: tube, turret saddle with three knurled knobs, objective bell,
    // sunshade, eyepiece with rubber eyecup --- (axis exactly at y = +0.17)
    const SCOPE_Y = 0.17;

    this.prim(MeshBuilder.CreateCylinder("scopeTube", { height: 0.24, diameter: 0.034, tessellation: 24 }, scene),
      scopeMat, parent, [0, SCOPE_Y, -0.09], { rx: Math.PI / 2 });

    // machined detail rings on the tube
    for (const [ringName, ringZ] of [["scopeEtchF", 0.018], ["scopeEtchR", -0.185]] as const) {
      this.prim(MeshBuilder.CreateCylinder(ringName, { height: 0.003, diameter: 0.0348, tessellation: 24 }, scene),
        darkTrimMat, parent, [0, SCOPE_Y, ringZ], { rx: Math.PI / 2 });
    }

    // turret saddle (the thicker mid-section)
    this.prim(MeshBuilder.CreateCylinder("scopeSaddle", { height: 0.08, diameter: 0.047, tessellation: 24 }, scene),
      scopeMat, parent, [0, SCOPE_Y, -0.05], { rx: Math.PI / 2 });

    // elevation turret (top): base, knurled knob, cap, witness dot
    this.prim(MeshBuilder.CreateCylinder("turretTopBase", { height: 0.012, diameter: 0.036, tessellation: 16 }, scene),
      scopeMat, parent, [0, SCOPE_Y + 0.029, -0.05]);

    this.prim(MeshBuilder.CreateCylinder("turretTop", { height: 0.022, diameter: 0.031, tessellation: 16 }, scene),
      knurlMat, parent, [0, SCOPE_Y + 0.046, -0.05]);

    this.prim(MeshBuilder.CreateCylinder("turretTopCap", { height: 0.005, diameter: 0.031, tessellation: 16 }, scene),
      scopeMat, parent, [0, SCOPE_Y + 0.0595, -0.05]);

    this.prim(MeshBuilder.CreateCylinder("turretTopDot", { height: 0.002, diameter: 0.0045, tessellation: 8 }, scene),
      markMat, parent, [0, SCOPE_Y + 0.046, -0.0338], { rx: Math.PI / 2 });

    // windage turret (right side)
    this.prim(MeshBuilder.CreateCylinder("turretSideBase", { height: 0.012, diameter: 0.036, tessellation: 16 }, scene),
      scopeMat, parent, [0.0295, SCOPE_Y, -0.05], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("turretSide", { height: 0.022, diameter: 0.031, tessellation: 16 }, scene),
      knurlMat, parent, [0.0465, SCOPE_Y, -0.05], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("turretSideCap", { height: 0.005, diameter: 0.031, tessellation: 16 }, scene),
      scopeMat, parent, [0.060, SCOPE_Y, -0.05], { rz: Math.PI / 2 });

    // parallax/side-focus knob (left side — the camera-facing flank)
    this.prim(MeshBuilder.CreateCylinder("parallaxBase", { height: 0.012, diameter: 0.038, tessellation: 16 }, scene),
      scopeMat, parent, [-0.0295, SCOPE_Y, -0.05], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("parallaxKnob", { height: 0.026, diameter: 0.036, tessellation: 16 }, scene),
      knurlMat, parent, [-0.048, SCOPE_Y, -0.05], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("parallaxCap", { height: 0.005, diameter: 0.036, tessellation: 16 }, scene),
      scopeMat, parent, [-0.0635, SCOPE_Y, -0.05], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("parallaxDot", { height: 0.002, diameter: 0.0045, tessellation: 8 }, scene),
      markMat, parent, [-0.048, SCOPE_Y, -0.0685], { rx: Math.PI / 2 });

    // objective bell — flares out to the big front lens
    this.prim(MeshBuilder.CreateCylinder("scopeObjBell", { height: 0.07, diameterTop: 0.066, diameterBottom: 0.036, tessellation: 24 }, scene),
      scopeMat, parent, [0, SCOPE_Y, 0.065], { rx: Math.PI / 2 });

    // sunshade tube ahead of the bell
    this.prim(MeshBuilder.CreateCylinder("scopeSunshade", { height: 0.036, diameter: 0.068, tessellation: 24 }, scene),
      scopeMat, parent, [0, SCOPE_Y, 0.118], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("scopeFrontRim", { height: 0.012, diameter: 0.072, tessellation: 24 }, scene),
      knurlMat, parent, [0, SCOPE_Y, 0.142], { rx: Math.PI / 2 });

    // dark backing disc occludes the tube interior behind the curved glass
    this.prim(MeshBuilder.CreateCylinder("scopeLensBacking", { height: 0.004, diameter: 0.06, tessellation: 20 }, scene),
      lensRearMat, parent, [0, SCOPE_Y, 0.136], { rx: Math.PI / 2 });

    // curved objective lens — flattened glass dome bulging out of the bell
    this.prim(MeshBuilder.CreateSphere("scopeLensFront", { diameter: 0.058, segments: 16, slice: 0.55 }, scene),
      lensMat, parent, [0, SCOPE_Y, 0.14], { rx: Math.PI / 2, sy: 0.45 }); // flatten the dome into a lens profile // bulge faces out of the muzzle (+z)

    // ocular bell + fast-focus ring + eyecup + rear lens
    this.prim(MeshBuilder.CreateCylinder("scopeOcular", { height: 0.06, diameterTop: 0.036, diameterBottom: 0.05, tessellation: 24 }, scene),
      scopeMat, parent, [0, SCOPE_Y, -0.24], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("scopeFocusRing", { height: 0.024, diameter: 0.054, tessellation: 24 }, scene),
      knurlMat, parent, [0, SCOPE_Y, -0.282], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("scopeEyeRim", { height: 0.008, diameter: 0.05, tessellation: 24 }, scene),
      scopeMat, parent, [0, SCOPE_Y, -0.297], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateTorus("scopeEyecup", { diameter: 0.044, thickness: 0.0065, tessellation: 24 }, scene),
      rubberMat, parent, [0, SCOPE_Y, -0.3], { rx: Math.PI / 2 });

    // curved ocular lens — shallow dome facing the shooter
    this.prim(MeshBuilder.CreateSphere("scopeLensRear", { diameter: 0.042, segments: 12, slice: 0.55 }, scene),
      lensRearMat, parent, [0, SCOPE_Y, -0.301], { rx: -Math.PI / 2, sy: 0.35 }); // bulge faces back toward the eye (-z)

    // --- Bolt assembly (own pivot group so the rig can rotate/pull it) ---
    const boltGroup = new Mesh("boltGroup", scene);
    boltGroup.position.set(0, 0.125, -0.16); // pivot on the bolt axis
    boltGroup.parent = parent;

    this.prim(MeshBuilder.CreateCylinder("boltShaft", { height: 0.1, diameter: 0.018, tessellation: 16 }, scene),
      metalMat, boltGroup, [0, 0, 0.01], { rx: Math.PI / 2 });

    // handle arm tapers toward the ball knob
    this.prim(MeshBuilder.CreateCylinder("boltArm", { height: 0.05, diameterTop: 0.011, diameterBottom: 0.015, tessellation: 12 }, scene),
      metalMat, boltGroup, [0.027, 0, -0.01], { rz: -Math.PI / 2 }); // points +x, thin end outboard

    this.prim(MeshBuilder.CreateSphere("boltBall", { diameter: 0.028, segments: 12 }, scene), metalMat, boltGroup, [0.055, 0, -0.01]);

    // Rest pose: handle angled down-right (ViewModelRig owns the animation)
    boltGroup.rotation.z = -0.9;

    // --- Left arm: bare, muscular support arm. The elbow sits far below the
    // screen edge so only a short diagonal of forearm is visible (no endless
    // tube), rising steeply from bottom-left to a full hand at mid-forend ---
    const lShoulder = new Vector3(-0.36, -0.66, -0.25);
    const lElbow = new Vector3(-0.2, -0.34, -0.05);
    // forearm runs straight into the heel of the hand — no wrist segment
    const lForeEnd = new Vector3(-0.038, -0.035, 0.062);

    this.addCuff("leftCuff", scene, parent, sleeveMat, lShoulder, lElbow, 0.25, 0.132, 0.06);
    this.createTaperedLimb("leftUpper", scene, parent, skinMat, lShoulder, lElbow, 0.06, 0.052, 20);
    this.addMuscleBulge("leftBicep", scene, parent, skinMat, lShoulder, lElbow, 0.5, 0.105, 0.17, 0.1, new Vector3(0.002, 0.012, 0));

    this.prim(MeshBuilder.CreateSphere("leftElbow", { diameter: 0.095, segments: 16 }, scene), skinMat, parent, lElbow);

    this.createTaperedLimb("leftFore", scene, parent, skinMat, lElbow, lForeEnd, 0.05, 0.038, 20);
    // gentle swell inside the silhouette — not a separate lobe
    this.addMuscleBulge("leftFlexor", scene, parent, skinMat, lElbow, lForeEnd, 0.3, 0.092, 0.15, 0.088, new Vector3(-0.004, 0.006, 0));

    // raised veins on the camera-facing flank of the forearm
    this.addVein("leftVeinMain", scene, parent, veinMat, [
      new Vector3(-0.169, -0.187, 0.002),
      new Vector3(-0.139, -0.139, 0.021),
      new Vector3(-0.118, -0.097, 0.04),
      new Vector3(-0.094, -0.058, 0.054),
    ], 0.0044);
    this.addVein("leftVeinBranch", scene, parent, veinMat, [
      new Vector3(-0.139, -0.139, 0.021),
      new Vector3(-0.119, -0.108, 0.034),
      new Vector3(-0.1, -0.079, 0.046),
    ], 0.0036);
    this.addVein("leftVeinElbow", scene, parent, veinMat, [
      new Vector3(-0.241, -0.312, -0.05),
      new Vector3(-0.22, -0.278, -0.036),
      new Vector3(-0.1995, -0.2435, -0.021),
    ], 0.0048);

    // COD4-style support grip: palm up under the forend just ahead of the
    // receiver, heel of the hand growing straight out of the forearm.
    // From the shooter's view the THUMB rides the near flank — the four
    // fingers wrap the far side, tips just cresting the top line
    this.prim(this.createLimb( "leftPalm", scene, new Vector3(-0.026, -0.014, 0.065), new Vector3(-0.014, 0.0, 0.13), 0.031 ),
      gloveMat, parent, null);

    // glove strap ringing the heel of the hand
    this.addCuff("leftGloveStrap", scene, parent, rubberMat,
      new Vector3(-0.026, -0.014, 0.065), new Vector3(-0.014, 0.0, 0.13), 0.05, 0.069, 0.02);

    // thenar mass at the thumb root, visible under the near edge
    this.prim(MeshBuilder.CreateSphere("leftThenar", { diameter: 0.024, segments: 12 }, scene), gloveMat, parent, [-0.024, -0.006, 0.078]);

    // four two-segment fingers wrapping the far side of the forend —
    // gloved up to the knuckle, bare past it (fingerless gloves)
    for (let i = 0; i < 4; i++) {
      const z = 0.07 + i * 0.022;
      const r = 0.0112 - i * 0.0005;

      this.prim(MeshBuilder.CreateSphere(`leftKnuckle${i}`, { diameter: 0.013, segments: 10 }, scene), gloveMat, parent, [0.03, 0.034, z + 0.002]);

      this.prim(this.createLimb( `leftFinger${i}`, scene, new Vector3(0.016, -0.004, z), new Vector3(0.03, 0.034, z + 0.002), r ),
        gloveMat, parent, null);

      this.prim(this.createLimb( `leftFingerTip${i}`, scene, new Vector3(0.03, 0.034, z + 0.002), new Vector3(0.021, 0.08, z + 0.0035), r * 0.88 ),
        handMat, parent, null);
    }

    // thumb pressed along the near flank, pointing up toward the muzzle.
    // Kept outboard of the stock's near face so the whole digit stays
    // visible on the surface instead of sinking into the camo
    this.prim(this.createLimb( "leftThumb", scene, new Vector3(-0.034, -0.012, 0.075), new Vector3(-0.041, 0.018, 0.085), 0.013 ),
      gloveMat, parent, null);

    this.prim(this.createLimb( "leftThumbTip", scene, new Vector3(-0.041, 0.018, 0.085), new Vector3(-0.035, 0.052, 0.106), 0.0115 ),
      handMat, parent, null);

    // --- Right arm group: bare trigger arm; the rig moves this to work the bolt ---
    const rightArmGroup = new Mesh("rightArmGroup", scene);
    rightArmGroup.parent = parent;

    const rShoulder = new Vector3(0.32, -0.56, -0.6);
    const rElbow = new Vector3(0.14, -0.24, -0.4);
    // forearm runs straight into the heel of the hand — no wrist segment
    const rForeEnd = new Vector3(0.042, -0.038, -0.262);

    this.addCuff("rightCuff", scene, rightArmGroup, sleeveMat, rShoulder, rElbow, 0.2, 0.134, 0.06);
    this.createTaperedLimb("rightUpper", scene, rightArmGroup, skinMat, rShoulder, rElbow, 0.061, 0.052, 20);
    this.addMuscleBulge("rightBicep", scene, rightArmGroup, skinMat, rShoulder, rElbow, 0.5, 0.1, 0.165, 0.095, new Vector3(-0.003, 0.01, 0));

    this.prim(MeshBuilder.CreateSphere("rightElbow", { diameter: 0.094, segments: 16 }, scene), skinMat, rightArmGroup, rElbow);

    this.createTaperedLimb("rightFore", scene, rightArmGroup, skinMat, rElbow, rForeEnd, 0.05, 0.038, 20);
    this.addMuscleBulge("rightFlexor", scene, rightArmGroup, skinMat, rElbow, rForeEnd, 0.3, 0.09, 0.14, 0.086, new Vector3(-0.004, 0.005, 0));

    this.addVein("rightVeinMain", scene, rightArmGroup, veinMat, [
      new Vector3(0.0868, -0.1435, -0.361),
      new Vector3(0.0616, -0.089, -0.322),
      new Vector3(0.0411, -0.0442, -0.2895),
    ], 0.0042);

    // palm against the grip's right face
    this.prim(this.createLimb( "rightPalm", scene, new Vector3(0.033, -0.026, -0.242), new Vector3(0.029, 0.03, -0.252), 0.0255 ),
      gloveMat, rightArmGroup, null);

    // glove strap ringing the heel of the hand
    this.addCuff("rightGloveStrap", scene, rightArmGroup, rubberMat,
      new Vector3(0.033, -0.026, -0.242), new Vector3(0.029, 0.03, -0.252), 0.06, 0.06, 0.018);

    // index finger reaching the trigger (two segments)
    this.prim(this.createLimb( "rightIndex", scene, new Vector3(0.029, 0.022, -0.231), new Vector3(0.012, 0.015, -0.209), 0.0094 ),
      gloveMat, rightArmGroup, null);

    this.prim(this.createLimb( "rightIndexTip", scene, new Vector3(0.012, 0.015, -0.209), new Vector3(0.002, 0.009, -0.2035), 0.0085 ),
      handMat, rightArmGroup, null);

    // remaining fingers wrapped around the grip (two segments each) —
    // gloved bases, bare tips
    for (let i = 0; i < 3; i++) {
      const y = 0.004 - i * 0.019;
      this.prim(this.createLimb( `rightFinger${i}`, scene, new Vector3(0.035, y, -0.237), new Vector3(0.015, y + 0.007, -0.251), 0.0102 ),
        gloveMat, rightArmGroup, null);

      this.prim(this.createLimb( `rightFingerTip${i}`, scene, new Vector3(0.015, y + 0.007, -0.251), new Vector3(-0.003, y + 0.011, -0.249), 0.0092 ),
        handMat, rightArmGroup, null);
    }

    this.prim(this.createLimb( "rightThumb", scene, new Vector3(0.023, 0.036, -0.257), new Vector3(-0.005, 0.046, -0.28), 0.0112 ),
      handMat, rightArmGroup, null);

    this.mergeWeaponParts(parent, [boltGroup, rightArmGroup]);

    // Pivot/Offset parent so we can transform/sway it relative to camera
    // Typically, the weapon sits at the bottom-right in hipfire:
    // x = 0.25, y = -0.3, z = 0.6
    parent.position.set(0.25, -0.3, 0.6);
    parent.rotation.y = -Math.PI / 36; // slight angle inward

    return parent;
  }

  // Stippled polymer grip panels — diamond field of raised dots, the classic
  // service-pistol texture (u/v wraps the grip flanks)
  private createStippleTexture(scene: Scene): DynamicTexture {
    return this.makeCanvasTexture(scene, "uspStippleTex", 256, (ctx, s) => {
      ctx.fillStyle = "#191a1d";
      ctx.fillRect(0, 0, s, s);
      // staggered raised dots: lit crown upper-left, shadow lower-right
      const step = 14;
      for (let row = 0; row * step < s + step; row++) {
        const xOff = (row % 2) * (step / 2);
        for (let col = -1; col * step < s + step; col++) {
          const x = col * step + xOff;
          const y = row * step;
          ctx.fillStyle = "#08090b";
          ctx.beginPath();
          ctx.arc(x + 1.4, y + 1.4, 4.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#33363c";
          ctx.beginPath();
          ctx.arc(x, y, 3.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#4a4e55";
          ctx.beginPath();
          ctx.arc(x - 1.1, y - 1.1, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // border band so panel edges read as a frame
      ctx.strokeStyle = "#0c0d0f";
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, s - 10, s - 10);
      // wear: dots polished shiny where the palm rides
      this.paintNoise(ctx, s, ["#565a61"], 26, 3, 9, 0.18);
    });
  }

  // Matte polymer frame — fine speckle grain with faint mold/parting lines
  private createPolymerTexture(scene: Scene): DynamicTexture {
    return this.makeCanvasTexture(scene, "uspPolymerTex", 256, (ctx, s) => {
      ctx.fillStyle = "#222428";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#1c1e22", "#282b30", "#1f2125"], 240, 4, 18, 0.4);
      this.paintNoise(ctx, s, ["#383c43", "#15161a"], 500, 1, 2, 0.3);
      // mold parting lines
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = "#0f1013";
      ctx.lineWidth = 2;
      for (const y of [s * 0.3, s * 0.72]) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(s, y);
        ctx.stroke();
      }
      // scuffs
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = "#3f444b";
      ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const x = Math.random() * s, y = Math.random() * s, a = Math.random() * Math.PI;
        const len = 8 + Math.random() * 30;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  // USP .45-style sidearm viewmodel. Same conventions as the rifle:
  // +z is the muzzle, the iron-sight line sits exactly at y = +0.141 / x = 0
  // so the final ADS frame (root at y = -0.141) centers the sights on camera.
  // Animated pivots the rig drives by name: slideGroup (blowback / lock-back),
  // hammerGroup (rocks with the slide), magGroup (drops during reload),
  // supportArmGroup (left hand leaves the grip to run the mag swap).
  public createPistolMesh(scene: Scene): Mesh {
    const parent = new Mesh("usp45_root", scene);

    // --- Materials ---
    const polymerMat = this.stdMat(scene, "uspPolymerMat", { tex: this.createPolymerTexture(scene), spec: [0.07, 0.07, 0.08], power: 14 });

    const stippleMat = this.stdMat(scene, "uspStippleMat", { tex: this.createStippleTexture(scene), spec: [0.05, 0.05, 0.06], power: 10 });

    // sky-glint reflection shared by the slide and small steel parts
    const slideReflTex = this.makeCanvasTexture(scene, "uspReflTex", 256, (ctx, s) => {
      const grad = ctx.createLinearGradient(0, 0, 0, s);
      grad.addColorStop(0.0, "#d7e6f3");
      grad.addColorStop(0.45, "#8fa5ba");
      grad.addColorStop(0.6, "#ebf4fa");
      grad.addColorStop(0.68, "#5d7387");
      grad.addColorStop(1.0, "#252f3a");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);
      const sun = ctx.createRadialGradient(s * 0.66, s * 0.24, 2, s * 0.66, s * 0.24, 42);
      sun.addColorStop(0, "rgba(255,255,248,0.9)");
      sun.addColorStop(1, "rgba(255,255,248,0)");
      ctx.fillStyle = sun;
      ctx.beginPath();
      ctx.arc(s * 0.66, s * 0.24, 42, 0, Math.PI * 2);
      ctx.fill();
    });
    slideReflTex.coordinatesMode = Texture.SPHERICAL_MODE;

    const slideMat = this.stdMat(scene, "uspSlideMat", { diffuse: [0.08, 0.09, 0.11], spec: [0.32, 0.34, 0.4], power: 42 }); // blued slide steel
    slideMat.reflectionTexture = slideReflTex;
    slideMat.reflectionFresnelParameters = new FresnelParameters();
    slideMat.reflectionFresnelParameters.bias = 0.02;
    slideMat.reflectionFresnelParameters.power = 5;
    slideMat.reflectionFresnelParameters.leftColor = new Color3(0.4, 0.42, 0.46);
    slideMat.reflectionFresnelParameters.rightColor = Color3.Black();

    const steelMat = this.stdMat(scene, "uspSteelMat", { diffuse: [0.13, 0.14, 0.17], spec: [0.45, 0.47, 0.52], power: 56 }); // in-the-white controls

    const darkTrimMat = this.stdMat(scene, "uspDarkTrimMat", { diffuse: [0.02, 0.02, 0.025], spec: [0.1, 0.1, 0.12], power: 20 });

    const knurlMat = this.stdMat(scene, "uspKnurlMat", { tex: this.createKnurlTexture(scene), spec: [0.35, 0.35, 0.4], power: 48 });

    const dotMat = this.stdMat(scene, "uspSightDotMat", { diffuse: [0.85, 0.85, 0.8], emissive: [0.38, 0.38, 0.34] }); // 3-dot sights

    const brassMat = this.stdMat(scene, "uspBrassMat", { diffuse: [0.48, 0.34, 0.12], spec: [0.7, 0.55, 0.25], power: 64 }); // chambered round

    // arms reuse the rifle's procedural skin/glove treatment
    const skinTex = this.createSkinTexture(scene);
    const skinMat = this.stdMat(scene, "uspSkinArmMat", { tex: skinTex, spec: [0.16, 0.13, 0.1], power: 24 });

    const handMat = this.stdMat(scene, "uspSkinHandMat", { tex: this.createHandTexture(scene), spec: [0.14, 0.11, 0.09], power: 22 });

    const gloveMat = this.stdMat(scene, "uspGloveMat", { tex: this.createGloveTexture(scene), spec: [0.05, 0.05, 0.045], power: 12 });

    const veinMat = this.stdMat(scene, "uspSkinVeinMat", { tex: skinTex, diffuse: [0.82, 0.88, 0.95], spec: [0.18, 0.16, 0.14], power: 30 });

    const sleeveMat = this.stdMat(scene, "uspSleeveMat", { tex: this.createCamoTexture(scene), diffuse: [0.78, 0.78, 0.76], spec: [0.02, 0.02, 0.02] });

    const rubberMat = this.stdMat(scene, "uspRubberMat", { diffuse: [0.055, 0.055, 0.06], spec: [0.03, 0.03, 0.03], power: 10 });

    // --- Slide group (pivot on the slide axis so blowback is a pure z slide) ---
    const slideGroup = new Mesh("slideGroup", scene);
    slideGroup.position.set(0, 0.118, 0);
    slideGroup.parent = parent;

    this.prim(MeshBuilder.CreateBox("slideBody", { width: 0.034, height: 0.034, depth: 0.205 }, scene), slideMat, slideGroup, null);

    // rounded top spine kills the boxy roofline
    this.prim(MeshBuilder.CreateCylinder("slideSpine", { height: 0.19, diameter: 0.026, tessellation: 20 }, scene),
      slideMat, slideGroup, [0, 0.011, 0], { rx: Math.PI / 2 });

    // cocking serrations front + rear, both flanks
    for (const [sx, sz, nm] of [
      [-0.0178, -0.072, "serRL"], [0.0178, -0.072, "serRR"],
      [-0.0178, 0.058, "serFL"], [0.0178, 0.058, "serFR"],
    ] as const) {
      this.prim(MeshBuilder.CreateBox(nm, { width: 0.0015, height: 0.026, depth: 0.042 }, scene), knurlMat, slideGroup, [sx, -0.001, sz]);
    }

    // ejection port cut on the right flank + extractor bar behind it
    this.prim(MeshBuilder.CreateBox("ejectionPort", { width: 0.004, height: 0.018, depth: 0.052 }, scene),
      darkTrimMat, slideGroup, [0.0162, 0.006, 0.025]);

    this.prim(MeshBuilder.CreateBox("extractor", { width: 0.003, height: 0.005, depth: 0.03 }, scene), steelMat, slideGroup, [0.0168, 0.009, -0.012]);

    // machining line along each flank
    for (const ex of [-0.0172, 0.0172]) {
      this.prim(MeshBuilder.CreateBox(`slideEtch${ex < 0 ? "L" : "R"}`, { width: 0.0008, height: 0.002, depth: 0.18 }, scene),
        darkTrimMat, slideGroup, [ex, -0.009, 0]);
    }

    // rear sight: two dovetail ears with a true notch between them, a white
    // dot on each ear. Sights ride proud of the slide spine so the ADS eye
    // line (y = +0.146 in weapon space) sees the front post in the notch.
    for (const ex of [-0.00825, 0.00825]) {
      this.prim(MeshBuilder.CreateBox(`rearSightEar${ex < 0 ? "L" : "R"}`, { width: 0.0085, height: 0.009, depth: 0.013 }, scene),
        slideMat, slideGroup, [ex, 0.0245, -0.094]);
    }
    this.prim(MeshBuilder.CreateBox("rearSightBase", { width: 0.025, height: 0.004, depth: 0.013 }, scene), slideMat, slideGroup, [0, 0.019, -0.094]);

    for (const dx of [-0.0075, 0.0075]) {
      this.prim(MeshBuilder.CreateCylinder(`rearDot${dx < 0 ? "L" : "R"}`, { height: 0.0015, diameter: 0.0035, tessellation: 10 }, scene),
        dotMat, slideGroup, [dx, 0.0255, -0.1008], { rx: Math.PI / 2 });
    }

    // front sight post with the third white dot facing the shooter
    this.prim(MeshBuilder.CreateBox("frontSight", { width: 0.007, height: 0.011, depth: 0.014 }, scene), slideMat, slideGroup, [0, 0.024, 0.092]);

    this.prim(MeshBuilder.CreateCylinder("frontDot", { height: 0.0015, diameter: 0.0035, tessellation: 10 }, scene),
      dotMat, slideGroup, [0, 0.027, 0.0845], { rx: Math.PI / 2 });

    // muzzle: barrel proud of the slide face, bushing ring, dark bore
    this.prim(MeshBuilder.CreateCylinder("pistolBarrel", { height: 0.014, diameter: 0.0205, tessellation: 18 }, scene),
      steelMat, slideGroup, [0, -0.0005, 0.108], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("muzzleBushing", { height: 0.006, diameter: 0.027, tessellation: 18 }, scene),
      darkTrimMat, slideGroup, [0, -0.0005, 0.1045], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("pistolBore", { height: 0.003, diameter: 0.012, tessellation: 12 }, scene),
      darkTrimMat, slideGroup, [0, -0.0005, 0.1155], { rx: Math.PI / 2 });

    // rear plate (breech face cover)
    this.prim(MeshBuilder.CreateBox("slideRearPlate", { width: 0.03, height: 0.028, depth: 0.004 }, scene),
      darkTrimMat, slideGroup, [0, -0.001, -0.1035]);

    // chambered round peeking through the port (visible when the slide rides back)
    this.prim(MeshBuilder.CreateCylinder("chamberBrass", { height: 0.024, diameter: 0.0115, tessellation: 12 }, scene),
      brassMat, parent, [0.004, 0.112, 0.022], { rx: Math.PI / 2 }); // frame-level: stays put as the slide moves

    // --- Frame (polymer) ---
    this.prim(MeshBuilder.CreateBox("frameBody", { width: 0.03, height: 0.032, depth: 0.135 }, scene), polymerMat, parent, [0, 0.09, -0.012]);

    // rail edge where slide meets frame
    this.prim(MeshBuilder.CreateBox("frameRailEdge", { width: 0.032, height: 0.003, depth: 0.135 }, scene), darkTrimMat, parent, [0, 0.1035, -0.012]);

    // dust cover accessory rail with grooves
    this.prim(MeshBuilder.CreateBox("accessoryRail", { width: 0.03, height: 0.014, depth: 0.052 }, scene), polymerMat, parent, [0, 0.083, 0.052]);

    for (const gy of [0.0795, 0.0865]) {
      this.prim(MeshBuilder.CreateBox(`railGroove${gy}`, { width: 0.031, height: 0.0022, depth: 0.052 }, scene), darkTrimMat, parent, [0, gy, 0.052]);
    }

    // trigger guard: round rear ring + squared front face
    this.prim(MeshBuilder.CreateTorus("pistolTriggerGuard", { diameter: 0.054, thickness: 0.0065, tessellation: 24 }, scene),
      polymerMat, parent, [0, 0.063, -0.018], { rz: Math.PI / 2 }); // vertical ring

    this.prim(MeshBuilder.CreateBox("guardFront", { width: 0.0065, height: 0.026, depth: 0.0065 }, scene),
      polymerMat, parent, [0, 0.052, 0.0095], { rx: 0.15 });

    this.prim(MeshBuilder.CreateBox("pistolTrigger", { width: 0.006, height: 0.025, depth: 0.009 }, scene),
      steelMat, parent, [0, 0.063, -0.008], { rx: 0.28 });

    // --- Grip (raked back ~17°): core + stipple panels + straps ---
    const GRIP_RAKE = 0.3;
    this.prim(MeshBuilder.CreateBox("gripCore", { width: 0.031, height: 0.105, depth: 0.044 }, scene),
      polymerMat, parent, [0, 0.026, -0.075], { rx: GRIP_RAKE });

    this.prim(MeshBuilder.CreateBox("gripPanels", { width: 0.0335, height: 0.075, depth: 0.04 }, scene),
      stippleMat, parent, [0, 0.022, -0.0765], { rx: GRIP_RAKE });

    this.prim(this.createLimb("backstrap", scene, new Vector3(0, 0.078, -0.094), new Vector3(0, -0.018, -0.108), 0.0105), polymerMat, parent, null);

    this.prim(this.createLimb("frontstrap", scene, new Vector3(0, 0.07, -0.052), new Vector3(0, -0.022, -0.078), 0.01), stippleMat, parent, null);

    // beavertail shelf over the web of the hand
    this.prim(MeshBuilder.CreateSphere("beavertail", { diameter: 0.022, segments: 12 }, scene),
      polymerMat, parent, [0, 0.085, -0.112], { scale: [1, 0.5, 1.3] });

    // --- Controls: mag release, slide release, safety, takedown pin, lanyard ---
    this.prim(MeshBuilder.CreateCylinder("magRelease", { height: 0.005, diameter: 0.0095, tessellation: 12 }, scene),
      steelMat, parent, [-0.0175, 0.07, -0.043], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateBox("slideRelease", { width: 0.0025, height: 0.0065, depth: 0.046 }, scene),
      steelMat, parent, [-0.0168, 0.1, -0.035]);

    this.prim(MeshBuilder.CreateCylinder("slideReleasePin", { height: 0.004, diameter: 0.0065, tessellation: 10 }, scene),
      steelMat, parent, [-0.0168, 0.1, -0.013], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateBox("safetyLever", { width: 0.0025, height: 0.012, depth: 0.018 }, scene),
      steelMat, parent, [-0.0168, 0.103, -0.083], { rx: -0.5 });

    this.prim(MeshBuilder.CreateCylinder("takedownPin", { height: 0.004, diameter: 0.0065, tessellation: 10 }, scene),
      steelMat, parent, [0.0162, 0.094, -0.02], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateTorus("lanyardLoop", { diameter: 0.01, thickness: 0.002, tessellation: 12 }, scene),
      steelMat, parent, [0, -0.03, -0.105], { rx: Math.PI / 2 });

    // --- Hammer group (pivot at the hammer pin; rocks back with the slide).
    // USP-style exposed ring hammer: the pivot sits at the frame tang so the
    // cocked spur stands clearly proud of the slide's rear plate — the
    // signature "pin" silhouette on the back of the gun. Spur top stays
    // under the rear-sight notch (eye line y = +0.146) in every pose. ---
    const hammerGroup = new Mesh("hammerGroup", scene);
    hammerGroup.position.set(0, 0.1, -0.098);
    hammerGroup.parent = parent;

    this.prim(MeshBuilder.CreateBox("hammerBody", { width: 0.011, height: 0.028, depth: 0.007 }, scene), steelMat, hammerGroup, [0, 0.008, -0.002]);

    // ring spur: wide drum with a dark through-hole suggested on both faces
    this.prim(MeshBuilder.CreateCylinder("hammerSpur", { height: 0.009, diameter: 0.019, tessellation: 14 }, scene),
      steelMat, hammerGroup, [0, 0.0235, -0.008], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("hammerHole", { height: 0.0096, diameter: 0.0085, tessellation: 12 }, scene),
      darkTrimMat, hammerGroup, [0, 0.0235, -0.008], { rz: Math.PI / 2 });

    hammerGroup.rotation.x = -0.55; // carried cocked

    this.prim(MeshBuilder.CreateCylinder("hammerPin", { height: 0.036, diameter: 0.006, tessellation: 10 }, scene),
      steelMat, parent, [0, 0.1, -0.098], { rz: Math.PI / 2 });

    // --- Magazine group (pivot at the grip heel; slides out along the rake) ---
    const magGroup = new Mesh("magGroup", scene);
    magGroup.position.set(0, -0.022, -0.091);
    magGroup.rotation.x = GRIP_RAKE;
    magGroup.parent = parent;

    this.prim(MeshBuilder.CreateBox("magBody", { width: 0.0245, height: 0.055, depth: 0.034 }, scene), steelMat, magGroup, [0, 0.024, 0]);

    this.prim(MeshBuilder.CreateBox("magBasePlate", { width: 0.0315, height: 0.011, depth: 0.046 }, scene),
      polymerMat, magGroup, [0, -0.004, -0.001]);

    this.prim(MeshBuilder.CreateCylinder("magTopRound", { height: 0.022, diameter: 0.0115, tessellation: 12 }, scene),
      brassMat, magGroup, [0, 0.055, 0.002], { rx: Math.PI / 2 });

    // --- Right arm: bare trigger arm, palm on the grip's right flank,
    // index riding the trigger, thumb crossing to the camera-facing flank.
    // The pistol arms sit much closer to the camera than the rifle's, so
    // every thickness runs ~78% of the rifle numbers to read the same. ---
    const rShoulder = new Vector3(0.3, -0.58, -0.5);
    const rElbow = new Vector3(0.13, -0.27, -0.3);
    const rForeEnd = new Vector3(0.032, -0.008, -0.112);

    this.addCuff("uspRightCuff", scene, parent, sleeveMat, rShoulder, rElbow, 0.22, 0.105, 0.05);
    this.createTaperedLimb("uspRightUpper", scene, parent, skinMat, rShoulder, rElbow, 0.048, 0.041, 20);
    this.addMuscleBulge("uspRightBicep", scene, parent, skinMat, rShoulder, rElbow, 0.5, 0.078, 0.13, 0.074, new Vector3(-0.003, 0.01, 0));

    this.prim(MeshBuilder.CreateSphere("uspRightElbow", { diameter: 0.072, segments: 16 }, scene), skinMat, parent, rElbow);

    this.createTaperedLimb("uspRightFore", scene, parent, skinMat, rElbow, rForeEnd, 0.039, 0.028, 20);
    this.addMuscleBulge("uspRightFlexor", scene, parent, skinMat, rElbow, rForeEnd, 0.3, 0.07, 0.11, 0.067, new Vector3(-0.004, 0.005, 0));

    this.addVein("uspRightVein", scene, parent, veinMat, [
      new Vector3(0.085, -0.155, -0.215),
      new Vector3(0.062, -0.105, -0.185),
      new Vector3(0.043, -0.06, -0.155),
    ], 0.004);

    this.prim(this.createLimb( "uspRightPalm", scene, new Vector3(0.028, -0.012, -0.098), new Vector3(0.024, 0.042, -0.112), 0.0245 ),
      gloveMat, parent, null);

    this.addCuff("uspRightStrap", scene, parent, rubberMat,
      new Vector3(0.028, -0.012, -0.098), new Vector3(0.024, 0.042, -0.112), 0.08, 0.058, 0.018);

    // three fingers wrapped around the frontstrap — gloved base, bare tip
    for (let i = 0; i < 3; i++) {
      const y = 0.034 - i * 0.02;
      this.prim(this.createLimb( `uspRightFinger${i}`, scene, new Vector3(0.026, y, -0.062), new Vector3(0.002, y + 0.003, -0.052), 0.0102 ),
        gloveMat, parent, null);

      this.prim(this.createLimb( `uspRightFingerTip${i}`, scene, new Vector3(0.002, y + 0.003, -0.052), new Vector3(-0.018, y + 0.006, -0.06), 0.0092 ),
        handMat, parent, null);
    }

    // index finger: along the frame, tip dropping onto the trigger
    this.prim(this.createLimb( "uspRightIndex", scene, new Vector3(0.026, 0.054, -0.096), new Vector3(0.013, 0.052, -0.045), 0.0094 ),
      gloveMat, parent, null);

    this.prim(this.createLimb( "uspRightIndexTip", scene, new Vector3(0.013, 0.052, -0.045), new Vector3(0.0045, 0.06, -0.012), 0.0085 ),
      handMat, parent, null);

    // right thumb crosses behind the grip to lie on the near (camera) flank
    this.prim(this.createLimb( "uspRightThumb", scene, new Vector3(0.016, 0.062, -0.108), new Vector3(-0.016, 0.06, -0.09), 0.0112 ),
      handMat, parent, null);

    this.prim(this.createLimb( "uspRightThumbTip", scene, new Vector3(-0.016, 0.06, -0.09), new Vector3(-0.02, 0.064, -0.058), 0.01 ),
      handMat, parent, null);

    // --- Support (left) arm group: wraps the right hand; the rig drops this
    // off-screen to run the mag swap during reloads ---
    const supportArmGroup = new Mesh("supportArmGroup", scene);
    supportArmGroup.parent = parent;

    const lShoulder = new Vector3(-0.34, -0.62, -0.42);
    const lElbow = new Vector3(-0.18, -0.3, -0.26);
    const lForeEnd = new Vector3(-0.034, -0.026, -0.108);

    this.addCuff("uspLeftCuff", scene, supportArmGroup, sleeveMat, lShoulder, lElbow, 0.25, 0.103, 0.05);
    this.createTaperedLimb("uspLeftUpper", scene, supportArmGroup, skinMat, lShoulder, lElbow, 0.047, 0.041, 20);
    this.addMuscleBulge("uspLeftBicep", scene, supportArmGroup, skinMat, lShoulder, lElbow, 0.5, 0.082, 0.133, 0.078, new Vector3(0.002, 0.012, 0));

    this.prim(MeshBuilder.CreateSphere("uspLeftElbow", { diameter: 0.074, segments: 16 }, scene), skinMat, supportArmGroup, lElbow);

    this.createTaperedLimb("uspLeftFore", scene, supportArmGroup, skinMat, lElbow, lForeEnd, 0.039, 0.029, 20);
    this.addMuscleBulge("uspLeftFlexor", scene, supportArmGroup, skinMat, lElbow, lForeEnd, 0.3, 0.072, 0.117, 0.069, new Vector3(-0.004, 0.006, 0));

    // raised veins on the camera-facing flank of the support forearm
    this.addVein("uspLeftVeinMain", scene, supportArmGroup, veinMat, [
      new Vector3(-0.152, -0.247, -0.23),
      new Vector3(-0.124, -0.196, -0.204),
      new Vector3(-0.097, -0.143, -0.177),
      new Vector3(-0.072, -0.094, -0.152),
    ], 0.0044);
    this.addVein("uspLeftVeinBranch", scene, supportArmGroup, veinMat, [
      new Vector3(-0.124, -0.196, -0.204),
      new Vector3(-0.104, -0.166, -0.185),
      new Vector3(-0.086, -0.138, -0.168),
    ], 0.0036);
    this.addVein("uspLeftVeinElbow", scene, supportArmGroup, veinMat, [
      new Vector3(-0.205, -0.345, -0.283),
      new Vector3(-0.19, -0.316, -0.27),
      new Vector3(-0.176, -0.288, -0.258),
    ], 0.0046);

    this.prim(this.createLimb( "uspLeftPalm", scene, new Vector3(-0.03, -0.02, -0.094), new Vector3(-0.022, 0.03, -0.112), 0.0245 ),
      gloveMat, supportArmGroup, null);

    this.addCuff("uspLeftStrap", scene, supportArmGroup, rubberMat,
      new Vector3(-0.03, -0.02, -0.094), new Vector3(-0.022, 0.03, -0.112), 0.06, 0.06, 0.018);

    this.prim(MeshBuilder.CreateSphere("uspLeftThenar", { diameter: 0.022, segments: 12 }, scene),
      gloveMat, supportArmGroup, [-0.027, 0.006, -0.092]);

    // four fingers wrapping over the right hand's fingers
    for (let i = 0; i < 4; i++) {
      const y = 0.024 - i * 0.019;
      this.prim(this.createLimb( `uspLeftFinger${i}`, scene, new Vector3(-0.028, y, -0.06), new Vector3(0.0, y + 0.002, -0.048), 0.0106 ),
        gloveMat, supportArmGroup, null);

      this.prim(this.createLimb( `uspLeftFingerTip${i}`, scene, new Vector3(0.0, y + 0.002, -0.048), new Vector3(0.022, y + 0.005, -0.058), 0.0094 ),
        handMat, supportArmGroup, null);
    }

    // left thumb stacked under the right thumb along the camera-facing flank
    this.prim(this.createLimb( "uspLeftThumb", scene, new Vector3(-0.03, 0.036, -0.096), new Vector3(-0.028, 0.042, -0.066), 0.011 ),
      gloveMat, supportArmGroup, null);

    this.prim(this.createLimb( "uspLeftThumbTip", scene, new Vector3(-0.028, 0.042, -0.066), new Vector3(-0.024, 0.046, -0.036), 0.01 ),
      handMat, supportArmGroup, null);

    this.mergeWeaponParts(parent, [slideGroup, hammerGroup, magGroup, supportArmGroup]);

    parent.position.set(0.155, -0.235, 0.46);
    parent.rotation.y = -Math.PI / 40;

    return parent;
  }

  // Worn black phosphate/blued metal for the MP44 receiver: chipped stamped
  // edges, oily handling polish, and small rain-bright scratches.
  private createMp44MetalTexture(scene: Scene): DynamicTexture {
    return this.makeCanvasTexture(scene, "mp44MetalTex", 512, (ctx, s) => {
      ctx.fillStyle = "#111519";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#0b0e11", "#171c21", "#20262c", "#090b0d"], 360, 5, 28, 0.38);
      this.paintNoise(ctx, s, ["#2b3239", "#38414a"], 80, 2, 9, 0.16);

      // long stamped flats and folded seams
      ctx.globalAlpha = 0.32;
      for (const y of [74, 132, 246, 308, 388]) {
        const grad = ctx.createLinearGradient(0, y - 7, 0, y + 7);
        grad.addColorStop(0, "#07090b");
        grad.addColorStop(0.48, "#313840");
        grad.addColorStop(1, "#07090b");
        ctx.fillStyle = grad;
        ctx.fillRect(0, y - 2, s, 4);
      }
      ctx.globalAlpha = 1;

      // edge chips and handling scratches
      ctx.strokeStyle = "rgba(180,188,188,0.34)";
      ctx.lineCap = "round";
      for (let i = 0; i < 48; i++) {
        const x = Math.random() * s;
        const y = Math.random() * s;
        const len = 8 + Math.random() * 42;
        const a = (Math.random() - 0.5) * 0.5;
        ctx.globalAlpha = 0.12 + Math.random() * 0.24;
        ctx.lineWidth = 1 + Math.random() * 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  // Dark laminated wartime stock/handguard finish: wet grain, dents, and
  // rubbed high spots, closer to the reference than a fresh warm rifle stock.
  private createMp44WoodTexture(scene: Scene): DynamicTexture {
    return this.makeCanvasTexture(scene, "mp44WoodTex", 512, (ctx, s) => {
      const base = ctx.createLinearGradient(0, 0, s, 0);
      base.addColorStop(0, "#24170e");
      base.addColorStop(0.45, "#3b2414");
      base.addColorStop(0.7, "#1f130b");
      base.addColorStop(1, "#4a2e19");
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, s, s);

      for (let i = 0; i < 26; i++) {
        const y = Math.random() * s;
        const wobble = 10 + Math.random() * 30;
        ctx.strokeStyle = i % 3 === 0 ? "rgba(95,58,28,0.5)" : "rgba(18,10,5,0.42)";
        ctx.lineWidth = 1.2 + Math.random() * 3.2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= s; x += 36) {
          ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * wobble + (Math.random() - 0.5) * 10);
        }
        ctx.stroke();
      }
      this.paintNoise(ctx, s, ["#120a05", "#5a351a", "#2b180b"], 180, 3, 20, 0.28);

      // pressure dents and gouges
      ctx.strokeStyle = "rgba(8,5,3,0.45)";
      for (let i = 0; i < 20; i++) {
        const x = Math.random() * s, y = Math.random() * s;
        ctx.lineWidth = 1 + Math.random() * 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 12 + Math.random() * 35, y + (Math.random() - 0.5) * 9);
        ctx.stroke();
      }
    });
  }

  // MP44/StG-44-style automatic rifle viewmodel. The reference silhouette is
  // built around the hooded ring front sight, tall rear notch, ribbed stamped
  // receiver, dark wet metal, curved magazine, and support hand along the left
  // side of the fore-end.
  public createMp44Mesh(scene: Scene): Mesh {
    const parent = new Mesh("mp44_root", scene);

    // Spherical sky-glint map — the same trick the M40A3 scope and USP slide
    // use to read as real blued steel instead of flat paint. Tuned moodier
    // (overcast rain-yard sky, low warm sun) so the wartime metal stays dark
    // but catches a live rim light as the view turns. This is the single
    // biggest reason the MP44 used to look flatter than the other two guns.
    const skyReflTex = this.makeCanvasTexture(scene, "mp44ReflTex", 256, (ctx, s) => {
      const grad = ctx.createLinearGradient(0, 0, 0, s);
      grad.addColorStop(0.0, "#c8d6e4");
      grad.addColorStop(0.42, "#7c8ea1");
      grad.addColorStop(0.58, "#dfe9f2"); // bright overcast horizon band
      grad.addColorStop(0.66, "#515f6e");
      grad.addColorStop(1.0, "#1b2129");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);
      const sun = ctx.createRadialGradient(s * 0.62, s * 0.26, 2, s * 0.62, s * 0.26, 44);
      sun.addColorStop(0, "rgba(255,247,228,0.85)");
      sun.addColorStop(1, "rgba(255,247,228,0)");
      ctx.fillStyle = sun;
      ctx.beginPath();
      ctx.arc(s * 0.62, s * 0.26, 44, 0, Math.PI * 2);
      ctx.fill();
    });
    skyReflTex.coordinatesMode = Texture.SPHERICAL_MODE;

    const metalMat = this.stdMat(scene, "mp44MetalMat", { tex: this.createMp44MetalTexture(scene), spec: [0.4, 0.42, 0.45], power: 52 });
    // grazing-angle sheen on the stamped receiver/barrel — dark face-on, bright
    // at the silhouette edge where the blueing catches the sky
    metalMat.reflectionTexture = skyReflTex;
    metalMat.reflectionFresnelParameters = new FresnelParameters();
    metalMat.reflectionFresnelParameters.bias = 0.02;
    metalMat.reflectionFresnelParameters.power = 5;
    metalMat.reflectionFresnelParameters.leftColor = new Color3(0.34, 0.37, 0.41);
    metalMat.reflectionFresnelParameters.rightColor = Color3.Black();

    const darkMat = this.stdMat(scene, "mp44DarkMat", { diffuse: [0.018, 0.02, 0.022], spec: [0.14, 0.15, 0.16], power: 28 });
    darkMat.reflectionTexture = skyReflTex;
    darkMat.reflectionFresnelParameters = new FresnelParameters();
    darkMat.reflectionFresnelParameters.bias = 0.01;
    darkMat.reflectionFresnelParameters.power = 6;
    darkMat.reflectionFresnelParameters.leftColor = new Color3(0.16, 0.18, 0.21);
    darkMat.reflectionFresnelParameters.rightColor = Color3.Black();

    // worn high spots / in-the-white edges — polished steel, strongest catch
    const edgeMat = this.stdMat(scene, "mp44WornEdgeMat", { diffuse: [0.46, 0.48, 0.48], spec: [0.72, 0.74, 0.78], power: 92 });
    edgeMat.reflectionTexture = skyReflTex;
    edgeMat.reflectionFresnelParameters = new FresnelParameters();
    edgeMat.reflectionFresnelParameters.bias = 0.12;
    edgeMat.reflectionFresnelParameters.power = 2.4;
    edgeMat.reflectionFresnelParameters.leftColor = new Color3(0.62, 0.65, 0.68);
    edgeMat.reflectionFresnelParameters.rightColor = new Color3(0.12, 0.13, 0.15);

    const woodMat = this.stdMat(scene, "mp44WoodMat", { tex: this.createMp44WoodTexture(scene), spec: [0.16, 0.11, 0.06], power: 18 });
    // faint waxed sheen on the laminated furniture
    woodMat.reflectionTexture = skyReflTex;
    woodMat.reflectionFresnelParameters = new FresnelParameters();
    woodMat.reflectionFresnelParameters.bias = 0.03;
    woodMat.reflectionFresnelParameters.power = 7;
    woodMat.reflectionFresnelParameters.leftColor = new Color3(0.16, 0.12, 0.08);
    woodMat.reflectionFresnelParameters.rightColor = Color3.Black();

    // knurled control surfaces (charging knob, selector, muzzle nut)
    const knurlMat = this.stdMat(scene, "mp44KnurlMat", { tex: this.createKnurlTexture(scene), spec: [0.4, 0.4, 0.45], power: 64 });

    const sightDotMat = this.stdMat(scene, "mp44SightDotMat", { diffuse: [0.72, 0.72, 0.66], emissive: [0.22, 0.22, 0.18] });

    const brassMat = this.stdMat(scene, "mp44BrassMat", { diffuse: [0.48, 0.35, 0.14], spec: [0.7, 0.56, 0.26], power: 62 });
    brassMat.reflectionTexture = skyReflTex;
    brassMat.reflectionFresnelParameters = new FresnelParameters();
    brassMat.reflectionFresnelParameters.bias = 0.1;
    brassMat.reflectionFresnelParameters.power = 2.6;
    brassMat.reflectionFresnelParameters.leftColor = new Color3(0.55, 0.43, 0.16);
    brassMat.reflectionFresnelParameters.rightColor = Color3.Black();

    const skinTex = this.createSkinTexture(scene);
    const skinMat = this.stdMat(scene, "mp44SkinArmMat", { tex: skinTex, spec: [0.16, 0.13, 0.1], power: 24 });

    const handMat = this.stdMat(scene, "mp44SkinHandMat", { tex: this.createHandTexture(scene), spec: [0.14, 0.11, 0.09], power: 22 });

    const gloveMat = this.stdMat(scene, "mp44GloveMat", { tex: this.createGloveTexture(scene), spec: [0.05, 0.05, 0.045], power: 12 });

    const sleeveMat = this.stdMat(scene, "mp44SleeveMat", { tex: this.createCamoTexture(scene), diffuse: [0.78, 0.78, 0.76], spec: [0.02, 0.02, 0.02] });

    const rubberMat = this.stdMat(scene, "mp44RubberMat", { diffuse: [0.055, 0.055, 0.06], spec: [0.03, 0.03, 0.03], power: 10 });

    const veinMat = this.stdMat(scene, "mp44SkinVeinMat", { tex: skinTex, diffuse: [0.82, 0.88, 0.95], spec: [0.18, 0.16, 0.14], power: 30 });

    // --- Receiver and barrel assembly ---
    this.prim(MeshBuilder.CreateBox("mp44Receiver", { width: 0.062, height: 0.072, depth: 0.34 }, scene), metalMat, parent, [0, 0.103, -0.055]);

    // Kept below the y=+0.17 sight axis so nothing crosses the ADS view,
    // and low enough that the rear leaf stays visible over the tube.
    this.prim(MeshBuilder.CreateCylinder("mp44ReceiverTop", { height: 0.31, diameter: 0.05, tessellation: 24 }, scene),
      metalMat, parent, [0, 0.128, -0.047], { rx: Math.PI / 2, sx: 0.74 });

    this.prim(MeshBuilder.CreateBox("mp44LowerFold", { width: 0.067, height: 0.013, depth: 0.31 }, scene), darkMat, parent, [0, 0.064, -0.055]);

    for (let i = 0; i < 7; i++) {
      const z = -0.18 + i * 0.046;
      this.prim(MeshBuilder.CreateBox(`mp44ReceiverRib${i}`, { width: 0.066, height: 0.0045, depth: 0.012 }, scene), edgeMat, parent, [0, 0.1285, z]);
    }

    for (const sx of [-1, 1]) {
      this.prim(MeshBuilder.CreateBox(`mp44SideStamp${sx}`, { width: 0.003, height: 0.027, depth: 0.19 }, scene),
        darkMat, parent, [0.033 * sx, 0.111, -0.045]);

      for (let i = 0; i < 6; i++) {
        this.prim(MeshBuilder.CreateCylinder(`mp44Rivet${sx}_${i}`, { height: 0.004, diameter: 0.0062, tessellation: 10 }, scene),
          edgeMat, parent, [0.035 * sx, 0.077 + (i % 2) * 0.047, -0.178 + i * 0.061], { rz: Math.PI / 2 });
      }
    }

    this.prim(MeshBuilder.CreateBox("mp44EjectionPort", { width: 0.004, height: 0.026, depth: 0.068 }, scene),
      darkMat, parent, [-0.0338, 0.124, 0.025]);

    const boltGroup = new Mesh("mp44BoltGroup", scene);
    boltGroup.position.set(-0.037, 0.126, 0.026);
    boltGroup.parent = parent;

    this.prim(MeshBuilder.CreateBox("mp44BoltFace", { width: 0.005, height: 0.02, depth: 0.054 }, scene), edgeMat, boltGroup, [0.001, 0, 0]);

    this.prim(MeshBuilder.CreateCylinder("mp44ChargeStem", { height: 0.026, diameter: 0.006, tessellation: 10 }, scene),
      edgeMat, boltGroup, [-0.014, 0.004, -0.017], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateSphere("mp44ChargeKnob", { diameter: 0.017, segments: 14 }, scene), knurlMat, boltGroup, [-0.031, 0.004, -0.017]);

    this.prim(MeshBuilder.CreateCylinder("mp44ChamberRound", { height: 0.03, diameter: 0.0095, tessellation: 12 }, scene),
      brassMat, parent, [-0.01, 0.126, 0.025], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("mp44GasTube", { height: 0.27, diameter: 0.024, tessellation: 24 }, scene),
      metalMat, parent, [0, 0.146, 0.18], { rx: Math.PI / 2 });

    // gas-block collar where the tube meets the barrel, plus the bleed port
    this.prim(MeshBuilder.CreateCylinder("mp44GasBlock", { height: 0.03, diameter: 0.032, tessellation: 20 }, scene),
      metalMat, parent, [0, 0.14, 0.318], { rx: Math.PI / 2 });
    this.prim(MeshBuilder.CreateCylinder("mp44GasPort", { height: 0.0185, diameter: 0.007, tessellation: 12 }, scene),
      darkMat, parent, [0, 0.153, 0.318]);

    this.prim(MeshBuilder.CreateCylinder("mp44Barrel", { height: 0.36, diameterTop: 0.016, diameterBottom: 0.021, tessellation: 24 }, scene),
      edgeMat, parent, [0, 0.121, 0.285], { rx: Math.PI / 2 });

    for (const z of [0.08, 0.16, 0.255, 0.37]) {
      this.prim(MeshBuilder.CreateCylinder(`mp44BarrelBand${z}`, { height: 0.012, diameter: 0.034, tessellation: 20 }, scene),
        darkMat, parent, [0, 0.134, z], { rx: Math.PI / 2 });
    }

    this.prim(MeshBuilder.CreateCylinder("mp44Muzzle", { height: 0.034, diameter: 0.024, tessellation: 20 }, scene),
      darkMat, parent, [0, 0.121, 0.475], { rx: Math.PI / 2 });

    // chamfered crown ring catches a bright glint off the muzzle face
    this.prim(MeshBuilder.CreateCylinder("mp44MuzzleCrown", { height: 0.006, diameterTop: 0.025, diameterBottom: 0.02, tessellation: 20 }, scene),
      edgeMat, parent, [0, 0.121, 0.49], { rx: -Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("mp44Bore", { height: 0.004, diameter: 0.011, tessellation: 12 }, scene),
      darkMat, parent, [0, 0.121, 0.494], { rx: Math.PI / 2 });

    // Threaded muzzle-nut step behind the crown
    this.prim(MeshBuilder.CreateCylinder("mp44MuzzleNut", { height: 0.011, diameter: 0.0265, tessellation: 20 }, scene),
      knurlMat, parent, [0, 0.121, 0.458], { rx: Math.PI / 2 });

    // --- Iron sights ---
    // Sight axis invariant: x=0, y=+0.17 in weapon space. The final ADS frame
    // raises the weapon to y=-0.17, so the post tip, hood center, and rear
    // notch all sit exactly on the camera axis — rounds land on the sights.
    const sightY = 0.17;

    // Hooded front sight: pyramid block on the barrel, tapered post whose tip
    // reaches the axis, and a ring hood centered on it.
    this.prim(MeshBuilder.CreateCylinder("mp44FrontSightBase", { height: 0.032, diameterBottom: 0.036, diameterTop: 0.013, tessellation: 4 }, scene),
      metalMat, parent, [0, 0.137, 0.429], { ry: Math.PI / 4 });

    this.prim(MeshBuilder.CreateTorus("mp44FrontSightHood", { diameter: 0.046, thickness: 0.004, tessellation: 36 }, scene),
      darkMat, parent, [0, sightY, 0.429], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateCylinder("mp44FrontPost", { height: 0.0145, diameterBottom: 0.006, diameterTop: 0.0044, tessellation: 10 }, scene),
      darkMat, parent, [0, 0.159, 0.429]);

    this.prim(MeshBuilder.CreateCylinder("mp44FrontPostTip", { height: 0.0037, diameterBottom: 0.0044, diameterTop: 0.0036, tessellation: 10 }, scene),
      sightDotMat, parent, [0, sightY - 0.00185, 0.429]);

    // Rear sight: ramped slider base + leaf with a true V-notch. The whole
    // leaf sits BELOW the sight axis (COD4 reference framing) so the full
    // hood ring and post float above it, unobstructed, at full ADS.
    this.prim(MeshBuilder.CreateBox("mp44RearSightRamp", { width: 0.04, height: 0.016, depth: 0.055 }, scene),
      metalMat, parent, [0, 0.147, -0.148], { rx: -0.08 });

    this.prim(MeshBuilder.CreateBox("mp44RearSlider", { width: 0.045, height: 0.007, depth: 0.015 }, scene), edgeMat, parent, [0, 0.1545, -0.138]);

    this.prim(MeshBuilder.CreateBox("mp44RearLeaf", { width: 0.044, height: 0.009, depth: 0.0055 }, scene), darkMat, parent, [0, 0.15, -0.168]);

    for (const sx of [-1, 1]) {
      this.prim(MeshBuilder.CreateBox(`mp44RearCheek${sx}`, { width: 0.0165, height: 0.011, depth: 0.0055 }, scene),
        darkMat, parent, [0.0125 * sx, 0.157, -0.168], { rz: 0.42 * sx }); // inner edges slope down into the V

      this.prim(MeshBuilder.CreateBox(`mp44RearCheekWear${sx}`, { width: 0.014, height: 0.0016, depth: 0.0058 }, scene),
        edgeMat, parent, [0.0104 * sx, 0.1621, -0.168], { rz: 0.42 * sx });
    }

    // --- Furniture: dark wood stock, pistol grip, fore-end ---
    this.prim(MeshBuilder.CreateBox("mp44ButtPad", { width: 0.07, height: 0.105, depth: 0.028 }, scene), rubberMat, parent, [0, 0.067, -0.46]);

    this.prim(MeshBuilder.CreateSphere("mp44Stock", { diameter: 0.12, segments: 18 }, scene),
      woodMat, parent, [0, 0.068, -0.345], { scale: [0.44, 0.68, 1.55] });

    this.createTaperedLimb(
      "mp44StockNeck", scene, parent, woodMat,
      new Vector3(0, 0.048, -0.27), new Vector3(0, 0.082, -0.185),
      0.035, 0.032, 18
    );

    this.prim(MeshBuilder.CreateBox("mp44PistolGrip", { width: 0.052, height: 0.13, depth: 0.045 }, scene),
      woodMat, parent, [0, 0.012, -0.162], { rx: 0.36 });

    this.prim(MeshBuilder.CreateBox("mp44GripCap", { width: 0.057, height: 0.011, depth: 0.052 }, scene),
      darkMat, parent, [0, -0.054, -0.184], { rx: 0.36 });

    this.prim(MeshBuilder.CreateCylinder("mp44ForeEnd", { height: 0.225, diameterTop: 0.063, diameterBottom: 0.073, tessellation: 22 }, scene),
      woodMat, parent, [0, 0.067, 0.106], { rx: Math.PI / 2, sx: 0.72 });

    for (let i = 0; i < 4; i++) {
      this.prim(MeshBuilder.CreateBox(`mp44ForeGroove${i}`, { width: 0.052, height: 0.003, depth: 0.17 }, scene),
        darkMat, parent, [0, 0.091 + i * 0.006, 0.112]);
    }

    this.prim(MeshBuilder.CreateTorus("mp44FrontSlingLoop", { diameter: 0.022, thickness: 0.0025, tessellation: 12 }, scene),
      edgeMat, parent, [-0.044, 0.073, 0.18], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateTorus("mp44RearSlingLoop", { diameter: 0.021, thickness: 0.0025, tessellation: 12 }, scene),
      edgeMat, parent, [-0.044, 0.08, -0.3], { rz: Math.PI / 2 });

    // Trigger group and controls
    this.prim(MeshBuilder.CreateTorus("mp44TriggerGuard", { diameter: 0.058, thickness: 0.0065, tessellation: 24 }, scene),
      metalMat, parent, [0, 0.045, -0.12], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateBox("mp44Trigger", { width: 0.007, height: 0.031, depth: 0.011 }, scene),
      edgeMat, parent, [0, 0.046, -0.105], { rx: 0.22 });

    this.prim(MeshBuilder.CreateCylinder("mp44Selector", { height: 0.006, diameter: 0.014, tessellation: 14 }, scene),
      knurlMat, parent, [-0.035, 0.111, -0.125], { rz: Math.PI / 2 });

    this.prim(MeshBuilder.CreateBox("mp44SelectorLever", { width: 0.004, height: 0.007, depth: 0.032 }, scene),
      edgeMat, parent, [-0.038, 0.104, -0.108], { rx: -0.45 });

    // Push-button cross-bolt safety on the trigger housing (the AUTO/single
    // selector's companion control) — a small in-the-white detail
    this.prim(MeshBuilder.CreateCylinder("mp44SafetyButton", { height: 0.006, diameter: 0.0105, tessellation: 12 }, scene),
      edgeMat, parent, [-0.034, 0.07, -0.118], { rz: Math.PI / 2 });

    // --- Curved stamped magazine group ---
    const magGroup = new Mesh("mp44MagGroup", scene);
    magGroup.position.set(0, 0.028, -0.035);
    magGroup.rotation.x = -0.1;
    magGroup.parent = parent;

    // One smooth banana extrusion curving forward (real StG44 direction),
    // with stamped vertical side ribs built into the cross-section profile.
    const magW = 0.026, magD = 0.029, magCh = 0.007, magRib = 0.0018;
    const magShape = [
      new Vector3(magW, -(magD - magCh), 0),
      new Vector3(magW, -0.013, 0),
      new Vector3(magW + magRib, -0.0095, 0),
      new Vector3(magW, -0.006, 0),
      new Vector3(magW, 0.006, 0),
      new Vector3(magW + magRib, 0.0095, 0),
      new Vector3(magW, 0.013, 0),
      new Vector3(magW, magD - magCh, 0),
      new Vector3(magW - magCh, magD, 0),
      new Vector3(-(magW - magCh), magD, 0),
      new Vector3(-magW, magD - magCh, 0),
      new Vector3(-magW, 0.013, 0),
      new Vector3(-(magW + magRib), 0.0095, 0),
      new Vector3(-magW, 0.006, 0),
      new Vector3(-magW, -0.006, 0),
      new Vector3(-(magW + magRib), -0.0095, 0),
      new Vector3(-magW, -0.013, 0),
      new Vector3(-magW, -(magD - magCh), 0),
      new Vector3(-(magW - magCh), -magD, 0),
      new Vector3(magW - magCh, -magD, 0),
    ];
    const magPath: Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      // start slightly off-vertical so the extrusion frame stays stable
      const a = 0.05 + (i / 10) * 0.34;
      magPath.push(new Vector3(
        0,
        0.012 - 0.5 * (Math.sin(a) - Math.sin(0.05)),
        0.004 + 0.5 * (Math.cos(0.05) - Math.cos(a))
      ));
    }
    const magBody = MeshBuilder.ExtrudeShape("mp44MagBody", {
      shape: magShape,
      path: magPath,
      closeShape: true,
      cap: Mesh.CAP_ALL,
      sideOrientation: Mesh.DOUBLESIDE,
    }, scene);
    magBody.material = metalMat;
    magBody.parent = magGroup;

    this.prim(MeshBuilder.CreateBox("mp44MagFeedLips", { width: 0.046, height: 0.012, depth: 0.052 }, scene), edgeMat, magGroup, [0, 0.011, 0.002]);

    this.prim(MeshBuilder.CreateCylinder("mp44MagTopRound", { height: 0.032, diameter: 0.0095, tessellation: 12 }, scene),
      brassMat, magGroup, [0, 0.021, 0.006], { rx: Math.PI / 2 });

    this.prim(MeshBuilder.CreateBox("mp44MagBasePlate", { width: 0.058, height: 0.012, depth: 0.066 }, scene),
      darkMat, magGroup, [0, -0.157, 0.043], { rx: -0.39 }); // matches the arc tangent at the bottom

    // --- Right trigger arm and hand ---
    const rShoulder = new Vector3(0.33, -0.58, -0.58);
    const rElbow = new Vector3(0.15, -0.27, -0.37);
    const rForeEnd = new Vector3(0.044, -0.034, -0.21);

    this.addCuff("mp44RightCuff", scene, parent, sleeveMat, rShoulder, rElbow, 0.22, 0.126, 0.055);
    this.createTaperedLimb("mp44RightUpper", scene, parent, skinMat, rShoulder, rElbow, 0.057, 0.048, 20);
    this.addMuscleBulge("mp44RightBicep", scene, parent, skinMat, rShoulder, rElbow, 0.5, 0.094, 0.154, 0.088, new Vector3(-0.003, 0.01, 0));

    this.prim(MeshBuilder.CreateSphere("mp44RightElbow", { diameter: 0.088, segments: 16 }, scene), skinMat, parent, rElbow);

    this.createTaperedLimb("mp44RightFore", scene, parent, skinMat, rElbow, rForeEnd, 0.046, 0.035, 20);
    this.addMuscleBulge("mp44RightFlexor", scene, parent, skinMat, rElbow, rForeEnd, 0.3, 0.083, 0.132, 0.079, new Vector3(-0.004, 0.005, 0));
    this.addVein("mp44RightVein", scene, parent, veinMat, [
      new Vector3(0.092, -0.155, -0.3),
      new Vector3(0.067, -0.104, -0.263),
      new Vector3(0.047, -0.058, -0.232),
    ], 0.0042);

    // Trigger hand built like the M40A3's: short palm capsule tucked against
    // the grip's right face (following the grip rake, top forward), glove
    // strap at the heel, two-segment index reaching the trigger, three
    // fingers wrapping the front strap with bare tips, bare thumb over the top.
    this.prim(this.createLimb( "mp44RightPalm", scene, new Vector3(0.034, -0.022, -0.198), new Vector3(0.03, 0.034, -0.178), 0.0255 ),
      gloveMat, parent, null);

    this.addCuff("mp44RightStrap", scene, parent, rubberMat,
      new Vector3(0.034, -0.022, -0.198), new Vector3(0.03, 0.034, -0.178), 0.06, 0.06, 0.018);

    this.prim(this.createLimb( "mp44RightIndex", scene, new Vector3(0.029, 0.038, -0.18), new Vector3(0.012, 0.046, -0.135), 0.0094 ),
      gloveMat, parent, null);

    this.prim(this.createLimb( "mp44RightIndexTip", scene, new Vector3(0.012, 0.046, -0.135), new Vector3(0.004, 0.047, -0.112), 0.0085 ),
      handMat, parent, null);

    for (let i = 0; i < 3; i++) {
      const y = 0.018 - i * 0.021;
      // the grip is raked (top forward), so each lower finger sits further back
      const zr = -0.152 - i * 0.008;
      this.prim(this.createLimb( `mp44RightFinger${i}`, scene, new Vector3(0.036, y, zr), new Vector3(0.016, y + 0.007, zr + 0.019), 0.0102 ),
        gloveMat, parent, null);

      this.prim(this.createLimb( `mp44RightFingerTip${i}`, scene, new Vector3(0.016, y + 0.007, zr + 0.019), new Vector3(-0.002, y + 0.011, zr + 0.017), 0.0092 ),
        handMat, parent, null);
    }

    this.prim(this.createLimb( "mp44RightThumb", scene, new Vector3(0.022, 0.048, -0.18), new Vector3(-0.006, 0.056, -0.2), 0.0112 ),
      handMat, parent, null);

    // --- Support arm group: rests along fore-end, leaves during reload ---
    const supportArmGroup = new Mesh("mp44SupportArmGroup", scene);
    supportArmGroup.parent = parent;

    const lShoulder = new Vector3(-0.38, -0.62, -0.32);
    const lElbow = new Vector3(-0.21, -0.32, -0.11);
    // forearm runs straight into the heel of the hand under the fore-end
    const lForeEnd = new Vector3(-0.034, 0.005, 0.06);

    this.addCuff("mp44LeftCuff", scene, supportArmGroup, sleeveMat, lShoulder, lElbow, 0.24, 0.126, 0.055);
    this.createTaperedLimb("mp44LeftUpper", scene, supportArmGroup, skinMat, lShoulder, lElbow, 0.056, 0.048, 20);
    this.addMuscleBulge("mp44LeftBicep", scene, supportArmGroup, skinMat, lShoulder, lElbow, 0.5, 0.096, 0.158, 0.09, new Vector3(0.002, 0.012, 0));

    this.prim(MeshBuilder.CreateSphere("mp44LeftElbow", { diameter: 0.09, segments: 16 }, scene), skinMat, supportArmGroup, lElbow);

    this.createTaperedLimb("mp44LeftFore", scene, supportArmGroup, skinMat, lElbow, lForeEnd, 0.047, 0.036, 20);
    this.addMuscleBulge("mp44LeftFlexor", scene, supportArmGroup, skinMat, lElbow, lForeEnd, 0.3, 0.086, 0.14, 0.082, new Vector3(-0.004, 0.006, 0));
    this.addVein("mp44LeftVeinMain", scene, supportArmGroup, veinMat, [
      new Vector3(-0.18, -0.247, -0.06),
      new Vector3(-0.143, -0.19, -0.018),
      new Vector3(-0.108, -0.132, 0.026),
      new Vector3(-0.075, -0.079, 0.064),
    ], 0.0044);

    // M40A3-style support grip adapted to the MP44 fore-end: palm cups the
    // wood from BELOW (heel growing straight out of the forearm, body tucked
    // under the left-bottom quadrant), four two-segment fingers wrap the far
    // side with bare tips cresting the top line, thumb rides the
    // camera-facing flank pointing up toward the muzzle.
    this.prim(this.createLimb( "mp44LeftPalm", scene, new Vector3(-0.024, 0.024, 0.07), new Vector3(-0.012, 0.038, 0.135), 0.031 ),
      gloveMat, supportArmGroup, null);

    // glove strap ringing the heel of the hand
    this.addCuff("mp44LeftStrap", scene, supportArmGroup, rubberMat,
      new Vector3(-0.024, 0.024, 0.07), new Vector3(-0.012, 0.038, 0.135), 0.05, 0.069, 0.02);

    // thenar mass at the thumb root, visible under the near edge
    this.prim(MeshBuilder.CreateSphere("mp44LeftThenar", { diameter: 0.024, segments: 12 }, scene), gloveMat, supportArmGroup, [-0.032, 0.04, 0.085]);

    // four two-segment fingers wrapping the far side of the fore-end —
    // gloved up to the knuckle, bare past it (fingerless gloves)
    for (let i = 0; i < 4; i++) {
      const z = 0.075 + i * 0.022;
      const r = 0.0112 - i * 0.0005;

      this.prim(MeshBuilder.CreateSphere(`mp44LeftKnuckle${i}`, { diameter: 0.013, segments: 10 }, scene),
        gloveMat, supportArmGroup, [0.027, 0.094, z + 0.002]);

      this.prim(this.createLimb( `mp44LeftFinger${i}`, scene, new Vector3(0.02, 0.046, z), new Vector3(0.027, 0.092, z + 0.002), r ),
        gloveMat, supportArmGroup, null);

      this.prim(this.createLimb( `mp44LeftFingerTip${i}`, scene, new Vector3(0.027, 0.092, z + 0.002), new Vector3(0.014, 0.112, z + 0.0035), r * 0.88 ),
        handMat, supportArmGroup, null);
    }

    // thumb pressed along the near flank, pointing up toward the muzzle,
    // kept outboard of the wood so the whole digit stays visible
    this.prim(this.createLimb( "mp44LeftThumb", scene, new Vector3(-0.032, 0.038, 0.078), new Vector3(-0.039, 0.062, 0.092), 0.013 ),
      gloveMat, supportArmGroup, null);

    this.prim(this.createLimb( "mp44LeftThumbTip", scene, new Vector3(-0.039, 0.062, 0.092), new Vector3(-0.033, 0.092, 0.112), 0.0115 ),
      handMat, supportArmGroup, null);

    this.mergeWeaponParts(parent, [boltGroup, magGroup, supportArmGroup]);

    parent.position.set(0.19, -0.265, 0.55);
    parent.rotation.y = -Math.PI / 38;

    return parent;
  }

  // Weathered concrete perimeter wall covered in layered graffiti: throw-ups,
  // wildstyle letters, tags, drips and wheat-paste remnants. Designed to tile
  // horizontally (uScale=6) and fill once vertically (vScale=1).
  public createGraffitiWallMaterial(scene: Scene, uScale: number = 6, vScale: number = 1): StandardMaterial {
    return this.canvasMat(scene, `graffitiWallMat_${uScale}_${vScale}`, 1024, { spec: [0.03, 0.03, 0.03], power: 8, u: uScale, v: vScale }, (ctx, s) => {
      // -- Concrete base --
      ctx.fillStyle = "#8c8a84";
      ctx.fillRect(0, 0, s, s);
      this.paintNoise(ctx, s, ["#858380", "#93918c", "#7e7c78", "#9b9993"], 500, 6, 55, 0.45);
      this.paintNoise(ctx, s, ["#6e6c68", "#62605c"], 200, 2, 9, 0.38);
      this.paintNoise(ctx, s, ["#a6a4a0", "#9e9c98"], 100, 1, 5, 0.32);

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
        let x = Math.random() * s, y = Math.random() * s;
        ctx.moveTo(x, y);
        for (let j = 0; j < 7; j++) {
          x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 60;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      const drawOverspray = (
        cx: number,
        cy: number,
        w: number,
        h: number,
        colors: string[],
        count: number,
        alpha: number
      ) => {
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
          const px = x - width * 0.43 + i * (width * 0.86 / (dripCount - 1)) + (Math.random() - 0.5) * 18;
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
          drawDrip(s * 0.2 + i * s * 0.07, s * 0.64 + Math.random() * 14, 14 + Math.random() * 34, i % 3 === 0 ? "#b8161b" : "#f15f20", 2.5 + Math.random() * 3);
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
        const sx2 = Math.random() * s, sy2 = Math.random() * s;
        ctx.beginPath();
        ctx.arc(sx2, sy2, 0.4 + Math.random() * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
  }

  // Pin-up poster mural — a real photo, served same-origin from /public so the
  // WebGL texture upload isn't blocked by cross-origin tainting. Replaces the
  // old hand-drawn canvas portrait. id picks which poster:
  //   id=1: red gingham bikini (3:4)   id=2: flag bikini (~9:16)
  public createPortraitMuralMaterial(scene: Scene, id: 1 | 2): StandardMaterial {
    const name = `portraitMuralMat_${id}`;
    const cached = scene.getMaterialByName(name);
    if (cached) return cached as StandardMaterial;

    const tex = new Texture(`/mural${id}.jpg`, scene);
    tex.anisotropicFilteringLevel = 8;

    const mat = new StandardMaterial(name, scene);
    mat.diffuseTexture = tex;
    // The overcast rain key is flat and the haze eats contrast, so let the
    // poster self-illuminate a touch — it reads as a printed photo, not a
    // muddy smear, without going fullbright.
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(0.35, 0.35, 0.35);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mat.specularPower = 12;
    return mat;
  }

  public createBillboardMuralMaterial(scene: Scene, id: 1 | 2): StandardMaterial {
    const name = `billboardMuralMat_${id}`;
    const cached = scene.getMaterialByName(name);
    if (cached) return cached as StandardMaterial;

    // The poster art is composited onto a canvas so the print itself can be
    // weathered in place — desaturated toward the overcast palette, edges
    // darkened, rain-drip streaks, grime blotches and paste-sheet seams —
    // instead of reading like a fresh print bolted into a rainy yard.
    // Canvas matches each source's aspect (mural1 3:4, mural2 452x768) so
    // nothing stretches; it starts as flat grime until the JPG arrives.
    const w = id === 1 ? 768 : 452;
    const h = id === 1 ? 1024 : 768;
    const tex = new DynamicTexture(`billboardMuralTex_${id}`, { width: w, height: h }, scene, true);
    tex.anisotropicFilteringLevel = 8;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = "#3b3e3c";
    ctx.fillRect(0, 0, w, h);
    tex.update();

    const img = new Image();
    img.src = `/mural${id}.jpg`;
    img.onload = () => {
      ctx.drawImage(img, 0, 0, w, h);

      // pull the print's saturation toward the muted rain palette
      ctx.globalCompositeOperation = "saturation";
      ctx.fillStyle = "rgba(128, 128, 128, 0.45)";
      ctx.fillRect(0, 0, w, h);

      // weather-darkened edges (multiply vignette)
      ctx.globalCompositeOperation = "multiply";
      const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.25, w / 2, h / 2, h * 0.72);
      vig.addColorStop(0, "#ffffff");
      vig.addColorStop(1, "#969c9a");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, w, h);

      // rain-drip streaks bleeding down from the top edge
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

      // grime blotches
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

      // pale mineral wash where water sheets off the frame
      ctx.globalCompositeOperation = "screen";
      const wash = ctx.createLinearGradient(0, 0, 0, h * 0.3);
      wash.addColorStop(0, "rgba(140, 148, 150, 0.16)");
      wash.addColorStop(1, "rgba(140, 148, 150, 0)");
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h * 0.3);

      ctx.globalCompositeOperation = "source-over";
      tex.update();
    };

    const mat = new StandardMaterial(name, scene);
    mat.diffuseTexture = tex;
    // Half the previous hoarding brightness: the print sits back in the
    // overcast scene instead of outshining it, the tiny emissive lift only
    // keeps it legible at distance.
    mat.diffuseColor = new Color3(0.19, 0.20, 0.215);
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(0.02, 0.02, 0.022);
    mat.specularColor = new Color3(0.04, 0.04, 0.04);
    mat.specularPower = 8;
    return mat;
  }
}
