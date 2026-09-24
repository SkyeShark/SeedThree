// Date palm (Phoenix dactylifera) — the canopy tree of arid river-valley groves
// and oases (Tigris–Euphrates, Nile, North Africa). Built by the dichotomous trunk
// machinery with FORKING DISABLED (one unbranched trunk: lean, gentle curve back
// toward vertical, slight taper, flared base) + the PINNATE FROND BUILDER for the
// crown (core/frond-builder.js, docs/frond-builder.md).
//
// References used (Wikimedia Commons, CC-BY-SA; morphology from the literature):
//   • "Date palm orchard, Al-Faw, Basrah, Iraq" (2007) — trunk proportions, the
//     diamond leaf-base boot pattern, crown-to-trunk ratio of grove palms.
//   • "Date grove in Baghdadi, Iraq" — tall slender grove trunks, spherical
//     burst crowns, lower fronds drooping past horizontal.
//   • "Phoenix dactylifera1.jpg" (oasis grove) — gray-green leaflets in several
//     planes, the feathery (never flat) crown read, dead fronds hanging below.
//   • "Dates on date palm.jpg" — pale yellow-green petioles, the orange peduncle
//     arching out of the crown and hanging strands of amber dates.
//   • Morphology: fronds 3–6 m with ~150–250 leaflets in multiple planes, leaflets
//     30–60 × 2–3 cm, gray-green; trunk 40–60 cm diameter with diamond leaf-base
//     scars ~10 × 25–30 cm; spines (acanthophylls) on the petiole
//     (palmpedia.net, dimensions.com, PMC9511727 cultivar survey).
//
// Seed = individual: the dials set the MEAN height/lean/crown; each seed draws
// its own height (±20%), lean (skewed — most stand straight), frond count,
// frond length and droop (see individualizePalm in core/tree.js).
//
// Materials: LOD0 is TWO material groups — trunk + rachis + peduncle tubes (bark,
// `_branches`, one bark ATLAS: trunk tile + rachis/peduncle colour strips) and ONE
// merged atlas-mapped leaves mesh (leaflets, spines, dead leaflets, date bunches).
//
// Crown: a MATURE crown — ~96 live fronds with an age ramp that sends the
// mid-aged majority past horizontal (elevCurve/droopCurve < 1), so it closes
// into a rounded crown instead of an upward burst, kept to ~90k LOD0 triangles
// by card economy (1-segment folded leaflets; docs/frond-builder.md §4). The
// rachis samples its own yellow-green strip (pale base, paler underside) with
// dome-bent normals (no dark lines from below); the amber dates hang from long
// arching orange-yellow peduncles; the skirt dial tops out at a thick 40-frond
// brown skirt (default stays light, like a trimmed cultivated palm).

// Atlas rects from scripts/texture/compose-frond-atlas.mjs (v up, three.js UV);
// the bunch and dead pieces are post-graded in place (docs/frond-builder.md §6).
const ATLAS = {
  live: [[0.00293, 0.00293, 0.04395, 0.99707], [0.0498, 0.00293, 0.09082, 0.99707], [0.09668, 0.00293, 0.1377, 0.99707], [0.14355, 0.00293, 0.18457, 0.99707], [0.19043, 0.00293, 0.23145, 0.99707], [0.2373, 0.00293, 0.27832, 0.99707], [0.28418, 0.00293, 0.3252, 0.99707], [0.33105, 0.00293, 0.37207, 0.99707]],
  dead: [[0.37793, 0.00293, 0.41895, 0.99707], [0.4248, 0.00293, 0.46582, 0.99707], [0.47168, 0.00293, 0.5127, 0.99707], [0.51855, 0.00293, 0.55957, 0.99707], [0.56543, 0.00293, 0.60645, 0.99707], [0.6123, 0.00293, 0.65332, 0.99707], [0.65918, 0.00293, 0.7002, 0.99707], [0.70605, 0.00293, 0.74707, 0.99707]],
  bunch: [0.75293, 0.50732, 0.99707, 0.99268],
};

const DATE_BUNCHES = 5;
const DEAD_SKIRT_MAX = 40; // dead fronds at the Dead-frond skirt dial's top (a full unpruned skirt)

// Bark ATLAS (scripts/texture/compose-palm-bark-atlas.mjs): the trunk tile fills
// u 0..0.875 (two periodic copies); the live-rachis and peduncle colour strips sit
// beyond it, so the crown tubes share the bark material.
const BARK_ATLAS = { regionU: 0.875, tilesAround: 2, tileAspect: 1.14286 };

export const datePalm = {
  name: 'Date Palm',
  latin: 'Phoenix dactylifera',
  bark: 'date_palm_albedo.png',          // leaf-base "boot" lattice (seamless)
  leaf: 'date_palm_frond_albedo.png',    // frond ATLAS: live + dead leaflets + date bunch
  // Arid / riverine (Tigris–Euphrates groves). Uses the existing 'desert' biome
  // (sky, ground, soundscape) — a new biome value would ripple into scenes and
  // audio, so a dedicated riverine/oasis biome is left for later.
  biome: 'desert',
  groundTexture: 'desert_ground_albedo.png',
  rockTexture: 'desert_rock_albedo.png',
  foliageType: 'fronds',
  tileWorldSize: 0.75,
  plantSink: 0.15,
  lodDistanceMultipliers: { lod1: 1.5, lod2: 3.0, billboard: 5.5 },
  controls: [
    { key: 'trunkHeight', name: 'Height (m)', min: 4, max: 18, step: 0.5, get: (s) => s.params.trunkHeight, set: (s, v) => { s.params.trunkHeight = v; } },
    { key: 'lean', name: 'Lean (°)', min: 0, max: 30, step: 1, get: (s) => s.params.lean, set: (s, v) => { s.params.lean = v; } },
    { key: 'frondCount', name: 'Frond count', min: 20, max: 140, step: 1, get: (s) => s.foliage.frondCount, set: (s, v) => { if (s.foliage) s.foliage.frondCount = Math.round(v); } },
    { key: 'frondLength', name: 'Frond length (m)', min: 2, max: 6, step: 0.1, get: (s) => s.foliage.frondLength, set: (s, v) => { if (s.foliage) s.foliage.frondLength = v; } },
    { key: 'droop', name: 'Droop', min: 0, max: 1.8, step: 0.05, get: (s) => s.foliage.droop, set: (s, v) => { if (s.foliage) s.foliage.droop = v; } },
    { key: 'deadSkirt', name: 'Dead-frond skirt', min: 0, max: 1, step: 0.05, get: (s) => s.foliage.deadCount / DEAD_SKIRT_MAX, set: (s, v) => { if (s.foliage) s.foliage.deadCount = Math.round(v * DEAD_SKIRT_MAX); } },
    { key: 'dates', name: 'Dates', dropdown: { Off: 0, On: 1 }, get: (s) => (s.foliage.bunchCount > 0 ? 1 : 0), set: (s, v) => { if (s.foliage) s.foliage.bunchCount = Number(v) ? DATE_BUNCHES : 0; } },
    { key: 'offshoots', name: 'Basal offshoots', min: 0, max: 4, step: 1, get: (s) => s.foliage.offshoots, set: (s, v) => { if (s.foliage) s.foliage.offshoots = Math.round(v); } },
  ],
  advancedControls: [
    { key: 'heightVar', name: 'Height variation / seed', min: 0, max: 0.4, step: 0.01, get: (s) => s.params.heightVar, set: (s, v) => { s.params.heightVar = v; } },
    { key: 'trunkThickness', name: 'Trunk thickness', min: 0.5, max: 1.6, step: 0.05, get: () => 1, set: (s, v) => { s.params.trunkRadius *= v; } },
    { key: 'trunkFlare', name: 'Trunk base flare', min: 0, max: 1.5, step: 0.05, get: (s) => s.params.trunkFlare, set: (s, v) => { s.params.trunkFlare = v; } },
    { key: 'curlUp', name: 'Lean recovery (curl-up)', min: 0, max: 0.3, step: 0.01, get: (s) => s.params.curlUp, set: (s, v) => { s.params.curlUp = v; } },
    { key: 'crownDepth', name: 'Crown depth (m)', min: 0.3, max: 2, step: 0.05, get: (s) => s.foliage.crownDepth, set: (s, v) => { if (s.foliage) s.foliage.crownDepth = v; } },
    { key: 'leafletsPerSide', name: 'Leaflets per side', min: 20, max: 120, step: 1, get: (s) => s.foliage.leafletsPerSide, set: (s, v) => { if (s.foliage) s.foliage.leafletsPerSide = Math.round(v); } },
    { key: 'leafletLength', name: 'Leaflet length (m)', min: 0.2, max: 0.8, step: 0.01, get: (s) => s.foliage.leafletLength, set: (s, v) => { if (s.foliage) s.foliage.leafletLength = v; } },
    { key: 'leafletAngle', name: 'Leaflet angle to rachis (°)', min: 10, max: 80, step: 1, get: (s) => s.foliage.leafletAngle, set: (s, v) => { if (s.foliage) s.foliage.leafletAngle = v; } },
    { key: 'vFold', name: 'Frond V-fold (°)', min: 0, max: 60, step: 1, get: (s) => s.foliage.vFold, set: (s, v) => { if (s.foliage) s.foliage.vFold = v; } },
    { key: 'rankSpread', name: 'Leaflet plane spread (°)', min: 0, max: 35, step: 1, get: (s) => s.foliage.rankSpread, set: (s, v) => { if (s.foliage) s.foliage.rankSpread = v; } },
    { key: 'elevMax', name: 'Lowest frond base angle (°)', min: 50, max: 130, step: 1, get: (s) => s.foliage.elevMax, set: (s, v) => { if (s.foliage) s.foliage.elevMax = v; } },
  ],
  foliage: {
    mode: 'fronds',            // leaf material: no per-card flutter (merged mesh)
    tint: 0xffffff,            // the dull gray-green grade is baked into the atlas (--live-tint) so engines match
    alphaTest: 0.4,
    transmit: [0.30, 0.40, 0.18], // glaucous gray-green leaflets — muted backlight
    // A mature crown carries ~60–120 live fronds; the mean here (±12% per seed)
    // fills a rounded, closed crown — the lower half droops well past horizontal.
    frondCount: 96,
    frondCountVar: 0.12,
    frondLength: 4.6,
    crownDepth: 1.5,
    elevMin: 5, elevMax: 100, elevCurve: 0.75,
    droop: 1,
    droopMin: 8, droopMax: 82, droopCurve: 0.9,
    petioleFrac: 0.2,
    rachisRadius: 0.045, sheathFlare: 2.2, rachisTipRadius: 0.005,
    leafletsPerSide: 66,
    leafletLength: 0.62,
    leafletWidth: 0.065,
    leafletAngle: 40, leafletTipAngle: 22,
    vFold: 24, rankSpread: 24,
    spinesPerSide: 9,
    deadCount: 3,              // light skirt by default (dial 0 = maintained city palms)
    deadKeep: 0.8,             // dead fronds keep most leaflets → the skirt reads as a thick brown mass at high dial
    skirtDepth: 1.6,
    bunchCount: DATE_BUNCHES,
    bunchLength: 1.0,
    // Fruit stalks: long flattened orange-yellow peduncles arching out of the
    // crown; the bunches hang from their ends, below/outside the lower fronds.
    peduncleLength: 2.3,
    peduncleRadius: 0.024,
    peduncleElev: 60, peduncleDroop: 124,
    peduncleSeat: [0.3, 0.6],
    offshoots: 0,
    trunkTopWind: 0.3,
    atlas: ATLAS,
    // Crown tubes sample the bark atlas (compose-palm-bark-atlas.mjs output):
    // live rachis = yellow-green strip (pale cream at the base, paler underside),
    // peduncle = orange-yellow strip, dead fronds = a pale boot-face patch of the trunk tile.
    rachisUV: [0.8916, 0.00195, 0.93652, 0.99805],
    peduncleUV: [0.93848, 0.00195, 0.9834, 0.99805],
    deadRachisUV: [0.42039, 0.3516, 0.43652, 0.3906],
    rachisNormalBend: 0.5,
  },
  params: {
    trunkHeight: 11,           // mean trunk height (m); seeds vary ±heightVar
    heightVar: 0.2,
    lean: 12,                  // lean dial (deg); each seed draws a skewed 0..1.25× of it
    segmentLength: 1.4,
    trunkRadius: 0.24,
    trunkFlare: 0.35,
    trunkUndulation: 0.25,
    segRadiusKeep: 0.995,      // palms barely taper
    contRadiusKeep: 0.995,
    curlUp: 0.07,              // a leaning trunk curves gently back toward vertical
    gnarliness: 2.5,
    armBend: 0,
    continuationKink: 2,
    radialSegs: 12,
    barkAtlas: BARK_ATLAS,     // one trunk revolution = the atlas's trunk region (never the strips)
    trunkSegRes: 6,
    segCurveRes: 3,
    branchRepel: 0,
    tileWorldSize: 0.75,
  },
};
