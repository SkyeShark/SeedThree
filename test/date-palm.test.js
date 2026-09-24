import test from 'node:test';
import assert from 'node:assert/strict';

import { generate, getSchema, skeleton, toPreset, fromPreset } from '../src/api/seedthree.js';
import { SPECIES } from '../src/species/index.js';

const lodObject = (group, name) => group.levels.find((l) => l.object.userData.lodName === name).object;
const meshesOf = (obj) => { const out = []; obj.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };

test('date palm grows within budget with a two-material LOD0 (bark + one merged leaves mesh)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { group, stats } = generate({ species: 'datePalm', seed });
    assert.equal(stats.summary.lodCount, 3);
    assert.ok(stats.summary.lod0Triangles > 45000, `seed ${seed} too sparse`);
    // Card-economy budget: LOD0 ≤ 90k tris per tree (docs/frond-builder.md §4).
    assert.ok(stats.summary.lod0Triangles <= 90000, `seed ${seed} over budget: ${stats.summary.lod0Triangles}`);
    // A mature, closed crown: 60–120 live fronds.
    const { fronds } = group.userData.palm;
    assert.ok(fronds >= 60 && fronds <= 120, `seed ${seed} frond count ${fronds}`);
    assert.ok(stats.summary.heightMeters >= 9 && stats.summary.heightMeters <= 22, `seed ${seed} height ${stats.summary.heightMeters}`);
    const lod0 = meshesOf(lodObject(group, 'LOD0'));
    // Exactly two material groups, no instancing → the GLB export writes two primitives.
    assert.equal(lod0.length, 2);
    assert.ok(lod0.every((m) => !m.isInstancedMesh));
    const [bark, leaves] = lod0;
    assert.ok(bark.geometry.attributes.aStemCenter, 'bark carries the tube wind attributes');
    assert.ok(leaves.name.endsWith('_LOD0_leaves'));
    assert.ok(leaves.geometry.attributes.aThickness && leaves.geometry.attributes.aWindVec);
    assert.deepEqual(leaves.geometry.userData.exportAttributes, ['position', 'normal', 'uv']);
    for (const v of leaves.geometry.attributes.position.array) assert.ok(Number.isFinite(v));
    // The reduced levels really are reduced.
    const t = (name) => stats.perLod.find((l) => l.name === name).triangles;
    assert.ok(t('LOD1') < t('LOD0') * 0.6 && t('LOD2') < t('LOD1'));
  }
});

test('date palm seeds are distinct individuals and deterministic', () => {
  const a = generate({ species: 'datePalm', seed: 3 });
  const b = generate({ species: 'datePalm', seed: 3 });
  const c = generate({ species: 'datePalm', seed: 4 });
  assert.deepEqual(a.stats.summary, b.stats.summary);
  assert.notDeepEqual(a.stats.summary, c.stats.summary);
  const heights = [1, 2, 3, 4, 5, 6].map((seed) => generate({ species: 'datePalm', seed }).group.userData.palm.height);
  assert.ok(Math.max(...heights) - Math.min(...heights) > 2, 'trunk height should vary by seed');
});

test('date palm dials: dates off, skirt, and forking stays disabled', () => {
  const on = generate({ species: 'datePalm', seed: 2 }).stats.summary.lod0Triangles;
  const off = generate({ species: 'datePalm', seed: 2, controls: { dates: 0 } }).stats.summary.lod0Triangles;
  assert.ok(off < on, 'dates add bunch cards');
  const skirt = generate({ species: 'datePalm', seed: 2, controls: { deadSkirt: 1 } });
  assert.ok(skirt.group.userData.palm.dead > 25, 'full dial = a thick unpruned skirt');
  const sk = skeleton({ species: 'datePalm', seed: 2 });
  assert.equal(sk.generator, 'dichotomous-trunk+fronds');
  const { group } = generate({ species: 'datePalm', seed: 2 });
  assert.ok(group.userData.stems.every((s) => s.children.length <= 1), 'the trunk never forks');
});

test('date palm schema + presets round-trip', () => {
  const schema = getSchema('datePalm');
  assert.ok(schema.shape.some((k) => k.key === 'dates'));
  assert.ok(schema.advanced.some((k) => k.key === 'vFold'));
  const preset = toPreset({ species: 'datePalm', seed: 7, controls: { lean: 20 } });
  const back = fromPreset(JSON.parse(JSON.stringify(preset)));
  assert.equal(back.seed, 7);
  assert.equal(back.controls.lean, 20);
});

test('date palm LOD0 budget holds across the seed population', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const t = generate({ species: 'datePalm', seed }).stats.summary.lod0Triangles;
    assert.ok(t <= 90000, `seed ${seed} over budget: ${t}`);
  }
});

test('date palm bark atlas: the trunk stays in its region, crown tubes sample the strips', () => {
  const f = SPECIES.datePalm.foliage, ba = SPECIES.datePalm.params.barkAtlas;
  const { group } = generate({ species: 'datePalm', seed: 3 });
  const bark = meshesOf(lodObject(group, 'LOD0'))[0];
  const uv = bark.geometry.attributes.uv.array;
  const strip0 = Math.min(f.rachisUV[0], f.peduncleUV[0]), strip1 = Math.max(f.rachisUV[2], f.peduncleUV[2]);
  let inStrips = 0;
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i];
    const ok = (u >= -1e-5 && u <= ba.regionU + 1e-5) || (u >= strip0 - 1e-5 && u <= strip1 + 1e-5);
    assert.ok(ok, `bark uv u=${u} samples the gutter/outside the atlas`);
    if (u >= strip0 - 1e-5) inStrips++;
  }
  assert.ok(inStrips > 1000, 'live rachis + peduncles sample the colour strips');
});

test('date palm fruit: peduncles in the bark slot, bunches hang from them', () => {
  const on = generate({ species: 'datePalm', seed: 3 });
  const off = generate({ species: 'datePalm', seed: 3, controls: { dates: 0 } });
  assert.equal(on.group.userData.palm.peduncles, 5);
  assert.equal(off.group.userData.palm.peduncles, 0);
  const tris = (g) => meshesOf(lodObject(g, 'LOD0')).map((m) => m.geometry.index.count / 3);
  const [barkOn, leavesOn] = tris(on.group), [barkOff, leavesOff] = tris(off.group);
  assert.ok(barkOn > barkOff, 'stalks are bark geometry');
  assert.ok(leavesOn > leavesOff, 'bunch cards are leaves geometry');
  assert.equal(meshesOf(lodObject(on.group, 'LOD0')).length, 2, 'still exactly two meshes');
});
