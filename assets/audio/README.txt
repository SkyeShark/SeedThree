SeedThree ambient audio
========================

WIND (looping bed, one per biome) — generated with Stable Audio 3 via ComfyUI,
then made into a seamless loop:
    wind_temperate.mp3   leafy forest/meadow breeze
    wind_desert.mp3      dry arid desert wind
Regenerate with:
    node scripts/audio/gen-wind.mjs wind_<biome>_raw.mp3 22 "<prompt ...Length: 22 seconds>"
    node scripts/audio/loop-wind.mjs wind_<biome>_raw.mp3 wind_<biome>.mp3
Playback level is set low in src/audio/ambience.js (WIND_LEVEL) — a faint bed.

BIRD CALLS — random interspersed, per biome, multiple variants per kind (pick one
at random, subtle volume, fade in + out). Filenames <kind>_<n>.mp3:
    temperate:  crow_1/2.mp3,       mallard_1/2.mp3
    desert:     roadrunner_1/2.mp3, cactus_wren_1/2.mp3
All sourced from xeno-canto (see the XC ids in the original Downloads filenames);
trimmed/normalized with ffmpeg. Add more variants by dropping <kind>_<n>.mp3 here.

Toggle everything with the speaker button in the bottom-left (starts muted — one
click to enable; browser autoplay policy requires that first gesture).
