// Sweet cherry (Prunus avium) — compact upright orchard tree with a rounded
// crown, ascending scaffold branches and fine outer twigs.

import { broadleafControls } from './broadleaf-controls.js';

export const cherry = {
  name: 'Sweet Cherry',
  latin: 'Prunus avium',
  bark: 'red_maple_albedo.png',
  leaf: 'red_maple_single_albedo.png',
  biome: 'temperate',
  controls: broadleafControls,
  foliage: {
    mode: 'leaves',
    clustersPerBranch: 3,
    clusterSize: 0.68,
    clusterSizeVar: 0.2,
    clusterQuads: 2,
    tint: 0xcce0a9,
    leavesPerBranch: 8,
    size: 0.22,
    downAngle: 48,
    bend: 0,
    trunkClearRadius: 0.3,
  },
  params: {
    scale: 4.85,
    scaleV: 0.48,
    levels: 3,
    ratio: 0.038,
    ratioPower: 1.3,
    baseSize: 0.27,
    shape: 1,
    flare: 0.4,
    attractionUp: 0.62,
    baseSplits: 1,
    baseSplitAngle: 12,
    //          trunk L1    L2    L3
    length:    [1,    0.48, 0.31, 0.18],
    lengthV:   [0,    0.14, 0.12, 0.08],
    taper:     [1,    1,    1,    1],
    curveRes:  [8,    5,    4,    3],
    curve:     [5,    22,   22,   0],
    curveBack: [0,   -8,    0,    0],
    curveV:    [9,    46,   50,   46],
    downAngle: [0,    55,   51,   48],
    downAngleV:[0,    17,   20,   20],
    rotate:    [0,    137,  137,  137],
    rotateV:   [0,    25,   28,   28],
    branches:  [0,    19,   12,   0],
    radialSegments: [9, 7, 5, 4],
  },
};
