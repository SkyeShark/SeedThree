// Derive a leaf TRANSLUCENCY (thickness) map from a leaf cutout's alpha.
//
// Physically, a leaf is thin at its edges (light passes through → glows when
// backlit) and thicker at the midrib/interior and along veins (blocks light).
// A blurred alpha is a cheap, perfectly co-registered proxy for "distance from
// edge": near the cutout edge the blur mixes in transparent pixels (low), deep
// in the interior it stays ~1. So (1 − blur(alpha)) is high at the thin edges.
//
// Output: grayscale where WHITE = transmits a lot (thin edges), BLACK = opaque
// (interior / veins / transparent background). Used as the SSS thickness map so
// only the leaf rim glows, not the whole card.
//
// Usage: node scripts/texture/derive-translucency.mjs <leaf.png> [--radius 22] [--body 0.28]

import sharp from 'sharp';

const args = process.argv.slice(2);
const input = args[0];
if (!input) { console.error('usage: derive-translucency.mjs <leaf.png>'); process.exit(2); }
const ti = args.indexOf('--tissue'); const tissue = ti >= 0 ? +args[ti + 1] : 0.85;   // transmission of leaf tissue between veins
const vgi = args.indexOf('--vein'); const veinGain = vgi >= 0 ? +args[vgi + 1] : 6.0;  // how strongly veins are darkened (opaque)
const out = input.replace(/\.png$/i, '_translucency.png');

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

// Explicit byte buffers (Buffer.from on a Float32Array mis-strides → scanlines).
const alpha = Buffer.alloc(W * H);
const lum = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  alpha[i] = data[i * C + 3];
  lum[i] = Math.round(0.3 * data[i * C] + 0.59 * data[i * C + 1] + 0.11 * data[i * C + 2]);
}

const raw1 = { raw: { width: W, height: H, channels: 1 } };
// Physically: the whole thin blade transmits; the VEINS are opaque. Detect veins
// as bright ridges via a band-limited high-pass (blur2 − blur12, so 1px source
// noise can't get through) and darken them strongly. Tissue stays translucent.
const lumMed = await sharp(Buffer.from(lum), raw1).blur(2).raw().toBuffer();
const lumBig = await sharp(Buffer.from(lum), raw1).blur(12).raw().toBuffer();

const outBuf = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) {
  const a = alpha[i] / 255;
  if (a < 0.35) { outBuf[i] = 0; continue; }          // cut soft edge (matches alphaTest)
  const vein = Math.min(1, Math.max(0, (lumMed[i] - lumBig[i]) / 255 * veinGain)); // bright ridge → opaque vein
  let t = tissue - vein * 0.85;                        // tissue transmits; veins go dark/opaque
  t = Math.max(0.04, Math.min(0.95, t));
  outBuf[i] = Math.round(t * 255);
}

// Light 1px smooth to antialias vein lines (not enough to blur the structure).
await sharp(outBuf, raw1).blur(1.0).png().toFile(out);
console.log(`translucency -> ${out.split(/[\\/]/).pop()}  (${W}x${H}, tissue ${tissue}, veinGain ${veinGain})`);
