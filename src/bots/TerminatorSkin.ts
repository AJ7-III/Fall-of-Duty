import { Color3, Constants, DynamicTexture, PBRMaterial, RawCubeTexture, Texture } from "@babylonjs/core";
import type { BaseTexture, Material, Scene } from "@babylonjs/core";

// The Terminator skin for difficulty 9+: liquid-metal chrome that actually
// mirrors the yard (a painted environment cube: overcast sky, wet ground,
// container-colour horizon), the armour's own normal map so every plate
// edge still catches light, and red running lights — the Vanguard's red
// trim stripes, lifted from the glb's original albedo as an emissive mask —
// under a visor that burns red into the bloom.

const ENV_SIZE = 128;

function paintFace(paint: (ctx: CanvasRenderingContext2D, s: number) => void): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ENV_SIZE;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  paint(ctx, ENV_SIZE);
  return new Uint8Array(ctx.getImageData(0, 0, ENV_SIZE, ENV_SIZE).data.buffer);
}

// Six faces in Babylon order: +X, -X, +Y, -Y, +Z, -Z
function chromeEnvironment(scene: Scene): RawCubeTexture {
  const sky = (ctx: CanvasRenderingContext2D, s: number): void => {
    const g = ctx.createRadialGradient(s * 0.5, s * 0.5, 4, s * 0.5, s * 0.5, s * 0.75);
    g.addColorStop(0, "#c9d2da");
    g.addColorStop(1, "#8d98a3");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 14; i++) {
      ctx.globalAlpha = 0.08 + Math.random() * 0.08;
      ctx.fillStyle = "#e2e8ee";
      ctx.beginPath();
      ctx.ellipse(
        Math.random() * s,
        Math.random() * s,
        18 + Math.random() * 30,
        5 + Math.random() * 8,
        Math.random() * Math.PI,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  const ground = (ctx: CanvasRenderingContext2D, s: number): void => {
    ctx.fillStyle = "#1b2019";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) {
      ctx.globalAlpha = 0.1 + Math.random() * 0.12;
      ctx.fillStyle = i % 3 ? "#2e3a2a" : "#5a6470"; // wet grass with puddle glints
      ctx.beginPath();
      ctx.ellipse(Math.random() * s, Math.random() * s, 6 + Math.random() * 14, 3 + Math.random() * 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  const side =
    (seed: number) =>
    (ctx: CanvasRenderingContext2D, s: number): void => {
      // sky down to a bright horizon band, then the yard: containers and
      // warehouse walls as blocks of colour, dark wet ground at the bottom
      const g = ctx.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, "#8d98a3");
      g.addColorStop(0.42, "#b9c3cc");
      g.addColorStop(0.5, "#d3dae0");
      g.addColorStop(0.52, "#4a5058");
      g.addColorStop(0.8, "#2a2f2b");
      g.addColorStop(1, "#1b2019");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      const palette = ["#3b5a7a", "#7a3b2c", "#3f6b3a", "#5d5d63", "#8b7a4a", "#2c3e50"];
      let x = (seed * 17) % 20;
      while (x < s) {
        const w = 12 + ((seed * 7 + x) % 22);
        const h = 18 + ((seed * 13 + x) % 20);
        ctx.fillStyle = palette[(x + seed) % palette.length];
        ctx.fillRect(x, s * 0.52 - h * 0.35, w, h);
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(x, s * 0.52 - h * 0.35, 2, h); // dark seam
        x += w + 3;
      }
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = "#c9d2da";
      ctx.fillRect(0, s * 0.62, s, 3); // rain-slick ground glint under the horizon
      ctx.globalAlpha = 1;
    };
  const faces = [
    paintFace(side(1)),
    paintFace(side(2)),
    paintFace(sky),
    paintFace(ground),
    paintFace(side(3)),
    paintFace(side(4)),
  ];
  return new RawCubeTexture(scene, faces, ENV_SIZE, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT, true);
}

// The red trim of the original Vanguard paint job, as an emissive mask:
// every texel where red clearly dominates keeps its colour, the rest is
// black. Read back from the GPU copy the glb loader already uploaded.
async function markingsMask(scene: Scene, albedo: BaseTexture): Promise<DynamicTexture | null> {
  const size = albedo.getSize();
  if (!size.width || !size.height) return null;
  const pixels = (await albedo.readPixels()) as Uint8Array | null;
  if (!pixels) return null;
  // readPixels hands rows back bottom-up (v = 0 first); upload them
  // unflipped so the mask lands in the same orientation as the source
  const tex = new DynamicTexture(
    "terminatorMarkingsTex",
    { width: size.width, height: size.height },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
    Constants.TEXTUREFORMAT_RGBA,
    false
  );
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size.width, size.height);
  const d = img.data;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const red = r > 110 && r > g * 1.7 && r > b * 1.7;
    d[i] = red ? 255 : 0;
    d[i + 1] = red ? 30 : 0;
    d[i + 2] = red ? 16 : 0;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  return tex;
}

export interface TerminatorSkin {
  body: PBRMaterial;
  visor: PBRMaterial;
}

let cached: TerminatorSkin | null = null;
let cachedScene: Scene | null = null;

// One shared skin per scene. `srcBody` is the glb's PBR body material —
// its normal map and original albedo are what make the chrome read as
// armour rather than a smooth statue.
export function terminatorSkin(scene: Scene, srcBody: Material | null): TerminatorSkin {
  if (cached && cachedScene === scene && !scene.isDisposed) return cached;
  const env = chromeEnvironment(scene);

  const body = new PBRMaterial("terminatorChromeMat", scene);
  body.albedoColor = new Color3(0.8, 0.82, 0.86);
  body.metallic = 1;
  body.roughness = 0.19;
  body.reflectionTexture = env;
  body.environmentIntensity = 1.0;
  body.enableSpecularAntiAliasing = true;
  body.emissiveColor = new Color3(1, 0.1, 0.05);
  body.emissiveIntensity = 0; // lit up once the markings mask lands
  const src = srcBody as PBRMaterial | null;
  if (src?.bumpTexture) {
    body.bumpTexture = src.bumpTexture;
    body.invertNormalMapX = src.invertNormalMapX;
    body.invertNormalMapY = src.invertNormalMapY;
  }
  if (src?.albedoTexture) {
    markingsMask(scene, src.albedoTexture)
      .then((mask) => {
        if (!mask || scene.isDisposed) return;
        body.emissiveTexture = mask;
        body.emissiveIntensity = 3.2;
      })
      .catch(() => {
        /* no markings — the chrome still stands */
      });
  }

  const visor = new PBRMaterial("terminatorVisorMat", scene);
  visor.albedoColor = new Color3(0.05, 0.01, 0.01);
  visor.metallic = 0.6;
  visor.roughness = 0.25;
  visor.reflectionTexture = env;
  visor.emissiveColor = new Color3(1, 0.09, 0.04);
  visor.emissiveIntensity = 2.6; // past the bloom threshold: the eyes glow, still red

  cached = { body, visor };
  cachedScene = scene;
  return cached;
}
