Replacement for #12, #13 and #14, built directly on current main (cf2eaad); #10 is already in the base.

The three shrubs retain the reviewed bark and branchlet assets. Juniper keeps all four of main's original juniper_scrub maps unchanged. Bilberry and raspberry translucency maps are regenerated with main's corrected pipeline.

Fruit GLBs now embed base colour, tangent normal and roughness textures, use metres, and do not depend on COLOR_0. Raspberry uses a fused smooth drupelet source, decimated retopology and a curved green pedicel/calyx. Asset provenance is explicit: these are reproducible authored Blender sources, not Orrery/Tripo outputs.

Fruit starts at 0.72 along the outer shoots, with higher caps/attempt counts. Smaller single-plane branchlet sprays reduce overlap so the hanging fruit is visible. The growth skeleton and branchlet artwork are retained.

Validation: independent branch tests and Vite production build; actual WebGPU PBR loading, side/overhead close-ups and LOD0/1/2 counts across seeds 1–10. Natural leaf occlusion remains; the close-ups and mask results are included for review.

![Baked raspberry fruit](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-fruiting-shrubs-20261012/docs/review-evidence/raspberry-fruit.png)

![Raspberry fruit below the leaf sprays](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-fruiting-shrubs-20261012/docs/review-evidence/raspberry-fruit-on-plant-side.png)

![Bilberries viewed from above](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-fruiting-shrubs-20261012/docs/review-evidence/bilberry-fruit-on-plant-top.png)

![Juniper cones on outer shoots](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-fruiting-shrubs-20261012/docs/review-evidence/commonJuniper-fruit-on-plant-side.png)
