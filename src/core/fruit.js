// Fruit instancing: small GLB assets (Orrery/Tripo-generated, retopoed + baked)
// hung from the terminal twigs by the same branch-frame anchoring the leaf
// grammar uses. The GLB is authored "standing" (stem up, body below); its
// geometry is re-origined to the STEM TIP so an identity-rotated instance
// hangs naturally from its anchor point, and wind rides the exact
// foliage sway path (aWindVec/aAnchorPos, no flutter — fruit is heavy).

import {
  InstancedMesh, InstancedBufferAttribute, Matrix4, Quaternion, Vector3,
  MeshStandardNodeMaterial, Box3, DoubleSide,
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
