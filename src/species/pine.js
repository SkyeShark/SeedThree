// Ponderosa / PNW pine (Pinus ponderosa) — a tall EXCURRENT conifer: one straight
// dominant leader carrying a CONICAL crown of near-horizontal, whorl-ish branches whose
// tips droop, clothed in dense blue-green NEEDLE sprays. Reddish plated bark. Weber-Penn
// with a strong straight trunk (low trunk curve), horizontal limbs (high downAngle,
// attractionUp ~0), conical shape, and needle-spray cards for foliage. See docs/morphology.md.

import { broadleafControls } from './broadleaf-controls.js';

export const pine = {
  name: 'Ponderosa Pine',
  latin: 'Pinus ponderosa',
  bark: 'pine_albedo.png',            // reddish plated conifer bark (Codex $imagegen → derived PBR)
  leaf: 'pine_needle_albedo.png',     // flat needle-spray alpha card (Codex, chroma-keyed)
  biome: 'temperate',
  tileWorldSize: 1.2,                 // bark tile (m)
  controls: broadleafControls,
  foliage: {
    mode: 'leaves',
    // needle sprays ride the branchlets densely and droop out — bigger cards than a leaf
    clustersPerBranch: 3, clusterSize: 1.1, clusterSizeVar: 0.3, clusterQuads: 2,
    tint: 0xcdd8c0,                   // near-neutral so the blue-green needles read true
    leavesPerBranch: 9, size: 0.7, downAngle: 62, bend: 0,
    startFrac: 0.15,
  },
  params: {
    scale: 30, scaleV: 3, levels: 3, ratio: 0.02, ratioPower: 1.4,
    baseSize: 0.12 /* clothed most of the trunk (young conical form) */, shape: 0 /* conical spire */, flare: 0.5, attractionUp: 0.0, // branches stay horizontal, not up-swept
    baseSplits: 0, baseSplitAngle: 0,
    //          trunk  L1     L2(branchlet) L3
    length:    [1.0,  0.34,  0.34,   0.28], lengthV: [0.0, 0.08, 0.1, 0.1],
    taper:     [1.0,  1.0,   1.0,    1.0],  curveRes: [14, 6, 4, 3],
    curve:     [2,    12,    16,     0],    curveBack: [0, 0, 0, 0], curveV: [4, 18, 24, 24], // dead-straight trunk; limbs droop over their length
    downAngle: [0,    82,    80,     74],   downAngleV: [0, 10, 12, 12], // near-horizontal whorl-ish limbs, tips droop
    rotate:    [0,    137,   137,    137],  rotateV: [0, 22, 22, 22],
    branches:  [0,    46,    16,     0],    radialSegments: [12, 6, 4, 3], // dense conifer of many horizontal limbs
  },
};
