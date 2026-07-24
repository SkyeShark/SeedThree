// Procedural meadow wildflowers: compact modeled stems, leaves and three flower
// heads, with a five-color per-instance palette. Geometry/material factories are
// reusable by streaming worlds; buildWildflowers supplies the SeedThree demo's
// deterministic terrain scatter.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import {
  attribute,
  cameraViewMatrix,
  mix,
  normalize,
  vec4,
} from 'three/tsl';
import { Rng } from './rng.js';
import { grassWindPosition } from './wind.js';

const TAU = Math.PI * 2;
const STEM_COLORS = [new Color(0x405b32), new Color(0x526e3b)];
const FLOWER_CENTER = new Color(0xc99431);
const PETAL_BASE = new Color(0xffffff);

/** Natural but legible white, purple, yellow, orange and red meadow flowers. */
export const WILDFLOWER_COLORS = [
  0xf2efe3,
  0x9669bd,
  0xe7c63f,
  0xdf8436,
  0xc94b42,
];

/**
 * Compact SeedThree-style clump: crossed stems and leaves plus three modeled
 * flower heads. One shared geometry is intended to be instanced.
 */
export function createWildflowerGeometry() {
  const buffers = {
    positions: [],
    normals: [],
    colors: [],
    uvs: [],
    flowerMasks: [],
    indices: [],
  };

  const stalks = [
    { x: -0.16, z: 0.04, height: 0.78, leanX: -0.04, leanZ: 0.015, yaw: 0.25, bloomScale: 0.95 },
    { x: 0.08, z: -0.08, height: 0.96, leanX: 0.055, leanZ: -0.025, yaw: 2.2, bloomScale: 1.08 },
    { x: 0.2, z: 0.12, height: 0.68, leanX: 0.035, leanZ: 0.045, yaw: 4.35, bloomScale: 0.84 },
  ];

  stalks.forEach((stalk, index) => {
    appendStalk(buffers, stalk.x, stalk.z, stalk.height, stalk.leanX, stalk.leanZ, stalk.yaw, index);
    appendFlowerHead(
      buffers,
      new Vector3(stalk.x + stalk.leanX, stalk.height, stalk.z + stalk.leanZ),
      stalk.yaw,
      0.13 * stalk.bloomScale,
    );
  });

  const geometry = new BufferGeometry();
  geometry.setIndex(buffers.indices);
  geometry.setAttribute('position', new Float32BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(buffers.normals, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(buffers.colors, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(buffers.uvs, 2));
  geometry.setAttribute('flowerMask', new Float32BufferAttribute(buffers.flowerMasks, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export function createWildflowerMaterial({
  name = 'SeedThree wildflowers',
  positionNode = null,
} = {}) {
  const material = new MeshStandardNodeMaterial();
  material.name = name;
  material.side = DoubleSide;
  material.roughness = 0.9;
  material.metalness = 0;
  material.color.set(0xffffff);
  material.forceSinglePass = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;

  const baseColor = attribute('color', 'vec3');
  const flowerColor = attribute('aFlowerColor', 'vec3');
  const flowerMask = attribute('flowerMask', 'float');
  material.colorNode = mix(baseColor, flowerColor, flowerMask);
  material.positionNode = positionNode ?? grassWindPosition(1);

  const upView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  material.normalNode = normalize(upView);
  return material;
}

export function sampleWildflowerColor(paletteIndex, rng, out = new Color()) {
  const base = WILDFLOWER_COLORS[
    Math.abs(Math.trunc(paletteIndex)) % WILDFLOWER_COLORS.length
  ];
  return out
    .setHex(base)
    .offsetHSL((rng() - 0.5) * 0.018, (rng() - 0.5) * 0.06, (rng() - 0.5) * 0.07);
}

/**
 * Scatter a meadow layer over a SeedThree terrain sampler.
 * @param {object} opts { sampler, seed, count, flatRadius }
 */
export function buildWildflowers(opts = {}) {
  const rng = new Rng(`wildflowers:${opts.seed ?? 1}`);
  const count = opts.count ?? 850;
  const flatR = opts.flatRadius ?? 15;
  const heightAt = opts.sampler?.heightAt ?? (() => 0);
  const rocknessAt = opts.sampler?.rocknessAt ?? (() => 0);
  const maxR = Math.min((opts.sampler?.R ?? 75) * 0.72, 170);
  const geometry = createWildflowerGeometry();
  const material = createWildflowerMaterial();
  const colors = new Float32Array(count * 3);
  geometry.setAttribute('aFlowerColor', new InstancedBufferAttribute(colors, 3));

  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = 'wildflowers';
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  const matrix = new Matrix4();
  const quaternion = new Quaternion();
  const position = new Vector3();
  const scale = new Vector3();
  const yAxis = new Vector3(0, 1, 0);
  const color = new Color();
  let placed = 0;
  let guard = count * 8;
  while (placed < count && guard-- > 0) {
    const angle = rng.range(0, TAU);
    const radius = 1.8 + (maxR - 2.2) * rng.next();
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const rocky = rocknessAt(x, z);
    if (rocky > rng.range(0.36, 0.68)) continue;
    if (radius < 8 && rng.next() > 0.12 + 0.88 * ((radius - 1.8) / 6.2)) continue;

    quaternion.setFromAxisAngle(yAxis, rng.range(0, TAU));
    const height = rng.range(0.42, 0.88) * (radius > flatR ? 1.12 : 1);
    const width = height * rng.range(0.84, 1.16);
    position.set(x, heightAt(x, z) - 0.015, z);
    scale.set(width, height, width);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(placed, matrix);

    sampleWildflowerColor(placed, () => rng.next(), color);
    colors[placed * 3] = color.r;
    colors[placed * 3 + 1] = color.g;
    colors[placed * 3 + 2] = color.b;
    placed++;
  }

  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  geometry.getAttribute('aFlowerColor').needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

function appendStalk(buffers, rootX, rootZ, height, leanX, leanZ, yaw, colorIndex) {
  const root = new Vector3(rootX, 0, rootZ);
  const tip = new Vector3(rootX + leanX, height, rootZ + leanZ);
  const width = 0.018;
  const stemColor = STEM_COLORS[colorIndex % STEM_COLORS.length];

  for (let plane = 0; plane < 2; plane++) {
    const angle = yaw + plane * Math.PI * 0.5;
    const side = new Vector3(Math.cos(angle) * width, 0, Math.sin(angle) * width);
    const normal = new Vector3(-Math.sin(angle), 0.25, Math.cos(angle)).normalize();
    appendQuad(buffers, [
      vertex(root.clone().sub(side), normal, stemColor, [0, 0], 0),
      vertex(root.clone().add(side), normal, stemColor, [1, 0], 0),
      vertex(tip.clone().add(side.clone().multiplyScalar(0.45)), normal, stemColor, [1, 1], 0),
      vertex(tip.clone().sub(side.clone().multiplyScalar(0.45)), normal, stemColor, [0, 1], 0),
    ]);
  }

  appendLeaf(buffers, root, tip, yaw + 0.8, height * 0.34, 0.2, stemColor);
  appendLeaf(buffers, root, tip, yaw + Math.PI + 0.35, height * 0.53, 0.16, STEM_COLORS[(colorIndex + 1) % 2]);
}

function appendLeaf(buffers, root, tip, yaw, heightFraction, length, color) {
  const t = heightFraction / Math.max(tip.y, 0.001);
  const stemPoint = root.clone().lerp(tip, t);
  const direction = new Vector3(Math.cos(yaw), 0.28, Math.sin(yaw)).normalize();
  const side = new Vector3(-direction.z, 0, direction.x).multiplyScalar(0.035);
  const leafTip = stemPoint.clone().addScaledVector(direction, length);
  const normal = new Vector3(0, 1, 0);

  appendQuad(buffers, [
    vertex(stemPoint.clone().sub(side), normal, color, [0, heightFraction], 0),
    vertex(stemPoint.clone().add(side), normal, color, [1, heightFraction], 0),
    vertex(leafTip.clone().addScaledVector(side, 0.12), normal, color, [1, Math.min(1, heightFraction + 0.25)], 0),
    vertex(leafTip.clone().addScaledVector(side, -0.12), normal, color, [0, Math.min(1, heightFraction + 0.25)], 0),
  ]);
}

function appendFlowerHead(buffers, center, yaw, radius) {
  const tiltDirection = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const normal = new Vector3(tiltDirection.x * 0.24, 0.95, tiltDirection.z * 0.24).normalize();
  const axisU = new Vector3(-Math.sin(yaw), 0, Math.cos(yaw)).normalize();
  const axisV = new Vector3().crossVectors(normal, axisU).normalize();
  const petalCount = 6;

  for (let petal = 0; petal < petalCount; petal++) {
    const angle = (petal / petalCount) * TAU;
    const direction = axisU.clone().multiplyScalar(Math.cos(angle)).addScaledVector(axisV, Math.sin(angle));
    const tangent = axisU.clone().multiplyScalar(-Math.sin(angle)).addScaledVector(axisV, Math.cos(angle));
    const inner = center.clone().addScaledVector(direction, radius * 0.14).addScaledVector(normal, 0.008);
    const outer = center.clone().addScaledVector(direction, radius).addScaledVector(normal, 0.012);
    const halfInner = radius * 0.18;
    const halfOuter = radius * 0.31;
    appendQuad(buffers, [
      vertex(inner.clone().addScaledVector(tangent, -halfInner), normal, PETAL_BASE, [0, 1], 1),
      vertex(inner.clone().addScaledVector(tangent, halfInner), normal, PETAL_BASE, [1, 1], 1),
      vertex(outer.clone().addScaledVector(tangent, halfOuter), normal, PETAL_BASE, [1, 1], 1),
      vertex(outer.clone().addScaledVector(tangent, -halfOuter), normal, PETAL_BASE, [0, 1], 1),
    ]);
  }

  const centerRadius = radius * 0.3;
  const centerVertex = center.clone().addScaledVector(normal, 0.02);
  for (let segment = 0; segment < petalCount; segment++) {
    const a0 = (segment / petalCount) * TAU;
    const a1 = ((segment + 1) / petalCount) * TAU;
    appendTriangle(buffers, [
      vertex(centerVertex, normal, FLOWER_CENTER, [0.5, 1], 0),
      vertex(
        centerVertex.clone()
          .addScaledVector(axisU, Math.cos(a0) * centerRadius)
          .addScaledVector(axisV, Math.sin(a0) * centerRadius),
        normal,
        FLOWER_CENTER,
        [0, 1],
        0,
      ),
      vertex(
        centerVertex.clone()
          .addScaledVector(axisU, Math.cos(a1) * centerRadius)
          .addScaledVector(axisV, Math.sin(a1) * centerRadius),
        normal,
        FLOWER_CENTER,
        [1, 1],
        0,
      ),
    ]);
  }
}

function vertex(position, normal, color, cardUv, flowerMask) {
  return { position, normal, color, uv: cardUv, flowerMask };
}

function appendQuad(buffers, vertices) {
  const base = buffers.positions.length / 3;
  vertices.forEach((item) => appendVertex(buffers, item));
  buffers.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function appendTriangle(buffers, vertices) {
  const base = buffers.positions.length / 3;
  vertices.forEach((item) => appendVertex(buffers, item));
  buffers.indices.push(base, base + 1, base + 2);
}

function appendVertex(buffers, item) {
  buffers.positions.push(item.position.x, item.position.y, item.position.z);
  buffers.normals.push(item.normal.x, item.normal.y, item.normal.z);
  buffers.colors.push(item.color.r, item.color.g, item.color.b);
  buffers.uvs.push(item.uv[0], item.uv[1]);
  buffers.flowerMasks.push(item.flowerMask);
}
