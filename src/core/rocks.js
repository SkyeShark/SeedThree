// Procedural scatter rocks: noise-displaced icosahedra (a few reusable variants,
// many placements), textured with the biome rock PBR set via TRIPLANAR
// projection — displaced blobs have no sane UVs, triplanar needs none.
// Deterministic per (biome, seed).

import {
  Group, InstancedMesh, IcosahedronGeometry, MeshStandardNodeMaterial,
  Vector3, Matrix4, Quaternion, Euler, BackSide,
} from 'three/webgpu';
import { texture, triplanarTexture, float, vec3, vec4, normalView, normalize, cameraViewMatrix } from 'three/tsl';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from './rng.js';

function displaceRock(rawGeo, rng, squash) {
  // PolyhedronGeometry is NON-indexed (verts duplicated per face): displacing
  // duplicates independently tears the surface open and forces facet normals.
  // Weld first → displace each unique vertex once → smooth normals.
  const geo = mergeVertices(rawGeo);
  rawGeo.dispose();
  const pos = geo.attributes.position;
  const v = new Vector3();
  // SMOOTH boulder silhouettes only — gentle low-frequency lumps from a few
  // random plane waves. All surface detail (ridges, cracks, grain) comes from
  // the texture maps, not the geometry.
  const waves = Array.from({ length: 4 }, () => ({
    dir: new Vector3(rng.vary(0, 1), rng.vary(0, 1), rng.vary(0, 1)).normalize(),
    freq: rng.range(1.0, 2.4),
    amp: rng.range(0.05, 0.13),
    phase: rng.range(0, Math.PI * 2),
  }));
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const n = v.clone().normalize();
    let d = 1;
    for (const w of waves) d += w.amp * Math.sin(n.dot(w.dir) * w.freq * Math.PI + w.phase);
    v.copy(n).multiplyScalar(d);
    v.y *= squash; // boulders sit wider than tall
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals(); // indexed after weld → genuinely smooth shading
  return geo;
}

/**
 * @param {object} opts { rockTexture, rockNormal, rockRoughness, seed, flatRadius, count }
 * @returns {Group}
 */
export function buildRocks(opts = {}) {
  const rng = new Rng(`rocks:${opts.seed ?? 1}`);
  const flatR = opts.flatRadius ?? 15;
  const count = opts.count ?? 9;

  const mat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  // Closed smooth geometry: render back faces into the shadow map — kills
  // terminator acne at the source, so the global normalBias can stay tiny
  // (a big normalBias eats grass-blade shadows).
  mat.shadowSide = BackSide;
  if (opts.rockTexture) {
    // Full rock PBR via TRIPLANAR (blob geometry has no sane UVs): albedo,
    // roughness, and the normal map applied as a world-locked additive detail
    // over the smooth vertex normals — the maps carry every ridge and crack.
    const scale = float(0.35);
    mat.colorNode = triplanarTexture(texture(opts.rockTexture), null, null, scale);
    if (opts.rockRoughness) {
      mat.roughnessNode = triplanarTexture(texture(opts.rockRoughness), null, null, scale).g;
    }
    if (opts.rockNormal) {
      // tangent-sample → deviation from flat (z≈1 ⇒ ~0), world-locked so it
      // doesn't swim with the camera, added over the smooth normal.
      const d = triplanarTexture(texture(opts.rockNormal), null, null, scale).xyz.mul(2).sub(vec3(1, 1, 2));
      const dView = cameraViewMatrix.mul(vec4(d, 0)).xyz;
      mat.normalNode = normalize(normalView.add(dView.mul(0.7)));
    }
  } else {
    mat.color.set(0x8a8578);
  }

  const variants = Array.from({ length: 3 }, () =>
    displaceRock(new IcosahedronGeometry(1, 3), rng, rng.range(0.55, 0.8)));

  const group = new Group();
  group.name = 'rocks';
  const heightAt = opts.sampler?.heightAt ?? (() => 0);
  const rocknessAt = opts.sampler?.rocknessAt ?? (() => 0);
  const maxR = (opts.sampler?.R ?? 75) * 0.75;
  // Seat against the LOWEST terrain point under the footprint — sampling only
  // the centre leaves downhill edges hovering on slopes.
  const seatHeight = (x, z, fr) => Math.min(
    heightAt(x, z),
    heightAt(x + fr, z), heightAt(x - fr, z),
    heightAt(x, z + fr), heightAt(x, z - fr)
  );

  // Boulders — INSTANCED per variant (3 draws total, any count).
  const m = new Matrix4();
  const q = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const eul = new Euler();
  const perVariant = variants.map(() => []);
  for (let i = 0; i < count; i++) {
    // Scatter across the WHOLE terrain (uniform by area), clear of the trunk;
    // bigger boulders allowed out on the hills.
    const a = rng.range(0, Math.PI * 2);
    const r = 3.5 + (maxR - 3.5) * Math.sqrt(rng.next());
    const onHills = r > flatR;
    const s = rng.range(0.3, onHills ? 2.2 : 0.9) * (i % 3 === 0 ? 1.4 : 0.8);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    eul.set(rng.vary(0, 0.2), rng.range(0, Math.PI * 2), rng.vary(0, 0.2));
    q.setFromEuler(eul);
    // centre near the LOWEST footprint height → the underside is always well
    // inside the ground, even on slopes
    pos.set(x, seatHeight(x, z, s * 0.8) + s * rng.range(0.0, 0.2), z);
    scl.setScalar(s);
    perVariant[i % variants.length].push(new Matrix4().compose(pos, q, scl));
  }
  perVariant.forEach((mats, vi) => {
    if (!mats.length) return;
    const im = new InstancedMesh(variants[vi], mat, mats.length);
    mats.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  });

  // Gravel/scree — one more instanced draw: small pebbles seeded exactly where
  // the rockness mask thins the grass out. DENSE — instancing is nearly free,
  // and a real scree field needs thousands of stones, not hundreds.
  // detail-1 welded pebbles: smooth-shaded rounded stones (detail-0 reads as
  // d20 dice no matter the normals). 12k × 80 tris keeps the budget sane.
  const screeGeo = displaceRock(new IcosahedronGeometry(1, 1), rng, 0.55);
  const screeCount = opts.scree ?? 12000;
  const screeMats = [];
  let guard = screeCount * 5;
  while (screeMats.length < screeCount && guard-- > 0) {
    const a = rng.range(0, Math.PI * 2);
    const r = 3 + (maxR - 3) * Math.sqrt(rng.next());
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (rocknessAt(x, z) < rng.range(0.4, 0.7)) continue; // only on rocky ground
    const s = rng.range(0.05, 0.28);
    eul.set(rng.vary(0, 0.4), rng.range(0, Math.PI * 2), rng.vary(0, 0.4));
    q.setFromEuler(eul);
    pos.set(x, heightAt(x, z) - s * 0.3, z); // sunk a third — pebbles sit IN the dirt
    scl.setScalar(s);
    screeMats.push(new Matrix4().compose(pos, q, scl));
  }
  if (screeMats.length) {
    const im = new InstancedMesh(screeGeo, mat, screeMats.length);
    screeMats.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = false; // pebbles: not worth the shadow-pass cost
    im.receiveShadow = true;
    group.add(im);
  }

  group.userData.material = mat; // for disposal alongside the environment
  return group;
}
