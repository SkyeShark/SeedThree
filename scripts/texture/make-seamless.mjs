// Force an image tileable by mirror-blending a thin margin at each edge so the
// outermost rows/cols on opposite sides converge to equal values. Only the edge
// bands change; interior features are untouched (safe here — the saguaro areole
// dots sit on interior rib crests, the tile edges are grooves).
// Usage: node scripts/texture/make-seamless.mjs <in> <out> [--h 40] [--v 22] [--size 1024]
import sharp from 'sharp';
const args = process.argv.slice(2);
const IN = args[0], OUT = args[1];
const gi = (f, d) => { const i = args.indexOf(f); return i >= 0 ? parseInt(args[i + 1]) : d; };
const MH = gi('--h', 40), MV = gi('--v', 22), SIZE = gi('--size', 1024);

const { data, info } = await sharp(IN).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const px = (x, y) => (y * W + x) * C;

// Horizontal: pair col x with col W-1-x, blend so col0==colW-1 at the seam.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < MH; x++) {
    const w = 0.5 * (1 - x / MH);
    const iL = px(x, y), iR = px(W - 1 - x, y);
    for (let c = 0; c < C; c++) {
      const L = data[iL + c], R = data[iR + c];
      data[iL + c] = Math.round(L * (1 - w) + R * w);
      data[iR + c] = Math.round(R * (1 - w) + L * w);
    }
  }
}
// Vertical: pair row y with row H-1-y.
for (let x = 0; x < W; x++) {
  for (let y = 0; y < MV; y++) {
    const w = 0.5 * (1 - y / MV);
    const iT = px(x, y), iB = px(x, H - 1 - y);
    for (let c = 0; c < C; c++) {
      const T = data[iT + c], B = data[iB + c];
      data[iT + c] = Math.round(T * (1 - w) + B * w);
      data[iB + c] = Math.round(B * (1 - w) + T * w);
    }
  }
}
await sharp(data, { raw: { width: W, height: H, channels: C } }).png().toFile(OUT);
console.log(`seamless → ${OUT}  (edge blend h${MH}/v${MV})`);
