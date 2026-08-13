import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferAttribute, BufferGeometry, InstancedBufferAttribute, Matrix4, Quaternion, Vector3,
} from 'three/webgpu';

import { generate, getSchema, skeleton } from '../src/api/seedthree.js';
import { buildCardFoliage } from '../src/core/branch-cards.js';
import { buildFoliage } from '../src/core/leaf-cards.js';
import { generateSkeleton } from '../src/core/weber-penn.js';
import { Rng } from '../src/core/rng.js';
import { buildWillowCurtains } from '../src/core/willow-curtains.js';
import { floweringDogwood } from '../src/species/flowering-dogwood.js';
import { paperBirch } from '../src/species/paper-birch.js';
import { quakingAspen } from '../src/species/quaking-aspen.js';
import { americanSycamore } from '../src/species/american-sycamore.js';
import { weepingWillow } from '../src/species/weeping-willow.js';
import { broadleafControls } from '../src/species/broadleaf-controls.js';

const ADDED_SPECIES = [
  'paperBirch',
  'quakingAspen',
  'americanSycamore',
  'floweringDogwood',
  'weepingWillow',
];

test('added species generate finite, foliated LOD0 trees', () => {
  for (const species of ADDED_SPECIES) {
    const { group, stats } = generate({ species, seed: 1 });
    assert.equal(stats.summary.lodCount, 3, species);
    assert.ok(stats.summary.lod0Triangles > 0, species);
    assert.ok(group.userData.leafInstances > 0, species);
    for (const value of [
      stats.summary.widthMeters,
      stats.summary.heightMeters,
      stats.summary.depthMeters,
      ...stats.boundingBox.min,
      ...stats.boundingBox.max,
    ]) assert.ok(Number.isFinite(value), `${species}: ${value}`);
  }
});

test('paper birch keeps a fine open crown with ascending upper limbs', () => {
  assert.ok(paperBirch.params.ratio >= 0.008 && paperBirch.params.ratio <= 0.011);
  assert.ok(paperBirch.foliage.size >= 0.16 && paperBirch.foliage.size <= 0.22);
  assert.ok(paperBirch.foliage.widthRatio < 0.8);

  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  for (const seed of [1, 2, 7, 13, 31]) {
    const { stems } = generateSkeleton(
      paperBirch.params,
      new Rng(`${paperBirch.name}:${seed}`),
    );
    const trunk = stems.find((stem) => stem.level === 0);
    const primaries = stems
      .filter((stem) => stem.level === 1)
      .sort((a, b) => a.points[0].y - b.points[0].y);
    const twigs = stems.filter((stem) => stem.level === 2);
    assert.equal(primaries.length, 24);
    assert.equal(twigs.length, 408);

    const trunkTop = trunk.points.at(-1);
    const firstDirectionY = (stem) => stem.points[1]
      .clone().sub(stem.points[0]).normalize().y;
    const quarter = primaries.length / 4;
    const lowerRise = average(primaries.slice(0, quarter).map(firstDirectionY));
    const upperRise = average(primaries.slice(-quarter).map(firstDirectionY));
    assert.ok(upperRise > lowerRise + 0.25, `branch-angle gradient seed ${seed}`);
    assert.ok(
      Math.hypot(trunkTop.x, trunkTop.z) / trunkTop.y < 0.07,
      `straight leader seed ${seed}`,
    );
    const maxBranchY = Math.max(
      ...stems.filter((stem) => stem.level > 0).flatMap((stem) => stem.points.map((p) => p.y)),
    );
    assert.ok(maxBranchY < trunkTop.y, `leader overtopped seed ${seed}`);

    const grown = generate({ species: 'paperBirch', seed });
    const crownRatio = grown.stats.summary.widthMeters / grown.stats.summary.heightMeters;
    assert.ok(crownRatio > 0.58 && crownRatio < 0.70, `open oval crown seed ${seed}`);
    assert.ok(grown.group.userData.leafInstances >= 10000);
    assert.ok(grown.stats.summary.lod0Triangles >= 50000);
    assert.ok(grown.stats.summary.lod0Triangles <= 70000);
  }
});

test('quaking aspen keeps a high narrow live crown and dominant leader', () => {
  assert.ok(quakingAspen.params.ratio >= 0.006 && quakingAspen.params.ratio <= 0.008);
  assert.ok(quakingAspen.foliage.size >= 0.18 && quakingAspen.foliage.size <= 0.24);
  assert.ok(quakingAspen.foliage.flutterScale >= 1.5);
  assert.ok(quakingAspen.foliage.widthRatio >= 0.95);

  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  for (const seed of [1, 2, 7, 13, 31]) {
    const { stems } = generateSkeleton(
      quakingAspen.params,
      new Rng(`${quakingAspen.name}:${seed}`),
    );
    const trunk = stems.find((stem) => stem.level === 0);
    const primaries = stems
      .filter((stem) => stem.level === 1)
      .sort((a, b) => a.points[0].y - b.points[0].y);
    const twigs = stems.filter((stem) => stem.level === 2);
    assert.equal(primaries.length, 20);
    assert.equal(twigs.length, 280);

    const trunkTop = trunk.points.at(-1);
    const firstCrownHeight = primaries[0].points[0].y / trunkTop.y;
    assert.ok(
      firstCrownHeight > 0.50 && firstCrownHeight < 0.56,
      `high live-crown base seed ${seed}: ${firstCrownHeight}`,
    );
    const firstDirectionY = (stem) => stem.points[1]
      .clone().sub(stem.points[0]).normalize().y;
    const quarter = primaries.length / 4;
    const lowerRise = average(primaries.slice(0, quarter).map(firstDirectionY));
    const upperRise = average(primaries.slice(-quarter).map(firstDirectionY));
    assert.ok(upperRise > lowerRise + 0.07, `modest angle gradient seed ${seed}`);
    assert.ok(
      Math.hypot(trunkTop.x, trunkTop.z) / trunkTop.y < 0.06,
      `straight aspen leader seed ${seed}`,
    );
    const maxBranchY = Math.max(
      ...stems.filter((stem) => stem.level > 0).flatMap((stem) => stem.points.map((p) => p.y)),
    );
    assert.ok(maxBranchY < trunkTop.y, `aspen leader overtopped seed ${seed}`);

    const grown = generate({ species: 'quakingAspen', seed });
    const crownRatio = grown.stats.summary.widthMeters / grown.stats.summary.heightMeters;
    assert.ok(crownRatio > 0.34 && crownRatio < 0.52, `narrow crown seed ${seed}`);
    assert.ok(grown.group.userData.leafInstances >= 10000);
    assert.ok(grown.group.userData.leafInstances <= 12000);
    assert.ok(grown.stats.summary.lod0Triangles >= 45000);
    assert.ok(grown.stats.summary.lod0Triangles <= 60000);
  }
});

test('american sycamore keeps a shared low bole and distributed fine-shoot crown', () => {
  assert.equal(americanSycamore.terminalStemsAreGuides, true);
  assert.equal(americanSycamore.foliage.quads, 1);
  assert.ok(americanSycamore.foliage.size >= 0.22 && americanSycamore.foliage.size <= 0.28);
  assert.ok(americanSycamore.params.lengthMax[1] <= 13.5);

  for (const seed of [1, 2, 7, 13, 31]) {
    const { stems } = generateSkeleton(
      americanSycamore.params,
      new Rng(`${americanSycamore.name}:${seed}`),
    );
    const byLevel = Object.fromEntries([0, 1, 2, 3].map((level) => [
      level,
      stems.filter((stem) => stem.level === level),
    ]));
    assert.equal(byLevel[0].length, 3);
    assert.equal(byLevel[1].length, 10);
    assert.equal(byLevel[2].length, 130);
    assert.equal(byLevel[3].length, 3120);

    const roots = stems.filter((stem) => stem.parentId === -1);
    const bole = stems.find((stem) => stem.role === 'sharedBole');
    const leaders = stems.filter((stem) => stem.role === 'trunkLeader');
    assert.deepEqual(roots, [bole]);
    assert.equal(leaders.length, 2);
    assert.ok(leaders.every((leader) => leader.parentId === bole.id));
    assert.ok(leaders.every((leader) => (
      leader.points[0].distanceTo(bole.points.at(-1)) < 1e-6
    )));

    const allPoints = stems.flatMap((stem) => stem.points);
    const minY = Math.min(...allPoints.map((point) => point.y));
    const maxY = Math.max(...allPoints.map((point) => point.y));
    const forkRatio = (bole.points.at(-1).y - minY) / (maxY - minY);
    assert.ok(forkRatio > 0.17 && forkRatio < 0.23, `low shared fork seed ${seed}: ${forkRatio}`);
    for (const leader of leaders) {
      const children = byLevel[1].filter((stem) => stem.parentId === leader.id);
      const stub = Math.min(...children.map((stem) => (
        stem.points[0].distanceTo(leader.points.at(-1))
      )));
      assert.ok(stub < 0.55, `trimmed leader seed ${seed}: ${stub}`);
    }

    assert.ok(byLevel[3].every((stem) => stem.length >= 0.65 && stem.length <= 1.55));
    const turns = byLevel[2].flatMap((stem) => {
      const dirs = stem.points.slice(1).map((point, i) => (
        point.clone().sub(stem.points[i]).normalize()
      ));
      return dirs.slice(1).map((dir, i) => (
        Math.acos(Math.max(-1, Math.min(1, dir.dot(dirs[i])))) * 180 / Math.PI
      ));
    }).sort((a, b) => a - b);
    const medianTurn = turns[Math.floor(turns.length / 2)];
    assert.ok(medianTurn > 18 && medianTurn < 25, `stout zigzag twigs seed ${seed}: ${medianTurn}`);

    const grown = generate({ species: 'americanSycamore', seed });
    const bare = generate({
      species: 'americanSycamore', seed, controls: { showLeaves: false },
    });
    assert.ok(grown.group.userData.leafInstances >= 37000);
    assert.ok(grown.group.userData.leafInstances <= 37500);
    assert.equal(
      grown.stats.summary.lod0Triangles - bare.stats.summary.lod0Triangles,
      grown.group.userData.leafInstances * 2,
    );
    assert.ok(bare.stats.summary.lod0Triangles < 15000);
    assert.ok(grown.stats.summary.lod0Triangles >= 88000);
    assert.ok(grown.stats.summary.lod0Triangles <= 90000);
    const height = grown.stats.summary.heightMeters;
    const spans = [grown.stats.summary.widthMeters, grown.stats.summary.depthMeters];
    assert.ok(Math.max(...spans) / height > 0.95);
    assert.ok(Math.max(...spans) / height < 1.40);
    assert.ok(Math.min(...spans) / height > 0.70);
  }
});

test('willow ends real wood at feeders and builds dense curved foliage directly', () => {
  const sk = skeleton({ species: 'weepingWillow', seed: 1 });
  const withLeaves = generate({ species: 'weepingWillow', seed: 1 });
  const bare = generate({ species: 'weepingWillow', seed: 1, controls: { showLeaves: false } });

  assert.deepEqual(sk.stemsByLevel, { 0: 1, 1: 9, 2: 56 });
  assert.equal(sk.tips, 56);
  assert.ok(withLeaves.group.userData.leafInstances >= 1000 && withLeaves.group.userData.leafInstances <= 1400);
  assert.notEqual(withLeaves.group.userData.leafInstances, sk.tips);
  assert.ok(withLeaves.stats.summary.lod0Triangles >= 50000);
  assert.ok(withLeaves.stats.summary.lod0Triangles < 80000);

  const foliage = withLeaves.group.levels[0].object.children.find((o) => o.name === 'willow-curtains');
  assert.ok(foliage?.isMesh);
  assert.ok(!foliage.isInstancedMesh);
  assert.equal(foliage.userData.feederCount, sk.tips);
  assert.equal(
    withLeaves.stats.summary.lod0Triangles - bare.stats.summary.lod0Triangles,
    foliage.userData.vineCount * foliage.userData.trianglesPerVine,
  );
  for (const key of ['aWindVec', 'aAnchorPos', 'aThickness']) {
    assert.ok(foliage.geometry.attributes[key], key);
  }

  // Every ribbon follows one continuous curve: it begins in the sampled feeder
  // frame, arches outward, and keeps a slight sweep through the whole pendant
  // tail instead of resolving into a straight vertical edge.
  const segments = weepingWillow.foliage.segments;
  const sheets = weepingWillow.foliage.quads;
  const vertsPerVine = (segments + 1) * 2 * sheets;
  const positions = foliage.geometry.attributes.position.array;
  const center = (vine, ring) => {
    const a = (vine * vertsPerVine + ring * 2) * 3;
    return [
      (positions[a] + positions[a + 3]) / 2,
      (positions[a + 1] + positions[a + 4]) / 2,
      (positions[a + 2] + positions[a + 5]) / 2,
    ];
  };

  // Desktop LOD1 keeps every individual curved vine and reduces only curve
  // tessellation. The still-large on-screen crown therefore retains every
  // attachment while staying comfortably inside a desktop triangle budget.
  const lod1Foliage = withLeaves.group.levels[1].object.children
    .find((o) => o.name === 'willow-curtains');
  assert.ok(lod1Foliage?.isMesh && !lod1Foliage.isInstancedMesh);
  const lod1KeepRatio = lod1Foliage.userData.vineCount / foliage.userData.vineCount;
  assert.equal(lod1KeepRatio, 1);
  assert.equal(lod1Foliage.userData.trianglesPerVine, 7 * sheets * 2);
  const lod1Ratio = withLeaves.stats.perLod[1].triangles
    / withLeaves.stats.perLod[0].triangles;
  assert.ok(lod1Ratio > 0.56 && lod1Ratio < 0.60, lod1Ratio);

  const lod1Segments = 7;
  const lod1VertsPerVine = (lod1Segments + 1) * 2 * sheets;
  const lod1Positions = lod1Foliage.geometry.attributes.position.array;
  const lod0Roots = new Set(Array.from(
    { length: foliage.userData.vineCount },
    (_, vine) => center(vine, 0).map((x) => x.toFixed(5)).join(','),
  ));
  for (let vine = 0; vine < lod1Foliage.userData.vineCount; vine++) {
    const a = vine * lod1VertsPerVine * 3;
    const lod1Root = [
      (lod1Positions[a] + lod1Positions[a + 3]) / 2,
      (lod1Positions[a + 1] + lod1Positions[a + 4]) / 2,
      (lod1Positions[a + 2] + lod1Positions[a + 5]) / 2,
    ];
    assert.ok(lod0Roots.has(lod1Root.map((x) => x.toFixed(5)).join(',')));
  }
  const direction = (a, b) => {
    const v = b.map((x, i) => x - a[i]);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const angle = (a, b) => Math.acos(Math.max(
    -1, Math.min(1, a.reduce((sum, x, i) => sum + x * b[i], 0)),
  )) * 180 / Math.PI;
  const bends = [];
  const lengths = [];
  const maxJointTurns = [];
  const curveDeviations = [];
  let minRootY = Infinity;
  const tailHorizontals = [];
  for (let vine = 0; vine < foliage.userData.vineCount; vine++) {
    const path = Array.from({ length: segments + 1 }, (_, ring) => center(vine, ring));
    minRootY = Math.min(minRootY, path[0][1]);
    lengths.push(path.slice(1).reduce(
      (sum, point, i) => sum + Math.hypot(...point.map((x, axis) => x - path[i][axis])),
      0,
    ));
    const directions = path.slice(1).map((point, i) => direction(path[i], point));
    const start = directions[0];
    const tail = directions.at(-1);
    tailHorizontals.push(Math.hypot(tail[0], tail[2]));
    bends.push(angle(start, tail));
    maxJointTurns.push(Math.max(...directions.slice(1).map((dir, i) => angle(directions[i], dir))));

    const chord = path.at(-1).map((x, i) => x - path[0][i]);
    const chordLength = Math.hypot(...chord);
    const chordDir = chord.map((x) => x / chordLength);
    let maxDeviation = 0;
    for (const point of path) {
      const rel = point.map((x, i) => x - path[0][i]);
      const projection = rel.reduce((sum, x, i) => sum + x * chordDir[i], 0);
      maxDeviation = Math.max(maxDeviation, Math.hypot(
        ...rel.map((x, i) => x - projection * chordDir[i]),
      ));
    }
    curveDeviations.push(maxDeviation);
  }
  bends.sort((a, b) => a - b);
  lengths.sort((a, b) => a - b);
  maxJointTurns.sort((a, b) => a - b);
  curveDeviations.sort((a, b) => a - b);
  tailHorizontals.sort((a, b) => a - b);
  assert.ok(bends[Math.floor(bends.length / 2)] > 75);
  assert.ok(lengths[Math.floor(lengths.length / 2)] > 5.2);
  assert.ok(maxJointTurns.at(-1) < 45); // no 90-degree elbow anywhere
  assert.ok(curveDeviations[Math.floor(curveDeviations.length / 2)] > 1);
  const medianTailHorizontal = tailHorizontals[Math.floor(tailHorizontals.length / 2)];
  assert.ok(medianTailHorizontal > 0.05); // subtle continuing arc, not a vertical edge
  assert.ok(tailHorizontals.at(-1) < 0.22); // still hangs rather than looking windblown
  const feederSkeleton = generateSkeleton(weepingWillow.params, new Rng(`${weepingWillow.name}:1`));
  const feederTop = Math.max(...feederSkeleton.stems.filter((s) => s.level === 2).flatMap((s) => s.points.map((p) => p.y)));
  const expectedRootMin = weepingWillow.foliage.floorMin
    + (feederTop - weepingWillow.foliage.floorMin) * weepingWillow.foliage.attachmentMinHeightRatio;
  assert.ok(minRootY >= expectedRootMin - 1e-5);

  let minVertexY = Infinity;
  for (let i = 1; i < positions.length; i += 3) minVertexY = Math.min(minVertexY, positions[i]);
  assert.ok(minVertexY >= weepingWillow.foliage.floorMin - 1e-5);
  const uv = foliage.geometry.attributes.uv.array;
  assert.equal(Math.min(...uv), 0);
  assert.equal(Math.max(...uv), 1);

  const mobile = generate({ species: 'weepingWillow', seed: 1, lod: { mobileTarget: true } });
  const far = mobile.group.levels.find((level) => level.object.userData.lodName === 'LOD4')?.object;
  assert.equal(far?.userData.cardLevel, 2);
  const mobileWoodTris = ['LOD2', 'LOD3', 'LOD4'].map((lodName) => {
    const level = mobile.group.levels.find((entry) => entry.object.userData.lodName === lodName)?.object;
    const wood = level?.children.find((object) => object.isMesh && object.name !== 'willow-curtains');
    assert.ok(wood?.geometry, `${lodName} wood`);
    return (wood.geometry.index?.count ?? wood.geometry.attributes.position.count) / 3;
  });
  assert.ok(
    mobileWoodTris[0] > mobileWoodTris[1]
      && mobileWoodTris[1] > mobileWoodTris[2],
    `mobile willow wood must decrease at every rung: ${mobileWoodTris.join(' > ')}`,
  );
  const resized = generate({ species: 'weepingWillow', seed: 1, controls: { leafSizeVar: 1 } });
  assert.equal(resized.shaped.foliage.sizeVar, 0);
});

test('willow keeps arching scaffolds and curved real feeders beneath the foliage veil', () => {
  for (const seed of [1, 2, 7, 13, 31]) {
    const { stems } = generateSkeleton(weepingWillow.params, new Rng(`${weepingWillow.name}:${seed}`));
    const trunk = stems.find((s) => s.level === 0);
    assert.ok(Math.hypot(trunk.points.at(-1).x, trunk.points.at(-1).z) < 1.5, `trunk seed ${seed}`);

    const primary = stems.filter((s) => s.level === 1).sort((a, b) => a.points[0].y - b.points[0].y);
    assert.equal(primary.length, 9);
    const tipY = (stem) => stem.points.at(-1).clone().sub(stem.points.at(-2)).normalize().y;
    const lowerTipY = (tipY(primary[0]) + tipY(primary[1])) / 2;
    const upperTipY = (tipY(primary.at(-1)) + tipY(primary.at(-2))) / 2;
    assert.ok(lowerTipY < -0.05, `lower scaffolds do not arch seed ${seed}`);
    assert.ok(upperTipY > lowerTipY + 0.1, `upper crown does not lift seed ${seed}`);

    const feeders = stems.filter((s) => s.level === 2);
    assert.ok(feeders.length >= 45 && feeders.length <= 65, `feeder count seed ${seed}`);
    assert.equal(stems.some((s) => s.level > 2), false);

    const grown = generate({ species: 'weepingWillow', seed });
    const foliage = grown.group.levels[0].object.children.find((o) => o.name === 'willow-curtains');
    assert.ok(foliage.userData.vineCount >= 900 && foliage.userData.vineCount <= 1500, `vine count seed ${seed}`);
    assert.equal(foliage.userData.feederCount, feeders.length);
    assert.ok(foliage.userData.vineCount / feeders.length >= 15);
  }
});

test('willow feeder-local sheet bakes retain full vines before live floor placement', () => {
  const q = new Quaternion().setFromUnitVectors(
    new Vector3(0, 1, 0),
    new Vector3(1, 0, 0),
  );
  const feeder = {
    points: [new Vector3(0, 0, 0), new Vector3(2, 0, 0)],
    orients: [q, q.clone()],
    winds: [0.6, 0.8],
  };
  const cfg = {
    ...weepingWillow.foliage,
    spacing: 0.1,
    floor: null,
    floorMin: null,
  };
  const free = buildWillowCurtains(
    [feeder], { ...cfg, disableFloor: true },
    new Rng('willow:canonical-sheet'), null,
  );
  assert.ok(free);
  assert.equal(free.userData.vineCount, 17);
  assert.ok(free.geometry.boundingBox.min.y < 0);

  const grouped = buildWillowCurtains(
    [feeder], {
      ...cfg, disableFloor: true,
      vineKeepFraction: weepingWillow.foliage.groupedCardVineKeepFraction,
    },
    new Rng('willow:canonical-sheet'), null,
  );
  assert.ok(grouped);
  assert.equal(grouped.userData.vineCount, 9);

  const clipped = buildWillowCurtains(
    [feeder], cfg,
    new Rng('willow:canonical-sheet'), null,
  );
  assert.equal(clipped, null);
  free.geometry.dispose();
  grouped.geometry.dispose();
});

test('willow sheet LOD thinning is exact, deterministic, and nested', () => {
  const feederCount = 56;
  const feeders = Array.from({ length: feederCount }, (_, id) => ({
    id,
    parentId: Math.floor(id / 7),
    points: [new Vector3(id, 10, 0), new Vector3(id + 1, 10, 0)],
    winds: [0.5, 0.7],
  }));
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -0.5, -1, 0, 0.5, -1, 0, 0.5, 1, 0, -0.5, 1, 0,
  ]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aWindVec', new InstancedBufferAttribute(new Float32Array(feederCount * 3), 3));
  geometry.setAttribute('aAnchorPos', new InstancedBufferAttribute(new Float32Array(feederCount * 3), 3));
  geometry.userData.willowBowed = {
    center: [0, 0, 0], halfW: 0.5, halfH: 1,
    view: 'front', horizontalScale: 1, verticalScale: 1,
  };
  const cards = {
    variants: [{ geometry, material: undefined, chordLen: 1, minY: -1 }],
    centerUniform: { value: new Vector3() },
    gravityAligned: true,
    foliageOnly: true,
    floorMin: 0,
  };
  const roots = (group) => {
    const out = new Set();
    const matrix = new Matrix4();
    for (const mesh of group.children) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        out.add(Math.round(matrix.elements[12]));
      }
    }
    return out;
  };
  const build = (keepFraction, seed, extra = {}) => buildCardFoliage(
    feeders,
    cards,
    new Rng(seed),
    { growScale: 1, keepFraction, stableKeep: true, ...extra },
  );

  const coarse = build(1, 'willow-sheet-coarse', { crossed: true, cardGrid: { cols: 4, rows: 5 } });
  const mid = build(0.55, 'willow-sheet-mid');
  const repeat = build(0.55, 'different-rng-must-not-reshuffle');
  const tuned = build(weepingWillow.foliage.groupedCardFeederKeepFraction, 'willow-sheet-tuned');
  const far = build(0.30, 'willow-sheet-far');
  const midRoots = roots(mid);
  const repeatRoots = roots(repeat);
  const farRoots = roots(far);
  assert.equal(midRoots.size, 31);
  assert.equal(farRoots.size, 17);
  assert.equal(roots(tuned).size, 45);
  assert.equal(coarse.children.reduce((n, mesh) => n + mesh.count, 0), feederCount * 2);
  for (const mesh of coarse.children) assert.equal(mesh.geometry.index.count / 3, 24);
  assert.deepEqual(repeatRoots, midRoots);
  for (const root of farRoots) assert.ok(midRoots.has(root));

  for (const group of [coarse, mid, repeat, tuned, far]) {
    group.traverse((object) => object.material?.dispose?.());
  }
  geometry.dispose();
});

test('willow delays and envelope-corrects grouped proxy rungs', () => {
  assert.deepEqual(weepingWillow.lodDistanceMultipliers, {
    lod1: 2.5, lod2: 6.5, billboard: 10.5,
  });
  assert.equal(weepingWillow.foliage.groupedCardHorizontalScale, 0.95);
  assert.equal(weepingWillow.foliage.groupedCardVerticalScale, 1.2);
  assert.equal(weepingWillow.foliage.groupedCardVineKeepFraction, 0.5);
  assert.equal(weepingWillow.foliage.groupedCardFeederKeepFraction, 0.8);
});

test('dogwood branches in same-node opposite, decussate pairs', () => {
  const { stems } = generateSkeleton(floweringDogwood.params, new Rng(`${floweringDogwood.name}:1`));
  const key = (s) => `${s.parentId}:${s.points[0].toArray().map((v) => v.toFixed(8)).join(',')}`;
  const trunks = stems.filter((stem) => stem.level === 0);
  assert.deepEqual(trunks.map((stem) => stem.role), ['sharedBole', 'trunkLeader', 'trunkLeader']);
  assert.equal(trunks.filter((stem) => stem.parentId < 0).length, 1);

  for (const [level, expectedNodes] of [[1, 6], [2, 132]]) {
    const groups = new Map();
    for (const stem of stems.filter((s) => s.level === level)) {
      const groupKey = key(stem);
      const group = groups.get(groupKey) ?? [];
      group.push(stem);
      groups.set(groupKey, group);
    }
    assert.equal(groups.size, expectedNodes);
    for (const pair of groups.values()) {
      assert.equal(pair.length, 2);
      const parent = stems[pair[0].parentId];
      const base = pair[0].points[0];
      let tangent = null, best = Infinity;
      for (let i = 0; i < parent.points.length - 1; i++) {
        const segment = parent.points[i + 1].clone().sub(parent.points[i]);
        const t = Math.max(0, Math.min(1, base.clone().sub(parent.points[i]).dot(segment) / segment.lengthSq()));
        const distance = parent.points[i].clone().addScaledVector(segment, t).distanceToSquared(base);
        if (distance < best) { best = distance; tangent = segment.normalize(); }
      }
      const a = pair[0].points[1].clone().sub(base).normalize();
      const b = pair[1].points[1].clone().sub(base).normalize();
      const radialA = a.clone().addScaledVector(tangent, -a.dot(tangent)).normalize();
      const radialB = b.clone().addScaledVector(tangent, -b.dot(tangent)).normalize();
      // Their shared forward component follows the parent, while their radial
      // components leave opposite sides of the same node.
      assert.ok(radialA.dot(radialB) < -0.9);
    }
  }
});

test('dogwood leaf cards are opposite at each node and decussate between nodes', () => {
  const stem = {
    points: [new Vector3(0, 0, 0), new Vector3(0, 4, 0)],
    orients: [new Quaternion(), new Quaternion()],
    winds: [0.4, 0.9],
  };
  const cfg = {
    leavesPerBranch: 6, size: 1, sizeVar: 0, widthRatio: 1, taper: 0,
    startFrac: 0.1, downAngle: 90, downAngleV: 0, droop: 0, bend: 0,
    quads: 1, trunkClearRadius: 0, whorlSize: 2, rotate: 90, rotateV: 0,
  };
  const foliage = buildFoliage([stem], cfg, new Rng('dogwood-leaf-pairs'), undefined, null);
  assert.equal(foliage.count, 6);
  const matrices = Array.from({ length: foliage.count }, (_, index) => {
    const matrix = new Matrix4();
    foliage.getMatrixAt(index, matrix);
    return matrix;
  });
  const position = (matrix) => new Vector3().setFromMatrixPosition(matrix);
  const direction = (matrix) => new Vector3(
    matrix.elements[4], matrix.elements[5], matrix.elements[6],
  ).normalize();
  for (let i = 0; i < matrices.length; i += 2) {
    assert.ok(position(matrices[i]).distanceTo(position(matrices[i + 1])) < 1e-7);
    assert.ok(direction(matrices[i]).dot(direction(matrices[i + 1])) < -0.999999);
  }
  assert.ok(Math.abs(direction(matrices[0]).dot(direction(matrices[2]))) < 1e-6);
  assert.ok(Math.abs(direction(matrices[2]).dot(direction(matrices[4]))) < 1e-6);
  foliage.geometry.dispose();
});

test('legacy one-leaf phyllotaxy remains byte-identical when whorlSize is explicit', () => {
  const stem = {
    points: [new Vector3(0, 0, 0), new Vector3(0, 3, 0)],
    orients: [new Quaternion(), new Quaternion()],
    winds: [0.4, 0.9],
  };
  const cfg = {
    leavesPerBranch: 7, size: 0.4, sizeVar: 0.2, widthRatio: 0.8,
    taper: 0.2, startFrac: 0.1, downAngle: 50, downAngleV: 12,
    droop: 8, droopV: 3, bend: 0.2, quads: 1, trunkClearRadius: 0,
  };
  const legacyRng = new Rng('legacy-leaves');
  const explicitRng = new Rng('legacy-leaves');
  const legacy = buildFoliage([stem], cfg, legacyRng, undefined, null);
  const explicit = buildFoliage(
    [stem], { ...cfg, whorlSize: 1, rotate: 11, rotateV: 99 },
    explicitRng, undefined, null,
  );
  assert.deepEqual(
    Array.from(legacy.instanceMatrix.array),
    Array.from(explicit.instanceMatrix.array),
  );
  for (const name of ['aWindVec', 'aAnchorPos', 'aThickness']) {
    assert.deepEqual(
      Array.from(legacy.geometry.getAttribute(name).array),
      Array.from(explicit.geometry.getAttribute(name).array),
    );
  }
  assert.equal(legacyRng._state, explicitRng._state);
  legacy.geometry.dispose();
  explicit.geometry.dispose();
});

test('dogwood keeps a low broad fork and hits its configured desktop LOD budgets', () => {
  assert.equal(floweringDogwood.preserveLod2Tips, true);
  assert.equal(floweringDogwood.foliage.clustersPerBranch % 2, 0);
  for (const seed of [1, 2, 7, 13, 31]) {
    const { stems } = generateSkeleton(
      floweringDogwood.params,
      new Rng(`${floweringDogwood.name}:${seed}`),
    );
    const bole = stems.find((stem) => stem.role === 'sharedBole');
    const maxY = Math.max(...stems.flatMap((stem) => stem.points.map((point) => point.y)));
    const boleRatio = bole.points.at(-1).y / maxY;
    assert.ok(boleRatio > 0.19 && boleRatio < 0.27, `low fork seed ${seed}: ${boleRatio}`);

    const grown = generate({ species: 'floweringDogwood', seed });
    const spreadRatio = grown.stats.summary.widthMeters / grown.stats.summary.heightMeters;
    const lod1Ratio = grown.stats.perLod[1].triangles / grown.stats.perLod[0].triangles;
    const lod2Ratio = grown.stats.perLod[2].triangles / grown.stats.perLod[0].triangles;
    assert.ok(spreadRatio > 1.05 && spreadRatio < 1.4, `broad crown seed ${seed}: ${spreadRatio}`);
    assert.ok(lod1Ratio > 0.49 && lod1Ratio < 0.53, `LOD1 seed ${seed}: ${lod1Ratio}`);
    assert.ok(lod2Ratio > 0.14 && lod2Ratio < 0.16, `LOD2 seed ${seed}: ${lod2Ratio}`);
  }
});

test('broadleaf controls and willow API defaults expose supported values', () => {
  assert.equal(broadleafControls.find((c) => c.key === 'levels').max, 3);
  const advanced = getSchema('weepingWillow').advanced;
  assert.equal(advanced.find((c) => c.key === 'forceDirY').default, 1);
  assert.equal(advanced.find((c) => c.key === 'forceStrength').default, 0);
});


