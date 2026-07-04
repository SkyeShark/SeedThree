// Re-key a Codex image-to-image output onto an ORIGINAL leaf's authoritative
// alpha silhouette. gpt-image-2 can't emit transparency, so it paints the leaf
// on a flat bg; we throw that bg away and paste the original cutout's alpha back,
// forcing the de-lit albedo AND the translucency map to share the exact same
// registered silhouette as the source card (so the tree's alphaTest, normals and
// SSS thickness all line up pixel-for-pixel).
//
// Usage: node scripts/texture/apply-alpha.mjs <codexOut.png> <original.png> <out.png> [--gray] [--despill]
//   --gray     collapse the Codex RGB to luminance (for grayscale maps like
//              translucency), then store it in RGB with the original alpha.
//   --despill  pull R,B toward G on magenta pixels (removes the #FF00FF bg cast
//              that can bleed into the soft alpha rim of a de-lit COLOR albedo;
//              harmless on green leaf tissue where G already dominates).

import sharp from 'sharp';

const [codexOut, original, out, ...rest] = process.argv.slice(2);
if (!codexOut || !original || !out) {
  console.error('usage: apply-alpha.mjs <codexOut.png> <original.png> <out.png> [--gray]');
  process.exit(2);
}
const gray = rest.includes('--gray');
const despill = rest.includes('--despill');

// original size + alpha are authoritative
const { data: oData, info: oInfo } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: OC } = oInfo;
const alpha = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) alpha[i] = oData[i * OC + 3];

// bring the codex output to the exact source resolution. Read with the actual
// channel count — the source may be 1-channel grayscale (transmission maps) or
// 3/4-channel color, and striding by a hard-coded 3 corrupts grayscale inputs.
let rgbPipe = sharp(codexOut).resize(W, H, { fit: 'fill' }).removeAlpha();
if (gray) rgbPipe = rgbPipe.greyscale();
const { data: rgb, info: rInfo } = await rgbPipe.raw().toBuffer({ resolveWithObject: true });
const RC = rInfo.channels;

// weld: RGB from codex, A from the original cutout
const merged = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const r0 = rgb[i * RC];
  let r = r0, g = RC >= 3 ? rgb[i * RC + 1] : r0, b = RC >= 3 ? rgb[i * RC + 2] : r0;
  if (despill) { // magenta (#FF00FF) has high R & B, low G → clamp R,B to G
    if (r > g) r = g;
    if (b > g) b = g;
  }
  merged[i * 4] = r;
  merged[i * 4 + 1] = g;
  merged[i * 4 + 2] = b;
  merged[i * 4 + 3] = alpha[i];
}
await sharp(merged, { raw: { width: W, height: H, channels: 4 } }).png().toFile(out);
console.log(`apply-alpha -> ${out.split(/[\\/]/).pop()}  (${W}x${H}, gray=${gray}, alpha from ${original.split(/[\\/]/).pop()})`);
