// Headless stats snapshot for regression diffs: every species × seeds 1..3 →
// JSON of generate().stats (summary + perLod + bounds). Usage:
//   node scripts/reference/snapshot-stats.mjs out.json [speciesKey ...]
import { writeFileSync } from 'node:fs';
import { generate } from '../../src/api/seedthree.js';
import { SPECIES } from '../../src/species/index.js';

const [out, ...only] = process.argv.slice(2);
if (!out) { console.error('usage: snapshot-stats.mjs out.json [species...]'); process.exit(2); }
const keys = only.length ? only : Object.keys(SPECIES);
const res = {};
for (const key of keys) {
  for (const seed of [1, 2, 3]) {
    const { stats } = generate({ species: key, seed });
    res[`${key}:${seed}`] = stats;
  }
  console.log(key);
}
writeFileSync(out, JSON.stringify(res, null, 1));
