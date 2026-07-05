// Derive a clean saguaro-flesh PBR set from a Codex "undamaged" albedo.
//
// The flesh is waxy cactus skin: fairly LOW, uniform roughness (not bark-rough),
// with a gentle normal that carries only the rib banding + areole dots (the big
// rib undulation is real mesh geometry, so we keep the normal subtle). Tileable
// via wrap-sampled Scharr. Writes _albedo (resized), _normal, _roughness.
//
// Usage: node scripts/texture/derive-cactus-flesh.mjs <clean_albedo_src> <out_stem> [--size 1024] [--strength 1.4]

import sharp from 'sharp';

const args = process.argv.slice(2);
const src = args[0];
const stem = args[1];
if (!src || !stem) { console.error('usage: derive-cactus-flesh.mjs <src> <out_stem> [--size N] [--strength N]'); process.exit(2); }
const gi = (f, d) => { const i = args.indexOf(f); return i >= 0 ? parseFloat(args[i + 1]) : d; };
const SIZE = gi('--size', 1024);
const STRENGTH = gi('--strength', 1.4);

// 1. ALBEDO — resize to the target tile size.
await sharp(src).resize(SIZE, SIZE, { fit: 'fill' }).png().toFile(`${stem}_albedo.png`);

// Luminance height field from the resized albedo (sRGB → linear-ish via gamma).
const { data, info } = await sharp(`${stem}_albedo.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const lum = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) {
  const r = data[i * C] / 255, g = data[i * C + 1] / 255, b = data[i * C + 2] / 255;
  lum[i] = Math.pow(0.2126 * r + 0.7152 * g + 0.0722 * b, 2.2); // approx linear
}
const wrap = (v, n) => (v % n + n) % n;
const L = (x, y) => lum[wrap(y, H) * W + wrap(x, W)];

// 2. NORMAL — Scharr gradient (5× lower angular error than Sobel), wrap-tiled,
// +Y/OpenGL for three.js. Subtle strength: the flesh is smooth, the ribs are mesh.
const normal = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const gx = (3 * L(x + 1, y - 1) + 10 * L(x + 1, y) + 3 * L(x + 1, y + 1))
             - (3 * L(x - 1, y - 1) + 10 * L(x - 1, y) + 3 * L(x - 1, y + 1));
    const gy = (3 * L(x - 1, y + 1) + 10 * L(x, y + 1) + 3 * L(x + 1, y + 1))
             - (3 * L(x - 1, y - 1) + 10 * L(x, y - 1) + 3 * L(x + 1, y - 1));
    let nx = -gx * STRENGTH, ny = -gy * STRENGTH, nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz);
    const o = (y * W + x) * 3;
    normal[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
    normal[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
    normal[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
  }
}
await sharp(normal, { raw: { width: W, height: H, channels: 3 } }).png().toFile(`${stem}_normal.png`);

// 3. ROUGHNESS — waxy: low base (~0.40), a touch rougher in the darker rib grooves
// and on the matte areole dots. Kept in a tight band so it never reads bark-rough.
const rough = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) {
  const r = 0.38 + 0.14 * (1 - lum[i]); // 0.38 (lit crest) .. ~0.52 (dark groove)
  rough[i] = Math.round(Math.max(0, Math.min(1, r)) * 255);
}
await sharp(rough, { raw: { width: W, height: H, channels: 1 } }).png().toFile(`${stem}_roughness.png`);

console.log(`clean flesh: ${stem}_albedo/_normal/_roughness.png  ${W}x${H}  (strength ${STRENGTH})`);
