// Golden reference for the Python port: grow trees with the REAL JS (the
// headless API in src/api/seedthree.js, no GPU) and dump skeletons + every LOD's
// mesh buffers as JSON. test_parity.py compares the Python core against these.
//
//   node blender/tests/golden_dump.mjs [outDir]
//
// The JS needs three's node_modules; by default this imports from a SeedThree
// checkout that has them (SEEDTHREE_JS, else ../../../SeedThree next to this
// worktree). Nothing is written into that checkout.

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsRoot = process.env.SEEDTHREE_JS || path.resolve(here, '../../../SeedThree');
const outDir = process.argv[2] || path.join(here, 'out', 'golden');
fs.mkdirSync(outDir, { recursive: true });

const imp = (p) => import(pathToFileURL(path.join(jsRoot, p)).href);
const api = await imp('src/api/seedthree.js');
const { Rng } = await imp('src/core/rng.js');
const { generateSkeleton } = await imp('src/core/weber-penn.js');
const { generateDichotomous } = await imp('src/core/dichotomous.js');
const { applySpeciesControls } = await imp('src/ui/controls.js');
const { SPECIES } = await imp('src/species/index.js');

export const CASES = [
  { species: 'whiteOak', seed: 1737 },
  { species: 'whiteOak', seed: 7, controls: { height: 15, crownShape: 2, branchDensity: 30, leafSize: 0.4, leavesPerBranch: 22, paramOverrides: { downAngle: { 2: 40 } } } },
  { species: 'redMaple', seed: 3 },
  { species: 'americanBeech', seed: 11 },
  { species: 'floweringDogwood', seed: 4 },
  { species: 'americanSycamore', seed: 2 },
  { species: 'apple', seed: 5 },
  { species: 'cherry', seed: 6 },
  { species: 'paperBirch', seed: 9 },
  { species: 'pine', seed: 2 },
  { species: 'weepingWillow', seed: 2 },
  { species: 'joshuaTree', seed: 7 },
  { species: 'saguaro', seed: 3 },
  { species: 'creosote', seed: 5 },
  { species: 'blackbrush', seed: 4 },
];

const arr = (a) => (a ? Array.from(a) : null);

function dumpStems(stems) {
  return stems.map((s) => ({
    level: s.level,
    points: s.points.flatMap((p) => [p.x, p.y, p.z]),
    radii: s.radii,
    orients: s.orients ? s.orients.flatMap((q) => [q.x, q.y, q.z, q.w]) : null,
    winds: s.winds,
  }));
}

function dumpLevel(obj) {
  const meshes = [];
  obj.traverse((o) => {
    if (!o.geometry) return;
    const g = o.geometry;
    const attrs = {};
    for (const [k, a] of Object.entries(g.attributes)) attrs[k] = { itemSize: a.itemSize, instanced: !!a.isInstancedBufferAttribute, array: arr(a.array) };
    meshes.push({
      name: o.name, instanced: !!o.isInstancedMesh, count: o.isInstancedMesh ? o.count : 1,
      index: g.index ? arr(g.index.array) : null, attrs,
      instanceMatrix: o.isInstancedMesh ? arr(o.instanceMatrix.array.subarray(0, o.count * 16)) : null,
    });
  });
  return meshes;
}

// Fruit: the headless API never loads the GLBs, so grow the orchard cases a second
// time through the app's own fruit path (tree.js -> buildFruits) with a stand-in
// geometry that has the GLB's exact bounds and triangle count.
const THREE = await import(pathToFileURL(path.join(jsRoot, 'node_modules/three/build/three.webgpu.js')).href);
const { prepareFruitGeometry, makeFruitMaterial } = await imp('src/core/fruit.js');
function glbStandIn(file) {
  const b = fs.readFileSync(file);
  const jlen = b.readUInt32LE(12);
  const doc = JSON.parse(b.subarray(20, 20 + jlen).toString('utf8'));
  const node = doc.nodes.find((n) => n.mesh !== undefined);
  const prim = doc.meshes[node.mesh].primitives[0];
  const acc = doc.accessors[prim.attributes.POSITION];
  const [x0, y0, z0] = acc.min, [x1, y1, z1] = acc.max;
  const pos = new Float32Array([x0, y0, z0, x1, y0, z0, x0, y1, z0, x1, y1, z0, x0, y0, z1, x1, y0, z1, x0, y1, z1, x1, y1, z1]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const nIdx = prim.indices !== undefined ? doc.accessors[prim.indices].count : acc.count;
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(nIdx), 1));
  return prepareFruitGeometry(geo);
}

for (const c of CASES) {
  const sp = SPECIES[c.species];
  const t0 = performance.now();
  let assets = null;
  if (sp.fruit?.mesh) {
    assets = api.placeholderAssets(c.species);
    assets.fruitGeo = glbStandIn(path.join(jsRoot, 'assets', 'fruits', sp.fruit.mesh));
    assets.fruitMat = makeFruitMaterial(null);
  }
  const out = api.generate({ species: c.species, seed: c.seed, controls: c.controls || {}, ...(assets ? { assets } : {}) });
  const ms = performance.now() - t0;
  const merged = out.preset.controls;
  const shaped = applySpeciesControls(sp, merged);
  let skel;
  if (sp.foliageType === 'rosette' || sp.foliageType === 'sprayClusters') {
    const leaf = shaped.foliage?.leafLen ?? shaped.foliage?.clusterSize ?? 0.5;
    skel = generateDichotomous({ ...shaped.params, tipClearance: leaf * 0.9 }, new Rng(`${sp.name}:${c.seed}`)).stems;
  } else {
    skel = generateSkeleton(shaped.params, new Rng(`${sp.name}:${c.seed}`)).stems;
  }
  const rng = new Rng(`${sp.name}:${c.seed}`);
  const draws = Array.from({ length: 16 }, () => rng.next());
  const doc = {
    case: c, ms, rngFirst16: draws, stats: out.stats, preset: out.preset,
    stems: dumpStems(skel),
    levels: out.group.levels.map((l) => ({ name: l.object.userData.lodName, meshes: dumpLevel(l.object) })),
  };
  const name = `${c.species}_${c.seed}${c.controls ? '_dials' : ''}.json`;
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(doc));
  console.log(name, `${ms.toFixed(0)} ms`, out.stats.summary);
}
