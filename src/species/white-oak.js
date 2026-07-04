// White oak (Quercus alba) — broad, rounded, decurrent; massive near-horizontal
// low limbs, gnarled/crooked secondaries; wider-than-tall silvery crown.
// See docs/morphology.md §1.

import { CROWN_SHAPES } from '../ui/controls.js';

export const whiteOak = {
  name: 'White Oak',
  latin: 'Quercus alba',
  bark: 'white_oak_albedo.png',
  leaf: 'white_oak_single_albedo.png', // single-leaf card — LOD cards bake from this
  biome: 'temperate',
  tileWorldSize: 1.55,   // bark tile size (m) — smaller = more tiling detail
  // Broadleaf control vocabulary (density/angle/gnarliness along the trunk).
  controls: [
    { key: 'height', name: 'Height (m)', min: 4, max: 26, step: 0.5, get: (s) => s.params.scale, set: (s, v) => { s.params.scale = v; } },
    { key: 'levels', name: 'Branch levels', min: 2, max: 4, step: 1, get: (s) => s.params.levels, set: (s, v) => { s.params.levels = Math.round(v); } },
    { key: 'crownShape', name: 'Crown shape', dropdown: CROWN_SHAPES, get: (s) => s.params.shape, set: (s, v) => { s.params.shape = Math.round(v); } },
    { key: 'branchDensity', name: 'Branch density', min: 2, max: 45, step: 1, get: (s) => s.params.branches[1] ?? 20, set: (s, v) => { s.params.branches[1] = Math.round(v); } },
    { key: 'branchAngle', name: 'Branch angle', min: 15, max: 95, step: 1, get: (s) => s.params.downAngle[1] ?? 50, set: (s, v) => { s.params.downAngle[1] = v; } },
    { key: 'gnarliness', name: 'Gnarliness', min: 0, max: 120, step: 1, get: (s) => s.params.curveV[1] ?? 40, set: (s, v) => { s.params.curveV[1] = v; } },
    { key: 'trunks', name: 'Trunks', min: 1, max: 4, step: 1, get: (s) => 1 + (s.params.baseSplits || 0), set: (s, v) => { s.params.baseSplits = Math.round(v) - 1; } },
    { key: 'trunkThickness', name: 'Trunk thickness', min: 0.4, max: 2.2, step: 0.05, get: () => 1, set: (s, v) => { s.params.ratio *= v; } },
    { key: 'leafSize', name: 'Leaf size', min: 0.2, max: 1.5, step: 0.05, get: (s) => s.foliage.size ?? 0.6, set: (s, v) => { s.foliage.size = v; } },
    { key: 'leavesPerBranch', name: 'Leaves / branch', min: 0, max: 30, step: 1, get: (s) => s.foliage.leavesPerBranch ?? 14, set: (s, v) => { s.foliage.leavesPerBranch = Math.round(v); } },
  ],
  foliage: {
    mode: 'leaves',          // LOD0 = high-quality single leaves; cluster sprays at LOD1+
    clustersPerBranch: 3,
    clusterSize: 1.3,
    clusterSizeVar: 0.3,
    clusterQuads: 2,
    tint: 0xdfe8c8,          // near-neutral so the texture's green shows faithfully
    // single-leaf fallback params (used if mode:'leaves')
    leavesPerBranch: 14,
    size: 0.6,
    downAngle: 52,
    bend: 0,
  },
  params: {
    scale: 13, scaleV: 2,
    levels: 3,
    ratio: 0.035,
    ratioPower: 1.3,
    baseSize: 0.18,      // limbs start fairly low
    shape: 1,            // spherical → broad rounded crown
    flare: 0.8,          // heavy buttressed base
    attractionUp: 0.7,   // gnarled limbs sweep back up at the tips
    baseSplits: 1,       // occasional low fork into heavy scaffolds
    baseSplitAngle: 18,
    //          trunk  L1    L2    L3
    length:    [1.0,  0.5,  0.42, 0.35],
    lengthV:   [0.0,  0.12, 0.12, 0.1],
    taper:     [1.0,  1.0,  1.0,  1.0],
    curveRes:  [12,   7,    5,    3],
    curve:     [6,    30,   35,   0],
    curveBack: [0,    -20,  0,    0],   // S-curved scaffold limbs
    curveV:    [16,   80,   80,   70],  // straighter lower trunk; gnarled branches
    downAngle: [0,    68,   55,   50],  // near-horizontal massive low limbs
    downAngleV:[0,    18,   20,   20],
    rotate:    [0,    140,  140,  140],
    rotateV:   [0,    30,   30,   30],
    branches:  [0,    26,   14,   0],
    radialSegments: [14, 10, 6, 5],   // more sides on trunk/limbs → smoother bark
  },
};
