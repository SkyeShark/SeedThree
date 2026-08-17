import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/api/seedthree.js';
import { bilberry } from '../src/species/bilberry.js';
import { SPECIES } from '../src/species/index.js';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));

test('bilberry is a registered, foliated dichotomous shrub', () => {
  assert.equal(SPECIES.bilberry, bilberry);
  assert.equal(bilberry.foliageType, 'sprayClusters');
  assert.equal(bilberry.fruit.mesh, 'bilberry_berry.glb');
  assert.equal(bilberry.fruit.maxCount, 14);
  const grown = generate({ species: 'bilberry', seed: 7 });
  assert.equal(grown.stats.summary.lodCount, 3);
  assert.ok(grown.group.userData.leafInstances > 0);
  assert.ok(grown.stats.summary.widthMeters > 0.4);
  assert.ok(grown.stats.summary.heightMeters > 0.25);
});

test('bilberry owns complete bark, foliage, and binary fruit assets', () => {
  assertTextureSet('bark', 'bilberry_branch', ['albedo', 'normal', 'roughness']);
  assertTextureSet('leaves', 'bilberry', ['albedo', 'normal', 'roughness', 'translucency']);
  const fruit = `${assets}fruits/bilberry_berry.glb`;
  assert.ok(existsSync(fruit));
  assert.equal(readFileSync(fruit).subarray(0, 4).toString('ascii'), 'glTF');
});

function assertTextureSet(folder, base, maps) {
  for (const map of maps) {
    assert.ok(existsSync(`${assets}${folder}/${base}_${map}.png`), `${base}_${map}.png`);
  }
}
