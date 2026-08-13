// Paper birch (Betula papyrifera) — a cool-climate pioneer with a slender
// trunk, low ascending limbs, and a loose pyramidal crown that rounds and
// becomes irregular with age. Open-grown trees may be multi-stemmed.
// The signature bark is chalky white, horizontally lenticeled, and peeling;
// foliage is made from small, alternate, doubly serrate ovate leaves.
// Sources: USDA Forest Service FEIS/Silvics; NC State Extension.

import { broadleafControls } from './broadleaf-controls.js';

export const paperBirch = {
  name: 'Paper Birch',
  latin: 'Betula papyrifera',
  bark: 'paper_birch_albedo.png',
  leaf: 'paper_birch_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.0,
  controls: broadleafControls,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.05, clusterSizeVar: 0.28, clusterQuads: 2,
    tint: 0xd7e6b5, leavesPerBranch: 28, size: 0.20, sizeVar: 0.22, widthRatio: 0.68,
    startFrac: 0.18, downAngle: 50, droop: 18, bend: 0,
    trunkClearRadius: 0.32,
  },
  // Forest paper birch is narrow and straight; in open sites the crown begins
  // lower and spreads, often on two slim leaders. A spherical length envelope
  // gives the mature oval crown, while moderate upward tropism preserves the
  // characteristic light, ascending branchwork instead of an oak-like dome.
  params: {
    scale: 18, scaleV: 2, levels: 3, ratio: 0.0095, ratioPower: 1.3,
    baseSize: 0.12, shape: 1 /* mature irregular oval/rounded crown */, flare: 0.25, attractionUp: 0.25,
    baseSplits: 0, baseSplitAngle: 12,
    //          trunk  L1     L2(twig) L3
    length:    [1.0,  0.36,  0.16,   0.14], lengthV: [0.0, 0.09, 0.08, 0.06],
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [12, 6, 4, 3],
    curve:     [3,    5,     8,      0],    curveBack: [0, 0, 0, 0], curveV: [8, 34, 42, 38],
    downAngle: [0,    80,    55,     55],   downAngleV: [0, 10, 14, 16],
    downAngleProgress: [0, -34, -10, 0],
    rotate:    [0,    137,   137,    137],  rotateV: [0, 24, 24, 24],
    branches:  [0,    24,    28,     0],    radialSegments: [10, 6, 4, 3],
    branchStart: [0, 0.12, 0.22, 0],
    branchEnd: [1, 0.94, 0.98, 1],
    branchDistPower: [1, 1, 0.72, 1],
    branchJitter: [0, 0.015, 0.025, 0],
    lengthScaleBase: [1, 1, 1, 1],
    lengthScaleTip: [1, 0.55, 1.10, 1],
  },
};
