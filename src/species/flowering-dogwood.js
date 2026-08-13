// Flowering dogwood (Cornus florida) — a small shade-tolerant understory tree
// with a short trunk, broad slightly flat-topped crown, and low horizontal
// branches arranged in opposite, candelabra-like tiers. The green leaves are
// opposite and oval with strongly arcuate veins; mature bark forms small dark
// square "alligator-hide" blocks. Sources: USDA FS FEIS; NC State; Virginia Tech.

import { broadleafControls } from './broadleaf-controls.js';

export const floweringDogwood = {
  name: 'Flowering Dogwood',
  latin: 'Cornus florida',
  bark: 'flowering_dogwood_albedo.png',
  leaf: 'flowering_dogwood_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 0.65,
  controls: broadleafControls,
  // Cornus forms distinct terminal leaf pads. Dropping entire tips at the card
  // rung punches large holes, so its 15% budget is spent on cheaper wood instead.
  preserveLod2Tips: true,
  // Its broad opposite terminal pads become edge-on from common views if the
  // first card rung uses one plane. Bake orthogonal views and cross them so the
  // LOD2 crown keeps the same read while still meeting the triangle budget.
  crossedLod2Cards: true,
  foliage: {
    // Summer form: opposite, decussate leaves overlap over the outer half of
    // each short shoot, forming Cornus's broad leafy pads without fake flowers.
    mode: 'leaves', clustersPerBranch: 4, clusterSize: 1.05, clusterSizeVar: 0.28, clusterQuads: 2,
    tint: 0xd3dfad, leavesPerBranch: 44, size: 0.15, sizeVar: 0.20, widthRatio: 1.0,
    taper: 0.10, startFrac: 0.52, downAngle: 50, droop: 8, bend: 0.65,
    whorlSize: 2, rotate: 90, rotateV: 5,
    trunkClearRadius: 0.18,
  },
  // A real low bole divides into two co-dominant leaders. Opposite scaffold
  // pairs live on those spreading leaders instead of forming a single regular
  // ladder on a pole; short ascending twigs build the characteristic layered
  // candelabra crown. Quotas are divided between leaders, never duplicated.
  params: {
    scale: 6.6, scaleV: 0.7, levels: 3, ratio: 0.022, ratioPower: 1.15,
    baseSize: 0.10, shape: 2 /* low hemispherical, slightly flat-topped crown */, flare: 0.30, attractionUp: 0.45,
    baseSplits: 0, baseSplitAngle: 16,
    trunkForkHeight: 0.24, trunkForkCount: 2,
    trunkForkAngle: 38, trunkForkAngleV: 8,
    trunkForkRadiusKeep: 0.72, trunkForkBaseTaper: 0.20, trunkForkFlareScale: 0.94,
    //          trunk  L1     L2(twig) L3
    length:    [1.0,  0.46,  0.22,   0.15], lengthV: [0.0, 0.16, 0.10, 0.08],
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [10, 9, 5, 3],
    curve:     [4,    0,     12,     0],    curveBack: [0, -34, -8, 0], curveV: [8, 28, 34, 22],
    downAngle: [0,    98,    54,     52],   downAngleV: [0, 12, 16, 14],
    downAngleProgress: [0, -18, -10, 0],
    rotate:    [0,    90,    90,     90],   rotateV: [0, 24, 16, 8],
    whorlSize: [1,    2,     2,      1],
    branches:  [0,    12,    36,     0],    radialSegments: [10, 7, 5, 3],
    branchStart: [0, 0.10, 0.16, 0], branchEnd: [1, 0.78, 0.98, 1],
    branchDistPower: [1, 1.08, 0.68, 1], branchJitter: [0, 0.045, 0.03, 0],
    lengthScaleBase: [1, 1.10, 0.90, 1], lengthScaleTip: [1, 1.22, 1.08, 1],
    decurrentTrunk: true, decurrentTrunkExtension: 0.015,
  },
};
