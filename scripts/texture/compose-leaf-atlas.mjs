// Compose a LEAF ATLAS for Weber–Penn species whose leaf material carries more
// than one picture: the leaf/spray card plus fruit skin, flower cards, etc.,
// so every foliage element samples ONE texture (an optional alternative to a
// separate fruit material; see docs/foliage-materials.md "Leaf atlas + atlas
// fruit").
//
// Each piece goes into a slot rect (pixels, image space, top-left origin):
//   fit  — a chroma-keyed cutout: cropped to its alpha bbox (+margin), scaled to
//          fit the slot keeping its aspect, BASE AT THE SLOT BOTTOM (leaf cards
//          anchor at v=0 = image bottom). `rot180` first flips a hanging sprig
//          (authored attached at the image top) so its attachment is the base.
//   fill — an opaque swatch (fruit skin) resized to fill the slot exactly.
//   mul=r,g,b — multiply the piece's RGB (e.g. a darker calyx copy of a skin).
//
// Usage:
//   node scripts/texture/compose-leaf-atlas.mjs <out_albedo.png> --size 2048 \
//     --piece leaf=key.png@0,0,1024,2048:fit \
//     --piece skin=skin.png@1024,0,1024,1024:fill \
//     --piece calyx=skin.png@1536,1024,512,512:fill:mul=0.55,0.3,0.25 \
//     [--json rects.json]
// Prints { name: { uv: [u0,v0,u1,v1], aspect } } in three.js UV convention
// (v UP from the image bottom). `uv` is the placed CONTENT rect, so a card
// mapped to it shows the piece edge to edge; `aspect` = width/height of that
// rect (a leaf card's widthRatio).

import sharp from 'sharp';
import fs from 'node:fs';

const args = process.argv.slice(2);
const out = args[0];
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const pieces = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--piece') pieces.push(args[i + 1]);
if (!out || !pieces.length) {
  console.error('usage: compose-leaf-atlas.mjs <out.png> --size 2048 --piece name=file@x,y,w,h:fit|fill[:rot180][:mul=r,g,b] ...');
  process.exit(2);
}
const SIZE = +opt('--size', 2048);
const MARGIN = 8;

const canvas = Buffer.alloc(SIZE * SIZE * 4); // transparent
const result = {};

for (const spec of pieces) {
  const m = /^(\w+)=([^@]+)@(\d+),(\d+),(\d+),(\d+)((?::[^:]+)*)$/.exec(spec);
  if (!m) throw new Error(`bad --piece ${spec}`);
  const [, name, file, sx, sy, sw, sh, flagStr] = m;
  const [x0, y0, w, h] = [+sx, +sy, +sw, +sh];
  const flags = flagStr.split(':').filter(Boolean);
  const mode = flags.includes('fill') ? 'fill' : 'fit';
  const mulFlag = flags.find((f) => f.startsWith('mul='));
  const mul = mulFlag ? mulFlag.slice(4).split(',').map(Number) : null;

  let img = sharp(file).ensureAlpha();
  if (flags.includes('rot180')) img = img.rotate(180);
  let { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  let W = info.width, H = info.height;

  let px, pw, ph, ox, oy;
  if (mode === 'fill') {
    const r = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
      .resize(w, h, { fit: 'fill' }).raw().toBuffer();
    px = r; pw = w; ph = h; ox = x0; oy = y0;
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
  } else {
    // alpha bbox
    let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 20) {
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
    if (bx1 < 0) throw new Error(`${name}: empty alpha`);
    const cw = bx1 - bx0 + 1, ch = by1 - by0 + 1;
    const cropped = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
      .extract({ left: bx0, top: by0, width: cw, height: ch }).raw().toBuffer();
    const s = Math.min((w - 2 * MARGIN) / cw, (h - 2 * MARGIN) / ch);
    pw = Math.max(1, Math.round(cw * s)); ph = Math.max(1, Math.round(ch * s));
    px = await sharp(cropped, { raw: { width: cw, height: ch, channels: 4 } })
      .resize(pw, ph, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
    ox = x0 + Math.round((w - pw) / 2);
    oy = y0 + h - MARGIN - ph; // base at the slot bottom
  }
  if (mul) {
    for (let i = 0; i < px.length; i += 4) {
      px[i] = Math.min(255, px[i] * mul[0]); px[i + 1] = Math.min(255, px[i + 1] * mul[1]); px[i + 2] = Math.min(255, px[i + 2] * mul[2]);
    }
  }
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const s = (y * pw + x) * 4, d = ((oy + y) * SIZE + (ox + x)) * 4;
      canvas[d] = px[s]; canvas[d + 1] = px[s + 1]; canvas[d + 2] = px[s + 2]; canvas[d + 3] = px[s + 3];
    }
  }
  const r5 = (v) => +v.toFixed(5);
  // three.js UV: u right, v up from the image bottom.
  result[name] = {
    uv: [r5(ox / SIZE), r5(1 - (oy + ph) / SIZE), r5((ox + pw) / SIZE), r5(1 - oy / SIZE)],
    aspect: +(pw / ph).toFixed(4),
  };
}

await sharp(canvas, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toFile(out);
const json = JSON.stringify(result);
console.log(json);
const jp = opt('--json', null);
if (jp) fs.writeFileSync(jp, json);
