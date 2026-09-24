# Foliage / Leaf-Card Material — Design Brief

How to make instanced leaf cards look like soft translucent foliage instead of flat
dark cutouts, in Three.js WebGPU/TSL. Priority order below; steps 1–3 do ~80%.

## Diagnosis (two different root causes)
- **Flat / self-shadowed / half go dark** → *shading-normal* problem. A flat quad has one
  constant normal, so cards facing away from the sun go uniformly dark. Fix = bend normals
  into a dome/sphere so cards shade like a rounded canopy.
- **Black undersides / no glow** → *fill-light + translucency* problem, NOT normals.
  Three.js already flips back-face normals on `DoubleSide`. Fix = ambient/sky fill + a
  light-transmission term.

## Fix priority
1. **Fill light first** (cheapest, biggest win): `HemisphereLight` (sky/ground) + environment
   irradiance (PMREM/IBL). Resolves most "dark undersides." We already have HemisphereLight;
   adding an env map would help further.
2. **Dome / spherical normals** (the flat-card fix) — SpeedTree "Global Smoothing" =
   `normalize(leafPos − treeCenter)`. In TSL: override `material.normalNode`:
   ```js
   const domeWorld = normalize(positionWorld.sub(treeCenter));      // uniform vec3 = canopy centre
   mat.normalNode = normalize(mix(normalView, transformNormalToView(domeWorld), 0.7));
   ```
   Same normal on both faces (don't `negateOnBackSide`) keeps undersides lit. **IMPLEMENTED**
   in `core/leaf-cards.js` (domeStrength default 0.7).
3. **Translucency / backlight glow** — Barré-Brisebois model. Three.js r184 ships
   **`MeshSSSNodeMaterial`** (extends MeshPhysicalNodeMaterial) implementing exactly this; set
   `thicknessColorNode` (subsurface tint), `thicknessDistortionNode≈0.1`, `thicknessPowerNode≈2`,
   `thicknessScaleNode≈12`. Or copy its `direct()` into a custom `LightingModel`. **NOT yet done**
   — next foliage upgrade. (Marked experimental; cheap O(1) term, fine for instanced cards.)
4. **Wrap / half-Lambert diffuse** to soften the terminator: `NdotL*0.5+0.5` (optionally `^2`).
   Needs a custom `LightingModel.direct()` (not a material property).
5. **Alpha + shadows**: `alphaTest` for cutout (flows to shadow map). **`alphaToCoverage` does
   NOT reach three.js shadow maps** (issue #30462) → use alphaTest or an alphaHash customDepth.
   For soft shadows use PCFSoft/VSM + shadow bias; engines also reduce foliage self-shadow
   strength. Coverage-preserving mips (or runtime `alpha *= 1 + mip*0.25`) stop distant foliage
   from thinning away.

## TSL API notes (verified)
- `material.normalNode` expects a **view-space** vector; convert world normals with
  `transformNormalToView()`. Accessors: `positionWorld`, `normalView`, `normalWorld`.
- Deprecated aliases: `transformedNormalView/World` → `normalView/World`;
  `directionToFaceDirection` → `negateOnBackSide`.
- `material.lightingModel` is NOT a real property — use a `LightingModel` subclass via
  `setupLightingModel()` override or `lightsNode.context({ lightingModel })`
  (see `webgpu_lights_custom` example).
- Per-instance dome centres via `instancedBufferAttribute`/`attribute('name')` if a single
  tree-centre uniform isn't enough (we use a single canopy-centroid uniform per tree).
- Overdraw (overlapping alpha), not triangle count, is the foliage perf bottleneck.

Refs: SpeedTree leaf_generator (Global/Local/Card Smoothing, Puffiness), Barré-Brisebois GDC2011
translucency, three.js `MeshSSSNodeMaterial` source + `webgpu_materials_sss`/`webgpu_lights_custom`
examples, bgolus alpha-to-coverage, Valve Half-Lambert.

## Translucency IMPLEMENTED (uniform-glow fix)

Root cause of "every leaf glows the same lime-green when backlit" (verified in r184
`MeshSSSNodeMaterial` source): the Barré-Brisebois term depends only on V/L/N, so all
camera-facing cards transmit identically unless the **thickness inputs vary spatially**.
Two culprits: `thicknessAmbientNode` is a flat view-independent glow floor (the example's
0.4 is the classic mistake — set **0** for leaves), and a **constant** `thicknessColorNode`.

**Fix (implemented in `leaf-cards.js`):** `thicknessColorNode = perTexelMap × perInstanceRandom × desaturatedGreen`, `ambient=0`, `power=6`, `scale=3`, `distortion=0.3`, transmit color `rgb(0.42,0.62,0.24)`.
- **Per-texel translucency map** (`scripts/texture/derive-translucency.mjs`): whole leaf blade
  transmits (bright), veins/midrib dark (luminance high-pass), soft edge cut at alpha<0.35.
  Derived from the leaf's own texture → perfectly co-registered (do NOT generate a separate
  unaligned map). **Gotcha found:** an early blurred-alpha "rim" version inverted on lobed
  leaves (thin interior tissue lit, perimeter dark) — dropped it for uniform-blade + dark-veins.
- **Per-instance random** thickness attribute `aThickness` (0.4–1, Unreal PerInstanceRandom
  style) — the key lever that makes leaves vary card-to-card instead of glowing identically.
- Still available if needed: shadow-based interior darkening (three folds shadow into lightColor
  before transmission, so `receiveShadow=true` + a shadow-casting sun darkens interior leaves),
  and a full custom `LightingModel` subclass (both `LightingModel`/`PhysicalLightingModel` are
  exported from `three/webgpu`; hook via `setupLightingModel()`).

## Leaf atlas + atlas fruit (pomegranate, fig, tamarisk)

An optional second way to carry fruit and flowers, beside the orchard path
(apple/cherry hang real GLB fruit with its own material): put every foliage
picture — leaf card, flower card, fruit skin — on ONE leaf texture, a LEAF
ATLAS, so the tree keeps two materials (bark + leaves). Pomegranate, fig and
tamarisk are built this way:

- **Atlas** — `scripts/texture/compose-leaf-atlas.mjs` packs chroma-keyed
  cutouts (`fit`: cropped, base at the slot bottom, `rot180` for sprigs
  authored hanging) and opaque swatches (`fill`, e.g. a seamless fruit skin;
  `mul=` for a darker calyx/neck copy) into one texture and prints each
  piece's UV rect + aspect. Then `dilate-alpha --fill --fill-rect <leaf rect>`
  → `derive-pbr` → `derive-translucency`, and grade the fruit/flower rects of
  the translucency map to ~0 (`grade-atlas-rect --gain 0`) so they never glow.
- **Leaf cards** — `foliage.leafUV` maps every leaf/cluster card onto its
  rect (`makeLeafGeometry` in `core/leaf-cards.js`); null = whole texture.
- **Accent cards** — `foliage.accents[]` (`{ uv, chance, perBranch, size,
  widthRatio, startFrac, downAngle, droop, enabled, cardBake }`) place extra
  card sets (flowers) on a fraction of the twigs with the leaf grammar, on the
  SAME leaf material (`buildAccentCards`). LOD0/LOD1 mesh them (LOD1 at half
  chance); the LOD2 card bake includes them unless `cardBake: false`.
- **Atlas fruit** — `fruit.atlas: { skin, calyx|neck }` + `fruit.shape`
  ('pomegranate' | 'fig') builds a small lathe mesh (`core/fruit.js
  makeAtlasFruitGeometry`) UV-mapped into the atlas, hung by `buildFruits` and
  drawn with the leaf material. It carries a per-vertex `aThickness = 0`;
  with `foliage.atlasFruit: true` the leaf material reads that as SOLID (true
  geometric normal instead of the canopy dome, no SSS, no flutter). Fruit
  rides LOD0 (hero mesh), LOD1 (½, low-poly twin) and the LOD2 card rung (¼,
  low-poly) as real geometry — a card bake can only fruit ¼/½/all of its few
  exemplar variants, which over-fruits the whole rung.
- **Export** — fruit is exported without dome-bent normals (it is solid).
  With `foliage.mergeExportPiles` (opt-in; the four garden species set it)
  `export-glb.js` merges the instanced piles that share a material before
  grouping, so leaves + fruit + accents write ONE leaves primitive per LOD;
  without it every pile keeps its own primitive, as before.
  With `foliage.singleSidedExport` (opt-in; the three leaf-atlas species) the
  dome-bent card piles are written with BOTH windings and the same outward
  normals, and the leaf material exports `doubleSided: false` (fruit is left
  as is) — see "Dome normals in other engines" below.
- **See-through crowns (tamarisk)** — a haze of thread-thin branchlets is
  built from MANY small cards on invisible guide twigs
  (`terminalStemsAreGuides`), plus three opt-in leaf-material knobs
  (`core/leaf-cards.js`; all default off, so other species are unchanged):
  `selfShadowFloor` (received shadow never darkens below it — no opaque dark
  cores), `shadowAlphaCut` (only texels at least this opaque cast shadow —
  speckled, not solid card shadows) and `alphaDitherMip` + `alphaDitherRange`
  (past that texture mip the alpha test fades into a screen-space dither, so a
  card covers ≈ its mean alpha at range instead of the solid lobed silhouette
  its averaged far mips pass at a fixed cutoff). The dither is render-only:
  `alphaTest` stays the exported glTF MASK cutoff, so an engine needs its own
  dithered/TAA opacity mask to get the same far haze. The LOD2 card material
  inherits `transmit` + `selfShadowFloor` when the floor is set.
  Tamarisk atlas recipe: branchlet + flower panicle keyed with `chroma-key`,
  `compose-leaf-atlas` (plume `fit:rot180:mul=0.74,0.73,0.62`, flower
  `fit:rot180:mul=1.12,1.02,0.95`), `grade-atlas-rect` on the plume rect
  (`--hue 70 --pull 0.55 --sat 0.85 --gamma 0.95 --gain 0.97`), then
  `dilate-alpha --fill --fill-rect <plume>` → `derive-pbr` →
  `derive-translucency` with the flower rect at `--gain 0.8` (pale petals do
  transmit; zeroing them rendered the spikes dark brown).

## Dome normals in other engines

The canopy look depends on the exported dome-bent normals (every card shades by
the outward canopy sphere, not its own face). Two things undo that when a GLB is
imported elsewhere: an importer that **recomputes normals** replaces them with
flat per-face normals (keep "import normals" on), and a **`doubleSided`** glTF
material makes the renderer flip the normal on each card's back face, so half
the card faces shade as if they faced into the canopy (dark interiors and
undersides). The opt-in single-sided export (`foliage.singleSidedExport`)
exists for the second case: both windings, one outward normal, single-sided
material.
