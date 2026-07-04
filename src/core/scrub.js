// Desert scrub: instanced crossed-quad shrubs (sagebrush / blackbrush / creosote)
// scattered over the desert floor where the temperate biome would put grass.
// Same vegetation staples as grass.js — up-facing normals so shrubs light like
// the ground, per-instance tint variance, wind sway — but sparser, taller, and
// muted grey-green desert tones.

import {
  Group, InstancedMesh, InstancedBufferAttribute, BufferGeometry, BufferAttribute,
  MeshSSSNodeMaterial, Matrix4, Quaternion, Vector3, DoubleSide, Color,
} from 'three/webgpu';
import { texture, attribute, vec4, float, cameraViewMatrix, normalize, uniform, normalMap, normalView } from 'three/tsl';
import { Rng } from './rng.js';
import { grassWindPosition } from './wind.js';

// A bushy CLUMP of sprig quads fanning up-and-out from the base, so ONE scattered
// instance reads as a small shrub built from the leaf-sprig card — not a flat
// billboard. All quads share the sprig texture; a deterministic layout + the
// per-instance yaw/scale in buildScrub keep them from looking stamped.
function shrubGeometry(quads = 8, width = 1) {
  const positions = [], normals = [], uvs = [], indices = [];
  let base = 0;
  const rnd = (n) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };
  for (let q = 0; q < quads; q++) {
    const az = (q / quads) * Math.PI * 2 + (rnd(q) - 0.5) * 1.0;  // spread around, jittered
    const tilt = 0.22 + rnd(q + 7) * 0.55;                        // lean out from vertical
    const h = 0.6 + rnd(q + 3) * 0.55;                            // this sprig's height
    const w = width * (0.7 + rnd(q + 11) * 0.5);
    const off = 0.10 * rnd(q + 5);
    const ca = Math.cos(az), sa = Math.sin(az);
    const cx = ca * off, cz = sa * off;                          // slight base spread
    const upx = Math.sin(tilt) * ca, upy = Math.cos(tilt), upz = Math.sin(tilt) * sa; // up leans outward
    const rx = -sa, rz = ca;                                     // quad width axis (horizontal ⟂ az)
    for (const [lx, ly] of [[-0.5 * w, 0], [0.5 * w, 0], [0.5 * w, 1], [-0.5 * w, 1]]) {
      positions.push(cx + rx * lx + upx * ly * h, upy * ly * h, cz + rz * lx + upz * ly * h);
      normals.push(0, 1, 0); // light like the ground plane, not by card angle
      uvs.push(lx / w + 0.5, ly);
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

// One material per shrub species (each has its own alpha card + relief + rim-glow).
function shrubMaterial(map, normal, translucency, transmitRGB) {
  const mat = new MeshSSSNodeMaterial({ map, alphaTest: 0.42, side: DoubleSide, roughness: 0.96, metalness: 0 });
  const transmit = uniform(new Color().setRGB(...transmitRGB));
  // Backlit rim glow: the translucency map (thin leaf edges transmit, interior
  // blocks) × per-instance tint. Falls back to a flat 1 if the map is missing.
  const edge = translucency ? texture(translucency).r : float(1);
  mat.thicknessColorNode = edge.mul(attribute('aTint', 'vec3').y).mul(transmit);
  mat.thicknessDistortionNode = uniform(0.35);
  mat.thicknessAmbientNode = uniform(0.05);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(5.0);
  mat.thicknessScaleNode = uniform(2.2);
  mat.colorNode = texture(map).mul(vec4(attribute('aTint', 'vec3'), 1));
  mat.positionNode = grassWindPosition(1);
  const upView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  const relief = normal ? normalMap(texture(normal)).sub(normalView) : null;
  mat.normalNode = relief ? normalize(upView.add(relief.mul(0.5))) : normalize(upView);
  return mat;
}

/**
 * @param {object} opts { shrubs:[{texture,normal,tint:[r,g,b],height,share,planes,width}],
 *                         sampler, seed, flatRadius, count }
 * @returns {Group|null}
 */
export function buildScrub(opts = {}) {
  const shrubs = (opts.shrubs ?? []).filter((s) => s.texture); // skip species whose card is still generating
  if (!shrubs.length) return null;
  const rng = new Rng(`scrub:${opts.seed ?? 1}`);
  const flatR = opts.flatRadius ?? 15;
  const count = opts.count ?? 2600; // desert is SPARSE — far fewer than grass
  const heightAt = opts.sampler?.heightAt ?? (() => 0);
  const rocknessAt = opts.sampler?.rocknessAt ?? (() => 0);
  const maxR = Math.min((opts.sampler?.R ?? 75) * 0.8, 210);

  const totalShare = shrubs.reduce((n, s) => n + (s.share ?? 1), 0);
  const buckets = shrubs.map((s) => {
    const cap = Math.ceil(count * (s.share ?? 1) / totalShare) + 1;
    const geo = shrubGeometry(s.quads ?? 8, s.width ?? 1);
    const mesh = new InstancedMesh(geo, shrubMaterial(s.texture, s.normal, s.translucency, s.transmit ?? [0.34, 0.42, 0.18]), cap);
    mesh.castShadow = true; mesh.receiveShadow = true;
    return { s, geo, mesh, cap, tint: new Float32Array(cap * 3), placed: 0 };
  });

  const m = new Matrix4(), q = new Quaternion(), pos = new Vector3(), scl = new Vector3();
  const Y = new Vector3(0, 1, 0);
  let placed = 0, guard = count * 5;
  while (placed < count && guard-- > 0) {
    // pick a species bucket by share
    let pick = rng.range(0, totalShare), bi = 0;
    for (; bi < shrubs.length - 1; bi++) { pick -= (shrubs[bi].share ?? 1); if (pick <= 0) break; }
    const b = buckets[bi];
    if (b.placed >= b.cap) continue;
    const a = rng.range(0, Math.PI * 2);
    const r = 1.6 + (maxR - 2) * rng.next();
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // desert scrub grows in the open flats and gentle scree, but bare rock/steep
    // stays bare; a wide clearing under the hero tree.
    if (rocknessAt(x, z) > rng.range(0.72, 0.98)) continue;
    if (r < 10 && rng.next() > 0.10 + 0.9 * ((r - 1.6) / 8.4)) continue;
    q.setFromAxisAngle(Y, rng.range(0, Math.PI * 2));
    const h = (b.s.height ?? 0.55) * rng.range(0.7, 1.35);
    pos.set(x, heightAt(x, z) - 0.02, z);
    const wr = h * rng.range(1.0, 1.5);
    scl.set(wr, h, wr);
    m.compose(pos, q, scl);
    b.mesh.setMatrixAt(b.placed, m);
    // muted per-instance tint around the species base (grey-green desert shrub),
    // slightly drier/paler at random.
    const t = b.s.tint ?? [0.7, 0.75, 0.55];
    const dry = rng.next() < 0.22 ? 0.22 : 0;
    b.tint[b.placed * 3] = t[0] * rng.range(0.85, 1.12) + dry;
    b.tint[b.placed * 3 + 1] = t[1] * rng.range(0.85, 1.12) * (1 - dry * 0.4);
    b.tint[b.placed * 3 + 2] = t[2] * rng.range(0.82, 1.1) * (1 - dry * 0.5);
    b.placed++;
    placed++;
  }

  const group = new Group();
  group.name = 'scrub';
  for (const b of buckets) {
    b.mesh.count = b.placed;
    b.geo.setAttribute('aTint', new InstancedBufferAttribute(b.tint, 3));
    b.mesh.instanceMatrix.needsUpdate = true;
    b.mesh.computeBoundingSphere();
    group.add(b.mesh);
  }
  return group;
}
