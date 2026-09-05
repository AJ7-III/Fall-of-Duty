import { Color3, DynamicTexture, StandardMaterial } from "@babylonjs/core";
import type { BaseTexture, Scene } from "@babylonjs/core";

// Procedural texture kit. Every surface in the yard is painted at load time
// on a 2D canvas — zero external image assets, nothing to license — and the
// same painter can be turned into a tangent-space normal map so flat quads
// pick up real relief under the directional light.

export type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;

export type RGB = readonly [number, number, number];

export interface StdMatOptions {
  tex?: BaseTexture | null;
  bump?: BaseTexture | null;
  diffuse?: RGB;
  spec?: RGB;
  power?: number;
  emissive?: RGB;
}

export interface CanvasMatOptions {
  spec: RGB;
  power?: number;
  u?: number;
  v?: number;
  // Relief strength for the generated normal map (0 = none). The height
  // field is the painted luminance unless `height` paints a dedicated one.
  bump?: number;
  height?: Painter;
}

export function paintCanvas(size: number, paint: Painter): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  paint(canvas.getContext("2d") as CanvasRenderingContext2D, size);
  return canvas;
}

export function makeCanvasTexture(scene: Scene, name: string, size: number, paint: Painter): DynamicTexture {
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  paint(tex.getContext() as CanvasRenderingContext2D, size);
  tex.update();
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

// Scatter soft elliptical blotches — the workhorse for surface grime/variation
export function paintNoise(
  ctx: CanvasRenderingContext2D,
  size: number,
  colors: readonly string[],
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

// Tangent-space normal map from a height canvas (luminance = height), Sobel
// filtered with wrap-around so tiled textures never seam. Written in the
// OpenGL/glTF convention (+X right, +Y up); Babylon's left-handed default
// wants X flipped, which the material flag below handles.
export function normalMapFromHeight(scene: Scene, name: string, height: HTMLCanvasElement, strength: number): DynamicTexture {
  const s = height.width;
  const src = (height.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, s, s).data;
  const h = new Float32Array(s * s);
  for (let i = 0; i < s * s; i++) {
    h[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }
  const at = (x: number, y: number): number => h[((y + s) % s) * s + ((x + s) % s)];

  const tex = new DynamicTexture(name, { width: s, height: s }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const out = ctx.createImageData(s, s);
  const d = out.data;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -gx * strength;
      let ny = gy * strength; // canvas y grows downward; +Y up in tangent space
      let nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * s + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  tex.update();
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

// StandardMaterial with the common settings applied in one call
export function stdMat(scene: Scene, name: string, o: StdMatOptions): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  if (o.tex) mat.diffuseTexture = o.tex;
  if (o.bump) {
    mat.bumpTexture = o.bump;
    mat.invertNormalMapX = true; // OpenGL-convention map in a left-handed scene
    mat.invertNormalMapY = false;
  }
  if (o.diffuse) mat.diffuseColor = new Color3(o.diffuse[0], o.diffuse[1], o.diffuse[2]);
  if (o.spec) mat.specularColor = new Color3(o.spec[0], o.spec[1], o.spec[2]);
  if (o.power !== undefined) mat.specularPower = o.power;
  if (o.emissive) mat.emissiveColor = new Color3(o.emissive[0], o.emissive[1], o.emissive[2]);
  return mat;
}

// Cached canvas-painted material: scene-cache lookup -> paint -> material
// (+ optional normal map). The texture name derives from the material name.
export function canvasMat(scene: Scene, name: string, size: number, o: CanvasMatOptions, paint: Painter): StandardMaterial {
  const cached = scene.getMaterialByName(name);
  if (cached) return cached as StandardMaterial;
  const texName = name.replace("Mat", "Tex");
  const tex = makeCanvasTexture(scene, texName, size, paint);
  let bump: DynamicTexture | null = null;
  if (o.bump) {
    const height = o.height ? paintCanvas(size, o.height) : (tex.getContext().canvas as HTMLCanvasElement);
    bump = normalMapFromHeight(scene, `${texName}_n`, height, o.bump);
    if (o.u !== undefined) bump.uScale = o.u;
    if (o.v !== undefined) bump.vScale = o.v;
  }
  if (o.u !== undefined) tex.uScale = o.u;
  if (o.v !== undefined) tex.vScale = o.v;
  return stdMat(scene, name, { tex, bump, spec: o.spec, power: o.power });
}
