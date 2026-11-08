// Round-trip check, JS side: load preset JSON files written by the Blender
// add-on (api.save_preset), open them with the web app's own fromPreset, grow
// them with the JS generator, and print the stats as JSON for
// test_preset_roundtrip.py to compare with the Python build of the same preset.
//
//   node blender/tests/preset_roundtrip.mjs <preset.json> [...]

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsRoot = process.env.SEEDTHREE_JS || path.resolve(here, '../../../SeedThree');
const api = await import(pathToFileURL(path.join(jsRoot, 'src/api/seedthree.js')).href);

const out = {};
for (const f of process.argv.slice(2)) {
  const preset = JSON.parse(fs.readFileSync(f, 'utf8'));
  const { species, seed, controls } = api.fromPreset(preset);
  const g = api.generate({ species, seed, controls });
  // the app's Save writes exactly { format, species, controls }: re-serialize
  // to show the file survives a JS load/save cycle unchanged
  const again = api.toPreset({ species, seed, controls });
  out[path.basename(f)] = {
    stats: g.stats.summary, perLod: g.stats.perLod.map((l) => l.triangles),
    resaved: again,
  };
}
console.log(JSON.stringify(out));
