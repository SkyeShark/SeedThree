import test from 'node:test';
import assert from 'node:assert/strict';

import { generate } from '../src/api/seedthree.js';
import { stableStemSubset } from '../src/core/branch-cards.js';

test('stable stem subsets are exact, ordered, and nested', () => {
  const stems = Array.from({ length: 100 }, (_, id) => ({ id }));
  const full = stableStemSubset(stems, 1);
  const mid = stableStemSubset(stems, 0.5);
  const far = stableStemSubset(stems, 0.18);
  assert.equal(full.length, 100);
  assert.equal(mid.length, 50);
  assert.equal(far.length, 18);
  assert.deepEqual(full, stems);
  assert.ok(mid.every((stem, index, array) => index === 0 || array[index - 1].id < stem.id));
  const midSet = new Set(mid);
  assert.ok(far.every((stem) => midSet.has(stem)));
});

test('new broadleaf mobile ladders expose calibrated nested card and tube keeps', () => {
  const ordinary = ['paperBirch', 'quakingAspen', 'floweringDogwood'];
  for (const species of ordinary) {
    const { group } = generate({ species, seed: 1, lod: { mobileTarget: true } });
    const data = Object.fromEntries(group.levels.map(({ object }) => [
      object.userData.lodName, object.userData,
    ]));
    assert.equal(data.LOD2.cardKeepFraction, 1, species);
    assert.equal(data.LOD2.meshTerminalKeepFraction, 1, species);
    assert.equal(data.LOD3.cardKeepFraction, 1, species);
    assert.equal(data.LOD3.meshTerminalKeepFraction, 0.4, species);
    assert.equal(data.LOD4.cardKeepFraction, 0.4, species);
    assert.equal(data.LOD4.meshTerminalKeepFraction, 0.2, species);
    assert.equal(data.LOD2.cardLevel, data.LOD3.cardLevel, species);
    assert.equal(data.LOD3.cardLevel, data.LOD4.cardLevel, species);
  }

  const { group } = generate({
    species: 'americanSycamore', seed: 1, lod: { mobileTarget: true },
  });
  const data = Object.fromEntries(group.levels.map(({ object }) => [
    object.userData.lodName, object.userData,
  ]));
  assert.equal(data.LOD2.cardKeepFraction, 1);
  assert.equal(data.LOD3.cardKeepFraction, 0.5);
  assert.equal(data.LOD4.cardKeepFraction, 0.18);
  assert.equal(data.LOD2.cardLevel, data.LOD3.cardLevel);
  assert.equal(data.LOD3.cardLevel, data.LOD4.cardLevel);
});
