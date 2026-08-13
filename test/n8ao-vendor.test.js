import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const vendorDir = new URL('../src/vendor/n8ao/', import.meta.url);
const expectedFiles = [
  'BlueNoise.js',
  'createN8AOScenePass.js',
  'index.js',
  'LICENSE',
  'math.js',
  'N8AONode.js',
  'NOTICE.md',
  'VENDORED.md',
];

// SHA-256 of the exact local, uncommitted Eidoverse vendor at HEAD 08aa5be.
// Runtime files are normalized back to Eidoverse's pinned Deno specifiers before
// hashing, so this test permits only SeedThree's six documented import rewrites.
const eidoverseHashes = {
  'BlueNoise.js': '7eadb9c3f448cb093c26da7fd2e990e7ae07af1a795f5ead77f81c9d64c5bf99',
  'createN8AOScenePass.js': '8fbb3e98149382e5c342e2dcc4dc20fbe91b7d81a81ba342a0840b39b8121ae9',
  'index.js': 'a9130bb0e9fa724e56a0b5674c06891f39e069df0cca228712db903e6521c4fd',
  LICENSE: '62ac6e532739fa01bbd5e9c5ebdd93a61bbe42c63d2b77368678eb6e024fd243',
  'math.js': '9a122d89e35cf12a680ce7e1c98dcaa28d7f962247aa54c0b433529255ee069e',
  'N8AONode.js': 'f18d38ab93e09612e867160170b359f1f781c3c5f4be6bad6c5f4121f191daa6',
  'NOTICE.md': '9366d915518a23238ec654dda13aa4e238e8ef66ecd7df2ecd4a4bc88e32367a',
  'VENDORED.md': '0ca24d7d461de6d6233a92e6ea7f596fde9e207848546aa0644c7b0601668d95',
};

function restoreEidoverseSpecifiers(source) {
  return source
    .replaceAll('"three/webgpu"', '"npm:three@0.184.0/webgpu"')
    .replaceAll('"three/tsl"', '"npm:three@0.184.0/tsl"')
    .replaceAll('"three"', '"npm:three@0.184.0"');
}

test('vendored N8AO matches the exact local Eidoverse copy apart from imports', async () => {
  const actualFiles = (await readdir(vendorDir)).sort();
  assert.deepEqual(actualFiles, [...expectedFiles].sort());

  for (const filename of expectedFiles) {
    const bytes = await readFile(new URL(filename, vendorDir));
    const normalized = filename.endsWith('.js')
      ? Buffer.from(restoreEidoverseSpecifiers(bytes.toString('utf8')))
      : bytes;
    const hash = createHash('sha256').update(normalized).digest('hex');
    assert.equal(hash, eidoverseHashes[filename], filename);
  }
});

test('N8AO runtime imports are local and card receivers remain explicitly masked', async () => {
  for (const filename of expectedFiles.filter((name) => name.endsWith('.js'))) {
    const source = await readFile(new URL(filename, vendorDir), 'utf8');
    assert.doesNotMatch(source, /(?:npm:|jsr:|https?:)/, filename);
  }

  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const branchCards = await readFile(new URL('../src/core/branch-cards.js', import.meta.url), 'utf8');
  const impostor = await readFile(new URL('../src/core/impostor.js', import.meta.url), 'utf8');

  assert.match(main, /import\s+\{\s*N8AONode\s*\}\s+from\s+'\.\/vendor\/n8ao\/N8AONode\.js'/);
  assert.doesNotMatch(main, /GTAONode/);
  assert.match(main, /mrt\(\{\s*output,\s*normal:\s*normalView,\s*aomask:\s*float\(1\)\s*\}\)/);
  assert.match(main, /configuration\.transparencyAware\s*=\s*false/);
  assert.match(main, /autoDetectTransparency\s*=\s*false/);
  assert.match(main, /mix\(scenePassColor,\s*aoPass\.getTextureNode\(\),\s*aoMask\.r\)/);
  assert.match(branchCards, /mrt\(\{\s*output,\s*normal:\s*normalView,\s*aomask:\s*float\(0\)\s*\}\)/);
  assert.match(impostor, /mrt\(\{\s*output,\s*normal:\s*normalView,\s*aomask:\s*float\(0\)\s*\}\)/);
});
