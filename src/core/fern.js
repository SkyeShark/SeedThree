// Barkless fern generator: instanced, curved frond ribbons radiate from one
// crown. The frond texture owns the rachis as well as the pinnae, so no woody
// branch mesh or borrowed bark material is needed.

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LOD,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { Rng } from './rng.js';
import { WIND_DIR } from './wind.js';

const Y = new Vector3(0, 1, 0);

export function buildFernTree(species, seed, assets = {}, lodOpts = {}) {
  const lod = new LOD();
  lod.name = `${species.name} (seed ${seed})`;
  const fullCount = species.foliage?.frondCount ?? 11;
  const levels = [
    { name: 'LOD0', distance: 0, count: fullCount, segments: 8 },
    { name: 'LOD1', distance: lodOpts.lod1Dist ?? 18, count: Math.max(5, Math.round(fullCount * 0.68)), segments: 5 },
    { name: 'LOD2', distance: lodOpts.lod2Dist ?? 42, count: Math.max(3, Math.round(fullCount * 0.38)), segments: 3 },
  ];
  const stats = [];

  for (const [levelIndex, config] of levels.entries()) {
    const level = new Group();
    level.name = `${species.name} ${config.name}`;
    level.userData.lodName = config.name;
    const fronds = buildFernFronds(
      species,
      config,
      new Rng(`${species.name}:${seed}:fronds${levelIndex}`),
      assets.leafMat,
    );
    if (fronds) level.add(fronds);
    lod.addLevel(level, config.distance, 0.05);
    stats.push({ name: config.name, distance: config.distance, leafInstances: config.count });
  }

  lod.position.y = -(species.plantSink ?? 0.01);
  lod.userData = {
    species: species.name,
    seed,
    mobileBuilt: false,
    stemCount: 0,
    tipCount: fullCount,
    leafInstances: fullCount,
    levels: stats,
  };
  return { group: lod, stems: [], tips: [] };
}

function buildFernFronds(species, config, rng, material) {
  if (!material || config.count <= 0) return null;
  const foliage = species.foliage ?? {};
  const variants = Array.from({ length: 3 }, (_, variant) => ({
    geometry: createFrondGeometry(
      config.segments,
      foliage.widthRatio ?? 0.24,
      (foliage.bend ?? 0.48) * (0.82 + variant * 0.18),
    ),
    instances: [],
  }));

  for (let index = 0; index < config.count; index++) {
    const angle = (index / config.count) * Math.PI * 2 + rng.vary(0, 0.16);
    const length = rng.range(foliage.minLength ?? 0.58, foliage.maxLength ?? 0.92);
    const rootRadius = rng.range(0.008, 0.026);
    variants[Math.floor(rng.next() * variants.length)].instances.push({ angle, length, rootRadius });
  }

  const group = new Group();
  group.name = 'fern-fronds';
  const matrix = new Matrix4();
  const quaternion = new Quaternion();
  const inverse = new Quaternion();
  const scale = new Vector3();
  const position = new Vector3();
  const wind = new Vector3();

  for (const [variantIndex, variant] of variants.entries()) {
    if (variant.instances.length === 0) {
      variant.geometry.dispose();
      continue;
    }
    const mesh = new InstancedMesh(variant.geometry, material, variant.instances.length);
    mesh.name = `fern-fronds-${variantIndex}`;
    const anchorPos = new Float32Array(variant.instances.length * 3);
    const windVec = new Float32Array(variant.instances.length * 3);
    const thickness = new Float32Array(variant.instances.length);

    variant.instances.forEach((instance, instanceIndex) => {
      quaternion.setFromAxisAngle(Y, instance.angle);
      position.set(
        Math.sin(instance.angle) * instance.rootRadius,
        0,
        Math.cos(instance.angle) * instance.rootRadius,
      );
      scale.setScalar(instance.length);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(instanceIndex, matrix);

      inverse.copy(quaternion).invert();
      wind.copy(WIND_DIR).applyQuaternion(inverse).multiplyScalar(0.62 / instance.length);
      windVec.set(wind.toArray(), instanceIndex * 3);
      anchorPos.set(position.toArray(), instanceIndex * 3);
      thickness[instanceIndex] = rng.range(0.55, 1);
    });

    variant.geometry.setAttribute('aWindVec', new InstancedBufferAttribute(windVec, 3));
    variant.geometry.setAttribute('aAnchorPos', new InstancedBufferAttribute(anchorPos, 3));
    variant.geometry.setAttribute('aThickness', new InstancedBufferAttribute(thickness, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.frondCount = config.count;
  return group;
}

function createFrondGeometry(segments, widthRatio, bend) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let segment = 0; segment <= segments; segment++) {
    const t = segment / segments;
    const centerY = t;
    const centerZ = bend * t * t;
    const width = widthRatio * Math.sin(Math.PI * Math.pow(t, 0.82));
    positions.push(-width, centerY, centerZ, width, centerY, centerZ);
    uvs.push(0, t, 1, t);
    if (segment < segments) {
      const base = segment * 2;
      indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
