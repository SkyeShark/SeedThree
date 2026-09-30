import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { placeholderAssets } from '../src/api/seedthree.js';
import { prepareFruitGeometry } from '../src/core/fruit.js';
import { buildTree } from '../src/core/tree.js';
import { blackbrush } from '../src/species/blackbrush.js';

test('dichotomous shrubs carry deterministic real fruit on their near LODs', () => {
  const species = {
    ...blackbrush,
    name: 'Fruit integration shrub',
    fruit: {
      mesh: 'test-fruit.glb',
      perBranch: 3,
      chance: 1,
      startFrac: 0.18,
      maxCount: 12,
    },
  };
  const assets = placeholderAssets('blackbrush');
  assets.fruitGeo = prepareFruitGeometry(new BoxGeometry(0.008, 0.012, 0.008));
  assets.fruitMat = new MeshStandardNodeMaterial({ roughness: 1 });

  const first = buildTree(species, 7, assets);
  const nearCounts = first.group.levels
    .map(({ object }) => object.userData.fruitMesh?.count ?? 0);
  assert.ok(nearCounts[0] > 0 && nearCounts[0] <= 12, nearCounts);
  assert.ok(nearCounts[1] > 0 && nearCounts[1] <= 4, nearCounts);
  assert.equal(nearCounts[2], 0);

  const rebuilt = buildTree(species, 7, assets, {}, first.group);
  const rebuiltCounts = rebuilt.group.levels
    .map(({ object }) => object.userData.fruitMesh?.count ?? 0);
  assert.deepEqual(rebuiltCounts, nearCounts);
  for (const { object } of rebuilt.group.levels) {
    assert.ok(object.children.filter((child) => child.name === 'fruit').length <= 1);
  }
});
