import assert from "node:assert/strict";
import { test } from "node:test";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { RGBDTextureTools } from "@babylonjs/core/Misc/rgbdTextureTools.js";

test("pending RGBD decode completes safely after scene and engine disposal", { timeout: 5000 }, async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    Object.assign(engine.getCaps(), { textureHalfFloatRender: true, textureHalfFloatLinearFiltering: true });
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([128, 64, 32, 255]), 1, 1, scene, false);
    texture.isRGBD = true;
    const internal = texture.getInternalTexture();
    // NullEngine does not upload raw pixels; mark the supplied data ready so
    // Babylon starts its real asynchronous shader import and RGBD decode.
    internal.isReady = true;
    RGBDTextureTools.ExpandRGBDTexture(texture);
    assert.equal(internal.isReady, false, "decode must still be pending when disposal begins");

    scene.dispose();
    engine.dispose();
    assert.equal(texture.getScene(), null);
    assert.equal(engine.isDisposed, true);

    // Observe cleanup only after disposal, so the ordinary texture disposal
    // cannot satisfy this wait. Babylon's compiled decode callback must run.
    const releaseTexture = engine._releaseTexture.bind(engine);
    let disposedAtDecodeCleanup;
    const decoded = new Promise((resolve) => {
      engine._releaseTexture = (released) => {
        releaseTexture(released);
        if (released === internal) {
          disposedAtDecodeCleanup = engine.isDisposed;
          resolve();
        }
      };
    });
    await decoded;
    assert.equal(disposedAtDecodeCleanup, true);
    assert.equal(internal.isReady, true, "decode callback must reach its completion after cleanup");
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
