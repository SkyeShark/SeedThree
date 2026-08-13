// Baked branch cards — billboard-cloud / SpeedTree-Clusters style intermediate
// LOD foliage, baked FROM THE LOD0 TREE ITSELF (per the AAA pipeline research:
// HZD's authored clusters, Simplygon/InstaLOD's automated billboard clouds).
//
// A few exemplar terminal subtrees (twig cylinder + its real LOD0 leaf
// instances, real leaf material) are rendered through the multichannel baker
// into unlit material inputs (albedo/normal/rough/translucency). At LOD1+ every
// terminal twig — cylinder AND leaves — is replaced by ONE single-quad card
// instance using those bakes, placed with the branch's own frame. Because the
// card is literally a picture of the LOD0 tree relit by the same material
// family, color/density/silhouette parity across the LOD switch is automatic.
//
// Bakes are cached per (species, leaf params) in main.js — they're built from a
// FIXED exemplar seed, so reseeding the tree reuses them.

import {
  Group, Mesh, InstancedMesh, BufferGeometry, BufferAttribute, InstancedBufferAttribute,
  OrthographicCamera, Box3, Vector3, Quaternion, Matrix4, Color, DoubleSide, MeshSSSNodeMaterial,
} from 'three/webgpu';
import {
  texture, uniform, positionWorld, attribute, cameraViewMatrix, vec3, vec4, float, mix, mrt, output, normalView,
} from 'three/tsl';
import { Rng } from './rng.js';
import { generateSkeleton } from './weber-penn.js';
import { generateDichotomous, buildMergedMesh } from './dichotomous.js';
import { buildYuccaFoliage } from './yucca-leaves.js';
import { buildBranchGeometry } from './branch-mesh.js';
import { buildFoliage, addThicknessAttribute } from './leaf-cards.js';
import { buildFruits } from './fruit.js';
import { bakeGroupToTextures } from './impostor.js';
import { foliageWindPosition, sunDirectionUniform, WIND_DIR } from './wind.js';

const MAX_CARD_INSTANCES = 4096; // aThickness allocation on the shared geometry
const TRANSMIT = [0.42, 0.62, 0.24];

const chordVec = (stem, out) =>
  out.copy(stem.points[stem.points.length - 1]).sub(stem.points[0]);

// Arc length (sum of segments) — the STABLE size reference for card scaling. The
// straight-line CHORD collapses toward 0 on short curved twigs (tip curves back over
// the base), which made `len/chordLen` explode → cards baked 10-30× too big.
function stemArcLen(stem) {
  let l = 0; const p = stem.points;
  for (let i = 1; i < p.length; i++) l += p[i].distanceTo(p[i - 1]);
  return l;
}

// Rebase a stem into card-local space: base at the origin, chord along +Y —
// the same frame the card quad and its placement transform use.
function rebaseStem(stem) {
  const base = stem.points[0];
  const chord = chordVec(stem, new Vector3()).normalize();
  const q = new Quaternion().setFromUnitVectors(chord, new Vector3(0, 1, 0));
  return {
    ...stem,
    points: stem.points.map((p) => p.clone().sub(base).applyQuaternion(q)),
    orients: stem.orients.map((o) => q.clone().multiply(o)),
  };
}

// parentId → [children] index over a flat stem list (see weber-penn topology).
function childrenMap(stems) {
  const m = new Map();
  for (const s of stems) {
    if (s.parentId == null || s.parentId < 0) continue;
    let a = m.get(s.parentId); if (!a) m.set(s.parentId, a = []);
    a.push(s);
  }
  return m;
}

// A root stem + every descendant (branch + its twigs), gathered depth-first.
function subtreeOf(root, byParent) {
  const out = [root];
  const stack = [root.id];
  while (stack.length) {
    const kids = byParent.get(stack.pop());
    if (!kids) continue;
    for (const k of kids) { out.push(k); stack.push(k.id); }
  }
  return out;
}

// Rebase a WHOLE subtree by ONE shared frame (the root's base/chord), so the
// limb keeps its internal shape but sits base-at-origin, chord-up — the frame
// the placed card is scaled/oriented in. On a curled root whose chord collapses,
// fall back to the base-segment tangent so the whole limb isn't flung sideways.
function rebaseSubtree(subtree, root) {
  const base = root.points[0];
  const chord = chordVec(root, new Vector3());
  if (chord.lengthSq() < 1e-6) chord.copy(root.points[1]).sub(root.points[0]);
  chord.normalize();
  const q = new Quaternion().setFromUnitVectors(chord, new Vector3(0, 1, 0));
  return subtree.map((s) => ({
    ...s,
    points: s.points.map((p) => p.clone().sub(base).applyQuaternion(q)),
    orients: s.orients.map((o) => q.clone().multiply(o)),
  }));
}

// Willow curtain sheets are reusable only while gravity stays in world Y. A
// feeder's pitch therefore cannot be part of the card frame: canonicalize by
// translation + yaw alone, mapping its horizontal chord to local +X. The same
// yaw-only frame is reconstructed for live placement below.
function horizontalStemDir(stem, out) {
  chordVec(stem, out);
  out.y = 0;
  if (out.lengthSq() < 1e-6 && stem.points.length > 1) {
    out.copy(stem.points[1]).sub(stem.points[0]);
    out.y = 0;
  }
  if (out.lengthSq() < 1e-6) {
    out.copy(stem.points[0]);
    out.y = 0;
  }
  if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
  return out.normalize();
}

function stemYawFrame(stem, out = new Quaternion()) {
  const dir = horizontalStemDir(stem, new Vector3());
  // THREE's +Y rotation maps +X to (cos(a), 0, -sin(a)).
  return out.setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(-dir.z, dir.x));
}

function rebaseGravitySubtree(subtree, root) {
  const base = root.points[0];
  const q = stemYawFrame(root).invert();
  return subtree.map((s) => ({
    ...s,
    points: s.points.map((p) => p.clone().sub(base).applyQuaternion(q)),
    orients: s.orients.map((o) => q.clone().multiply(o)),
  }));
}

// Single quad spanning the bake framing, in the SAME stem-local space (origin =
// stem base) so instance transforms are just (base position, chord rotation, scale).
// view 'front' lies in the z=0 plane (the front bake camera's framing); view
// 'side' lies in the x=0 plane matching the SIDE bake camera (at +x looking -x,
// whose screen-right is world -z — so U runs from +z to -z). Both planes contain
// the chord axis, so a crossed pair shares ONE instance transform and the 90° is
// baked into the side quad's vertices — the pair can never shear apart.
function cardQuadGeometry(center, halfW, halfH, view = 'front') {
  const geo = new BufferGeometry();
  const y0 = center.y - halfH, y1 = center.y + halfH;
  if (view === 'side') {
    const z0 = center.z + halfW, z1 = center.z - halfW; // U: +z → -z (side camera's right)
    geo.setAttribute('position', new BufferAttribute(new Float32Array([
      0, y0, z0, 0, y0, z1, 0, y1, z1, 0, y1, z0,
    ]), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array([
      1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
    ]), 3));
  } else {
    const x0 = center.x - halfW, x1 = center.x + halfW;
    geo.setAttribute('position', new BufferAttribute(new Float32Array([
      x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0,
    ]), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]), 3));
  }
  geo.setAttribute('uv', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

// Gravity-aligned curtain clusters use a shallow cylindrical bow instead of a
// flat quad. Crosswise/depth bow gives volume, while an in-plane parabolic drift
// makes the whole LOD2/mobile-near sheet read as an arc even head-on instead of
// a straight rectangular curtain.
function bowedCardGeometry(
  center, halfW, halfH, view = 'front', horizontalScale = 1, verticalScale = 1,
  cols = 5, rows = 7,
) {
  cols = Math.max(2, Math.round(cols));
  rows = Math.max(2, Math.round(rows));
  const crossBow = halfW * 0.18;
  const longBow = Math.min(halfH * 0.18, halfW * 0.55);
  const inPlaneArc = Math.min(halfH * 0.065, halfW * 0.18);
  const surfaceHalfW = Math.max(0.001, halfW - inPlaneArc * 0.5);
  const positions = [], uvs = [], indices = [];
  const y0 = center.y - halfH;
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    // Stretch upward from the hem, never about the centre: the live floor clamp
    // stays exact while a willow-only proxy can recover lost crown-top coverage.
    const y = y0 + v * halfH * 2 * verticalScale;
    const curve = longBow * Math.sin(Math.PI * v);
    // Center both bends and narrow the ruled surface by half the arc excursion.
    // The curved silhouette then stays inside the original baked-card envelope.
    const arc = inPlaneArc * (v * (2 - v) - 0.5);
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const across = u * 2 - 1;
      const depth = crossBow * (1 - across * across) + curve
        - (crossBow + longBow) * 0.5;
      // Compress only the live proxy's horizontal silhouette around its authored
      // view centre. The bake camera + UVs stay full-size, so no source foliage
      // clips; direct LOD0/1 geometry is completely untouched.
      if (view === 'side') positions.push(
        depth * horizontalScale, y, center.z + (-across * surfaceHalfW + arc) * horizontalScale,
      );
      else positions.push(center.x + (across * surfaceHalfW + arc) * horizontalScale, y, depth * horizontalScale);
      uvs.push(u, v);
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = (r + 1) * cols + c, e = d + 1;
      indices.push(a, b, e, a, e, d);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Same material family + dome-normal blend as LOD0 leaves — matched diffuse
// response across the LOD switch is what hides the pop (proxy-normal transfer).
function makeCardMaterial(t, centerUniform, opts = {}) {
  const mat = new MeshSSSNodeMaterial({
    map: t.albedo, normalMap: t.normal, roughnessMap: t.rough,
    alphaTest: 0.35, side: DoubleSide, roughness: 1.0, metalness: 0.0,
  });
  // Canopy-sphere field evaluated from WORLD position via cameraViewMatrix —
  // NOT transformNormalToView, which applies each instance's rotation and makes
  // neighboring crossed cards disagree about the dome (crosshatch shadowing).
  // Same construction as the billboard cards. Baked world-space normals ride
  // on top as additive per-pixel detail.
  const base = positionWorld.sub(centerUniform).normalize().add(vec3(0, 0.45, 0)); // up-bias: never point down
  const detail = texture(t.normal).xyz.mul(2).sub(1);
  const nWorld = base.add(detail.mul(0.45)).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
  // Same canopy sway as the leaves; noFlutter for CROSSED (limb) card sets — the
  // random-phase flutter tears a crossed pair apart at the seam (see wind.js).
  mat.positionNode = foliageWindPosition(!opts.noFlutter);
  const transmit = uniform(new Color().setRGB(...TRANSMIT));
  mat.thicknessColorNode = texture(t.trans).r.mul(attribute('aThickness', 'float')).mul(transmit);
  mat.thicknessDistortionNode = uniform(0.3);
  mat.thicknessAmbientNode = uniform(0.16); // scatter floor — see leaf-cards.js
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(6.0);
  mat.thicknessScaleNode = uniform(3.0);
  mat.userData.gltfDiffuseTransmission = { factor: 1.0, color: TRANSMIT, map: t.trans };
  // Flat proxy cards are receivers neither for N8AO darkening nor crossed-plane
  // crease artifacts. Keep their bent normal in the MRT, but write aomask=0.
  mat.mrtNode = mrt({ output, normal: normalView, aomask: float(0) });
  return mat;
}

/**
 * Bake 2-4 exemplar branch cards for a species, rooted at a chosen branch level.
 * Caller must pause its animation loop (renderer is re-targeted).
 *
 * @param {object} species  shaped species preset (params + foliage reflect GUI)
 * @param {object} assets   cached species assets (barkMat, leafMat, ...)
 * @param {object} opts     { size, variants, cardLevel } — cardLevel defaults to
 *                          the deepest level (per-twig cards); lower levels bake a
 *                          whole limb (branch + twigs + leaves) into one card.
 * @returns {Promise<{variants: Array, centerUniform} | null>}
 */
export async function bakeBranchCards(renderer, species, assets, opts = {}) {
  if (!assets.leafMat || !assets.barkMat) return null;
  const variantCount = opts.variants ?? 3;
  const size = opts.size ?? 512;
  const willowCurtains = species.foliage?.mode === 'willowCurtains';
  const gravityAligned = willowCurtains && !!opts.gravityAligned;
  const crossViews = gravityAligned || !!opts.crossViews;
  const floorMin = species.foliage?.floorMin
    ?? species.foliage?.curtainFloorMin
    ?? species.params?.terminalFloorMin
    ?? 0;

  // Fixed exemplar seed → deterministic cards independent of the live tree seed.
  const rng = new Rng(`${species.name}:cards`);
  const { stems } = generateSkeleton(species.params, rng);
  const v = new Vector3();
  // Which branch level roots each card. Default = the deepest level (terminal
  // twigs → one card per twig, the classic hybrid LOD). A LOWER cardLevel bakes a
  // whole LIMB (branch + all its twigs + leaves) into ONE card, so reduced/mobile
  // LODs can DELETE that limb's geometry and show a single billboard of it — the
  // AAA "curve toward impostor" (each rung down bakes a bigger slice of the tree).
  const maxLevel = stems[0]?.maxLevel ?? 0;
  const cardLevel = opts.cardLevel ?? maxLevel;
  const byParent = childrenMap(stems);
  const roots = stems.filter((s) => s.level === cardLevel && s.points.length >= 2 && chordVec(s, v).lengthSq() > 1e-4);
  if (!roots.length) return null;

  // Exemplars from spread ARC-length percentiles — variety without atlas bloat.
  // (Arc length, not chord — the chord collapses on curved twigs; see stemArcLen.)
  const sorted = [...roots].sort((a, b) => stemArcLen(a) - stemArcLen(b));
  const picks = [0.25, 0.45, 0.65, 0.85].slice(0, Math.min(variantCount, 4))
    .map((f) => sorted[Math.floor(f * (sorted.length - 1))]);

  const centerUniform = uniform(new Vector3());
  const thicknessRng = new Rng(`${species.name}:cards:thickness`);
  const variants = [];
  for (const [vi, stem] of picks.entries()) {
    // The exemplar is the root's WHOLE subtree, rebased by the root frame. At the
    // default (terminal) level the subtree is just the twig itself, so this stays
    // identical to the old per-twig bake.
    const sourceSubtree = subtreeOf(stem, byParent);
    const sub = gravityAligned
      ? rebaseGravitySubtree(sourceSubtree, stem) : rebaseSubtree(sourceSubtree, stem);
    const subTerminals = sub.filter((s) => s.level === maxLevel);
    const group = new Group();
    // foliageOnly: bake LEAVES only, no twig tube in the card. For hybrid levels
    // that KEEP the real twig skeleton (keepTwigs), a card with the tube baked in
    // duplicates every twig — a cylinder AND a picture of that cylinder side by
    // side (glaring at the mobile near view). Collapse levels, whose real tubes
    // are deleted, bake the full twig+leaves content.
    const guideLevel = species.guideLevel ?? (species.terminalStemsAreGuides ? maxLevel : null);
    const branchStems = guideLevel == null ? sub : sub.filter((s) => s.level !== guideLevel);

    let twigGeo = null;
    if (!opts.foliageOnly && branchStems.length) {
      twigGeo = buildBranchGeometry(branchStems, { tileWorldSize: species.tileWorldSize ?? 1.5 });
      group.add(new Mesh(twigGeo, assets.barkMat));
    }
    const frng = new Rng(`${species.name}:cards:${vi}`);
    // trunkClearRadius culls leaves near the WORLD axis (the real trunk). The exemplar
    // cluster is rebased to the ORIGIN, so leaving it on would cull the ENTIRE cluster
    // (every leaf sits within the radius of x=z=0) → empty cards (the red maple forest
    // "no leaves" bug). It only makes sense against the actual trunk, so force it off here.
    // FOLIAGE-ONLY cards bake their leaves on a STRAIGHTENED twig. The exemplar's
    // random curve put the leaf mass off the chord axis in a direction unrelated
    // to whatever real twig the card lands on — leaves floated in the air beside
    // their branch. (Full-content cards hid this: the baked tube moved WITH its
    // leaves.) Straight along the chord, the leaves hug the real twig underneath
    // — which the mobile near LOD decimates to its chord anyway.
    const leafStems = subTerminals.length ? subTerminals : sub;
    // Willow curtains synthesize their curved vines FROM the real feeder curve.
    // Straightening the foliage-only exemplar would erase their attachment arc.
    const bakeStems = (!opts.foliageOnly || willowCurtains) ? leafStems : leafStems.map((s) => {
      let acc = 0;
      const pts = s.points.map((p, j) => { if (j > 0) acc += p.distanceTo(s.points[j - 1]); return new Vector3(0, acc, 0); });
      return { ...s, points: pts, orients: s.orients.map(() => new Quaternion()) };
    });
    // Ordinary species bake their LOD0 leaves; authored hanging sprays must retain
    // their top-anchor/guide grammar or the bake silently turns them back into leaves.
    const bakeMode = willowCurtains
      ? 'willowCurtains'
      : species.foliage?.mode === 'hangingSprays' ? 'hangingSprays' : 'leaves';
    // The canonical feeder root sits near y=0, so a world-ground hem is invalid
    // during the reusable bake. Live placement clamps the finished sheet instead.
    const bakeCfg = {
      ...(species.foliage || {}), mode: bakeMode, trunkClearRadius: 0,
      hangFloor: null, curtainFloor: null, floor: null, floorMin: null,
      terminalFloor: null, terminalFloorMin: null, disableFloor: true,
      // A crossed pair displays two real views at once, unlike the source
      // geometry where one projection owns each pixel. Bake a stable, slightly
      // thinner willow subset so the pair preserves the airy gaps of the direct
      // vines instead of adding both projections into an opaque fuzzy shell.
      ...(willowCurtains ? {
        vineKeepFraction: species.foliage?.groupedCardVineKeepFraction ?? 1,
      } : {}),
    };
    const leaves = buildFoliage(bakeStems, bakeCfg, frng, assets.leafMat, null);
    if (leaves) group.add(leaves);
    // Fruit bakes INTO the cards (orchard species): the reduced LODs delete
    // the real fruit instances, so without this the tree visibly de-fruits at
    // the LOD2 switch. Anchored on the same (possibly straightened) stems the
    // leaves use — the card rotates as one picture at place time.
    if (species.fruit && assets.fruitGeo && assets.fruitMat) {
      const fruitRng = new Rng(`${species.name}:cards:fruit:${vi}`);
      const perCard = { ...species.fruit, bakeCard: true, maxCount: 5, perBranch: 1 };
      const fruit = buildFruits(bakeStems, perCard, fruitRng, assets.fruitGeo, assets.fruitMat);
      if (fruit) group.add(fruit);
    }
    if (!group.children.length) continue; // foliage-only exemplar with no leaves → nothing to bake

    if (leaves) leaves.computeBoundingBox?.();
    const box = new Box3().setFromObject(group);
    const center = box.getCenter(new Vector3());
    const sz = box.getSize(new Vector3());
    // Each orthographic view frames its own screen-horizontal extent. Using the
    // larger X/Z dimension for both made crossed willow sheets inflate the live
    // crown by 8–14% when the exemplar was much deeper than it was wide.
    const halfWByView = { front: Math.max(0.01, sz.x * 0.51), side: Math.max(0.01, sz.z * 0.51) };
    const halfH = (sz.y / 2) * 1.02;
    const depth = Math.max(sz.x, sz.z) + 2;
    // crossViews (limb sets placed as CROSSED PAIRS): bake a REAL side view too,
    // exactly like the billboard. Reusing the front texture on the 90° twin put
    // imagery at azimuths where the limb has no geometry — the branch-intersection
    // GAPS at the cross seam. Two views agree wherever the planes meet.
    const views = [];
    for (const [name, dir, halfW] of crossViews
      ? [['front', new Vector3(0, 0, 1), halfWByView.front], ['side', new Vector3(1, 0, 0), halfWByView.side]]
      : [['front', new Vector3(0, 0, 1), halfWByView.front]]) {
      const cam = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, depth * 2);
      cam.position.copy(center).addScaledVector(dir, depth);
      cam.lookAt(center);
      views.push({ name, camera: cam });
    }
    const bakedAll = await bakeGroupToTextures(renderer, group, views, { size, dilate: 10 });
    const baked = bakedAll.front;

    // Bake-only geometry is disposable; the card quad is cached across rebuilds.
    twigGeo?.dispose();
    if (leaves) leaves.geometry.dispose();

    // per-instance wind heading×weight + anchor point (sway phase) — values
    // written per rebuild by buildCardFoliage. Weight is PACKED into aWindVec:
    // WebGPU caps pipelines at 8 vertex buffers and the forest twin (which
    // adds aTreeOrigin) sits exactly at that limit.
    const cardGeo = (view) => {
      const halfW = halfWByView[view];
      const horizontalScale = gravityAligned
        ? Math.max(0.5, Math.min(1, species.foliage?.groupedCardHorizontalScale ?? 1))
        : 1;
      const verticalScale = gravityAligned
        ? Math.max(0.75, Math.min(1.5, species.foliage?.groupedCardVerticalScale ?? 1))
        : 1;
      const geo = gravityAligned
        ? bowedCardGeometry(center, halfW, halfH, view, horizontalScale, verticalScale)
        : cardQuadGeometry(center, halfW, halfH, view);
      if (gravityAligned) {
        // Retain the analytic surface recipe so farther mobile rungs can rebuild
        // the same bowed sheet on a cheaper grid without rebaking its texture.
        geo.userData.willowBowed = {
          center: center.toArray(), halfW, halfH, view, horizontalScale, verticalScale,
        };
      }
      geo.userData.shared = true; // disposeTree must NOT free cached card geometry
      addThicknessAttribute(geo, MAX_CARD_INSTANCES, thicknessRng);
      geo.setAttribute('aWindVec', new InstancedBufferAttribute(new Float32Array(MAX_CARD_INSTANCES * 3), 3));
      geo.setAttribute('aAnchorPos', new InstancedBufferAttribute(new Float32Array(MAX_CARD_INSTANCES * 3), 3));
      return geo;
    };
    const geometry = cardGeo('front');
    let side = null;
    if (crossViews && bakedAll.side) {
      const sgeo = cardGeo('side');
      // Matched SSS thickness across the pair — one card must not glow more than
      // its twin when backlit.
      sgeo.attributes.aThickness.array.set(geometry.attributes.aThickness.array);
      side = {
        geometry: sgeo,
        material: makeCardMaterial(bakedAll.side, centerUniform, { noFlutter: opts.noFlutter }),
        textures: bakedAll.side,
      };
    }
    variants.push({
      geometry,
      material: makeCardMaterial(baked, centerUniform, { noFlutter: opts.noFlutter }),
      textures: baked,
      side,
      chordLen: stemArcLen(stem), // ARC length (stable), not the collapsing chord
      minY: center.y - halfH,
      floorMin,
    });
  }
  return variants.length ? {
    variants, centerUniform,
    foliageOnly: !!opts.foliageOnly,
    preserveGuideLength: species.foliage?.mode === 'hangingSprays',
    gravityAligned,
    floorMin,
  } : null;
}

/**
 * Bake TERMINAL ROSETTE BRANCH cards for a dichotomous species (Joshua/yucca):
 * each exemplar is a terminal arm — tube stub + FULL desktop-quality crown and
 * dead-leaf skirt (texture triangles are free, so the card gets the hero look) —
 * baked in one front view. Rosette crowns are near-rotationally-symmetric, so
 * one view serves a 4-way crossed placement (buildCardFoliage {copies: 4}).
 * The far mobile rung replaces every terminal arm (~600 cone tris) with 8 tris.
 */
export async function bakeRosetteCards(renderer, species, assets, opts = {}) {
  if (!assets.rosetteMat || !assets.barkMat) return null;
  const variantCount = Math.min(opts.variants ?? 3, 3);
  const size = opts.size ?? 512;

  // Fixed exemplar seed → deterministic cards independent of the live tree seed.
  const rng = new Rng(`${species.name}:rcards`);
  const skParams = { ...species.params, tipClearance: (species.foliage?.leafLen ?? 0.5) * 0.9 };
  const { terminalStems } = generateDichotomous(skParams, rng);
  const v = new Vector3();
  const terms = (terminalStems ?? []).filter((s) => s.points.length >= 2 && chordVec(s, v).lengthSq() > 1e-4);
  if (!terms.length) return null;
  const sorted = [...terms].sort((a, b) => stemArcLen(a) - stemArcLen(b));
  const picks = [0.3, 0.6, 0.85].slice(0, variantCount).map((f) => sorted[Math.floor(f * (sorted.length - 1))]);

  const centerUniform = uniform(new Vector3());
  const thicknessRng = new Rng(`${species.name}:rcards:thickness`);
  const variants = [];
  for (const [vi, stem] of picks.entries()) {
    // Dichotomous stems may not carry orients — rebase points (and orients when
    // present) by the base/chord frame, and orphan the copy (terminals have no
    // children, but the skirt logic reads .children/.terminal).
    const base = stem.points[0];
    const chord = chordVec(stem, new Vector3()).normalize();
    const q = new Quaternion().setFromUnitVectors(chord, new Vector3(0, 1, 0));
    const local = {
      ...stem,
      terminal: true,
      children: [],
      points: stem.points.map((p) => p.clone().sub(base).applyQuaternion(q)),
      ...(stem.orients ? { orients: stem.orients.map((o) => q.clone().multiply(o)) } : {}),
    };

    const group = new Group();
    // Arm stub tube — plain bark; the full skirt drapes over most of it anyway.
    const tubeGeo = buildMergedMesh([local], { ...species.params, ribDepth: 0, radialSegs: 8 });
    group.add(new Mesh(tubeGeo, assets.barkMat));
    const frng = new Rng(`${species.name}:rcards:${vi}`);
    // FULL crown + skirt (no skirtToBark): the card is a PICTURE of the hero arm.
    const fol = buildYuccaFoliage([local], { ...(species.foliage || {}), density: 1, coneRadialSegs: 8 }, frng, assets.rosetteMat, [local], null);
    if (fol) group.add(fol);
    if (!group.children.length) continue;

    const box = new Box3().setFromObject(group);
    const center = box.getCenter(new Vector3());
    const sz = box.getSize(new Vector3());
    const halfW = (Math.max(sz.x, sz.z) / 2) * 1.02;
    const halfH = (sz.y / 2) * 1.02;
    const depth = Math.max(sz.x, sz.z) + 2;
    const cam = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, depth * 2);
    cam.position.set(center.x, center.y, center.z + depth);
    cam.lookAt(center);
    let baked;
    try {
      baked = (await bakeGroupToTextures(renderer, group, [{ name: 'front', camera: cam }], { size, dilate: 10 })).front;
    } finally {
      // Everything in `fol` is bake-only. buildYuccaFoliage clones the cached
      // cone geometry before adding its private instancing attributes, so free
      // those CLONES and the InstancedMesh buffers. The cone cache and shared
      // rosette material are deliberately left alone.
      tubeGeo.dispose();
      fol?.traverse((o) => {
        if (!o.isInstancedMesh) return;
        if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
        o.dispose();
      });
    }
    if (!baked) continue;

    const geometry = cardQuadGeometry(center, halfW, halfH);
    geometry.userData.shared = true;
    addThicknessAttribute(geometry, MAX_CARD_INSTANCES, thicknessRng);
    geometry.setAttribute('aWindVec', new InstancedBufferAttribute(new Float32Array(MAX_CARD_INSTANCES * 3), 3));
    geometry.setAttribute('aAnchorPos', new InstancedBufferAttribute(new Float32Array(MAX_CARD_INSTANCES * 3), 3));
    variants.push({
      geometry,
      material: makeCardMaterial(baked, centerUniform, { noFlutter: true }),
      textures: baked,
      chordLen: stemArcLen(stem),
    });
  }
  return variants.length ? { variants, centerUniform, rosette: true } : null;
}

/**
 * Exact low-discrepancy stem subset. Ranking only stable stem identity means
 * every lower keep fraction is a strict subset of every higher one, while the
 * returned array retains source order for deterministic card bucketing.
 */
export function stableStemSubset(stems, keepFraction) {
  const keep = Math.max(0, Math.min(1, keepFraction));
  if (keep >= 1) return [...stems];
  if (keep <= 0 || stems.length === 0) return [];
  const golden = 0.6180339887498949;
  const ranked = stems.map((stem, index) => {
    const identity = stem.id ?? index;
    return { stem, identity, score: ((identity + 1) * golden) % 1 };
  }).sort((a, b) => a.score - b.score || a.identity - b.identity);
  const keepN = Math.max(0, Math.min(
    stems.length,
    Math.round(stems.length * keep),
  ));
  const survivors = new Set(ranked.slice(0, keepN).map((entry) => entry.stem));
  return stems.filter((stem) => survivors.has(stem));
}

/**
 * Place one baked card per terminal stem (variant round-robin, random roll
 * about the branch axis). LOD2 passes keepFraction < 1 + a bigger growScale —
 * the SpeedTree "fewer and bigger" volume-preserving reduction.
 * stableKeep replaces Bernoulli thinning with an exact, deterministic,
 * low-discrepancy subset whose survivors nest as keepFraction decreases.
 *
 * @returns {Group} one InstancedMesh per variant
 */
export function buildCardFoliage(terminalStems, cards, rng, opts = {}) {
  const grow = opts.growScale ?? 1.2;
  const keep = opts.keepFraction ?? 1;
  const stableKeep = !!opts.stableKeep;
  // Whole-limb cards (mobile far rungs) place a CROSSED PAIR per limb, like the
  // final billboard. One flat quad per TWIG can vanish edge-on because hundreds of
  // neighbours at random rolls cover for it — but a lone LIMB card IS the canopy
  // where it stands, so edge-on it left a bare pole with streaks. The 90° twin
  // keeps the limb readable from every azimuth for +2 tris per limb.
  // opts.copies overrides the fan count (rosette terminal cards use 4 — the
  // crown is near-rotationally-symmetric, so one bake serves all four planes).
  const copies = opts.copies ?? (opts.crossed ? 2 : 1);
  const { variants, centerUniform } = cards;
  const gravityAligned = !!cards.gravityAligned;
  if (!terminalStems.length || !variants.length) return null;

  // Dome origin at the canopy BOTTOM (same convention as leaf materials — a
  // mid-canopy origin gives downward dome normals below it → black underside).
  const center = new Vector3();
  let minY = Infinity;
  for (const s of terminalStems) {
    center.add(s.points[s.points.length - 1]);
    for (const p of s.points) minY = Math.min(minY, p.y);
  }
  center.divideScalar(terminalStems.length);
  centerUniform.value.set(center.x, Math.min(minY - 0.5, center.y - 1), center.z);

  // Sparse, broad gravity cards cannot tolerate Bernoulli clumps or a fresh
  // random subset at every rung. Rank stable stem IDs by a golden-ratio
  // low-discrepancy score, take the exact requested count, then retain source
  // order for variant bucketing and placement. Thresholding one fixed ranking
  // guarantees that every farther subset is nested in every nearer one.
  const stableSurvivors = stableKeep && keep < 1
    ? new Set(stableStemSubset(terminalStems, keep))
    : null;

  // Bucket each terminal to the NEAREST-SIZE exemplar (by arc length), so the placement
  // scale s = liveArc/exemplarArc stays ~1 and the baked LEAVES don't get scaled up.
  // Round-robin bucketing put long terminals on short-exemplar cards → s up to 4× →
  // giant leaves. Nearest-match keeps every card's leaves ~their true (LOD0) size.
  const buckets = variants.map(() => []);
  for (const stem of terminalStems) {
    if (stableSurvivors ? !stableSurvivors.has(stem) : keep < 1 && rng.next() > keep) continue;
    const a = stemArcLen(stem);
    let best = 0, bestD = Infinity;
    for (let vi = 0; vi < variants.length; vi++) { const d = Math.abs(a - variants[vi].chordLen); if (d < bestD) { bestD = d; best = vi; } }
    buckets[best].push(stem);
  }

  const group = new Group();
  group.name = 'foliage';
  const m = new Matrix4();
  const q = new Quaternion();
  const qRoll = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const chord = new Vector3();
  const Y = new Vector3(0, 1, 0);

  for (const [vi, list] of buckets.entries()) {
    if (!list.length) continue;
    const variant = variants[vi];
    // Crossed pairs with a REAL side bake (variant.side) put the 90° in the SIDE
    // GEOMETRY and give both meshes the SAME instance transform — the two views
    // agree at the seam (no branch-intersection gaps) and can never shear apart.
    // Legacy crossed sets (no side bake) fall back to two rolled copies of the
    // front texture; single-view twig sets stay one mesh, one copy.
    const paired = copies > 1 && variant.side;
    // opts.cloneGeometry: a PRIVATE per-call copy of the card quad. Two LOD
    // rungs placing from the SAME baked set write their per-instance
    // aWindVec/aAnchorPos into the same shared buffers — the rung built second
    // overwrote the first 2N of the earlier rung's 4N entries, so exactly half
    // its cards took the other level's wind frame and slid off their arms.
    // Fresh userData (no `shared` flag) → disposeTree frees the clone.
    const mk = (geo) => {
      const recipe = geo.userData?.willowBowed;
      if (recipe && opts.cardGrid) {
        const g = bowedCardGeometry(
          new Vector3().fromArray(recipe.center),
          recipe.halfW, recipe.halfH, recipe.view,
          recipe.horizontalScale, recipe.verticalScale,
          opts.cardGrid.cols, opts.cardGrid.rows,
        );
        // These are per-instance attributes, not surface attributes. Give each
        // rung private buffers just as cloneGeometry does, so wind writes from a
        // cheaper far rung cannot corrupt the cached/mobile-near sheet.
        for (const name of ['aThickness', 'aWindVec', 'aAnchorPos']) {
          const attr = geo.getAttribute(name);
          if (attr) g.setAttribute(name, attr.clone());
        }
        g.userData = {}; // transient per-rung geometry; dispose with the tree
        return g;
      }
      if (opts.cloneGeometry) {
        const g = geo.clone();
        g.userData = {};
        return g;
      }
      return geo;
    };
    const maxStems = paired
      ? MAX_CARD_INSTANCES
      : Math.floor(MAX_CARD_INSTANCES / Math.max(1, copies));
    const placed = list.length > maxStems ? list.slice(0, maxStems) : list;
    if (placed.length < list.length) {
      console.warn(
        `[SeedThree] Card variant ${vi} requested ${paired ? list.length : list.length * copies} instances; `
        + `clamped to MAX_CARD_INSTANCES (${MAX_CARD_INSTANCES}).`,
      );
    }
    const parts = paired
      ? [{ geo: mk(variant.geometry), mat: variant.material }, { geo: mk(variant.side.geometry), mat: variant.side.material }]
      : [{ geo: mk(variant.geometry), mat: variant.material }];
    const perMesh = paired ? placed.length : placed.length * copies;
    const meshes = parts.map((p, pi) => {
      const im = new InstancedMesh(p.geo, p.mat, perMesh);
      im.name = `cards${vi}${paired ? (pi ? '_side' : '_front') : ''}`;
      return im;
    });
    const weights = new Float32Array(perMesh); // CPU copy for the forest rebinner
    const qChord = new Quaternion();
    const qInv = new Quaternion();
    const wv = new Vector3();
    let k = 0;
    for (const stem of placed) {
      // Sway weight: a per-twig card anchors near the tips, so its BASE weight is
      // already tip-like. A CROSSED limb card replaces the limb's whole canopy —
      // swaying it by the limb root's stiff base weight froze LOD2 while the
      // nearer LODs waved (the wind "mostly stopped" bug). Use the root's TIP
      // weight so the card moves like the foliage it stands in for — EXCEPT when
      // the caller pins windAt:'base' (rosette terminal cards: their joint with
      // the arm stub is visible, and tip amplitude slides the card off the arm).
      const useTip = opts.windAt ? opts.windAt === 'tip' : copies > 1;
      const weight = useTip
        ? (stem.winds?.[stem.winds.length - 1] ?? stem.winds?.[0] ?? 0.6)
        : (stem.winds?.[0] ?? 0.6);
      pos.copy(stem.points[0]);
      chordVec(stem, chord);
      const chordLen = chord.length();
      const refLen = stemArcLen(stem);      // stable size ref (chord collapses on curved twigs)
      if (refLen < 1e-3) continue;
      // Orient along the chord when it's meaningful; on a curled twig whose chord
      // nearly vanishes, fall back to the base-segment tangent so the card isn't
      // wildly mis-aimed (and, crucially, isn't scaled by a near-zero chord).
      if (gravityAligned) stemYawFrame(stem, qChord);
      else if (chordLen > 0.15 * refLen) qChord.setFromUnitVectors(Y, chord.divideScalar(chordLen));
      else qChord.setFromUnitVectors(Y, chord.copy(stem.points[1]).sub(stem.points[0]).normalize());
      // Reusable willow sheets are authored in the yaw frame; rolling them would
      // rotate their baked gravity/hem away from world Y.
      const roll = gravityAligned ? 0 : rng.range(0, Math.PI * 2);
      // Arc-length ratio → ~1 (× grow). FOLIAGE-ONLY cards clamp the ratio hard:
      // the card scales its LEAVES with it, and at the mobile NEAR view a long
      // twig on a short exemplar reads as giant leaves (beech's wide twig-length
      // spread). Leaf size is sacred; a slightly short/long leaf run along the
      // twig is invisible next to wrong-sized leaves.
      let s = (refLen / variant.chordLen) * grow;
      if (cards.foliageOnly && !cards.preserveGuideLength) s = Math.min(1.15, Math.max(0.75, s));
      if (gravityAligned && variant.minY < -1e-4) {
        const floor = variant.floorMin ?? cards.floorMin ?? opts.floorMin;
        if (Number.isFinite(floor)) {
          const allowedDrop = pos.y - floor;
          if (allowedDrop <= 0) continue;
          s = Math.min(s, allowedDrop / -variant.minY);
        }
      }
      if (s < 0.03) continue;
      scl.set(s, s, s);
      const rolls = paired ? [roll] : Array.from({ length: copies }, (_, ci) => roll + ci * Math.PI / copies);
      for (const r of rolls) {
        qRoll.setFromAxisAngle(Y, r);
        q.copy(qChord).multiply(qRoll);
        // wind heading×weight in card-local space + anchor for sway phase (wind.js)
        qInv.copy(q).invert();
        wv.copy(WIND_DIR).applyQuaternion(qInv).multiplyScalar(weight / s);
        m.compose(pos, q, scl);
        for (const im of meshes) { // paired: identical transform on front + side
          im.geometry.attributes.aWindVec.setXYZ(k, wv.x, wv.y, wv.z);
          im.geometry.attributes.aAnchorPos.setXYZ(k, pos.x, pos.y, pos.z);
          im.setMatrixAt(k, m);
        }
        weights[k] = weight;
        k++;
      }
    }
    for (const [meshIndex, im] of meshes.entries()) {
      im.count = k;
      im.userData.windWeights = weights;
      im.instanceMatrix.needsUpdate = true;
      im.geometry.attributes.aWindVec.needsUpdate = true;
      im.geometry.attributes.aAnchorPos.needsUpdate = true;
      im.computeBoundingSphere();
      // Broad gravity-aligned sheets otherwise shadow one another at their
      // intersections, drawing black vertical slits through the grouped crown.
      // Keep one real canopy-shadow caster per crossed pair, but do not let the
      // proxy sheets receive each other's synthetic seam shadows.
      im.castShadow = !gravityAligned || !paired || meshIndex === 0;
      im.receiveShadow = !gravityAligned;
      im.userData.lockShadowPolicy = gravityAligned;
      group.add(im);
    }
  }
  return group.children.length ? group : null;
}

// Forest twin of a card material: identical look, but the canopy-dome normal
// reads its origin from a PER-INSTANCE attribute (aTreeOrigin) instead of the
// hero tree's uniform — otherwise every forest tree shades as if its leaves
// belonged to one giant canopy centred on the hero (the lighting mismatch).
// Cached per source material so rebuilds don't recompile.
const forestMats = new WeakMap();
export function forestCardMaterial(srcMat) {
  let mat = forestMats.get(srcMat);
  if (mat) return mat;
  mat = new MeshSSSNodeMaterial({
    map: srcMat.map, normalMap: srcMat.normalMap, roughnessMap: srcMat.roughnessMap,
    alphaTest: srcMat.alphaTest, side: DoubleSide, roughness: 1.0, metalness: 0.0,
  });
  const base = positionWorld.sub(attribute('aTreeOrigin', 'vec3')).normalize().add(vec3(0, 0.45, 0));
  const detail = srcMat.normalMap ? texture(srcMat.normalMap).xyz.mul(2).sub(1) : vec3(0, 0, 0);
  const nWorld = base.add(detail.mul(0.45)).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
  // Trees INSIDE the shadow frustum (world r < ~74) self-shadow with the real
  // map; beyond it no shadows exist, so the analytic sun-occlusion fades in by
  // world radius to carry the same look — one material, both regimes.
  const treeOrigin = attribute('aTreeOrigin', 'vec3');
  const sunFacing = base.normalize().dot(sunDirectionUniform).mul(0.5).add(0.5);
  const analytic = sunFacing.pow(1.4).mul(0.78).add(0.22);
  const occl = mix(float(1), analytic, treeOrigin.xz.length().smoothstep(float(60), float(90)));
  mat.colorNode = texture(srcMat.map).mul(vec4(occl, occl, occl, 1));
  const transmit = uniform(new Color().setRGB(...TRANSMIT));
  const dtMap = srcMat.userData.gltfDiffuseTransmission?.map;
  mat.thicknessColorNode = (dtMap ? texture(dtMap).r : uniform(1)).mul(attribute('aThickness', 'float')).mul(transmit);
  mat.thicknessDistortionNode = uniform(0.3);
  mat.thicknessAmbientNode = uniform(0.16);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(6.0);
  mat.thicknessScaleNode = uniform(3.0);
  mat.positionNode = foliageWindPosition();
  forestMats.set(srcMat, mat);
  return mat;
}

export function disposeBranchCards(cards) {
  // A facade may hold several per-level sets in `byLevel` (its `variants` alias the
  // deepest set, so iterate byLevel to avoid missing — or double-freeing — a set).
  const sets = cards.byLevel ? [...cards.byLevel.values()] : [cards];
  for (const set of sets) {
    for (const variant of set.variants) {
      for (const tex of Object.values(variant.textures)) tex.dispose();
      forestMats.get(variant.material)?.dispose(); // forest twin shares the maps
      variant.material.dispose();
      variant.geometry.dispose();
      if (variant.side) { // crossed pairs carry a real side view (own bake + quad)
        for (const tex of Object.values(variant.side.textures)) tex.dispose();
        variant.side.material.dispose();
        variant.side.geometry.dispose();
      }
    }
  }
}
