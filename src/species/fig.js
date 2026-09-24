// Common fig (Ficus carica) — garden and orchard tree of the Mediterranean and
// Middle East, often grown under date palms. Weber–Penn: LOW and BROAD — wider than tall,
// several thick smooth pale-grey limbs leaving a short trunk (or the ground)
// at wide angles, curving up at their ends; a few stout blunt shoots per limb
// carry big palmate leaves clustered toward the tips, so the crown reads
// CHUNKY and a little open (bold leaves, pale limbs visible between them).
//
// References used (Wikimedia Commons photos, viewed as morphology reference only — no photo
// was used as a texture or image-generation input; morphology from the literature):
//   • "Ficus carica 451027968.jpg" — garden fig: low, broad, dense dome of
//     bold leaves, wider than tall.
//   • "Ficus carica July 2026-1.jpg" — the smooth pale silver-grey limbs.
//   • "Ficus carica. Santiago de Compostela. Galiza.jpg" — 3–5 deep rounded
//     lobes, pale palmate veins, young figs in the leaf axils.
//   • "Fig Tree (Ficus Carica) - detail - geograph.org.uk - 562736.jpg" — the
//     pear-shaped syconia with a narrow neck and short stalk.
//   • Morphology: 3–6 (–10) m, often multi-stemmed, broad crown; leaves
//     alternate, palmately 3–5-lobed, 10–20 cm; bark smooth grey.
//
// Materials: LOD0 = bark + ONE leaf material on an atlas
// (assets/leaves/fig_atlas_*): the single fig-leaf card, a fig-skin swatch and
// its greener neck copy. Figs are atlas lathe fruit (core/fruit.js).

import { understoreyControls, fruitToggle } from './understorey-controls.js';

const ATLAS = {
  leaf: [0.00391, 0.25391, 0.74609, 0.98584], // aspect 1.014
  skin: [0.75, 0.75, 1, 1],
  neck: [0.75, 0.5, 1, 0.75],
};

export const fig = {
  name: 'Common Fig',
  latin: 'Ficus carica',
  bark: 'fig_bark_albedo.png',
  leaf: 'fig_atlas_albedo.png',
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',
  rockTexture: 'desert_rock_albedo.png',
  tileWorldSize: 1.1,
  controls: understoreyControls([fruitToggle('Figs')]),
  // Big leaves in terminal pads (dogwood recipe): keep every pad at the card
  // rung and cross its cards so edge-on pads never vanish.
  preserveLod2Tips: true,
  crossedLod2Cards: true,
  fruit: {
    atlas: { skin: ATLAS.skin, neck: ATLAS.neck },
    shape: 'fig', radius: 0.021, segments: 8,
    perBranch: 2, chance: 0.35, startFrac: 0.45, maxCount: 60, scaleVar: 0.15, tiltVar: 30,
  },
  foliage: {
    mode: 'leaves', atlasFruit: true, leafUV: ATLAS.leaf,
    singleSidedExport: true, // GLB export: dome-normal cards keep their outward normal on both faces (export-glb.js)
    mergeExportPiles: true, // GLB export: leaves + accents + atlas fruit write ONE leaves primitive (export-glb.js)
    clustersPerBranch: 3, clusterSize: 0.8, clusterSizeVar: 0.25, clusterQuads: 2,
    tint: 0xffffff, leavesPerBranch: 13, size: 0.24, sizeVar: 0.22, widthRatio: 1.014, quads: 2,
    taper: 0.15, startFrac: 0.4, downAngle: 56, downAngleV: 16, droop: 16, bend: 0.3,
    trunkClearRadius: 0.3,
    transmit: [0.4, 0.58, 0.22],
  },
  params: {
    scale: 5.0, scaleV: 0.6, levels: 3, ratio: 0.05, ratioPower: 1.35,
    baseSize: 0.06, shape: 2 /* hemispherical — broad low dome */, flare: 0.5,
    attractionUp: 0.35, attractionUpMinLevel: 1, // limbs spread wide, ends curve up
    baseSplits: 2, baseSplitAngle: 46,
    //          stems  L1 limb  L2 shoot
    length:    [1.0,  0.55,   0.36], lengthV: [0.0, 0.14, 0.08],
    taper:     [1.0,  1.0,    0.75], // stout blunt shoots
    curveRes:  [8,    8,      4],
    curve:     [-12,  -20,    10], curveBack: [0, 30, 0], curveV: [18, 30, 30],
    downAngle: [0,    58,     46], downAngleV: [0, 12, 14],
    downAngleProgress: [0, -18, 0],
    rotate:    [0,    140,    140], rotateV: [0, 30, 30],
    branches:  [0,    7,      17],
    radialSegments: [12, 9, 6],
    branchStart: [0, 0.18, 0.12], branchEnd: [1, 0.95, 0.98],
    branchJitter: [0, 0.03, 0.02],
  },
};
