// Derive a leaf TRANSLUCENCY map from a leaf cutout (albedo with alpha).
//
// Physically, the whole thin blade transmits light when backlit and the VEINS
// block it. The map reads the leaf's own texture that way: tissue transmits
// (--tissue), veins — bright ridges in the albedo, found by a band-limited
// high-pass — go dark (--vein), and everything under the alphaTest cut is black.
// Derived from the albedo itself, so it lines up with the leaf by construction:
// re-derive it whenever the albedo changes.
//
// Output: grayscale where WHITE = transmits, BLACK = opaque (veins / cut-out
// background), written as <stem>_translucency.png next to the input — a trailing
// `_albedo` is dropped (as derive-pbr.mjs does), so it replaces the live map.
//
// Usage: node scripts/texture/derive-translucency.mjs <leaf_albedo.png> [--tissue 0.85] [--vein 6]

import sharp from 'sharp';

const args = process.argv.slice(2);
const input = args[0];
if (!input) { console.error('usage: derive-translucency.mjs <leaf.png>'); process.exit(2); }
const ti = args.indexOf('--tissue'); const tissue = ti >= 0 ? +args[ti + 1] : 0.85;   // transmission of leaf tissue between veins
const vgi = args.indexOf('--vein'); const veinGain = vgi >= 0 ? +args[vgi + 1] : 6.0;  // how strongly veins are darkened (opaque)
const out = `${input.replace(/(_albedo)?\.png$/i, '')}_translucency.png`;

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
// sharp hands a blurred 1-channel raw image back as 3-channel sRGB: take one
// channel back, or the per-pixel reads below stride into the wrong pixels (a
// vertically squashed, scanlined vein field that doesn't line up with the leaf).
const lumMed = await sharp(Buffer.from(lum), raw1).blur(2).extractChannel(0).raw().toBuffer();
const lumBig = await sharp(Buffer.from(lum), raw1).blur(12).extractChannel(0).raw().toBuffer();

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
