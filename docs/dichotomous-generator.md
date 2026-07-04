# Dichotomous / rosette plant generator (Joshua tree, yuccas, dragon trees)

A **from-scratch** generator, fundamentally separate from the Weber-Penn
broadleaf path (`weber-penn.js` + `branch-mesh.js`). Those model a trunk with
children distributed *along* it and twigs that taper to points — wrong physics
for a Joshua tree. This is its own module: `core/dichotomous.js`.

This doc is the contract. Every requirement below came from the user; if the
code and this doc disagree, the doc wins — fix the code.

## 1. Skeleton — a stochastic L-system

Axiom `F`, rule `F → F[+F][-F]`, applied **stochastically**:

- `F` = grow one **short** segment forward.
- At the end of each segment, with probability = **branchiness**, the rule
  fires and the stem **forks** into 2 (occasionally 3) children; otherwise it
  **continues as a single straight-ish F** (a run). Branchiness raises how
  *often* junctions fork — but even at max, **not every junction forks**.
- `[+F][-F]`: the fork's children **diverge by equal, opposing angles** in a
  per-fork randomly-oriented plane → a clear **V, never parallel**.
- First fork **low to the ground** by default; a setting moves it.
- Depth (fork generations) is a setting.
- Segment bending (the elbow) is done by **programmatically bending the segment
  geometry** (curved polyline), NOT by adding more segments.
- Radius: arms stay **nearly as thick as the trunk** — only a slight step-down
  per fork (`forkRadiusKeep`), never tapering to a twig/point.
- **Default 1 trunk**; multi-trunk is a rare option.

## 2. Branch mesh — ONE merged surface, no split pieces

The whole skeleton is meshed as a **single, connected, weldable** tube network.
**No separate cylinders.** At every fork the parent tube **merges** into its
children (like the oak trunk's joined multi-leader base, but through every
junction): the parent's end ring feeds both children's start rings so the
surface is continuous — **no holes at junctions**. Fork children flare their
base to the parent radius so the union is seamless.

Branch/trunk **tips are never visible** — every tip is fully **hidden inside a
rosette**. (Tip closure shape is irrelevant since it's covered.)

## 3. Rosettes — circle-of-blades on nested cones

- Texture: a **circle of individual spike blades meeting at a point in the
  center**, alpha between them (user-supplied; already replaced in assets).
- Mapped onto **straight tapered cone shells** via planar-radial UV (sprite
  center → cone apex, blade tips → cone rim; `uvR` samples the full sprite so
  **tips are never cut off**).
- A rosette = several **nested cones** sharing the tip center: tight-up → flat
  → inverted-down ("opened up and stacked on each other") = a ball + skirt.
- **A few** cones may have **slight** bend — not a lot, not all of them.
- Cones **follow the branch geometry** — the cone axis aligns with the branch's
  direction at the tip (and the skirt drapes along the branch), so the rosette
  reads as growing out of the arm.
- Cones must **never show a visible point/apex** — the apex sits inside the
  branch/rosette, hidden.
- Rosette radius must be **larger than the branch radius** so it **hides the
  tip** (the "tiny nub" bug = undersized rosettes).

## 4. Dead-leaf skirt

Dead leaves hang **downward**, draping down **most of each branch**: **brown-
yellow right under the green** rosette, fading to **gray / bark color** further
down (dead leaves *becoming* the bark — the plant has **no real bark**).

## 5. Sliders — ALL map to THIS math

Every control affects the dichotomous math, not oak params:
Height · Fork generations (L-system depth) · Branchiness (fork probability) ·
Fork spread (divergence half-angle) · Gnarliness (segment curve variance) ·
Arm bend (elbow) · Arm/segment length · Arm curl-up (tropism toward vertical) ·
First-fork height (bare trunk) · Trunks (default 1) · Trunk thickness · Rosette
size · Rosette variation · Show leaves · Bark tiling.

## 6. Reuse — saguaro cactus (later)
This generator is **generic/parameterized**, not Joshua-specific. Saguaro
cactus reuses the same dichotomous branching but with **more curved arms**
(strong upward curve on the branches) and different mesh/skin (ribbed column,
no rosettes). Keep segment curvature, fork behavior, and mesh merging as
tunable parameters so a saguaro preset can drive the same core.

## 7. Direction: generalize to a shared L-system engine (all species)
`dichotomous.js` is already, in essence, a specialized L-system interpreter —
it applies `F → F[+F][-F]` stochastically via recursion instead of literal
string rewriting. The plan is to generalize it into ONE parametric, stochastic
L-system growth core that every species drives with its own ruleset + tuning:
- **turtle module set**: F (grow), +/− (turn), &/^ (pitch), \\// (roll),
  [ ] (branch push/pop) — 3D.
- **parametric modules** (Prusinkiewicz): symbols carry length/angle/radius/age
  so the sliders map straight onto grammar parameters.
- **stochastic rules**: e.g. dichotomous `F(0.6)→F[+F][-F] / F(0.4)→FF`.
- shared **merged-tube mesher** (section 2) as the geometry backend for all.
Per-species grammars: yucca/joshua = dichotomous; saguaro = dichotomous + curved
arms + ribbed skin; broadleaf (oak) = monopodial main axis + laterals;
conifer = whorled laterals. Migrate species one at a time, verifying each looks
as good or better than its current generator before switching — do NOT big-bang
replace the working Weber-Penn oak.

## 8. Later
Flower/fruit blooms as an option, once the shape reads right.

## Build order (verify with the user between stages — I can't see the canvas)
1. L-system skeleton + merged-tube mesh → check the **branching** reads right.
2. Rosettes sized to hide tips + the hanging brown→gray skirt.
3. Slight cone bend, polish, then blooms.
