import { Color3, Constants, DynamicTexture, PBRMaterial, Texture } from "@babylonjs/core";
import { yardEnvironment } from "../rendering/materials/environment";
import type { BaseTexture, Material, Scene } from "@babylonjs/core";

// The Terminator skin for difficulty 9+: liquid-metal chrome that mirrors
// the yard (the scene's painted environment cube: overcast sky, wet
// ground, container-colour horizon), the armour's own normal map so every plate
// edge still catches light, and red running lights — the Vanguard's red
// trim stripes, lifted from the glb's original albedo as an emissive mask —
// under a visor that burns red into the bloom.

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
  const env = yardEnvironment(scene);

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
