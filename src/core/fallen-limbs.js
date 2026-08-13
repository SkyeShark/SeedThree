// Fallen limbs: dead branch pieces scattered on the terrain around the tree.
// A few reusable gnarled variants (mini dichotomous skeletons, no foliage),
// textured with the species bark, INSTANCED like the rocks — but placed with
// real RESTING contact: each piece is laid on its side, pitched to follow the
// local slope, and seated so its lowest surface point sits just inside the
// ground. No floating tips, no buried logs.

import {
  Group, InstancedMesh, Matrix4, Quaternion, Vector3, Euler,
  MeshStandardNodeMaterial, Color,
} from 'three/webgpu';
import { Rng } from './rng.js';
import { generateDichotomous } from './dichotomous.js';

// One dead limb: a short, strongly-kinked forked branch grown along +Y, then
// rotated to lie along +X. Reuses the dichotomous grammar so the wood language
// (kinks, V-forks, taper) matches the standing trees.
function limbGeometry(rng, seedTag) {
  const { geometry } = generateDichotomous({
    trunks: 1,
    firstForkHeight: 0.28,
    armLength: 0.24,
    armFalloff: 0.8,
    forkGenerations: 3,
    branchiness: 0.75,
    forkSpread: 34,
    forkTriChance: 0.1,
    curlUp: 0,             // dead wood: no tropism
    armBend: 14,
    gnarliness: 26,        // weathered, erratic
    continuationKink: 18,
    forkRadiusKeep: 0.7,
    trunkRadius: 0.028,
    trunkFlare: 1.25,      // torn root/break end reads thicker
    trunkSegRes: 4,
    branchRepel: 0.3,
    minRadius: 0.004,
    radialSegs: 6,
    segCurveRes: 2,
    tileWorldSize: 0.5,
  }, new Rng(`limb:${seedTag}`));
  // Lay the piece down: growth axis +Y → ground axis +X.
  geometry.rotateZ(-Math.PI / 2);
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * @param {object} opts { barkTexture, barkNormal, barkRoughness, sampler, seed, flatRadius, count }
 * @returns {Group|null}
 */
export function buildFallenLimbs(opts = {}) {
  if (!opts.barkTexture) return null;
  // Own STATIC material — the species bark material carries the live wind
  // vertex node, and dead wood lying on the ground must not sway. Slight grey
  // pull sells weathered deadfall against the living trunk's warmer bark.
  const mat = new MeshStandardNodeMaterial({
    map: opts.barkTexture,
    normalMap: opts.barkNormal ?? null,
    roughnessMap: opts.barkRoughness ?? null,
    color: new Color(0xc9c4b8),
    roughness: opts.barkRoughness ? 1.0 : 0.95,
    metalness: 0,
  });
  const rng = new Rng(`limbs:${opts.seed ?? 1}`);
  const flatR = opts.flatRadius ?? 15;
  const count = opts.count ?? 14;
  const heightAt = opts.sampler?.heightAt ?? (() => 0);
  const maxR = (opts.sampler?.R ?? 75) * 0.6;

  const variants = Array.from({ length: 3 }, (_, i) => limbGeometry(rng, `${opts.seed ?? 1}:${i}`));

  const group = new Group();
  group.name = 'fallenLimbs';
  const m = new Matrix4();
  const q = new Quaternion();
  const qYaw = new Quaternion();
  const qTilt = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const perVariant = variants.map(() => []);
  const Y = new Vector3(0, 1, 0);
  const bb = new Vector3();

  for (let i = 0; i < count; i++) {
    const vi = i % variants.length;
    const geo = variants[vi];
    const a = rng.range(0, Math.PI * 2);
    // Bias under/near the canopy (limbs fall from the tree) with a tail
    // scattered out into the field.
    const r = rng.next() < 0.6 ? rng.range(1.6, flatR * 0.7) : flatR * 0.7 + (maxR - flatR * 0.7) * rng.next();
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const s = rng.range(0.6, 1.5);
    const yaw = rng.range(0, Math.PI * 2);

    // RESTING pose: pitch the piece so its long axis follows the ground slope
    // under its two ends (sampled along the yaw heading), then roll a little.
    geo.boundingBox.getSize(bb);
    const half = (bb.x * s) / 2;
    const dx = Math.cos(yaw), dz = -Math.sin(yaw); // local +X after yaw
    const hA = heightAt(x - dx * half, z - dz * half);
    const hB = heightAt(x + dx * half, z + dz * half);
    const pitch = Math.atan2(hB - hA, half * 2);
    qYaw.setFromEuler(new Euler(0, yaw, 0));
    qTilt.setFromEuler(new Euler(rng.vary(0, 0.25), 0, -pitch));
    q.copy(qYaw).multiply(qTilt);

    // Seat by the piece's LOWEST corner under this rotation: transform the
    // bbox corners, take min world y, and sink it ~1.5 cm into the dirt.
    let minY = Infinity;
    for (let cx = 0; cx <= 1; cx++) for (let cy = 0; cy <= 1; cy++) for (let cz = 0; cz <= 1; cz++) {
      pos.set(
        cx ? geo.boundingBox.max.x : geo.boundingBox.min.x,
        cy ? geo.boundingBox.max.y : geo.boundingBox.min.y,
        cz ? geo.boundingBox.max.z : geo.boundingBox.min.z,
      ).multiplyScalar(s).applyQuaternion(q);
      minY = Math.min(minY, pos.y);
    }
    const ground = Math.min(hA, hB, heightAt(x, z));
    pos.set(x, ground - minY - 0.015, z);
    scl.setScalar(s);
    perVariant[vi].push(new Matrix4().compose(pos, q, scl));
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
  group.userData.material = mat; // disposal alongside the environment
  return group;
}
