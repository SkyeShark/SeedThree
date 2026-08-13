// Big sagebrush (Artemisia tridentata) — SHRUB category: the upswept silver
// vase. Few stout fibrous stems, strong curl-up so everything reaches for the
// sky, dense small silver-lobed spray cards low AND high (its foliage starts
// near the crown, not only at the tips). Borrows blackbrush's branch bark for
// now (its own shredded-fiber set is a future asset).

export const sagebrush = {
  name: 'Big Sagebrush',
  latin: 'Artemisia tridentata',
  category: 'shrub',
  bark: 'blackbrush_branch_albedo.png',
  leaf: 'sagebrush_albedo.png',
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',
  rockTexture: 'desert_rock_albedo.png',
  tileWorldSize: 0.45,
  plantSink: 0.015,   // splayed multi-stem crown: deep sink buries the crotch
  foliageType: 'sprayClusters',
  controls: [
    { key: 'stems', name: 'Stems from crown', min: 2, max: 6, step: 1, get: (s) => s.params.trunks, set: (s, v) => { s.params.trunks = Math.round(v); } },
    { key: 'stemSplay', name: 'Stem splay (°)', min: 10, max: 30, step: 1, get: (s) => s.params.trunkSplayDeg, set: (s, v) => { s.params.trunkSplayDeg = v; } },
    { key: 'armLength', name: 'Segment length (m)', min: 0.2, max: 0.6, step: 0.02, get: (s) => s.params.armLength, set: (s, v) => { s.params.armLength = v; } },
    { key: 'forkGenerations', name: 'Fork generations', min: 3, max: 6, step: 1, get: (s) => s.params.forkGenerations, set: (s, v) => { s.params.forkGenerations = Math.round(v); } },
    { key: 'curlUp', name: 'Upsweep', min: 0.2, max: 0.8, step: 0.05, get: (s) => s.params.curlUp, set: (s, v) => { s.params.curlUp = v; } },
    { key: 'branchiness', name: 'Branchiness', min: 0.5, max: 0.9, step: 0.05, get: (s) => s.params.branchiness, set: (s, v) => { s.params.branchiness = v; } },
    { key: 'sprayCount', name: 'Sprays per twig', min: 2, max: 6, step: 1, get: (s) => s.foliage.clustersPerBranch, set: (s, v) => { s.foliage.clustersPerBranch = Math.round(v); } },
    { key: 'spraySize', name: 'Spray size', min: 0.15, max: 0.5, step: 0.02, get: (s) => s.foliage.clusterSize, set: (s, v) => { s.foliage.clusterSize = v; } },
  ],
  advancedControls: [
    { key: 'forkSpread', name: 'Fork spread (°)', min: 12, max: 32, step: 1, get: (s) => s.params.forkSpread ?? 20, set: (s, v) => { s.params.forkSpread = v; } },
    { key: 'gnarliness', name: 'Gnarliness', min: 4, max: 20, step: 1, get: (s) => s.params.gnarliness ?? 10, set: (s, v) => { s.params.gnarliness = v; } },
    { key: 'trunkFlare', name: 'Stem base flare', min: 1, max: 2.2, step: 0.05, get: (s) => s.params.trunkFlare ?? 1.5, set: (s, v) => { s.params.trunkFlare = v; } },
    { key: 'startFrac', name: 'Foliage start', min: 0, max: 0.6, step: 0.05, get: (s) => s.foliage.startFrac ?? 0.15, set: (s, v) => { s.foliage.startFrac = v; } },
  ],
  foliage: {
    // Matched to eidoverse SHRUB_GEN.sagebrush — leafy through the middle.
    clustersPerBranch: 3,
    clusterSize: 0.48,
    clusterSizeVar: 0.3,
    clusterQuads: 2,
    alphaTest: 0.42,
    tint: 0xffffff,
    transmit: [0.32, 0.40, 0.20], // muted desert backlight (scrub.js twin)
    downAngle: 30,          // silver lobes sweep upward with the stems
    downAngleV: 12,
    droop: 10,
    startFrac: 0.15,        // foliage begins low on the twig, not only at tips
    parentSprays: 0.6,
    rotate: 137,
  },
  params: {
    // Values matched to eidoverse SHRUB_GEN.sagebrush — upswept silver vase.
    trunks: 3,
    trunkSplayDeg: 26,
    firstForkHeight: 0.15,
    armLength: 0.36,
    armFalloff: 0.86,
    forkGenerations: 4,
    branchiness: 0.8,
    forkSpread: 24,
    forkTriChance: 0.08,
    curlUp: 0.28,            // the vase upsweep
    armBend: 10,
    gnarliness: 10,
    continuationKink: 8,
    forkRadiusKeep: 0.78,
    trunkRadius: 0.02,
    trunkFlare: 1.15,
    branchRepel: 0.55,
    minRadius: 0.004,
    radialSegs: 7,
    segCurveRes: 3,
    tileWorldSize: 0.45,
    windWeightScale: 0.3,   // sub-metre plant: tree wind amplitudes = jello
  },
};
