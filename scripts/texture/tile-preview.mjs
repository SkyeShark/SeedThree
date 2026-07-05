// Tile an image 2x2 (downscaled) to eyeball seam continuity at the wrap edges.
// Usage: node scripts/texture/tile-preview.mjs <img> <out.png>
import sharp from 'sharp';
const SRC = process.argv[2], OUT = process.argv[3];
const t = await sharp(SRC).resize(512, 512, { fit: 'fill' }).png().toBuffer();
const canvas = sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#000' } });
await canvas.composite([
  { input: t, left: 0, top: 0 }, { input: t, left: 512, top: 0 },
  { input: t, left: 0, top: 512 }, { input: t, left: 512, top: 512 },
]).png().toFile(OUT);
console.log('tiled 2x2 →', OUT);
