# Procedural Generation — Design Brief

Architecture decisions for the SpeedThree skeleton/mesh/foliage/wind pipeline, from a
July 2026 research synthesis. Confidence flagged where sources were thin.

## TL;DR architecture

- **Primary engine: Weber & Penn parametric model** (SIGGRAPH 1995). Proven, compact
  (~50 params), deterministic-per-seed, and the only one of the three families that
  natively covers conifers, palms, **and** cacti/succulents (via `nTaper`/`Lobes`/fan-leaf modes).
- **Secondary "crown solver": space colonization (Runions 2007)** for species where
  irregular mature-broadleaf realism matters (convincing even leafless).
- **Optional third path: L-systems** for herbaceous/rosette plants (yucca/agave rosettes,
  grasses), not trees.
- Downstream: **manual generalized-cylinder ring meshes** (not `TubeGeometry`),
  **InstancedMesh cross-quad foliage** with **alphaHash / alpha-to-coverage**,
  **octahedral-impostor LOD**, **TSL `positionNode` vertex wind** from baked attributes,
  **seeded splitmix32/sfc32 RNG**.

## Algorithm choice by morphology

| Target | Best algorithm | Why |
|---|---|---|
| Realistic broadleaf/deciduous | Space colonization (Weber-Penn fallback) | Crown silhouette + interior density from envelope+points; correct even bare. |
| Conifers | Weber-Penn or L-system | Excurrent, whorled phyllotaxy, dominant leader → per-level downangle/rotate/Shape=conical. |
| Cactus/saguaro | Weber-Penn (or explicit star-section sweep) | `nTaper` 2–3 for ribbed concatenated-sphere body, `Lobes`/`LobeDepth` odd (3/5/7) for ribs, arms as few high-angle branches + strong `AttractionUp`. |
| Yucca/agave/Joshua tree | L-system rosette or Weber-Penn negative-`Leaves` fan mode | Radial rosettes = phyllotactic fan; Joshua = sparse dichotomous splits (`nSegSplits≈1`) + terminal rosettes. *(Reasoned synthesis, not a benchmarked cite.)* |

## Reusable libraries / references

| Library | License | Use |
|---|---|---|
| **ez-tree** (dgreenheck) `github.com/dgreenheck/ez-tree`, npm `@dgreenheck/ez-tree` | **MIT** ✅ | Best MIT runtime generator; WebGL (three ^0.167, no WebGPU). Deep-dive on Codrops. Best starting reference for the generator itself. |
| **fable5-world-demo** (Braffolk) `github.com/Braffolk/fable5-world-demo` | **MIT** ✅ | **The only serious WebGPU-native procedural forest (June 2026):** WebGPURenderer + TSL + WGSL compute, branching grammar, cluster-card foliage, octahedral impostors, ~190k trees. **Study for the WebGPU/TSL architecture.** |
| **InstancedMesh2** (agargaro) `github.com/agargaro/instanced-mesh` | **MIT** ✅ | Forest scattering: InstancedMesh + BVH frustum culling, LOD, per-instance visibility (200k trees). |
| **octahedral-impostor** (agargaro) | **MIT** ✅ | Distant-tree LOD impostors (WIP). |
| **Arbaro** (Java) / **Blender Sapling Tree Gen** (Python) | **GPL** ⚠️ | **Authentic Weber-Penn** — read as algorithm/param source of truth, **do NOT copy** (copyleft). Arbaro ships clean per-species XML param files. |
| **proctree.js** (supereggbert) | **NONE** ❌ | 404 on `/license` → all-rights-reserved, legally unsafe to ship. Also **NOT** Weber-Penn (custom params clumpMax/branchFactor/dropAmount). Reference only. |
| TSL examples | — | Official `webgpu_tsl_wood`, `webgpu_tsl_procedural_terrain`; TSL/WebGPU grass `github.com/CK42BB/procedural-grass-threejs` (3-layer wind, closest wind reference). |

## Branch mesh generation

- **Do NOT use `THREE.TubeGeometry`** — single scalar radius, no taper. Build rings manually:
  for each of `nCurveRes` sections along the spline, emit a ring of `radialSegments` verts at
  the section origin/orientation with per-section radius (the Weber-Penn cross-section sweep).
- **Taper:** `radius·(1 − unitTaper·Z)` with `nTaper` profile; child radius via pipe model
  `parentRadius·(childLen/parentLen)^RatioPower`; `Flare` at base; `Lobes`/`LobeDepth` for ribs.
  Terminal radius ~0.001 so tips close to a point.
- **Junctions:** default = intersecting cylinders (child overlaps parent, tileable bark hides
  seam). Hero close-ups later = welding + intersection blending (SpeedTree) or metaballs. MVP = intersect.
- **UV for tileable bark:** U around circumference, V along length. `u = (j/segments)·wrapsX`,
  integer `wrapsX` = horizontal repeats. **Duplicate the seam vertex** (segments+1 verts/ring;
  extra carries u=wrapsX, first carries u=0). Watch texel density as radius tapers.
- **Poly budget (rough):** billboard 50–800 tris, midground 800–3k, foreground 3k–10k, hero 10k+.
  ~6 radial sides default; fewer sides/sections per level toward tips (store per-level arrays).

## Foliage

- **Cards:** single quad → **cross-quad** (2–4 intersecting, "X"/star) → twig cards (multiple
  leaves baked on one alpha texture). Place on terminal branches.
- **Instancing:** `InstancedMesh` for thousands of identical cards; `InstancedMesh2` (BVH cull)
  for large forests. BatchedMesh only for *many distinct* geometries (currently ~1.5–2× slower).
- **Alpha compositing** (all base-Material flags, shared WebGL/WebGPU NodeMaterials):
  - `alphaTest` — cheapest, no sorting, but hard aliased edges + thin foliage vanishes at distance.
  - `alphaToCoverage` — AA'd, order-independent, but **needs MSAA** + quantized opacity (SpeedTree's leaf choice).
  - `alphaHash` (r154+) — sortless, no MSAA needed, doesn't vanish under minification, but grainy (wants temporal AA). Tune `alphaHashScale` ~0.1–0.5 with AA, 1.0 without.
  - **Decision:** default to alphaHash or alphaToCoverage; *verify alphaHash is wired through the
    WebGPU NodeMaterial before committing* (medium confidence). Keep `alphaTest` on the depth/shadow
    material — alphaToCoverage historically broke foliage shadows.
- **Mip gotcha:** box-filter mips thin out alpha-tested foliage with distance. Use
  coverage-preserving mipmapping or runtime `alpha *= 1 + mipLevel·0.25`. Use **premultiplied
  alpha** to avoid dark leaf-edge fringes.
- **LOD:** `THREE.LOD` full mesh → reduced mesh → billboard/impostor. Distant = **octahedral
  impostors** (hemi-octahedral variant since trees aren't viewed from below); bake albedo/normal/
  depth into an atlas, nearest-3-view blend removes popping.

## Wind (TSL vertex)

- **Hierarchical model** (GPU Gems 3): rigid chain trunk→branch→leaf, 2–3 nodes deep, noise +
  summed periodic functions, per-branch random phase to desync.
- **Bake as vertex attributes** (all available at build time): branch level/hierarchy index,
  per-branch phase, stiffness/weight (~0 at base → 1 at tips), branch pivot/origin, axis+tangent.
- **TSL:** assign wind to **`material.positionNode`** (keeps auto MVP), not `vertexNode`.
  Blocks: `positionLocal`, `normalLocal`, `attribute('windWeight','float')`, `uniform()` for
  wind dir/strength, **`time`/`deltaTime`** (NOT deprecated `timerLocal`), `sin/cos`, `Fn()`.
  One TSL graph compiles to both WGSL and GLSL → covers WebGPU + WebGL2 fallback.
- Adapt the 3-layer analog (global sway / gust waves / per-blade turbulence) from
  `procedural-grass-threejs`.

## Deterministic RNG

- `Math.random()` is unseedable → unusable. **Pattern:** hash string seed (species + int) with
  **`xmur3`** → seed **`splitmix32`** (or `sfc32`) → thread ONE instance through generation in a
  fixed traversal order (parent before children) so adding features later doesn't shift existing
  species+seed output.
- **Avoid `mulberry32`** — reportedly skips ~⅓ of all 32-bit values. (Note: our placeholder
  currently uses mulberry32 — replace when building the real generator.)

## WebGPU + TSL gotchas (r171–r184)

1. **`await renderer.init()`** before rendering (done in our main.js). `.renderAsync()` for manual.
2. **Import discipline:** `three/webgpu` + `three/tsl`. Mixing bare `'three'` and `'three/webgpu'` breaks things. r171 = production floor.
3. **No raw GLSL** in WebGPU backend — author in TSL (escape hatch `wgslFn()`/`glslFn()`).
4. **Backend fallback can differ silently:** `instancedArray.element(index)` **ignores index on
   WebGL2 fallback** but indexes correctly on WebGPU — test instanced wind/foliage on both backends.
5. **MSAA:** `antialias` defaults to **false** on WebGPU (vs WebGL). Set `true` → 4 samples
   (done in our main.js). Needed for alpha-to-coverage; helps alpha-hash grain.
6. **Ecosystem churn:** pin the three.js version; expect API drift (possible `WebGPURenderer`→`Renderer` rename).
7. **Support (Nov 2025):** ~82% global; keep WebGL2 fallback for mobile/Linux fragmentation.

## Weber-Penn parameter schema (implement this)

Level `n` = 0 (trunk) → 3; `V`-suffix = random variation; angles in degrees.

**Global:** `Shape` (0 conical…8 envelope), `BaseSize` (0.1–0.4 bare trunk frac), `Scale`/`ScaleV`
(height m), `Levels` (3–4), `Ratio` (0.01–0.05 trunk radius/length), `RatioPower` (1–2 child-radius
falloff), `Lobes`/`LobeDepth` (odd ribs 3/5/7 / 0–0.3), `Flare` (0–1 base swell), `0BaseSplits`
(0–4 multi-trunk), `AttractionUp` (−3…+3, + up / − weeping).

**Per-level:** `nLength`/`nLengthV` (0.3–1.0), `nTaper` (0 cyl/1 cone/2 spherical/3 periodic; cactus ~2.2),
`nSegSplits`/`nSplitAngle`/`nSplitAngleV`, `nCurveRes` (3–8 rings/stem), `nCurve`/`nCurveBack`/`nCurveV`
(−90…90; neg CurveV = helix), `nDownAngle`/`nDownAngleV` (20–70 child pitch), `nRotate`/`nRotateV`
(+ spiral ~140° golden / − alternating), `nBranches` (0–60).

**Leaves:** `Leaves` (−20…60; **negative = palm-fan/rosette mode**), `LeafShape` (enum), `LeafScale`/`LeafScaleX`.

**Pruning envelope (optional crown control):** `PruneRatio` (0–1), `PruneWidth`/`PruneWidthPeak`,
`PrunePowerLow`/`PrunePowerHigh` (2 concave / 0.5 convex).

*Note:* the paper's per-species numeric appendix extracted with scrambled columns; pull clean
per-species values from Arbaro's XML (read-only, GPL) rather than trusting scraped cells.
