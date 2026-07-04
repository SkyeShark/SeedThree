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
