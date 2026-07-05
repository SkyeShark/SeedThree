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
  // LOD sliders wired to the rosette/cactus path (regular, non-mobile):
  //  • meshQuality  → global cone/rib DETAIL multiplier (the real tri lever — cones
  //    are ~93% of a dichotomous plant's triangles, so coneRadialSegs is the budget).
  //  • lod1/lod2Density → per-LOD ROSETTE density (Joshua/yucca) and SPINE density
  //    (saguaro), MULTIPLYING the defaults so density=1 keeps the current look.
  //  • lod1/lod2Dist → switch distances. (budget%/prune don't apply — no branch cards.)
  const q = Math.max(0.35, lodOpts.meshQuality ?? 1);
  const d1 = lodOpts.lod1Density ?? 1, d2 = lodOpts.lod2Density ?? 1;
  const cs = (base) => Math.max(3, Math.round(base * q)); // per-LOD cone (rosette) detail
  const rs = (base) => Math.max(4, Math.round(base * q)); // per-LOD tube (branch/trunk) radial detail — the Mesh-detail slider
  const levels = [
    { name: 'LOD0', distance: 0, radialSegs: rs(species.params.radialSegs ?? 10), rosetteDensity: 1, coneRadialSegs: cs(12) },
    { name: 'LOD1', distance: lodOpts.lod1Dist ?? 35, radialSegs: rs(6), rosetteDensity: 0.6 * d1, coneRadialSegs: cs(8) },
    { name: 'LOD2', distance: lodOpts.lod2Dist ?? 80, radialSegs: rs(5), rosetteDensity: 0.35 * d2, coneRadialSegs: cs(4) },
  ];
  if (species.cactus) {
    // A fluted column needs ≥2 radial samples PER RIB or the ribs alias into lumps
    // that read as broken/missing arms with garbage UVs. Keep the ribs resolved at
    // LOD0/1, then drop the fluting entirely (ribDepth 0 = smooth column) at the
    // far LOD where the ribs aren't readable anyway. The density sliders thin spines.
    const rc = species.params.ribCount ?? 16;
    levels[0].radialSegs = rc * 4; levels[0].ribDepth = species.params.ribDepth; levels[0].spineDensity = 1;
    levels[1].radialSegs = rc * 2; levels[1].ribDepth = species.params.ribDepth * 0.85; levels[1].spineDensity = 0.5 * d1;
    levels[2].radialSegs = Math.max(14, rc); levels[2].ribDepth = 0; levels[2].spineDensity = 0; // ribs gone at range → no spines
  }

  // MOBILE PERFORMANCE TARGET: park the full-detail cone levels (LOD0/LOD1 stay built
  // as the billboard-bake source + what the dials edit, but never render) and promote
  // a lighter "mobile near" LOD2 — MEDIUM cone/rib detail + a fuller bottom-up-thinned
  // skirt — to the near view, then the billboard. Far fewer tris up close while still
  // reading as the plant. applyLodMobile() parks the hiddenInApp levels + sets LOD2→
  // near (distance 0) and BB→billboardDist. (The forest instances are already
  // billboards, so the hero's cone draw-calls are the only near cost — acceptable.)
  if (lodOpts.mobileTarget) {
    levels[0].hiddenInApp = true;
    levels[1].hiddenInApp = true;
    if (species.cactus) {
      levels[2].radialSegs = (species.params.ribCount ?? 16) * 2;
      levels[2].ribDepth = species.params.ribDepth * 0.85;
      levels[2].spineDensity = 0.5 * d2; // keep ribs + spines on the near mobile column
    } else {
      // ROSETTE MOBILE LADDER (parity with the temperate card ladder). The dead-leaf
      // SKIRT — the bulk of the triangles — is BAKED into a thatch bark texture on the
      // tube (skirtToBark → skirt geometry dropped, tube uses assets.thatchBarkMat).
      // The green crown stays as cones, coarsened per level. Two extra cheap levels
      // (LOD3/LOD4, appOnly) slot into the LOD1/LOD2 slider positions via applyLodMobile.
      // Crown stays as cones but MUCH lighter than the hero: density < 1 → a single
      // (not double) blade copy, and coarser cones per level. (rosetteDensity>=1 doubles
      // the crown for hero alpha-gap fill — unneeded on mobile.) Skirt is gone (bark).
      levels[2].skirtToBark = true; levels[2].thatchBark = true;
      levels[2].radialSegs = 6; levels[2].coneRadialSegs = cs(6); levels[2].rosetteDensity = 0.9;
      levels.push({ name: 'LOD3', distance: lodOpts.lod1Dist ?? 35, appOnly: true, skirtToBark: true, thatchBark: true, radialSegs: 5, coneRadialSegs: cs(4), rosetteDensity: 0.6 * d1 });
      levels.push({ name: 'LOD4', distance: lodOpts.lod2Dist ?? 70, appOnly: true, skirtToBark: true, thatchBark: true, radialSegs: 5, coneRadialSegs: cs(3), rosetteDensity: 0.35 * d2 });
    }
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
    // Match the reused level by NAME, not array index: applyLodMobile SORTS reuse.levels
    // by distance (and the billboard is interleaved into the array), so reuse.levels[i]
    // no longer lines up with build-order levels[i]. Index-based reuse scrambled the
    // hiddenInApp/appOnly flags + geometry across the wrong level Groups — the
    // nondeterministic mobile-LOD breakage. Name-matching is order-independent.
    const level = (reuse && reuse.levels.find((l) => l.object.userData?.lodName === lv.name)?.object) || new Group();
    if (!level.userData.lodName) { level.name = `${speciesSlug}_${lv.name}`; level.userData.lodName = lv.name; }
    level.userData.hiddenInApp = !!lv.hiddenInApp; // mobile: parked by applyLodMobile (set even on reuse so toggling works)
    level.userData.appOnly = !!lv.appOnly;         // LOD3/LOD4 mobile extras — not exported to GLB

    // Bark cylinders — rewrite the existing geometry's attributes in place on
    // reuse (keeps the Mesh + geometry identity → no recompile), else build fresh
    // and remember the Mesh for next time. Thatch levels (reduced/mobile) use the
    // dead-leaf bark so the skirt reads as cladding once its cone geometry is dropped.
    const barkMat = (lv.thatchBark && assets.thatchBarkMat) ? assets.thatchBarkMat : (assets.barkMat ?? makeBarkMaterial(assets));
    let branches = level.userData.barkMesh;
    if (reuse && branches) {
      buildMergedMesh(stems, { ...species.params, radialSegs: lv.radialSegs, ribDepth: lv.ribDepth ?? species.params.ribDepth }, branches.geometry);
    } else {
      const geo = buildMergedMesh(stems, { ...species.params, radialSegs: lv.radialSegs, ribDepth: lv.ribDepth ?? species.params.ribDepth });
      branches = new Mesh(geo, barkMat);
      branches.castShadow = true; branches.receiveShadow = true;
      level.add(branches);
      level.userData.barkMesh = branches;
    }

    // Cactus spines: crossed alpha-card areoles marching down every rib crest. The
    // crest anchors come from the bark geometry we just (re)built at THIS LOD's rib
    // resolution, so they always match the bark. Rewritten in place on reuse.
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
      const fol = buildYuccaFoliage(terminalStems, { ...species.foliage, density: lv.rosetteDensity, coneRadialSegs: lv.coneRadialSegs, skirtToBark: lv.skirtToBark }, frng, assets.rosetteMat, stems, reuseFol);
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
    mobileBuilt: !!lodOpts.mobileTarget, // reuse only when the mobile state matches (LOD distances differ)
    stemCount: stems.length, tipCount: terminalStems.length,
    leafInstances: stats[0].leafInstances, levels: stats,
    stems, // retained for debug/inspection (skirt framing checks)
  };
  return { group: lod, stems, tips: terminalStems };
}
import { barkWindPosition, instancedBarkWindPosition } from './wind.js';
import { texture, mix, smoothstep, positionWorld, uniform, float, vec3 } from 'three/tsl';
import { mx_fractal_noise_float } from 'three/tsl';

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

// Thatch bark (reduced/mobile LODs where the skirt geometry is dropped) — a LAYERED
// blend so we don't lose real bark where it belongs: the dead-leaf THATCH clads the
// branches up top (where the skirt actually is), blending down to bare trunk BARK on
// the lower trunk. Mask = world height (Joshua's branches sit above the first fork; the
// lower trunk stays bare). Albedo + roughness blend; thatch normal carries the leaf
// bumps. Falls back to plain thatch/bark if a map is missing.
export function makeThatchBarkMaterial(assets = {}) {
  if (!assets.thatchTexture || !assets.barkTexture) return makeBarkMaterial({ ...assets, barkTexture: assets.thatchTexture ?? assets.barkTexture, barkNormal: assets.thatchNormal ?? assets.barkNormal, barkRoughness: assets.thatchRoughness ?? assets.barkRoughness });
  const mat = new MeshStandardNodeMaterial({
    map: assets.thatchTexture, normalMap: assets.thatchNormal ?? assets.barkNormal ?? null,
    roughnessMap: assets.thatchRoughness ?? assets.barkRoughness ?? null, roughness: 1, metalness: 0,
  });
  const barkC = texture(assets.barkTexture), thatchC = texture(assets.thatchTexture);
  const barkR = texture(assets.barkRoughness ?? assets.thatchRoughness), thatchR = texture(assets.thatchRoughness ?? assets.barkRoughness);
  const loY = uniform(assets.thatchLoY ?? 0.6), hiY = uniform(assets.thatchHiY ?? 1.5);
  const m = smoothstep(loY, hiY, positionWorld.y); // 0 low (bark) → 1 high (thatch)
  mat.colorNode = mix(barkC.rgb, thatchC.rgb, m);
  mat.roughnessNode = mix(barkR.r, thatchR.r, m);
  mat.positionNode = barkWindPosition();
  return mat;
}

// Saguaro bark — a CLEAN base skin (Codex "undamaged" variant) with real photo
// damage (scars/blotches) blended IN only where a low-frequency, WORLD-space noise
// mask says so. Two wins from one trick:
//   • On a single tall column the damage no longer tiles vertically (the 1K damage
//     tile used to repeat every ~1 m → obvious stacking). The mask period is ~2 m,
//     so a 6 m cactus shows only a couple of damage zones at non-repeating heights.
//   • Forest instances sit at different world positions → each samples a different
//     slice of the noise field → free per-plant variety, no instance attribute.
// Clean & damaged albedo/roughness are co-registered in UV (the clean was Codex-
// seeded from the damaged), so the mix is clean skin ↔ scarred skin at the same
// texel. Normal uses the clean map throughout (its scar bumps tiled too). The
// `damage` uniform (0 pristine … 1 heavy) is the user dial; `seed` offsets the
// noise so successive generations differ. Falls back to plain bark if no clean set.
export function makeCactusBarkMaterial(assets = {}) {
  if (!assets.barkCleanAlbedo || !assets.barkTexture) return makeBarkMaterial(assets);
  const damage = uniform(assets.barkDamage ?? 0.35);
  const seed = uniform(vec3(0, 0, 0));
  const freq = uniform(0.55); // world-space noise frequency (period ≈ 1/freq metres)
  const mat = new MeshStandardNodeMaterial({
    // .map/.roughnessMap kept as the DAMAGED set so the forest twin
    // (forestBarkMaterial, which only copies map/normalMap/roughnessMap) still
    // renders textured; the hero overrides them with the blend nodes below.
    map: assets.barkTexture,
    normalMap: assets.barkCleanNormal ?? assets.barkNormal ?? null,
    roughnessMap: assets.barkRoughness ?? null,
    metalness: 0.0,
  });
  const tint = uniform(vec3(1, 1, 1)); // Bark-tint dial (multiplies the blended bark)
  const clnA = texture(assets.barkCleanAlbedo);
  const dmgA = texture(assets.barkTexture);
  const clnR = texture(assets.barkCleanRoughness ?? assets.barkRoughness);
  const dmgR = texture(assets.barkRoughness);
  // Fractal value noise in world space → [0,1]. 3 octaves gives soft blotch edges.
  const n = mx_fractal_noise_float(positionWorld.mul(freq).add(seed), 3, 2.0, 0.5, 1.0);
  const m = n.mul(0.5).add(0.5);
  // coverage: damage=0 → threshold above the noise range (pristine); damage=1 →
  // below it (fully scarred). 0.18 half-width = a soft fade at every patch edge.
  const t = mix(float(1.08), float(-0.08), damage);
  const d = smoothstep(t.sub(0.18), t.add(0.18), m);
  mat.colorNode = mix(clnA.rgb, dmgA.rgb, d).mul(tint);
  mat.roughnessNode = mix(clnR.r, dmgR.r, d);
  mat.positionNode = barkWindPosition();
  mat.userData.barkDamage = damage; // GUI "Bark damage" dial writes .value
  mat.userData.barkSeed = seed;
  mat.userData.barkTint = tint;     // Bark-tint dial writes .value (linear)
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
  // (Rosette species build their own mobile ladder in buildDichotomousTree.)
  base[0].hiddenInApp = true;
  base[1].hiddenInApp = true;
  // MOBILE LADDER = the impostor CURVE: each rung down bakes a BIGGER slice of the
  // tree into each card and DELETES the geometry that slice replaces. The near LOD
  // is the hybrid reference — full twig skeleton + per-twig cards. LOD3 collapses
  // each level-(maxL-1) limb (branch + its twigs + leaves) into ONE card; LOD4
  // collapses a level higher. Real geometry recedes toward the trunk while cards
  // get FEWER and LARGER — so both tris and instances step down for real, and the
  // last hop to the 2-card billboard is a short one. meshQuality (the Twig/skeleton
  // quality slider) scales the facets of whatever real tubes each rung keeps.
  // Budget solver stays OFF (its radialScale correction floors at seg=3 and
  // collapsed levels to the same count) — the steps are EXPLICIT and predictable.
  const maxL = (species.params?.levels ?? 3) - 1;
  // rung: cardLevel = branch level that roots each card; keepTwigs = keep the real
  // tubes at/below cardLevel (hybrid) vs DELETE them (collapse). Each rung is a
  // DISTINCT step so the ramp is real:
  //   LOD2 (near, dist 0)  — real twigs + FOLIAGE-ONLY per-twig cards. The card
  //     must not contain the twig tube here: the real cylinder + a picture of the
  //     same cylinder side by side reads as a doubled twig at the near view.
  //   LOD3 — first collapse: twig tubes DELETED, full twig+leaves cards replace
  //     them (hundreds of singles overlap; no crossing needed).
  //   LOD4 — limb collapse ONE level up: each level-(maxL-1) limb bakes to a
  //     CROSSED card pair, tubes at/below deleted. One level (not two) keeps
  //     enough cards for crown-top coverage; the trunk always stays real.
  const rung = (name, dist, cardLevel, keepTwigs, radialScale, ringStride, keep, prune) => ({
    name, distance: dist, prune, cardLevel, keepTwigs,
    radialScale: Math.max(0.15, Math.min(1, radialScale * q)), // × Twig/skeleton quality
    ringStride,
    appOnly: name === 'LOD3' || name === 'LOD4',
    foliage: clusters, budgetFrac: 0, // explicit steps, no solver
    // A lone flat LIMB card is the whole canopy where it stands and vanishes
    // edge-on — cross it like the billboard. Twig cards overlap; keep them single.
    cards: { growScale: growFor(1), keepFraction: keep, crossed: cardLevel < maxL },
  });
  // Near (effective LOD0, dist 0) — reference mobile model. Terminal twigs are
  // 3-sided prisms decimated to ~base+tip (the ≤10k mobile-near budget lives or
  // dies on twig tube tris — they dominate the count).
  Object.assign(base[2], rung('LOD2', 0, maxL, true, 0.6, 2, 1.0, 0.05),
    { appOnly: false, hiddenInApp: false, terminalSides: 3, terminalRingStride: 4 });
  // Density sliders thin the cards. PRUNE IS OFF on the mobile card rungs: the
  // prune sliders are DESKTOP dials (hidden in mobile mode), yet their values
  // leaked in here — lod2Prune's 0.35 default silently deleted a third of the
  // limb cards, tearing big holes in sparse crowns (the sweetgum gap). A card
  // costs ~4 tris; a missing limb card costs a hole. Not worth it.
  base.push(rung('LOD3', opts.lod1Dist ?? 35, maxL, false, 0.5, 3, Math.min(1, opts.lod1Density ?? 1), 0));
  base.push(rung('LOD4', opts.lod2Dist ?? 70, Math.max(1, maxL - 1), false, 0.4, 4, Math.min(1, opts.lod2Density ?? 1), 0));
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
  const maxLevel = stems[0]?.maxLevel ?? 0;
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
    if (lv.cardLevel != null) level.userData.cardLevel = lv.cardLevel; // which branch level collapsed to cards (debug/inspect)

    // Baked branch cards replace terminal twig foliage; unless the level keeps
    // its twig skeleton (keepTwigs — the hybrid look), the terminal cylinders
    // drop out of the branch mesh too. Rosette species keep real geometry at
    // every level (LOD via density) — the card bake assumes the leaf grammar.
    const useCards = !!(lv.cards && lodOpts.branchCards && leavesOn) && species.foliageType !== 'rosette';
    // Which branch level roots this level's cards. Default = the deepest (per-twig
    // cards). Mobile LODs step it UP the tree (lv.cardLevel) so each card is a whole
    // LIMB baked to a billboard — and every stem at/below that level is DELETED here,
    // so the collapsed limbs leave no floating cylinders behind (the mobile bug).
    const cardLevel = useCards ? Math.min(maxLevel, lv.cardLevel ?? maxLevel) : maxLevel;
    let meshStems = (useCards && !lv.keepTwigs) ? stems.filter((s) => s.level < cardLevel) : stems;
    // The stems that ROOT a card at this level (terminals when cardLevel===maxLevel).
    let cardRoots = useCards ? stems.filter((s) => s.level === cardLevel && s.points.length >= 2) : terminalStems;
    let levelTerminals = terminalStems;
    if (useCards) {
      // Thin the CARDS from the thinnest limbs up; if the twig skeleton is kept
      // (desktop hybrid) drop those limbs' cylinders with them. NEVER prune the
      // tree's top 20% (by card base height): the crown-top limbs are the THINNEST
      // (Weber-Penn shape ratio), so pure radius-sorted pruning scalped the
      // silhouette and left the trunk tip poking bare out of the canopy.
      if (lv.prune > 0 && cardRoots.length) {
        const ys = cardRoots.map((s) => s.points[0].y).sort((a, b) => a - b);
        const yCap = ys[Math.min(ys.length - 1, Math.floor(ys.length * 0.8))];
        const candidates = cardRoots.filter((s) => s.points[0].y <= yCap)
          .sort((a, b) => a.radii[0] - b.radii[0]);
        const drop = new Set(candidates.slice(0, Math.floor(cardRoots.length * lv.prune)));
        cardRoots = cardRoots.filter((s) => !drop.has(s));
        if (lv.keepTwigs) meshStems = meshStems.filter((s) => !drop.has(s));
      }
    } else if (lv.prune > 0) {
      // SpeedTree-style branch removal on real-leaf levels: the thinnest branches of
      // the deepest remaining level vanish first, and their FOLIAGE goes with them.
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
      // Pick the card set baked at THIS level + content. keepTwigs (hybrid) levels
      // use FOLIAGE-ONLY cards — the real tubes render, so a tube baked into the
      // card would double every twig; collapse levels use the full twig+leaves bake.
      const setKey = `${cardLevel}:${lv.keepTwigs ? 'fol' : 'full'}`;
      const cardsSet = lodOpts.branchCards.byLevel?.get(setKey)
        ?? lodOpts.branchCards.byLevel?.get(`${cardLevel}:full`)
        ?? lodOpts.branchCards;
      foliage = buildCardFoliage(cardRoots, cardsSet, frng, lv.cards);
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
      terminalSides: lv.terminalSides,      // mobile near: twigs as 3-sided prisms
      terminalRingStride: lv.terminalRingStride,
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
