// Colour-grade ONE rect of an atlas texture in place (RGB only; alpha untouched),
// e.g. warming a frond atlas's date bunch toward amber/yellow without
// re-composing the whole atlas (docs/frond-builder.md §6).
//
// Per pixel, in HSV: hue pulled `--pull` of the way toward `--hue` (deg),
// saturation × `--sat`, value lifted by the gamma `--gamma` (v' = v^gamma, < 1
// brightens the darks more than the lights) then × `--gain`.
//
// Usage:
//   node scripts/texture/grade-atlas-rect.mjs <atlas.png> --rect u0,v0,u1,v1 \
//     [--hue 40] [--pull 0.4] [--sat 1] [--gamma 0.75] [--gain 1] [--out other.png]
// The rect is in three.js UV convention (v up from the image bottom), exactly as
// the species preset's `foliage.atlas` stores it.

import sharp from 'sharp';

const args = process.argv.slice(2);
const file = args[0];
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
if (!file || !opt('--rect')) {
  console.error('usage: grade-atlas-rect.mjs <atlas.png> --rect u0,v0,u1,v1 [--hue 40] [--pull 0.4] [--sat 1] [--gamma 0.75] [--gain 1] [--out f.png]');
  process.exit(2);
}
const [u0, v0, u1, v1] = opt('--rect').split(',').map(Number);
const HUE = +opt('--hue', 40), PULL = +opt('--pull', 0.4), SAT = +opt('--sat', 1);
const GAMMA = +opt('--gamma', 0.75), GAIN = +opt('--gain', 1);
const out = opt('--out', file);

const hasAlpha = (await sharp(file).metadata()).hasAlpha; // keep the file's channel layout
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const x0 = Math.floor(u0 * W), x1 = Math.ceil(u1 * W);
const y0 = Math.floor((1 - v1) * H), y1 = Math.ceil((1 - v0) * H);

function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

let n = 0;
for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
  for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
    const o = (y * W + x) * 4;
    let [h, s, v] = rgb2hsv(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255);
    let dh = HUE - h; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
    h = (h + dh * PULL + 360) % 360;
    s = Math.min(1, s * SAT);
    v = Math.min(1, Math.pow(v, GAMMA) * GAIN);
    const [r, g, b] = hsv2rgb(h, s, v);
    data[o] = Math.round(r * 255); data[o + 1] = Math.round(g * 255); data[o + 2] = Math.round(b * 255);
    n++;
  }
}
let img = sharp(data, { raw: { width: W, height: H, channels: 4 } });
if (!hasAlpha) img = img.removeAlpha();
await img.png({ compressionLevel: 9 }).toFile(out === file ? `${file}.tmp.png` : out);
if (out === file) { const fs = await import('node:fs'); fs.renameSync(`${file}.tmp.png`, file); }
console.error(`[grade] ${out}: ${n} px in rect [${x0},${y0}]-[${x1},${y1}] graded (hue→${HUE}° ×${PULL}, sat ×${SAT}, v^${GAMMA} ×${GAIN})`);
