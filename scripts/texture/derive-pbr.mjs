// Derive tangent-space normal + roughness maps from an albedo texture.
//
// Albedo luminance is treated as a height field. The normal map is the Sobel
// gradient of that height (wrap-sampled so it stays tileable); the roughness map
// is a contrast-stretched luminance biased high (bark is rough everywhere, a bit
// rougher in the dark crevices). This keeps the whole PBR set consistent and
// seamless with the Codex-generated albedo without needing extra generations.
//
// Usage: node scripts/texture/derive-pbr.mjs <albedo.png> [--strength 2.5]
// Writes <base sans _albedo>_normal.png and _roughness.png beside the input.

import sharp from 'sharp';
import path from 'node:path';

const args = process.argv.slice(2);
const input = args[0];
if (!input) { console.error('usage: derive-pbr.mjs <albedo.png> [--strength N]'); process.exit(2); }
const si = args.indexOf('--strength');
const strength = si >= 0 ? parseFloat(args[si + 1]) : 2.5;

const stem = input.replace(/(_albedo)?\.png$/i, '');
const normalOut = `${stem}_normal.png`;
const roughOut = `${stem}_roughness.png`;

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

// Luminance height field in [0,1]. Alpha-aware: transparent margins (e.g. the
// color-flooded halos from dilate-alpha) are masked out — deriving from them
// paints ghost silhouettes into the normal/roughness maps.
const lum = new Float32Array(W * H);
const mask = new Uint8Array(W * H);
let hasAlpha = false;
for (let i = 0; i < W * H; i++) {
  const r = data[i * C], g = data[i * C + 1], b = data[i * C + 2];
  lum[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  mask[i] = data[i * C + 3] > 16 ? 1 : 0;
  if (!mask[i]) hasAlpha = true;
}
if (!hasAlpha) mask.fill(1); // fully opaque input (bark/ground): behave as before
const wrap = (v, n) => (v % n + n) % n;
const L = (x, y) => lum[wrap(y, H) * W + wrap(x, W)];

// Normal map (RGB) via Sobel, tileable through wrap sampling. Outside the
// alpha mask: flat neutral (128,128,255).
const normal = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    if (!mask[y * W + x]) {
      normal[o] = 128; normal[o + 1] = 128; normal[o + 2] = 255;
      continue;
    }
    const gx = (L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1))
             - (L(x - 1, y - 1) + 2 * L(x - 1, y) + L(x - 1, y + 1));
    const gy = (L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1))
             - (L(x - 1, y - 1) + 2 * L(x, y - 1) + L(x + 1, y - 1));
    let nx = -gx * strength, ny = -gy * strength, nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz);
    nx *= inv; ny *= inv; nz *= inv;
    normal[o] = Math.round((nx * 0.5 + 0.5) * 255);
    normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
  }
}

// Roughness (grayscale): high overall, rougher in dark crevices. Outside the
// alpha mask: flat neutral 0.7.
const rough = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) {
  if (!mask[i]) { rough[i] = 178; continue; }
  const r = 0.95 - 0.22 * lum[i];       // lighter ridges slightly smoother
  rough[i] = Math.round(Math.max(0, Math.min(1, r)) * 255);
}

await sharp(normal, { raw: { width: W, height: H, channels: 3 } }).png().toFile(normalOut);
await sharp(rough, { raw: { width: W, height: H, channels: 1 } }).png().toFile(roughOut);

console.log(`albedo:    ${path.basename(input)} ${W}x${H}`);
console.log(`normal  -> ${path.basename(normalOut)}  (strength ${strength})`);
console.log(`roughness -> ${path.basename(roughOut)}`);
