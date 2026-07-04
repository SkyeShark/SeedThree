// Alpha dilation / edge-padding ("solidify") for cutout textures.
//
// AI-generated cutouts store BLACK rgb in transparent texels. When sampled with
// bilinear filtering + mipmaps, that black bleeds into the opaque edges → a dark
// halo/fringe around every leaf. Fix: flood the opaque edge colours outward into
// the transparent region (RGB only; alpha is preserved so alphaTest is unchanged).
//
// Usage: node scripts/texture/dilate-alpha.mjs <cutout.png> [--passes 20]  (overwrites in place)

import sharp from 'sharp';

const input = process.argv[2];
if (!input) { console.error('usage: dilate-alpha.mjs <cutout.png> [--passes N]'); process.exit(2); }
const pi = process.argv.indexOf('--passes');
const passes = pi >= 0 ? +process.argv[pi + 1] : 20;

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

const rgb = new Float32Array(W * H * 3);
const alpha = new Uint8Array(W * H);
const filled = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  rgb[i * 3] = data[i * C]; rgb[i * 3 + 1] = data[i * C + 1]; rgb[i * 3 + 2] = data[i * C + 2];
  alpha[i] = data[i * C + 3];
  filled[i] = alpha[i] > 12 ? 1 : 0;   // opaque texels seed the flood
}

for (let p = 0; p < passes; p++) {
  const next = filled.slice();
  let changed = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (filled[idx]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nidx = ny * W + nx;
          if (filled[nidx]) { r += rgb[nidx * 3]; g += rgb[nidx * 3 + 1]; b += rgb[nidx * 3 + 2]; n++; }
        }
      }
      if (n > 0) { rgb[idx * 3] = r / n; rgb[idx * 3 + 1] = g / n; rgb[idx * 3 + 2] = b / n; next[idx] = 1; changed++; }
    }
  }
  filled.set(next);
  if (!changed) break;
}

const out = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1]; out[i * 4 + 2] = rgb[i * 3 + 2];
  out[i * 4 + 3] = alpha[i]; // original alpha preserved
}
await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toFile(input);
console.log(`dilated (${passes} passes) -> ${input.split(/[\\/]/).pop()}  ${W}x${H}`);
