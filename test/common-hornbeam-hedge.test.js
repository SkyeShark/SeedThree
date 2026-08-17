import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/api/seedthree.js';
import { commonHornbeamHedge } from '../src/species/common-hornbeam-hedge.js';
import { SPECIES } from '../src/species/index.js';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));

test('common hornbeam field hedge is a registered, upright coppiced shrub', () => {
  assert.equal(SPECIES.commonHornbeamHedge, commonHornbeamHedge);
  assert.equal(commonHornbeamHedge.foliageType, 'sprayClusters');
  assert.equal(commonHornbeamHedge.params.trunks, 5);
  assert.ok(commonHornbeamHedge.params.curlUp > 0.3);
  assert.equal(commonHornbeamHedge.fruit, undefined);
  const grown = generate({ species: 'commonHornbeamHedge', seed: 7 });
  assert.equal(grown.stats.summary.lodCount, 3);
  assert.ok(grown.group.userData.leafInstances > 0);
  assert.ok(grown.stats.summary.widthMeters > 0.5);
  assert.ok(grown.stats.summary.heightMeters > 0.5);
});

test('common hornbeam field hedge owns complete bark and foliage assets', () => {
  assertTextureSet('bark', 'hornbeam_hedge_branch', ['albedo', 'normal', 'roughness']);
  assertTextureSet('leaves', 'hornbeam_hedge_spray', ['albedo', 'normal', 'roughness', 'translucency']);
});

function assertTextureSet(folder, base, maps) {
  for (const map of maps) {
    assert.ok(existsSync(`${assets}${folder}/${base}_${map}.png`), `${base}_${map}.png`);
  }
}
