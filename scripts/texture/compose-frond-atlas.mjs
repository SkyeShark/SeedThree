// Compose a FROND ATLAS for the pinnate frond builder (docs/frond-builder.md):
// several chroma-keyed source sheets (rows of vertical leaflets on magenta, and
// one hanging fruit bunch) are cut into their individual pieces and packed into
// ONE texture, so every foliage element of a palm (live leaflets, dead
// leaflets, fruit strands) samples a single material and the palm exports with
// two materials (bark + leaves).
//
// Leaflet sheets: pieces are found by the alpha COLUMN projection (runs of
// columns that contain opaque pixels = one vertical leaflet), then each piece is
// cropped to its own alpha bbox and fitted into a tall slot (base at the slot
// bottom, tip at the top — the frond builder maps v=0 → leaflet base).
// Bunch sheet: cropped to its alpha bbox and fitted into the right-hand slot.
//
// Usage:
//   node scripts/texture/compose-frond-atlas.mjs <out_albedo.png> \
//     --live key_leaflets.png --dead key_dead.png --bunch key_dates.png \
//     [--size 2048] [--slot 96] [--json rects.json] [--live-tint 0.8,0.84,0.76]
// Prints (and optionally writes) the UV rects as JSON in three.js UV convention
// (u right, v UP from the image bottom): { live: [[u0,v0,u1,v1],…], dead: […], bunch: [u0,v0,u1,v1] }.
// Paste them into the species preset's `frond.atlas`.

import sharp from 'sharp';
import fs from 'node:fs';

const args = process.argv.slice(2);
const out = args[0];
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
if (!out || !opt('--live')) {
  console.error('usage: compose-frond-atlas.mjs <out.png> --live a.png [--dead b.png] [--bunch c.png] [--size 2048] [--slot 96]');
  process.exit(2);
}
const SIZE = +opt('--size', 2048);
const SLOT = +opt('--slot', 96);
const MARGIN = 6; // px of transparent padding per slot (mip/dilate headroom)

async function rgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

// Vertical pieces by alpha column projection.
function columnPieces(img, minWidth = 8) {
  const { data, W, H } = img;
  const colOn = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = 0; y < H; y++) if (data[(y * W + x) * 4 + 3] > 128) n++;
    colOn[x] = n > H * 0.05 ? 1 : 0;
  }
  const runs = [];
  for (let x = 0; x < W;) {
    if (!colOn[x]) { x++; continue; }
    let e = x; while (e < W && colOn[e]) e++;
    if (e - x >= minWidth) runs.push([Math.max(0, x - 3), Math.min(W, e + 3)]);
    x = e;
  }
  return runs.map(([x0, x1]) => bbox(img, x0, 0, x1, H));
}

function bbox(img, x0, y0, x1, y1) {
  const { data, W } = img;
  let minX = x1, minY = y1, maxX = x0, maxY = y0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (data[(y * W + x) * 4 + 3] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// Fit a crop into a slot rect (px, top-left origin), aspect preserved; for a
// leaflet the piece is stretched to the full slot HEIGHT (width follows) so the
// base/tip land exactly at the rect ends the builder maps to the rachis.
async function placePiece(file, crop, slot, composites, fillHeight, tint = null) {
  const innerW = slot.w - 2 * MARGIN, innerH = slot.h - 2 * MARGIN;
  let w, h;
  if (fillHeight) { h = innerH; w = Math.min(innerW, Math.max(1, Math.round(crop.width * (innerH / crop.height)))); }
  else {
    const s = Math.min(innerW / crop.width, innerH / crop.height);
    w = Math.max(1, Math.round(crop.width * s)); h = Math.max(1, Math.round(crop.height * s));
  }
  // Optional per-piece colour grade (sRGB multiply) — bakes a species tint into
  // the TEXTURE so engines (which never see the app's material tint) match.
  let img = sharp(file).extract(crop).resize(w, h, { fit: 'fill' });
  if (tint) img = sharp(await img.png().toBuffer()).linear([...tint, 1], [0, 0, 0, 0]);
  const buf = await img.png().toBuffer();
  const left = slot.x + Math.round((slot.w - w) / 2);
  const top = slot.y + (fillHeight ? MARGIN : Math.round((slot.h - h) / 2));
  composites.push({ input: buf, left, top });
  // UV rect of the placed piece (three.js convention: v up from the bottom).
  return [left / SIZE, 1 - (top + h) / SIZE, (left + w) / SIZE, 1 - top / SIZE].map((v) => +v.toFixed(5));
}

const composites = [];
const rects = { live: [], dead: [], bunch: null };
let x = 0;
for (const [kind, file] of [['live', opt('--live')], ['dead', opt('--dead')]]) {
  if (!file) continue;
  const img = await rgba(file);
  const pieces = columnPieces(img);
  for (const crop of pieces) {
    if (x + SLOT > SIZE - (opt('--bunch') ? SIZE / 4 : 0)) { console.warn(`[atlas] out of slot room — dropping extra ${kind} pieces`); break; }
    const tint = kind === 'live' && opt('--live-tint') ? opt('--live-tint').split(',').map(Number) : null;
    rects[kind].push(await placePiece(file, crop, { x, y: 0, w: SLOT, h: SIZE }, composites, true, tint));
    x += SLOT;
  }
}
if (opt('--bunch')) {
  const file = opt('--bunch');
  const img = await rgba(file);
  const crop = bbox(img, 0, 0, img.W, img.H);
  const slot = { x: SIZE - SIZE / 4, y: 0, w: SIZE / 4, h: SIZE / 2 };
  rects.bunch = await placePiece(file, crop, slot, composites, false);
}

await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(composites).png().toFile(out);
const json = JSON.stringify(rects);
if (opt('--json')) fs.writeFileSync(opt('--json'), json);
console.log(json);
console.error(`[atlas] ${out}: ${rects.live.length} live, ${rects.dead.length} dead leaflets${rects.bunch ? ', 1 bunch' : ''}`);
