// Saguaro spine clusters (areoles).
//
// A real saguaro carries its spines in AREOLES — little felt buttons marching in
// tidy vertical rows straight down the crest of every rib. We reproduce that as a
// merged mesh of crossed alpha cards:
//   - GEOMETRY: two planes crossed 90° about the OUTWARD surface normal (a
//     billboard cross), NOT a cone — per the user's spec. One plane runs along the
//     rib (aligned to the stem tangent), the other across it.
//   - BENT VERTEX NORMALS: each card's normals fan radially out of a centre dropped
//     below the base (like impostor.js's bent-normal cards), so the flat cross reads
//     as a rounded 3-D spine tuft instead of a flat decal, and the two planes agree
//     where they intersect (no shading seam).
//   - EMBEDDED HALFWAY: the card base is sunk ~embed·H into the flesh so there's no
//     floating gap or hard bottom edge — the areole appears to grow OUT of the skin.
//   - PLACEMENT: seated on the EXACT rib-crest vertices (dichotomous.js hands us the
//     crest frame in geometry.userData.ribCrests), so buttons + spines land dead on
//     the ridge peaks.
//
// Wind: a plain (non-instanced) Mesh whose positionNode is barkWindPosition() with
// per-vertex aWind + aStemCenter copied from the anchor ring — so each cluster sways
// byte-identically to the flesh it grows from (no detachment on arm tips). The whole
// card shares one anchor weight/phase → it rides along rigidly, which is right for a
// stiff spine cluster.

import { BufferGeometry, BufferAttribute, Mesh, MeshSSSNodeMaterial, Vector3, Color, DoubleSide } from 'three/webgpu';
import { texture, uniform, shadow } from 'three/tsl';
import { barkWindPosition } from './wind.js';

const SPINE_TRANSMIT = [0.86, 0.78, 0.42]; // hot straw-gold backlight halo of sunlit spines

// Spine material — waxy pale spines that GLOW when backlit (the classic saguaro
// halo). aSpine marks this mesh so the off-thread impostor baker rebuilds the same
// material (see bake-transfer matKindOf).
export function makeSpineMaterial(assets, sunLight = null) {
  const mat = new MeshSSSNodeMaterial({
    map: assets.leafTexture ?? null,           // saguaro_spines_albedo (alpha card)
    color: assets.leafTexture ? 0xffffff : 0xd9c9a0,
    roughness: 0.85, metalness: 0,
    side: DoubleSide,
    alphaTest: assets.leafTexture ? 0.4 : 0, transparent: false,
  });
  if (assets.leafNormal) mat.normalMap = assets.leafNormal;
  if (assets.leafRoughness) { mat.roughnessMap = assets.leafRoughness; mat.roughness = 1.0; }
  // Backlit transmission — thin spines light up gold with the sun behind them. three's
  // SSS transmission is NOT dimmed by the shadow map on its own (receiveShadow only
  // darkens the diffuse), so an areole on the cactus's SHADOWED back would glow straight
  // through the opaque body. REAL fix: multiply the transmission by shadow(sunLight) —
  // the actual cast-shadow-map sample for THIS fragment — so the body's own shadow kills
  // the glow on its occluded side while the sunlit silhouette rim keeps its full halo.
  // No analytic hemisphere math. (Worker bake passes no light → plain glow, fine for the
  // flat impostor.)
  const transmit = uniform(new Color().setRGB(...SPINE_TRANSMIT));
  const transBase = assets.leafTranslucency ? transmit.mul(texture(assets.leafTranslucency).r) : transmit;
  // shadow() needs BOTH the light AND its shadow object (shadow(light, light.shadow)) —
  // passing only the light returns "lit" everywhere (why the back spines still glowed).
  mat.thicknessColorNode = (sunLight && sunLight.shadow) ? transBase.mul(shadow(sunLight, sunLight.shadow)) : transBase;
  mat.thicknessDistortionNode = uniform(0.35);
  mat.thicknessAmbientNode = uniform(0.03); // low floor → shadow-side spines stay dark
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(5.0);
  mat.thicknessScaleNode = uniform(2.5);
  mat.userData.gltfDiffuseTransmission = { factor: 1.0, color: SPINE_TRANSMIT, map: assets.leafTranslucency ?? null };
  mat.positionNode = barkWindPosition(); // sway with the flesh (aWind + aStemCenter)
  return mat;
}

const DEFAULTS = {
  size: 0.13,       // spine-card height (m) — a few cm of spine, scene-scaled
  widthFrac: 0.85,  // card width as a fraction of height
  embed: 0.45,      // fraction of the card sunk into the flesh (halfway-ish)
  sizeVar: 0.25,    // per-areole size jitter
  density: 1,       // LOD dial: fraction of crest anchors kept
  splay: 1.0,       // bent-normal fan strength
};

const _t1 = new Vector3(), _t2 = new Vector3(), _wp = new Vector3(), _nn = new Vector3();

/**
 * Build (or rewrite in place) the merged spine mesh for a fluted cactus.
 * @param {Array}  crestAnchors  geometry.userData.ribCrests from buildMergedMesh
 * @param {object} cfg           { size, widthFrac, embed, density, ... }
 * @param {Rng}    rng
 * @param {Material} material     shared spine material (assets.spineMat)
 * @param {Mesh}   [reuseMesh]    rewrite this mesh's geometry buffers in place
 * @returns {Mesh|null}
 */
export function buildCactusSpines(crestAnchors, cfg, rng, material, reuseMesh = null) {
  const c = { ...DEFAULTS, ...cfg };
  if (!crestAnchors || !crestAnchors.length || c.density <= 0) {
    if (reuseMesh) { reuseMesh.geometry.setDrawRange(0, 0); reuseMesh.visible = false; }
    return reuseMesh ?? null;
  }

  const pos = [], nrm = [], uvs = [], wind = [], center = [], spine = [], idx = [];
  const H = c.size, W = c.size * c.widthFrac;
  const hLow = -H * c.embed, hHigh = H * (1 - c.embed);
  const halfW = W * 0.5;
  // Two crossed planes: plane A spans (widthDir=T1, up=N); plane B spans (T2, N).
  // Corner order per plane: 0=base-left 1=base-right 2=tip-left 3=tip-right.
  const corners = [[-1, hLow], [1, hLow], [-1, hHigh], [1, hHigh]];

  const emitPlane = (P, N, wdir, w, sc) => {
    const b0 = pos.length / 3;
    for (const [xs, h] of corners) {
      const x = xs * halfW * sc;
      const hh = h * sc;
      _wp.copy(P).addScaledVector(wdir, x).addScaledVector(N, hh);
      pos.push(_wp.x, _wp.y, _wp.z);
      // Bent normal: radial from a centre dropped below the base along −N, in the
      // (wdir, N) plane → base points out along N, edges fan toward the rim, and
      // both planes agree on the shared N axis (no cross seam).
      _nn.copy(wdir).multiplyScalar(xs * c.splay).addScaledVector(N, (hh / H) + 0.55);
      if (_nn.lengthSq() < 1e-8) _nn.copy(N);
      _nn.normalize();
      nrm.push(_nn.x, _nn.y, _nn.z);
      uvs.push((xs * 0.5 + 0.5), (h - hLow) / H); // V: base→0, tip→1
      wind.push(w); center.push(P._c.x, P._c.y, P._c.z); spine.push(1);
    }
    idx.push(b0, b0 + 1, b0 + 2, b0 + 2, b0 + 1, b0 + 3);
  };

  for (const a of crestAnchors) {
    if (c.density < 1 && rng.next() > c.density) continue;
    const N = a.normal;
    // T1 = stem tangent flattened into the tangent plane (areole rows run DOWN the
    // rib); T2 = N × T1 (across the rib). Crossed 90° about N.
    _t1.copy(a.tangent).addScaledVector(N, -a.tangent.dot(N));
    if (_t1.lengthSq() < 1e-8) { _t1.set(N.z, N.x, N.y); _t1.addScaledVector(N, -_t1.dot(N)); }
    _t1.normalize();
    _t2.crossVectors(N, _t1).normalize();
    const sc = 1 + rng.vary(0, c.sizeVar);
    // On a THIN stem (arm tips), the embed depth can exceed the flesh radius and
    // the card base would poke out the far side through the axis. Push the whole
    // card OUT along the normal so its base stays inside the flesh, not past it.
    const push = Math.max(0, H * c.embed * sc - a.radius);
    const P = a.pos.clone().addScaledVector(N, push); P._c = a.center; // stash centerline for wind phase
    emitPlane(P, N, _t1, a.wind, sc);
    emitPlane(P, N, _t2, a.wind, sc);
  }

  const g = reuseMesh ? reuseMesh.geometry : new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('aWind', new BufferAttribute(new Float32Array(wind), 1));
  g.setAttribute('aStemCenter', new BufferAttribute(new Float32Array(center), 3));
  g.setAttribute('aSpine', new BufferAttribute(new Float32Array(spine), 1)); // material-kind marker for the baker
  g.setIndex(idx);
  g.setDrawRange(0, idx.length);
  g.computeBoundingSphere();
  g.computeBoundingBox();

  if (reuseMesh) { reuseMesh.visible = true; return reuseMesh; }
  const mesh = new Mesh(g, material);
  mesh.name = 'cactus_spines';
  mesh.castShadow = true; mesh.receiveShadow = true; // body shadow darkens the near-side spines' diffuse
  mesh.frustumCulled = false;
  return mesh;
}
