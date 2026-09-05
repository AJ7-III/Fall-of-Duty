import { Constants, HDRFiltering, RawCubeTexture } from "@babylonjs/core";
import type { Scene } from "@babylonjs/core";

// The yard as a reflection environment: what wet steel, glass, chrome and
// puddles mirror. Painted once per scene — an overcast sky matching the
// dome's palette, a bright horizon band, blocks of container colour and
// warehouse grey below it, dark wet ground underneath — and handed to the
// scene as its environment texture so every PBR material picks it up.

const SIZE = 256;

type FacePainter = (ctx: CanvasRenderingContext2D, s: number) => void;

function paintFace(paint: FacePainter): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  paint(ctx, SIZE);
  return new Uint8Array(ctx.getImageData(0, 0, SIZE, SIZE).data.buffer);
}

const sky: FacePainter = (ctx, s) => {
  const g = ctx.createRadialGradient(s * 0.5, s * 0.5, 4, s * 0.5, s * 0.5, s * 0.75);
  g.addColorStop(0, "#5f6771");
  g.addColorStop(1, "#8d959d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 30; i++) {
    ctx.globalAlpha = 0.06 + Math.random() * 0.08;
    ctx.fillStyle = i % 2 ? "#b4bac0" : "#4e565f";
    ctx.beginPath();
    ctx.ellipse(
      Math.random() * s,
      Math.random() * s,
      30 + Math.random() * 60,
      10 + Math.random() * 18,
      Math.random() * Math.PI,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};

const ground: FacePainter = (ctx, s) => {
  ctx.fillStyle = "#1c211a";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) {
    ctx.globalAlpha = 0.1 + Math.random() * 0.12;
    ctx.fillStyle = i % 3 ? "#2f3b2b" : "#5b6571"; // wet grass with puddle glints
    ctx.beginPath();
    ctx.ellipse(Math.random() * s, Math.random() * s, 10 + Math.random() * 26, 5 + Math.random() * 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
};

const side =
  (seed: number): FacePainter =>
  (ctx, s) => {
    // zenith grey down to the bright horizon, then the yard, then wet ground
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, "#6f7780");
    g.addColorStop(0.36, "#9aa1a7");
    g.addColorStop(0.49, "#c2c7cb");
    g.addColorStop(0.51, "#4a5058");
    g.addColorStop(0.78, "#2c312d");
    g.addColorStop(1, "#1c211a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    // containers and warehouse walls as blocks of colour along the horizon
    const palette = ["#3b5a7a", "#7a3b2c", "#3f6b3a", "#5d5d63", "#8b7a4a", "#2c3e50", "#6d6f72"];
    let x = (seed * 31) % 24;
    while (x < s) {
      const w = 20 + ((seed * 7 + x) % 44);
      const h = 28 + ((seed * 13 + x) % 40);
      ctx.fillStyle = palette[(x + seed) % palette.length];
      ctx.fillRect(x, s * 0.51 - h * 0.3, w, h);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fillRect(x, s * 0.51 - h * 0.3, 3, h); // dark seam
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(x, s * 0.51 - h * 0.3, w, 2); // lit top rail
      x += w + 4;
    }
    // rain-slick ground glint under the horizon
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = "#c2c7cb";
    ctx.fillRect(0, s * 0.6, s, 4);
    ctx.globalAlpha = 1;
  };

let cache = new WeakMap<Scene, RawCubeTexture>();

// Six faces in Babylon order: +X, -X, +Y, -Y, +Z, -Z
export function yardEnvironment(scene: Scene): RawCubeTexture {
  const existing = cache.get(scene);
  if (existing) return existing;
  const faces = [
    paintFace(side(1)),
    paintFace(side(2)),
    paintFace(sky),
    paintFace(ground),
    paintFace(side(3)),
    paintFace(side(4)),
  ];
  const env = new RawCubeTexture(scene, faces, SIZE, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT, true);
  env.name = "yardEnvironment";
  env.gammaSpace = true;
  cache.set(scene, env);
  // Prefilter the mip chain for roughness (GGX-convolved lobes instead of
  // raw box mips) so rough surfaces reflect a soft, firefly-free version
  // of the yard, and bake the spherical harmonics for the diffuse term
  new HDRFiltering(scene.getEngine(), { quality: Constants.TEXTURE_FILTERING_QUALITY_MEDIUM })
    .prefilter(env)
    .catch((err) => console.warn("environment prefilter skipped:", err));
  return env;
}

export function resetEnvironmentCache(): void {
  cache = new WeakMap();
}
