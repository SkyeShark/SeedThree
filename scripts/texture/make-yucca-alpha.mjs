// make-yucca-alpha.mjs — add a frayed-strand alpha channel to the yucca leaf
// atlas so each spike reads as a stiff blade fraying to fibrous hair at the
// tip (living AND dead halves). V (rows) = along the leaf: base→tip. U
// (cols) = across the blade width within each atlas half.
//
//   node scripts/texture/make-yucca-alpha.mjs assets/leaves/yucca_leaf_albedo.png
//
// Alpha model (tileable in U is NOT needed — a spike is one blade):
//   - across-width: opaque core, edges taper off (a blade, not a rectangle)
//   - along-length: fully opaque near the base, the top ~35% frays — each
//     vertical fiber strand cuts off at its own hashed height, so the tip
//     becomes separated hairs instead of a clean edge.

import sharp from 'sharp';

const inPath = process.argv[2] ?? 'assets/leaves/yucca_leaf_albedo.png';
const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;

// hash → per-column strand cutoff, coherent in bands so fibers clump
function hash(n) { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); }

for (let y = 0; y < H; y++) {
  const v = y / (H - 1);                 // 0 base … 1 tip
  for (let x = 0; x < W; x++) {
    // atlas has two halves (living | dead); width coord within the half
    const half = x < W / 2 ? 0 : 1;
    const u = (x - half * (W / 2)) / (W / 2 - 1); // 0..1 across this blade
    // blade cross-profile: opaque middle, soft margins
    const edge = Math.min(u, 1 - u) * 2;          // 0 at edges → 1 center
    let a = Math.min(1, edge / 0.28);             // full opaque past ~14% in
    // frayed tip: each fiber column dies at its own height in the top 35%
    const strand = hash(Math.floor(x * 0.7) + half * 991);
    const fray = 0.65 + 0.35 * strand;            // this strand's cutoff height
    if (v > fray) a *= Math.max(0, 1 - (v - fray) / (1 - fray) * 1.6);
    // fine vertical gaps between fiber bundles near the tip
    if (v > 0.5 && hash(x * 2.3 + 17) > 0.93) a *= 0.15;
    const i = (y * W + x) * 4 + 3;
    data[i] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
}

await sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toFile(inPath);
console.log(`alpha written into ${inPath} (${W}x${H}, frayed-strand spike mask)`);
