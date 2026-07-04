// Loblolly / southern yellow pine (Pinus taeda) — the classic southern pine: a tall,
// straight trunk that self-prunes to a LONG CLEAR BOLE carrying a relatively small,
// rounded crown HIGH up (baseSize high). Long needles in bundles of 3, reddish scaly-
// plated bark. Conifer path (Weber-Penn conifer recipe — see pine.js / morphology).

import { broadleafControls } from './broadleaf-controls.js';

export const loblolly = {
  name: 'Loblolly Pine',
  latin: 'Pinus taeda',
  bark: 'loblolly_albedo.png',
  leaf: 'loblolly_needle_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.2,
  controls: broadleafControls,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.2, clusterSizeVar: 0.3, clusterQuads: 2,
    tint: 0xccd6b8, leavesPerBranch: 8, size: 0.85, downAngle: 55, bend: 0, startFrac: 0.2, // long needle sprays (bigger cards)
  },
  params: {
    scale: 30, scaleV: 3, levels: 3, ratio: 0.018, ratioPower: 1.4,
    baseSize: 0.5 /* self-pruned: long clear bole, crown HIGH */, shape: 0 /* conical crown */, flare: 0.4, attractionUp: 0.15,
    baseSplits: 0, baseSplitAngle: 0,
    //          trunk  L1     L2     L3
    length:    [1.0,  0.35,  0.34,  0.28], lengthV: [0.0, 0.1, 0.1, 0.1],
    taper:     [1.0,  1.0,   1.0,   1.0],  curveRes: [14, 6, 4, 3],
    curve:     [2,    12,    14,    0],    curveBack: [0, 0, 0, 0], curveV: [5, 22, 26, 26],
    downAngle: [0,    72,    68,    62],   downAngleV: [0, 12, 14, 14], // ascending-horizontal limbs
    rotate:    [0,    137,   137,   137],  rotateV: [0, 24, 24, 24],
    branches:  [0,    40,    16,    0],    radialSegments: [12, 6, 4, 3],
  },
};
