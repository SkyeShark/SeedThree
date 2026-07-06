// SeedThree headless API — design and grow SeedThree plants programmatically,
// with no dev server, no browser, and (for pure geometry) no GPU. This is a thin
// ADAPTER over the exact same generation code the app runs: it imports the real
// species presets, the real control→param mapping (ui/controls.js), and the real
// buildTree, so a tree grown here is identical to one grown in the UI. Nothing in
// the app is modified; the Vite bundle never imports this file.
//
// It is runtime-agnostic — it runs under Node and under Deno (the eidoverse
// target) unchanged, because SeedThree and eidoverse share the same stack
// (three@0.184 WebGPU + NodeMaterial/TSL) and the same bare specifiers
// (`three/webgpu`, `three/tsl`), which eidoverse's import map already resolves.
//
// Two tiers of use:
//   • GEOMETRY (no GPU): generate() → a THREE.LOD of real branch/leaf geometry.
//     The FULL plant grows (canopy, rosettes, spines) over placeholder 1×1
//     textures fed through the real material factories, so headless stats and
//     bounds match the app exactly. Runs anywhere. Great for agents that want
//     to design shapes, read stats, and round-trip presets.
//   • TEXTURED (needs a real THREE renderer/device, e.g. inside an eidoverse
//     scene): createTree({ loadTexture }) loads the species' PBR maps through an
//     injected loader and builds the app's real bark/leaf/rosette/spine materials.
//     (Baked card/billboard far-LODs additionally need a renderer to render-to-
//     texture — see bakeLODs() note — but a hero tree up close never needs them.)
//
// The design/introspection surface (listSpecies, getSchema, defaultControls,
// toPreset/fromPreset) is what an agent uses to know which knobs exist, set them,
// and hand a `seedthree-preset/1` JSON back to the human to open in the app.

import { SPECIES, DEFAULT_SPECIES } from '../species/index.js';
import {
  controlsFromSpecies, applySpeciesControls, ADVANCED_LEVEL_PARAMS, CROWN_SHAPES,
} from '../ui/controls.js';
import {
  buildTree, makeBarkMaterial, makeCactusBarkMaterial, makeThatchBarkMaterial,
} from '../core/tree.js';
import { makeFoliageMaterial } from '../core/leaf-cards.js';
import { makeYuccaMaterial } from '../core/yucca-leaves.js';
import { makeSpineMaterial } from '../core/cactus-spines.js';
import { generateSkeleton } from '../core/weber-penn.js';
import { generateDichotomous } from '../core/dichotomous.js';
import { Rng } from '../core/rng.js';
import { windStrength, windSpeed } from '../core/wind.js';
import {
  Box3, Vector3, Scene, Mesh, Group, MeshStandardMaterial,
  DataTexture, RGBAFormat, SRGBColorSpace,
} from 'three/webgpu';

export { SPECIES, DEFAULT_SPECIES, CROWN_SHAPES };

const speciesOrThrow = (key) => {
  const sp = SPECIES[key];
  if (!sp) throw new Error(`[seedthree] unknown species "${key}". Known: ${Object.keys(SPECIES).join(', ')}`);
  return sp;
};

// ---- introspection --------------------------------------------------------

/** One-line descriptor per species — the menu an agent picks from. */
export function listSpecies() {
  return Object.entries(SPECIES).map(([key, sp]) => ({
    key, name: sp.name, latin: sp.latin ?? null, biome: sp.biome ?? null,
    foliageType: sp.foliageType ?? 'leaves', cactus: !!sp.cactus,
    generator: sp.foliageType === 'rosette' ? 'dichotomous-lsystem' : 'weber-penn',
  }));
}

function knob(entry, sp, group) {
  const k = { key: entry.key, name: entry.name, group, default: entry.get(sp) };
  if (entry.dropdown) k.options = entry.dropdown;
  else { k.min = entry.min; k.max = entry.max; k.step = entry.step; }
  return k;
}

// The globally-editable controls (not species-specific) that the UI exposes,
// with their UI ranges. Only the ones relevant to the species' type are returned.
function globalKnobs(sp) {
  const rosette = sp.foliageType === 'rosette';
  const cactus = !!sp.cactus;
  const out = [
    { key: 'seed', name: 'Seed', group: 'global', min: 1, max: 9999, step: 1, default: 1 },
    { key: 'showLeaves', name: 'Show leaves', group: 'global', type: 'bool', default: true },
    { key: 'tileWorldSize', name: 'Bark tiling (m)', group: 'global', min: 0.6, max: 3.0, step: 0.05, default: sp.tileWorldSize ?? 1.5 },
    { key: 'barkTint', name: 'Bark tint', group: 'material', type: 'color', default: 0xffffff },
    { key: 'barkFlat', name: 'Bark flat shading', group: 'material', type: 'bool', default: false },
  ];
  if (!rosette) out.push(
    { key: 'leafColorize', name: 'Leaf tint', group: 'material', type: 'color', default: 0xffffff },
    { key: 'leafTintAmount', name: 'Leaf tint amount', group: 'material', min: 0, max: 1, step: 0.01, default: 0 },
    { key: 'leafAngle', name: 'Leaf angle', group: 'material', min: 0, max: 100, step: 1, default: sp.foliage?.downAngle ?? 52 },
    { key: 'leafStart', name: 'Leaf start', group: 'material', min: 0, max: 1, step: 0.01, default: sp.foliage?.startFrac ?? 0.1 },
    { key: 'leafSizeVar', name: 'Leaf size variance', group: 'material', min: 0, max: 1, step: 0.01, default: sp.foliage?.sizeVar ?? 0.3 },
    { key: 'leafAlpha', name: 'Leaf alpha test', group: 'material', min: 0, max: 1, step: 0.01, default: sp.foliage?.alphaTest ?? 0.4 },
    { key: 'leafQuads', name: 'Leaf billboard', group: 'material', options: { 'Single': 1, 'Crossed (double)': 2 }, default: sp.foliage?.quads ?? 2 },
  );
  if (rosette && !cactus) out.push(
    { key: 'frondGreenTint', name: 'Frond green tint', group: 'material', type: 'color', default: 0xffffff },
    { key: 'frondDryTint', name: 'Frond dry tint', group: 'material', type: 'color', default: 0xffffff },
    { key: 'frondDryestTint', name: 'Frond dryest tint', group: 'material', type: 'color', default: 0xffffff },
    { key: 'frondDryness', name: 'Frond dryness', group: 'material', min: 0, max: 1, step: 0.01, default: 0 },
  );
  if (cactus) out.push(
    { key: 'spineTint', name: 'Spine tint', group: 'material', type: 'color', default: 0xffffff },
    { key: 'barkDamage', name: 'Bark damage', group: 'material', min: 0, max: 1, step: 0.01, default: sp.barkDamage ?? 0.35 },
  );
  return out;
}

// The LOD/optimization options buildTree accepts (lodOpts). Card/billboard bakes
// need a renderer; the rest (mesh quality, distances, budgets, density, prune)
// shape the real-geometry LODs and work headless.
export const LOD_OPTIONS = [
  { key: 'meshQuality', name: 'Mesh quality', min: 0.3, max: 1, step: 0.05, default: 1 },
  { key: 'lod1Dist', name: 'LOD1 at (m)', min: 5, max: 80, step: 1, default: 35 },
  { key: 'lod2Dist', name: 'LOD2 at (m)', min: 15, max: 150, step: 1, default: 70 },
  { key: 'billboardDist', name: 'Billboard at (m)', min: 30, max: 300, step: 1, default: 120 },
  { key: 'lod1Pct', name: 'LOD1 budget (%)', min: 15, max: 85, step: 5, default: 50, temperateOnly: true },
  { key: 'lod2Pct', name: 'LOD2 budget (%)', min: 4, max: 40, step: 1, default: 15, temperateOnly: true },
  { key: 'lod1Density', name: 'LOD1 density', min: 0.2, max: 1, step: 0.05, default: 1 },
  { key: 'lod2Density', name: 'LOD2 density', min: 0.2, max: 1, step: 0.05, default: 1 },
  { key: 'lod1Prune', name: 'LOD1 prune', min: 0, max: 0.85, step: 0.05, default: 0, temperateOnly: true },
  { key: 'lod2Prune', name: 'LOD2 prune', min: 0, max: 0.85, step: 0.05, default: 0.35, temperateOnly: true },
  { key: 'mobileTarget', name: 'Mobile performance target', type: 'bool', default: false },
];

/**
 * The full knob vocabulary for a species: exactly what the UI exposes, as data.
 *   shape    — the species' own headline dials (branch density, fork generations…)
 *   advanced — per-level Weber-Penn dials (temperate, as `paramOverrides.<key>.<lvl>`
 *              paths) OR the flat L-system dials (rosette/cactus)
 *   global   — seed / showLeaves / bark tiling
 *   material — live tint/alpha/flat dials (leaf, bark, frond, spine)
 *   lod      — the LOD/optimization options for generate()'s `lod` arg
 */
export function getSchema(speciesKey) {
  const sp = speciesOrThrow(speciesKey);
  const rosette = sp.foliageType === 'rosette';
  const shape = (sp.controls ?? []).map((e) => knob(e, sp, 'shape'));

  let advanced;
  if (rosette) {
    advanced = (sp.advancedControls ?? []).map((e) => knob(e, sp, 'advanced'));
  } else {
    // Temperate: per-level dials written into controls.paramOverrides[key][level].
    const levels = sp.params?.levels ?? 3;
    advanced = [];
    for (const m of ADVANCED_LEVEL_PARAMS) {
      const lo = m.trunk ? 0 : 1;
      for (let lvl = lo; lvl <= levels - 1; lvl++) {
        advanced.push({
          path: `paramOverrides.${m.key}.${lvl}`, name: `${m.name} · L${lvl}`, group: 'advanced',
          min: m.min, max: m.max, step: m.step, default: sp.params?.[m.key]?.[lvl] ?? m.dflt,
        });
      }
    }
    // General growth-force tropism (ez-tree parity).
    advanced.push(
      { key: 'forceDirX', name: 'Force dir X', group: 'advanced', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'forceDirY', name: 'Force dir Y', group: 'advanced', min: -1, max: 1, step: 0.01, default: 1 },
      { key: 'forceDirZ', name: 'Force dir Z', group: 'advanced', min: -1, max: 1, step: 0.01, default: 0 },
      { key: 'forceStrength', name: 'Force strength', group: 'advanced', min: 0, max: 0.12, step: 0.001, default: 0 },
    );
  }

  return {
    species: speciesKey, name: sp.name, latin: sp.latin ?? null, biome: sp.biome ?? null,
    foliageType: sp.foliageType ?? 'leaves', cactus: !!sp.cactus,
    generator: rosette ? 'dichotomous-lsystem' : 'weber-penn',
    shape, advanced, global: globalKnobs(sp),
    lod: LOD_OPTIONS.filter((o) => !o.temperateOnly || !rosette),
  };
}

/** The default control object for a species (identical to a fresh UI load). */
export function defaultControls(speciesKey) {
  return controlsFromSpecies(speciesOrThrow(speciesKey));
}

// ---- describe(): the agent-facing TEXT menu ---------------------------------
// Progressive disclosure, mirroring the app's collapsed panel: the first hit is
// species + SEED (the seed alone gives endless distinct plants — it's the main
// dial), and the granular knobs stay behind named "folders" you open on demand,
// exactly like clicking a section header in the UI. This keeps an agent's first
// contact to one decision instead of eighty.

const fmtKnob = (k) => {
  const id = k.key ?? k.path;
  if (k.options) return `  ${id} — ${k.name}; one of {${Object.entries(k.options).map(([n, v]) => `${n}:${v}`).join(', ')}} (default ${k.default})`;
  if (k.type === 'bool') return `  ${id} — ${k.name}; true|false (default ${k.default})`;
  if (k.type === 'color') return `  ${id} — ${k.name}; hex color (default 0x${(k.default ?? 0xffffff).toString(16)})`;
  return `  ${id} — ${k.name}; ${k.min}..${k.max} step ${k.step} (default ${k.default})`;
};

/**
 * Text menu for agents. Call with no args for the species list; with a species
 * key for its quick-start + folder index; with (species, folder) to open one
 * folder ('shape' | 'advanced' | 'global' | 'material' | 'lod').
 */
export function describe(speciesKey = null, folder = null) {
  if (!speciesKey) {
    const rows = listSpecies().map((s) => `  ${s.key.padEnd(14)} ${s.name}${s.latin ? ` (${s.latin})` : ''} — ${s.biome}, ${s.generator}`);
    return [
      'SeedThree species — pick one, then design by SEED first:',
      ...rows,
      '',
      "Quick start:  generate({ species: 'whiteOak', seed: 1..9999 })",
      'Every seed is a different individual of the species — iterating the seed is',
      'usually all a scene needs. Fine dials exist behind folders:',
      "  describe('<species>')            → that species' quick-start + folder index",
      "  describe('<species>', '<folder>') → open one folder's dials",
    ].join('\n');
  }
  const schema = getSchema(speciesKey);
  const folders = {
    shape: schema.shape, advanced: schema.advanced, global: schema.global.filter((k) => k.group === 'global'),
    material: schema.global.filter((k) => k.group === 'material'), lod: schema.lod,
  };
  if (folder) {
    const knobs = folders[folder];
    if (!knobs) return `Unknown folder "${folder}". Folders: ${Object.keys(folders).join(', ')}`;
    const hint = folder === 'advanced' && schema.generator === 'weber-penn'
      ? '\nPer-level dials are paths: controls.paramOverrides.<param>.<level>, e.g.\n  generate({ species, seed, controls: { paramOverrides: { downAngle: { 1: 50 } } } })'
      : folder === 'lod'
        ? "\nPass these as generate()'s `lod` argument, not inside `controls`."
        : '';
    return [`${schema.name} — ${folder} (${knobs.length} dials):`, ...knobs.map(fmtKnob)].join('\n') + hint;
  }
  const counts = Object.entries(folders).map(([n, arr]) => `${n} (${arr.length})`).join(' · ');
  return [
    `${schema.name}${schema.latin ? ` (${schema.latin})` : ''} — ${schema.biome}, ${schema.generator}.`,
    '',
    `Quick start:  generate({ species: '${speciesKey}', seed: 1..9999 })`,
    'The SEED is the main dial — each one is a different individual. Read the',
    'returned stats (tris, height, width) and re-roll or resize before reaching',
    'for fine dials.',
    '',
    `Closed folders — open with describe('${speciesKey}', '<folder>'):`,
    `  ${counts}`,
  ].join('\n');
}

// Merge a partial control override over the species defaults (deep-merges the one
// nested field, paramOverrides, so setting one per-level dial doesn't wipe others).
function mergeControls(speciesKey, controls = {}, seed) {
  const base = controlsFromSpecies(speciesOrThrow(speciesKey));
  const merged = { ...base, ...controls };
  if (controls.paramOverrides || base.paramOverrides) {
    merged.paramOverrides = { ...(base.paramOverrides || {}) };
    for (const [k, per] of Object.entries(controls.paramOverrides || {})) {
      merged.paramOverrides[k] = { ...(base.paramOverrides?.[k] || {}), ...per };
    }
  }
  if (seed !== undefined) merged.seed = seed;
  return merged;
}

// ---- stats ----------------------------------------------------------------

const geoTris = (g) => {
  const n = g.index ? g.index.count : g.attributes.position.count;
  return n / 3;
};

/** Per-LOD + summary geometry stats for a built THREE.LOD (or any Object3D). */
export function statsOf(group) {
  const perLod = [];
  const levels = group.levels ?? [{ object: group, distance: 0 }];
  for (const lv of levels) {
    let triangles = 0, verts = 0, meshes = 0, instances = 0;
    lv.object.traverse((o) => {
      if (!o.geometry) return;
      meshes++;
      const inst = o.isInstancedMesh ? o.count : 1;
      instances += o.isInstancedMesh ? o.count : 0;
      triangles += geoTris(o.geometry) * inst;
      verts += o.geometry.attributes.position.count;
    });
    perLod.push({
      name: lv.object.userData?.lodName ?? lv.object.name ?? `L${perLod.length}`,
      distance: lv.distance ?? 0, meshes, instances,
      triangles: Math.round(triangles), verts,
      appOnly: !!lv.object.userData?.appOnly, hiddenInApp: !!lv.object.userData?.hiddenInApp,
    });
  }
  let box = null, size = null;
  try {
    const b = new Box3().setFromObject(levels[0].object);
    if (isFinite(b.min.x) && isFinite(b.max.x)) {
      const s = b.getSize(new Vector3());
      box = { min: b.min.toArray(), max: b.max.toArray() };
      size = { widthMeters: +Math.max(s.x, s.z).toFixed(3), heightMeters: +s.y.toFixed(3), depthMeters: +Math.min(s.x, s.z).toFixed(3) };
    }
  } catch { /* Box3 over instanced geometry can throw on some builds — bounds are best-effort */ }
  return {
    summary: { lodCount: perLod.length, ...(size || {}), lod0Triangles: perLod[0]?.triangles ?? 0 },
    perLod, boundingBox: box,
  };
}

/**
 * Raw skeleton for a design (stem/tip counts, levels) — CPU only, no meshing.
 * Uses the SAME rng seed convention as buildTree so counts match the built tree.
 */
export function skeleton({ species, seed = 1, controls = {} } = {}) {
  const sp = speciesOrThrow(species);
  const shaped = applySpeciesControls(sp, mergeControls(species, controls, seed));
  if (sp.foliageType === 'rosette') {
    const skParams = { ...shaped.params, tipClearance: (shaped.foliage?.leafLen ?? 0.5) * 0.9 };
    const { stems, terminalStems } = generateDichotomous(skParams, new Rng(`${sp.name}:${seed}`));
    return { generator: 'dichotomous-lsystem', stems: stems.length, terminals: (terminalStems || []).length };
  }
  const { stems, tips } = generateSkeleton(shaped.params, new Rng(`${sp.name}:${seed}`));
  const byLevel = {};
  for (const s of stems) byLevel[s.level] = (byLevel[s.level] || 0) + 1;
  return { generator: 'weber-penn', stems: stems.length, tips: tips.length, stemsByLevel: byLevel };
}

// ---- generate (geometry, no GPU) ------------------------------------------

/**
 * Grow a plant from a design — real branch + leaf geometry at every LOD, with
 * self-constructed node materials (no textures). Runs with no server and no GPU.
 *
 * @param {object} o
 * @param {string} o.species  species key (see listSpecies)
 * @param {number} [o.seed=1]
 * @param {object} [o.controls]  partial override of the species' controls (see getSchema)
 * @param {object} [o.lod]       lodOpts (see LOD_OPTIONS); card/billboard bakes are skipped headless
 * @param {object} [o.assets]    prebuilt material bag (from buildAssets) — else placeholder materials
 * @param {boolean} [o.placeholders=true]  when no material bag is given, self-supply
 *                  placeholder materials so the FULL plant grows (canopy included)
 *                  and stats match the app. false → bare skeleton (branches only).
 * @returns {{ group: THREE.LOD, stats: object, preset: object, shaped: object }}
 */
export function generate({ species, seed = 1, controls = {}, lod = {}, assets = null, placeholders = true } = {}) {
  const sp = speciesOrThrow(species);
  const merged = mergeControls(species, controls, seed);
  const shaped = applySpeciesControls(sp, merged);
  const bag = assets?.barkMat ? assets : (placeholders ? placeholderAssets(species) : (assets ?? {}));
  const { group } = buildTree(shaped, seed, bag, lod);
  group.userData.species = sp.name;
  return { group, stats: statsOf(group), preset: toPreset({ species, seed, controls: merged }), shaped };
}

// ---- wind -------------------------------------------------------------------

/**
 * All SeedThree materials sway via shared wind uniforms (strength defaults to
 * 0.5, speed to 1.0) — in a live render the trees MOVE by default. Set strength
 * to 0 for a perfectly still plant, or tune the gusts per shot.
 */
export function setWind({ strength, speed } = {}) {
  if (strength !== undefined) windStrength.value = strength;
  if (speed !== undefined) windSpeed.value = speed;
  return { strength: windStrength.value, speed: windSpeed.value };
}

// ---- material composition ---------------------------------------------------

// The material half of main.js loadSpeciesAssets: given a texture bag, build the
// species' real material set (bark/cactus+spine/thatch/rosette/leaf+cluster).
// Shared by buildAssets (real PBR maps) and placeholderAssets (1×1 stand-ins).
function composeMaterials(sp, assets, sunLight = null) {
  if (sp.cactus) {
    assets.barkDamage = sp.barkDamage ?? 0.35;
    assets.barkMat = makeCactusBarkMaterial(assets);
    assets.spineMat = makeSpineMaterial(assets, sunLight);
  } else {
    assets.barkMat = makeBarkMaterial(assets);
  }
  if (sp.thatchBark && assets.thatchTexture) {
    assets.thatchBarkMat = makeThatchBarkMaterial(assets);
  }
  if (!sp.cactus && sp.foliageType === 'rosette') {
    const yucca = makeYuccaMaterial(assets, sp.foliage);
    assets.rosetteMat = yucca.material;
    assets.frondGreenTint = yucca.greenTint; assets.frondDryTint = yucca.dryTint;
    assets.frondDryestTint = yucca.dryestTint; assets.frondDryness = yucca.dryness;
  } else if (!sp.cactus) {
    const leafFol = makeFoliageMaterial(assets, { ...sp.foliage, mode: 'leaves' });
    assets.leafMat = leafFol.material; assets.leafCenter = leafFol.centerUniform;
    assets.leafTintNode = leafFol.tintNode; assets.leafTintAmount = leafFol.tintAmount;
    const clusterFol = makeFoliageMaterial(assets, { ...sp.foliage, mode: 'clusters' });
    assets.clusterMat = clusterFol.material; assets.clusterCenter = clusterFol.centerUniform;
    assets.clusterTintNode = clusterFol.tintNode; assets.clusterTintAmount = clusterFol.tintAmount;
  }
  return assets;
}

// ---- placeholder materials (headless default) -------------------------------

// 1×1 stand-in textures, so the REAL material factories run with no files and no
// GPU. Without them a bare `assets` grows a LEAFLESS skeleton — tree.js only
// builds foliage/rosettes/spines when their material exists (assets.leafMat /
// rosetteMat / spineMat) — and a design loop iterating on those stats would be
// tuning the wrong tree (oak reads 33k tris bare vs the true 56k with canopy).
const px = (rgb, srgb = false) => {
  const t = new DataTexture(new Uint8Array([rgb[0], rgb[1], rgb[2], 255]), 1, 1, RGBAFormat);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
};
const FLAT_NORMAL = [128, 128, 255], ROUGH = [210, 210, 210], TRANS = [130, 130, 130];

/**
 * A full material bag over placeholder textures — the plant renders with flat
 * plausible colors (green canopy, brown/green bark) and, more importantly, its
 * GEOMETRY, STATS, and BOUNDS are identical to the textured tree.
 */
export function placeholderAssets(speciesKey, { sunLight = null } = {}) {
  const sp = speciesOrThrow(speciesKey);
  const barkAlbedo = sp.cactus ? [96, 128, 72] : [110, 86, 62];
  const assets = {
    barkTexture: px(barkAlbedo, true), barkNormal: px(FLAT_NORMAL), barkRoughness: px(ROUGH),
    leafTexture: px([88, 138, 58], true), leafTranslucency: px(TRANS),
    leafNormal: px(FLAT_NORMAL), leafRoughness: px(ROUGH),
    leafDryTexture: px([176, 148, 96], true), leafDryestTexture: px([140, 130, 112], true),
  };
  if (sp.cactus) {
    assets.barkCleanAlbedo = px([104, 140, 80], true);
    assets.barkCleanNormal = px(FLAT_NORMAL); assets.barkCleanRoughness = px(ROUGH);
  }
  if (sp.thatchBark) {
    assets.thatchTexture = px([158, 132, 88], true);
    assets.thatchNormal = px(FLAT_NORMAL); assets.thatchRoughness = px(ROUGH);
  }
  return composeMaterials(sp, assets, sunLight);
}

// ---- textured materials (needs a THREE device, e.g. inside eidoverse) ------

// Filename derivation mirrors main.js loadSpeciesAssets exactly, so the material
// wiring is faithful to the app. `loadTexture(path, { srgb }) => Promise<Texture|null>`
// is injected by the caller (in eidoverse: read the file + globalThis.loadImageTexture).
async function loadMaps(loadTexture, dir, sub, file, extraLinear = []) {
  const base = file.replace(/(_albedo)?\.png$/, '');
  const path = (name) => `${dir}/${sub}/${name}`;
  const opt = (name, srgb) => loadTexture(path(name), { srgb }).catch(() => null);
  const out = {};
  out.albedo = await loadTexture(path(file), { srgb: true }).catch(() => null);
  out.normal = await opt(`${base}_normal.png`, false);
  out.roughness = await opt(`${base}_roughness.png`, false);
  for (const suf of extraLinear) out[suf] = await opt(`${base}_${suf}.png`, false);
  return { base, ...out };
}

/**
 * Build the app's real per-species material bag (bark/leaf/rosette/spine + thatch,
 * cactus clean-skin blend) using an injected texture loader — the headless twin of
 * main.js loadSpeciesAssets. Pass the result as generate({ assets }) or createTree.
 *
 * @param {object} o
 * @param {string} o.species
 * @param {(path:string, opts:{srgb:boolean}) => Promise<Texture|null>} o.loadTexture
 * @param {string} [o.assetsDir='assets']  root of the SeedThree assets/ tree
 * @param {object} [o.sunLight]            optional THREE light (cactus spine self-shadow)
 */
export async function buildAssets({ species, loadTexture, assetsDir = 'assets', sunLight = null } = {}) {
  const sp = speciesOrThrow(species);
  if (typeof loadTexture !== 'function') throw new Error('[seedthree] buildAssets needs a loadTexture(path,{srgb}) function');
  const bark = await loadMaps(loadTexture, assetsDir, 'bark', sp.bark);
  const leaf = await loadMaps(loadTexture, assetsDir, 'leaves', sp.leaf, ['translucency']);
  const leafBase = sp.leaf.replace(/(_albedo)?\.png$/, '');
  const leafDry = await loadTexture(`${assetsDir}/leaves/${leafBase}_dry_albedo.png`, { srgb: true }).catch(() => null);
  const leafDryest = await loadTexture(`${assetsDir}/leaves/${leafBase}_dryest_albedo.png`, { srgb: true }).catch(() => null);

  const assets = {
    barkTexture: bark.albedo, barkNormal: bark.normal, barkRoughness: bark.roughness,
    leafTexture: leaf.albedo, leafTranslucency: leaf.translucency, leafNormal: leaf.normal, leafRoughness: leaf.roughness,
    leafDryTexture: leafDry, leafDryestTexture: leafDryest,
  };

  if (sp.cactus) {
    const cleanBase = bark.base.replace(/_skin$/, '_skin_clean');
    assets.barkCleanAlbedo = await loadTexture(`${assetsDir}/bark/${cleanBase}_albedo.png`, { srgb: true }).catch(() => null);
    assets.barkCleanNormal = await loadTexture(`${assetsDir}/bark/${cleanBase}_normal.png`, { srgb: false }).catch(() => null);
    assets.barkCleanRoughness = await loadTexture(`${assetsDir}/bark/${cleanBase}_roughness.png`, { srgb: false }).catch(() => null);
  }
  if (sp.thatchBark) {
    const th = await loadMaps(loadTexture, assetsDir, 'bark', sp.thatchBark);
    assets.thatchTexture = th.albedo; assets.thatchNormal = th.normal; assets.thatchRoughness = th.roughness;
  }
  return composeMaterials(sp, assets, sunLight);
}

/**
 * One-call textured tree for a live scene (eidoverse): load the species' PBR maps
 * through your loader, build the real materials, grow the plant. Returns the group
 * ready to scene.add(). Pass `level` to get just one LOD's Object3D (the common
 * case for a hero plant — 'LOD0' is full detail).
 */
export async function createTree({ species, seed = 1, controls = {}, lod = {}, loadTexture, assetsDir = 'assets', sunLight = null, level = null } = {}) {
  const assets = loadTexture
    ? await buildAssets({ species, loadTexture, assetsDir, sunLight })
    : placeholderAssets(species, { sunLight });
  const res = generate({ species, seed, controls, lod, assets });
  if (level) {
    const lv = res.group.levels.find((l) => (l.object.userData?.lodName ?? '') === level);
    res.object = lv ? lv.object : res.group.levels[0].object;
  } else {
    res.object = res.group;
  }
  res.assets = assets;
  return res;
}

// ---- presets (app-compatible seedthree-preset/1) --------------------------

/** Serialize a design to the exact JSON the app's Save preset writes. */
export function toPreset({ species, seed = 1, controls = {} }) {
  const merged = mergeControls(species, controls, seed);
  return { format: 'seedthree-preset/1', species, controls: merged };
}

/** Parse an app preset back into { species, seed, controls } (defaults-merged). */
export function fromPreset(preset) {
  if (!preset || !SPECIES[preset.species]) throw new Error(`[seedthree] preset has unknown species "${preset?.species}"`);
  const controls = { ...controlsFromSpecies(SPECIES[preset.species]), ...(preset.controls || {}) };
  return { species: preset.species, seed: controls.seed ?? 1, controls };
}

// ---- GLB export (geometry; for the pure-Node design/handoff path) ---------

// GLTFExporter's binary path needs FileReader, which Node lacks (Deno has it
// natively, so this shim only installs under Node). GLTFExporter listens via
// addEventListener('loadend'), so a bare onload-only shim HANGS — cover both the
// on<event> props and addEventListener for load/loadend/error. Never touches a browser.
function ensureFileReader() {
  if (typeof globalThis.FileReader !== 'undefined') return;
  globalThis.FileReader = class {
    constructor() { this._l = {}; this.result = null; this.error = null; }
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this._l[type] = (this._l[type] || []).filter((f) => f !== fn); }
    _emit(type) { const ev = { target: this, type }; this['on' + type]?.(ev); for (const fn of this._l[type] || []) fn(ev); }
    _read(promise, transform) {
      promise.then((v) => { this.result = transform(v); this._emit('load'); this._emit('loadend'); })
        .catch((e) => { this.error = e; this._emit('error'); this._emit('loadend'); });
    }
    readAsArrayBuffer(blob) { this._read(blob.arrayBuffer(), (b) => b); }
    readAsDataURL(blob) { this._read(blob.arrayBuffer(), (b) => `data:${blob.type};base64,` + Buffer.from(b).toString('base64')); }
  };
}

// Resolve GLTFExporter across runtimes without version-coupling: browser/Vite
// alias `three/addons/…`, Node `three/examples/jsm/…`. Deno's npm import map
// doesn't expose either bare form, so under Deno pass the class as `opts.exporter`
// (`import { GLTFExporter } from 'npm:three@0.184.0/addons/exporters/GLTFExporter.js'`).
async function resolveGLTFExporter(injected) {
  if (injected) return injected;
  for (const spec of ['three/addons/exporters/GLTFExporter.js', 'three/examples/jsm/exporters/GLTFExporter.js']) {
    try { return (await import(spec)).GLTFExporter; } catch { /* try next */ }
  }
  throw new Error('[seedthree] could not resolve GLTFExporter for this runtime — pass exportGLB(obj, { exporter: GLTFExporter })');
}

/**
 * Export an object (from generate().group or a single level) to a .glb ArrayBuffer.
 * Node-focused: materials are swapped to plain MeshStandardMaterial on a throwaway
 * scene so the GLB opens cleanly anywhere (the app's TSL/textured look is a live-
 * render feature, not a glTF one). Returns an ArrayBuffer; the caller writes it.
 * Under Deno, pass the exporter class: exportGLB(obj, { exporter: GLTFExporter }).
 */
export async function exportGLB(object, { binary = true, exporter = null } = {}) {
  ensureFileReader();
  const GLTFExporter = await resolveGLTFExporter(exporter);
  const scene = new Scene();
  const proxyColor = new MeshStandardMaterial({ color: 0x6a7f4f, roughness: 1 });
  const barkColor = new MeshStandardMaterial({ color: 0x6b4f3a, roughness: 1 });
  object.traverse((o) => {
    if (!o.isMesh) return;
    const clone = o.isInstancedMesh
      ? Object.assign(o.clone(), { material: /leaf|card|frond|rosette|spine|cluster/i.test(o.name) ? proxyColor : barkColor })
      : new Mesh(o.geometry, /bark|branch|trunk/i.test(o.name) ? barkColor : proxyColor);
    if (o.isInstancedMesh) { clone.instanceMatrix = o.instanceMatrix; clone.count = o.count; }
    o.updateWorldMatrix(true, false);
    clone.applyMatrix4(o.matrixWorld);
    scene.add(clone);
  });
  const exp = new GLTFExporter();
  return await new Promise((res, rej) => exp.parse(scene, res, rej, { binary }));
}
