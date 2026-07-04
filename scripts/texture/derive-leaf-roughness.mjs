// Leaf roughness with real SHINE: a broadleaf's adaxial (top) surface is a waxy,
// glossy cuticle across the blade, while the veins/midrib and the leaf margin read
// matte. Engine specular highlights come from LOW-roughness areas catching the sun,
// so the blade must be smooth (glossy) and the veins rough (matte).
//
// We already have a registered TRANSLUCENCY map per leaf that cleanly separates
// blade (bright — thin tissue transmits) from veins (dark — thick/opaque). That is
// exactly the blade-vs-vein mask we need, perfectly co-registered, so we drive
// roughness straight off it:  rough = matte - gloss*translucency  (bright blade →
// low roughness/glossy, dark veins → high roughness/matte). Outside the alpha: a
// neutral 0.7. Alpha comes from the albedo cutout.
//
// Usage: node scripts/texture/derive-leaf-roughness.mjs <albedo.png> <translucency.png>
//        [--gloss 0.4] [--matte 0.9]
// Writes <base sans _albedo>_roughness.png beside the albedo.

import sharp from 'sharp';
import path from 'node:path';

const args = process.argv.slice(2);
const [albedoSrc, transSrc] = args;
if (!albedoSrc || !transSrc) {
  console.error('usage: derive-leaf-roughness.mjs <albedo.png> <translucency.png> [--gloss N] [--matte N]');
  process.exit(2);
}
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? +args[i + 1] : d; };
const gloss = argVal('--gloss', 0.40); // roughness of the shiniest blade (lower = shinier)
const matte = argVal('--matte', 0.90); // roughness of the mattest veins/margin

const base = albedoSrc.replace(/(_albedo)?\.png$/i, '');
const out = `${base}_roughness.png`;

const { data: a, info } = await sharp(albedoSrc).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;
// translucency, resized to match, single channel
const t = await sharp(transSrc).ensureAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer();
const tC = t.length / (W * H); // channel count of the resized translucency buffer

const rough = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) {
  if (a[i * C + 3] < 16) { rough[i] = 178; continue; } // outside leaf → neutral 0.7
  const trans = t[i * tC] / 255;                        // blade ~high, veins ~low
  // bright blade → gloss (low roughness), dark veins → matte (high roughness)
  const r = matte - (matte - gloss) * trans;
  rough[i] = Math.round(Math.max(0, Math.min(1, r)) * 255);
}
await sharp(rough, { raw: { width: W, height: H, channels: 1 } }).png().toFile(out);
console.log(`leaf roughness -> ${path.basename(out)}  (gloss ${gloss} blade / matte ${matte} veins)`);
