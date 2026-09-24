# Species roadmap — candidates mapped to the machinery we already have

The engine's promise is "a new species is a preset + textures, no engine
changes" (README §Adding a species). This roadmap sorts candidates by how true
that is for each: **drop-in** (preset + Codex textures only), **small tweak**
(one contained engine accommodation), and **new machinery** (a real feature).
Ordered within each tier by scene value per effort.

Reference note: the saguaro reference photo set for the LOD work (Saguaro NP,
Tucson) happens to show prickly pear AND cholla growing in-frame with the
saguaros — the Sonoran scene reads underdressed without at least one of them.

## Tier 1 — drop-in presets (Weber-Penn path)

1. **Paper birch** (*Betula papyrifera*) — the white peeling bark is the whole
   tree; our per-species bark PBR pipeline is exactly the right tool. Small
   oval crown, `levels 3`, thin trunk, upswept branches. Textures: white bark
   albedo/normal/rough (the horizontal lenticel strokes matter), small
   serrated leaf. Biggest temperate-variety win available.
2. **Quaking aspen** (*Populus tremuloides*) — birch's sibling: pale
   green-white smooth bark, round fluttering leaves (our per-instance flutter
   finally gets its poster species — bump flutter amplitude in `foliage`).
   Groves of them in the forest ring would look superb.
3. **American sycamore** (*Platanus occidentalis*) — mottled camo bark
   (another texture showcase), broad open crown, big leaves, `branchAngle`
   wide. Zero new engine needs.
4. **Flowering dogwood** (*Cornus florida*) — small understory tree; a white
   "blossom" leaf-card variant makes it a spring showpiece (the leaf material
   already supports per-species cards + tint).
5. **Weeping willow** (*Salix babylonica*) — mostly a preset: strong downward
   `curve`/`downAngle` on the deep levels + the growth-force tropism
   (`forceDir -Y`) we already expose, long narrow leaf cards. The pendulous
   tips will tell us if the grammar needs a "droop" curve mode (then it's
   Tier 2, still small).

## Tier 2 — small engine accommodations (dichotomous/rosette family)

6. **Mojave yucca** (*Yucca schidigera*) — a short, few-crowned Joshua:
   `forkGenerations 2-3`, thicker trunk, LONGER rosette blades, heavier skirt.
   The generator and `yucca-leaves.js` were literally built for this
   generalization; likely pure preset in practice. Instant desert variety.
7. **Barrel cactus** (*Ferocactus*) — saguaro machinery, no arms
   (`armMaxOrder 0`), short/fat column (`firstForkHeight` low, fat
   `trunkRadius`), deeper ribs, denser+longer spines. Possibly pure preset;
   at most a "squat column" proportion knob.
8. **Agave / century plant** — a TRUNKLESS ground rosette: one giant crown at
   y≈0 (the `babyTree` degenerate case already handles trunk-is-the-plant);
   blades need to read THICK/succulent (wider cone `open` angles + a fleshy
   blade texture). Optional later: the iconic flower stalk as a single
   continuation stem. Small contained tweaks to the rosette builder.
9. **Cholla** (*Cylindropuntia*) — chained cylindrical segments = the
   dichotomous tube mesher with short `armLength`, high `branchiness`, and a
   HEAVY spine pass (the fuzzy backlit halo is the species — our spine cards
   + SSS already do exactly this on the saguaro). Worth a prototype before
   calling it Tier 3.

## Tier 3 — new machinery (schedule as features)

10. **Prickly pear** (*Opuntia*) — pad-chain growth: flat elliptical segments
    joined edge-to-edge at varied azimuths. Pads are not tubes; needs a new
    segment mesher (lofted disc pairs) though placement/L-system logic can
    reuse the dichotomous fork grammar. The desert floor wants it badly
    (see reference photo) — best first Tier-3 investment.
11. **Fan palm** (*Washingtonia*) — the frond builder now EXISTS
    ([`frond-builder.md`](frond-builder.md), shipped with the date palm):
    trunk, crown layout, droop, dead-frond skirt (the shaggy Washingtonia
    skirt = a dense `deadCount` / high `deadKeep` skirt), LODs and frond
    cards are shared. What remains is the PALMATE leaflet placer (fanned,
    pleated segments on a short costa — see the doc's §7) plus a pleated-
    segment atlas piece. Now a Tier-2 item. Pairs with a future "oasis" biome.
    - ✅ **Date palm** (*Phoenix dactylifera*) — DONE: pinnate frond builder
      (curved rachis + V-folded multi-plane leaflet cards + spines), dead
      skirt, date bunches, offshoots, baked frond-card LOD2. Uses the `desert`
      biome for now (a riverine/oasis biome would ripple into scenes + audio).
12. **Ponderosa-style deadwood snag** — not a species so much as a variant
    flag (foliage off + bark weathering tint + branch prune high); nearly
    free and adds enormous realism scattered through both biomes. Could ship
    as a `snag: true` preset toggle any time.

## Suggested order

Birch → Mojave yucca → barrel cactus → aspen → agave → sycamore/dogwood →
cholla prototype → willow → prickly pear (feature) → ~~palm (feature)~~ date
palm done (frond builder) → fan palm (palmate placer).

Each Tier-1/2 species: 1 bark set + 1-2 leaf/blade cards via the Codex
`$imagegen → scripts/texture/` pipeline, a preset file, and a HUD/LOD sanity
pass (the mobile ladders are generator-level, so new presets inherit them for
free).
