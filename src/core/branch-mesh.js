// Turn a skeleton (list of stems) into a single merged BufferGeometry of tapered
// generalized cylinders — the Weber-Penn "cross-sections connected into a mesh"
// method. Not THREE.TubeGeometry (which can't taper).
//
// UVs: U wraps around the circumference with the seam vertex duplicated (so the
// bark texture tiles cleanly around the stem); V runs along the length. Both are
// scaled by world size so bark texel density stays roughly constant across the
// trunk and thin twigs. A per-vertex wind weight is baked for the wind shader.

import { BufferGeometry, BufferAttribute, Vector3 } from 'three/webgpu';

const WORLD_UP = new Vector3(0, 1, 0);
const WORLD_X = new Vector3(1, 0, 0);

// Unit tangent of a polyline at index i (central difference in the interior).
function tangentAt(points, i, out) {
  const n = points.length;
  if (i === 0) out.copy(points[1]).sub(points[0]);
  else if (i === n - 1) out.copy(points[n - 1]).sub(points[n - 2]);
  else out.copy(points[i + 1]).sub(points[i - 1]);
  if (out.lengthSq() < 1e-10) out.set(0, 1, 0);
  return out.normalize();
}

/**
 * @param {Array} stems  from generateSkeleton()
 * @param {object} opts   { tileWorldSize } — world meters per bark tile repeat
 *                        { radialScale }  — LOD: scale ring vertex counts (min 3 sides)
 *                        { ringStride }   — LOD: keep every Nth cross-section
 */
export function buildBranchGeometry(stems, opts = {}) {
  const tileWorldSize = opts.tileWorldSize ?? 1.5;
  const radialScale = opts.radialScale ?? 1;
  const ringStride = Math.max(1, Math.round(opts.ringStride ?? 1));

  const positions = [];
  const normals = [];
  const uvs = [];
  const winds = [];
  const centers = []; // stem centerline per vertex → wind sway phase (matches foliage)
  const indices = [];
  let vertBase = 0;

  const radial = new Vector3();
  const pos = new Vector3();
  const tan = new Vector3();
  const nrm = new Vector3();
  const bin = new Vector3();

  for (const stem of stems) {
    const { lobes, lobeDepth } = stem;
    const seg = Math.max(3, Math.round(stem.radialSegments * radialScale));
    // LOD ring decimation: keep every ringStride-th cross-section plus the tip,
    // so all LOD levels share identical stem endpoints (no silhouette pop).
    let points = stem.points, radii = stem.radii, stemWinds = stem.winds ?? null;
    if (ringStride > 1 && points.length > 2) {
      const P = [], R = [], W = [];
      for (let i = 0; i < points.length - 1; i += ringStride) {
        P.push(points[i]); R.push(radii[i]);
        if (stemWinds) W.push(stemWinds[i]);
      }
      P.push(points[points.length - 1]); R.push(radii[radii.length - 1]);
      if (stemWinds) { W.push(stemWinds[stemWinds.length - 1]); stemWinds = W; }
      points = P; radii = R;
    }
    const rings = points.length;
    const ringVerts = seg + 1; // duplicate seam vertex (last == first around)

    // Rotation-minimizing frame (parallel transport) along the stem: a per-ring
    // (normal, binormal) that does NOT inherit the generator's phyllotaxy/split
    // twist, so bark furrows stay aligned instead of swirling diagonally at forks.
    const fN = [], fB = [];
    tangentAt(points, 0, tan);
    nrm.crossVectors(tan, WORLD_UP);
    if (nrm.lengthSq() < 1e-6) nrm.crossVectors(tan, WORLD_X);
    nrm.normalize();
    bin.crossVectors(nrm, tan).normalize(); // B = N×T so (N,B) winding matches outward faces
    fN.push(nrm.clone()); fB.push(bin.clone());
    for (let i = 1; i < rings; i++) {
      tangentAt(points, i, tan);
      nrm.copy(fN[i - 1]).addScaledVector(tan, -fN[i - 1].dot(tan)); // project onto new ring plane
      if (nrm.lengthSq() < 1e-8) {
        nrm.crossVectors(tan, WORLD_UP);
        if (nrm.lengthSq() < 1e-6) nrm.crossVectors(tan, WORLD_X);
      }
      nrm.normalize();
      bin.crossVectors(nrm, tan).normalize(); // B = N×T so (N,B) winding matches outward faces
      fN.push(nrm.clone()); fB.push(bin.clone());
    }

    // Per-stem CONSTANT integer wrap (from a representative radius above the base
    // flare) → furrows run straight up the whole stem and tile seamlessly around,
    // instead of converging into a radial fan where the trunk tapers. Baked into
    // UVs, so it exports cleanly to glTF/other engines.
    const refIdx = Math.min(rings - 1, Math.max(0, Math.floor(rings * 0.25)));
    const circumference = 2 * Math.PI * radii[refIdx];
    // EVEN texel density across every branch size, without stretch:
    //  - thick stems: integer wrap (perfectly seamless around, ~tile-sized texels)
    //  - thin stems (< 3/4 tile around): FRACTIONAL wrap — the twig samples a
    //    proportionally narrow strip of the bark tile, so density stays exactly
    //    uniform. Cost: a micro-seam (the strip's width) along one edge, invisible
    //    at twig scale. The old max(1,·) floor stretched twigs up to ~50:1.
    const wraps = circumference / tileWorldSize;
    const uScale = wraps >= 0.75 ? Math.max(1, Math.round(wraps)) : wraps;
    // V tiles by the true world width of one U tile → texels are EXACTLY square
    // on every stem (equals tileWorldSize on twigs, within integer-rounding of
    // it on thick stems), so no vertical stretch anywhere.
    const tileV = Math.max(0.02, circumference / uScale);
    let vAlong = 0;
    let lastWind = 0.05;
    for (let i = 0; i < rings; i++) {
      if (i > 0) vAlong += points[i].distanceTo(points[i - 1]);
      const v = vAlong / tileV;
      const axN = fN[i], axB = fB[i];
      const r = radii[i];

      // Wind weight: the skeleton's fork-continuous field (children inherit
      // the parent's weight where they attach); legacy formula as fallback.
      const alongFrac = i / (rings - 1);
      const levelFrac = stem.maxLevel > 0 ? stem.level / stem.maxLevel : 0;
      const wind = stemWinds
        ? stemWinds[i]
        : Math.min(1, 0.15 + 0.85 * (0.5 * levelFrac + 0.5 * levelFrac * alongFrac + 0.15 * alongFrac));
      lastWind = wind;

      for (let j = 0; j <= seg; j++) {
        const theta = (j / seg) * Math.PI * 2;
        const cos = Math.cos(theta), sin = Math.sin(theta);
        // Ribbed cross-section for cacti (odd lobe counts recommended).
        const lobeMod = lobes > 0 ? 1 + lobeDepth * Math.cos(lobes * theta) : 1;
        const rr = r * lobeMod;

        radial.copy(axN).multiplyScalar(cos).addScaledVector(axB, sin);
        pos.copy(points[i]).addScaledVector(radial, rr);

        positions.push(pos.x, pos.y, pos.z);
        normals.push(radial.x, radial.y, radial.z);
        uvs.push((j / seg) * uScale, v);
        winds.push(wind);
        centers.push(points[i].x, points[i].y, points[i].z);
      }
    }

    // Stitch quads between consecutive rings.
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const a = vertBase + i * ringVerts + j;
        const b = a + 1;
        const c = a + ringVerts;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    // Tip cap: seal the terminal ring when it ends at a real radius (editable
    // taper < 1, or a level that doesn't close to a point). Default trees taper
    // to ~0.002 so the threshold skips them and no cap tris are spent.
    //
    // The cap gets its OWN ring of vertices (duplicating the terminal cross-
    // section) with a FLAT outward-tangent normal and a PLANAR DISC uv projection
    // — NOT the side wall's circumferential U (0..uScale), which fanned to a point
    // smears the bark into a radial star. The disc uv radius is tipR/tileWorldSize
    // so cap texel density matches the walls; it's centred at tile (0.5, 0.5).
    let extraVerts = 0;
    const tipR = radii[rings - 1];
    if (tipR > 0.012) {
      const tp = points[rings - 1];
      tangentAt(points, rings - 1, tan); // outward tip normal (the whole cap faces +tangent)
      const axN = fN[rings - 1], axB = fB[rings - 1];
      const capUVr = tipR / tileWorldSize;
      const capBase = vertBase + rings * ringVerts; // first cap-ring vertex index
      for (let j = 0; j <= seg; j++) {
        const theta = (j / seg) * Math.PI * 2;
        const cos = Math.cos(theta), sin = Math.sin(theta);
        const lobeMod = lobes > 0 ? 1 + lobeDepth * Math.cos(lobes * theta) : 1;
        const rr = tipR * lobeMod;
        radial.copy(axN).multiplyScalar(cos).addScaledVector(axB, sin);
        pos.copy(tp).addScaledVector(radial, rr);
        positions.push(pos.x, pos.y, pos.z);
        normals.push(tan.x, tan.y, tan.z);
        uvs.push(0.5 + capUVr * cos, 0.5 + capUVr * sin);
        winds.push(lastWind);
        centers.push(tp.x, tp.y, tp.z);
      }
      const centerIdx = capBase + (seg + 1);
      positions.push(tp.x, tp.y, tp.z);
      normals.push(tan.x, tan.y, tan.z);
      uvs.push(0.5, 0.5);
      winds.push(lastWind);
      centers.push(tp.x, tp.y, tp.z);
      // Ring verts wind CLOCKWISE around +tangent (radial spins N→B about −T), so
      // centre→ring[j+1]→ring[j] is CCW as seen from outside the tip → front face.
      for (let j = 0; j < seg; j++) indices.push(centerIdx, capBase + j + 1, capBase + j);
      extraVerts = (seg + 1) + 1;
    }

    vertBase += rings * ringVerts + extraVerts;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute('aWind', new BufferAttribute(new Float32Array(winds), 1));
  geo.setAttribute('aStemCenter', new BufferAttribute(new Float32Array(centers), 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}
