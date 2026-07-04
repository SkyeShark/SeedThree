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
  texture, uniform, positionWorld, attribute, cameraViewMatrix, vec3, vec4, float, mix,
} from 'three/tsl';
import { Rng } from './rng.js';
import { generateSkeleton } from './weber-penn.js';
import { buildBranchGeometry } from './branch-mesh.js';
import { buildFoliage, addThicknessAttribute } from './leaf-cards.js';
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

// Single quad spanning the bake framing, in the SAME stem-local space (origin =
// stem base) so instance transforms are just (base position, chord rotation, scale).
function cardQuadGeometry(center, halfW, halfH) {
  const geo = new BufferGeometry();
  const x0 = center.x - halfW, x1 = center.x + halfW;
  const y0 = center.y - halfH, y1 = center.y + halfH;
  geo.setAttribute('position', new BufferAttribute(new Float32Array([
    x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0,
  ]), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

// Same material family + dome-normal blend as LOD0 leaves — matched diffuse
// response across the LOD switch is what hides the pop (proxy-normal transfer).
function makeCardMaterial(t, centerUniform) {
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
  mat.positionNode = foliageWindPosition(); // cards ride the same canopy sway
  const transmit = uniform(new Color().setRGB(...TRANSMIT));
  mat.thicknessColorNode = texture(t.trans).r.mul(attribute('aThickness', 'float')).mul(transmit);
  mat.thicknessDistortionNode = uniform(0.3);
  mat.thicknessAmbientNode = uniform(0.16); // scatter floor — see leaf-cards.js
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(6.0);
  mat.thicknessScaleNode = uniform(3.0);
  mat.userData.gltfDiffuseTransmission = { factor: 1.0, color: TRANSMIT, map: t.trans };
  return mat;
}

/**
 * Bake 2-4 exemplar terminal-branch cards for a species.
 * Caller must pause its animation loop (renderer is re-targeted).
 *
 * @param {object} species  shaped species preset (params + foliage reflect GUI)
 * @param {object} assets   cached species assets (barkMat, leafMat, ...)
 * @returns {Promise<{variants: Array, centerUniform} | null>}
 */
export async function bakeBranchCards(renderer, species, assets, opts = {}) {
  if (!assets.leafMat || !assets.barkMat) return null;
  const variantCount = opts.variants ?? 3;
  const size = opts.size ?? 512;

  // Fixed exemplar seed → deterministic cards independent of the live tree seed.
  const rng = new Rng(`${species.name}:cards`);
  const { stems } = generateSkeleton(species.params, rng);
  const v = new Vector3();
  const terminals = stems.filter((s) => s.level === s.maxLevel && s.points.length >= 2 && chordVec(s, v).lengthSq() > 1e-4);
  if (!terminals.length) return null;

  // Exemplars from spread ARC-length percentiles — variety without atlas bloat.
  // (Arc length, not chord — the chord collapses on curved twigs; see stemArcLen.)
  const sorted = [...terminals].sort((a, b) => stemArcLen(a) - stemArcLen(b));
  const picks = [0.25, 0.45, 0.65, 0.85].slice(0, Math.min(variantCount, 4))
    .map((f) => sorted[Math.floor(f * (sorted.length - 1))]);

  const centerUniform = uniform(new Vector3());
  const thicknessRng = new Rng(`${species.name}:cards:thickness`);
  const variants = [];
  for (const [vi, stem] of picks.entries()) {
    const local = rebaseStem(stem);
    const group = new Group();
    const twigGeo = buildBranchGeometry([local], { tileWorldSize: species.tileWorldSize ?? 1.5 });
    group.add(new Mesh(twigGeo, assets.barkMat));
    const frng = new Rng(`${species.name}:cards:${vi}`);
    // trunkClearRadius culls leaves near the WORLD axis (the real trunk). The exemplar
    // cluster is rebased to the ORIGIN, so leaving it on would cull the ENTIRE cluster
    // (every leaf sits within the radius of x=z=0) → empty cards (the red maple forest
    // "no leaves" bug). It only makes sense against the actual trunk, so force it off here.
    const leaves = buildFoliage([local], { ...(species.foliage || {}), mode: 'leaves', trunkClearRadius: 0 }, frng, assets.leafMat, null);
    if (leaves) group.add(leaves);

    if (leaves) leaves.computeBoundingBox?.();
    const box = new Box3().setFromObject(group);
    const center = box.getCenter(new Vector3());
    const sz = box.getSize(new Vector3());
    const halfW = (Math.max(sz.x, sz.z) / 2) * 1.02;
    const halfH = (sz.y / 2) * 1.02;
    const depth = Math.max(sz.x, sz.z) + 2;
    const cam = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, depth * 2);
    cam.position.set(center.x, center.y, center.z + depth);
    cam.lookAt(center);

    const baked = (await bakeGroupToTextures(renderer, group, [{ name: 'card', camera: cam }], { size, dilate: 10 })).card;

    // Bake-only geometry is disposable; the card quad is cached across rebuilds.
    twigGeo.dispose();
    if (leaves) leaves.geometry.dispose();

    const geometry = cardQuadGeometry(center, halfW, halfH);
    geometry.userData.shared = true; // disposeTree must NOT free cached card geometry
    addThicknessAttribute(geometry, MAX_CARD_INSTANCES, thicknessRng);
    // per-instance wind heading×weight + anchor point (sway phase) — values
    // written per rebuild by buildCardFoliage. Weight is PACKED into aWindVec:
    // WebGPU caps pipelines at 8 vertex buffers and the forest twin (which
    // adds aTreeOrigin) sits exactly at that limit.
    geometry.setAttribute('aWindVec', new InstancedBufferAttribute(new Float32Array(MAX_CARD_INSTANCES * 3), 3));
    geometry.setAttribute('aAnchorPos', new InstancedBufferAttribute(new Float32Array(MAX_CARD_INSTANCES * 3), 3));
    variants.push({
      geometry,
      material: makeCardMaterial(baked, centerUniform),
      textures: baked,
      chordLen: stemArcLen(stem), // ARC length (stable), not the collapsing chord
    });
  }
  return { variants, centerUniform };
}

/**
 * Place one baked card per terminal stem (variant round-robin, random roll
 * about the branch axis). LOD2 passes keepFraction < 1 + a bigger growScale —
 * the SpeedTree "fewer and bigger" volume-preserving reduction.
 *
 * @returns {Group} one InstancedMesh per variant
 */
export function buildCardFoliage(terminalStems, cards, rng, opts = {}) {
  const grow = opts.growScale ?? 1.2;
  const keep = opts.keepFraction ?? 1;
  const { variants, centerUniform } = cards;
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

  // Bucket each terminal to the NEAREST-SIZE exemplar (by arc length), so the placement
  // scale s = liveArc/exemplarArc stays ~1 and the baked LEAVES don't get scaled up.
  // Round-robin bucketing put long terminals on short-exemplar cards → s up to 4× →
  // giant leaves. Nearest-match keeps every card's leaves ~their true (LOD0) size.
  const buckets = variants.map(() => []);
  for (const stem of terminalStems) {
    if (keep < 1 && rng.next() > keep) continue;
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
    const mesh = new InstancedMesh(variant.geometry, variant.material, list.length);
    mesh.name = `cards${vi}`;
    const windVecAttr = variant.geometry.attributes.aWindVec;
    const anchorAttr = variant.geometry.attributes.aAnchorPos;
    const weights = new Float32Array(list.length); // CPU copy for the forest rebinner
    const qInv = new Quaternion();
    const wv = new Vector3();
    let k = 0;
    for (const stem of list) {
      const weight = stem.winds?.[0] ?? 0.6; // twig sway weight at the card's anchor
      pos.copy(stem.points[0]);
      chordVec(stem, chord);
      const chordLen = chord.length();
      const refLen = stemArcLen(stem);      // stable size ref (chord collapses on curved twigs)
      if (refLen < 1e-3) continue;
      // Orient along the chord when it's meaningful; on a curled twig whose chord
      // nearly vanishes, fall back to the base-segment tangent so the card isn't
      // wildly mis-aimed (and, crucially, isn't scaled by a near-zero chord).
      if (chordLen > 0.15 * refLen) q.setFromUnitVectors(Y, chord.divideScalar(chordLen));
      else q.setFromUnitVectors(Y, chord.copy(stem.points[1]).sub(stem.points[0]).normalize());
      qRoll.setFromAxisAngle(Y, rng.range(0, Math.PI * 2)); // roll about the branch axis
      q.multiply(qRoll);
      const s = (refLen / variant.chordLen) * grow; // arc-length ratio → ~1 (× grow), never explodes
      scl.set(s, s, s);
      // wind heading×weight in card-local space + anchor for sway phase (wind.js)
      qInv.copy(q).invert();
      wv.copy(WIND_DIR).applyQuaternion(qInv).multiplyScalar(weight / s);
      windVecAttr.setXYZ(k, wv.x, wv.y, wv.z);
      anchorAttr.setXYZ(k, pos.x, pos.y, pos.z);
      weights[k] = weight;
      m.compose(pos, q, scl);
      mesh.setMatrixAt(k++, m);
    }
    mesh.count = k;
    mesh.userData.windWeights = weights;
    mesh.instanceMatrix.needsUpdate = true;
    windVecAttr.needsUpdate = true;
    anchorAttr.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
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
  for (const variant of cards.variants) {
    for (const tex of Object.values(variant.textures)) tex.dispose();
    forestMats.get(variant.material)?.dispose(); // forest twin shares the maps
    variant.material.dispose();
    variant.geometry.dispose();
  }
}
