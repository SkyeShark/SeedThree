// Tileability checker for seamless textures.
//
// Measures how well an image tiles by comparing the pixels that become adjacent
// when the image is repeated (last column vs first column, last row vs first row)
// against the baseline of normal adjacent-pixel variation in the interior. A
// seamless texture has edge-seam error close to the interior baseline; a visible
// seam has edge error several times higher.
//
// Also writes an offset ("torus-shifted") preview: the image rolled by 50% in x
// and y so the former edges meet in the center — any seam appears as a cross.
//
// Usage: node scripts/texture/check-tile.mjs <image.png> [--preview out.png]

import sharp from 'sharp';
import path from 'node:path';

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
  console.error('usage: node check-tile.mjs <image.png> [--preview out.png]');
  process.exit(2);
}
const previewIdx = args.indexOf('--preview');
const previewOut = previewIdx >= 0 ? args[previewIdx + 1]
  : input.replace(/\.png$/i, '.offset.png');

const { data, info } = await sharp(input)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const { width: W, height: H, channels: C } = info;
const at = (x, y, c) => data[(y * W + x) * C + c];

// Mean absolute difference (over RGB) between two columns.
function colDiff(x0, x1) {
  let sum = 0;
  for (let y = 0; y < H; y++)
    for (let c = 0; c < 3; c++) sum += Math.abs(at(x0, y, c) - at(x1, y, c));
  return sum / (H * 3);
}
function rowDiff(y0, y1) {
  let sum = 0;
  for (let x = 0; x < W; x++)
    for (let c = 0; c < 3; c++) sum += Math.abs(at(x, y0, c) - at(x, y1, c));
  return sum / (W * 3);
}

// Seam error: pixels that wrap around and become neighbors when tiled.
const seamX = colDiff(W - 1, 0);
const seamY = rowDiff(H - 1, 0);

// Interior baseline: average adjacent-column / adjacent-row diff sampled across
// the image. This is the "normal" local variation the seam should blend into.
let baseX = 0, baseY = 0, n = 0;
for (let f = 0.1; f < 0.9; f += 0.1) {
  baseX += colDiff(Math.floor(W * f), Math.floor(W * f) + 1);
  baseY += rowDiff(Math.floor(H * f), Math.floor(H * f) + 1);
  n++;
}
baseX /= n; baseY /= n;

const ratioX = seamX / baseX;
const ratioY = seamY / baseY;
// Verdict: seam within ~2x of interior variation reads as seamless in practice.
const pass = ratioX < 2.0 && ratioY < 2.0;

console.log(`image:        ${path.basename(input)}  ${W}x${H}  ${C}ch`);
console.log(`seam X (L|R): ${seamX.toFixed(2)}  vs interior ${baseX.toFixed(2)}  -> ${ratioX.toFixed(2)}x`);
console.log(`seam Y (T|B): ${seamY.toFixed(2)}  vs interior ${baseY.toFixed(2)}  -> ${ratioY.toFixed(2)}x`);
console.log(`verdict:      ${pass ? 'PASS (tiles cleanly)' : 'FAIL (visible seam)'}`);

// Offset preview so a human can eyeball any seam as a center cross.
// Roll the raw buffer we already decoded by 50% in x and y (torus shift).
const shifted = Buffer.alloc(data.length);
const dx = W >> 1, dy = H >> 1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const sx = (x + dx) % W, sy = (y + dy) % H;
    const src = (sy * W + sx) * C, dst = (y * W + x) * C;
    for (let c = 0; c < C; c++) shifted[dst + c] = data[src + c];
  }
}
await sharp(shifted, { raw: { width: W, height: H, channels: C } })
  .png()
  .toFile(previewOut);
console.log(`offset preview -> ${path.basename(previewOut)}`);

process.exitCode = pass ? 0 : 1;
