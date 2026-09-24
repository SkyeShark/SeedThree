// Alpha dilation / edge-padding ("solidify") for cutout textures.
//
// AI-generated cutouts store BLACK rgb in transparent texels. When sampled with
// bilinear filtering + mipmaps, that black bleeds into the opaque edges → a dark
// halo/fringe around every leaf. Fix: flood the opaque edge colours outward into
// the transparent region (RGB only; alpha is preserved so alphaTest is unchanged).
//
// Usage: node scripts/texture/dilate-alpha.mjs <cutout.png> [--passes 20] [--fill]  (overwrites in place)
// --fill: after the passes, fill EVERY still-empty texel by pull-push (the
// nearest coarser-mip average of opaque colour) — thin sprays on a big atlas
// otherwise keep black texels that bleed into the far mips (dark/navy cards).
// --fill-rect u0,v0,u1,v1 (repeatable, three.js UV, v up): AFTER the fill, every
// transparent texel inside the rect takes the mean colour of that rect's
// green-dominant opaque texels (the leaves). A sparse leaf spray on a brown
// twig otherwise mips to olive-brown at distance (the fill mixes twig, skin and
// flower colours into the leaf's far mips).

import sharp from 'sharp';

const input = process.argv[2];
if (!input) { console.error('usage: dilate-alpha.mjs <cutout.png> [--passes N]'); process.exit(2); }
const pi = process.argv.indexOf('--passes');
const passes = pi >= 0 ? +process.argv[pi + 1] : 20;

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

const rgb = new Float32Array(W * H * 3);
const alpha = new Uint8Array(W * H);
const filled = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  rgb[i * 3] = data[i * C]; rgb[i * 3 + 1] = data[i * C + 1]; rgb[i * 3 + 2] = data[i * C + 2];
  alpha[i] = data[i * C + 3];
  filled[i] = alpha[i] > 12 ? 1 : 0;   // opaque texels seed the flood
}

for (let p = 0; p < passes; p++) {
  const next = filled.slice();
  let changed = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (filled[idx]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nidx = ny * W + nx;
          if (filled[nidx]) { r += rgb[nidx * 3]; g += rgb[nidx * 3 + 1]; b += rgb[nidx * 3 + 2]; n++; }
        }
      }
      if (n > 0) { rgb[idx * 3] = r / n; rgb[idx * 3 + 1] = g / n; rgb[idx * 3 + 2] = b / n; next[idx] = 1; changed++; }
    }
  }
  filled.set(next);
  if (!changed) break;
}

if (process.argv.includes('--fill')) {
  // pull: weighted box pyramid of (colour × filled, filled)
  const levels = [];
  let lw = W, lh = H;
  let col = new Float32Array(W * H * 3), wt = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) if (filled[i]) { wt[i] = 1; col[i * 3] = rgb[i * 3]; col[i * 3 + 1] = rgb[i * 3 + 1]; col[i * 3 + 2] = rgb[i * 3 + 2]; }
  levels.push({ w: lw, h: lh, col, wt });
  while (lw > 1 || lh > 1) {
    const nw = Math.max(1, lw >> 1), nh = Math.max(1, lh >> 1);
    const nc = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const si = y * lw + x, di = Math.min(nh - 1, y >> 1) * nw + Math.min(nw - 1, x >> 1);
      nwt[di] += wt[si]; nc[di * 3] += col[si * 3]; nc[di * 3 + 1] += col[si * 3 + 1]; nc[di * 3 + 2] += col[si * 3 + 2];
    }
    levels.push({ w: nw, h: nh, col: nc, wt: nwt });
    lw = nw; lh = nh; col = nc; wt = nwt;
  }
  // push: each empty texel takes the finest level that has coverage there
  let filledN = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (filled[i]) continue;
    for (let l = 1; l < levels.length; l++) {
      const L = levels[l];
      const lx = Math.min(L.w - 1, x >> l), ly = Math.min(L.h - 1, y >> l), li = ly * L.w + lx;
      if (L.wt[li] > 0) { rgb[i * 3] = L.col[li * 3] / L.wt[li]; rgb[i * 3 + 1] = L.col[li * 3 + 1] / L.wt[li]; rgb[i * 3 + 2] = L.col[li * 3 + 2] / L.wt[li]; filledN++; break; }
    }
  }
  console.log(`pull-push filled ${filledN} texels`);
}

for (let ai = 0; ai < process.argv.length; ai++) {
  if (process.argv[ai] !== '--fill-rect') continue;
  const [u0, v0, u1, v1] = process.argv[ai + 1].split(',').map(Number);
  const x0 = Math.round(u0 * W), x1 = Math.round(u1 * W), y0 = Math.round((1 - v1) * H), y1 = Math.round((1 - v0) * H);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    if (alpha[i] > 128 && rgb[i * 3 + 1] >= rgb[i * 3] && rgb[i * 3 + 1] >= rgb[i * 3 + 2] * 0.9) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; n++; }
  }
  if (!n) continue;
  r /= n; g /= n; b /= n;
  let k = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    if (alpha[i] < 8) { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; k++; }
  }
  console.log(`fill-rect ${process.argv[ai + 1]}: ${k} texels ← leaf mean (${r | 0},${g | 0},${b | 0})`);
}

const out = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1]; out[i * 4 + 2] = rgb[i * 3 + 2];
  out[i * 4 + 3] = alpha[i]; // original alpha preserved
}
await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toFile(input);
console.log(`dilated (${passes} passes) -> ${input.split(/[\\/]/).pop()}  ${W}x${H}`);
