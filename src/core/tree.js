// Assemble a renderable tree: skeleton → mesh at several detail levels → THREE.LOD.
// One Weber-Penn skeleton is shared by every level (identical silhouette, no pop);
// levels differ only in cylinder resolution and foliage mode. The far billboard
// level (crossplane impostor) is baked separately and attached in main.js.

import { Group, LOD, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';
import { Rng } from './rng.js';
import { generateSkeleton } from './weber-penn.js';
import { buildBranchGeometry, estimateBranchTriangles } from './branch-mesh.js';
import { buildFoliage } from './leaf-cards.js';
import { buildCardFoliage, stableStemSubset } from './branch-cards.js';
import { buildYuccaFoliage } from './yucca-leaves.js';
import { generateDichotomous, buildMergedMesh, stemFoliageView } from './dichotomous.js';
import { buildCactusSpines } from './cactus-spines.js';
import { buildFruits } from './fruit.js';

// Branch/trunk mesh-quality slider: the DEFAULT position, used as the
// normalization anchor everywhere the slider is consumed. At the default the
// tuned budgets hold (Joshua mobile near ≈ 10k); slider = 1 is the rich state
// (≈ 13k, 12-sided undecimated tubes). Shared with the UI + headless API.
export const MESHQ_DEFAULT = 0.8;

// Foliage/card groups own their InstancedMesh buffers. Their materials are
// species/card-cache assets, and card quads marked shared belong to the bake
// cache, so reconciliation must free only private geometry + mesh buffers.
function disposeTransientGroup(group) {
  group.traverse((o) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();
  });
}

function removeTransientGroup(parent, key) {
  const group = parent.userData[key];
  if (!group) return;
  parent.remove(group);
  disposeTransientGroup(group);
  parent.userData[key] = null;
}

function cardGeometries(cards) {
  const out = [];
  for (const variant of cards?.variants ?? []) {
    if (variant.geometry) out.push(variant.geometry);
    if (variant.side?.geometry) out.push(variant.side.geometry);
  }
  return out;
}

// Dichotomous plants: one stochastic L-system skeleton (shared across LODs),
// meshed as ONE merged tube per level (fewer rings at distance), each tip
// capped by a rosette. No card baking — real geometry with density LOD.
function buildDichotomousTree(species, seed, assets, lodOpts, reuse = null) {
  const speciesSlug = species.name.replace(/\s+/g, '_');
  const skRng = new Rng(`${species.name}:${seed}`);
  // Crown clearance tracks the (live) rosette radius so bigger rosettes push
  // branches further apart automatically.
  const skParams = { ...species.params, tipClearance: (species.foliage?.leafLen ?? species.foliage?.clusterSize ?? 0.5) * 0.9 };
  const { stems, terminalStems } = generateDichotomous(skParams, skRng);
  const ribsPerTile = assets.barkMat?.userData.ribsPerTile;
  if (species.cactus && ribsPerTile) {
    ribsPerTile.value = Math.max(1, species.params.ribsPerTile ?? 4);
  }

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
  // The mesh-quality slider is a BRANCH/TRUNK dial ONLY (user call): it never
  // touches rosette cones. It's normalized around MESHQ_DEFAULT so the default
  // position reproduces the tuned look (mobile near ≈ 10k) and slider = 1 buys
  // richer tubes (mobile near ≈ 13k: 12-sided, undecimated).
  const q = Math.max(0.3, lodOpts.meshQuality ?? MESHQ_DEFAULT);
  const qn = Math.min(1.25, q / MESHQ_DEFAULT); // 1 at the default position
  const d0 = lodOpts.lod0Density ?? 1; // mobile-near rosette density dial (mobile perf only)
  const d1 = lodOpts.lod1Density ?? 1, d2 = lodOpts.lod2Density ?? 1;
  const cs = (base) => Math.max(3, Math.round(base)); // per-LOD cone (rosette) detail — OFF the slider
  const rs = (base) => Math.max(4, Math.round(base * qn)); // per-LOD tube (branch/trunk) radial detail — the slider's domain
  // Ring decimation (ringMaxSpacing/ringKeepAngle → buildMergedMesh) is the
  // LENGTHWISE tri lever: the skeleton's ring cadence is hero-dense, so reduced
  // LODs drop low-shape rings and spend the savings on ROUND cross-sections —
  // a tube below 6 radial sides reads as a square strut, unusable as an asset.
  // The slider owns BOTH tube axes (user call): sides via rs() above, and the
  // HORIZONTAL rings via ring() below — under the default the decimation ramps
  // up on every level INCLUDING the hero LOD0 (untouched at/above the default,
  // so the tuned budgets hold; lowQ runs 0 at the default → 1 at the floor).
  const lowQ = Math.max(0, (MESHQ_DEFAULT - q) / (MESHQ_DEFAULT - 0.3));
  const ring = (spacing, angle) => ({ ringMaxSpacing: spacing + 0.6 * lowQ, ringKeepAngle: angle + 15 * lowQ });
  const shrub = species.foliageType === 'sprayClusters';
  const nativeSides = species.params.radialSegs ?? 10;
  const levels = shrub
    // SHRUB LADDER: tubes dominate a shrub's triangles (sprays are a few hundred
    // tris), so the reduction levers are SIDES + ring decimation — and every
    // reduced rung must stay at or below LOD0's native sides. (The rosette
    // ladder's rungs assumed Joshua-fat tubes and could exceed a thin shrub's
    // LOD0 — the "lower LOD is heavier than the main one" report.)
    ? [
      { name: 'LOD0', distance: 0, radialSegs: rs(nativeSides), rosetteDensity: 1, ...ring(0, 0) },
      { name: 'LOD1', distance: lodOpts.lod1Dist ?? 35, radialSegs: Math.min(rs(5), nativeSides), rosetteDensity: 0.6 * d1, ...ring(0.5, 18) },
      { name: 'LOD2', distance: lodOpts.lod2Dist ?? 80, radialSegs: Math.min(rs(4), nativeSides), rosetteDensity: 0.35 * d2, ...ring(0.9, 26) },
    ]
    : [
      { name: 'LOD0', distance: 0, radialSegs: rs(nativeSides), rosetteDensity: 1, coneRadialSegs: cs(12), ...ring(0, 0) },
      { name: 'LOD1', distance: lodOpts.lod1Dist ?? 35, radialSegs: rs(6), rosetteDensity: 0.6 * d1, coneRadialSegs: cs(8), ...ring(0.35, 12) },
      { name: 'LOD2', distance: lodOpts.lod2Dist ?? 80, radialSegs: rs(6), rosetteDensity: 0.35 * d2, coneRadialSegs: cs(4), ...ring(0.6, 18) },
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
    if (shrub) {
      // SHRUB MOBILE LADDER: same levers as the desktop shrub rungs, pushed
      // harder — and NEVER above the native sides (the rosette ladder's fixed
      // nearSides=8 exceeded a 6-sided shrub LOD0: heavier "reduced" rungs).
      levels[2].radialSegs = Math.min(rs(5), nativeSides);
      levels[2].rosetteDensity = 0.6 * d0;
      Object.assign(levels[2], ring(0.5, 18));
      levels.push({ name: 'LOD3', distance: lodOpts.lod1Dist ?? 35, appOnly: true, radialSegs: Math.min(rs(4), nativeSides), rosetteDensity: 0.35 * d1, ...ring(0.9, 26) });
      levels.push({ name: 'LOD4', distance: lodOpts.lod2Dist ?? 70, appOnly: true, radialSegs: 4, rosetteDensity: 0.2 * d2, ...ring(1.3, 34) });
    } else if (species.cactus) {
      // CACTUS MOBILE LADDER. The near rung keeps resolved ribs + thinned spines;
      // LOD3/LOD4 are REAL far rungs (the toggle previously added nothing here —
      // the LOD1/LOD2 sliders had no targets and the near LOD ran alone to the
      // billboard). Ribs soften → vanish; spines thin → off.
      const rc = species.params.ribCount ?? 16;
      levels[2].radialSegs = rc * 2;
      levels[2].ribDepth = species.params.ribDepth * 0.85;
      levels[2].spineDensity = 0.3 * d2; // keep ribs + thinned spines on the near mobile column
      // Straight columns shed rings via the gap criterion; the keep-angle is
      // for the J-elbows and must stay TIGHT on this rung at the default — it
      // renders at arm's length, and ≥5° ring creases catch the light on the
      // ribbed surface. Below the default the slider's ring ramp takes over.
      Object.assign(levels[2], ring(0.25, 3));
      // LOD3 drops the FLUTING entirely — any ribDepth > 0 re-triggers the mesher's
      // rib lock (radialSegs snaps back to ribCount×2) and the rung stays as heavy
      // as the near one. At 35 m the rib impression comes from the bark texture +
      // crest tint, not geometry.
      // spineDensity 0 is HONEST here, not a choice: crest anchors are only
      // collected while ribDepth > 0 (dichotomous.js), so a smooth column can
      // never grow spines — a nonzero value here silently did nothing (Sol).
      levels.push({ name: 'LOD3', distance: lodOpts.lod1Dist ?? 35, appOnly: true, radialSegs: 12, ...ring(0.6, 20), ribDepth: 0, spineDensity: 0, rosetteDensity: 0 });
      levels.push({ name: 'LOD4', distance: lodOpts.lod2Dist ?? 70, appOnly: true, radialSegs: 8, ...ring(1.0, 30), ribDepth: 0, spineDensity: 0, rosetteDensity: 0 });
    } else {
      // ROSETTE MOBILE LADDER — PERFORMANCE FIRST. This ladder exists for a
      // triangle budget (near ≤ ~8k, then real steps), and fidelity spends only
      // what's left: a SHORT geometric sleeve (skirtTopLen) keeps the Joshua
      // identity, the thatch texture carries the rest. (A 0.9 m sleeve at 0.9
      // density blew the near rung to 11k — the budget owns this ladder.)
      // Crown cones need ≥6 radial segments or the green rosettes read as SQUARE
      // pyramids at the near view (user report); the budget compensates via
      // density, sleeves, and the tube's radial cut instead.
      levels[2].skirtToBark = true; levels[2].thatchBark = true; levels[2].skirtTopLen = 0.4;
      // Near-rung rosette density: 0.48 tuned base × the mobile-only "LOD0
      // rosette density" dial (crowns + skirt thin together, bottom-up).
      levels[2].coneRadialSegs = cs(6); levels[2].rosetteDensity = 0.48 * d0;
      // Tube quality rides the branch/trunk slider ALONE (cones fixed above):
      // default (MESHQ_DEFAULT) → 8 sides + ring decimation ≈ 10.8k near rung
      // (6 sides still read faceted on the sky-lined top branches — user
      // report; "10k is fine if it looks good"); slider 1 → 12 sides, no
      // decimation ≈ 13.6k; below default it leans out toward 4 sides AND the
      // ring ramp thins the horizontal rings. ringMaxSpacing must be EXPLICITLY
      // zeroed at high quality — the desktop LOD2 base entry it inherits from
      // carries 0.6.
      const nearSides = q >= MESHQ_DEFAULT
        ? Math.round(8 + ((q - MESHQ_DEFAULT) / (1 - MESHQ_DEFAULT)) * 4)
        : Math.max(4, Math.round(4 + ((q - 0.3) / (MESHQ_DEFAULT - 0.3)) * 4));
      levels[2].radialSegs = nearSides;
      Object.assign(levels[2], ring(0.45, 15));
      if (q >= 0.95) levels[2].ringMaxSpacing = 0;
      // Both far rungs collapse each TERMINAL ROSETTE BRANCH (crown + sleeve +
      // arm stub) to baked cards (rosette crowns are near-rotationally-symmetric,
      // so one bake serves every plane): LOD3 = FOUR crossed copies (8 tris/arm),
      // LOD4 = TWO (4 tris/arm). Real geometry shrinks to the non-terminal tubes.
      // Falls back to sparse cones per rosetteDensity when no card set exists.
      // LOD3's tube gets NO reduction (user call): the rosette cards already
      // carry the rung's whole budget win, so the remaining structural
      // branches/trunk MATCH the near rung's sides — and no ring decimation.
      levels.push({ name: 'LOD3', distance: lodOpts.lod1Dist ?? 35, appOnly: true, skirtToBark: true, thatchBark: true, skirtTopLen: 0.2, radialSegs: nearSides, coneRadialSegs: 3, rosetteDensity: 0.35 * d1, rosetteCards: true, cardCopies: 4, cardKeepFraction: Math.max(0, Math.min(1, d1)) });
      levels.push({ name: 'LOD4', distance: lodOpts.lod2Dist ?? 70, appOnly: true, skirtToBark: true, thatchBark: true, skirtTopLen: 0, radialSegs: 5, ringMaxSpacing: 1.2, ringKeepAngle: 35, coneRadialSegs: 3, rosetteDensity: 0.18 * d2, rosetteCards: true, cardCopies: 2, cardKeepFraction: Math.max(0, Math.min(1, d2)) });
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
  // Card sets already placed by an earlier rung THIS build: a repeat placement
  // must clone the card quads (see buildCardFoliage opts.cloneGeometry) or the
  // second rung's per-instance wind attrs overwrite the first's.
  const placedCardGeometries = new Set();
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
    // Rosette-card rung: terminal-arm tubes live INSIDE their baked cards, so the
    // mesher skips those subtrees (their parents cap like tips).
    const cardKeepFraction = Math.max(0, Math.min(1, lv.cardKeepFraction ?? 1));
    const useRosetteCards = !!(
      lv.rosetteCards
      && cardKeepFraction > 0
      && lodOpts.branchCards?.rosette
      && lodOpts.branchCards.variants?.length
    );
    const termSet = useRosetteCards ? new Set(terminalStems) : null;
    const meshParams = {
      ...species.params, radialSegs: lv.radialSegs, ribDepth: lv.ribDepth ?? species.params.ribDepth,
      // Ring decimation: the mesh-time lever that thins a stem along its LENGTH
      // (radialSegs only cuts girth — leaning on it alone squared the branches).
      ...(lv.ringMaxSpacing ? { ringMaxSpacing: lv.ringMaxSpacing, ringKeepAngle: lv.ringKeepAngle } : {}),
      ...(termSet ? { skipStem: (s) => termSet.has(s) } : {}),
    };
    const barkMat = (lv.thatchBark && assets.thatchBarkMat) ? assets.thatchBarkMat : (assets.barkMat ?? makeBarkMaterial(assets));
    let branches = level.userData.barkMesh;
    if (reuse && branches) {
      buildMergedMesh(stems, meshParams, branches.geometry);
    } else {
      const geo = buildMergedMesh(stems, meshParams);
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
    if (useRosetteCards) {
      // FOUR-WAY crossed terminal-rosette cards (8 tris per arm) replace the
      // crown+skirt cones AND the terminal tubes (skipped above). Rebuilt fresh
      // each time (a few dozen instances; materials come cached from the card
      // set, so there's no pipeline recompile) — the in-place cone-reuse path
      // doesn't apply to this rung.
      removeTransientGroup(level, 'folGroup');
      removeTransientGroup(level, 'cardGroup');
      const frng = new Rng(`${species.name}:${seed}:rcards${i}`);
      // windAt 'base': the card's joint with its arm stub is VISIBLE here — the
      // card must sway with the weight at that joint or it slides off the arm
      // (tip weight is for temperate limb cards whose base joint is buried).
      const cardFol = buildCardFoliage(terminalStems, lodOpts.branchCards, frng, {
        copies: lv.cardCopies ?? 4, keepFraction: cardKeepFraction, growScale: 1, windAt: 'base',
        cloneGeometry: cardGeometries(lodOpts.branchCards).some((g) => placedCardGeometries.has(g)),
      });
      if (cardFol) {
        for (const g of cardGeometries(lodOpts.branchCards)) placedCardGeometries.add(g);
        cardFol.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; leafInstances += o.count || 0; } });
        level.add(cardFol);
        level.userData.cardGroup = cardFol;
      }
    } else if (species.foliageType === 'sprayClusters' && assets.clusterMat && species.foliage !== false && (lv.rosetteDensity ?? 1) > 0) {
      // SHRUB foliage: the authored leaf-spray sheet placed by leaf-cards'
      // cluster grammar on the dichotomous terminal stems — same branch-frame
      // anchoring as temperate cluster cards, so sprays ride their twigs.
      // Rebuilt per level (a few dozen instances; material is cached).
      removeTransientGroup(level, 'cardGroup');
      removeTransientGroup(level, 'folGroup');
      const frng = new Rng(`${species.name}:${seed}:sprays${i}`);
      const sprayDensity = lv.rosetteDensity ?? 1;
      const cfg = { ...species.foliage, mode: 'clusters',
        clustersPerBranch: Math.max(1, Math.round((species.foliage.clustersPerBranch ?? 2) * sprayDensity)) };
      // Anchor sprays on the SAME decimated stem view the tube mesher renders
      // at this level: reduced LODs pull rings onto the gnarl's mean curve, and
      // cards anchored to the raw skeleton hover beside the smoothed twigs.
      const anchorView = (s) => stemFoliageView(s, meshParams);
      const fol = buildFoliage(terminalStems.map(anchorView), cfg, frng, assets.clusterMat, assets.clusterCenter);
      // parentSprays (0..1): sub-terminal parents also carry sprays — the
      // mid-canopy fill of the eidoverse shrub look. Fraction scales the
      // per-branch count; the terminals' call above owns the dome centre.
      let parentFol = null;
      const pFrac = species.foliage.parentSprays ?? 0;
      if (pFrac > 0) {
        const parents = stems.filter((s) => !s.terminal && s.children.some((ch) => ch.terminal));
        if (parents.length) {
          parentFol = buildFoliage(parents.map(anchorView),
            { ...cfg, clustersPerBranch: Math.max(1, Math.round(cfg.clustersPerBranch * pFrac)) },
            new Rng(`${species.name}:${seed}:psprays${i}`), assets.clusterMat, null);
        }
      }
      if (fol || parentFol) {
        const grp = new Group();
        for (const m of [fol, parentFol]) {
          if (!m) continue;
          m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; leafInstances += o.count || 0; } });
          grp.add(m);
        }
        level.add(grp);
        level.userData.folGroup = grp;
      }
    } else if (assets.rosetteMat && species.foliage !== false && (lv.rosetteDensity ?? 1) > 0) {
      // A missing/failed card bake falls back to cones. Remove any card group
      // left by the previous rebuild before reusing/creating the cone group.
      removeTransientGroup(level, 'cardGroup');
      const frng = new Rng(`${species.name}:${seed}:rosette${i}`);
      // Pass the persistent foliage Group on reuse so buildYuccaFoliage rewrites
      // its per-cone InstancedMesh buffers in place (setMatrixAt, never swap).
      const reuseFol = level.userData.folGroup ?? null;
      const fol = buildYuccaFoliage(terminalStems, { ...species.foliage, density: lv.rosetteDensity, coneRadialSegs: lv.coneRadialSegs, skirtToBark: lv.skirtToBark, skirtTopLen: lv.skirtTopLen }, frng, assets.rosetteMat, stems, reuseFol);
      if (fol) {
        fol.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; leafInstances += o.count || 0; } });
        if (!reuseFol) { level.add(fol); level.userData.folGroup = fol; }
      }
    } else {
      // Density zero (or foliage/material disabled) must reconcile both paths;
      // otherwise a reused level keeps rendering whichever group was attached
      // by the preceding build.
      removeTransientGroup(level, 'cardGroup');
      removeTransientGroup(level, 'folGroup');
    }

    // Fruiting shrubs share the same real GLB fruit path as orchard trees. Keep
    // fruit on the two nearest LODs, thin it at LOD1, and rebuild it as a
    // transient mesh so seed/species edits cannot leave stale instances behind.
    removeTransientGroup(level, 'fruitMesh');
    if (species.fruit && assets.fruitGeo && assets.fruitMat && i < 2 && species.foliage !== false) {
      const frng = new Rng(`${species.name}:${seed}:fruit${i}`);
      const fcfg = i === 0 ? species.fruit
        : { ...species.fruit, maxCount: Math.max(1, Math.round((species.fruit.maxCount ?? 120) * 0.35)) };
      const fruit = buildFruits(terminalStems, fcfg, frng, assets.fruitGeo, assets.fruitMat, stems);
      if (fruit) {
        leafInstances += fruit.count;
        level.add(fruit);
        level.userData.fruitMesh = fruit;
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
import { texture, mix, smoothstep, positionWorld, uniform, float, vec3, uv, fract, abs } from 'three/tsl';
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
  // Full thatch by 1.1 m (was 1.5 — arms sat in the half-blended zone and read as
  // smooth pale tubes), and the thatch albedo is pulled toward the reference's
  // gray-tan (real dead-leaf sleeves are darker + grayer than the raw texture).
  const loY = uniform(assets.thatchLoY ?? 0.6), hiY = uniform(assets.thatchHiY ?? 1.1);
  const thatchTint = uniform(vec3(0.85, 0.82, 0.75));
  const m = smoothstep(loY, hiY, positionWorld.y); // 0 low (bark) → 1 high (thatch)
  mat.colorNode = mix(barkC.rgb, thatchC.rgb.mul(thatchTint), m);
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
  // Pale warm-ivory SPINE-ROW tint along the rib crests (reference: the crest
  // areole rows read as bright dotted lines at every distance). The bark tile is
  // painted with 4 crest columns whose centres land at fract(u·4)=0.5 (the rib
  // lock — see buildMergedMesh), so a narrow triangle mask there IS the crest
  // line. Subtle (×0.45): it must read as spines catching light, not stripes.
  const ribsPerTile = uniform(Math.max(1, assets.ribsPerTile ?? 4));
  const crestTri = float(1).sub(abs(fract(uv().x.mul(ribsPerTile)).sub(0.5)).mul(2));
  const crestMask = smoothstep(0.62, 0.92, crestTri).mul(0.45);
  const blended = mix(clnA.rgb, dmgA.rgb, d);
  mat.colorNode = mix(blended, blended.mul(vec3(1.18, 1.15, 1.02)).add(vec3(0.06, 0.055, 0.04)), crestMask).mul(tint);
  mat.roughnessNode = mix(clnR.r, dmgR.r, d);
  mat.positionNode = barkWindPosition();
  mat.userData.barkDamage = damage; // GUI "Bark damage" dial writes .value
  mat.userData.barkSeed = seed;
  mat.userData.barkTint = tint;     // Bark-tint dial writes .value (linear)
  mat.userData.ribsPerTile = ribsPerTile;
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
  const maxL = (species.params?.levels ?? 3) - 1;
  const willowCurtains = f.mode === 'willowCurtains';
  // Normalized branch/trunk quality, capped at 1: the temperate look is
  // UNCHANGED at (and above) the slider default — only below it leans out.
  const q = Math.min(1, (opts.meshQuality ?? MESHQ_DEFAULT) / MESHQ_DEFAULT);
  const leavesOn = (f.leavesPerBranch ?? 1) > 0;       // user "Show leaves" toggle
  // Hanging sprays are already authored cluster cards. Converting their fallback
  // to generic `clusters` would run the ordinary upward leaf grammar and flip the
  // top-anchored willow vines. Preserve their placement mode at every LOD.
  const clusters = f.mode === 'hangingSprays' || willowCurtains
    ? { ...f, leavesPerBranch: leavesOn ? (f.leavesPerBranch ?? 1) : 0 }
    : { ...f, mode: 'clusters', clustersPerBranch: leavesOn ? (f.clustersPerBranch ?? 3) : 0 };
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
      // Sparse terminal-pad species tear obvious crown holes when whole tips
      // disappear; retain their pads and spend the same budget on cheaper wood.
      prune: species.preserveLod2Tips ? 0 : (opts.lod2Prune ?? 0.35),
      foliage: clusters,
      cards: {
        growScale: growFor(keep2), keepFraction: keep2,
        crossed: !!species.crossedLod2Cards,
      },
    },
  ];
  if (willowCurtains) {
    // Desktop LOD1 deliberately keeps individual curved vine cards. Grouping a
    // feeder's whole curtain begins only at desktop LOD2, which is promoted to
    // the visible near/LOD0 rung by the mobile-performance ladder below.
    const lod1Segments = Math.max(6, Math.min(f.segments ?? 12, 7));
    const lod1VineKeep = Math.max(0, Math.min(1, opts.lod1Density ?? 1));
    Object.assign(base[1], {
      prune: 0,
      foliage: {
        ...f,
        // Seven rows keep sub-decimetre curve error at the switch. Keep every
        // vine at the default desktop density: tessellation alone provides the
        // reduction, so the still-large on-screen crown does not lose 14% of
        // its curtain roots during the first transition.
        segments: lod1Segments,
        vineKeepFraction: lod1VineKeep,
        vinesPerMeter: f.vinesPerMeter ?? 9,
      },
    });
    Object.assign(base[2], {
      cardLevel: maxL,
      prune: 0,
      cards: {
        growScale: 1, keepFraction: keep2,
        // The real side bake keeps feeder sheets volumetric and closes the dark
        // edge-on gaps at the first grouped-card rung.
        crossed: true, gravityAligned: true, stableKeep: true,
        floorMin: f.floorMin ?? 0.28,
      },
    });
  }
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
  // MOBILE LADDER = a nested representation curve. The promoted near rung keeps
  // every terminal card and a cheap terminal skeleton. Mid/far retain the same
  // card grammar while taking stable card/tube subsets, so nothing reappears or
  // jumps to a different attachment as distance increases. The calibrated target
  // is ~100→55→30%, matching Willow's separately authored bowed-sheet ladder.
  const guideLevel = species.guideLevel ?? (species.terminalStemsAreGuides ? maxL : null);
  // cardLevel roots a card; keepTwigs selects the foliage-only bake so retained
  // tubes never get doubled by a photographed tube on the same card.
  const rung = (name, dist, cardLevel, keepTwigs, radialScale, ringStride, keep, prune) => ({
    name, distance: dist, prune, cardLevel, keepTwigs,
    radialScale: Math.max(0.15, Math.min(1, radialScale * q)), // × Twig/skeleton quality
    ringStride,
    appOnly: name === 'LOD3' || name === 'LOD4',
    foliage: clusters, budgetFrac: 0, // explicit steps, no solver
    // A lone flat LIMB card is the whole canopy where it stands and vanishes
    // edge-on — cross it like the billboard. Twig cards overlap; keep them single.
    cards: {
      growScale: growFor(1), keepFraction: keep,
      crossed: cardLevel < maxL || !!species.crossedLod2Cards,
      stableKeep: true,
    },
  });
  if (willowCurtains) {
    const willowRung = (name, dist, radialScale, ringStride, keep, crossed, cardGrid = null) => ({
      ...rung(name, dist, maxL, true, radialScale, ringStride, keep, 0),
      cards: {
        growScale: 1, keepFraction: keep, crossed, stableKeep: true,
        gravityAligned: true, floorMin: f.floorMin ?? 0.28,
        ...(cardGrid ? { cardGrid } : {}),
      },
    });
    // The promoted mobile near view keeps both gravity-aligned sheet views.
    // Thin feeder groups first while keeping crossed depth, then remove the
    // side view at the next rung. Changing one visual axis per transition avoids
    // the old sequence where every side plane vanished at once and the following
    // rung immediately opened unrelated spatial holes.
    Object.assign(
      base[2],
      willowRung('LOD2', 0, 0.6, 2, 1, true),
      {
        appOnly: false, hiddenInApp: false,
        terminalSides: 3, terminalRingStride: 4,
      },
    );
    const groupedFeederKeep = Math.max(0, Math.min(
      1, f.groupedCardFeederKeepFraction ?? 0.70,
    ));
    // First mobile reduction preserves every feeder and spends its savings on
    // the sheet grid. Coverage changes only when the farther rung takes the
    // stable 80% subset, avoiding a density hole immediately after mobile-near.
    const midKeep = Math.min(1, opts.lod1Density ?? 1);
    base.push(Object.assign(
      willowRung(
        'LOD3', opts.lod1Dist ?? 35, 0.5, 3,
        midKeep, true, { cols: 4, rows: 5 },
      ),
      // Keep terminal feeder tubes monotonic too: without these overrides the
      // farther rung accidentally gained rings over mobile-near LOD2.
      { terminalSides: 3, terminalRingStride: 5 },
    ));
    // The far rung keeps the same stable feeder subset at its default, but uses
    // one bowed view per feeder. Its density control thins within the exact same
    // ranking, so custom values remain nested and cannot reshuffle the crown.
    const farKeep = Math.min(
      midKeep,
      groupedFeederKeep * Math.min(1, opts.lod2Density ?? 1),
    );
    base.push(Object.assign(
      willowRung(
        'LOD4', opts.lod2Dist ?? 70, 0.4, 4,
        farKeep, false, { cols: 4, rows: 5 },
      ),
      { terminalSides: 3, terminalRingStride: 6 },
    ));
    return base;
  }
  const guideCards = guideLevel === maxL;
  const density1 = Math.max(0, Math.min(1, opts.lod1Density ?? 1));
  const density2 = Math.max(0, Math.min(1, opts.lod2Density ?? 1));
  // Near (effective LOD0, dist 0) is the full mobile reference. Pruning here and
  // restoring roots at LOD3 made foliage appear as distance increased, so every
  // terminal card and tube survives this rung.
  Object.assign(
    base[2],
    rung('LOD2', 0, maxL, true, 0.6, 2, 1, 0),
    {
      appOnly: false, hiddenInApp: false,
      terminalSides: 3, terminalRingStride: 4,
      meshTerminalKeepFraction: 1,
    },
  );
  // Ordinary broadleaves spend the mid reduction on terminal tube count while
  // retaining every foliage card. Guide-only Sycamore has no terminal tubes, so
  // its equivalent saving is a stable half-card subset.
  const midCardKeep = (guideCards ? 0.5 : 1) * density1;
  const midTubeKeep = guideCards ? 1 : Math.min(midCardKeep, 0.4 * density1);
  base.push(Object.assign(
    rung('LOD3', opts.lod1Dist ?? 35, maxL, true, 0.5, 3, midCardKeep, 0),
    {
      terminalSides: 3, terminalRingStride: 4,
      meshTerminalKeepFraction: midTubeKeep,
    },
  ));
  // Far keeps nested card/tube subsets. Sycamore reduces its guide cards to 18%
  // and coarsens the real scaffold; ordinary species keep 40% cards / 20% tubes.
  const farCardKeep = Math.min(
    midCardKeep,
    (guideCards ? 0.18 : 0.4) * density2,
  );
  const farTubeKeep = guideCards
    ? 1 : Math.min(midTubeKeep, farCardKeep, 0.2 * density2);
  base.push(Object.assign(
    rung(
      'LOD4', opts.lod2Dist ?? 70, maxL, true,
      guideCards ? 0.4 : 0.5, guideCards ? 4 : 3,
      farCardKeep, 0,
    ),
    {
      terminalSides: 3, terminalRingStride: 4,
      meshTerminalKeepFraction: farTubeKeep,
    },
  ));
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
  if (species.foliageType === 'rosette' || species.foliageType === 'sprayClusters') return buildDichotomousTree(species, seed, assets, lodOpts, reuse);

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
  const guideLevel = species.guideLevel ?? (species.terminalStemsAreGuides ? maxLevel : null);
  const geoTris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  let total0 = 0; // LOD0 triangle count — the reference the percent budgets solve against
  // Card sets already placed by an earlier rung this build — a repeat placement
  // (levels=2 species map LOD3 and LOD4 onto the same `1:full` set) must clone
  // the quads or the later rung's instance wind attrs overwrite the earlier's.
  const placedCardGeometries = new Set();
  const thinGuideRoots = (roots, prune) => {
    const byParent = new Map();
    for (const stem of roots) {
      const group = byParent.get(stem.parentId) ?? [];
      group.push(stem);
      byParent.set(stem.parentId, group);
    }
    const keep = new Set();
    for (const group of byParent.values()) {
      group.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      const keepN = Math.max(1, Math.ceil(group.length * (1 - prune)));
      if (keepN === 1) keep.add(group[Math.floor(group.length / 2)]);
      else for (let i = 0; i < keepN; i++) keep.add(group[Math.round(i * (group.length - 1) / (keepN - 1))]);
    }
    return roots.filter((stem) => keep.has(stem));
  };
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
    if (lv.cards) level.userData.cardKeepFraction = lv.cards.keepFraction ?? 1;
    if (lv.meshTerminalKeepFraction != null) {
      level.userData.meshTerminalKeepFraction = lv.meshTerminalKeepFraction;
    }
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
        let drop;
        if (guideLevel === cardLevel) {
          const targetDrop = Math.min(candidates.length, Math.floor(cardRoots.length * lv.prune));
          const candidatePrune = candidates.length ? targetDrop / candidates.length : 0;
          const keep = new Set(thinGuideRoots(candidates, candidatePrune));
          drop = new Set(candidates.filter((stem) => !keep.has(stem)));
        } else {
          drop = new Set(candidates.slice(0, Math.floor(cardRoots.length * lv.prune)));
        }
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
        const kept = guideLevel === deepest ? thinGuideRoots(candidates, lv.prune) : candidates.slice(Math.floor(candidates.length * lv.prune));
        const keep = new Set(kept);
        const drop = new Set(candidates.filter((stem) => !keep.has(stem)));
        meshStems = meshStems.filter((s) => !drop.has(s));
        levelTerminals = levelTerminals.filter((s) => !drop.has(s));
      }
    }
    // Some terminal stems are procedural placement guides rather than wood. Keep
    // them in `levelTerminals` for foliage/pruning/wind, but never send them to the
    // tube mesher — even Show Leaves=false must not resurrect the old willow rods.
    if (guideLevel != null) meshStems = meshStems.filter((s) => s.level !== guideLevel);

    // Foliage FIRST — its triangle count feeds the branch budget solver.
    let foliage = null;
    let leafInstances = 0;
    if (useCards) {
      // Random Bernoulli thinning can remove every curtain from one crown sector.
      // Guide species instead retain evenly spaced siblings on every feeder, then
    // Mobile card rungs thin terminal tubes independently of their foliage cards.
    // Both use stableStemSubset's one identity ranking, so every far tube remains
    // represented by a surviving card and no attachment reshuffles between rungs.
    const meshTerminalKeep = Math.max(0, Math.min(1, lv.meshTerminalKeepFraction ?? 1));
    if (useCards && meshTerminalKeep < 1) {
      const terminalKeep = new Set(stableStemSubset(
        meshStems.filter((stem) => stem.level === maxLevel), meshTerminalKeep,
      ));
      meshStems = meshStems.filter((stem) => stem.level !== maxLevel || terminalKeep.has(stem));
    }
      // disable buildCardFoliage's second random keep pass. Willow opts into the
      // exact stable-ID path inside buildCardFoliage instead.
      let cardOpts = lv.cards;
      const keepFraction = Math.max(0, Math.min(1, lv.cards.keepFraction ?? 1));
      if (guideLevel === cardLevel && keepFraction < 1) {
        cardRoots = lv.cards.stableKeep
          ? stableStemSubset(cardRoots, keepFraction)
          : thinGuideRoots(cardRoots, 1 - keepFraction);
        cardOpts = { ...lv.cards, keepFraction: 1 };
      }
      const frng = new Rng(`${species.name}:${seed}:cards${i}`);
      // Pick the card set baked at THIS level + content. keepTwigs (hybrid) levels
      // use FOLIAGE-ONLY cards — the real tubes render, so a tube baked into the
      // card would double every twig; collapse levels use the full twig+leaves bake.
      const setKey = `${cardLevel}:${lv.keepTwigs ? 'fol' : 'full'}`;
      const cardsSet = lodOpts.branchCards.byLevel?.get(setKey)
        ?? lodOpts.branchCards.byLevel?.get(`${cardLevel}:full`)
        ?? lodOpts.branchCards;
      // A partial byLevel facade may alias another set's variants while having a
      // different object identity. Track the actual quad geometries so the later
      // rung cannot overwrite the earlier rung's per-instance wind attributes.
      const setGeometries = cardGeometries(cardsSet);
      const cloneGeometry = setGeometries.some((g) => placedCardGeometries.has(g));
      if (cloneGeometry) cardOpts = { ...cardOpts, cloneGeometry: true };
      foliage = buildCardFoliage(cardRoots, cardsSet, frng, cardOpts);
      if (foliage) for (const g of setGeometries) placedCardGeometries.add(g);
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
        // Direct willow LOD0/1 differ only in curve tessellation. Reuse their
        // random stream so every root, length, roll, and arc stays in place at
        // the switch instead of all ~1,000 vines visibly reshuffling.
        const rngTag = cfg.mode === 'willowCurtains' && i < 2
          ? 'willow-direct' : `foliage${i}`;
        const frng = new Rng(`${species.name}:${seed}:${rngTag}`);
        foliage = buildFoliage(levelTerminals, cfg, frng, fMat, fCenter);
        if (foliage) leafInstances = foliage.userData.vineCount ?? foliage.count ?? 0;
      }
    }
    let folTris = 0;
    if (foliage) {
      foliage.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.userData.lockShadowPolicy) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
        folTris += geoTris(o.geometry) * (o.isInstancedMesh ? o.count : 1);
      });
      level.add(foliage);
    }

    // Fruit (orchard species): retopoed GLB instances hung from the twigs.
    // Near LODs only — a ~7 cm apple is sub-pixel past the LOD2 switch.
    // Anchored to REAL WOOD: guide species' terminal level is invisible leaf
    // scaffolding (terminalStemsAreGuides), and fruit hung there floats in
    // canopy air — so hang from the deepest RENDERED stems instead.
    // Placed OUTSIDE the branch budget solve (decoration on top, LOD1 thinned).
    if (species.fruit && assets.fruitGeo && assets.fruitMat && i < 2 && species.foliage !== false) {
      const frng = new Rng(`${species.name}:${seed}:fruit${i}`);
      // LOD1 keeps a QUARTER of the fruit: at the 12m+ switch each fruit is a
      // few pixels, but zero would be a visible pop. The solver absorbs the
      // cost (fruit feeds folTris below), so the percent target still holds.
      const fcfg = i === 0 ? species.fruit
        : { ...species.fruit, maxCount: Math.round((species.fruit.maxCount ?? 120) * 0.25) };
      let fruitStems = levelTerminals;
      if (guideLevel != null) {
        const deepestWood = Math.max(...meshStems.map((s) => s.level));
        fruitStems = meshStems.filter((s) => s.level === deepestWood);
      }
      const fruit = buildFruits(fruitStems, fcfg, frng, assets.fruitGeo, assets.fruitMat, meshStems);
      if (fruit) {
        leafInstances += fruit.count;
        level.add(fruit);
        // Count fruit against the level's triangle budget (folTris feeds the
        // branch solver) — otherwise LOD1 blows past its percent target by
        // exactly the fruit cost.
        folTris += geoTris(fruit.geometry) * fruit.count;
      }
    }

    // Branch cylinders, budget-solved. Radial segment rounding makes triangle
    // count a staircase, not a linear function of radialScale. Search that exact
    // staircase analytically, then allocate only the selected geometry once.
    const gopts = {
      tileWorldSize: species.tileWorldSize ?? 1.5,
      radialScale: lv.radialScale,
      ringStride: lv.ringStride,
      terminalSides: lv.terminalSides,      // mobile near: twigs as 3-sided prisms
      terminalRingStride: lv.terminalRingStride,
    };
    let solvedOpts = gopts;
    if (lv.budgetFrac && total0 > 0) {
      const targetBranch = Math.max(100, total0 * lv.budgetFrac - folTris);
      const solveAtStride = (ringStride) => {
        const estimate = (radialScale) => estimateBranchTriangles(meshStems, {
          ...gopts, ringStride, radialScale,
        });
        const minTris = estimate(0.1);
        const maxTris = estimate(1);
        if (targetBranch <= minTris) {
          return { ringStride, radialScale: 0.1, triangles: minTris, atMax: false };
        }
        if (targetBranch >= maxTris) {
          return { ringStride, radialScale: 1, triangles: maxTris, atMax: true };
        }

        let lo = 0.1, hi = 1;
        for (let pass = 0; pass < 28; pass++) {
          const mid = (lo + hi) * 0.5;
          if (estimate(mid) <= targetBranch) lo = mid;
          else hi = mid;
        }
        const below = { ringStride, radialScale: lo, triangles: estimate(lo), atMax: false };
        const above = { ringStride, radialScale: hi, triangles: estimate(hi), atMax: false };
        const belowError = Math.abs(targetBranch - below.triangles);
        const aboveError = Math.abs(targetBranch - above.triangles);
        return aboveError < belowError ? above : below; // ties stay cheaper
      };

      let solved = solveAtStride(gopts.ringStride);
      // Generic LOD2 cards are so cheap that stride-2 wood may top out far
      // below 15%. Restore intermediate rings before spending extra sides;
      // this preserves the branch curves and makes the configured rung reachable.
      if (solved.atMax && gopts.ringStride > 1) {
        const denser = solveAtStride(1);
        if (Math.abs(targetBranch - denser.triangles)
          < Math.abs(targetBranch - solved.triangles)) solved = denser;
      }
      solvedOpts = {
        ...gopts,
        radialScale: solved.radialScale,
        ringStride: solved.ringStride,
      };
    }
    const geo = buildBranchGeometry(meshStems, solvedOpts);
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
