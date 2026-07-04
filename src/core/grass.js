// Ground grass: instanced crossed-quad tufts scattered over the flat ring.
// Vegetation staples applied: vertex normals point straight UP (tufts inherit
// the terrain's lighting instead of flickering by card angle), per-instance
// shade variation breaks up tiling, and tips bend in the shared wind field.

import {
  Group, InstancedMesh, InstancedBufferAttribute, BufferGeometry, BufferAttribute,
  MeshSSSNodeMaterial, Matrix4, Quaternion, Vector3, DoubleSide, Color,
} from 'three/webgpu';
import { texture, attribute, vec4, cameraViewMatrix, normalize, uniform, normalMap, normalView } from 'three/tsl';
import { Rng } from './rng.js';
import { grassWindPosition } from './wind.js';

// Crossed base-anchored quads (y 0..1), up-facing normals. `planes` and `width`
// give distinct tuft silhouettes so the meadow isn't one shape stamped 13k times.
function tuftGeometry(planes = 2, width = 1) {
  const positions = [], normals = [], uvs = [], indices = [];
  let base = 0;
  for (let q = 0; q < planes; q++) {
    const a = (q * Math.PI) / planes;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (const [lx, ly] of [[-0.5 * width, 0], [0.5 * width, 0], [0.5 * width, 1], [-0.5 * width, 1]]) {
      positions.push(lx * ca, ly, lx * sa);
      normals.push(0, 1, 0); // grass trick: light like the ground plane
      uvs.push(lx / width + 0.5, ly);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  return g;
}

/**
 * @param {object} opts { tuftTexture, seed, flatRadius, count }
 * @returns {InstancedMesh|null}
 */
export function buildGrass(opts = {}) {
  if (!opts.tuftTexture) return null; // texture still generating → skip gracefully
  const rng = new Rng(`grass:${opts.seed ?? 1}`);
  const flatR = opts.flatRadius ?? 15;
  const count = opts.count ?? 13000;
  const heightAt = opts.sampler?.heightAt ?? (() => 0);
  const rocknessAt = opts.sampler?.rocknessAt ?? (() => 0);
  // Reach out to the distant meadow pockets — the rockness check below rejects
  // the rocky ground between them, so far tufts land only inside the painted
  // grass patches (which is exactly where the terrain shows grass texture).
  const maxR = Math.min((opts.sampler?.R ?? 75) * 0.8, 210);

  const mat = new MeshSSSNodeMaterial({
    map: opts.tuftTexture,
    alphaTest: 0.42,
    side: DoubleSide,
    roughness: 0.95,
    metalness: 0,
  });
  // Backlit translucency, same family as the leaves — low sun through the
  // meadow glows. Per-tuft variance rides the tint's green channel.
  const transmit = uniform(new Color().setRGB(0.45, 0.65, 0.22));
  mat.thicknessColorNode = attribute('aTint', 'vec3').y.mul(transmit);
  mat.thicknessDistortionNode = uniform(0.4);
  mat.thicknessAmbientNode = uniform(0.06); // low floor — keeps per-tuft tints readable
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(5.0);
  mat.thicknessScaleNode = uniform(2.6);
  // Per-instance TINT × the map (ez-tree trick: wide green-channel variance) —
  // kills the "carpet of identical tufts" look far better than brightness alone.
  mat.colorNode = texture(opts.tuftTexture).mul(vec4(attribute('aTint', 'vec3'), 1));
  if (opts.tuftRoughness) { mat.roughnessMap = opts.tuftRoughness; mat.roughness = 1.0; }
  mat.positionNode = grassWindPosition(1);
  // Explicit world-up normal via cameraViewMatrix: DoubleSide otherwise FLIPS
  // the vertex normal on back-facing quads → half the crossed blades shade
  // as if lit from below (the "weird grass shading"). The normal MAP rides on
  // top as a DELTA from the flat card normal (same trick as the leaf cards):
  // blade-strand relief survives, card orientation contributes nothing.
  const upView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  const relief = opts.tuftNormal ? normalMap(texture(opts.tuftNormal)).sub(normalView) : null;
  mat.normalNode = relief ? normalize(upView.add(relief.mul(0.6))) : normalize(upView);

  // Two tuft silhouettes: wide meadow fans + narrow tall clumps.
  const variants = [
    { geo: tuftGeometry(2, 1.0), share: 0.62, tall: 1.0 },
    { geo: tuftGeometry(3, 0.6), share: 0.38, tall: 1.4 },
  ].map((v) => {
    const cap = Math.ceil(count * v.share);
    const mesh = new InstancedMesh(v.geo, mat, cap);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return { ...v, cap, mesh, tint: new Float32Array(cap * 3), placed: 0 };
  });

  const m = new Matrix4();
  const q = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const Y = new Vector3(0, 1, 0);
  let placed = 0;
  let guard = count * 4;
  while (placed < count && guard-- > 0) {
    const variant = variants[rng.next() < variants[0].share ? 0 : 1];
    if (variant.placed >= variant.cap) continue;
    // Scatter over the WHOLE terrain, LINEAR in radius (ez-tree calibration:
    // lush near the hero tree, thinning outward), with a root clearing at the
    // trunk and bare patches wherever the ground turns rocky.
    const a = rng.range(0, Math.PI * 2);
    const r = 1.2 + (maxR - 1.6) * rng.next();
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rocky = rocknessAt(x, z);
    if (rocky > rng.range(0.6, 0.95)) continue; // only the harshest scree stays bare
    // Sparse ring under the canopy: real trees shade out their own understory.
    if (r < 9 && rng.next() > 0.18 + 0.82 * ((r - 1.2) / 7.8)) continue;
    q.setFromAxisAngle(Y, rng.range(0, Math.PI * 2));
    // ez-tree scale lesson: clumps read as GRASS only when they're substantial
    // (theirs are ⅓–½ tree height; tiny tufts read as carpet fuzz).
    const h = rng.range(0.55, 1.15) * (r > flatR ? 1.3 : 1) * variant.tall;
    pos.set(x, heightAt(x, z) - 0.02, z);
    scl.set(h * rng.range(1.4, 2.1) / variant.tall, h, h * rng.range(1.4, 2.1) / variant.tall);
    m.compose(pos, q, scl);
    variant.mesh.setMatrixAt(variant.placed, m);
    // Green meadow → dry straw-ORANGE as the ground turns rocky (shared noise
    // again: the color gradient lands exactly where the scree appears), with
    // wide per-tuft variance and occasional dry clumps even in the meadow.
    const dry = Math.min(1, Math.max(0, (rocky - 0.15) * 1.6)) + (rng.next() < 0.1 ? 0.3 : 0);
    variant.tint[variant.placed * 3] = rng.range(0.55, 1.0) + dry * 0.45;           // R up
    variant.tint[variant.placed * 3 + 1] = rng.range(0.55, 1.25) * (1 - dry * 0.35); // G down
    variant.tint[variant.placed * 3 + 2] = rng.range(0.45, 0.8) * (1 - dry * 0.55);  // B way down
    variant.placed++;
    placed++;
  }
  const group = new Group();
  group.name = 'grass';
  for (const v of variants) {
    v.mesh.count = v.placed;
    v.geo.setAttribute('aTint', new InstancedBufferAttribute(v.tint, 3));
    v.mesh.instanceMatrix.needsUpdate = true;
    v.mesh.computeBoundingSphere();
    group.add(v.mesh);
  }
  return group;
}
