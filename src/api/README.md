# SeedThree headless API

Design and grow SeedThree plants **programmatically — no dev server, no browser,
and (for pure geometry) no GPU**. This is a thin adapter over the exact code the
app runs (same species presets, same control→param mapping, same `buildTree`), so
a tree grown here is identical to one grown in the UI.

It is **purely additive**: nothing in the app is modified and the Vite bundle
never imports it. It is **runtime-agnostic** — Node and Deno, unchanged.

Entry point: [`src/api/seedthree.js`](./seedthree.js).

**Proven end-to-end:** a textured white oak + saguaro grown through this API were
rendered by eidoverse's Deno WebGPU engine (`eido.py render --probe`) — see
[`example-eidoverse-scene.js`](./example-eidoverse-scene.js).

---

## Agent quick start — the seed IS the design

Don't start from the eighty dials. Start from the seed:

```js
import { generate, describe } from './seedthree.js';

const { group, stats } = generate({ species: 'whiteOak', seed: 1737 });
// stats.summary → { lod0Triangles, heightMeters, widthMeters, ... }
```

Every seed is a different individual of the species. Iterating the seed and
reading the returned stats is usually the whole design loop. The granular knobs
exist, but they're behind **text folders** you open on demand — the same
progressive disclosure as the app's collapsed panel, so first contact is one
decision, not eighty:

```js
describe()                        // species menu + this quick-start
describe('joshuaTree')            // that species' one-paragraph brief + folder index
describe('joshuaTree', 'shape')   // open ONE folder: each dial with range/default
// folders: shape · advanced · global · material · lod
```

Then set only what the shot needs:

```js
generate({ species: 'whiteOak', seed: 1737, controls: { height: 22 } });
```

(`getSchema(key)` still returns the full vocabulary as JSON for tooling that
wants everything at once.)

---

## Why it exists — eidoverse integration

eidoverse renders three.js videos headlessly in Deno on the GPU (WebGPU +
NodeMaterial/TSL). SeedThree is the **same stack** — three@0.184, the same bare
specifiers (`three/webgpu`, `three/tsl`) eidoverse's import map already resolves
— so a SeedThree `THREE.Group` **is** an eidoverse `THREE.*` object and drops
straight into a scene:

```js
// Inside an eidoverse scene script (engine eval()s it → import by absolute file URL):
const SEEDTHREE_URL = new URL('../SeedThree/', `file:///${Deno.cwd().replaceAll('\\', '/')}/`).href;
const st = await import(`${SEEDTHREE_URL}src/api/seedthree.js`);

const loadTexture = async (path, { srgb }) =>
    globalThis.loadImageTexture(await Deno.readFile(path), { srgb });

const { object, stats } = await st.createTree({
    species: 'whiteOak', seed: 42,
    loadTexture, assetsDir: '../SeedThree/assets',
    sunLight: sun, level: 'LOD0',
});
scene.add(object);
```

### Verified eidoverse gotchas

- **Set `globalThis._noAutoFixPlacement = true` in `setup()`.** The engine's
  post-setup clipping audit auto-separates "intersecting" meshes; a tree is
  intentionally-overlapping geometry, so the audit dismembers it (scattered
  limbs/rosettes). Warn-only mode leaves the plants whole.
- **Import by absolute file URL** (above) — the engine eval()s scene scripts, so
  a relative dynamic `import()` resolves against the engine's URL, not your work
  folder. `Deno.readFile` keeps plain relative paths (cwd = repo root).
- **Shadows work — but never judge them from frame 1.** A modified shadow-camera
  frustum settles one frame late (known eidoverse first-frame wonk), so a
  single-frame `--probe` of a shadowed scene shows all receivers black while
  frame 2+ of a real render is perfect (verified: full canopy shadows +
  self-shadowing at frame 45 with the app's 4096-map/bias config). Evaluate
  shadowed scenes from a later frame.
- **Trees sway by default** (`windStrength` 0.5). `st.setWind({ strength, speed })`
  tunes or stills them.

---

## Two tiers

| | needs | gives |
|---|---|---|
| **Geometry** — `generate()` | nothing (Node or Deno, no GPU) | a `THREE.LOD` of the FULL plant — canopy, rosettes, spines — over placeholder materials; stats **identical to the app** |
| **Textured** — `createTree({ loadTexture })` | a live THREE device (e.g. inside an eidoverse scene) | the app's real bark/leaf/rosette/spine materials from the species' PBR maps |

Headless `generate()` self-supplies **placeholder 1×1 textures** through the real
material factories, so the whole plant grows and headless stats/bounds match the
app exactly (bare `{}` used to grow a leafless skeleton — misleading numbers).
Pass `placeholders: false` for a branches-only skeleton. The GPU-baked far-LODs
(branch cards, billboard) render-to-texture and are skipped headless; real-geometry
LOD0/1/2 are always present.

## Stats

```js
stats.summary   // { lodCount, widthMeters, heightMeters, depthMeters, lod0Triangles }
stats.perLod    // [{ name, distance, meshes, instances, triangles, verts }]
stats.boundingBox
```

## Presets — round-trip with the app

`toPreset`/`fromPreset` speak the exact `seedthree-preset/1` JSON the app's
**Save / Load** panel uses — a headless-designed tree opens in the UI (📂 Load):

```js
const preset = toPreset({ species: 'joshuaTree', seed: 7, controls: { forkGenerations: 6 } });
await Deno.writeTextFile('tree.seedthree.json', JSON.stringify(preset, null, 2));
```

## GLB export (geometry)

Materials are swapped to plain standard materials so the GLB opens anywhere (the
TSL/textured look is a live-render feature). Node resolves the exporter itself;
Deno's import map has no bare specifier for it, so pass the class:

```js
// Node:
const buf = await exportGLB(group);
// Deno:
import { GLTFExporter } from 'npm:three@0.184.0/addons/exporters/GLTFExporter.js';
const buf = await exportGLB(group, { exporter: GLTFExporter });
await Deno.writeFile('tree.glb', new Uint8Array(buf));
```

---

## API reference

| export | returns |
|---|---|
| `describe(species?, folder?)` | **text menu** — start here (progressive disclosure) |
| `generate({species,seed,controls,lod,assets,placeholders})` | `{ group, stats, preset, shaped }` |
| `createTree({…,loadTexture,assetsDir,sunLight,level})` | `{ object, group, stats, assets }` (async) |
| `setWind({strength,speed})` | current wind values |
| `listSpecies()` | species descriptors (JSON) |
| `getSchema(key)` | full knob vocabulary (JSON) |
| `defaultControls(key)` | default control object |
| `skeleton({species,seed,controls})` | stem/tip counts (no meshing) |
| `placeholderAssets(key,{sunLight})` | placeholder material bag |
| `buildAssets({species,loadTexture,assetsDir,sunLight})` | textured material bag (async) |
| `statsOf(group)` | per-LOD + summary stats |
| `toPreset(...)` / `fromPreset(preset)` | preset ⇄ design |
| `exportGLB(object,{binary,exporter})` | glb ArrayBuffer (async) |
| `SPECIES`, `DEFAULT_SPECIES`, `CROWN_SHAPES`, `LOD_OPTIONS` | constants |

The `loadTexture` contract is `(path, { srgb }) => Promise<THREE.Texture|null>`;
return `null` for a missing optional map (the material factories handle it).
