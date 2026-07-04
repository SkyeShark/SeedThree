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
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 1.3, clusterSizeVar: 0.3, clusterQuads: 2,
    tint: 0xd6e6b0, leavesPerBranch: 7, size: 0.5, downAngle: 54, bend: 0, // many short twigs now
    trunkClearRadius: 0.7, // keep leaves off the trunk column (height-tapered)
  },
  // American beech (Fagus grandifolia): broad, wide-spreading DENSE dome on a short low-
  // branching trunk. Modelled on the WHITE OAK natural base (heavy gnarl + varied branch
  // angles = the thing that reads as a real tree, not a rigid antenna) but a touch more
  // horizontal/wider, single-trunk, with SHORT leafy twigs. Earlier "horizontal layered +
  // distichous" experiment made it a cell-tower — real beech needs the NATURAL VARIATION.
  params: {
    scale: 16, scaleV: 2, levels: 3, ratio: 0.03, ratioPower: 1.3,
    baseSize: 0.2 /* clear lower trunk — no limbs right at the ground */, shape: 1 /* SPHERICAL: crown widest in the MIDDLE, so the lowest limbs are SHORT (shape 2 made full-length giant limbs at the base) */, flare: 0.6, attractionUp: 0.45,
    baseSplits: 0, baseSplitAngle: 0,
    //          trunk  L1     L2(twig) L3
    length:    [1.0,  0.6,   0.16,   0.14], lengthV: [0.0, 0.16, 0.12, 0.1], // wide low limbs + high length variance (irregular, natural)
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [12, 7, 5, 3],
    curve:     [6,    24,    26,     0],    curveBack: [0, -14, 0, 0], curveV: [16, 62, 65, 58], // GNARLED like oak (curveV high) → wiggly natural branches, not straight antenna arms
    downAngle: [0,    70,    60,     54],   downAngleV: [0, 22, 24, 24], // VARIED angles (high variance) → some horizontal, some ascending — the key to not looking fake
    rotate:    [0,    140,   140,    140],  rotateV: [0, 32, 32, 32], // natural spiral spread with lots of jitter
    branches:  [0,    30,    22,     0],    radialSegments: [12, 8, 6, 4],
  },
};
