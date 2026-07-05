// Art-director guide image: overlay vertical guide lines on the TextureCan saguaro
// flesh marking the rib-crest columns where the areole/spine holes must land.
// The mesh locks uScale=4, uPhase=0.125 → crests at U = 0.125,0.375,0.625,0.875.
// Usage: node scripts/texture/make-flesh-guide.mjs <src_albedo> <out.png>
import sharp from 'sharp';

const SRC = process.argv[2] || 'assets/bark/saguaro_skin_albedo.png';
const OUT = process.argv[3];
if (!OUT) { console.error('usage: make-flesh-guide.mjs <src> <out.png>'); process.exit(2); }

const { data, info } = await sharp(SRC).resize(1024, 1024, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, C = info.channels;
const cols = [0.125, 0.375, 0.625, 0.875].map((f) => Math.round(f * W));
const halfWidth = 3, alpha = 0.55, MAG = [236, 64, 220];
for (let y = 0; y < H; y++) for (const cx of cols) for (let dx = -halfWidth; dx <= halfWidth; dx++) {
  const x = cx + dx; if (x < 0 || x >= W) continue;
  const i = (y * W + x) * C;
  data[i]   = Math.round(data[i]   * (1 - alpha) + MAG[0] * alpha);
  data[i+1] = Math.round(data[i+1] * (1 - alpha) + MAG[1] * alpha);
  data[i+2] = Math.round(data[i+2] * (1 - alpha) + MAG[2] * alpha);
}
await sharp(data, { raw: { width: W, height: H, channels: C } }).png().toFile(OUT);
console.log('guide →', OUT, 'lines at x=', cols.join(','));
