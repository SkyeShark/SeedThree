// Reusable instanced card clumps for low vegetation: reeds, rushes, herbs and
// other alpha-cutout ground cover. Placement stays application-owned; this
// module supplies deterministic geometry, PBR/SSS material wiring and the
// instance attributes needed by SeedThree's shared wind field.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  MeshSSSNodeMaterial,
  Quaternion,
  TextureLoader,
  Vector3,
  ClampToEdgeWrapping,
  NoColorSpace,
  SRGBColorSpace,
} from 'three/webgpu';
import {
  attribute,
  cameraViewMatrix,
  float,
  normalMap,
  normalView,
  normalize,
  texture,
  uniform,
  vec4,
} from 'three/tsl';
import { groundCoverWindPosition, WIND_DIR } from './wind.js';

const loader = new TextureLoader();
const TAU = Math.PI * 2;
const Y_AXIS = new Vector3(0, 1, 0);
const windQuaternion = new Quaternion();

/**
 * Load a card texture set from caller-provided URLs.
 * Missing optional maps resolve to null; the albedo is required.
 */
export async function loadGroundCoverTextures(sources, maxAnisotropy = 4) {
  const [albedo, normal, roughness, translucency] = await Promise.all([
    loadTexture(sources?.albedo, true, maxAnisotropy),
    loadTexture(sources?.normal, false, maxAnisotropy),
    loadTexture(sources?.roughness, false, maxAnisotropy),
    loadTexture(sources?.translucency, false, maxAnisotropy),
  ]);
  if (!albedo) throw new Error(`SeedThree ground-cover albedo missing (${sources?.albedo ?? 'no URL'})`);
  return { albedo, normal, roughness, translucency };
}

/**
 * Create SeedThree's WebGPU foliage material for an alpha-card clump.
 * positionNode is injectable so engines with their own instance transforms can
 * retain an established wind convention.
 */
export function createGroundCoverMaterial({
  name = 'SeedThree ground cover',
  textures,
  transmit = [0.3, 0.42, 0.16],
  windAmount = 0.16,
  positionNode = null,
  alphaTest = 0.38,
} = {}) {
  if (!textures?.albedo) throw new Error('createGroundCoverMaterial requires textures.albedo');

  const material = new MeshSSSNodeMaterial({
    map: textures.albedo,
    alphaTest,
    side: DoubleSide,
    roughness: 0.96,
    metalness: 0,
  });
  material.name = name;
  material.forceSinglePass = true;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;
  material.roughnessMap = textures.roughness ?? null;
  if (textures.roughness) material.roughness = 1;

  const transmitColor = uniform(new Color().setRGB(...transmit));
  const transmission = textures.translucency ? texture(textures.translucency).r : float(1);
  material.thicknessColorNode = transmission.mul(attribute('aTint', 'vec3').y).mul(transmitColor);
  material.thicknessDistortionNode = uniform(0.3);
  material.thicknessAmbientNode = uniform(0.026);
  material.thicknessAttenuationNode = uniform(1);
  material.thicknessPowerNode = uniform(5);
  material.thicknessScaleNode = uniform(1.5);
  material.colorNode = texture(textures.albedo).mul(
    vec4(attribute('aTint', 'vec3'), float(1)),
  );
  material.positionNode = positionNode ?? groundCoverWindPosition(windAmount);

  const upView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  const relief = textures.normal
    ? normalMap(texture(textures.normal)).sub(normalView)
    : null;
  material.normalNode = relief ? normalize(upView.add(relief.mul(0.4))) : normalize(upView);
  return material;
}

/** Deterministic crossed-card clump with varied azimuth, height and lean. */
export function createCardClumpGeometry(spec) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let base = 0;

  for (let quad = 0; quad < spec.quads; quad++) {
    const azimuth = (quad / spec.quads) * TAU + (hash01(quad + 1.7) - 0.5) * 0.95;
    const tilt = spec.tiltMin + hash01(quad + 7.1) * spec.tiltSpan;
    const height = spec.heightMin + hash01(quad + 3.3) * spec.heightSpan;
    const width = spec.width * (0.76 + hash01(quad + 11.4) * 0.52);
    const offset = spec.baseSpread * hash01(quad + 5.2);
    const ca = Math.cos(azimuth);
    const sa = Math.sin(azimuth);
    const cx = ca * offset;
    const cz = sa * offset;
    const upX = Math.sin(tilt) * ca;
    const upY = Math.cos(tilt);
    const upZ = Math.sin(tilt) * sa;
    const rightX = -sa;
    const rightZ = ca;

    for (const [localX, localY] of [
      [-0.5 * width, 0],
      [0.5 * width, 0],
      [0.5 * width, 1],
      [-0.5 * width, 1],
    ]) {
      positions.push(
        cx + rightX * localX + upX * localY * height,
        upY * localY * height,
        cz + rightZ * localX + upZ * localY * height,
      );
      normals.push(0, 1, 0);
      uvs.push(localX / width + 0.5, localY);
    }

    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Add the standard per-instance tint and wind attributes to a geometry. */
export function addGroundCoverInstanceAttributes(geometry, capacity) {
  const tint = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  const anchor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  const wind = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  geometry.setAttribute('aTint', tint);
  geometry.setAttribute('aAnchorPos', anchor);
  geometry.setAttribute('aWindVec', wind);
  return { tint, anchor, wind };
}

/**
 * Convert SeedThree's world wind direction into one instance's local frame,
 * compensating for the downstream instance scale.
 */
export function groundCoverWindVector(yaw, scale, out = new Vector3()) {
  windQuaternion.setFromAxisAngle(Y_AXIS, -yaw);
  out.copy(WIND_DIR).applyQuaternion(windQuaternion);
  if (scale.x !== 0) out.x /= scale.x;
  if (scale.y !== 0) out.y /= scale.y;
  if (scale.z !== 0) out.z /= scale.z;
  return out;
}

export function disposeGroundCoverTextures(textures) {
  textures.albedo.dispose();
  textures.normal?.dispose();
  textures.roughness?.dispose();
  textures.translucency?.dispose();
}

async function loadTexture(url, srgb, maxAnisotropy) {
  if (!url) return null;
  try {
    const loaded = await loader.loadAsync(url);
    loaded.wrapS = ClampToEdgeWrapping;
    loaded.wrapT = ClampToEdgeWrapping;
    loaded.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    loaded.anisotropy = Math.max(1, Math.min(16, maxAnisotropy));
    return loaded;
  } catch {
    return null;
  }
}

function hash01(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}
