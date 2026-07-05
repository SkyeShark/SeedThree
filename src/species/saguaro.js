// Saguaro (Carnegiea gigantea) — the iconic Sonoran columnar cactus. Driven by
// the dichotomous L-system (core/dichotomous.js) in ARM-ASYMMETRIC mode: a tall
// straight fluted column whose upper trunk sprouts a few lateral arms that jut
// out then curl up (the candelabra). The tube cross-section is FLUTED into ~16
// accordion ribs; spines ride the rib crests (added by the spine builder); the
// skin is a waxy green cactus-flesh material. See docs/dichotomous-generator.md.

export const saguaro = {
  name: 'Saguaro',
  latin: 'Carnegiea gigantea',
  bark: 'saguaro_skin_albedo.png', // waxy green cactus flesh (Codex $imagegen → derived PBR)
  spine: 'saguaro_spines_albedo.png', // areole spine-cluster alpha card (Codex)
  leaf: 'saguaro_spines_albedo.png',  // satisfies the asset loader; spines are placed by the cactus path, not as a rosette
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',
  rockTexture: 'desert_rock_albedo.png',
  tileWorldSize: 0.9,
  plantSink: 0.1,
  foliageType: 'rosette', // uses the dichotomous path; foliage is spines, not a rosette
  cactus: true,           // → fluted mesh + cactus-flesh material + spines (not bark/rosette)
  controls: [
    { key: 'trunkHeight', name: 'Column growth (m/seg)', min: 0.7, max: 2.2, step: 0.1, get: (s) => s.params.firstForkHeight, set: (s, v) => { s.params.firstForkHeight = v; } },
    { key: 'armLength', name: 'Arm length (m)', min: 0.6, max: 2, step: 0.1, get: (s) => s.params.armLength, set: (s, v) => { s.params.armLength = v; } },
    { key: 'forkGenerations', name: 'Column segments', min: 3, max: 8, step: 1, get: (s) => s.params.forkGenerations, set: (s, v) => { s.params.forkGenerations = Math.round(v); } },
    { key: 'branchiness', name: 'Arm frequency', min: 0.0, max: 0.7, step: 0.05, get: (s) => s.params.branchiness, set: (s, v) => { s.params.branchiness = v; } },
    { key: 'forkSpread', name: 'Arm splay (°)', min: 40, max: 90, step: 2, get: (s) => s.params.forkSpread, set: (s, v) => { s.params.forkSpread = v; } },
    { key: 'curlUp', name: 'Arm curl-up', min: 0.2, max: 0.85, step: 0.05, get: (s) => s.params.curlUp, set: (s, v) => { s.params.curlUp = v; } },
    { key: 'ribCount', name: 'Ribs', min: 10, max: 26, step: 1, get: (s) => s.params.ribCount, set: (s, v) => { s.params.ribCount = Math.round(v); s.params.radialSegs = Math.max(48, Math.round(v) * 4); } },
    { key: 'ribDepth', name: 'Rib depth', min: 0.04, max: 0.2, step: 0.01, get: (s) => s.params.ribDepth, set: (s, v) => { s.params.ribDepth = v; } },
    { key: 'trunkThickness', name: 'Column thickness', min: 0.5, max: 2, step: 0.05, get: () => 1, set: (s, v) => { s.params.trunkRadius *= v; } },
    { key: 'spineDensity', name: 'Spine density', min: 0.15, max: 1, step: 0.05, get: (s) => s.spines?.density ?? 1, set: (s, v) => { s.spines.density = v; } },
  ],
  // Advanced L-system dials — the candelabra arm system + column shaping the
  // Shape panel doesn't expose.
  advancedControls: [
    { key: 'armAsymmetric', name: 'Arm style', dropdown: { 'Candelabra (asymmetric)': true, 'Symmetric V': false }, get: (s) => s.params.armAsymmetric ?? true, set: (s, v) => { s.params.armAsymmetric = v; } },
    { key: 'armMinHeightFrac', name: 'Arm min height', min: 0, max: 0.8, step: 0.05, get: (s) => s.params.armMinHeightFrac ?? 0.2, set: (s, v) => { s.params.armMinHeightFrac = v; } },
    { key: 'armMaxOrder', name: 'Arm max order', min: 1, max: 4, step: 1, get: (s) => s.params.armMaxOrder ?? 1, set: (s, v) => { s.params.armMaxOrder = Math.round(v); } },
    { key: 'armGenerations', name: 'Arm length (segments)', min: 0, max: 8, step: 1, get: (s) => s.params.armGenerations ?? 5, set: (s, v) => { s.params.armGenerations = Math.round(v); } },
    { key: 'armFalloff', name: 'Arm falloff / gen', min: 0.5, max: 1, step: 0.02, get: (s) => s.params.armFalloff ?? 0.9, set: (s, v) => { s.params.armFalloff = v; } },
    { key: 'forkTriChance', name: '2-arm chance', min: 0, max: 0.6, step: 0.05, get: (s) => s.params.forkTriChance ?? 0.15, set: (s, v) => { s.params.forkTriChance = v; } },
    { key: 'forkRadiusKeep', name: 'Arm thickness keep', min: 0.5, max: 1, step: 0.02, get: (s) => s.params.forkRadiusKeep ?? 0.72, set: (s, v) => { s.params.forkRadiusKeep = v; } },
    { key: 'forkBaseScale', name: 'Arm base neck', min: 0.4, max: 1.2, step: 0.02, get: (s) => s.params.forkBaseScale ?? 0.58, set: (s, v) => { s.params.forkBaseScale = v; } },
    { key: 'branchRepel', name: 'Branch repel', min: 0, max: 1.5, step: 0.05, get: (s) => s.params.branchRepel ?? 0.6, set: (s, v) => { s.params.branchRepel = v; } },
    { key: 'trunkPinch', name: 'Base pinch', min: 0, max: 0.4, step: 0.02, get: (s) => s.params.trunkPinch ?? 0.12, set: (s, v) => { s.params.trunkPinch = v; } },
    { key: 'trunkSegRes', name: 'Column ring detail', min: 3, max: 16, step: 1, get: (s) => s.params.trunkSegRes ?? 9, set: (s, v) => { s.params.trunkSegRes = Math.round(v); } },
  ],
  foliage: false, // spines are built separately (cactus path); no rosette
  // Spine areoles (crossed alpha cards marching down each rib crest — cactus-spines.js).
  spines: {
    density: 1,      // user dial (× per-LOD density): fraction of rib-crest areoles kept
    size: 0.12,      // spine-cluster height (m)
    widthFrac: 0.85, // width as a fraction of height
    embed: 0.45,     // fraction sunk into the flesh
    sizeVar: 0.28,   // per-areole size jitter
    splay: 1.0,      // bent-normal fan (rounded-tuft shading)
  },
  params: {
    firstForkHeight: 1.3,   // per-segment climb; total column ≈ firstForkHeight × forkGenerations
    armLength: 1.3,         // arm segment length
    armFalloff: 0.9,
    forkGenerations: 5,     // ~5 × 1.3 ≈ 6.5 m column (scene-scaled, not the real 12 m giant)
    branchiness: 0.55,      // per ELIGIBLE junction — tuned for mostly-branched with some single columns
    armAsymmetric: true,    // main axis continues + lateral arms curl up (candelabra)
    armMinHeightFrac: 0.2,  // arms sprout from the lower-MID trunk up (not clustered at the very top)
    armMaxOrder: 1,         // only the trunk sprouts arms; arms never re-branch (no bush of arms-off-arms)
    armGenerations: 5,      // fresh arm depth → long candelabra J arms that rise toward the crown, regardless of sprout height
    forkSpread: 72,         // arms jut out wide before curling up
    curlUp: 0.6,            // strong upward pull → arms & column stay vertical
    armBend: 3,             // saguaros are smooth/straight, barely any elbow
    gnarliness: 4,          // low — clean columns, not gnarled
    forkRadiusKeep: 0.72,   // arms a bit thinner than the trunk but still stout
    forkBaseScale: 0.58,    // neck the arm base well inside the trunk so it doesn't poke out at the crotch
    trunkRadius: 0.34,      // thick columnar trunk
    trunkFlare: 0,          // saguaros never flare at the base
    trunkPinch: 0.12,       // they slightly pinch inward right at the ground contact
    trunkSegRes: 6,
    ribCount: 16,           // ~16 accordion ribs
    ribDepth: 0.12,         // rib crest amplitude (fraction of radius)
    radialSegs: 64,         // 4 verts per rib so crests/grooves resolve smoothly
    trunks: 1,
    branchRepel: 0.6,
  },
};
