import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'src/vendor/n8ao');
const files = [
  'createN8AOScenePass.js',
  'math.js',
  'N8AONode.js',
];
const rewrites = [
  ['npm:three@0.184.0/webgpu', 'three/webgpu'],
  ['npm:three@0.184.0/tsl', 'three/tsl'],
  ['npm:three@0.184.0', 'three'],
];

for (const name of files) {
  const path = resolve(root, name);
  const source = await readFile(path, 'utf8');
  let adapted = source;
  let changes = 0;
  for (const [from, to] of rewrites) {
    const count = adapted.split(from).length - 1;
    changes += count;
    adapted = adapted.replaceAll(from, to);
  }
  if (changes === 0) throw new Error(`${name}: no pinned Three.js imports found`);
  if (/from\s+["'](?:npm:|jsr:|https?:)/.test(adapted)) {
    throw new Error(`${name}: unsupported remote import remains`);
  }
  await writeFile(path, adapted, 'utf8');
  console.log(`${name}: ${changes} import${changes === 1 ? '' : 's'} adapted`);
}
