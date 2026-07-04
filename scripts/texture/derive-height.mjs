// derive-height.mjs — height map from a tangent-space normal map by Poisson
// integration in the frequency domain (the principled inverse of "normal from
// height"; a luminance guess would put height where the PAINT is dark, not
// where the surface is low).
//
//   node scripts/texture/derive-height.mjs <normal.png> [out_height.png]
//
// Method: normals give the gradient field (dh/dx = -n.x/n.z, dh/dy = -n.y/n.z
// for OpenGL-convention maps). The height whose gradient best fits it (least
// squares) solves the Poisson equation ∇²h = div(g), which is a per-frequency
// division in Fourier space. Tileable input → periodic boundary = exactly
// what the FFT assumes. Output is normalized to [8, 255] (floor keeps SPOM
// rays from degenerate full-depth wells).

import sharp from 'sharp';
import path from 'node:path';

const inPath = process.argv[2];
if (!inPath) { console.error('usage: derive-height.mjs <normal.png> [out.png]'); process.exit(1); }
const outPath = process.argv[3] ?? inPath.replace(/_normal\.png$/i, '_height.png');
if (outPath === inPath) { console.error('output would overwrite input — name it explicitly'); process.exit(1); }

// ---- radix-2 complex FFT (in-place, separable for 2D) ----------------------
function fft1d(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { // bit reversal
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function fft2d(re, im, w, h, inverse) {
  const rowR = new Float64Array(w), rowI = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    rowR.set(re.subarray(y * w, y * w + w)); rowI.set(im.subarray(y * w, y * w + w));
    fft1d(rowR, rowI, inverse);
    re.set(rowR, y * w); im.set(rowI, y * w);
  }
  const colR = new Float64Array(h), colI = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { colR[y] = re[y * w + x]; colI[y] = im[y * w + x]; }
    fft1d(colR, colI, inverse);
    for (let y = 0; y < h; y++) { re[y * w + x] = colR[y]; im[y * w + x] = colI[y]; }
  }
}

const img = sharp(inPath).ensureAlpha();
const { width: w, height: h } = await img.metadata();
if ((w & (w - 1)) || (h & (h - 1))) { console.error(`dimensions ${w}x${h} must be powers of two for the FFT`); process.exit(1); }
const raw = await img.raw().toBuffer();

// gradient field from the normal map (OpenGL convention: +Y up)
const gx = new Float64Array(w * h), gy = new Float64Array(w * h);
for (let i = 0; i < w * h; i++) {
  const nx = raw[i * 4] / 127.5 - 1, ny = raw[i * 4 + 1] / 127.5 - 1;
  const nz = Math.max(0.15, raw[i * 4 + 2] / 127.5 - 1);
  gx[i] = -nx / nz;
  gy[i] = ny / nz; // image y grows downward; OpenGL green is up
}

// Poisson solve: H(k) = (i·kx·Gx + i·ky·Gy) / -(kx² + ky²)
const gxI = new Float64Array(w * h), gyI = new Float64Array(w * h);
fft2d(gx, gxI, w, h, false);
fft2d(gy, gyI, w, h, false);
const hr = new Float64Array(w * h), hi = new Float64Array(w * h);
for (let y = 0; y < h; y++) {
  const ky = 2 * Math.PI * (y < h / 2 ? y : y - h) / h;
  for (let x = 0; x < w; x++) {
    const kx = 2 * Math.PI * (x < w / 2 ? x : x - w) / w;
    const k2 = kx * kx + ky * ky;
    const i = y * w + x;
    if (k2 < 1e-12) { hr[i] = 0; hi[i] = 0; continue; }
    // (i·kx·Gx + i·ky·Gy) / -k²  →  real/imag shuffle of the i· product
    hr[i] = (kx * gxI[i] + ky * gyI[i]) / k2;
    hi[i] = -(kx * gx[i] + ky * gy[i]) / k2;
  }
}
fft2d(hr, hi, w, h, true);

// normalize with a small percentile clip (integration can produce outliers)
const sorted = Float64Array.from(hr).sort();
const lo = sorted[Math.floor(0.005 * sorted.length)], hiV = sorted[Math.floor(0.995 * sorted.length)];
const out = Buffer.alloc(w * h);
for (let i = 0; i < w * h; i++) {
  const t = Math.max(0, Math.min(1, (hr[i] - lo) / Math.max(1e-9, hiV - lo)));
  out[i] = 8 + Math.round(t * 247); // floor at 8: no degenerate full-depth wells
}
await sharp(out, { raw: { width: w, height: h, channels: 1 } }).png().toFile(outPath);
console.log(`height -> ${path.basename(outPath)}  (${w}x${h}, Poisson-integrated from ${path.basename(inPath)})`);
