<div align="center">

<img src="assets/ui/logo.png" alt="SeedThree" width="128" />

# SeedThree

**Open-source procedural tree & plant generator for the web, built on Three.js (WebGPU).**

**▶ [Use Live NOW!](https://skyeshark.github.io/SeedThree/)** &nbsp;(WebGPU-capable browser required — Chrome/Edge)

</div>

A fully procedural tree and plant generator: pick a species, tune its parameters, and get a unique, textured, wind-animated 3D plant you can drop into a scene or export to glTF.

![SeedThree — a procedurally generated White Oak tree with the live control panel showing shape, foliage, and advanced branch tuning](docs/media/hero_temperate.png)
![SeedThree — a procedurally generated Joshua tree in the desert with the live control panel showing shape, foliage, and LOD parameters](docs/media/hero.png)

> **Status: `v0.1.0-alpha`.** Ten species, full LOD + export pipeline, and a living scene are in — but it's early and rough in places. Expect sharp edges.

## What's in it

- **Ten species across two biomes**
  - *Temperate:* White Oak · Red Maple · Tulip Poplar · Sweetgum · American Beech · Ponderosa Pine · Loblolly Pine · Douglas Fir
  - *Desert:* Joshua Tree · Saguaro
- **Two generators.** A [Weber–Penn](https://courses.cs.duke.edu/fall02/cps124/resources/p119-weber.pdf) parametric model for broadleaves & conifers, and a from-scratch dichotomous [L-system](https://en.wikipedia.org/wiki/L-system) for the desert succulents (merged-tube mesh, rib crests, areole spines).
- **Real morphology.** Each species' branch angles, taper, gnarl, and crown shape are dialed to reference photos, not generic defaults.
- **Foliage as cards.** Base-anchored single-leaf and needle-spray cards with backlit translucency (Barré-Brisebois SSS), dome-normal canopy shading, and per-instance wind.
- **LOD chain + impostors.** LOD0 full geometry → reduced-geometry LOD1 → baked branch-card LOD2 → a 2-plane billboard impostor, baked off-thread in a Web Worker so the viewer never stalls. Per-LOD density & branch-prune dials.
- **A living scene.** Instanced forest ring with per-instance LOD, wind-animated grass & desert scrub, procedural rocks, PBR terrain with slope/height material blending, volumetric-ish clouds, and a movable sun.
- **Ambient audio.** Per-biome wind bed (seamless loop) + randomly interspersed bird calls, with a mute toggle.
- **glTF export.** One click writes a `.glb` with merged per-LOD meshes and standard `KHR_materials_*` extensions (incl. leaf transmission).

## Requirements

A **WebGPU-capable browser** — recent Chrome or Edge (Chrome 113+). There's an automatic WebGL2 fallback, but WebGPU is the intended path.

## Run it

```bash
npm install
npm run dev      # http://localhost:5390
```

Then use the control panel to pick a species, reshape it, reseed, tune LODs, and export a `.glb`. Drag to orbit; the corner speaker button toggles ambient sound.

```bash
npm run build    # production bundle in dist/
npm run preview  # serve the built bundle
```

## How the textures & audio are made

Textures and audio ship in the repo, so a clone runs out of the box — you don't need to regenerate anything. But they're *generated*, and the tooling is included:

- **Textures** (bark albedo, leaf/needle/spine alpha cards) come from **OpenAI Codex CLI's `$imagegen`** (gpt-image-2). Scripts in `scripts/texture/` chroma-key the alpha, dilate, and derive normal/roughness/translucency maps.
- **Wind beds** are generated with **Stable Audio 3** via a local **ComfyUI**, then analyzed and flattened into seamless loops by `scripts/audio/`. Bird calls are trimmed [xeno-canto](https://xeno-canto.org) recordings.

It's a cross-tool collaboration: the engine, PBR derivation, and scene are written by Claude Code; Codex paints the textures; Stable Audio scores the wind.

## Adding a species (agent workflow)

New plants are added by dropping in a **preset** and a small set of **generated textures** — no engine changes. This is designed to be done by a coding agent (Claude Code, Codex, etc.) driving an image generator like **gpt-image-2**. There are three steps.

### 1. Write the preset — `src/species/<name>.js`

Export a species object and register it in `src/species/index.js` (import + add to the `SPECIES` map). **The preset chooses which of the two generators runs** — pick the one that matches the plant:

**A) Broadleaves & conifers → [Weber–Penn](https://courses.cs.duke.edu/fall02/cps124/resources/p119-weber.pdf) parametric model.** Copy the closest existing species (`white-oak.js` is the template; `pine.js` for conifers) and retune the parameters to reference photos.

```js
export const redcedar = {
  name: 'Eastern Redcedar',
  latin: 'Juniperus virginiana',
  bark: 'redcedar_albedo.png',            // → assets/bark/  (+ derived _normal/_roughness)
  leaf: 'redcedar_needle_albedo.png',     // → assets/leaves/ (+ derived _normal/_roughness/_translucency)
  biome: 'temperate',                     // 'temperate' | 'desert' (picks the environment + soundscape)
  tileWorldSize: 1.2,                     // bark tile size in metres
  controls: broadleafControls,            // sliders exposed in the UI
  foliage: { mode: 'leaves', leavesPerBranch: 9, size: 0.7, downAngle: 60, tint: 0xbfcbb0 },
  params: {                               // Weber–Penn — arrays are [trunk, L1, L2, L3]
    scale: 12, levels: 3, ratio: 0.02, baseSize: 0.15, shape: 0 /* 0=conical…5=flame */,
    attractionUp: 0.0, length: [1.0, 0.4, 0.3, 0.25], downAngle: [0, 80, 74, 68],
    curve: [2, 14, 18, 0], branches: [0, 46, 16, 0], radialSegments: [12, 6, 4, 3],
    /* …see white-oak.js / pine.js for the full field list… */
  },
};
```

Rules of thumb: `length[childLevel]` is a **fraction of the parent's** length (small terminal values → short leafy twigs, not bare whips); high `downAngle` + `attractionUp: 0` reads as a conifer, up-swept angles as a broadleaf; `shape` sets the crown silhouette.

**B) Desert succulents (saguaro, Joshua tree, yuccas) → dichotomous [L-system](https://en.wikipedia.org/wiki/L-system) (Lindenmayer).** These aren't branch-and-leaf trees, so they run a completely different generator: set `foliageType: 'rosette'` (or `cactus: true`) and describe the plant as an **L-system** — a branching grammar of fork rules (probability, depth, split angle), segment length/taper, rib count, arm gating, and rosette-leaf or areole-spine placement — which builds a single merged-tube mesh. Copy `saguaro.js` / `joshua-tree.js`; the grammar, parameters, and mesh construction are documented in [`docs/dichotomous-generator.md`](docs/dichotomous-generator.md).

### 2. Generate the textures (image model → PBR maps)

Generate two source images with your image model, then run them through the pipeline in `scripts/texture/`. The loader auto-derives map names by suffix, so **naming matters**: `<x>_albedo.png` → `<x>_normal.png`, `<x>_roughness.png` (+ `_translucency.png` for leaves).

**Bark** — prompt for a *seamless, tileable* bark albedo, then derive PBR:
```bash
node scripts/texture/derive-pbr.mjs assets/bark/redcedar_albedo.png   # writes _normal + _roughness
```

**Leaf / needle card** — generate the foliage on a **flat magenta `#FF00FF`** background (for a clean alpha key), then cut it out and derive maps:
```bash
node scripts/texture/chroma-key.mjs        raw.png assets/leaves/redcedar_needle_albedo.png
node scripts/texture/dilate-alpha.mjs      assets/leaves/redcedar_needle_albedo.png --passes 4
node scripts/texture/derive-pbr.mjs        assets/leaves/redcedar_needle_albedo.png
node scripts/texture/derive-translucency.mjs assets/leaves/redcedar_needle_albedo.png  # → *_albedo_translucency.png (rename to _translucency.png)
```

Art-direction gotchas learned the hard way:
- **A needle spray must be a single feather/frond branchlet** — one central woody axis with needles emanating ~45° on both sides, fully inside the frame. A *radial burst* from one point reads as a **grass tuft** on the tree, not a conifer.
- Bark must tile with no visible seam (offset-check it); a leaf card should fill the frame with a little margin so alpha-dilation and mip-mapping don't clip it.

If you use OpenAI Codex CLI: it can't always save into the workspace, so prompt it to *"generate the image only — do not save/read/list/search files"*, tag the prompt with a unique marker, then harvest the bytes with `scripts/texture/harvest-codex-image.mjs --match <marker> <out.png>`.

### 3. Verify

```bash
npm run dev    # pick your species in the panel; check LOD0→billboard, wind, and GLB export
```

That's the whole loop: **preset in → textures generated → registered → it's a first-class species** with LODs, forest instancing, wind, and export, same as the built-ins.

## Layout

```
src/
  core/        generators (weber-penn, dichotomous), meshing, LOD, cards, impostor, wind, terrain, grass…
  species/     one preset file per plant
  audio/       ambient soundscape (wind bed + bird scheduler)
  ui/          control panel
scripts/
  texture/     Codex image → alpha cutout → PBR/translucency maps
  audio/       Stable Audio generation + seamless-loop tooling
assets/        committed textures & audio
docs/          spec notes + media
```

## License

[MIT](LICENSE) © 2026 SkyeShark.

Generated textures/audio are produced with third-party models (gpt-image-2, Stable Audio 3) and trimmed xeno-canto recordings; check the respective licenses before commercial redistribution of those assets.
