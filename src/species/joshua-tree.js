// Joshua tree (Yucca brevifolia) — driven by the dedicated dichotomous
// generator (core/dichotomous.js), NOT the Weber-Penn broadleaf path. See
// docs/dichotomous-generator.md. All controls map to the L-system math.

export const joshuaTree = {
  name: 'Joshua Tree',
  latin: 'Yucca brevifolia',
  bark: 'joshua_tree_albedo.png',
  leaf: 'yucca_rosette_albedo.png', // circle-of-blades rosette sprite (user-supplied)
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',  // muted Mojave desert-pavement (Codex $imagegen → derived PBR)
  rockTexture: 'desert_rock_albedo.png',      // base slope rock; variants: pale sandstone/caliche/scree + desert_sandstone accent
  tileWorldSize: 0.8,
  plantSink: 0.15,
  foliageType: 'rosette',
  tileWorldSize: 0.8, // seeds the Bark-tiling dial; wired to params.tileWorldSize
  // Controls mapped to the DICHOTOMOUS params (not oak params).
  controls: [
    { key: 'trunkHeight', name: 'Trunk height (m)', min: 0.8, max: 4, step: 0.1, get: (s) => s.params.firstForkHeight, set: (s, v) => { s.params.firstForkHeight = v; } },
    { key: 'armLength', name: 'Arm length (m)', min: 0.4, max: 1.6, step: 0.05, get: (s) => s.params.armLength, set: (s, v) => { s.params.armLength = v; } },
    { key: 'forkGenerations', name: 'Fork generations', min: 2, max: 8, step: 1, get: (s) => s.params.forkGenerations, set: (s, v) => { s.params.forkGenerations = Math.round(v); } },
    { key: 'branchiness', name: 'Branchiness', min: 0.3, max: 0.9, step: 0.05, get: (s) => s.params.branchiness, set: (s, v) => { s.params.branchiness = v; } },
    { key: 'forkSpread', name: 'Fork spread (°)', min: 12, max: 50, step: 1, get: (s) => s.params.forkSpread, set: (s, v) => { s.params.forkSpread = v; } },
    { key: 'armBend', name: 'Arm bend (°)', min: 0, max: 40, step: 1, get: (s) => s.params.armBend, set: (s, v) => { s.params.armBend = v; } },
    { key: 'gnarliness', name: 'Gnarliness', min: 0, max: 30, step: 1, get: (s) => s.params.gnarliness, set: (s, v) => { s.params.gnarliness = v; } },
    { key: 'curlUp', name: 'Arm curl-up', min: 0, max: 0.8, step: 0.05, get: (s) => s.params.curlUp, set: (s, v) => { s.params.curlUp = v; } },
    { key: 'trunks', name: 'Trunks (rare >1)', min: 1, max: 4, step: 1, get: (s) => s.params.trunks, set: (s, v) => { s.params.trunks = Math.round(v); } },
    { key: 'trunkThickness', name: 'Trunk thickness', min: 0.5, max: 2, step: 0.05, get: () => 1, set: (s, v) => { s.params.trunkRadius *= v; } },
    { key: 'rosetteSize', name: 'Rosette size', min: 0.4, max: 1.3, step: 0.05, get: (s) => s.foliage.leafLen, set: (s, v) => { s.foliage.leafLen = v; } },
    { key: 'rosetteVar', name: 'Rosette variation', min: 0, max: 0.4, step: 0.02, get: (s) => s.foliage.leafLenVar, set: (s, v) => { s.foliage.leafLenVar = v; } },
  ],
  // Advanced L-system dials (rendered in the Advanced folder) — the dichotomous
  // params the Shape panel doesn't already expose.
  advancedControls: [
    { key: 'armFalloff', name: 'Arm falloff / gen', min: 0.5, max: 1, step: 0.02, get: (s) => s.params.armFalloff ?? 0.86, set: (s, v) => { s.params.armFalloff = v; } },
    { key: 'forkTriChance', name: 'Trident chance', min: 0, max: 0.6, step: 0.05, get: (s) => s.params.forkTriChance ?? 0.15, set: (s, v) => { s.params.forkTriChance = v; } },
    { key: 'forkRadiusKeep', name: 'Arm thickness keep', min: 0.5, max: 1, step: 0.02, get: (s) => s.params.forkRadiusKeep ?? 0.86, set: (s, v) => { s.params.forkRadiusKeep = v; } },
    { key: 'forkBaseScale', name: 'Arm base neck', min: 0.4, max: 1.2, step: 0.02, get: (s) => s.params.forkBaseScale ?? 1.0, set: (s, v) => { s.params.forkBaseScale = v; } },
    { key: 'branchRepel', name: 'Branch repel', min: 0, max: 1.5, step: 0.05, get: (s) => s.params.branchRepel ?? 0.7, set: (s, v) => { s.params.branchRepel = v; } },
    { key: 'trunkFlare', name: 'Trunk base flare', min: 1, max: 3, step: 0.05, get: (s) => s.params.trunkFlare ?? 1.7, set: (s, v) => { s.params.trunkFlare = v; } },
    { key: 'trunkSegRes', name: 'Trunk ring detail', min: 3, max: 16, step: 1, get: (s) => s.params.trunkSegRes ?? 9, set: (s, v) => { s.params.trunkSegRes = Math.round(v); } },
    { key: 'trunkSplayDeg', name: 'Multi-trunk splay (°)', min: 0, max: 40, step: 1, get: (s) => s.params.trunkSplayDeg ?? 14, set: (s, v) => { s.params.trunkSplayDeg = v; } },
  ],
  foliage: {
    leafLen: 0.5,        // rosette radius (user default) — still >> arm radius, hides tips
    leafLenVar: 0.15,
    thatchStep: 0.085,   // spacing of the dead-leaf sleeve down the arms (denser = fuller, less thin)
  },
  params: {
    firstForkHeight: 1.2,  // trunk to first fork — low to the ground (user default)
    armLength: 0.95,       // segment length per generation
    armFalloff: 0.87,
    forkGenerations: 6,
    branchiness: 0.6,      // forks often but not every junction
    forkSpread: 50,        // wide diverging V (broad crown) — user default
    curlUp: 0.28,          // less upward pull → arms spread wider & the tree sits lower
    armBend: 8,            // gentle elbow (user default)
    gnarliness: 12,
    forkRadiusKeep: 0.86,  // arms stay nearly trunk-thick
    trunkRadius: 0.17,
    radialSegs: 10,
    trunks: 1,             // single trunk by default
    branchRepel: 0.9,      // stronger anti-intersection steering
    // tipClearance is injected from the (live) rosette size in tree.js so crown
    // clearance always matches the crown radius.
  },
};
