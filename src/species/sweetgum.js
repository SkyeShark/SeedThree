// Sweetgum (Liquidambar styraciflua) — Maryland fields/edges; young pyramidal
// crown maturing to a rounded oval, single trunk, corky ridged bark, star leaves.

import { broadleafControls } from './broadleaf-controls.js';

export const sweetgum = {
  name: 'Sweetgum',
  latin: 'Liquidambar styraciflua',
  bark: 'sweetgum_albedo.png',
  leaf: 'sweetgum_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.4,
  controls: broadleafControls,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.25, clusterSizeVar: 0.3, clusterQuads: 2,
    tint: 0xcfe4ac, leavesPerBranch: 7, size: 0.55, downAngle: 55, bend: 0, // 520 short twigs now → fewer leaves each
    trunkClearRadius: 0.75, // no leaves intersecting the trunk column
  },
  // Real sweetgum (Liquidambar): EXCURRENT — one straight central leader that does NOT
  // fork (baseSplits 0), CONICAL/pyramidal when young (shape 0), with well-spaced,
  // small-diameter branches that ascend then droop slightly at the tips. Leaves ride
  // SHORT twigs (length[2] small), not the 2 m straight wires the old flame preset made.
  params: {
    scale: 16, scaleV: 2, levels: 3, ratio: 0.025, ratioPower: 1.3,
    baseSize: 0.12, shape: 0 /* conical → young pyramidal crown */, flare: 0.4, attractionUp: 0.15, // low leader dominance keeps a straight central spire
    baseSplits: 0, baseSplitAngle: 0,
    //          trunk  L1     L2(twig) L3
    length:    [1.0,  0.45,  0.16,   0.14], lengthV: [0.0, 0.1, 0.08, 0.06], // short leafy twigs, not long whips
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [12, 6, 4, 3],
    curve:     [3,    14,    8,      0],    curveBack: [0, 0, 0, 0], curveV: [8, 28, 32, 32], // fairly straight, gently gnarled
    downAngle: [0,    55,    62,     66],   downAngleV: [0, 12, 14, 14], // ascending limbs, tips droop a touch (sweetgum habit)
    rotate:    [0,    137,   137,    137],  rotateV: [0, 20, 20, 20],
    branches:  [0,    40,    22,     0],    radialSegments: [12, 8, 6, 4], // dense, well-spaced pyramid of short twigs
  },
};
