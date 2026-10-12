// Material-backed meadow wildflowers. Every bloom is a real transparent atlas
// card; modeled stems and leaves provide depth and wind-readable silhouettes.
// buildWildflowers scatters single-species colonies instead of tinting one piece
// of cut geometry into unrelated decorative colors.

import {
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
} from 'three/webgpu';
import {
  attribute,
  cameraViewMatrix,
  float,
  mix,
  normalViewGeometry,
  normalize,
  texture,
  uv,
  vec2,
  vec4,
} from 'three/tsl';
import { Rng } from './rng.js';
import { grassWindPosition } from './wind.js';

const TAU = Math.PI * 2;
const STEM_COLORS = [new Color(0x557340), new Color(0x66844b)];
const FLOWER_CARD_COLOR = new Color(0xffffff);
const ATLAS_CELL_WIDTH = 1 / 5;
const STEM_TEXTURE_WIDTH = 32;
const STEM_TEXTURE_HEIGHT = 128;

/** Species represented by the five atlas cells, with legible real-world scale bands. */
export const WILDFLOWER_VARIANTS = [
  { id: 'daisy-star-aster', label: 'Daisy star-aster', atlasOffset: 0 / 5, height: [0.45, 0.72], width: [0.82, 1.05] },
  { id: 'clusius-gentian', label: 'Clusius gentian', atlasOffset: 1 / 5, height: [0.32, 0.5], width: [0.68, 0.88] },
  { id: 'grey-hawkbit', label: 'Grey hawkbit', atlasOffset: 2 / 5, height: [0.4, 0.66], width: [0.76, 0.98] },
  { id: 'bulbiferous-lily', label: 'Bulbiferous lily', atlasOffset: 3 / 5, height: [0.68, 1.05], width: [0.92, 1.16] },
  { id: 'red-campion', label: 'Red campion', atlasOffset: 4 / 5, height: [0.55, 0.9], width: [0.76, 1] },
];

let stemTexture = null;

/** Five-stem colony with one alpha-mapped quad at each flower head. */
export function createWildflowerGeometry(headScale = 1) {
  const buffers = {
    positions: [], normals: [], colors: [], uvs: [], flowerMasks: [], indices: [],
  };
  const stalks = [
    { x: -0.16, z: 0.04, height: 0.78, leanX: -0.04, leanZ: 0.015, yaw: 0.25, bloomScale: 0.95 },
    { x: 0.08, z: -0.08, height: 0.96, leanX: 0.055, leanZ: -0.025, yaw: 2.2, bloomScale: 1.08 },
    { x: 0.2, z: 0.12, height: 0.68, leanX: 0.035, leanZ: 0.045, yaw: 4.35, bloomScale: 0.84 },
    { x: -0.04, z: 0.2, height: 0.86, leanX: -0.018, leanZ: 0.04, yaw: 5.45, bloomScale: 0.9 },
    { x: 0.22, z: -0.16, height: 0.74, leanX: 0.04, leanZ: -0.028, yaw: 1.3, bloomScale: 0.88 },
  ];

  stalks.forEach((stalk, index) => {
    appendStalk(buffers, stalk, index);
    appendFlowerHeadCard(
      buffers,
      new Vector3(stalk.x + stalk.leanX, stalk.height, stalk.z + stalk.leanZ),
      stalk.yaw,
      0.13 * stalk.bloomScale * headScale,
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
  atlasTexture,
  name = 'SeedThree material-backed wildflowers',
  positionNode = null,
} = {}) {
  if (!atlasTexture) throw new Error('createWildflowerMaterial requires a botanical wildflower atlas texture');

  const material = new MeshStandardNodeMaterial();
  material.name = name;
  material.map = atlasTexture;
  material.side = DoubleSide;
  material.alphaTest = 0.18;
  material.roughness = 0.88;
  material.metalness = 0;
  material.color.set(0xffffff);
  material.forceSinglePass = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;

  const flowerMask = attribute('flowerMask', 'float');
  const atlasUv = uv()
    .mul(vec2(ATLAS_CELL_WIDTH, 1))
    .add(vec2(attribute('aFlowerVariant', 'float'), 0));
  const flowerTexel = texture(atlasTexture, atlasUv);
  const stemTexel = texture(stemTexture ??= createStemSurfaceTexture(), uv());
  material.colorNode = mix(
    vec4(attribute('color', 'vec3'), float(1)).mul(stemTexel),
    flowerTexel,
    flowerMask,
  );
  material.positionNode = positionNode ?? grassWindPosition(1);

  const upView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  material.normalNode = normalize(mix(normalViewGeometry, upView, flowerMask));
  material.userData.wildflowerAtlas = WILDFLOWER_VARIANTS.map((variant) => variant.id);
  material.userData.stemTexture = 'procedural fibrous stem surface';
  return material;
}

/**
 * Scatter deterministic, single-species colonies over a SeedThree terrain.
 * @param {object} opts { atlasTexture, sampler, seed, count, flatRadius }
 */
export function buildWildflowers(opts = {}) {
  if (!opts.atlasTexture) return null;
  const rng = new Rng(`wildflowers:${opts.seed ?? 1}`);
  const count = opts.count ?? 520;
  const flatR = opts.flatRadius ?? 15;
  const heightAt = opts.sampler?.heightAt ?? (() => 0);
  const rocknessAt = opts.sampler?.rocknessAt ?? (() => 0);
  const maxR = Math.min((opts.sampler?.R ?? 75) * 0.72, 170);
  const geometry = createWildflowerGeometry(opts.headScale ?? 1);
  const material = createWildflowerMaterial({ atlasTexture: opts.atlasTexture });
  const variants = new Float32Array(count);
  geometry.setAttribute('aFlowerVariant', new InstancedBufferAttribute(variants, 1));

  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = 'material-backed wildflower colonies';
  mesh.castShadow = opts.castShadow ?? false;
  mesh.receiveShadow = opts.receiveShadow === true;

  const matrix = new Matrix4();
  const quaternion = new Quaternion();
  const position = new Vector3();
  const scale = new Vector3();
  const yAxis = new Vector3(0, 1, 0);
  let patch = null;
  let placed = 0;
  let guard = count * 14;
  while (placed < count && guard-- > 0) {
    if (!patch || patch.remaining <= 0) {
      const angle = rng.range(0, TAU);
      const radius = 1.8 + (maxR - 2.2) * rng.next();
      patch = {
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        radius: rng.range(0.55, 2.2),
        remaining: Math.floor(rng.range(4, 11)),
        variantIndex: Math.floor(rng.next() * WILDFLOWER_VARIANTS.length),
      };
    }

    const colonyAngle = rng.range(0, TAU);
    const colonyRadius = Math.sqrt(rng.next()) * patch.radius;
    const x = patch.x + Math.cos(colonyAngle) * colonyRadius;
    const z = patch.z + Math.sin(colonyAngle) * colonyRadius;
    const radius = Math.hypot(x, z);
    const rocky = rocknessAt(x, z);
    if (radius > maxR || rocky > rng.range(0.36, 0.68)) {
      patch.remaining--;
      continue;
    }
    if (radius < 8 && rng.next() > 0.12 + 0.88 * ((radius - 1.8) / 6.2)) {
      patch.remaining--;
      continue;
    }

    const variant = WILDFLOWER_VARIANTS[patch.variantIndex];
    quaternion.setFromAxisAngle(yAxis, rng.range(0, TAU));
    const height = rng.range(variant.height[0], variant.height[1]) * (radius > flatR ? 1.08 : 1);
    const width = height * rng.range(variant.width[0], variant.width[1]);
    position.set(x, heightAt(x, z) - 0.015, z);
    scale.set(width, height, width);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(placed, matrix);
    variants[placed] = variant.atlasOffset;
    placed++;
    patch.remaining--;
  }

  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  geometry.getAttribute('aFlowerVariant').needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.userData.species = WILDFLOWER_VARIANTS.map((variant) => variant.label);
  return mesh;
}

function appendStalk(buffers, stalk, colorIndex) {
  const root = new Vector3(stalk.x, 0, stalk.z);
  const tip = new Vector3(stalk.x + stalk.leanX, stalk.height, stalk.z + stalk.leanZ);
  const width = 0.009;
  const stemColor = STEM_COLORS[colorIndex % STEM_COLORS.length];

  for (let plane = 0; plane < 2; plane++) {
    const angle = stalk.yaw + plane * Math.PI * 0.5;
    const side = new Vector3(Math.cos(angle) * width, 0, Math.sin(angle) * width);
    const normal = new Vector3(-Math.sin(angle), 0.25, Math.cos(angle)).normalize();
    appendQuad(buffers, [
      vertex(root.clone().sub(side), normal, stemColor, [0, 0], 0),
      vertex(root.clone().add(side), normal, stemColor, [1, 0], 0),
      vertex(tip.clone().add(side.clone().multiplyScalar(0.45)), normal, stemColor, [1, 3.2], 0),
      vertex(tip.clone().sub(side.clone().multiplyScalar(0.45)), normal, stemColor, [0, 3.2], 0),
    ]);
  }

  appendLeaf(buffers, root, tip, stalk.yaw + 0.8, 0.34, 0.2, stemColor);
  appendLeaf(buffers, root, tip, stalk.yaw + Math.PI + 0.35, 0.53, 0.16, STEM_COLORS[(colorIndex + 1) % 2]);
}

function appendLeaf(buffers, root, tip, yaw, heightFraction, length, color) {
  const stemPoint = root.clone().lerp(tip, heightFraction);
  const direction = new Vector3(Math.cos(yaw), 0.28, Math.sin(yaw)).normalize();
  const side = new Vector3(-direction.z, 0, direction.x).multiplyScalar(0.035);
  const leafTip = stemPoint.clone().addScaledVector(direction, length);
  const normal = new Vector3(0, 1, 0);
  appendQuad(buffers, [
    vertex(stemPoint.clone().sub(side), normal, color, [0, 0], 0),
    vertex(stemPoint.clone().add(side), normal, color, [1, 0], 0),
    vertex(leafTip.clone().addScaledVector(side, 0.12), normal, color, [1, 1], 0),
    vertex(leafTip.clone().addScaledVector(side, -0.12), normal, color, [0, 1], 0),
  ]);
}

function appendFlowerHeadCard(buffers, center, yaw, radius) {
  const tiltDirection = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const normal = new Vector3(tiltDirection.x * 0.24, 0.95, tiltDirection.z * 0.24).normalize();
  const axisU = new Vector3(-Math.sin(yaw), 0, Math.cos(yaw)).normalize();
  const axisV = new Vector3().crossVectors(normal, axisU).normalize();
  const lifted = center.clone().addScaledVector(normal, 0.008);
  appendQuad(buffers, [
    vertex(lifted.clone().addScaledVector(axisU, -radius).addScaledVector(axisV, -radius), normal, FLOWER_CARD_COLOR, [0, 0], 1),
    vertex(lifted.clone().addScaledVector(axisU, radius).addScaledVector(axisV, -radius), normal, FLOWER_CARD_COLOR, [1, 0], 1),
    vertex(lifted.clone().addScaledVector(axisU, radius).addScaledVector(axisV, radius), normal, FLOWER_CARD_COLOR, [1, 1], 1),
    vertex(lifted.clone().addScaledVector(axisU, -radius).addScaledVector(axisV, radius), normal, FLOWER_CARD_COLOR, [0, 1], 1),
  ]);
}

function createStemSurfaceTexture() {
  const pixels = new Uint8Array(STEM_TEXTURE_WIDTH * STEM_TEXTURE_HEIGHT * 4);
  for (let y = 0; y < STEM_TEXTURE_HEIGHT; y++) {
    const v = y / (STEM_TEXTURE_HEIGHT - 1);
    const nodeBand = Math.exp(-Math.pow((v * 4.1) % 1 - 0.52, 2) / 0.005);
    for (let x = 0; x < STEM_TEXTURE_WIDTH; x++) {
      const index = (y * STEM_TEXTURE_WIDTH + x) * 4;
      const fiber = Math.sin(x * 1.31 + y * 0.17) + Math.sin(x * 3.77 - y * 0.09) * 0.34;
      const grain = ((x * 29 + y * 47 + (x * y) % 17) % 23) / 22 - 0.5;
      const value = Math.max(165, Math.min(244, 222 + fiber * 8 + grain * 7 - nodeBand * 28));
      pixels[index] = value * 0.93;
      pixels[index + 1] = value;
      pixels[index + 2] = value * 0.88;
      pixels[index + 3] = 255;
    }
  }
  const result = new DataTexture(pixels, STEM_TEXTURE_WIDTH, STEM_TEXTURE_HEIGHT, RGBAFormat, UnsignedByteType);
  result.name = 'Procedural wildflower stem fibers';
  result.colorSpace = SRGBColorSpace;
  result.wrapS = RepeatWrapping;
  result.wrapT = RepeatWrapping;
  result.minFilter = LinearMipmapLinearFilter;
  result.magFilter = LinearFilter;
  result.generateMipmaps = true;
  result.needsUpdate = true;
  return result;
}

function vertex(position, normal, color, cardUv, flowerMask) {
  return { position, normal, color, uv: cardUv, flowerMask };
}

function appendQuad(buffers, vertices) {
  const base = buffers.positions.length / 3;
  vertices.forEach((item) => appendVertex(buffers, item));
  buffers.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function appendVertex(buffers, item) {
  buffers.positions.push(item.position.x, item.position.y, item.position.z);
  buffers.normals.push(item.normal.x, item.normal.y, item.normal.z);
  buffers.colors.push(item.color.r, item.color.g, item.color.b);
  buffers.uvs.push(item.uv[0], item.uv[1]);
  buffers.flowerMasks.push(item.flowerMask);
}
