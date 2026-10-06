# Third-party notices

## Soldier model and animations

`public/models/soldier.glb` contains the Vanguard character from Adobe Mixamo,
with Idle, Walk, Run and TPose animation clips. The character source is recorded
in the project's original credits; the GLB itself has an empty copyright field
and identifies its exporter as `blendergltf v1.2.0`.

This file, its embedded textures and its animations are **excluded from the
repository's MIT license**. Recolouring, conversion to glTF and reuse for the
first-person arms do not change the source asset's terms. The original project
credits do not record the download date or the individual animation IDs.

Source: [Adobe Mixamo](https://www.mixamo.com/).
Usage information: [Adobe's Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html).
Applicable terms: [Mixamo Additional Terms](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf)
and [Adobe General Terms of Use](https://www.adobe.com/legal/terms.html).

The FAQ describes royalty-free use in video games. It does not grant this
repository permission to relicense the raw asset under MIT. Asset reuse or
redistribution must follow Adobe's terms separately from the project's code.

## Runtime dependencies

- [Babylon.js core and loaders](https://github.com/BabylonJS/Babylon.js): Apache License 2.0.

Production builds include this notice and the project MIT license in the root
of `dist/`. `dist/LICENSES/` contains both Babylon package licenses and the
core package's upstream attribution notice. These files are included in the
GitHub Pages deployment alongside the game.

The source repository and package lock identify the dependencies used in a
build. Development tools, including TypeScript, Vite, ESLint, Prettier and
Playwright, retain their own package licenses and are not relicensed by this
repository.
