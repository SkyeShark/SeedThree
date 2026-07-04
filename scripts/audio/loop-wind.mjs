// Turn a raw generated wind clip into a SEAMLESS, subtle loop.
//
// Analysis + tooling:
//  1. ffprobe the duration.
//  2. Trim the onset/offset (Stable Audio often ramps in/out at the very edges).
//  3. Crossfade-loop via overlap-wrap: split the trimmed body into [head|tail],
//     then acrossfade the TAIL back over the HEAD. The hard wrap point then lands
//     on two originally-consecutive samples (continuous), and the crossfade hides
//     the internal seam — a true seamless loop.
//  4. loudnorm to a quiet, consistent level so the bed is subtle by default (the
//     app's Web Audio gain trims it further).
//
// Usage: node scripts/audio/loop-wind.mjs <in.mp3> <out.mp3> [crossfadeSec=3] [edgeTrimSec=0.6]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const [inArg, outArg, xfArg, edgeArg] = process.argv.slice(2);
if (!inArg || !outArg) { console.error('usage: loop-wind.mjs <in.mp3> <out.mp3> [xfade=3] [edge=0.6]'); process.exit(2); }
const inPath = path.resolve(inArg), outPath = path.resolve(outArg);
if (!fs.existsSync(inPath)) { console.error('no input:', inPath); process.exit(1); }

const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inPath]).toString().trim());
let edge = Number(edgeArg ?? 0.6);
let xf = Number(xfArg ?? 3);
const innerLen = dur - 2 * edge;
if (innerLen < 4) { console.error(`clip too short (${dur}s) to loop`); process.exit(1); }
if (xf > innerLen / 2 - 0.5) xf = Math.max(1, innerLen / 2 - 0.5);
const LF = innerLen - xf; // final loop length
const e0 = edge, e1 = dur - edge;

// Overlap-add loop: fade the HEAD in and the TAIL out (triangular), then mix them
// aligned at t=0. The wrap point (out[end]=inner[LF-e], out[0]=inner[LF]) lands on
// two originally-consecutive samples → continuous; the fades hide the seam. Robust
// where acrossfade fails (it empties when the first stream == crossfade length).
const fc = [
  `[0:a]atrim=${e0.toFixed(3)}:${e1.toFixed(3)},asetpts=N/SR/TB[inner]`,
  `[inner]asplit[m][t]`,
  // qsin = equal-power fade: the two overlapped segments are UNCORRELATED wind, so
  // linear (tri) fades would dip the loudness mid-crossfade; qsin holds it constant.
  `[m]atrim=0:${LF.toFixed(3)},asetpts=N/SR/TB,afade=t=in:st=0:d=${xf.toFixed(3)}:curve=qsin[main]`,
  `[t]atrim=${LF.toFixed(3)}:${innerLen.toFixed(3)},asetpts=N/SR/TB,afade=t=out:st=0:d=${xf.toFixed(3)}:curve=qsin[tail]`,
  `[main][tail]amix=inputs=2:normalize=0[mix]`,
  `[mix]loudnorm=I=-24:TP=-3:LRA=7[o]`,
].join(';');

// WAV out (pcm_s16le) for the wind bed: MP3/OGG bake encoder padding into the
// decoded buffer, which replays as a GAP/click every loop cycle in Web Audio.
// WAV has no padding → the AudioBufferSourceNode loop is truly seamless.
const isWav = /\.wav$/i.test(outPath);
const codec = isWav ? ['-c:a', 'pcm_s16le'] : ['-b:a', '128k'];
execFileSync('ffmpeg', ['-y', '-i', inPath, '-filter_complex', fc, '-map', '[o]', '-ac', '1', '-ar', '32000', ...codec, outPath], { stdio: 'ignore' });
const outDur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath]).toString().trim());
console.log(`[loop-wind] ${path.basename(inPath)} (${dur.toFixed(1)}s) -> ${path.basename(outPath)} seamless loop ${outDur.toFixed(1)}s, xfade ${xf.toFixed(1)}s (${Math.round(fs.statSync(outPath).size / 1024)}KB)`);
