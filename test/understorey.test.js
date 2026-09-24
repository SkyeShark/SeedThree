// Leaf-atlas garden species (pomegranate, fig, tamarisk): two materials (bark +
// ONE leaf material carrying fruit/flowers), the opt-in single-primitive GLB
// export, the LOD0 budget, and seed individuality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshStandardMaterial } from 'three/webgpu';

import { generate, getSchema } from '../src/api/seedthree.js';
import { exportGLB } from '../src/core/export-glb.js';

const SPECIES_KEYS = ['pomegranate', 'fig', 'tamarisk'];
const BUDGET = 50000;

const lodObject = (group, name) => group.levels.find((l) => l.object.userData.lodName === name).object;
const meshesOf = (obj) => { const out = []; obj.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };

// GLTFExporter's binary path needs FileReader (absent in Node).
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    constructor() { this._l = {}; this.result = null; }
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
    removeEventListener() {}
    _emit(t) { const ev = { target: this, type: t }; this['on' + t]?.(ev); for (const fn of this._l[t] || []) fn(ev); }
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this._emit('load'); this._emit('loadend'); }); }
    readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = `data:${blob.type};base64,` + Buffer.from(b).toString('base64'); this._emit('load'); this._emit('loadend'); }); }
  };
}

// Parse the JSON chunk of a GLB.
function glbJson(buf) {
  const dv = new DataView(buf);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
}

for (const key of SPECIES_KEYS) {
  test(`${key}: LOD0 is two material slots (bark + one shared leaf material)`, () => {
    for (const seed of [1, 2, 3]) {
      const { group } = generate({ species: key, seed });
      const lod0 = meshesOf(lodObject(group, 'LOD0'));
      const mats = new Set(lod0.map((m) => m.material));
      assert.equal(mats.size, 2, `seed ${seed}: ${mats.size} materials in LOD0`);
      const bark = lod0.filter((m) => !m.isInstancedMesh);
      assert.equal(bark.length, 1, 'one bark mesh');
      const leafMat = lod0.find((m) => m.name === 'foliage')?.material;
      assert.ok(leafMat, 'foliage present');
      for (const m of lod0.filter((o) => o.isInstancedMesh)) assert.equal(m.material, leafMat, `${m.name} rides the leaf material`);
    }
  });

  test(`${key}: LOD0 ≤ ${BUDGET} tris over seeds 1–20, LOD chain reduces`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { stats } = generate({ species: key, seed });
      assert.equal(stats.summary.lodCount, 3);
      assert.ok(stats.summary.lod0Triangles <= BUDGET, `seed ${seed} over budget: ${stats.summary.lod0Triangles}`);
      assert.ok(stats.summary.lod0Triangles > 8000, `seed ${seed} too sparse`);
      const t = (n) => stats.perLod.find((l) => l.name === n).triangles;
      assert.ok(t('LOD1') < t('LOD0') && t('LOD2') < t('LOD1'), `seed ${seed} LOD chain`);
    }
  });

  test(`${key}: seeds are distinct individuals and deterministic`, () => {
    const a = generate({ species: key, seed: 5 }).stats.summary;
    const b = generate({ species: key, seed: 5 }).stats.summary;
    assert.deepEqual(a, b);
    const sizes = [1, 2, 3, 4, 5, 6].map((seed) => generate({ species: key, seed }).stats.summary);
    const w = sizes.map((s) => s.widthMeters), h = sizes.map((s) => s.heightMeters);
    assert.ok(Math.max(...w) - Math.min(...w) > 0.5 || Math.max(...h) - Math.min(...h) > 0.5, 'size should vary by seed');
  });

  test(`${key}: GLB export writes exactly one leaves primitive at LOD0`, async () => {
    const { group } = generate({ species: key, seed: 2 });
    // Plain stand-in materials keep the SHARING (leaf material identity) but
    // drop the placeholder DataTextures (no canvas in Node).
    const swap = new Map();
    group.traverse((o) => {
      if (!o.isMesh) return;
      if (!swap.has(o.material)) swap.set(o.material, new MeshStandardMaterial());
      o.material = swap.get(o.material);
    });
    const json = glbJson(await exportGLB(group));
    const node = (name) => json.nodes.find((n) => n.name === name);
    const slug = group.levels[0].object.name; // <Species>_LOD0
    const leaves = json.meshes[node(`${slug}_leaves`).mesh];
    const branches = json.meshes[node(`${slug}_branches`).mesh];
    assert.equal(leaves.primitives.length, 1, 'fruit/accents merge into the ONE leaves primitive');
    assert.equal(branches.primitives.length, 1);
  });
}

// The pile merge is opt-in (foliage.mergeExportPiles): a species without the
// flag keeps one primitive per instanced pile even when piles share a material.
async function leavesPrimitives(key, seed) {
  const { group } = generate({ species: key, seed });
  const swap = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (!swap.has(o.material)) swap.set(o.material, new MeshStandardMaterial());
    o.material = swap.get(o.material);
  });
  const json = glbJson(await exportGLB(group));
  const slug = group.levels[0].object.name;
  const node = json.nodes.find((n) => n.name === `${slug}_leaves`);
  return json.meshes[node.mesh].primitives.length;
}

test('GLB pile merge is opt-in: Joshua tree keeps its per-pile leaves primitives; tamarisk writes one', async () => {
  assert.equal(await leavesPrimitives('joshuaTree', 1), 17, 'Joshua tree (no opt-in) exports as before');
  assert.equal(await leavesPrimitives('tamarisk', 1), 1, 'tamarisk (opted in) merges to one leaves primitive');
});

// Opt-in single-sided export (foliage.singleSidedExport): dome-normal cards must
// not export doubleSided — back faces would flip the outward canopy normal.
async function exportLeaves(key, seed, keepFlag) {
  const { group } = generate({ species: key, seed });
  const swap = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    if (!swap.has(o.material)) {
      const m = new MeshStandardMaterial({ side: o.material.side });
      if (keepFlag && o.material.userData?.exportSingleSided) m.userData.exportSingleSided = true;
      swap.set(o.material, m);
    }
    o.material = swap.get(o.material);
  });
  const before = [...swap.values()].map((m) => m.side);
  const json = glbJson(await exportGLB(group));
  const slug = group.levels[0].object.name;
  const prim = json.meshes[json.nodes.find((n) => n.name === `${slug}_leaves`).mesh].primitives[0];
  const after = [...swap.values()].map((m) => m.side);
  return { mat: json.materials[prim.material], indices: json.accessors[prim.indices].count, before, after };
}

test('opted-in leaves export single-sided with both windings; live materials untouched; other species unchanged', async () => {
  for (const key of SPECIES_KEYS) {
    const on = await exportLeaves(key, 2, true);
    const off = await exportLeaves(key, 2, false);
    assert.ok(!on.mat.doubleSided, `${key}: leaves material exported single-sided`);
    assert.equal(off.mat.doubleSided, true, `${key}: without the flag the leaves stay doubleSided`);
    assert.ok(on.indices > off.indices * 1.5, `${key}: dome cards (not the solid fruit) carry both windings (${on.indices} vs ${off.indices})`);
    assert.deepEqual(on.after, on.before, `${key}: the export never changes the live materials' side`);
  }
  const oak = await exportLeaves('whiteOak', 1, true);
  assert.equal(oak.mat.doubleSided, true, 'white oak leaves unchanged (no opt-in)');
});

test('pomegranate + fig fruit hangs in the leaf slot; fruit toggle removes it', () => {
  for (const key of ['pomegranate', 'fig']) {
    const on = generate({ species: key, seed: 3 });
    const lod0 = meshesOf(lodObject(on.group, 'LOD0'));
    const fruit = lod0.find((m) => m.name === 'fruit');
    assert.ok(fruit && fruit.count >= 5, `${key}: fruit present (${fruit?.count})`);
    const leaves = lod0.find((m) => m.name === 'foliage');
    assert.equal(fruit.material, leaves.material, `${key}: fruit shares the leaf material`);
    assert.ok(fruit.geometry.attributes.aThickness, 'fruit carries the solid-fruit marker');
    assert.ok([...fruit.geometry.attributes.aThickness.array].every((v) => v === 0));
    // fruit UVs sample the atlas skin/calyx rects, never the leaf card
    const f = on.shaped.fruit;
    const rects = Object.values(f.atlas);
    const uv = fruit.geometry.attributes.uv.array;
    for (let i = 0; i < uv.length; i += 2) {
      assert.ok(rects.some(([u0, v0, u1, v1]) => uv[i] >= u0 - 1e-5 && uv[i] <= u1 + 1e-5 && uv[i + 1] >= v0 - 1e-5 && uv[i + 1] <= v1 + 1e-5), `${key}: fruit uv outside its atlas rects`);
    }
    const off = generate({ species: key, seed: 3, controls: { fruit: 0 } });
    assert.ok(!meshesOf(lodObject(off.group, 'LOD0')).some((m) => m.name === 'fruit'), `${key}: fruit toggle`);
  }
});

test('leaf cards sample only their atlas rect; accent toggles', () => {
  for (const key of SPECIES_KEYS) {
    const { group, shaped } = generate({ species: key, seed: 1 });
    const fol = meshesOf(lodObject(group, 'LOD0')).find((m) => m.name === 'foliage');
    const [u0, v0, u1, v1] = shaped.foliage.leafUV;
    const uv = fol.geometry.attributes.uv.array;
    for (let i = 0; i < uv.length; i += 2) {
      assert.ok(uv[i] >= u0 - 1e-6 && uv[i] <= u1 + 1e-6 && uv[i + 1] >= v0 - 1e-6 && uv[i + 1] <= v1 + 1e-6);
    }
  }
  const pomOn = meshesOf(lodObject(generate({ species: 'pomegranate', seed: 1 }).group, 'LOD0'));
  assert.ok(pomOn.some((m) => m.name.startsWith('accent')), 'pomegranate flowers default on');
  const pomOff = meshesOf(lodObject(generate({ species: 'pomegranate', seed: 1, controls: { flowers: 0 } }).group, 'LOD0'));
  assert.ok(!pomOff.some((m) => m.name.startsWith('accent')));
  const tamOff = meshesOf(lodObject(generate({ species: 'tamarisk', seed: 1 }).group, 'LOD0'));
  assert.ok(!tamOff.some((m) => m.name.startsWith('accent')), 'tamarisk flower plumes default off');
  const tamOn = meshesOf(lodObject(generate({ species: 'tamarisk', seed: 1, controls: { flowers: 1 } }).group, 'LOD0'));
  assert.ok(tamOn.some((m) => m.name.startsWith('accent')));
});

test('understorey schemas expose the fruit/flower dials', () => {
  assert.ok(getSchema('pomegranate').shape.some((k) => k.key === 'fruit'));
  assert.ok(getSchema('pomegranate').shape.some((k) => k.key === 'flowers'));
  assert.ok(getSchema('fig').shape.some((k) => k.key === 'fruit'));
  assert.ok(getSchema('tamarisk').shape.some((k) => k.key === 'flowers'));
});

test('tamarisk: broad dome of many small guide-borne branchlet cards, see-through material', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const { group, stats } = generate({ species: 'tamarisk', seed });
    const s = stats.summary;
    assert.ok(s.widthMeters > s.heightMeters, `seed ${seed}: crown should be wider than tall (${s.widthMeters} × ${s.heightMeters})`);
    const fol = meshesOf(lodObject(group, 'LOD0')).find((m) => m.name === 'foliage');
    assert.ok(fol.count >= 4000, `seed ${seed}: ${fol.count} branchlet cards — the haze needs many small cards`);
  }
  const { group } = generate({ species: 'tamarisk', seed: 1 });
  const mat = meshesOf(lodObject(group, 'LOD0')).find((m) => m.name === 'foliage').material;
  assert.equal(mat.alphaTest, 0.4, 'exported MASK cutoff');
  assert.ok(mat.alphaTestNode, 'far-mip alpha dither');
  assert.ok(mat.receivedShadowNode && mat.maskShadowNode, 'self-shadow floor + sparse shadow casting');
});
