// American beech (Fagus grandifolia) — Maryland understory/canopy; broad low
// dome, dense fine branching, smooth silvery-grey bark, elliptical veined leaves.

import { broadleafControls } from './broadleaf-controls.js';

export const americanBeech = {
  name: 'American Beech',
  latin: 'Fagus grandifolia',
  bark: 'american_beech_albedo.png',
  leaf: 'american_beech_single_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.5,
  controls: broadleafControls,
  // The deepest order is a compact leaf-placement axis, not renderable wood.
  // Keeping it out of the tube mesh prevents hair-thin pendant wire silhouettes.
  terminalStemsAreGuides: true,
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.3, clusterSizeVar: 0.3, clusterQuads: 2,
    tint: 0xd6e6b0, leavesPerBranch: 5, size: 0.40, sizeVar: 0.20,
    startFrac: 0.10, downAngle: 54, bend: 0,
    trunkClearRadius: 0.7, // keep leaves off the trunk column (height-tapered)
  },
  // American beech (Fagus grandifolia): a low-branched, wide-spreading crown built
  // from stout radial scaffolds, flattened bilateral secondary systems, and dense
  // short shoots. Lower limbs leave nearly horizontal and bow under their load;
  // upper limbs begin oblique and finish gently ascending. Descendants alternate
  // sides of their parent, but the trunk scaffolds retain natural radial phyllotaxy
  // so the crown never collapses into artificial stacked tiers.
  params: {
    scale: 16, scaleV: 2, levels: 4, ratio: 0.03, ratioPower: 1.3,
    baseSize: 0.2, shape: 1 /* broad rounded crown */, flare: 0.6, attractionUp: 0.18,
    baseSplits: 0, baseSplitAngle: 0,
    decurrentTrunk: true, decurrentTrunkExtension: 0.018,
    //          trunk  L1 scaffold  L2 bough  L3 short shoot
    length:    [1.0,  0.58,        0.26,     0.12],
    lengthV:   [0.0,  0.10,        0.06,     0.03],
    // Terminal foliage axes stay uniformly short instead of inheriting the
    // full size range of their parent boughs.
    lengthAbsolute:  [null, null, null, 0.55],
    lengthAbsoluteV: [0,    0,    0,    0.12],
    lengthMin:       [0,    0,    0,    0.35],
    lengthMax:       [null, null, null, 0.75],
    taper:     [1.0,  1.0,         1.0,      1.0],
    curveRes:  [12,   10,          6,        4],
    // Same-sign halves form one smooth loaded bow. Low variance removes the
    // metre-scale elbows produced by the old seven-segment, high-noise limbs.
    curve:     [4,    16,          6,        3],
    curveBack: [0,    14,          4,        0],
    curveV:    [8,    16,          14,       10],
    downAngle:         [0, 88,  44, 55],
    downAngleV:        [0, 9,   7,  10],
    downAngleProgress: [0, -42, -8, 0],
    rotate:    [0,    137,         172,      180],
    rotateV:   [0,    25,          20,       12],
    branches:  [0,    24,          18,       12],
    radialSegments: [12, 9, 6, 4],
    // Slightly irregular attachment positions, with fine growth biased toward
    // the outer portions of each parent limb, fill the crown without bead-like
    // rows or foliage bundled against the trunk.
    branchStart:     [0, 0.10, 0.12, 0.05],
    branchEnd:       [1, 0.94, 0.98, 0.98],
    branchDistPower: [1, 1.0,  0.90, 1.0],
    branchJitter:    [0, 0.020, 0.018, 0.015],
  },
};
