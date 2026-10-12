import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/api/seedthree.js';
import { commonHornbeam } from '../src/species/common-hornbeam.js';
import { SPECIES } from '../src/species/index.js';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));

test('common hornbeam coppiced shrub is a registered, upright coppiced shrub', () => {
  assert.equal(SPECIES.commonHornbeam, commonHornbeam);
  assert.equal(commonHornbeam.foliageType, 'sprayClusters');
  assert.equal(commonHornbeam.params.trunks, 5);
  assert.ok(commonHornbeam.params.curlUp > 0.3);
  assert.equal(commonHornbeam.fruit, undefined);
  const grown = generate({ species: 'commonHornbeam', seed: 7 });
  assert.equal(grown.stats.summary.lodCount, 3);
  assert.ok(grown.group.userData.leafInstances > 0);
  assert.ok(grown.stats.summary.widthMeters > 0.5);
  assert.ok(grown.stats.summary.heightMeters > 0.5);
});

test('common hornbeam coppiced shrub owns complete bark and foliage assets', () => {
  assertTextureSet('bark', 'hornbeam_hedge_branch', ['albedo', 'normal', 'roughness']);
  assertTextureSet('leaves', 'hornbeam_hedge_spray', ['albedo', 'normal', 'roughness', 'translucency']);
});

function assertTextureSet(folder, base, maps) {
  for (const map of maps) {
    assert.ok(existsSync(`${assets}${folder}/${base}_${map}.png`), `${base}_${map}.png`);
  }
}
