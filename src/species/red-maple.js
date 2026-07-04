// Red maple (Acer rubrum) — common Maryland/Camp Ramblewood tree; upright oval
// crown, single trunk, moderately dense upswept branches. See docs/morphology.md.

import { broadleafControls } from './broadleaf-controls.js';

export const redMaple = {
  name: 'Red Maple',
  latin: 'Acer rubrum',
  bark: 'red_maple_albedo.png',
  leaf: 'red_maple_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.3,
  controls: broadleafControls,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.2, clusterSizeVar: 0.3, clusterQuads: 2,
    tint: 0xdce4b4, leavesPerBranch: 7, size: 0.55, downAngle: 50, bend: 0, // many short twigs now → fewer leaves each
    trunkClearRadius: 0.85, // no leaves piling against the lower trunk
  },
  // Real red maple (Acer rubrum): a fairly straight single trunk carrying a dense
  // ROUNDED-OVAL crown of ASCENDING branches (maples sweep up), leaves on SHORT twigs.
  params: {
    scale: 15, scaleV: 2, levels: 3, ratio: 0.028, ratioPower: 1.3,
    baseSize: 0.18, shape: 1 /* spherical → rounded oval crown */, flare: 0.45, attractionUp: 0.5, // moderately clear trunk + ascending sweep
    baseSplits: 0, baseSplitAngle: 0,
    //          trunk  L1     L2(twig) L3
    length:    [1.0,  0.5,   0.16,   0.14], lengthV: [0.0, 0.1, 0.08, 0.06], // short leafy twigs, no whips
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [12, 6, 4, 3],
    curve:     [4,    18,    12,     0],    curveBack: [0, 0, 0, 0], curveV: [8, 38, 42, 42],
    downAngle: [0,    48,    55,     58],   downAngleV: [0, 12, 14, 14], // ascending limbs
    rotate:    [0,    137,   137,    137],  rotateV: [0, 20, 20, 20],
    branches:  [0,    34,    20,     0],    radialSegments: [12, 8, 6, 4],
  },
};
