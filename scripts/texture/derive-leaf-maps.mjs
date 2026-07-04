// THE leaf map pipeline (user-approved 2026-07-02):
//   Codex generates: de-lit ALBEDO + semantic HEIGHT map (bright=raised tissue,
//   dark=vein grooves). This script derives everything else from that pair, so
//   all maps stay physically coherent with one another:
//
//   normal        Sobel on the true height field (the one place Sobel is right)
//   roughness     veins (low height) rougher, waxy puffed tissue smoother
//   translucency  thin bright tissue transmits, dense dark veins block
//
// Usage: node scripts/texture/derive-leaf-maps.mjs <albedo.png> <height.png>
//        [--strength 6] [--blur 1.5]
// Writes <leafbase>_normal.png, _roughness.png, _translucency.png beside the albedo.

import sharp from 'sharp';
import path from 'node:path';

const args = process.argv.slice(2);
const [albedoSrc, heightSrc] = args;
if (!albedoSrc || !heightSrc) {
  console.error('usage: derive-leaf-maps.mjs <albedo.png> <height.png> [--strength N] [--blur N]');
  process.exit(2);
}
const argVal = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? +args[i + 1] : dflt; };
const strength = argVal('--strength', 6);
const blur = argVal('--blur', 1.5);

const base = albedoSrc.replace(/\.png$/i, '');
const { data: aData, info } = await sharp(albedoSrc).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;

let hPipe = sharp(heightSrc).greyscale().resize(W, H);
if (blur > 0) hPipe = hPipe.blur(blur); // keep tissue gradients smooth/organic
const hData = await hPipe.raw().toBuffer();

const N = W * H;
const mask = new Uint8Array(N);
for (let i = 0; i < N; i++) mask[i] = aData[i * 4 + 3] > 16 ? 1 : 0;

const clampI = (v, n) => Math.max(0, Math.min(n - 1, v));
const hAt = (x, y) => hData[clampI(y, H) * W + clampI(x, W)] / 255;

// ---- normal (OpenGL Y+) ----------------------------------------------------
const normal = Buffer.alloc(N * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    if (!mask[y * W + x]) { normal[o] = 128; normal[o + 1] = 128; normal[o + 2] = 255; continue; }
    const gx = (hAt(x + 1, y - 1) + 2 * hAt(x + 1, y) + hAt(x + 1, y + 1))
             - (hAt(x - 1, y - 1) + 2 * hAt(x - 1, y) + hAt(x - 1, y + 1));
    const gy = (hAt(x - 1, y + 1) + 2 * hAt(x, y + 1) + hAt(x + 1, y + 1))
             - (hAt(x - 1, y - 1) + 2 * hAt(x, y - 1) + hAt(x + 1, y - 1));
    let nx = -gx * strength, ny = gy * strength, nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz);
    normal[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
    normal[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
    normal[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
  }
}

// ---- roughness + translucency from the same height field -------------------
const rough = Buffer.alloc(N);
const trans = Buffer.alloc(N);
for (let i = 0; i < N; i++) {
  if (!mask[i]) { rough[i] = 178; trans[i] = 0; continue; }
  const h = hData[i] / 255;
  // veins (low h) matte ~0.82; waxy puffed tissue smoother ~0.55
  rough[i] = Math.round(255 * Math.max(0.2, Math.min(1, 0.82 - 0.27 * h)));
  // veins block light; thin tissue glows. Gamma < 1 lifts the tissue mids so
  // backlit leaves read bright (matches the look of the hand-painted reference).
  const t = Math.pow(Math.max(0, (h - 0.12) / 0.88), 0.85);
  trans[i] = Math.round(255 * Math.min(1, 0.06 + 0.92 * t));
}

await sharp(normal, { raw: { width: W, height: H, channels: 3 } }).png().toFile(`${base}_normal.png`);
await sharp(rough, { raw: { width: W, height: H, channels: 1 } }).png().toFile(`${base}_roughness.png`);
await sharp(trans, { raw: { width: W, height: H, channels: 1 } }).png().toFile(`${base}_translucency.png`);

console.log(`leaf maps from ${path.basename(heightSrc)} (strength ${strength}, blur ${blur}):`);
console.log(`  -> ${path.basename(base)}_normal.png, _roughness.png, _translucency.png`);
