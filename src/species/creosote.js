// Creosote bush (Larrea tridentata) — the first SHRUB category species: the
// dichotomous L-system grown as brush (multi-stem root crown, low V-forks, thin
// wiry wood), with the authored leaf-spray sheet placed as cluster cards on the
// terminal stems (foliageType 'sprayClusters' — leaf-cards' cluster grammar on
// the dichotomous skeleton). Not a small tree: no leader, no clear trunk.

export const creosote = {
  name: 'Creosote Bush',
  latin: 'Larrea tridentata',
  category: 'shrub',
  bark: 'creosote_branch_albedo.png',
  leaf: 'creosote_albedo.png',
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',
  rockTexture: 'desert_rock_albedo.png',
  tileWorldSize: 0.5,
  plantSink: 0.015,   // splayed multi-stem crown: deep sink buries the crotch
  foliageType: 'sprayClusters',
  controls: [
    { key: 'stems', name: 'Stems from crown', min: 3, max: 8, step: 1, get: (s) => s.params.trunks, set: (s, v) => { s.params.trunks = Math.round(v); } },
    { key: 'stemSplay', name: 'Stem splay (°)', min: 12, max: 40, step: 1, get: (s) => s.params.trunkSplayDeg, set: (s, v) => { s.params.trunkSplayDeg = v; } },
    { key: 'armLength', name: 'Segment length (m)', min: 0.25, max: 0.8, step: 0.05, get: (s) => s.params.armLength, set: (s, v) => { s.params.armLength = v; } },
    { key: 'forkGenerations', name: 'Fork generations', min: 3, max: 7, step: 1, get: (s) => s.params.forkGenerations, set: (s, v) => { s.params.forkGenerations = Math.round(v); } },
    { key: 'branchiness', name: 'Branchiness', min: 0.4, max: 0.9, step: 0.05, get: (s) => s.params.branchiness, set: (s, v) => { s.params.branchiness = v; } },
    { key: 'forkSpread', name: 'Fork spread (°)', min: 14, max: 40, step: 1, get: (s) => s.params.forkSpread, set: (s, v) => { s.params.forkSpread = v; } },
    { key: 'gnarliness', name: 'Gnarliness', min: 4, max: 28, step: 1, get: (s) => s.params.gnarliness, set: (s, v) => { s.params.gnarliness = v; } },
    { key: 'sprayCount', name: 'Sprays per twig', min: 1, max: 10, step: 1, get: (s) => s.foliage.clustersPerBranch, set: (s, v) => { s.foliage.clustersPerBranch = Math.round(v); } },
    { key: 'spraySize', name: 'Spray size', min: 0.25, max: 0.9, step: 0.05, get: (s) => s.foliage.clusterSize, set: (s, v) => { s.foliage.clusterSize = v; } },
  ],
  advancedControls: [
    { key: 'armFalloff', name: 'Segment falloff / gen', min: 0.6, max: 1, step: 0.02, get: (s) => s.params.armFalloff ?? 0.85, set: (s, v) => { s.params.armFalloff = v; } },
    { key: 'forkRadiusKeep', name: 'Twig thickness keep', min: 0.6, max: 1, step: 0.02, get: (s) => s.params.forkRadiusKeep ?? 0.82, set: (s, v) => { s.params.forkRadiusKeep = v; } },
    { key: 'curlUp', name: 'Curl-up', min: 0, max: 0.7, step: 0.05, get: (s) => s.params.curlUp ?? 0.3, set: (s, v) => { s.params.curlUp = v; } },
    { key: 'branchRepel', name: 'Branch repel', min: 0, max: 1.5, step: 0.05, get: (s) => s.params.branchRepel ?? 0.6, set: (s, v) => { s.params.branchRepel = v; } },
  ],
  foliage: {
    // Matched to eidoverse SHRUB_GEN.creosote (the tuned 07-29 dive values):
    // foliage SLEEVES the outer third of each wand — dense sprigs along the
    // terminal runs, real sky gaps between branch systems. Not a uniform fuzz.
    clustersPerBranch: 8,
    clusterSize: 0.58,
    clusterSizeVar: 0.35,
    clusterQuads: 2,        // crossed pair per spray
    alphaTest: 0.4,
    tint: 0xffffff,
    transmit: [0.30, 0.44, 0.18], // muted desert backlight (scrub.js twin)
    downAngle: 24,
    downAngleV: 12,
    droop: 14,
    startFrac: 0.22,
    parentSprays: 0.5,      // sub-terminal wands carry sprigs too (mid-canopy)
    rotate: 137,
  },
  params: {
    // brush habit: everything forks from a low crown; no leader.
    // Values matched to eidoverse SHRUB_GEN.creosote — open wiry vase.
    trunks: 5,
    trunkSplayDeg: 38,
    firstForkHeight: 0.12,
    armLength: 0.55,
    armFalloff: 0.85,
    forkGenerations: 4,
    branchiness: 0.78,
    forkSpread: 30,
    forkTriChance: 0.1,
    curlUp: 0.15,
    armBend: 12,
    gnarliness: 14,
    continuationKink: 10,
    forkRadiusKeep: 0.78,
    trunkRadius: 0.022,     // wiry, never trunk-like
    trunkFlare: 1.2,
    branchRepel: 0.6,
    minRadius: 0.004,
    radialSegs: 7,
    segCurveRes: 3,
    tileWorldSize: 0.5,
    barkGrainU: true,       // twig-pile tile: grain runs along the wand
    windWeightScale: 0.3,   // sub-metre plant: tree wind amplitudes = jello
  },
};
