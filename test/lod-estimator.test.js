import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBranchGeometry,
  estimateBranchTriangles,
} from '../src/core/branch-mesh.js';
import { generateSkeleton } from '../src/core/weber-penn.js';
import { Rng } from '../src/core/rng.js';
import { floweringDogwood } from '../src/species/flowering-dogwood.js';

test('branch LOD estimator exactly matches emitted index triangles', () => {
  const { stems } = generateSkeleton(
    floweringDogwood.params,
    new Rng(`${floweringDogwood.name}:estimator`),
  );
  const variants = [
    {},
    { radialScale: 0.72 },
    { radialScale: 0.31, ringStride: 2 },
    { radialScale: 0.1, ringStride: 3 },
    { radialScale: 0.4, ringStride: 2, terminalSides: 3, terminalRingStride: 4 },
  ];

  for (const opts of variants) {
    const geometry = buildBranchGeometry(stems, opts);
    assert.equal(
      geometry.index.count / 3,
      estimateBranchTriangles(stems, opts),
      JSON.stringify(opts),
    );
    geometry.dispose();
  }
});

test('dogwood card rung preserves tips and uses crossed terminal pads', () => {
  assert.equal(floweringDogwood.preserveLod2Tips, true);
  assert.equal(floweringDogwood.crossedLod2Cards, true);
});
