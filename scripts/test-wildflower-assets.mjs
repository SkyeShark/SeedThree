import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { DataTexture } from 'three/webgpu';
import sharp from 'sharp';
import {
  WILDFLOWER_VARIANTS,
  buildWildflowers,
  createWildflowerGeometry,
  createWildflowerMaterial,
} from '../src/core/wildflowers.js';

const assetUrl = (name) => new URL(`../assets/wildflowers/${name}`, import.meta.url);
const sourceNames = [
  'daisy-star-aster-head.png',
  'clusius-gentian-head.png',
  'grey-hawkbit-head.png',
  'bulbiferous-lily-head.png',
  'red-campion-head.png',
];

assert.equal(WILDFLOWER_VARIANTS.length, 5);
for (const name of sourceNames) {
  const metadata = await sharp(fileURLToPath(assetUrl(`source/${name}`))).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.channels, metadata.hasAlpha],
    [512, 512, 4, true], `${name} must remain a full transparent source card`);
}
const atlasMetadata = await sharp(fileURLToPath(assetUrl('gorski-kotar-wildflower-atlas.png'))).metadata();
assert.deepEqual(
  [atlasMetadata.width, atlasMetadata.height, atlasMetadata.channels, atlasMetadata.hasAlpha],
  [1280, 256, 4, true],
  'runtime atlas must contain five square RGBA cells',
);

const geometry = createWildflowerGeometry();
const flowerMask = geometry.getAttribute('flowerMask');
assert.equal([...flowerMask.array].filter((value) => value === 1).length, 20,
  'five flower heads should each be one four-vertex alpha card');
assert.equal(geometry.getAttribute('aFlowerColor'), undefined,
  'wildflowers must not retain the old vertex-tint flower fallback');

const atlas = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
atlas.needsUpdate = true;
const material = createWildflowerMaterial({ atlasTexture: atlas });
assert.equal(material.map, atlas);
assert.equal(material.alphaTest, 0.18);
assert.throws(() => createWildflowerMaterial(), /requires a botanical wildflower atlas/);

const mesh = buildWildflowers({
  atlasTexture: atlas,
  count: 50,
  seed: 'asset-test',
  sampler: { R: 75, heightAt: () => 0, rocknessAt: () => 0 },
});
assert.equal(mesh.count, 50);
const offsets = [...mesh.geometry.getAttribute('aFlowerVariant').array];
assert.ok(offsets.every((offset) => WILDFLOWER_VARIANTS.some(
  (variant) => Math.abs(variant.atlasOffset - offset) < 1e-6,
)));
assert.ok(offsets.some((offset, index) => index > 0 && offset === offsets[index - 1]),
  'scatter should form single-species colonies rather than a random confetti mix');

mesh.geometry.dispose();
mesh.material.dispose();
atlas.dispose();

console.log('SeedThree material-backed wildflower asset tests passed.');
