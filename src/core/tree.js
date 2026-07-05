// Assemble a renderable tree: skeleton → mesh at several detail levels → THREE.LOD.
// One Weber-Penn skeleton is shared by every level (identical silhouette, no pop);
// levels differ only in cylinder resolution and foliage mode. The far billboard
// level (crossplane impostor) is baked separately and attached in main.js.

import { Group, LOD, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { Rng } from './rng.js';
import { generateSkeleton } from './weber-penn.js';
import { buildBranchGeometry } from './branch-mesh.js';
import { buildFoliage } from './leaf-cards.js';
import { buildCardFoliage } from './branch-cards.js';
import { buildYuccaFoliage } from './yucca-leaves.js';
import { generateDichotomous, buildMergedMesh } from './dichotomous.js';
import { buildCactusSpines } from './cactus-spines.js';

// Dichotomous plants: one stochastic L-system skeleton (shared across LODs),
// meshed as ONE merged tube per level (fewer rings at distance), each tip
// capped by a rosette. No card baking — real geometry with density LOD.
function buildDichotomousTree(species, seed, assets, lodOpts, reuse = null) {
  const speciesSlug = species.name.replace(/\s+/g, '_');
  const skRng = new Rng(`${species.name}:${seed}`);
  // Crown clearance tracks the (live) rosette radius so bigger rosettes push
  // branches further apart automatically.
  const skParams = { ...species.params, tipClearance: (species.foliage?.leafLen ?? 0.5) * 0.9 };
  const { stems, terminalStems } = generateDichotomous(skParams, skRng);

  // Rosette foliage is ~93% of a dichotomous plant's triangles, and each rosette is
  // built from instanced cones — so coneRadialSegs (cone resolution) is the real LOD
  // budget lever, not the bark radialSegs. Coarsening cones 12→8→4 lands LOD1≈40% /
  // LOD2≈15% of LOD0 tris while keeping the rosette COUNT (silhouette) intact.
  const levels = [
    { name: 'LOD0', distance: 0, radialSegs: species.params.radialSegs ?? 10, rosetteDensity: 1, coneRadialSegs: 12 },
    { name: 'LOD1', distance: lodOpts.lod1Dist ?? 35, radialSegs: 6, rosetteDensity: 0.6, coneRadialSegs: 8 },
    { name: 'LOD2', distance: lodOpts.lod2Dist ?? 80, radialSegs: 5, rosetteDensity: 0.35, coneRadialSegs: 4 },
  ];
  if (species.cactus) {
    // A fluted column needs ≥2 radial samples PER RIB or the ribs alias into lumps
    // that read as broken/missing arms with garbage UVs. Keep the ribs resolved at
    // LOD0/1, then drop the fluting entirely (ribDepth 0 = smooth column) at the
    // far LOD where the ribs aren't readable anyway.
    const rc = species.params.ribCount ?? 16;
    levels[0].radialSegs = rc * 4; levels[0].ribDepth = species.params.ribDepth; levels[0].spineDensity = 1;
    levels[1].radialSegs = rc * 2; levels[1].ribDepth = species.params.ribDepth * 0.85; levels[1].spineDensity = 0.5;
    levels[2].radialSegs = Math.max(14, rc); levels[2].ribDepth = 0; levels[2].spineDensity = 0; // ribs gone at range → no spines
  }

  // REUSE: when the SAME rosette species is already on screen, we rewrite the
  // existing meshes' buffers IN PLACE (same LOD, same level Groups, same bark
  // geometry object, same per-cone InstancedMeshes) instead of building new
  // render objects. WebGPU compiles a pipeline PER render object, so reusing the
  // objects skips the heavy SSS/bark recompile that caused the ~0.8s edit freeze.
  const lod = reuse ?? new LOD();
  lod.name = `${species.name} (seed ${seed})`;
  const stats = [];
  for (const [i, lv] of levels.entries()) {
    const level = reuse ? reuse.levels[i].object : new Group();
    if (!reuse) { level.name = `${speciesSlug}_${lv.name}`; level.userData.lodName = lv.name; }

    // Bark cylinders — rewrite the existing geometry's attributes in place on
    // reuse (keeps the Mesh + geometry identity → no recompile), else build fresh
    // and remember the Mesh for next time.
    let branches = level.userData.barkMesh;
    if (reuse && branches) {
      buildMergedMesh(stems, { ...species.params, radialSegs: lv.radialSegs, ribDepth: lv.ribDepth ?? species.params.ribDepth }, branches.geometry);
    } else {
      const geo = buildMergedMesh(stems, { ...species.params, radialSegs: lv.radialSegs, ribDepth: lv.ribDepth ?? species.params.ribDepth });
      branches = new Mesh(geo, assets.barkMat ?? makeBarkMaterial(assets));
      branches.castShadow = true; branches.receiveShadow = true;
      level.add(branches);
      level.userData.barkMesh = branches;
    }

    // Cactus spines: crossed alpha-card areoles marching down every rib crest. The
    // crest anchors come from the bark geometry we just (re)built at THIS LOD's rib
    // resolution, so they always match the flesh. Rewritten in place on reuse.
    if (species.cactus && assets.spineMat) {
      const srng = new Rng(`${species.name}:${seed}:spines${i}`);
      const anchors = branches.geometry.userData.ribCrests || [];
      const spineCfg = { ...(species.spines || {}), density: (lv.spineDensity ?? 1) * (species.spines?.density ?? 1) };
      const reuseSpine = level.userData.spineMesh ?? null;
      const spines = buildCactusSpines(anchors, spineCfg, srng, assets.spineMat, reuseSpine);
      if (spines && !reuseSpine) { level.add(spines); level.userData.spineMesh = spines; }
    }

    let leafInstances = 0;
    if (assets.rosetteMat && species.foliage !== false) {
      const frng = new Rng(`${species.name}:${seed}:rosette${i}`);
      // Pass the persistent foliage Group on reuse so buildYuccaFoliage rewrites
      // its per-cone InstancedMesh buffers in place (setMatrixAt, never swap).
      const reuseFol = level.userData.folGroup ?? null;
      const fol = buildYuccaFoliage(terminalStems, { ...species.foliage, density: lv.rosetteDensity, coneRadialSegs: lv.coneRadialSegs }, frng, assets.rosetteMat, stems, reuseFol);
      if (fol) {
        fol.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; leafInstances += o.count || 0; } });
        if (!reuseFol) { level.add(fol); level.userData.folGroup = fol; }
      }
    }

    if (!reuse) lod.addLevel(level, lv.distance, 0.05);
    stats.push({ name: lv.name, distance: lv.distance, leafInstances });
  }

  lod.position.y = -(species.plantSink ?? 0.2);
  lod.userData = {
    species: species.name, seed,
    stemCount: stems.length, tipCount: terminalStems.length,
    leafInstances: stats[0].leafInstances, levels: stats,
    stems, // retained for debug/inspection (skirt framing checks)
  };
  return { group: lod, stems, tips: terminalStems };
}
import { barkWindPosition, instancedBarkWindPosition } from './wind.js';

// Bark material — created once per species (reused across rebuilds, see buildTree).
export function makeBarkMaterial(assets = {}) {
  const mat = new MeshStandardNodeMaterial({
    map: assets.barkTexture ?? null,
    normalMap: assets.barkNormal ?? null,
    roughnessMap: assets.barkRoughness ?? null,
    color: assets.barkTexture ? 0xffffff : 0x6b5540,
    roughness: assets.barkRoughness ? 1.0 : 0.92,
    metalness: 0.0,
  });
  mat.positionNode = barkWindPosition(); // sway ∝ baked aWind (trunk-stiff → tip-sway)
  return mat;
}

// Forest twin of the bark material: identical look, wind driven by per-slot
// instance attributes (see wind.js). Built EXPLICITLY — NodeMaterial.clone()
// silently drops map/normalMap/roughnessMap, which left instanced branches
// untextured white. Cached per source material and tied to its lifetime, so
// repeated forest rebuilds reuse one compiled pipeline.
const forestBarkMats = new WeakMap();
export function forestBarkMaterial(srcMat) {
  let mat = forestBarkMats.get(srcMat);
  if (mat) return mat;
  mat = new MeshStandardNodeMaterial({
    map: srcMat.map, normalMap: srcMat.normalMap, roughnessMap: srcMat.roughnessMap,
    color: srcMat.color.clone(), roughness: srcMat.roughness, metalness: srcMat.metalness,
  });
  mat.positionNode = instancedBarkWindPosition();
  srcMat.addEventListener('dispose', () => { mat.dispose(); forestBarkMats.delete(srcMat); });
  forestBarkMats.set(srcMat, mat);
  return mat;
}

// Per-level detail recipe. LOD0 = species default foliage (single leaves for
// hero quality); LOD1 swaps to cluster cards (SpeedTree poly reduction) with
// thinner cylinders; LOD2 halves the clusters again over near-minimal geometry.
function lodLevels(species, opts = {}) {
  const f = species.foliage || {};
  const q = opts.meshQuality ?? 1;                     // global quality multiplier
  const leavesOn = (f.leavesPerBranch ?? 1) > 0;       // user "Show leaves" toggle
  const clusters = {
    ...f,
    mode: 'clusters',
    clustersPerBranch: leavesOn ? (f.clustersPerBranch ?? 3) : 0,
  };
  // Per-LOD quality dials (0..1): mesh scales cylinder resolution, density is
  // the leaf/card keepFraction. Fewer instances auto-grow by 1/sqrt(keep) — the
  // SpeedTree "fewer and bigger" trick that preserves canopy volume as they drop.
  // Even ladder: LOD budgets are PERCENT TARGETS of LOD0's triangle count
  // (default 100 / 50 / 15 / billboard, GUI-editable). buildTree solves for
  // them: initial params here, then a corrective branch rebuild against the
  // measured counts.
  const pct1 = (opts.lod1Pct ?? 50) / 100;
  const pct2 = (opts.lod2Pct ?? 15) / 100;
  const keep2 = opts.lod2Density ?? 1;
  // Leaves stay the SAME SIZE across LODs (user wants consistent leaf size, not the
  // SpeedTree "fewer & bigger" enlargement — that made LOD1/LOD2 leaves visibly larger
  // than LOD0). LODs get FEWER leaves, never bigger ones. growFor is now a no-op (1×).
  const growFor = () => 1.0;
  const base = [
    { name: 'LOD0', distance: 0, radialScale: q, ringStride: 1, foliage: f },
    // LOD1 — TRUE GEOMETRY at the pct1 budget: real twigs + real single leaves,
    // fewer and bigger (survivors grow to hold canopy volume). Leaf count scales
    // with the budget; cylinders get budget-corrected in buildTree.
    {
      name: 'LOD1', distance: opts.lod1Dist ?? 35, budgetFrac: pct1,
      radialScale: q * pct1, ringStride: pct1 < 0.3 ? 2 : 1,
      prune: opts.lod1Prune ?? 0, // thinnest twigs vanish WITH their leaves
      foliage: {
        ...f,
        // Look dial: density < 1 = fewer-but-bigger leaves at the SAME budget
        // (the branch solver absorbs the freed triangles).
        leavesPerBranch: leavesOn ? Math.max(1, Math.round((f.leavesPerBranch ?? 14) * pct1 * (opts.lod1Density ?? 1))) : 0,
        size: (f.size ?? 0.55) * growFor(pct1 * (opts.lod1Density ?? 1)),
      },
    },
    // LOD2 — HYBRID at the pct2 budget: baked branch cards for all foliage (see
    // branch-cards.js), but the full twig skeleton stays as thin cylinders so
    // the silhouette keeps real structure; thinnest twigs prune first. The
    // cluster-spray foliage config is the fallback when no bakes exist.
    {
      name: 'LOD2', distance: opts.lod2Dist ?? 70, budgetFrac: pct2,
      radialScale: Math.min(1, q * pct2 * 2.4), ringStride: 2, // ×2.4 offsets stride-2 halving
      keepTwigs: true,
      prune: opts.lod2Prune ?? 0.35, // fraction of thinnest twigs dropped
      foliage: clusters,
      cards: { growScale: growFor(keep2), keepFraction: keep2 },
    },
  ];
  if (!opts.mobileTarget) return base;
  // MOBILE PERFORMANCE TARGET: keep the FULL desktop ladder intact — LOD0 (mesh)
  // and LOD1 (mesh) are still built exactly the same (they're the bake source and
  // what Shape/Foliage/Advanced edit), but flagged hiddenInApp so the app never
  // renders them. LOD2's baked cards become the visible near LOD (distance 0).
  // Then two cheaper card levels (appOnly — not exported) are appended. The whole
  // point of the LOD1/LOD2 sliders in mobile mode is to tune THESE two extras, so
  // they retarget cleanly across ALL four attributes (distance/budget/density/
  // prune) and the visible near LOD is DECOUPLED from them:
  //   near LOD (app-labelled LOD0) = fixed reference model (not slider-driven)
  //   'LOD1 …' sliders → extra card LOD #1 (internal LOD3, app-labelled LOD1)
  //   'LOD2 …' sliders → extra card LOD #2 (internal LOD4, app-labelled LOD2)
  //   'Billboard at (m)' → the billboard (unchanged)
  // (Rosettes have no branch cards → buildDichotomousTree ignores mobileTarget.)
  const NEAR_BUDGET = 0.15; // fixed budget frac for the reference near model
  base[0].hiddenInApp = true;
  base[1].hiddenInApp = true;
  // Near visible LOD = the reference mobile model: full-density cards over the
  // thinned twig skeleton, at a FIXED budget/prune so the LOD1/LOD2 sliders no
  // longer bleed into it (that was the mis-targeting — the desktop LOD2 recipe
  // read lod2Pct/lod2Density/lod2Prune).
  base[2].distance = 0;
  base[2].budgetFrac = NEAR_BUDGET;
  base[2].prune = 0.35;
  base[2].cards = { growScale: growFor(1), keepFraction: 1 };
  const q2 = Math.min(1, q * pct2 * 2.4);
  // One cheaper card level. budget% × density scales the branch budget as a
  // fraction of the near model; keepMul is the baseline card thinning per level.
  const extraCard = (name, dist, pct, density, prune, keepMul, stride) => ({
    name, distance: dist, prune, keepTwigs: true, appOnly: true,
    budgetFrac: Math.max(0.02, (pct / 100) * density * NEAR_BUDGET),
    radialScale: Math.min(1, q2 * keepMul), ringStride: stride,
    foliage: clusters,
    cards: { growScale: growFor(keepMul * density), keepFraction: keepMul * density },
  });
  base.push(extraCard('LOD3', opts.lod1Dist ?? 35, opts.lod1Pct ?? 50, opts.lod1Density ?? 1, opts.lod1Prune ?? 0, 0.6, 3));
  base.push(extraCard('LOD4', opts.lod2Dist ?? 70, opts.lod2Pct ?? 15, opts.lod2Density ?? 1, opts.lod2Prune ?? 0.35, 0.35, 4));
  return base;
}

/**
 * @param {object} species  a species preset ({ name, params, ... })
 * @param {string|number} seed
 * @param {object} assets   cached textures + materials from loadSpeciesAssets
 * @param {object} lodOpts  { lod1Dist, lod2Dist, meshQuality }
 * @returns {{ group: LOD, stems: Array, tips: Array }}
 */
export function buildTree(species, seed, assets = {}, lodOpts = {}, reuse = null) {
  // Dichotomous/rosette plants (Joshua tree, yuccas, saguaro) use their own
  // from-scratch generator — see docs/dichotomous-generator.md. `reuse` (an
  // existing same-species LOD) rewrites its meshes in place to dodge the WebGPU
  // per-render-object pipeline recompile (the edit freeze). Oak path ignores it.
  if (species.foliageType === 'rosette') return buildDichotomousTree(species, seed, assets, lodOpts, reuse);

  const rng = new Rng(`${species.name}:${seed}`);
  const { stems, tips } = generateSkeleton(species.params, rng);
  const terminalStems = stems.filter((s) => s.level === s.maxLevel);
  const barkMat = assets.barkMat ?? makeBarkMaterial(assets);

  const lod = new LOD();
  lod.name = `${species.name} (seed ${seed})`;
  const speciesSlug = species.name.replace(/\s+/g, '_');
  const levelStats = [];

  const leavesOn = species.foliage !== false && (species.foliage?.leavesPerBranch ?? 1) > 0;
  const geoTris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  let total0 = 0; // LOD0 triangle count — the reference the percent budgets solve against
  for (const [i, lv] of lodLevels(species, lodOpts).entries()) {
    const level = new Group();
    // _LOD-suffix naming: Unity/Unreal auto-detect these on import.
    level.name = `${speciesSlug}_${lv.name}`;
    level.userData.lodName = lv.name;
    level.userData.hiddenInApp = !!lv.hiddenInApp; // mobile: mesh LODs kept but never rendered
    level.userData.appOnly = !!lv.appOnly;         // mobile: extra card LODs, not exported

    // Baked branch cards replace terminal twig foliage; unless the level keeps
    // its twig skeleton (keepTwigs — the hybrid look), the terminal cylinders
    // drop out of the branch mesh too. Rosette species keep real geometry at
    // every level (LOD via density) — the card bake assumes the leaf grammar.
    const useCards = !!(lv.cards && lodOpts.branchCards && leavesOn) && species.foliageType !== 'rosette';
    let meshStems = useCards && !lv.keepTwigs ? stems.filter((s) => s.level < s.maxLevel) : stems;
    let levelTerminals = terminalStems;
    if (lv.prune > 0) {
      // SpeedTree-style branch removal: the thinnest branches of the deepest
      // remaining level vanish first, and their FOLIAGE goes with them — real
      // leaves AND baked cards. (Cards used to stay put, but the twig cylinders
      // are subpixel at LOD2 distance, so the prune dial visibly did NOTHING;
      // the cards ARE the canopy at that range.)
      const deepest = Math.max(...meshStems.map((s) => s.level));
      if (deepest > 0) {
        const candidates = meshStems.filter((s) => s.level === deepest)
          .sort((a, b) => a.radii[0] - b.radii[0]);
        const drop = new Set(candidates.slice(0, Math.floor(candidates.length * lv.prune)));
        meshStems = meshStems.filter((s) => !drop.has(s));
        levelTerminals = levelTerminals.filter((s) => !drop.has(s));
      }
    }
    // Foliage FIRST — its triangle count feeds the branch budget solver.
    let foliage = null;
    let leafInstances = 0;
    if (useCards) {
      const frng = new Rng(`${species.name}:${seed}:cards${i}`);
      foliage = buildCardFoliage(levelTerminals, lodOpts.branchCards, frng, lv.cards);
      if (foliage) leafInstances = foliage.children.reduce((n, c) => n + c.count, 0);
    } else if (species.foliageType === 'rosette' && species.foliage !== false) {
      if (assets.rosetteMat) {
        const frng = new Rng(`${species.name}:${seed}:foliage${i}`);
        // LOD via ring density: survivors keep their size, rings thin out.
        const density = lv.budgetFrac ? Math.max(0.25, lv.budgetFrac) : 1;
        foliage = buildYuccaFoliage(levelTerminals, { ...species.foliage, density }, frng, assets.rosetteMat, meshStems);
        if (foliage) leafInstances = foliage.children.reduce((n, c) => n + c.count, 0);
      }
    } else if (species.foliage !== false) {
      const cfg = lv.foliage;
      const fMat = cfg.mode === 'clusters' ? assets.clusterMat : assets.leafMat;
      const fCenter = cfg.mode === 'clusters' ? assets.clusterCenter : assets.leafCenter;
      if (fMat) {
        // Fresh per-level rng → leaf placement is deterministic per (species, seed, level).
        const frng = new Rng(`${species.name}:${seed}:foliage${i}`);
        foliage = buildFoliage(levelTerminals, cfg, frng, fMat, fCenter);
        if (foliage) leafInstances = foliage.count;
      }
    }
    let folTris = 0;
    if (foliage) {
      foliage.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        folTris += geoTris(o.geometry) * (o.isInstancedMesh ? o.count : 1);
      });
      level.add(foliage);
    }

    // Branch cylinders, budget-solved: build with the initial estimate, measure,
    // and rebuild once with a corrected radialScale so the level lands on its
    // percent target (radial segments scale triangle count ~linearly).
    const gopts = {
      tileWorldSize: species.tileWorldSize ?? 1.5,
      radialScale: lv.radialScale,
      ringStride: lv.ringStride,
    };
    let geo = buildBranchGeometry(meshStems, gopts);
    if (lv.budgetFrac && total0 > 0) {
      const targetBranch = Math.max(100, total0 * lv.budgetFrac - folTris);
      const tris = geoTris(geo);
      const corrected = Math.min(1, Math.max(0.1, lv.radialScale * (targetBranch / Math.max(tris, 1))));
      if (tris > 0 && Math.abs(corrected - lv.radialScale) / lv.radialScale > 0.08) {
        geo.dispose();
        geo = buildBranchGeometry(meshStems, { ...gopts, radialScale: corrected });
      }
    }
    geo.computeBoundingBox();
    const branches = new Mesh(geo, barkMat);
    branches.castShadow = true;
    branches.receiveShadow = true;
    level.add(branches);
    if (i === 0) total0 = geoTris(geo) + folTris; // budget reference for LOD1+

    lod.addLevel(level, lv.distance, 0.05); // 5% hysteresis against boundary flicker
    levelStats.push({ name: lv.name, distance: lv.distance, leafInstances });
  }

  // Plant the trunk base (local origin) into the ground. Anchoring at the origin
  // (not the bbox min) avoids a drooping low limb lifting the whole tree off the
  // terrain. A small sink guarantees contact with the flat central ground.
  lod.position.y = -(species.plantSink ?? 0.2);

  lod.userData = {
    species: species.name, seed,
    stemCount: stems.length, tipCount: tips.length,
    leafInstances: levelStats[0]?.leafInstances ?? 0,
    levels: levelStats,
  };

  return { group: lod, stems, tips };
}
