import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate, skeleton } from '../src/api/seedthree.js';
import { commonFern } from '../src/species/common-fern.js';
import { SPECIES } from '../src/species/index.js';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));

test('common fern is a registered barkless radial-frond species', () => {
  assert.equal(SPECIES.commonFern, commonFern);
  assert.equal(commonFern.foliageType, 'fern');
  assert.equal(commonFern.bark, null);
  assert.equal(skeleton({ species: 'commonFern', seed: 7 }).generator, 'radial-fronds');

  const grown = generate({ species: 'commonFern', seed: 7 });
  assert.equal(grown.stats.summary.lodCount, 3);
  assert.equal(grown.group.userData.stemCount, 0);
  assert.equal(grown.group.userData.leafInstances, commonFern.foliage.frondCount);
  const counts = grown.group.levels.map(({ object }) => object.children[0].userData.frondCount);
  assert.ok(counts[0] > counts[1] && counts[1] > counts[2], counts);
  assert.ok(grown.stats.summary.widthMeters > 0.5);
  assert.ok(grown.stats.summary.heightMeters > 0.4);
});

test('common fern owns a complete frond texture set and no bark set', () => {
  for (const map of ['albedo', 'normal', 'roughness', 'translucency']) {
    assert.ok(existsSync(`${assets}leaves/fern_${map}.png`), `fern_${map}.png`);
  }
  assert.equal(existsSync(`${assets}bark/fern_branch_albedo.png`), false);
});

test('fronds crest before their tip and follow the diagonal texture rachis', () => {
  const grown=generate({species:'commonFern',seed:7});
  const mesh=grown.group.levels[0].object.children[0].children[0];
  const p=mesh.geometry.attributes.position, uv=mesh.geometry.attributes.uv;
  const last=p.count-1;
  const apex=Math.max(...Array.from({length:p.count},(_,i)=>p.getY(i)));
  assert.ok(apex>p.getY(last), 'tip must descend from an earlier crest');
  assert.ok(p.getZ(last)>.7, 'tip must arch outward');
  assert.ok(Math.abs((uv.getX(0)+uv.getX(1))/2-.25)<.001);
  assert.ok(Math.abs((uv.getX(last-1)+uv.getX(last))/2-.92)<.001);
});
