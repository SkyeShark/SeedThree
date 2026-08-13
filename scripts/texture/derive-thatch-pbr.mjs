// Derive a Joshua-tree dead-leaf-thatch normal + roughness pair from a
// co-registered semantic height source.
//
// Unlike derive-pbr.mjs, this never interprets albedo luminance as relief.
// The semantic height is split into three scales so broad shingled overlaps
// dominate, central ribs stay readable, and fine fibers remain shallow. The
// same structural bands author roughness: smooth/worn leaf faces are lower,
// while fine fibers and true recesses are higher.
//
// Usage:
//   node scripts/texture/derive-thatch-pbr.mjs <albedo.png> <height.png> <out-stem>
//        [--strength 12] [--height-out cleaned-height.png]
//
// Writes <out-stem>_normal.png and <out-stem>_roughness.png. The optional
// height output is an 8-bit inspection copy; all derivation stays Float32.

import sharp from 'sharp';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const [albedoSrc, heightSrc, outStem] = args;
if (!albedoSrc || !heightSrc || !outStem) {
  console.error('usage: derive-thatch-pbr.mjs <albedo.png> <height.png> <out-stem> [--strength N] [--height-out out.png]');
  process.exit(2);
}
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const strength = Number(argValue('--strength', 12));
const heightOut = argValue('--height-out', null);

const meta = await sharp(albedoSrc).metadata();
const W = meta.width;
const H = meta.height;
if (!W || !H) throw new Error(`could not read dimensions from ${albedoSrc}`);
await mkdir(path.dirname(outStem), { recursive: true });
if (heightOut) await mkdir(path.dirname(heightOut), { recursive: true });

const { data: srcBytes, info: hInfo } = await sharp(heightSrc)
  .greyscale()
  .resize(W, H, { fit: 'fill' })
  .raw()
  .toBuffer({ resolveWithObject: true });

const N = W * H;
const source = new Float32Array(N);
for (let i = 0; i < N; i++) source[i] = srcBytes[i * hInfo.channels] / 255;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / Math.max(1e-9, b - a));
  return t * t * (3 - 2 * t);
};
const percentile = (values, p) => {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))))];
};

// Robust normalization keeps a few near-black gaps or white highlights from
// consuming the whole height range.
const sourceLo = percentile(source, 0.01);
const sourceHi = percentile(source, 0.99);
for (let i = 0; i < N; i++) source[i] = clamp01((source[i] - sourceLo) / Math.max(1e-6, sourceHi - sourceLo));

const wrap = (v, n) => (v % n + n) % n;

// A wrap-aware 3x3 median drops isolated generated speckle without smearing
// the registered leaf edges or creating a seam at the tile boundary.
function median3Wrap(input) {
  const out = new Float32Array(N);
  const values = new Float32Array(9);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const row = wrap(y + oy, H) * W;
        for (let ox = -1; ox <= 1; ox++) values[n++] = input[row + wrap(x + ox, W)];
      }
      for (let a = 1; a < 9; a++) {
        const v = values[a];
        let b = a - 1;
        while (b >= 0 && values[b] > v) { values[b + 1] = values[b]; b--; }
        values[b + 1] = v;
      }
      out[y * W + x] = values[4];
    }
  }
  return out;
}

// Circular box blur in two separable passes. Repeating it three times gives a
// smooth Gaussian-like band while preserving exact periodic/tile behavior.
function boxBlurWrap(input, radius) {
  if (radius <= 0) return Float32Array.from(input);
  const span = radius * 2 + 1;
  const horizontal = new Float32Array(N);
  const out = new Float32Array(N);

  for (let y = 0; y < H; y++) {
    const row = y * W;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += input[row + wrap(k, W)];
    for (let x = 0; x < W; x++) {
      horizontal[row + x] = sum / span;
      sum += input[row + wrap(x + radius + 1, W)] - input[row + wrap(x - radius, W)];
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += horizontal[wrap(k, H) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = sum / span;
      sum += horizontal[wrap(y + radius + 1, H) * W + x] - horizontal[wrap(y - radius, H) * W + x];
    }
  }
  return out;
}

function gaussianApprox(input, radius) {
  return boxBlurWrap(boxBlurWrap(boxBlurWrap(input, radius), radius), radius);
}

const clean = median3Wrap(source);
const mid = gaussianApprox(clean, 1);   // ribs and narrow leaf rolls
const broad = gaussianApprox(clean, 5); // leaf bodies and shingled overlaps

// Multi-scale cleaned height. Broad forms get most of the amplitude; ribs are
// secondary; high-frequency fibers are deliberately shallow.
const height = new Float32Array(N);
const fineMagnitude = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const midBand = mid[i] - broad[i];
  const fineBand = clean[i] - mid[i];
  height[i] = clamp01(broad[i] + 0.58 * midBand + 0.20 * fineBand);
  fineMagnitude[i] = Math.abs(fineBand);
}

// Wrap-sampled Scharr, encoded OpenGL/+Y for Three.js. Image rows increase
// downward, so +image-dY corresponds to +tangent-Y after the usual texture flip.
const hAt = (x, y) => height[wrap(y, H) * W + wrap(x, W)];
const normal = Buffer.alloc(N * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const gx = (3 * hAt(x + 1, y - 1) + 10 * hAt(x + 1, y) + 3 * hAt(x + 1, y + 1))
             - (3 * hAt(x - 1, y - 1) + 10 * hAt(x - 1, y) + 3 * hAt(x - 1, y + 1));
    const gy = (3 * hAt(x - 1, y + 1) + 10 * hAt(x, y + 1) + 3 * hAt(x + 1, y + 1))
             - (3 * hAt(x - 1, y - 1) + 10 * hAt(x, y - 1) + 3 * hAt(x + 1, y - 1));
    let nx = -(gx / 32) * strength;
    let ny = (gy / 32) * strength;
    let nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz);
    nx *= inv; ny *= inv; nz *= inv;
    const o = (y * W + x) * 3;
    normal[o] = Math.round((nx * 0.5 + 0.5) * 255);
    normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
  }
}

// Roughness comes only from the semantic height structure, never from albedo
// brightness. Smooth high leaf faces reach 0.72-0.84; ordinary thatch stays
// around 0.82-0.96; fibers and true recesses reach 0.90-0.98.
const broadLo = percentile(broad, 0.04);
const broadHi = percentile(broad, 0.96);
const fineHi = Math.max(1e-6, percentile(fineMagnitude, 0.98));
const roughness = Buffer.alloc(N * 3);
for (let i = 0; i < N; i++) {
  const b = clamp01((broad[i] - broadLo) / Math.max(1e-6, broadHi - broadLo));
  const fiber = smoothstep(0.18, 0.82, fineMagnitude[i] / fineHi);
  const face = Math.pow(smoothstep(0.50, 0.86, b) * (1 - 0.72 * fiber), 1.15);
  const recess = 1 - smoothstep(0.15, 0.46, b);
  const r = Math.max(0.72, Math.min(0.98, 0.89 - 0.16 * face + 0.075 * recess + 0.055 * fiber));
  const q = Math.round(r * 255);
  const o = i * 3;
  roughness[o] = q; roughness[o + 1] = q; roughness[o + 2] = q;
}

await sharp(normal, { raw: { width: W, height: H, channels: 3 } })
  .png()
  .toFile(`${outStem}_normal.png`);
await sharp(roughness, { raw: { width: W, height: H, channels: 3 } })
  .png()
  .toFile(`${outStem}_roughness.png`);

if (heightOut) {
  const preview = Buffer.alloc(N);
  for (let i = 0; i < N; i++) preview[i] = Math.round(height[i] * 255);
  await sharp(preview, { raw: { width: W, height: H, channels: 1 } }).png().toFile(heightOut);
}

console.log(`semantic thatch PBR: ${W}x${H}, strength ${strength}`);
console.log(`  normal    -> ${path.basename(outStem)}_normal.png`);
console.log(`  roughness -> ${path.basename(outStem)}_roughness.png`);
if (heightOut) console.log(`  height QA -> ${path.basename(heightOut)}`);
