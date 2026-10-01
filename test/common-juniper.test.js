import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/api/seedthree.js';
import { commonJuniper } from '../src/species/common-juniper.js';
import { SPECIES } from '../src/species/index.js';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));

test('common juniper is a registered, foliated dichotomous shrub', () => {
  assert.equal(SPECIES.commonJuniper, commonJuniper);
  assert.equal(commonJuniper.foliageType, 'sprayClusters');
  assert.equal(commonJuniper.fruit.mesh, 'juniper_berry.glb');
  assert.equal(commonJuniper.fruit.maxCount, 20);
  const grown = generate({ species: 'commonJuniper', seed: 7 });
  assert.equal(grown.stats.summary.lodCount, 3);
  assert.ok(grown.group.userData.leafInstances > 0);
  assert.ok(grown.stats.summary.widthMeters > 0.8);
  assert.ok(grown.stats.summary.heightMeters > 0.5);
});

test('common juniper owns complete bark, foliage, and binary fruit assets', () => {
  assertTextureSet('bark', 'common_juniper_branch', ['albedo', 'normal', 'roughness']);
  assertTextureSet('leaves', 'juniper_scrub', ['albedo', 'normal', 'roughness', 'translucency']);
  const fruit = `${assets}fruits/juniper_berry.glb`;
  assert.ok(existsSync(fruit));
  assert.equal(readFileSync(fruit).subarray(0, 4).toString('ascii'), 'glTF');
});

function assertTextureSet(folder, base, maps) {
  for (const map of maps) {
    assert.ok(existsSync(`${assets}${folder}/${base}_${map}.png`), `${base}_${map}.png`);
  }
}
