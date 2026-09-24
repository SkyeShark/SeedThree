// Fruit instancing: small GLB assets (Orrery/Tripo-generated, retopoed + baked)
// hung from the terminal twigs by the same branch-frame anchoring the leaf
// grammar uses. The GLB is authored "standing" (stem up, body below); its
// geometry is re-origined to the STEM TIP so an identity-rotated instance
// hangs naturally from its anchor point, and wind rides the exact
// foliage sway path (aWindVec/aAnchorPos, no flutter — fruit is heavy).

import {
  InstancedMesh, InstancedBufferAttribute, Matrix4, Quaternion, Vector3,
  MeshStandardNodeMaterial, Box3, DoubleSide, BufferGeometry, Float32BufferAttribute,
} from 'three/webgpu';
import { foliageWindPosition, WIND_DIR } from './wind.js';

const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);

// Re-origin a fruit geometry so (0,0,0) sits at the TOP-CENTRE of its bounding
// box (the stem tip). Returns the same geometry, translated in place.
export function prepareFruitGeometry(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, -bb.max.y, -cz);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// Node-material twin of the GLB's baked PBR material with the foliage base
// sway (no flutter). Built explicitly — NodeMaterial.clone() drops maps.
export function makeFruitMaterial(srcMat) {
  const mat = new MeshStandardNodeMaterial({
    map: srcMat?.map ?? null,
    normalMap: srcMat?.normalMap ?? null,
    roughnessMap: srcMat?.roughnessMap ?? null,
    metalnessMap: srcMat?.metalnessMap ?? null,
    color: srcMat?.color?.clone?.() ?? 0xffffff,
    // Tripo bakes fruit skins mirror-glossy; under the app's bright sun that
    // reads as plastic. Full factor uses the baked map as authored — the map
    // itself gets a matte lift at bake time (bake_fruit.py roughness boost).
    roughness: 1.0,
    metalness: 0.0,
    side: srcMat?.side ?? DoubleSide,
  });
  mat.positionNode = foliageWindPosition(false);
  return mat;
}

const DEFAULTS = {
  perBranch: 1,     // fruits attempted per terminal twig
  chance: 0.55,     // probability each attempt actually bears a fruit
  startFrac: 0.35,  // fruit zone starts this far along the twig
  scale: 1,         // multiplier on the GLB's authored size
  scaleVar: 0.15,
  tiltVar: 12,      // random hang tilt (deg) off straight down
  maxCount: 120,    // hard cap — a big tree has thousands of twigs, not fruits
};

/**
 * Place fruit instances on terminal stems (same anchoring as buildFoliage).
 * @param {Array} terminalStems  stems with .points/.orients/.winds/.radii
 * @param {object} cfg           species.fruit config (DEFAULTS above)
 * @param {import('./rng.js').Rng} rng
 * @param {BufferGeometry} geometry  prepared (top-origined) fruit geometry
 * @param {Material} material    makeFruitMaterial result (shared per species)
 * @param {Array} [obstacles]    ALL rendered stems — fruit whose body would
 *                               overlap any branch is rejected (no clipping)
 */
export function buildFruits(terminalStems, cfg, rng, geometry, material, obstacles = null) {
  const c = { ...DEFAULTS, ...cfg };
  if (!terminalStems.length || c.perBranch <= 0) return null;
  // Thin the per-attempt chance so the expected total respects maxCount.
  const expected = terminalStems.length * c.perBranch * c.chance;
  if (c.maxCount > 0 && expected > c.maxCount) c.chance *= c.maxCount / expected;
  const cap = terminalStems.length * c.perBranch;
  // Fruit body sphere from the prepared geometry (origin at stem tip, body
  // below): centre sits halfway down, radius covers the widest half-extent.
  const bb = geometry.boundingBox;
  const bodyDrop = -bb.min.y * 0.55;
  const bodyR = Math.max((bb.max.x - bb.min.x), (bb.max.z - bb.min.z), -bb.min.y) * 0.5;

  const geo = geometry.clone(); // per-build instanced attributes live on the clone
  geo.userData.shared = false;
  const m = new Matrix4();
  const q = new Quaternion();
  const qFrame = new Quaternion();
  const qTilt = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const wv = new Vector3();
  const qInv = new Quaternion();
  const _tan = new Vector3();
  const _body = new Vector3();
  const windVec = new Float32Array(cap * 3);
  const anchorPos = new Float32Array(cap * 3);
  const mesh = new InstancedMesh(geo, material, cap);
  mesh.name = 'fruit';

  let idx = 0;
  for (const stem of terminalStems) {
    const pts = stem.points, oris = stem.orients;
    const segN = pts.length - 1;
    for (let i = 0; i < c.perBranch; i++) {
      if (rng.next() > c.chance) continue;
      const frac = c.startFrac + (1 - c.startFrac) * ((i + rng.next()) / c.perBranch);
      const fseg = Math.min(segN - 1, Math.floor(frac * segN));
      const ft = frac * segN - fseg;
      pos.copy(pts[fseg]).lerp(pts[fseg + 1], ft);
      // Steep wood: fruit hanging off a near-vertical run dangles alongside
      // the branch and clips straight through it — only fruiting wood that
      // presents an underside gets fruit. (Card bakes exempt: their exemplar
      // twigs are STRAIGHTENED vertical, and the whole card rotates at place
      // time anyway, so the gate would reject every baked fruit.)
      _tan.subVectors(pts[fseg + 1], pts[fseg]).normalize();
      if (!c.bakeCard && Math.abs(_tan.y) > 0.72) continue;
      qFrame.copy(oris[fseg]).slerp(oris[fseg + 1], ft);
      // drop the anchor to the twig's UNDERSIDE (full radius; tiny bite keeps
      // contact) so the stem tip meets bark instead of centreline air
      const twigR = stem.radii
        ? stem.radii[fseg] * (1 - ft) + stem.radii[fseg + 1] * ft : 0.01;
      pos.y -= twigR * 0.95;
      // Anti-clip: reject anchors whose fruit BODY sphere would overlap any
      // rendered branch (obstacles = all mesh stems, their own twig excluded
      // by the fruit hanging below it).
      if (obstacles) {
        _body.copy(pos); _body.y -= bodyDrop;
        let hit = false;
        for (const ob of obstacles) {
          const opts = ob.points, orad = ob.radii;
          for (let k = 0; k < opts.length && !hit; k++) {
            const rr = (orad ? orad[k] : 0.01) + bodyR * 0.85;
            if (_body.distanceToSquared(opts[k]) < rr * rr && opts[k] !== pts[fseg]) {
              // skip the anchor's own neighbourhood (the twig it hangs from)
              if (opts[k].distanceToSquared(pos) > (twigR + bodyR) ** 2 * 0.9) hit = true;
            }
          }
          if (hit) break;
        }
        if (hit) continue;
      }
      // hang straight down with a small random tilt + free yaw. The fruit's own
      // frame is world-aligned (NOT the twig frame) — gravity owns fruit.
      qTilt.setFromAxisAngle(X, (rng.vary(0, c.tiltVar) * Math.PI) / 180);
      q.setFromAxisAngle(Y, rng.range(0, Math.PI * 2)).multiply(qTilt);

      const s = c.scale * (1 + rng.vary(0, c.scaleVar));
      scl.set(s, s, s);
      const windBase = stem.winds
        ? stem.winds[fseg] * (1 - ft) + stem.winds[fseg + 1] * ft : 0.8;
      qInv.copy(q).invert();
      wv.copy(WIND_DIR).applyQuaternion(qInv);
      windVec[idx * 3] = (wv.x / s) * windBase;
      windVec[idx * 3 + 1] = (wv.y / s) * windBase;
      windVec[idx * 3 + 2] = (wv.z / s) * windBase;
      anchorPos[idx * 3] = pos.x;
      anchorPos[idx * 3 + 1] = pos.y;
      anchorPos[idx * 3 + 2] = pos.z;
      m.compose(pos, q, scl);
      mesh.setMatrixAt(idx++, m);
    }
  }
  if (idx === 0) return null;
  geo.setAttribute('aWindVec', new InstancedBufferAttribute(windVec, 3));
  geo.setAttribute('aAnchorPos', new InstancedBufferAttribute(anchorPos, 3));
  mesh.count = idx;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---- atlas fruit: procedural, leaf-slot geometry ---------------------------
// An alternative to orchard GLB fruit (which carries its own material) for
// species that keep fruit on the leaf texture: a small lathe mesh UV-mapped
// into regions of the species' LEAF ATLAS (a seamless skin swatch wrapped once
// around, a darker swatch copy for the calyx/neck), rendered with the leaf
// material itself, so the tree keeps two materials (bark + leaves). It carries a per-vertex
// aThickness of 0: the leaf material (cfg.atlasFruit) reads that as "solid" →
// true geometric normals, no SSS glow, no flutter. See docs/foliage-materials.md.
//
// cfg: { shape: 'pomegranate' | 'fig', radius (m), segments, atlas: { skin, calyx|neck } }
// The geometry is authored stem-up and re-origined to the stem tip
// (prepareFruitGeometry), exactly like a GLB fruit, so buildFruits hangs it.

// profile: [[y, r, rectKey], …] top (stem) → bottom; y down is negative.
function latheParts(profile, segs, atlas, pos, nrm, uvs, idx) {
  // Arc length along the profile per part → v, so the swatch isn't smeared.
  const rings = [];
  for (let i = 0; i < profile.length; i++) {
    const [y, r, key] = profile[i];
    // Duplicate a ring where the rect changes (hard UV seam between parts).
    if (i > 0 && profile[i - 1][2] !== key) rings.push({ y, r, key: profile[i - 1][2] });
    rings.push({ y, r, key });
  }
  // per-part v extents
  const parts = new Map();
  for (let i = 0; i < rings.length; i++) {
    const k = rings[i].key;
    const prev = i > 0 && rings[i - 1].key === k ? rings[i - 1] : null;
    const e = parts.get(k) ?? { len: 0 };
    rings[i].s = e.len + (prev ? Math.hypot(rings[i].y - prev.y, rings[i].r - prev.r) : 0);
    e.len = rings[i].s;
    parts.set(k, e);
  }
  const base = pos.length / 3;
  for (let i = 0; i < rings.length; i++) {
    const { y, r, key, s } = rings[i];
    const [u0, v0, u1, v1] = atlas[key];
    const len = parts.get(key).len || 1;
    // profile normal from neighbouring rings (same part)
    const a = rings[Math.max(0, i - 1)], b = rings[Math.min(rings.length - 1, i + 1)];
    // perpendicular to the profile tangent (dr, dy): (-dy, dr) in (r, y), flipped outward below
    let nr = -(b.y - a.y), ny = (b.r - a.r);
    const nl = Math.hypot(nr, ny) || 1; nr /= nl; ny /= nl;
    if (nr < 0) { nr = -nr; ny = -ny; }
    for (let j = 0; j <= segs; j++) {
      const t = (j / segs) * Math.PI * 2;
      const c = Math.cos(t), sn = Math.sin(t);
      pos.push(r * c, y, r * sn);
      nrm.push(nr * c, ny, nr * sn);
      uvs.push(u0 + (j / segs) * (u1 - u0), v1 - (s / len) * (v1 - v0));
    }
  }
  const row = segs + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    if (rings[i].key !== rings[i + 1].key) continue; // seam duplicate: no strip
    for (let j = 0; j < segs; j++) {
      const a = base + i * row + j, b = a + row;
      // skip degenerate strips at a closed pole
      if (rings[i].r > 1e-5) idx.push(a, a + 1, b);
      if (rings[i + 1].r > 1e-5) idx.push(a + 1, b + 1, b);
    }
  }
}

// Far-rung twin (LOD1/LOD2): fewer sides and rings, no stalk/neck tube.
export function makeAtlasFruitGeometryLow(cfg) {
  return makeAtlasFruitGeometry({ ...cfg, segments: 6, rings: 4, lowPoly: true });
}

export function makeAtlasFruitGeometry(cfg) {
  const R = cfg.radius ?? 0.045;
  const segs = cfg.segments ?? 10;
  const atlas = cfg.atlas;
  const pos = [], nrm = [], uvs = [], idx = [];
  if (cfg.shape === 'fig') {
    // Pear/teardrop: narrow green neck at the stem, bulbous body, flattened
    // bottom (ostiole). Length ≈ 2.4 R.
    const H = 2.4 * R;
    const prof = [
      [0, 0.12, 'neck'], [-0.06, 0.2, 'neck'], [-0.16, 0.34, 'neck'], [-0.28, 0.55, 'skin'],
      [-0.42, 0.8, 'skin'], [-0.58, 0.97, 'skin'], [-0.73, 1.0, 'skin'], [-0.86, 0.9, 'skin'],
      [-0.95, 0.62, 'skin'], [-1.0, 0.0, 'skin'],
    ].map(([y, r, k]) => [y * H, r * R, k]);
    latheParts(prof, segs, atlas, pos, nrm, uvs, idx);
    // short stalk on top (neck swatch; hero only)
    if (!cfg.lowPoly) latheParts([[0.012, 0.0, 'neck'], [0.012, 0.1 * R, 'neck'], [0, 0.12 * R, 'neck']], 5, atlas, pos, nrm, uvs, idx);
  } else {
    // Pomegranate: slightly oblate globe + a crown-like calyx at the blossom
    // end (bottom): a short neck flaring into 6 pointed sepal teeth.
    const prof = [];
    const rings = cfg.rings ?? 7;
    for (let i = 0; i <= rings; i++) {
      const th = (i / rings) * Math.PI; // 0 top → π bottom
      prof.push([-(1 - Math.cos(th)) * R * 0.93, Math.sin(th) * R, 'skin']);
    }
    // stem stub at the top (hero only)
    if (!cfg.lowPoly) latheParts([[0.01, 0.0, 'calyx'], [0.01, 0.07 * R, 'calyx'], [0, 0.09 * R, 'calyx']], 5, atlas, pos, nrm, uvs, idx);
    latheParts(prof, segs, atlas, pos, nrm, uvs, idx);
    const yb = -1.86 * R; // bottom pole
    // calyx neck (open tube) below the globe (hero only)
    if (!cfg.lowPoly) latheParts([[yb + 0.12 * R, 0.34 * R, 'calyx'], [yb - 0.16 * R, 0.27 * R, 'calyx'], [yb - 0.28 * R, 0.34 * R, 'calyx']], 6, atlas, pos, nrm, uvs, idx);
    // sepal teeth: 6 flared triangles (two-sided by the DoubleSide material)
    const [u0, v0, u1, v1] = atlas.calyx;
    const teeth = 6;
    for (let t = 0; t < teeth; t++) {
      const a0 = ((t - 0.4) / teeth) * Math.PI * 2, a1 = ((t + 0.4) / teeth) * Math.PI * 2, am = (t / teeth) * Math.PI * 2;
      const b = pos.length / 3;
      const yr = cfg.lowPoly ? yb + 0.04 * R : yb - 0.28 * R, rr = cfg.lowPoly ? 0.3 * R : 0.34 * R;
      pos.push(rr * Math.cos(a0), yr, rr * Math.sin(a0), rr * Math.cos(a1), yr, rr * Math.sin(a1),
        0.56 * R * Math.cos(am), yr - 0.42 * R, 0.56 * R * Math.sin(am));
      for (let k = 0; k < 3; k++) nrm.push(Math.cos(am) * 0.6, -0.8, Math.sin(am) * 0.6);
      uvs.push(u0, v0, u1, v0, (u0 + u1) / 2, v1);
      idx.push(b, b + 1, b + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setAttribute('aThickness', new Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.setIndex(idx);
  return prepareFruitGeometry(g);
}
