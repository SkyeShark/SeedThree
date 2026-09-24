// Athel tamarisk (Tamarix aphylla; athel / salt-cedar character) — the
// drought- and salt-tolerant shade tree of arid river banks and oases.
// Weber–Penn: a short, gnarled,
// LEANING trunk (often two leaders) under a BROAD IRREGULAR DOME, usually wider
// than tall; the crown is an airy, fine-textured olive / straw-green HAZE of
// thousands of thin jointed scale-leaf branchlets hanging in soft drooping
// curtains, light passing through it — never solid puffs. Pale pink-to-cream
// flower spikes at the twig tips are optional (off).
//
// References used (Wikimedia Commons photos, viewed as morphology reference only — no photo
// was used as a texture or image-generation input; morphology from the literature):
//   • "Tamarix Aphylla.jpg" — desert tree habit: short gnarled trunk(s), broad
//     rounded olive-green crown, wider than tall.
//   • "Tamarix aphylla in Wagga Wagga.jpg" — two leaning leaders from a low
//     fork, straw-green haze, soft drooping crown edge.
//   • "Tamarix aphylla kz03.jpg" — close-up: thousands of thread-thin jointed
//     drooping branchlets (casuarina-like), light through the crown.
//   • "Tamarix aphylla flowers (1).jpg" — pale pink/whitish flowers in slender
//     fuzzy spikes clustered at the branch tips (the optional accent).
//   • Morphology: 6–10 (–18) m, often multi-stemmed; leaves reduced to
//     sheathing scales on jointed branchlets; bark dark, deeply furrowed.
//
// Crown grammar: the deepest order is an INVISIBLE placement guide
// (terminalStemsAreGuides) — the green branchlets ARE the foliage, so the fine
// twig level costs no bark triangles and is spread along the whole length of
// every L2 branch. Each guide carries a few small crossed branchlet cards that
// hang (droop) from it, so the crown fills evenly with many small see-through
// cards instead of a few dense plumes at the branch ends.
//
// Materials: LOD0 = bark + ONE leaf material on an atlas
// (assets/leaves/tamarisk_atlas_*): the drooping branchlet card + the flower
// panicle accent card (both authored hanging, flipped so their attachment is
// the card base). No fruit.

import { understoreyControls, flowerToggle } from './understorey-controls.js';

const ATLAS = {
  plume: [0.01416, 0.00391, 0.63086, 0.99609], // aspect 0.6216
  flower: [0.64844, 0.00391, 0.99609, 0.61914], // aspect 0.5651
};

export const tamarisk = {
  name: 'Athel Tamarisk',
  latin: 'Tamarix aphylla',
  bark: 'tamarisk_bark_albedo.png',
  leaf: 'tamarisk_atlas_albedo.png',
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',
  rockTexture: 'desert_rock_albedo.png',
  tileWorldSize: 1.0,
  controls: understoreyControls([flowerToggle('Flower plumes')]),
  // The branchlet level is leaf scaffolding, not wood (see header).
  terminalStemsAreGuides: true,
  foliage: {
    mode: 'leaves', leafUV: ATLAS.plume,
    mergeExportPiles: true, // GLB export: leaves + accents + atlas fruit write ONE leaves primitive (export-glb.js)
    clustersPerBranch: 1, clusterSize: 0.7, clusterSizeVar: 0.25, clusterQuads: 2,
    tint: 0xffffff, leavesPerBranch: 2, size: 0.44, sizeVar: 0.35, widthRatio: 0.62, quads: 2, alphaTest: 0.4,
    taper: 0.15, startFrac: 0.15, downAngle: 25, downAngleV: 20, droop: 85, droopV: 20, bend: 0,
    trunkClearRadius: 0.35,
    transmit: [0.3, 0.32, 0.13], // olive / straw-green backlight
    selfShadowFloor: 0.4, shadowAlphaCut: 0.6, alphaDitherMip: 1.5, alphaDitherRange: [0.04, 0.7], // light passes through the crown (leaf-cards.js)
    accents: [
      { uv: ATLAS.flower, widthRatio: 0.565, size: 0.42, sizeVar: 0.25, chance: 0.35, perBranch: 1, startFrac: 0.85, downAngle: 60, droop: 70, quads: 2, enabled: false },
    ],
  },
  params: {
    scale: 5.4, scaleV: 0.9, levels: 4, ratio: 0.036, ratioPower: 1.25,
    baseSize: 0.14, shape: 2 /* broad dome: long low limbs, short top */, flare: 0.7,
    attractionUp: 0.1, attractionUpMinLevel: 1,
    baseSplits: 0, baseSplitAngle: 15,
    // one short gnarled bole forking low into two leaning leaders
    trunkForkHeight: 0.14, trunkForkCount: 2, trunkForkAngle: 14, trunkForkAngleV: 8,
    trunkForkRadiusKeep: 0.74, trunkForkBaseTaper: 0.18, trunkForkFlareScale: 0.95,
    //          trunk  L1     L2     L3 guide
    length:    [1.0,  0.5,   0.5,   0.1], lengthV: [0.0, 0.12, 0.1, 0.02],
    lengthAbsolute:  [null, null, null, 0.34],
    lengthAbsoluteV: [0,    0,    0,    0.1],
    lengthMin:       [0,    0,    0,    0.2],
    lengthMax:       [null, null, null, 0.5],
    taper:     [1.0,  1.0,   1.0,   1.0],
    curveRes:  [10,   8,     5,     3],
    curve:     [26,   24,   -30,    20], curveBack: [-22, -30, 0, 0], curveV: [60, 70, 50, 30], // gnarled limbs; L2 arches over and down
    downAngle: [0,    52,    46,    50], downAngleV: [0, 14, 16, 18],
    downAngleProgress: [0, -18, 0, 0],
    rotate:    [0,    140,   140,   140], rotateV: [0, 30, 30, 40],
    branches:  [0,    20,    16,    28],
    radialSegments: [12, 7, 5, 3],
    branchStart: [0, 0.2, 0.08, 0.04], branchEnd: [1, 0.96, 0.99, 1],
    branchJitter: [0, 0.03, 0.02, 0.03],
  },
};
