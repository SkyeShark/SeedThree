// Derive a clean SPINE translucency (thickness) map from the spine cutout.
//
// Unlike a leaf (thin rim glows, thick veins block), a cactus spine is thin along
// its WHOLE length — it lights up uniformly when backlit. So the translucency is
// simply a clean, mostly-WHITE mask of the spine shape on black, with soft AA edges.
// We take the mask from the albedo's ALPHA (the true cutout) when it carries one,
// else key it off luminance (bright spines on dark background). This replaces a
// prior map that had gray mottling + a vertical banding artifact inside the spines.
//
// Usage: node scripts/texture/derive-spine-translucency.mjs <spine_albedo.png> [--lo 0.15] [--hi 0.8] [--out <path>]

import sharp from 'sharp';

const args = process.argv.slice(2);
const input = args[0];
if (!input) { console.error('usage: derive-spine-translucency.mjs <spine_albedo.png>'); process.exit(2); }
const num = (flag, d) => { const i = args.indexOf(flag); return i >= 0 ? +args[i + 1] : d; };
const lo = num('--lo', 0.15), hi = num('--hi', 0.80); // contrast window: interior → white, trim faint halo
const oi = args.indexOf('--out');
const out = oi >= 0 ? args[oi + 1]
  : /_albedo\.png$/i.test(input) ? input.replace(/_albedo\.png$/i, '_translucency.png')
  : input.replace(/\.png$/i, '_translucency.png');

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

// Does the alpha carry the cutout, or is it flat (opaque)? If flat, fall back to luminance.
let aMin = 255, aMax = 0;
for (let i = 0; i < W * H; i++) { const a = data[i * C + 3]; if (a < aMin) aMin = a; if (a > aMax) aMax = a; }
const useAlpha = (aMax - aMin) > 24;

const smooth = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const outBuf = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) {
  let m;
  if (useAlpha) m = data[i * C + 3] / 255;
  else m = (0.3 * data[i * C] + 0.59 * data[i * C + 1] + 0.11 * data[i * C + 2]) / 255; // bright spine on dark bg
  // Contrast-stretch so the spine body saturates to WHITE and only the faint edge
  // haze is trimmed — a clean uniform glow mask, no interior mottling.
  outBuf[i] = Math.round(smooth((m - lo) / (hi - lo)) * 255);
}

// 0.8px smooth only to keep the AA edge from stair-stepping (not enough to reintroduce haze).
await sharp(outBuf, { raw: { width: W, height: H, channels: 1 } }).blur(0.8).png().toFile(out);
console.log(`spine translucency -> ${out.split(/[\\/]/).pop()}  (${W}x${H}, ${useAlpha ? 'from alpha' : 'from luminance'}, window ${lo}..${hi})`);
