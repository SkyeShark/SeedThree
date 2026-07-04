// Harvest generated image(s) from the newest Codex session log into asset files.
//
// Codex's $imagegen puts the base64 PNG into its session jsonl but often can't
// save it to the workspace itself (sandbox escalation denials → it wanders). So
// we let Codex just GENERATE, then extract the bytes here. Never prints the
// base64 — only a small summary — so it doesn't blow the caller's token budget.
//
// Usage:
//   node scripts/texture/harvest-codex-image.mjs <out1.png> [out2.png ...]
//     Extracts the LAST N generated images (in generation order) to the given
//     paths. With one path, takes the single most recent image.
//   node scripts/texture/harvest-codex-image.mjs --list
//     Just report how many images the newest session produced.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sessRoot = path.join(os.homedir(), '.codex', 'sessions');

// newest session file; if `match` is given, only sessions whose prompt (near the
// top of the jsonl) contains that keyword — lets parallel Codex jobs be harvested
// individually without colliding on "newest".
function newestSession(match = null) {
  let best = null, bestT = -1;
  const kw = match ? match.toLowerCase() : null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const t = fs.statSync(full).mtimeMs;
        if (t <= bestT) continue;
        if (kw) {
          // read the head (prompt/meta live at the top; body is huge base64).
          // Codex prepends a large system-prompt block AND, for image-to-image
          // jobs, inlines the ~1.5MB base64 of each `-i` input image ahead of the
          // user text — so scan a generous 4MB to be sure the keyword is included.
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(4194304);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          if (!buf.slice(0, n).toString('utf8').toLowerCase().includes(kw)) continue;
        }
        bestT = t; best = full;
      }
    }
  };
  if (!fs.existsSync(sessRoot)) return null;
  walk(sessRoot);
  return best;
}

function imagesFrom(sessionFile) {
  // Return distinct generated images in order. De-dupe by result length+prefix
  // (the _call and _end records repeat the same bytes).
  const out = [];
  const seen = new Set();
  for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload;
    if (!p) continue;
    if ((p.type === 'image_generation_call' || p.type === 'image_generation_end')
        && typeof p.result === 'string' && p.result.length > 5000) {
      const key = p.result.length + ':' + p.result.slice(0, 32);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p.result);
    }
  }
  return out;
}

const args = process.argv.slice(2);
let match = null;
const mi = args.indexOf('--match');
if (mi >= 0) { match = args[mi + 1]; args.splice(mi, 2); }
const sess = newestSession(match);
if (!sess) { console.error(`no codex session found${match ? ` matching "${match}"` : ''}`); process.exit(2); }
const imgs = imagesFrom(sess);

if (args[0] === '--list' || args.length === 0) {
  console.log(JSON.stringify({ session: path.basename(sess), images: imgs.length }));
  process.exit(0);
}

const outs = args;
if (imgs.length < outs.length) {
  console.error(`only ${imgs.length} image(s) in session, need ${outs.length}`);
  process.exit(1);
}
// take the LAST outs.length images, in order
const chosen = imgs.slice(imgs.length - outs.length);
const report = [];
for (let i = 0; i < outs.length; i++) {
  const b64 = chosen[i].replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  fs.writeFileSync(outs[i], buf);
  report.push({ out: outs[i], bytes: buf.length, isPng });
}
console.log(JSON.stringify({ session: path.basename(sess), saved: report }, null, 1));
