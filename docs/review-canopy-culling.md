Replacement for #7, rebased onto current main (cf2eaad).

Retain bounded bake-only canopy coverage and crossed cards at distance. Whole-crown underlays are culled whenever their nearest bounding-sphere surface is within 20m of the camera. The hero path and per-slot grove compaction use the same predicate, with world transforms and slot scale included. Detailed sprays remain visible. Impostor baking explicitly restores culled underlays in its cloned source.

Current main's willow front/side views, curved feeders, shrub mobile ladder and orchard fruit baking are preserved. This replacement retains main's twig/mesh-quality policy instead of importing the old branch's obsolete mobile ladder.

Validation: independent branch tests and production build; coverage/cost limits; translated/scaled near-culling regressions; native WebGPU baseline/after screenshots from identical seeds at ground, overhead and close forced-LOD2 views. The close view exercises the same clearance predicate used by grove slots. Images below are viewable on GitHub without a local server.

Seed 7 CPU geometry counts: white oak LOD0 56,208 → 56,208, LOD1 28,104 → 28,104, LOD2 8,108 → 8,242; Douglas fir LOD0 45,264 → 45,264, LOD1 27,124 → 27,124, LOD2 6,894 → 6,898. Underlay cost is 4 triangles per root, bounded at 16; the two-root oak adds 8, the fir 4. Near culling removes those underlay triangles. Crossed detailed cards cost 4 triangles each instead of 2; bake-only fill adds zero runtime triangles. Draw and rendered-triangle measurements are in the attached JSON.

![White oak before, side](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-canopy-culling-20261012/docs/review-evidence/whiteOak-before-side.png)

![White oak after, side](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-canopy-culling-20261012/docs/review-evidence/whiteOak-after-side.png)

![White oak before, top](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-canopy-culling-20261012/docs/review-evidence/whiteOak-before-top.png)

![White oak after, top](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-canopy-culling-20261012/docs/review-evidence/whiteOak-after-top.png)

![White oak before, close forced LOD2](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-canopy-culling-20261012/docs/review-evidence/whiteOak-before-grove.png)

![White oak after, close forced LOD2](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-canopy-culling-20261012/docs/review-evidence/whiteOak-after-grove.png)
