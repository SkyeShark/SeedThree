// Chroma-key a flat MAGENTA background to transparency for AI-generated plant
// cards (gpt-image-2 has no native alpha, so we generate on flat magenta and key
// it here). Magenta's signature is "green is much lower than red AND blue", which
// is brightness-robust — a darker/lighter magenta still keys, while grey-green /
// olive / tan plant pixels (green >= red) stay opaque. Despills the magenta
// fringe on the anti-aliased edge so no purple halo survives.
//
// Usage: node scripts/texture/chroma-key.mjs <in.png> [out.png] [--lo 60 --hi 150]
//   Overwrites in place if no out path. Writes RGBA.

import sharp from 'sharp';

const args = process.argv.slice(2);
const input = args[0];
if (!input) { console.error('usage: chroma-key.mjs <in.png> [out.png] [--lo N --hi N]'); process.exit(2); }
const out = args[1] && !args[1].startsWith('--') ? args[1] : input;
const gi = (f, d) => { const i = args.indexOf(f); return i >= 0 ? parseFloat(args[i + 1]) : d; };
const LO = gi('--lo', 60), HI = gi('--hi', 150); // keyness feather band

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const smooth = (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

let keyed = 0;
for (let i = 0; i < W * H; i++) {
  const k = i * 4;
  const r = data[k], g = data[k + 1], b = data[k + 2];
  const keyness = (r + b) / 2 - g;           // magenta ≈ 255, green plant ≤ 0
  const bgAmount = smooth(keyness, LO, HI);   // 0 = plant, 1 = pure magenta
  const a = 1 - bgAmount;
  data[k + 3] = Math.round(a * 255);
  // GLOBAL magenta despill (every pixel, not just edges): magenta is the only
  // thing here whose red AND blue sit above green, so pull both down toward green.
  // Desert foliage is green/olive/grey (green-dominant) so it's barely touched;
  // warm woody stems keep most of their red (only the excess is trimmed). This is
  // what kills the purple cast that survived the edge-only despill last time.
  if (r > g) data[k] = Math.round(g + (r - g) * 0.5);
  if (b > g) data[k + 2] = Math.round(g + (b - g) * 0.2);
  if (a < 0.5) keyed++;
}
await sharp(Buffer.from(data), { raw: { width: W, height: H, channels: 4 } }).png().toFile(out);
console.log(JSON.stringify({ out, transparentPixels: keyed, coverage: +(1 - keyed / (W * H)).toFixed(3) }));
