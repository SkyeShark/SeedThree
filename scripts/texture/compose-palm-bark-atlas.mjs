// Compose a PALM BARK ATLAS: the seamless trunk tile plus colour STRIPS for the
// crown's tube geometry, in ONE bark-slot texture set (albedo / normal /
// roughness). The palm keeps two materials (bark + leaves), so everything in the
// bark slot that is not trunk — the live rachis, the fruit-stalk peduncle — gets
// its own region of the bark image instead of a material of its own
// (docs/frond-builder.md §6).
//
// Layout (W × H, default 2048 × 1024; u = x / W, v up from the image bottom):
//
//   [0, R)          the trunk region: `--tiles` periodic copies of the tile,
//                   resampled to fit (R = regionU · W). The trunk maps ONE
//                   revolution to u ∈ [0, regionU] (dichotomous.js `barkAtlas`),
//                   so the trunk never samples the strips.
//   [R, R+G)        gutter: continuation of the region's LEFT edge (so the
//                   region's right end stays seamless under filtering)
//   [R+G, R+G+S)    live RACHIS strip — u around the tube, v along the frond
//                   (base pale cream → yellow-green → green tip; underside paler)
//   [R+G+S, W-G)    PEDUNCLE strip — the date-bunch stalk (pale yellow at the
//                   crown → orange-yellow along its arch)
//   [W-G, W)        gutter: continuation of the region's RIGHT edge (so u = 0,
//                   which wraps to the image's right edge, stays seamless)
//
// Usage:
//   node scripts/texture/compose-palm-bark-atlas.mjs \
//     --tile assets/bark/source/date_palm_tile --out assets/bark/date_palm \
//     [--width 2048] [--height 1024] [--tiles 2] [--strip 96] [--gutter 32]
// Reads <tile>_albedo.png / _normal.png / _roughness.png (square seamless tile),
// writes <out>_albedo.png / _normal.png / _roughness.png, and prints the preset
// values (species `params.barkAtlas` + `foliage.rachisUV / peduncleUV /
// deadRachisUV`) as JSON.

import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const tile = opt('--tile'), out = opt('--out');
if (!tile || !out) {
  console.error('usage: compose-palm-bark-atlas.mjs --tile <prefix> --out <prefix> [--width 2048] [--height 1024] [--tiles 2] [--strip 96] [--gutter 32]');
  process.exit(2);
}
const W = +opt('--width', 2048), H = +opt('--height', 1024);
const TILES = +opt('--tiles', 2), S = +opt('--strip', 96), G = +opt('--gutter', 32);
const R = W - 2 * G - 2 * S;            // trunk region width (px)
if (R % TILES) throw new Error(`region width ${R} not divisible by --tiles ${TILES}`);
const CW = R / TILES;                   // one tile copy (px)
const INSET = 2;                        // px inset of the strip UV rects (bilinear / mip headroom)

// Deterministic hash noise.
let seed = 1337;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
// Periodic-in-u streak field (fibres run along the tube → vary across u only,
// slowly modulated along v). Periodic so the tube seam (u 0 ≡ 1) is invisible.
function streakField(n) {
  const waves = [];
  for (let i = 0; i < n; i++) waves.push({ k: 2 + Math.floor(rand() * 44), ph: rand() * Math.PI * 2, a: 0.3 + rand(), kv: rand() * 3, pv: rand() * 6.28 });
  const norm = waves.reduce((s, w) => s + w.a, 0);
  return (u, t) => {
    let h = 0;
    for (const w of waves) h += w.a * Math.sin(2 * Math.PI * w.k * u + w.ph + 0.8 * Math.sin(w.kv * t * 6.28 + w.pv));
    return h / norm; // ~[-1, 1], mostly ±0.35
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function ramp(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) return mix3(stops[i - 1][1], stops[i][1], smooth(stops[i - 1][0], stops[i][0], t));
  }
  return stops[stops.length - 1][1];
}

// One strip → { albedo, normal, rough } raw RGB buffers (S × H).
// t = along the tube from its base (v = 0, image bottom) to its tip.
// u = around the tube (tube vertex j/sides): sin(2πu) > 0 is the ADAXIAL (upper,
// N-facing) side of a frond; the underside (sin < 0) is what the park-bench view
// sees — paler and yellower on a real date palm.
function makeStrip({ stops, under, top, streakAmp, rough, roughVar, grooves }) {
  const albedo = Buffer.alloc(S * H * 3), normal = Buffer.alloc(S * H * 3), rgh = Buffer.alloc(S * H * 3);
  const f = streakField(28), fine = streakField(40);
  for (let y = 0; y < H; y++) {
    const t = 1 - (y + 0.5) / H;
    const base = ramp(stops, t);
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const side = Math.sin(2 * Math.PI * u);              // +1 top, −1 underside
      const k = 0.5 + 0.5 * side;
      const tone = mix3(under, top, k);                    // per-channel multipliers
      const st = f(u, t) * streakAmp + fine(u, t * 4.0) * streakAmp * 0.5;
      const o = (y * S + x) * 3;
      for (let c = 0; c < 3; c++) albedo[o + c] = Math.max(0, Math.min(255, Math.round(base[c] * tone[c] * (1 + st))));
      // Normal from the streak height (grooves along the tube): d/du only.
      const du = 1 / S;
      const dh = (f(u + du, t) - f(u - du, t)) / (2 * du) * grooves;
      const nx = -dh, nz = 1, inv = 1 / Math.hypot(nx, nz);
      normal[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      normal[o + 1] = 128;
      normal[o + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      const r = Math.round((rough + roughVar * st) * 255);
      rgh[o] = rgh[o + 1] = rgh[o + 2] = Math.max(0, Math.min(255, r));
    }
  }
  return { albedo, normal, rough: rgh };
}

// Live rachis (reference: "Dates on date palm" — pale cream-yellow leaf base,
// yellow-green petiole, greener toward the tip where the leaflets crowd it).
const rachis = makeStrip({
  stops: [[0.0, [222, 212, 158]], [0.07, [214, 206, 140]], [0.28, [186, 190, 104]], [0.6, [156, 170, 88]], [1.0, [128, 150, 76]]],
  under: [1.06, 1.05, 1.0], top: [0.9, 0.96, 0.86], streakAmp: 0.09, rough: 0.52, roughVar: 0.2, grooves: 0.02,
});
// Peduncle (fruit stalk): pale yellow where it leaves the crown → golden
// orange-yellow along the arch.
const peduncle = makeStrip({
  stops: [[0.0, [214, 204, 128]], [0.18, [232, 190, 86]], [0.55, [230, 168, 64]], [1.0, [220, 150, 52]]],
  under: [1.03, 1.02, 1.0], top: [0.95, 0.93, 0.88], streakAmp: 0.06, rough: 0.5, roughVar: 0.15, grooves: 0.015,
});

// Trunk region: TILES periodic copies resampled to CW wide. Resample a 3-wide
// tiled strip and crop the middle copy so the resampling filter wraps around
// (the region stays exactly periodic — no seam at the copy joints or the wrap).
async function region(file) {
  const meta = await sharp(file).metadata();
  const src = await sharp(file).removeAlpha().raw().toBuffer();
  const tw = meta.width, th = meta.height;
  const tripled = Buffer.alloc(tw * 3 * th * 3);
  for (let y = 0; y < th; y++) for (let k = 0; k < 3; k++) src.copy(tripled, (y * tw * 3 + k * tw) * 3, y * tw * 3, (y + 1) * tw * 3);
  const copy = await sharp(tripled, { raw: { width: tw * 3, height: th, channels: 3 } })
    .resize(CW * 3, H, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left: CW, top: 0, width: CW, height: H }).raw().toBuffer();
  const reg = Buffer.alloc(R * H * 3);
  for (let y = 0; y < H; y++) for (let k = 0; k < TILES; k++) copy.copy(reg, (y * R + k * CW) * 3, y * CW * 3, (y + 1) * CW * 3);
  return reg;
}

function assemble(reg, stripA, stripB) {
  const img = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const row = y * W * 3;
    reg.copy(img, row, y * R * 3, (y + 1) * R * 3);                                  // region
    reg.copy(img, row + R * 3, y * R * 3, (y * R + G) * 3);                          // right gutter = region start
    stripA.copy(img, row + (R + G) * 3, y * S * 3, (y + 1) * S * 3);                 // rachis
    stripB.copy(img, row + (R + G + S) * 3, y * S * 3, (y + 1) * S * 3);             // peduncle
    reg.copy(img, row + (W - G) * 3, ((y + 1) * R - G) * 3, (y + 1) * R * 3);        // wrap gutter = region end
  }
  return sharp(img, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 });
}

for (const [map, key] of [['albedo', 'albedo'], ['normal', 'normal'], ['roughness', 'rough']]) {
  const reg = await region(`${tile}_${map}.png`);
  await assemble(reg, rachis[key], peduncle[key]).toFile(`${out}_${map}.png`);
  console.error(`[bark-atlas] ${out}_${map}.png ${W}x${H}`);
}

const r5 = (x) => +x.toFixed(5);
const rect = (x0, x1) => [r5((x0 + INSET) / W), r5(INSET / H), r5((x1 - INSET) / W), r5(1 - INSET / H)];
// Dead fronds keep sampling a pale boot-face patch of the trunk tile (brightest
// low-variance window of the date palm source tile, at u 0.9609..1, v
// 0.3516..0.3906) — now inside the first tile copy.
const deadTile = [0.9609, 0.3516, 1.0, 0.3906];
const regionU = R / W;
console.log(JSON.stringify({
  barkAtlas: { regionU: r5(regionU), tilesAround: TILES, tileAspect: r5(H / CW) },
  rachisUV: rect(R + G, R + G + S),
  peduncleUV: rect(R + G + S, W - G),
  deadRachisUV: [r5(deadTile[0] * CW / W), deadTile[1], r5((deadTile[2] * CW - INSET) / W), deadTile[3]],
}));
