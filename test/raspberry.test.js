import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/api/seedthree.js';
import { raspberry } from '../src/species/raspberry.js';
import { SPECIES } from '../src/species/index.js';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));

test('raspberry is a registered, foliated dichotomous shrub', () => {
  assert.equal(SPECIES.raspberry, raspberry);
  assert.equal(raspberry.foliageType, 'sprayClusters');
  assert.equal(raspberry.fruit.mesh, 'raspberry_cluster.glb');
  assert.equal(raspberry.fruit.maxCount, 10);
  const grown = generate({ species: 'raspberry', seed: 7 });
  assert.equal(grown.stats.summary.lodCount, 3);
  assert.ok(grown.group.userData.leafInstances > 0);
  assert.ok(grown.stats.summary.widthMeters > 0.6);
  assert.ok(grown.stats.summary.heightMeters > 0.4);
});

test('raspberry owns complete cane, foliage, and binary fruit assets', () => {
  assertTextureSet('bark', 'raspberry_cane', ['albedo', 'normal', 'roughness']);
  assertTextureSet('leaves', 'raspberry_spray', ['albedo', 'normal', 'roughness', 'translucency']);
  const fruit = `${assets}fruits/raspberry_cluster.glb`;
  assert.ok(existsSync(fruit));
  assert.equal(readFileSync(fruit).subarray(0, 4).toString('ascii'), 'glTF');
});

function assertTextureSet(folder, base, maps) {
  for (const map of maps) {
    assert.ok(existsSync(`${assets}${folder}/${base}_${map}.png`), `${base}_${map}.png`);
  }
}
