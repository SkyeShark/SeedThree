Replacement for #11, based on current main (cf2eaad).

Barkless plants now skip fallen-limb bark loading in the app as well as the species asset loader. Frond UVs follow the shipped card's diagonal rachis. Fronds rise, crest before their tips and arch outward rather than growing as a near-vertical funnel.

This stays a draft: the radial-frond generator/API/GUI path is Tier-2/3 work and the review explicitly leaves that design decision to @SkyeShark. No scope approval is assumed.

Validation: independent branch tests and Vite production build; regression checks for the descending tip and UV rachis endpoints; native WebGPU side/overhead renders and ten seeds. Botanical form reference: [RHS male fern](https://www.rhsplants.co.uk/plants/_/dryopteris-filix-mas/classid.2000011777/sku.rh30000595/).

Full production-app smoke also passes with the fern selected: native WebGPU, loaded fern materials, barkless biome skips fallen limbs, and zero runtime errors. This fixture selects fern at startup and exercises the supported main-thread billboard bake path.

![Arched fronds](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-arched-fern-20261012/docs/review-evidence/commonFern-side.png)

![Continuous diagonal rachis sampling](https://raw.githubusercontent.com/SeloSlav/SeedThree/codex/review-arched-fern-20261012/docs/review-evidence/commonFern-top.png)
