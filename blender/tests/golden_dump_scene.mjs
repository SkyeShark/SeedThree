// Golden reference for the demo-scene port: the real JS terrain sampler, rocks, scree,
// fallen limbs, grass, scrub, cattail clump geometry, cloud placements and noise, and
// the forest slot loop (main.js updateForest, transcribed: main.js needs a DOM).
//
//   node blender/tests/golden_dump_scene.mjs [outDir]

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsRoot = process.env.SEEDTHREE_JS || path.resolve(here, '../../../SeedThree');
const outDir = process.argv[2] || path.join(here, 'out', 'golden_scene');
fs.mkdirSync(outDir, { recursive: true });
const imp = (p) => import(pathToFileURL(path.join(jsRoot, p)).href);
const THREE = await import(pathToFileURL(path.join(jsRoot, 'node_modules/three/build/three.webgpu.js')).href);
const { makeHeightSampler } = await imp('src/core/environment.js');
const { buildRocks } = await imp('src/core/rocks.js');
const { buildFallenLimbs } = await imp('src/core/fallen-limbs.js');
const { buildGrass } = await imp('src/core/grass.js');
const { buildScrub } = await imp('src/core/scrub.js');
const { createCattailGeometry } = await imp('src/core/cattails.js');
const { Rng } = await imp('src/core/rng.js');
const { ImprovedNoise } = await import(pathToFileURL(path.join(jsRoot, 'node_modules/three/examples/jsm/math/ImprovedNoise.js')).href);

const arr = (a) => Array.from(a);
const doc = {};
const smp = makeHeightSampler(1, { R: 280, flatR: 15, hillH: 12 });
const pts = [];
for (let i = 0; i < 400; i++) { const a = i * 2.399963; const r = (i * 0.7) % 279; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
doc.sampler = { pts, height: pts.map(([x, z]) => smp.heightAt(x, z)), rock: pts.map(([x, z]) => smp.rocknessAt(x, z)), meadow: pts.map(([x, z]) => smp.meadowAt(x, z)) };

function dumpGroup(g) {
  const out = [];
  g.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const at = {};
    for (const [k, a] of Object.entries(o.geometry.attributes)) if (a.isInstancedBufferAttribute) at[k] = arr(a.array.subarray(0, o.count * a.itemSize));
    out.push({ count: o.count, matrices: arr(o.instanceMatrix.array.subarray(0, o.count * 16)), position: arr(o.geometry.attributes.position.array), index: o.geometry.index ? arr(o.geometry.index.array) : null, inst: at });
  });
  return out;
}
const dummy = new THREE.Texture();
doc.rocks = dumpGroup(buildRocks({ rockTexture: dummy, sampler: smp, seed: 1, flatRadius: 15, count: 32 }));
doc.limbs = dumpGroup(buildFallenLimbs({ barkTexture: dummy, sampler: smp, seed: 1, flatRadius: 15, count: 16 }));
doc.grass = dumpGroup(buildGrass({ tuftTexture: dummy, sampler: smp, seed: 1, flatRadius: 15 }));
const smpD = makeHeightSampler(7, { R: 280, flatR: 15, hillH: 12 });
doc.scrub = dumpGroup(buildScrub({ shrubs: [
  { base: 'sagebrush', tint: [0.62, 0.68, 0.52], height: 0.55, share: 1.1, quads: 9, transmit: [0.32, 0.40, 0.20], texture: dummy },
  { base: 'blackbrush', tint: [0.40, 0.42, 0.47], height: 0.48, share: 1.0, quads: 8, transmit: [0.20, 0.22, 0.20], texture: dummy },
  { base: 'creosote', tint: [0.50, 0.62, 0.40], height: 0.80, share: 0.9, quads: 7, transmit: [0.30, 0.44, 0.18], texture: dummy },
], sampler: smpD, seed: 7, flatRadius: 15 }));
const cat = createCattailGeometry();
doc.cattail = { position: arr(cat.attributes.position.array), uv: arr(cat.attributes.uv.array) };

// clouds.js: placements (hash) and makeNoiseTexture (internal: transcribed with the real ImprovedNoise)
function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
doc.clouds = Array.from({ length: 8 }, (_, i) => {
  const ang = hash(i * 3.1 + 1) * Math.PI * 2, rad = 190 + hash(i * 2.7 + 5) * 110, alt = 85 + hash(i * 1.9 + 3) * 40;
  const w = 55 + hash(i * 4.3 + 7) * 55, h = 22 + hash(i * 5.7 + 2) * 14;
  return { pos: [Math.cos(ang) * rad, alt, Math.sin(ang) * rad], scale: [w, h, w * 0.85] };
});
{
  const size = 24, data = new Uint8Array(size * size * size); let i = 0; const scale = 0.05; const perlin = new ImprovedNoise(); const v = new THREE.Vector3();
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = 1.0 - v.set(x, y, z).subScalar(size / 2).divideScalar(size).length();
    data[i] = (128 + 128 * perlin.noise(x * scale / 1.5, y * scale, z * scale / 1.5)) * d * d; i++;
  }
  doc.cloudNoise24 = arr(data);
}

// main.js updateForest's slot loop (transcribed), on the demo terrain
{
  const rng = new Rng('forest:1'); const N = 64; const centerLocal = new THREE.Vector3(0, 6, 0); const slots = [];
  const q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < N; i++) {
    let x = 0, z = 0, r = 0;
    for (let tries = 0; tries < 8; tries++) {
      const a = rng.range(0, Math.PI * 2);
      r = i < N * 0.6 ? rng.range(38, 95) : 95 + 105 * Math.sqrt(rng.next());
      x = Math.cos(a) * r; z = Math.sin(a) * r;
      if (r < 95 || (smp.meadowAt?.(x, z) ?? 0) > 0.35) break;
    }
    const s = rng.range(0.5, 1.1); const rot = rng.range(0, Math.PI * 2);
    q.setFromAxisAngle(Y, rot); pos.set(x, smp.heightAt(x, z) - 0.3 * s, z); scl.setScalar(s);
    const mtx = new THREE.Matrix4().compose(pos, q, scl);
    slots.push({ mtx: arr(mtx.elements), origin: centerLocal.clone().applyMatrix4(mtx).toArray() });
  }
  doc.forest = slots;
}
fs.writeFileSync(path.join(outDir, 'scene.json'), JSON.stringify(doc));
console.log('scene golden:', doc.rocks.length, 'rock meshes,', doc.grass.map((g) => g.count), 'grass,', doc.scrub.map((g) => g.count), 'scrub');
