// Edge-preserving denoise for a map (e.g. a translucency/thickness map that has
// speckle noise between structured features). A median filter removes isolated
// speckle while keeping lines/edges (veins) crisp — unlike a blur, which smears
// the veins too. Optional light blur afterward to soften residual grain.
//
// Usage: node scripts/texture/denoise.mjs <map.png> [--median 5] [--blur 0]  (overwrites in place)

import sharp from 'sharp';
import { rename } from 'node:fs/promises';

const input = process.argv[2];
if (!input) { console.error('usage: denoise.mjs <map.png> [--median N] [--blur N]'); process.exit(2); }
const mi = process.argv.indexOf('--median'); const med = mi >= 0 ? +process.argv[mi + 1] : 5;
const bi = process.argv.indexOf('--blur'); const blur = bi >= 0 ? +process.argv[bi + 1] : 0;

const tmp = input.replace(/\.png$/i, '.denoise.png');
let pipe = sharp(input).median(med);       // odd window; removes speckle, keeps veins
if (blur > 0) pipe = pipe.blur(blur);
await pipe.png().toFile(tmp);
await rename(tmp, input);
console.log(`denoised (median ${med}${blur ? `, blur ${blur}` : ''}) -> ${input.split(/[\\/]/).pop()}`);
