// Weeping willow (Salix babylonica) — a stout trunk supporting a broad crown of
// rising then arching scaffold limbs. Real woody growth ends at the curved L2
// feeders; a willow-only foliage generator samples those feeders densely and
// grows flexible leaf-vines outward before gravity turns their tails downward.
// Sources: UF/IFAS Extension; Missouri Botanical Garden; NC State Extension;
// Remphrey & Pearn (2006), architectural analysis of a pendulous willow cultivar.

const willowControls = [
  { key: 'height', name: 'Height (m)', min: 6, max: 24, step: 0.5, get: (s) => s.params.scale, set: (s, v) => { s.params.scale = v; } },
  { key: 'scaffolds', name: 'Primary scaffolds', min: 5, max: 14, step: 1, get: (s) => s.params.branches[1], set: (s, v) => { s.params.branches[1] = Math.round(v); } },
  { key: 'crownSpread', name: 'Crown spread', min: 0.7, max: 1.35, step: 0.05, get: () => 1, set: (s, v) => { s.params.length[1] *= v; } },
  { key: 'feederSpacing', name: 'Feeder spacing (m)', min: 0.45, max: 1.2, step: 0.05, get: (s) => s.params.branchSpacing[2], set: (s, v) => { s.params.branchSpacing[2] = v; } },
  { key: 'curtainSpacing', name: 'Vine spacing (m)', min: 0.05, max: 0.3, step: 0.01, get: (s) => s.foliage.vineSpacing ?? (1 / s.foliage.vinesPerMeter), set: (s, v) => { s.foliage.vineSpacing = v; } },
  { key: 'curtainLength', name: 'Vine length (m)', min: 2.0, max: 7.0, step: 0.1, get: (s) => s.foliage.length, set: (s, v) => { s.foliage.length = v; } },
  { key: 'trunkThickness', name: 'Trunk thickness', min: 0.65, max: 1.6, step: 0.05, get: () => 1, set: (s, v) => { s.params.ratio *= v; } },
];

export const weepingWillow = {
  name: 'Weeping Willow',
  latin: 'Salix babylonica',
  bark: 'weeping_willow_albedo.png',
  leaf: 'weeping_willow_spray_albedo.png',
  biome: 'temperate',
  tileWorldSize: 1.35,
  controls: willowControls,
  // Long curtains retain large screen-space features farther than ordinary
  // broadleaf crowns. Delay the grouped-sheet and billboard switches until the
  // 5–6 m vines are small enough for their baked representations.
  lodDistanceMultipliers: { lod1: 2.5, lod2: 6.5, billboard: 10.5 },
  foliage: {
    mode: 'willowCurtains', tint: 0xd2e3ad,
    leavesPerBranch: 1, size: 1, sizeVar: 0, widthRatio: 0.55,
    quads: 2, alphaTest: 0.35,
    // Roughly 1,000–1,400 curved leaf-vines across the default 52–60 feeders.
    vinesPerMeter: 9, minPerFeeder: 6, maxPerFeeder: 36,
    startFrac: 0.12, endFrac: 0.98, attachmentJitter: 0.35,
    attachmentMinHeightRatio: 0.30,
    length: 5.8, lengthVariation: 1.3, minLength: 3.4,
    curveBuildup: 0.32, curveBuildupVariation: 0.10,
    tangentInfluence: 0.50, outwardSpread: 0.75,
    initialLift: 0.18, minLaunchY: 0.12,
    archLift: 0.58, archLiftVariation: 0.16,
    curveReach: 0.92, curveReachVariation: 0.22,
    terminalSweep: 0.22, terminalSweepVariation: 0.05,
    // Grouped feeder sheets otherwise expand the proxy crown beyond the direct
    // curtain envelope. Compress only their live X/Z geometry; bake framing and
    // UVs remain full-size, so the curved texture is retained without clipping.
    groupedCardHorizontalScale: 0.95,
    // Floor clamping makes reusable sheets lose the direct vines' highest tips.
    // Stretch only the baked proxy upward from its fixed hem to retain the crown
    // envelope; individual desktop LOD0/1 vine curves remain untouched.
    groupedCardVerticalScale: 1.20,
    // Crossed grouped sheets display two baked views simultaneously. Keep an
    // exact low-discrepancy 50% vine subset inside each view so the crossed pair
    // does not double-darken the canopy, then thin feeder groups—not random
    // pixels—on mobile rungs.
    groupedCardVineKeepFraction: 0.50,
    groupedCardFeederKeepFraction: 0.80,
    lateralVariation: 0.34, tailPull: 1.6,
    segments: 12,
    floor: 0.42, floorVariation: 0.08, floorWave: 0.10,
    floorLobes: 3, floorMin: 0.28, floorMax: 0.60,
  },
  params: {
    scale: 13, scaleV: 1.5, levels: 3, ratio: 0.04, ratioPower: 1.3,
    baseSize: 0.14, shape: 2 /* broad dome */, flare: 0.75, attractionUp: 0,
    forceDir: { x: 0, y: 1, z: 0 }, forceStrength: 0,
    baseSplits: 0, baseSplitAngle: 0,

    // L0 trunk → L1 load-bearing arch → L2 curved, real-wood feeder.
    length: [1, 0.62, 0.42], lengthV: [0, 0.08, 0.10],
    lengthScaleBase: [1, 1, 0.70], lengthScaleTip: [1, 1, 1.20],
    taper: [1, 1, 1], curveRes: [12, 10, 7],
    curve: [4, -28, 12], curveBack: [0, 70, 22], curveV: [7, 18, 24],
    downAngle: [0, 64, 65], downAngleProgress: [0, -26, -20],
    downAngleV: [0, 10, 20],
    rotate: [0, 137, 110], rotateV: [0, 25, 40], whorlSize: [1, 1, 1],

    branchStart: [0, 0.14, 0.20], branchEnd: [1, 0.98, 0.98],
    branchDistPower: [1, 1.20, 0.78], branchJitter: [0, 0.015, 0.035],
    branchSpacing: [0, 0, 0.75], branchMin: [0, 0, 3], branchMax: [0, 0, 8],
    branches: [0, 9, 10],
    radialSegments: [12, 9, 5],
  },
};
