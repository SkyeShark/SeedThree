// Tulip poplar (Liriodendron tulipifera) — the tall straight Maryland forest
// giant; long clear trunk, narrow oval crown carried high, strongly upright.

import { broadleafControls } from './broadleaf-controls.js';

export const tulipPoplar = {
  name: 'Tulip Poplar',
  latin: 'Liriodendron tulipifera',
  bark: 'tulip_poplar_albedo.png',
  leaf: 'tulip_poplar_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.7,
  controls: broadleafControls,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.2, clusterSizeVar: 0.3, clusterQuads: 2,
    tint: 0xcfe8b4, leavesPerBranch: 7, size: 0.6, downAngle: 48, bend: 0, // many short twigs now
    trunkClearRadius: 0.8, // keep leaves off the long clear bole (height-tapered)
  },
  // Real tulip poplar (Liriodendron): VERY tall, straight EXCURRENT trunk that self-
  // prunes to a long clear bole (baseSize high), carrying a relatively narrow, high
  // OVAL crown of ascending branches. Leaves on SHORT twigs.
  params: {
    scale: 26, scaleV: 2.5, levels: 3, ratio: 0.024, ratioPower: 1.35,
    baseSize: 0.42 /* tall clear trunk */, shape: 4 /* tapered cyl → narrow high oval */, flare: 0.4, attractionUp: 0.85 /* strongly upright leader */,
    baseSplits: 0, baseSplitAngle: 0,
    //          trunk  L1     L2(twig) L3
    length:    [1.0,  0.4,   0.15,   0.13], lengthV: [0.0, 0.1, 0.07, 0.06],
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [12, 6, 4, 3],
    curve:     [4,    16,    10,     0],    curveBack: [0, 0, 0, 0], curveV: [8, 34, 38, 38],
    downAngle: [0,    45,    50,     52],   downAngleV: [0, 12, 14, 14], // ascending upper-crown limbs
    rotate:    [0,    140,   140,    140],  rotateV: [0, 20, 20, 20],
    branches:  [0,    36,    20,     0],    radialSegments: [14, 8, 6, 4],
  },
};
