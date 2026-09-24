// Pomegranate (Punica granatum) — the fruiting shrub-tree of Mediterranean and
// Middle-Eastern gardens, often grown under date palms. Weber–Penn: a dense,
// rounded, MULTI-STEMMED crown
// 3–5 m tall, several stems leaving the root crown and dividing into a fine,
// twiggy lattice; small narrow glossy leaves on short spur shoots; red globes
// with a crown-like calyx hanging scattered through the outer crown.
//
// References used (Wikimedia Commons photos, viewed as morphology reference only — no photo
// was used as a texture or image-generation input; morphology from the literature):
//   • "Punica granatum with fruit in august.JPG" — the lone dry-land tree:
//     short trunk, dense rounded crown about as wide as tall.
//   • "National Botanical Garden of Wales, 'Punica granatum' (pomegranate
//     tree) - geograph.org.uk - 7066169.jpg" — the multi-stemmed clump and its
//     arching, twiggy outer shoots.
//   • "Granado (Punica granatum), Mahdia, Túnez, 2016-09-03, DD 02.jpg" — fruit
//     load: red-orange globes hanging at the shoot tips through the outer crown.
//   • "Punica granatum 'Nana', Tallinn Botanic Garden 02.jpg" and "Pomegranate
//     fruit and flower (Punica granatum) – Mediterranean Symbol in Shkodër.jpg"
//     — the waxy orange-red calyx tube + crinkled scarlet petals; crown calyx.
//   • Morphology: 3–6 m, often multi-trunked; leaves opposite/clustered on spur
//     shoots, narrow oblong-lanceolate 3–7 cm, glossy; flowers and fruit
//     terminal on short shoots; bark grey-brown, finely fissured, twisting.
//
// Materials: LOD0 = bark + ONE leaf material on an atlas
// (assets/leaves/pomegranate_atlas_*): the leafy-twig spray card, a seamless
// fruit-skin swatch, its darker calyx copy, and the flower card — composed by
// scripts/texture/compose-leaf-atlas.mjs. Fruit is procedural lathe geometry
// UV-mapped into the skin/calyx rects (core/fruit.js makeAtlasFruitGeometry),
// flowers are accent cards (core/leaf-cards.js buildAccentCards).

import { understoreyControls, fruitToggle, flowerToggle } from './understorey-controls.js';

// compose-leaf-atlas.mjs output (three.js UV, v up)
const ATLAS = {
  spray: [0.06055, 0.00391, 0.43945, 0.99609], // aspect 0.3819
  skin: [0.5, 0.5, 1, 1],
  calyx: [0.75, 0.25, 1, 0.5],
  flower: [0.50391, 0.00391, 0.74609, 0.27246], // aspect 0.9018
};

export const pomegranate = {
  name: 'Pomegranate',
  latin: 'Punica granatum',
  bark: 'pomegranate_bark_albedo.png',
  leaf: 'pomegranate_atlas_albedo.png',
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',
  rockTexture: 'desert_rock_albedo.png',
  tileWorldSize: 0.9,
  controls: understoreyControls([fruitToggle('Pomegranates'), flowerToggle('Flowers')]),
  fruit: {
    atlas: { skin: ATLAS.skin, calyx: ATLAS.calyx },
    shape: 'pomegranate', radius: 0.05, segments: 10, rings: 7,
    perBranch: 2, chance: 0.6, startFrac: 0.8, maxCount: 80, scaleVar: 0.12, tiltVar: 25,
  },
  foliage: {
    mode: 'leaves', atlasFruit: true, leafUV: ATLAS.spray,
    singleSidedExport: true, // GLB export: dome-normal cards keep their outward normal on both faces (export-glb.js)
    mergeExportPiles: true, // GLB export: leaves + accents + atlas fruit write ONE leaves primitive (export-glb.js)
    clustersPerBranch: 3, clusterSize: 0.5, clusterSizeVar: 0.25, clusterQuads: 2,
    tint: 0xffffff, leavesPerBranch: 8, size: 0.32, sizeVar: 0.25, widthRatio: 0.382,
    taper: 0.2, startFrac: 0.12, downAngle: 48, downAngleV: 18, droop: 14, bend: 0,
    trunkClearRadius: 0.15,
    transmit: [0.34, 0.5, 0.2],
    accents: [
      { uv: ATLAS.flower, widthRatio: 0.9, size: 0.075, sizeVar: 0.2, chance: 0.1, perBranch: 1, startFrac: 0.85, downAngle: 30, droop: 20, quads: 2, enabled: true },
    ],
  },
  params: {
    scale: 4.1, scaleV: 0.5, levels: 4, ratio: 0.028, ratioPower: 1.25,
    baseSize: 0.05, shape: 1 /* spherical — dense rounded crown */, flare: 0.35,
    attractionUp: 0.35, attractionUpMinLevel: 1,
    baseSplits: 3, baseSplitAngle: 18, // a clump of stems from the root crown
    //          stems  L1     L2     L3 twig
    length:    [1.0,  0.4,   0.42,  0.34], lengthV: [0.0, 0.1, 0.1, 0.08],
    taper:     [1.0,  1.0,   1.0,   1.0],
    curveRes:  [8,    6,     4,     3],
    curve:     [14,   18,    20,    10], curveBack: [-10, -10, 0, 0], curveV: [70, 80, 80, 60], // twisting, twiggy
    downAngle: [0,    38,    46,    46], downAngleV: [0, 12, 16, 16],
    downAngleProgress: [0, -12, 0, 0],
    rotate:    [0,    140,   140,   140], rotateV: [0, 30, 30, 30],
    branches:  [0,    8,     9,     5],
    radialSegments: [9, 6, 4, 3],
    branchStart: [0, 0.06, 0.08, 0.05], branchEnd: [1, 0.95, 0.98, 0.98],
    branchJitter: [0, 0.02, 0.02, 0.02],
  },
};
