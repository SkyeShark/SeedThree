// Volumetric clouds: a 3D Perlin-noise density texture raymarched inside a few
// box volumes scattered in the sky. Adapted from three.js `webgpu_volume_cloud`.
// Replaces the flat billboard sprites — real parallax, soft edges, no cut-offs.

import {
  Data3DTexture, RedFormat, LinearFilter, Mesh, BoxGeometry, NodeMaterial,
  Group, Color, Vector3, BackSide,
} from 'three/webgpu';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { float, vec3, vec4, If, Break, Fn, smoothstep, texture3D, uniform } from 'three/tsl';
import { RaymarchingBox } from 'three/addons/tsl/utils/Raymarching.js';

// Deterministic hash for placement (no Math.random → reproducible).
function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function makeNoiseTexture(size) {
  const data = new Uint8Array(size * size * size);
  let i = 0;
  const scale = 0.05;
  const perlin = new ImprovedNoise();
  const v = new Vector3();
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Spherical falloff → density concentrated in the middle (a puffy blob).
        const d = 1.0 - v.set(x, y, z).subScalar(size / 2).divideScalar(size).length();
        data[i] = (128 + 128 * perlin.noise(x * scale / 1.5, y * scale, z * scale / 1.5)) * d * d;
        i++;
      }
    }
  }
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RedFormat;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const raymarch = Fn(({ tex, range, threshold, opacity, steps }) => {
  const finalColor = vec4(0).toVar();
  RaymarchingBox(steps, ({ positionRay }) => {
    const mapValue = float(tex.sample(positionRay.add(0.5)).r).toVar();
    mapValue.assign(smoothstep(threshold.sub(range), threshold.add(range), mapValue).mul(opacity));
    const shading = tex.sample(positionRay.add(vec3(-0.01))).r.sub(tex.sample(positionRay.add(vec3(0.01))).r);
    const col = shading.mul(3.0).add(positionRay.x.add(positionRay.y).mul(0.25)).add(0.2);
    finalColor.rgb.addAssign(finalColor.a.oneMinus().mul(mapValue).mul(col));
    finalColor.a.addAssign(finalColor.a.oneMinus().mul(mapValue));
    If(finalColor.a.greaterThanEqual(0.95), () => Break());
  });
  return finalColor;
});

/**
 * @param {object} opts { count, seed, size, altitude, spread, tint }
 * @returns {Group}
 */
export function buildVolumetricClouds(opts = {}) {
  const count = opts.count ?? 5;
  const size = opts.size ?? 72;
  const tex = makeNoiseTexture(size);
  const tex3d = texture3D(tex, null, 0);
  const range = uniform(0.16), threshold = uniform(0.30), opacity = uniform(0.13), steps = uniform(60);
  const baseColor = uniform(new Color(opts.tint ?? 0xe6eef7));

  const group = new Group();
  group.name = 'clouds';
  for (let i = 0; i < count; i++) {
    const cloudNode = raymarch({ tex: tex3d, range, threshold, opacity, steps });
    const mat = new NodeMaterial();
    mat.colorNode = cloudNode.setRGB(cloudNode.rgb.add(baseColor));
    mat.side = BackSide;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.fog = false;

    const ang = hash(i * 3.1 + 1) * Math.PI * 2;
    const rad = (opts.spread ?? 55) + hash(i * 2.7 + 5) * 110;
    const alt = (opts.altitude ?? 70) + hash(i * 1.9 + 3) * 40;
    const w = 55 + hash(i * 4.3 + 7) * 55;
    const h = 22 + hash(i * 5.7 + 2) * 14;
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), mat);
    mesh.scale.set(w, h, w * 0.85);
    mesh.position.set(Math.cos(ang) * rad, alt, Math.sin(ang) * rad);
    mesh.renderOrder = 5;
    group.add(mesh);
  }
  return group;
}
