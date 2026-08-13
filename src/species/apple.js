// Cultivated apple (Malus domestica) — standard (non-dwarf) orchard form.
// Reference habit: a short stout trunk that forks low into a few HEAVY scaffold
// limbs; the lowest leave nearly horizontal and arch under load, upper ones rise
// steeper, so the crown reads as a broad dome wider than tall. No persistent
// leader (the trunk ends at its scaffolds — classic pruned orchard shape). The
// crown interior fills with short, kinked fruiting spurs — a dense fine twig
// lattice in winter, a full round canopy in leaf.

import { broadleafControls } from './broadleaf-controls.js';

export const apple = {
  name: 'Cultivated Apple',
  latin: 'Malus domestica',
  bark: 'apple_bark_albedo.png',
  leaf: 'apple_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.2,
  controls: broadleafControls,
  // Deepest order = leaf-placement spurs, not renderable wood (beech recipe) —
  // keeps the twig lattice out of the tube mesh and the silhouette clean.
  terminalStemsAreGuides: true,
  // Orrery-generated fruit GLB (retopoed + baked) hung from the fruiting spurs.
  // A cropped standard apple is LOADED — high chance, two attempts per spur
  // (the anti-clip rejection in buildFruits eats a share of attempts).
  fruit: { mesh: 'apple.glb', perBranch: 2, chance: 0.7, startFrac: 0.3, maxCount: 170 },
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 0.72, clusterSizeVar: 0.18, clusterQuads: 2,
    tint: 0xc8dda5, leavesPerBranch: 9, size: 0.24, sizeVar: 0.2,
    startFrac: 0.1, downAngle: 50, bend: 0,
    trunkClearRadius: 0.45,
  },
  params: {
    scale: 5.2, scaleV: 0.5, levels: 4, ratio: 0.036, ratioPower: 1.35,
    baseSize: 0.32, shape: 2 /* hemispherical — broad low dome */, flare: 0.55,
    attractionUp: 0.35, attractionUpMinLevel: 1, // scaffolds curl up along their run
    baseSplits: 0, baseSplitAngle: 0,
    decurrentTrunk: true, decurrentTrunkExtension: 0.015,
    //          trunk  L1 scaffold  L2 bough  L3 fruiting spur
    length:    [1.0,  0.62,        0.32,     0.14],
    lengthV:   [0.0,  0.12,        0.08,     0.04],
    // Spur twigs stay uniformly short — the dense shell of kinked fruiting wood.
    lengthAbsolute:  [null, null, null, 0.42],
    lengthAbsoluteV: [0,    0,    0,    0.10],
    lengthMin:       [0,    0,    0,    0.28],
    lengthMax:       [null, null, null, 0.60],
    taper:     [1.0,  1.0,         1.0,      1.0],
    curveRes:  [10,   9,           6,        4],
    curve:     [8,    20,          10,       4],
    curveBack: [0,   -8,           6,        0],   // scaffolds arch out, tips lift
    curveV:    [12,   22,          30,       20],  // apple-gnarl without spaghetti
    // Low scaffolds near-horizontal under crop load; upper ones leave steeper.
    downAngle:         [0, 64,  48, 56],
    downAngleV:        [0, 12,  10, 12],
    downAngleProgress: [0, -14, -6, 0], // top scaffolds still spread — no leader ball
    rotate:    [0,    137,         150,      160],
    rotateV:   [0,    28,          24,       18],
    branches:  [0,    8,           17,       16],
    radialSegments: [11, 8, 5, 4],
    // Irregular attachment, fine growth biased outward (no bead rows, no
    // foliage bundled on the trunk).
    branchStart:     [0, 0.08, 0.12, 0.05],
    branchEnd:       [1, 0.85, 0.98, 0.98],
    branchDistPower: [1, 1.0,  0.92, 1.0],
    branchJitter:    [0, 0.020, 0.018, 0.015],
  },
};
