// American sycamore (Platanus occidentalis) — an immense bottomland hardwood
// with a broad, coarse, irregular crown, a massive low-forking trunk, and a few
// heavy spreading limbs ending in stout zigzag twigs. Its exfoliating cream,
// gray, tan, and olive "camouflage" bark and huge lobed leaves are diagnostic.
// Sources: USDA Forest Service FEIS/Silvics; NC State Extension; Virginia Tech.

import { broadleafControls } from './broadleaf-controls.js';

export const americanSycamore = {
  name: 'American Sycamore',
  latin: 'Platanus occidentalis',
  bark: 'american_sycamore_albedo.png',
  leaf: 'american_sycamore_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 2.2,
  controls: broadleafControls,
  terminalStemsAreGuides: true,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.6, clusterSizeVar: 0.32, clusterQuads: 2,
    tint: 0xd8e2bc, leavesPerBranch: 12, size: 0.26, sizeVar: 0.22, widthRatio: 1.02, quads: 1,
    taper: 0.08, startFrac: 0.06, downAngle: 54, droop: 14, bend: 0,
    trunkClearRadius: 0.70,
  },
  // Open-grown sycamores can spread as wide as they are tall. Low density and
  // high angular/curvature variance keep pale scaffold limbs visible through
  // the canopy. One shared lower bole now feeds two co-dominant leaders at a
  // real above-ground crotch; their branch quota is divided, never duplicated.
  params: {
    scale: 27, scaleV: 3, levels: 4, ratio: 0.036, ratioPower: 1.20,
    baseSize: 0.10, shape: 1 /* broad rounded/irregular crown */, flare: 1.0, attractionUp: 0.18,
    baseSplits: 0, baseSplitAngle: 18,
    trunkForkHeight: 0.22, trunkForkCount: 2,
    trunkForkAngle: 26, trunkForkAngleV: 8,
    trunkForkRadiusKeep: 0.73, trunkForkBaseTaper: 0.18, trunkForkFlareScale: 0.94,
    decurrentTrunk: true, decurrentTrunkExtension: 0.018,
    //          trunk  L1     L2(twig) L3
    length:    [1.0,  0.52,  0.30,   0.20], lengthV: [0.0, 0.12, 0.13, 0.10],
    // Fine leaf-bearing shoots stay near one metre instead of recursively
    // collapsing into terminal pom-poms; they are placement guides, not tubes.
    lengthAbsolute: [null, null, null, 1.10], lengthAbsoluteV: [0, 0, 0, 0.22],
    lengthMin: [0, 0, 0, 0.65], lengthMax: [null, 13.5, null, 1.55],
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [14, 9, 6, 3],
    curve:     [3,    22,    12,     4],    curveBack: [0, -18, -18, -10], curveV: [8, 34, 62, 48],
    zigzagAngle: [0, 0, 10, 7], zigzagAngleV: [0, 0, 3, 2],
    downAngle: [0,    74,    62,     55],   downAngleV: [0, 14, 24, 22],
    downAngleProgress: [0, -30, -8, 0],
    rotate:    [0,    146,   90,     90],   rotateV: [0, 24, 38, 35],
    branches:  [0,    10,    22,     40],   radialSegments: [16, 12, 7, 4],
    branchStart: [0, 0.10, 0.20, 0.10],
    branchEnd: [1, 0.86, 0.98, 0.98],
    branchDistPower: [1, 1.15, 0.72, 0.82],
    branchJitter: [0, 0.015, 0.025, 0.018],
    lengthScaleBase: [1, 1.25, 1, 1],
    lengthScaleTip: [1, 0.85, 1.12, 1],
  },
};
