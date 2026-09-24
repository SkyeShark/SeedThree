# Frond builder (palms) — pinnate fronds on the dichotomous trunk

`core/frond-builder.js` builds palm crowns: curved blade strips with droop, not
nested cones. It is a generic generator feature; the date palm
(`species/date-palm.js`, `foliageType: 'fronds'`) is its first user. This doc is
the contract — if code and doc disagree, fix the code.

## 1. Where it plugs in

`buildTree` routes `foliageType: 'fronds'` to `buildFrondTree` (`core/tree.js`):

1. **Trunk** — `generateDichotomous` with **forking disabled** (`branchiness 0`,
   one trunk): a single run of F segments, meshed by `buildMergedMesh` exactly
   like a Joshua trunk. Palm-only generator params (all default to the old
   behaviour, so no other species changes):
   `trunkLean` / `trunkLeanAz` (initial lean of a single trunk; `curlUp` then
   bends it gently back toward vertical), `segRadiusKeep` / `contRadiusKeep`
   (per-segment taper; palms ≈ 0.995), `trunkUndulation` (root-flare lumpiness).
2. **Individual** — `individualizePalm(species, seed)` draws the seed's own
   trunk height (± `heightVar`), lean (skewed: most stand straight), frond
   count, frond length, droop and skirt size from a separate stream. The dials
   set the mean; the seed picks the individual.
3. **Crown layout** — `layoutCrown(top, base, cfg, rng)` produces frond
   descriptors once per individual (every LOD meshes the same layout, so levels
   never reshuffle): live fronds, the dead skirt, basal offshoots, fruit bunches.
4. **Meshing per LOD** — `buildCrownGeometry(layout, cfg, spec)` →
   `{ bark, leaves }`, or baked frond cards on the far rungs.
5. **Wind** — the trunk weight is `trunkTopWind · (y/H)^1.5` (palms sway from the
   crown); each rachis ramps from `trunkTopWind` at its base to 1 at its tip.
   Rachis vertices carry `aWind`/`aStemCenter` (bark wind shader); every leaflet
   vertex carries its rachis anchor weight/centreline point
   (`aWindVec`/`aAnchorPos`), so the foliage shader moves each leaflet with the
   exact offset of the rachis point it grows from — the weld invariant of
   `wind.js`. No per-card flutter (merged mesh; see §5).

## 2. The frond

A frond descriptor: `{ base, axis (crown axis), h (azimuth ⊥ axis), elev, droop,
droopPow, length, roll, dead, wBase, age, key, scale? }`.

- **Rachis curve** — lies in the plane (axis, h). Base direction
  `d0 = cos(elev)·axis + sin(elev)·h`; lateral `L = axis × h` (rolled by `roll`);
  the tangent at arc s is `d0` rotated about `L` by `droop·(s/length)^droopPow`
  (stiff petiole, bending tip — rotation about +L always bends toward gravity for
  a frond leaving an upright crown). Leaf-plane normal `N = T × L` (adaxial side:
  up on a horizontal frond, facing the crown centre on an upright one).
- **Rachis tube** (bark slot) — flattened ellipse (`rachisFlat` depth/width),
  radius `rachisRadius → rachisTipRadius`, sheath flare (`sheathFlare`) over the
  first 8 % where the leaf base wraps the trunk. UVs map the tube onto its own
  strip of the bark ATLAS (`rachisUV`; u around the tube with the adaxial side at
  u 0–0.5, v base → tip) — see §6. Dead fronds sample `deadRachisUV` (a pale
  boot-face patch of the trunk tile). Export normals are bent `rachisNormalBend`
  (0.5) toward the crown dome, like the leaflets' 0.85: a true tube normal faces
  the ground on the underside, so from below every rachis read as a dark line
  against the backlit leaflets.
- **Leaflets** (leaves slot) — `leafletsPerSide` per side from `petioleFrac` to
  the tip. Each leaflet:
  - **length profile** — a skewed bump peaking at `leafletPeak` of the blade,
    `leafletMinFrac` of `leafletLength` at both ends;
  - **angle to the rachis** — `leafletAngle` at the blade base easing to
    `leafletTipAngle` at the tip;
  - **V-fold** — lifted `vFold` above the frond plane (the frond's V);
  - **multi-plane ranks** — consecutive leaflets alternate
    `vFold + {+1, −0.15, −1}·rankSpread` (Phoenix leaflets sit in several planes —
    this is what keeps the crown feathery, never flat);
  - **own fold** — each card is folded along its midrib by `leafletFold` per
    half (induplicate, V opening upward), `leafletSag` gravity sag at the tip;
  - width = `leafletWidth · length` (the atlas alpha shapes the blade).
- **Spines** — `spinesPerSide` short acanthophylls along the petiole
  (`spineLength`), LOD0 only.
- **Dead fronds** — same grammar with the dead atlas pieces, hanging base angle
  148–180° (the oldest flat against the trunk), leaflets collapsed below the
  rachis, `deadKeep` of them left, as flat single cards (`deadWidthMul` wider).
  The skirt fills a FIXED band `skirtDepth` below the live crown whatever the
  count, so a high count thickens it instead of stretching it down the trunk.
- **Fruit** — each bunch rides a **peduncle**: a flattened strap tube (bark slot,
  its own orange-yellow atlas strip `peduncleUV`) that leaves a leaf axil in the
  `peduncleSeat` band (fraction of `crownDepth`), arches out at `peduncleElev`
  and bends `peduncleDroop` toward gravity so it ENDS hanging — the frond curve
  law with its own radius/flatness (`peduncleLength`, `peduncleRadius`,
  `peduncleFlat`). The bunch hangs from the stalk's end: three vertical cards at
  60° (two crossed cards read flat, like a pinecone, from the diagonals) plus a
  horizontal CAP card through the lower bunch, which is what reads from straight
  below. Bunches are spread evenly round the crown. `peduncleLength 0` restores
  the old stalkless bunches at the crown. The palm keeps its bunches as atlas
  cards rather than using the orchard fruit system (per-fruit GLB instances with
  their own material): a bunch is hundreds of small dates, which read fine as
  cards, and the crown stays on one leaves material.
- **Offshoots** — trunkless mini-crowns at the trunk foot (`offshoots`).

Randomness per leaflet comes from a per-frond stream drawn in a fixed order, so
reduced LODs keep a strict subset of LOD0's leaflets in the same places.

## 3. Crown layout parameters

`frondCount` (± `frondCountVar` per seed), `frondLength` (young fronds shorter),
`crownDepth` (band down the trunk top where live fronds attach; youngest at the
centre top, oldest lowest and outermost), phyllotaxis = golden angle.
`elevMin → elevMax`: base angle from the crown axis, youngest → oldest
(ascending spear → arching mid fronds → drooping old fronds), ramped by
`age^elevCurve`; `droopMin → droopMax` × `droop`: rachis bend, youngest →
oldest, ramped by `age^droopCurve`. Curves < 1 front-load the ramp: the mid-aged
majority already arches past horizontal, so the fronds' tip chords spread about
evenly in cos(angle) from the spear to the hanging oldest fronds — a rounded,
closed crown. Curves > 1 (the defaults 1.15 / 1.4) leave half the crown pointing
up: a young-palm / coconut-like burst. A mature date palm carries ~60–120 live
fronds (species mean 96 ± 12 %).
The crown axis is halfway between the trunk tip tangent and vertical, so a
leaning palm's crown turns back toward the light.

## 4. LOD chain

| level | trunk | crown |
|---|---|---|
| LOD0 | full rings | 12-ring rachis (6 on dead fronds), 1-segment V-folded leaflets (2 segments on the oldest silhouette fronds, `outerAge` 0.9), spines, flat skirt cards, peduncles + bunches |
| LOD1 | ring-decimated | 7-ring rachis, stable 85 % leaflet subset as flat single cards ×1.3 width, no spines (~38 % of LOD0) |
| LOD2 | ring-decimated | **baked frond cards** (below); fallback without a bake: 30 % flat leaflets |
| BB | — | the generic 2-plane billboard, baked from LOD0 |

**Frond cards** (`bakeFrondCards` / `buildFrondCardFoliage`): one straightened
exemplar frond per variant (two live, one dead when the skirt is on) is rendered
top-down through the multichannel baker. Each baked picture then rides a
**curved V-ribbon** (7 rows × 2 wings, 28 tris) bent by the same droop law as
the rachis; ribbons are pre-built per droop class (0–110° in 22° steps) and
instanced per (variant, class) — each frond takes its nearest class, oriented by
its base frame, scaled by its length. Instanced, so the forest grove re-instances
palms like every other species. The cards cast shadows but do not receive them
(~100 overlapping ribbons self-shadow into a dark mass the mesh LODs never
show). Card rungs still mesh the peduncles as real bark tubes
(`buildCrownGeometry(…, { pedunclesOnly })`) so the instanced bunches hang from
their stalks.

**Card economy (the LOD0 budget).** The date palm targets ≤ 90k LOD0 triangles
per tree, so a grove or an avenue of many palms stays affordable at full
detail. The crown stays dense by spending fewer triangles
per card, never by thinning fronds or leaflets: one folded segment per leaflet
(4 tris; the gravity sag rides in the card's chord), two segments only on the
oldest ~10 % of fronds, flat cards on the dead skirt, 6-ring dead rachises.
Default crowns land at 65–82k over seeds 1–40 (tested); the full-dial dead
skirt (40 fronds) adds ~13k and can exceed the budget (cultivated palms are usually trimmed). Mobile ladder: LOD0/LOD1 parked, cards as the
near rung, then card rungs without the skirt (LOD3) and with a stable 60 %
frond subset (LOD4).

## 5. Materials and the GLB export

LOD0 is exactly **two meshes → two glTF primitives**:

- `<Species>_LODn_branches` — trunk + every rachis and peduncle tube, one geometry
  (`mergeIndexedGeometries`, no BufferGeometryUtils so the core still imports
  under Deno), the species bark material.
- `<Species>_LODn_leaves` — ONE merged, non-instanced mesh of every leaflet,
  spine, dead leaflet and bunch card (incl. the cap cards), all on the species leaf material
  (`makeFoliageMaterial` with `mode: 'fronds'`: dome normals + SSS, no
  per-instance flutter — a merged mesh has no instance-local height).
  `geometry.userData.exportAttributes` makes the GLB export drop the
  shader-only wind/SSS attributes; normals are baked dome-bent (0.85) like the
  instanced-leaf export.

So a palm exports like the other species: one bark primitive and one masked
leaves primitive per LOD.

## 6. Textures

- **Frond atlas** (`assets/leaves/<x>_frond_albedo.png`, one texture for the
  whole leaves slot): `scripts/texture/compose-frond-atlas.mjs` cuts chroma-keyed
  source sheets (rows of vertical leaflets on magenta; one hanging fruit bunch)
  into pieces and packs them: live leaflets, dead leaflets, bunch. It prints the
  UV rects for the preset's `foliage.atlas`. `--live-tint r,g,b` grades the live
  leaflets IN the texture (the app's material tint is not part of the exported
  glTF, so baking the grade into the atlas keeps exports looking like the
  viewer). Then the usual
  `dilate-alpha` → `derive-pbr` → `derive-translucency` chain.
  **Post-grades** (`scripts/texture/grade-atlas-rect.mjs`, in place, one rect —
  run after the chain; the date palm's values):
  - bunch → amber/yellow dates: `--rect <atlas.bunch> --hue 40 --pull 0.55 --gamma 0.62 --gain 1.08` on the albedo;
  - dead leaflets → brown (a thick brown skirt): `--rect 0.37793,0.00293,0.74707,0.99707 --hue 30 --pull 0.7 --sat 1.8 --gamma 1 --gain 0.92`;
  - translucency map, dead rect and bunch rect: `--pull 0 --gamma 1 --gain 0.25`
    (the SSS transmit is green — dead leaflets and dates must not glow green).
- **Bark ATLAS** (`scripts/texture/compose-palm-bark-atlas.mjs`) — the rachis and
  peduncles live in the bark slot, so the bark image carries their colours. From
  the seamless 1024² boot-lattice tile (`assets/bark/source/<x>_tile_*.png`,
  a gitignored pipeline intermediate — see below) it
  writes a 2048 × 1024 albedo/normal/roughness set: u 0–0.875 = two periodic
  copies of the tile (resampled via a tripled strip so the copy joints and the
  wrap stay seamless), a 32 px gutter each side continuing the region's edges,
  and two 96 px strips — the **live rachis** (pale cream base → yellow-green →
  greener tip; paler, yellower underside) and the **peduncle** (pale yellow →
  orange-yellow). It prints the preset values. The trunk maps ONE revolution
  onto exactly the region (`params.barkAtlas`: `regionU`, `tilesAround`,
  `tileAspect` — a palm-only branch of `buildMergedMesh`), so it never samples
  a strip and texels stay square; the Bark-tiling dial does not apply to it.
  Plain UV0 + the standard BaseColor/Normal/Roughness maps (no vertex colours,
  no second UV set), so it imports cleanly into any glTF consumer.

  **Regenerating the source tile.** `assets/bark/source/` is not committed
  (like `assets/leaves/sources/`). To rebuild it: generate a seamless 1024²
  leaf-base "boot" lattice albedo (`$imagegen`, text prompt: an unrolled date
  palm trunk surface — overlapping diamond lattice of trimmed leaf-base stubs,
  pale straw cut faces, dark fibrous gaps, flat shadowless light, tileable),
  save it as `assets/bark/source/date_palm_tile_albedo.png`, run
  `node scripts/texture/derive-pbr.mjs assets/bark/source/date_palm_tile_albedo.png`
  for the `_normal`/`_roughness` pair, then
  `node scripts/texture/compose-palm-bark-atlas.mjs --tile assets/bark/source/date_palm_tile --out assets/bark/date_palm`.
  The rachis and peduncle strips are procedural (hash noise in the script), so
  only the tile comes from the image model.

- **Provenance.** Every date palm source image was made with Codex `$imagegen`
  from a text prompt (live-leaflet sheet, dead-leaflet sheet, date bunch,
  trunk tile); the dead-leaflet sheet is an image *edit* of the generated
  live-leaflet sheet. No photograph was used as an image input — the Wikimedia
  Commons photos listed in `src/species/date-palm.js` were morphology
  reference only.

## 7. Palmate (fan palms) — not implemented

Everything above the leaflet placer is shared: descriptor, rachis frame, layout,
LOD specs, card bake. A palmate blade needs (a) a short rachis (costa) ending in
a **hastula**, (b) segments fanned in the (T, L) plane over a `fanAngle` with a
pleat fold per segment (alternating ±`pleatFold` — the fan's corrugation), split
tips (`splitDepth`), and (c) a droop that bends segment tips rather than the
petiole. It would be a second emitter beside `emitLeaflets`, selected by
`frondType: 'palmate'`, with its own atlas piece (a single pleated segment).
The Washingtonia "shaggy skirt" maps onto the dead-frond skirt here (dense,
`deadKeep` high, drooping flat against the trunk).
