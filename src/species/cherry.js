// Sweet cherry (Prunus avium) — orchard tree. Reference habit: taller and more
// upright than apple; a clear trunk to ~1.5–2 m, then ASCENDING scaffold limbs
// that bow gently outward, building a compact rounded-oval crown. Limbs are
// straighter and smoother than apple's (cherry wood kinks far less); the fine
// outer twigs are slender and slightly pendulous at the tips. Smooth mahogany
// bark with horizontal lenticel banding.

import { broadleafControls } from './broadleaf-controls.js';

export const cherry = {
  name: 'Sweet Cherry',
  latin: 'Prunus avium',
  bark: 'cherry_bark_albedo.png',
  leaf: 'cherry_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.3,
  controls: broadleafControls,
  // Deepest order = leaf-placement twigs, not renderable wood (beech recipe).
  terminalStemsAreGuides: true,
  // Orrery-generated cherry-pair GLB (retopoed + baked) dangling from the twigs.
  fruit: { mesh: 'cherry_pair.glb', perBranch: 1, chance: 0.6, startFrac: 0.3, maxCount: 130 },
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 0.68, clusterSizeVar: 0.2, clusterQuads: 2,
    tint: 0xcce0a9, leavesPerBranch: 8, size: 0.28, sizeVar: 0.18,
    startFrac: 0.1, downAngle: 46, bend: 0,
    trunkClearRadius: 0.5,
  },
  params: {
    scale: 6.5, scaleV: 0.6, levels: 4, ratio: 0.031, ratioPower: 1.3,
    baseSize: 0.3, shape: 1 /* spherical — compact rounded-oval crown */, flare: 0.3,
    attractionUp: 0.5, attractionUpMinLevel: 2,
    baseSplits: 0, baseSplitAngle: 0,
    decurrentTrunk: true, decurrentTrunkExtension: 0.02,
    //          trunk  L1 scaffold  L2 bough  L3 twig
    length:    [1.0,  0.5,         0.3,      0.13],
    lengthV:   [0.0,  0.10,        0.07,     0.04],
    lengthAbsolute:  [null, null, null, 0.5],
    lengthAbsoluteV: [0,    0,    0,    0.12],
    lengthMin:       [0,    0,    0,    0.32],
    lengthMax:       [null, null, null, 0.7],
    taper:     [1.0,  1.0,         1.0,      1.0],
    curveRes:  [10,   9,           6,        4],
    curve:     [4,    12,          8,        3],
    curveBack: [0,    6,           4,        0],   // one gentle ascending bow
    curveV:    [8,    16,          18,       14],  // cherry limbs stay smooth
    // Scaffolds leave oblique and finish ascending; upper ones steeper still.
    downAngle:         [0, 48,  42, 50],
    downAngleV:        [0, 10,  9,  12],
    downAngleProgress: [0, -18, -6, 0],
    rotate:    [0,    137,         165,      175],
    rotateV:   [0,    25,          22,       16],
    branches:  [0,    8,           16,       14],
    radialSegments: [10, 8, 5, 4],
    branchStart:     [0, 0.16, 0.12, 0.05],
    branchEnd:       [1, 0.94, 0.98, 0.98],
    branchDistPower: [1, 1.0,  0.90, 1.0],
    branchJitter:    [0, 0.018, 0.016, 0.014],
  },
};
