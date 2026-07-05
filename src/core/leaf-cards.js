// Foliage as instanced single-leaf cards, placed the way Blender Sapling / ez-tree
// do it: one quad PER LEAF, anchored at its BASE EDGE on the actual branch
// centerline, oriented by the branch's local frame, tilted off the branch by a
// down-angle, spun around the branch by a phyllotactic angle, and gently bent
// toward light. Base-anchoring is what makes leaves read as attached to the twig
// instead of floating clusters.
//
// Lighting: dome/spherical normals (normal blended toward the outward direction
// from the canopy centre) so foliage shades as a soft volume, not flat cards.

import {
  BufferGeometry, BufferAttribute, InstancedBufferAttribute, InstancedMesh, MeshSSSNodeMaterial,
  Matrix4, Quaternion, Vector3, Color, DoubleSide,
} from 'three/webgpu';
import { positionWorld, normalView, mix, normalize, uniform, texture, attribute, float, normalMap, cameraViewMatrix, vec3, vec4, luminance, color } from 'three/tsl';
import { foliageWindPosition, WIND_DIR } from './wind.js';

// Per-instance random "thickness" (0.4–1) so leaves don't all transmit identically
// when backlit — the key fix for uniform-glow (Unreal PerInstanceRandom style).
export function addThicknessAttribute(geo, count, rng) {
  const thick = new Float32Array(count);
  for (let i = 0; i < count; i++) thick[i] = 0.4 + rng.next() * 0.6;
  geo.setAttribute('aThickness', new InstancedBufferAttribute(thick, 1));
}

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const GOLDEN = (137.5 * Math.PI) / 180;

// Base-anchored leaf quad(s): base edge at y=0, tip at y=1, width along x, normal +Z.
// `quads=2` adds a second quad rotated 90° about the length axis for volume.
function makeLeafGeometry(quads = 2) {
  const positions = [], normals = [], uvs = [], indices = [];
  const base = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
  // v = y so the leaf's petiole (image bottom) sits at the quad base (the twig).
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let b = 0;
  for (let q = 0; q < quads; q++) {
    const a = (q * Math.PI) / quads; // 0, 90°, ...
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i < 4; i++) {
      const [x, y] = base[i];
      positions.push(x * ca, y, x * sa);   // rotate quad about its length (Y) axis
      normals.push(-sa, 0, ca);
      uvs.push(uv[i][0], uv[i][1]);
    }
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    b += 4;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  return g;
}

const DEFAULTS = {
  leavesPerBranch: 14,
  size: 0.55,           // leaf length (m)
  sizeVar: 0.3,
  widthRatio: 0.62,     // leaf width / length
  taper: 0.35,          // shrink toward the branch tip (0..1)
  startFrac: 0.1,       // start foliating this far along the branch
  downAngle: 52,        // leaf pitch off the branch (deg) — always forward of the tangent
  downAngleV: 18,
  droop: 22,            // gravity droop toward the ground (deg) — FloraSynth-style sag
  droopV: 12,
  bend: 0,             // 0..1 bend toward light; >0 can rake leaves back toward the base
  quads: 2,
  tint: 0x88a24a,
  alphaTest: 0.4,
  trunkClearRadius: 0, // >0: cull leaves whose anchor sits within this radius of the
                       // trunk axis — removes the occluded on-trunk leaves that pile
                       // into a "bundle" hugging the lower trunk (per-species opt-in)
  domeStrength: 0.45,   // canopy-volume hint; balances flat-card shadowing vs washout
  // SpeedTree-style cluster sprays (far fewer instances than single leaves,
  // placed with the same leaf grammar — see buildFoliage).
  mode: 'leaves',        // 'leaves' | 'clusters'
  clustersPerBranch: 3,
  clusterSize: 1.3,      // spray card span (m) ≈ a terminal branch's leafy run
  clusterSizeVar: 0.3,
  clusterQuads: 2,       // crossed base-anchored planes per spray
};

/**
 * @param {Array} terminalStems  deepest-level stems (each has .points and .orients)
 * @param {object} assets  { leafTexture }
 * @param {object} cfg
 * @param {import('./rng.js').Rng} rng
 */
// Foliage material is created ONCE per species and reused across rebuilds, so
// editing tree shape never recreates the node material (which would force a
// WebGPU pipeline recompile and blink the leaves out). The canopy-centre uniform
// for the dome normals is updated per rebuild instead.
export function makeFoliageMaterial(assets, cfg) {
  const c = { ...DEFAULTS, ...cfg };
  // Cluster mode is only the no-bakes fallback now (LOD cards bake from LOD0),
  // so it simply reuses the single-leaf map set.
  const tex = assets.leafTexture;
  const texNormal = assets.leafNormal;
  const texRoughness = assets.leafRoughness;
  const texTranslucency = assets.leafTranslucency;
  const mat = new MeshSSSNodeMaterial({
    map: tex ?? null,
    color: new Color(c.tint),
    roughness: 0.82, metalness: 0.0,
    side: DoubleSide,
    alphaTest: tex ? c.alphaTest : 0,
    transparent: false,
  });
  if (texNormal) mat.normalMap = texNormal; // also exports to glTF
  if (texRoughness) { mat.roughnessMap = texRoughness; mat.roughness = 1.0; }

  // Tint as a luminance-preserving COLORIZE (not a multiply/overlay). The base is
  // the texture × the species' subtle baseline tint (default look preserved); the
  // user tint interpolates the base's color toward `tintNode` by `tintAmount`,
  // keeping the leaf's own light/dark detail via its luminance. amount 0 = raw
  // texture; amount 1 = fully recolored (e.g. green → autumn red without going
  // muddy). The ×1.7 lifts the mid-luminance recolor so a saturated tint doesn't
  // darken the canopy. Live-editable via the returned uniforms.
  const tintNode = uniform(new Color(cfg.leafColorize ?? 0xffffff));
  const tintAmount = uniform(cfg.leafTintAmount ?? 0);
  if (tex) {
    const texel = texture(tex);
    // Baseline species tint, multiplied in LINEAR space to match the old
    // constructor `color:` path (the sampled sRGB texture is already linearised, so
    // the tint must be too — else the canopy desaturates/greys).
    const tl = new Color(c.tint).convertSRGBToLinear();
    const base = texel.rgb.mul(vec3(tl.r, tl.g, tl.b));
    // Luminance-PRESERVING colorize: scale the tint so the recolored leaf keeps the
    // base's own brightness (recolor luminance == base luminance), then interpolate.
    // Dividing by the tint's luminance is what stops a dark/saturated tint (e.g. red,
    // luminance ~0.2) from crushing the whole canopy to black — it only swaps hue.
    const recolor = tintNode.mul(luminance(base).div(luminance(tintNode).max(0.08))).clamp(0, 1);
    mat.colorNode = mix(base, recolor, tintAmount);
    // Overriding colorNode detaches the map from the alpha path, so restore the
    // cutout explicitly: opacity = the leaf texture's alpha (alphaTest still clips it).
    mat.opacityNode = texel.a;
  }

  const centerUniform = uniform(new Vector3());
  // Up-biased canopy dome: no foliage normal ever points down (down-facing
  // normals sample the dark ground hemisphere → pitch-black lower canopy).
  const domeWorld = normalize(positionWorld.sub(centerUniform)).add(vec3(0, 0.45, 0));
  // Foliage shades PURELY by canopy-dome position + per-pixel leaf relief.
  // Any geometric-card-normal share lets crossed neighbors disagree (one card
  // lit, its intersecting partner dark — the crosshatch bug), so the card
  // orientation must contribute nothing:
  //  - dome: WORLD vector → view via cameraViewMatrix (immune to instance spin;
  //    transformNormalToView would rotate it per leaf)
  //  - relief: the normal map's DELTA from the flat card normal, added on top —
  //    orientation cancels out, veins/quilting survive
  const domeView = cameraViewMatrix.mul(vec4(domeWorld, 0)).xyz.normalize();
  const relief = texNormal ? normalMap(texture(texNormal)).sub(normalView) : float(0);
  mat.normalNode = normalize(domeView.add(relief.mul(0.9)));
  mat.positionNode = foliageWindPosition(); // canopy sway + per-instance flutter
  // Backlit translucency (Barré-Brisebois SSS) — leaves glow when lit from behind,
  // which is what makes foliage read as living leaves instead of flat albedo cards.
  // Backlit transmission = (per-texel translucency map) × (per-instance random) ×
  // desaturated transmitted green. The per-instance term is what breaks the
  // "every leaf glows the same" look; ambient=0 removes the flat glow floor.
  // (Engine-translucency research: Unreal Two-Sided Foliage / Barré-Brisebois.)
  const transmit = uniform(new Color().setRGB(0.42, 0.62, 0.24));
  const perTexel = texTranslucency ? texture(texTranslucency).r : float(1);
  mat.thicknessColorNode = perTexel.mul(attribute('aThickness', 'float')).mul(transmit);
  mat.thicknessDistortionNode = uniform(0.3);
  // Small scatter floor: canopies aren't black inside — light bounces through
  // the leaves. Runs through the per-texel translucency, so it reads as tissue
  // glow, not flat wash (0 killed the lower canopy entirely under dome normals).
  mat.thicknessAmbientNode = uniform(0.16);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(6.0);
  mat.thicknessScaleNode = uniform(3.0);
  // Carry the translucency data for glTF export: our live SSS is a custom TSL node
  // that GLTFExporter can't serialize, so the export-glb plugin reads this to write
  // the standard KHR_materials_diffuse_transmission extension (leaf transmission).
  mat.userData.gltfDiffuseTransmission = {
    factor: 1.0,
    color: [0.42, 0.62, 0.24],
    map: texTranslucency ?? null,
  };
  return { material: mat, centerUniform, tintNode, tintAmount };
}

export function buildFoliage(terminalStems, cfg, rng, material, centerUniform) {
  let c = { ...DEFAULTS, ...cfg };
  if (c.mode === 'clusters') {
    // Cluster sprays ride the EXACT same placement grammar as single leaves —
    // same branch-frame anchoring, down-angle, phyllotaxy, droop — just fewer,
    // bigger cards. Placement parity is what keeps LOD1+ matching LOD0's
    // silhouette; the old free-floating rosette clumps read as a different tree.
    c = {
      ...c,
      leavesPerBranch: c.clustersPerBranch,
      size: c.clusterSize,
      sizeVar: c.clusterSizeVar,
      quads: c.clusterQuads,
      startFrac: 0.35,   // sprays cover the leafy zone, not the bare branch base
      taper: 0.25,       // tip sprays only slightly smaller
      widthRatio: 1.0,   // the spray texture is square
    };
  }
  if (!terminalStems.length || c.leavesPerBranch <= 0) return null;

  const center = new Vector3();
  let minY = Infinity, maxY = -Infinity;
  for (const s of terminalStems) {
    center.add(s.points[s.points.length - 1]);
    for (const p of s.points) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  }
  const crownSpan = Math.max(0.5, maxY - minY);
  center.divideScalar(terminalStems.length);
  // Dome origin sits at the canopy BOTTOM (billboard-style). At the centroid,
  // every leaf below it gets a downward dome normal that no up-bias can save —
  // the black-underside bug.
  if (centerUniform) centerUniform.value.set(center.x, Math.min(minY - 0.5, center.y - 1), center.z);

  const geo = makeLeafGeometry(c.quads);
  const count = terminalStems.length * c.leavesPerBranch;
  const windBase = new Float32Array(count);     // twig wind weight at each leaf's anchor
  const windVec = new Float32Array(count * 3);  // wind heading in instance-local space
  const anchorPos = new Float32Array(count * 3); // anchor point in tree space (sway phase)
  const qInv = new Quaternion();
  const wv = new Vector3();
  const mesh = new InstancedMesh(geo, material, count);
  mesh.name = 'foliage';

  const m = new Matrix4();
  const q = new Quaternion();
  const qFrame = new Quaternion();
  const q1 = new Quaternion();
  const q2 = new Quaternion();
  const qb = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const n = new Vector3();
  const droopAxis = new Vector3();

  let idx = 0;
  for (const stem of terminalStems) {
    const pts = stem.points, oris = stem.orients;
    const segN = pts.length - 1;
    let phyllo = rng.range(0, Math.PI * 2);

    for (let i = 0; i < c.leavesPerBranch; i++) {
      const frac = c.startFrac + (1 - c.startFrac) * ((i + rng.next()) / c.leavesPerBranch);
      const fseg = Math.min(segN - 1, Math.floor(frac * segN));
      const ft = frac * segN - fseg;
      pos.copy(pts[fseg]).lerp(pts[fseg + 1], ft);
      // Drop leaves that anchor inside the bare trunk column — those pile into a
      // visible bundle on the thick LOWER trunk. TAPER the radius to 0 by ~65% up the
      // crown: near the top the "trunk" is just the thin leader and its short twigs sit
      // close to the axis, so a flat cull there strips the crown tip → a bare leader
      // spire poking out. Full clearance low, none high.
      if (c.trunkClearRadius > 0) {
        const hFrac = (pos.y - minY) / crownSpan;
        const effClear = c.trunkClearRadius * Math.max(0, 1 - hFrac / 0.65);
        if (effClear > 0 && Math.hypot(pos.x, pos.z) < effClear) continue;
      }
      qFrame.copy(oris[fseg]).slerp(oris[fseg + 1], ft); // branch frame: local +Y = tangent
      // twig's fork-continuous wind weight at this exact anchor point
      windBase[idx] = stem.winds
        ? stem.winds[fseg] * (1 - ft) + stem.winds[fseg + 1] * ft
        : 0.9;

      // qLeaf = frame · phyllo(about tangent Y) · downAngle(about X)
      phyllo += GOLDEN + rng.vary(0, 0.3);
      const down = (c.downAngle + rng.vary(0, c.downAngleV)) * Math.PI / 180;
      q1.setFromAxisAngle(X, down);
      q2.setFromAxisAngle(Y, phyllo);
      q.copy(qFrame).multiply(q2).multiply(q1);

      // Gentle bend toward light (Weber-Penn LeafBend, Y-up): lift the leaf normal
      // toward world up so leaves present up-and-outward.
      if (c.bend > 0) {
        n.set(0, 0, 1).applyQuaternion(q);
        const tpos = Math.atan2(pos.z, pos.x);
        const tbend = tpos - Math.atan2(n.z, n.x);
        qb.setFromAxisAngle(UP, c.bend * tbend);
        q.premultiply(qb);
        n.set(0, 0, 1).applyQuaternion(q);
        const fbend = Math.atan2(Math.hypot(n.x, n.z), n.y);
        qb.setFromAxisAngle(X, c.bend * fbend);
        q.multiply(qb);
      }

      // Gravity droop (FloraSynth foliageAngle): sag each leaf toward the ground.
      if (c.droop > 0) {
        n.set(0, 1, 0).applyQuaternion(q);       // current leaf length direction
        droopAxis.crossVectors(n, DOWN);
        if (droopAxis.lengthSq() > 1e-6) {
          droopAxis.normalize();
          qb.setFromAxisAngle(droopAxis, (c.droop + rng.vary(0, c.droopV)) * Math.PI / 180);
          q.premultiply(qb);
        }
      }

      const s = c.size * (1 - c.taper * frac) * (1 + rng.vary(0, c.sizeVar));
      scl.set(s * c.widthRatio, s, s);
      // wind heading into this leaf's local frame (inverse rotation, inverse
      // scale) so the instance transform maps it back to the true world wind
      qInv.copy(q).invert();
      wv.copy(WIND_DIR).applyQuaternion(qInv);
      // weight premultiplied into the vector (WebGPU 8-vertex-buffer budget)
      windVec[idx * 3] = (wv.x / scl.x) * windBase[idx];
      windVec[idx * 3 + 1] = (wv.y / scl.y) * windBase[idx];
      windVec[idx * 3 + 2] = (wv.z / scl.z) * windBase[idx];
      anchorPos[idx * 3] = pos.x;
      anchorPos[idx * 3 + 1] = pos.y;
      anchorPos[idx * 3 + 2] = pos.z;
      m.compose(pos, q, scl);
      mesh.setMatrixAt(idx++, m);
    }
  }
  addThicknessAttribute(geo, count, rng);
  geo.setAttribute('aWindVec', new InstancedBufferAttribute(windVec, 3));
  geo.setAttribute('aAnchorPos', new InstancedBufferAttribute(anchorPos, 3));
  geo.userData.windWeights = windBase; // CPU-side copy (probes/forest tiling)
  mesh.count = idx;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

// (Cluster placement now shares buildFoliage's leaf grammar — the old
// free-floating rosette builder is gone.)
