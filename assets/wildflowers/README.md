# Gorski Kotar wildflower cards

This folder contains a runtime atlas plus five transparent, material-ready
botanical head cards in `source/`. The individual 512×512 cards are retained as
editable source assets without making Vite ship them twice;
`gorski-kotar-wildflower-atlas.png` packs 256×256 runtime cells in this
left-to-right order:

1. Daisy star-aster
2. Clusius gentian (`Gentiana clusii`)
3. Grey hawkbit (`Leontodon incanus`)
4. Bulbiferous lily (`Lilium bulbiferum`)
5. Red campion (`Silene dioica`)

The cards use straight alpha and diffuse, overcast albedo-like lighting. SeedThree
maps one atlas cell onto each flower-head quad and groups instances into
single-species colonies. The modeled stems and leaves use a separate fibrous
surface treatment; flower color never falls back to vertex-tinted geometry.
