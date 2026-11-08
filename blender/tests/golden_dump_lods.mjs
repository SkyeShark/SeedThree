// Golden reference for the round-two port: the card and rosette-card bakes, the
// desktop card LOD2, the mobile ladders and hangingSprays, grown by the REAL JS.
//
//   node blender/tests/golden_dump_lods.mjs [outDir]
//
// bakeBranchCards / bakeRosetteCards need a renderer only to fill textures; their
// geometry, framing and placement do not. A recording stand-in renderer returns
// blank pixels and keeps every camera the bake renders through, so the dump holds
// the exact exemplar framings. Cards are then placed by the real buildTree the way
// main.js ensureBranchCards wires them. Nothing is written into the JS checkout.

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsRoot = process.env.SEEDTHREE_JS || path.resolve(here, '../../../SeedThree');
const outDir = process.argv[2] || path.join(here, 'out', 'golden_lods');
fs.mkdirSync(outDir, { recursive: true });

const imp = (p) => import(pathToFileURL(path.join(jsRoot, p)).href);
const api = await imp('src/api/seedthree.js');
const { buildTree } = await imp('src/core/tree.js');
const { bakeBranchCards, bakeRosetteCards } = await imp('src/core/branch-cards.js');
const { applySpeciesControls, controlsFromSpecies } = await imp('src/ui/controls.js');
const { SPECIES } = await imp('src/species/index.js');
const { prepareFruitGeometry, makeFruitMaterial } = await imp('src/core/fruit.js');
const THREE = await import(pathToFileURL(path.join(jsRoot, 'node_modules/three/build/three.webgpu.js')).href);

const arr = (a) => (a ? Array.from(a) : null);

function fakeRenderer() {
  const cams = [];
  let rt = null;
  return {
    cams,
    getRenderTarget: () => rt,
    setRenderTarget: (t) => { rt = t; },
    getClearColor: (c) => c,
    getClearAlpha: () => 0,
    setClearColor: () => {},
    renderAsync: async (scene, cam) => {
      if (!cam.isOrthographicCamera) return;
      cam.updateMatrixWorld(true);
      const rec = { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom, near: cam.near, far: cam.far,
        position: cam.position.toArray(), quaternion: cam.quaternion.toArray() };
      const last = cams[cams.length - 1];
      if (!last || JSON.stringify(last) !== JSON.stringify(rec)) cams.push(rec);
    },
    readRenderTargetPixelsAsync: async (t, x, y, w, h) => new Uint8Array(w * h * 4),
  };
}

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

function dumpGeo(g) {
  if (!g) return null;
  const out = { index: g.index ? arr(g.index.array) : null };
  for (const k of ['position', 'normal', 'uv', 'aThickness']) if (g.attributes[k]) out[k] = arr(g.attributes[k].array);
  return out;
}

function dumpLevel(obj) {
  const meshes = [];
  obj.traverse((o) => {
    if (!o.geometry) return;
    const g = o.geometry;
    const n = o.isInstancedMesh ? o.count : 0;
    const attrs = {};
    for (const [k, a] of Object.entries(g.attributes)) {
      const inst = !!a.isInstancedBufferAttribute;
      attrs[k] = { itemSize: a.itemSize, instanced: inst, array: arr(inst ? a.array.subarray(0, n * a.itemSize) : a.array) };
    }
    meshes.push({
      name: o.name, instanced: !!o.isInstancedMesh, count: o.isInstancedMesh ? o.count : 1,
      castShadow: o.castShadow, receiveShadow: o.receiveShadow,
      index: g.index ? arr(g.index.array) : null, attrs,
      instanceMatrix: o.isInstancedMesh ? arr(o.instanceMatrix.array.subarray(0, o.count * 16)) : null,
    });
  });
  return meshes;
}

// The cases: [species, seed, lodOpts, foliage override, bake?]
const CASES = [
  { species: 'whiteOak', seed: 1737, lod: {}, cards: true },
  { species: 'floweringDogwood', seed: 4, lod: {}, cards: true },
  { species: 'americanSycamore', seed: 2, lod: {}, cards: true },
  { species: 'weepingWillow', seed: 2, lod: {}, cards: true },
  { species: 'apple', seed: 5, lod: {}, cards: true },
  { species: 'whiteOak', seed: 1737, lod: { mobileTarget: true }, cards: true },
  { species: 'americanSycamore', seed: 2, lod: { mobileTarget: true }, cards: true },
  { species: 'weepingWillow', seed: 2, lod: { mobileTarget: true }, cards: true },
  { species: 'paperBirch', seed: 9, lod: { mobileTarget: true, lod1Density: 0.8, lod2Density: 0.6 }, cards: true },
  { species: 'paperBirch', seed: 9, lod: { mobileTarget: true }, cards: false },
  { species: 'joshuaTree', seed: 7, lod: { mobileTarget: true }, cards: true },
  { species: 'joshuaTree', seed: 7, lod: { mobileTarget: true, lod0Density: 0.6, meshQuality: 1 }, cards: false },
  { species: 'saguaro', seed: 3, lod: { mobileTarget: true }, cards: false },
  { species: 'creosote', seed: 5, lod: { mobileTarget: true, lod0Density: 0.7 }, cards: false },
  { species: 'redMaple', seed: 3, lod: {}, foliage: { mode: 'hangingSprays', leavesPerBranch: 3, size: 0.9 }, cards: true, tag: 'hanging' },
];

for (const c of CASES) {
  const sp = SPECIES[c.species];
  const merged = { ...controlsFromSpecies(sp), seed: c.seed };
  const shaped = applySpeciesControls(sp, merged);
  if (c.foliage) shaped.foliage = { ...shaped.foliage, ...c.foliage };
  const assets = api.placeholderAssets(c.species);
  if (sp.fruit?.mesh) {
    assets.fruitGeo = glbStandIn(path.join(jsRoot, 'assets', 'fruits', sp.fruit.mesh));
    assets.fruitMat = makeFruitMaterial(null);
  }
  const doc = { case: c, bakes: null, cameras: null, levels: null };
  let branchCards = null;
  if (c.cards) {
    const r = fakeRenderer();
    const maxLevel = (shaped.params.levels ?? 3) - 1;
    if (sp.foliageType === 'rosette') {
      if (c.lod.mobileTarget && !sp.cactus) branchCards = await bakeRosetteCards(r, shaped, assets, { size: 16, variants: 3 });
    } else {
      const willow = shaped.foliage?.mode === 'willowCurtains';
      const job = willow
        ? { level: maxLevel, foliageOnly: true, gravityAligned: true, crossViews: true, noFlutter: true }
        : { level: maxLevel, foliageOnly: true, crossViews: !!shaped.crossedLod2Cards, noFlutter: !!shaped.crossedLod2Cards };
      const set = await bakeBranchCards(r, shaped, assets, {
        size: 16, variants: 3, cardLevel: job.level, foliageOnly: job.foliageOnly,
        noFlutter: job.noFlutter ?? job.level < maxLevel, crossViews: job.crossViews ?? job.level < maxLevel,
        gravityAligned: !!job.gravityAligned,
      });
      if (set) {
        const byLevel = new Map([[`${maxLevel}:fol`, set]]);
        branchCards = { byLevel, variants: set.variants, centerUniform: set.centerUniform };
      }
    }
    doc.cameras = r.cams;
    if (branchCards) {
      doc.bakes = branchCards.variants.map((v) => ({
        chordLen: v.chordLen, minY: v.minY ?? null, floorMin: v.floorMin ?? null,
        geometry: dumpGeo(v.geometry), side: v.side ? dumpGeo(v.side.geometry) : null,
        recipe: v.geometry.userData.willowBowed ?? null,
      }));
    }
  }
  const { group } = buildTree(shaped, c.seed, assets, { ...c.lod, ...(branchCards ? { branchCards } : {}) });
  doc.levels = group.levels.map((l) => ({
    name: l.object.userData.lodName, distance: l.distance, userData: {
      hiddenInApp: !!l.object.userData.hiddenInApp, appOnly: !!l.object.userData.appOnly,
      cardLevel: l.object.userData.cardLevel ?? null, cardKeepFraction: l.object.userData.cardKeepFraction ?? null,
      meshTerminalKeepFraction: l.object.userData.meshTerminalKeepFraction ?? null,
    },
    centerUniform: branchCards?.centerUniform ? null : null,
    meshes: dumpLevel(l.object),
  }));
  if (branchCards?.centerUniform) doc.cardCenter = branchCards.centerUniform.value.toArray();
  const name = `${c.species}_${c.seed}${c.tag ? '_' + c.tag : ''}${c.lod.mobileTarget ? '_mobile' : ''}${c.cards ? '' : '_nocards'}${Object.keys(c.lod).length > 1 ? '_dials' : ''}.json`;
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(doc));
  console.log(name, doc.levels.map((l) => `${l.name}:${l.meshes.length}`).join(' '), doc.cameras ? `${doc.cameras.length} cams` : '');
}
