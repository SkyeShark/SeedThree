// Blackbrush (Coleogyne ramosissima) — SHRUB category: a dense, dark, gnarled
// low dome. Many short stems from the crown, high branchiness, strong per-
// segment jitter — the twiggy thicket habit — with small spray cards dense
// through the canopy (its sheet is a fine-twig spray, so more, smaller cards
// than creosote's open vase).

export const blackbrush = {
  name: 'Blackbrush',
  latin: 'Coleogyne ramosissima',
  category: 'shrub',
  bark: 'blackbrush_branch_albedo.png',
  leaf: 'blackbrush_albedo.png',
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',
  rockTexture: 'desert_rock_albedo.png',
  tileWorldSize: 0.4,
  plantSink: 0.015,   // splayed multi-stem crown: deep sink buries the crotch
  barkTint: 0xbfc7d9, // cool the warm-brown wood tile toward the slate twigs
  foliageType: 'sprayClusters',
  controls: [
    { key: 'stems', name: 'Stems from crown', min: 4, max: 9, step: 1, get: (s) => s.params.trunks, set: (s, v) => { s.params.trunks = Math.round(v); } },
    { key: 'stemSplay', name: 'Stem splay (°)', min: 16, max: 45, step: 1, get: (s) => s.params.trunkSplayDeg, set: (s, v) => { s.params.trunkSplayDeg = v; } },
    { key: 'armLength', name: 'Segment length (m)', min: 0.15, max: 0.45, step: 0.02, get: (s) => s.params.armLength, set: (s, v) => { s.params.armLength = v; } },
    { key: 'forkGenerations', name: 'Fork generations', min: 3, max: 7, step: 1, get: (s) => s.params.forkGenerations, set: (s, v) => { s.params.forkGenerations = Math.round(v); } },
    { key: 'branchiness', name: 'Branchiness', min: 0.5, max: 0.95, step: 0.05, get: (s) => s.params.branchiness, set: (s, v) => { s.params.branchiness = v; } },
    { key: 'gnarliness', name: 'Gnarliness', min: 8, max: 35, step: 1, get: (s) => s.params.gnarliness, set: (s, v) => { s.params.gnarliness = v; } },
    { key: 'sprayCount', name: 'Sprays per twig', min: 1, max: 5, step: 1, get: (s) => s.foliage.clustersPerBranch, set: (s, v) => { s.foliage.clustersPerBranch = Math.round(v); } },
    { key: 'spraySize', name: 'Spray size', min: 0.2, max: 0.7, step: 0.05, get: (s) => s.foliage.clusterSize, set: (s, v) => { s.foliage.clusterSize = v; } },
  ],
  advancedControls: [
    { key: 'armFalloff', name: 'Segment falloff / gen', min: 0.6, max: 1, step: 0.02, get: (s) => s.params.armFalloff ?? 0.82, set: (s, v) => { s.params.armFalloff = v; } },
    { key: 'forkSpread', name: 'Fork spread (°)', min: 18, max: 45, step: 1, get: (s) => s.params.forkSpread ?? 30, set: (s, v) => { s.params.forkSpread = v; } },
    { key: 'forkRadiusKeep', name: 'Twig thickness keep', min: 0.6, max: 1, step: 0.02, get: (s) => s.params.forkRadiusKeep ?? 0.8, set: (s, v) => { s.params.forkRadiusKeep = v; } },
    { key: 'branchRepel', name: 'Branch repel', min: 0, max: 1.5, step: 0.05, get: (s) => s.params.branchRepel ?? 0.5, set: (s, v) => { s.params.branchRepel = v; } },
  ],
  foliage: {
    // Eidoverse SHRUB_GEN.blackbrush grammar, re-weighted for THIS sheet: the
    // authored spray art is pale silver-grey, and at eidoverse's coverage it
    // blankets the near-black wood — the shrub's namesake DARKNESS comes from
    // branches showing through sparse foliage. Smaller cards, lighter parent
    // fill, a dark olive tint, and a harder alpha cut (the sheet's soft edge
    // fringe reads as a pale halo).
    clustersPerBranch: 3,
    clusterSize: 0.36,
    clusterSizeVar: 0.3,
    clusterQuads: 2,
    alphaTest: 0.52,
    // MEASURED from Skye's dormant-state reference (Downloads/
    // blackbrush_coleogyne_ramossisima.jpg): shrub mass averages a neutral-cool
    // dark grey (103,101,100). tint = target / sheet-mean(143,134,112) — the
    // sheet's warm pale twigs land exactly on the reference tone. Blackbrush is
    // near-BLACK dark grey most of the year; the silvery/green looks are its
    // brief bloom season, not the famous state.
    tint: 0xb7c0e2,
    transmit: [0.20, 0.21, 0.19], // neutral — any green glow re-tints the grey
    downAngle: 32,
    downAngleV: 14,
    droop: 16,
    startFrac: 0.2,
    parentSprays: 0.35,
    rotate: 137,
  },
  params: {
    // Values matched to eidoverse SHRUB_GEN.blackbrush — dense gnarled low dome.
    trunks: 6,
    trunkSplayDeg: 42,
    firstForkHeight: 0.08,
    armLength: 0.32,
    armFalloff: 0.82,
    forkGenerations: 4,
    branchiness: 0.85,
    forkSpread: 34,
    forkTriChance: 0.12,
    curlUp: 0.1,
    armBend: 14,
    gnarliness: 22,          // the namesake tangle
    continuationKink: 14,
    forkRadiusKeep: 0.76,
    trunkRadius: 0.015,
    trunkFlare: 1.15,
    branchRepel: 0.5,
    minRadius: 0.0035,
    radialSegs: 6,
    segCurveRes: 3,
    tileWorldSize: 0.4,
    windWeightScale: 0.25,  // stiff woody thicket — barely moves
  },
};
