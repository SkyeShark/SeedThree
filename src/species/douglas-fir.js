// Douglas fir (Pseudotsuga menziesii) — the iconic PNW conifer: VERY tall, straight
// EXCURRENT leader carrying a dense CONICAL crown of near-horizontal branches whose tips
// DROOP, clothed in soft flat blue-green needle sprays; very thick, deeply-furrowed dark
// corky bark. Conifer path (Weber-Penn conifer recipe — see pine.js / morphology).

import { broadleafControls } from './broadleaf-controls.js';

export const douglasFir = {
  name: 'Douglas Fir',
  latin: 'Pseudotsuga menziesii',
  bark: 'douglas_fir_albedo.png',
  leaf: 'douglas_fir_needle_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.3,
  controls: broadleafControls,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.1, clusterSizeVar: 0.3, clusterQuads: 2,
    tint: 0xc6d2b4, leavesPerBranch: 10, size: 0.6, downAngle: 65, bend: 0, startFrac: 0.15,
  },
  params: {
    scale: 34, scaleV: 3, levels: 3, ratio: 0.02, ratioPower: 1.4,
    baseSize: 0.12 /* clothed conical crown (young) */, shape: 0 /* conical spire */, flare: 0.5, attractionUp: 0.0, // limbs horizontal, tips droop
    baseSplits: 0, baseSplitAngle: 0,
    //          trunk  L1     L2     L3
    length:    [1.0,  0.34,  0.34,  0.28], lengthV: [0.0, 0.08, 0.1, 0.1],
    taper:     [1.0,  1.0,   1.0,   1.0],  curveRes: [14, 6, 4, 3],
    curve:     [2,    16,    22,    0],    curveBack: [0, 0, 0, 0], curveV: [4, 18, 24, 24], // limb tips curve down (drooping fir habit)
    downAngle: [0,    84,    82,    78],   downAngleV: [0, 10, 12, 12], // near-horizontal, drooping tips
    rotate:    [0,    137,   137,   137],  rotateV: [0, 22, 22, 22],
    branches:  [0,    52,    18,    0],    radialSegments: [12, 6, 4, 3], // very dense conifer
  },
};
