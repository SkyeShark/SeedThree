// Quaking aspen (Populus tremuloides) — a straight, slender, cold-climate
// pioneer with spreading limbs and a pyramidal young crown that matures into
// a narrow rounded canopy. Smooth cream-green bark darkens and furrows only at
// the old base; round, fine-toothed leaves flutter on flattened petioles.
// Sources: USDA Forest Service FEIS/Silvics; NPS; Utah State Extension.

import { broadleafControls } from './broadleaf-controls.js';

export const quakingAspen = {
  name: 'Quaking Aspen',
  latin: 'Populus tremuloides',
  bark: 'quaking_aspen_albedo.png',
  leaf: 'quaking_aspen_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.25,
  controls: broadleafControls,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.0, clusterSizeVar: 0.28, clusterQuads: 2,
    tint: 0xd9e8b9, leavesPerBranch: 38, size: 0.22, sizeVar: 0.22, widthRatio: 1.0, flutterScale: 1.7,
    startFrac: 0.15, downAngle: 48, droop: 12, bend: 0,
    trunkClearRadius: 0.22,
  },
  // One preset represents one ramet of a clonal grove: a single, nearly
  // uncurved bole with a compact crown, rather than a basal multi-trunk clump.
  // Short terminal twigs carry the small round leaves; existing foliage wind
  // supplies their diagnostic quaking motion without a species-only wind key.
  params: {
    scale: 20, scaleV: 2, levels: 3, ratio: 0.007, ratioPower: 1.35,
    baseSize: 0.52, shape: 1 /* narrow rounded mature crown */, flare: 0.25, attractionUp: 0.22,
    baseSplits: 0, baseSplitAngle: 0,
    //          trunk  L1     L2(twig) L3
    length:    [1.0,  0.23,  0.20,   0.14], lengthV: [0.0, 0.08, 0.08, 0.06],
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [12, 5, 4, 3],
    curve:     [2,    8,     8,      0],    curveBack: [0, 0, 0, 0], curveV: [5, 18, 28, 28],
    downAngle: [0,    62,    58,     58],   downAngleV: [0, 6, 12, 14],
    downAngleProgress: [0, -14, -6, 0],
    rotate:    [0,    144,   137,    137],  rotateV: [0, 16, 18, 20],
    branches:  [0,    20,    24,     0],    radialSegments: [10, 6, 4, 3],
    branchStart: [0, 0.52, 0.38, 0],
    branchEnd: [1, 0.96, 0.98, 1],
    branchDistPower: [1, 1, 0.72, 1],
    branchJitter: [0, 0.012, 0.025, 0],
    lengthScaleTip: [1, 0.50, 1.10, 1],
  },
};
