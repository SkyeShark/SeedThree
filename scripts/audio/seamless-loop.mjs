// Make a genuinely seamless ambient loop from a Stable-Audio clip that has an ARC
// (quiet onset -> loud swell -> fade-out). Naive edge-trim + crossfade fails: the
// clip isn't stationary, so you hear it swell and restart. So we ANALYZE and FLATTEN
// the loudness envelope in code:
//
//   1. Decode to mono f32 PCM (ffmpeg -f f32le), read samples here.
//   2. Windowed RMS envelope.
//   3. Trim the trailing fade-out + skip the onset bustle -> stationary interior.
//   4. FLATTEN: per-window gain = targetRMS / localRMS (smoothed to avoid pumping),
//      applied per-sample -> uniform loudness, no more swell/breathing.
//   5. Overlap-add EQUAL-POWER (sin/cos) crossfade of head<->tail so the wrap is
//      continuous (out[0] and out[end] are originally-consecutive samples).
//   6. Peak-normalize and write WAV (no MP3 padding -> gapless).
//
// Usage: node scripts/audio/seamless-loop.mjs <in> <out.wav> [xfade=3]
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const [inArg, outArg, xfArg] = process.argv.slice(2);
if (!inArg || !outArg) { console.error('usage: seamless-loop.mjs <in> <out.wav> [xfade=3]'); process.exit(2); }
const inPath = path.resolve(inArg), outPath = path.resolve(outArg);
const SR = 32000;

const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', inPath, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
if (dec.status !== 0) { console.error('decode failed:', dec.stderr?.toString().slice(0, 300)); process.exit(1); }
const raw = dec.stdout, N = Math.floor(raw.length / 4);
const s = new Float32Array(N);
for (let i = 0; i < N; i++) s[i] = raw.readFloatLE(i * 4);
const durTotal = N / SR;

// --- windowed RMS envelope ---
const win = 1600, hop = 800;
const env = [], tt = [];
for (let i = 0; i + win <= N; i += hop) {
  let a = 0; for (let j = i; j < i + win; j++) a += s[j] * s[j];
  env.push(Math.sqrt(a / win)); tt.push(i / SR);
}
const med = [...env].sort((a, b) => a - b)[env.length >> 1] || 1e-6;

// --- trim fade-out tail + onset bustle -> interior ---
const loud = 0.5 * med;
let last = env.length - 1; while (last > 0 && env[last] < loud) last--;
let first = 0; while (first < env.length && env[first] < loud) first++;
let tStart = Math.max(0, tt[first] + 1.2);        // clear onset
let tEnd = Math.min(durTotal, tt[last] + win / SR - 0.15); // drop fade-out
let innerLen = tEnd - tStart;
if (innerLen < 6) { tStart = durTotal * 0.12; tEnd = durTotal * 0.88; innerLen = tEnd - tStart; }

// --- FLATTEN loudness: smoothed per-window gain toward the interior median RMS ---
const iw0 = Math.floor(tStart * SR / hop), iw1 = Math.floor(tEnd * SR / hop);
const interiorEnv = env.slice(iw0, iw1);
const target = [...interiorEnv].sort((a, b) => a - b)[interiorEnv.length >> 1] || med;
const gw = env.map((e) => Math.max(0.25, Math.min(4, target / Math.max(e, 0.25 * med))));
// smooth the gain curve (~1.2s moving average) so it corrects the slow swell, not transients
const sm = Math.round(1.2 * SR / hop);
const gwS = gw.map((_, i) => { let a = 0, c = 0; for (let k = -sm; k <= sm; k++) { const j = i + k; if (j >= 0 && j < gw.length) { a += gw[j]; c++; } } return a / c; });
const gainAt = (k) => { const wf = k / hop, i0 = Math.min(gwS.length - 1, Math.floor(wf)), i1 = Math.min(gwS.length - 1, i0 + 1); const f = wf - i0; return gwS[i0] * (1 - f) + gwS[i1] * f; };

// --- extract flattened interior, overlap-add equal-power crossfade ---
let xf = Number(xfArg ?? 3); if (xf > innerLen / 2 - 0.5) xf = Math.max(1, innerLen / 2 - 0.5);
const i0 = Math.round(tStart * SR);
const innerN = Math.round(innerLen * SR), xfN = Math.round(xf * SR), LFN = innerN - xfN;
const inner = new Float32Array(innerN);
for (let k = 0; k < innerN; k++) inner[k] = s[i0 + k] * gainAt(i0 + k);
const out = new Float32Array(LFN);
for (let k = 0; k < LFN; k++) {
  if (k < xfN) { const x = (k / xfN) * (Math.PI / 2); out[k] = inner[k] * Math.sin(x) + inner[LFN + k] * Math.cos(x); }
  else out[k] = inner[k];
}
// peak-normalize with headroom
let peak = 0; for (let k = 0; k < LFN; k++) peak = Math.max(peak, Math.abs(out[k]));
const g = peak > 0 ? 0.7 / peak : 1; for (let k = 0; k < LFN; k++) out[k] *= g;

// --- verify flatness: interior RMS variance before vs after ---
const rmsVar = (arr, n) => { const w = Math.round(0.5 * SR); const r = []; for (let i = 0; i + w <= n; i += w) { let a = 0; for (let j = i; j < i + w; j++) a += arr[j] * arr[j]; r.push(Math.sqrt(a / w)); } const m = r.reduce((p, c) => p + c, 0) / r.length; return Math.sqrt(r.reduce((p, c) => p + (c - m) * (c - m), 0) / r.length) / m; };
const rawInterior = new Float32Array(innerN); for (let k = 0; k < innerN; k++) rawInterior[k] = s[i0 + k];

const spark = ' .:-=+*#%@';
console.log(`[seamless] ${path.basename(inPath)} ${durTotal.toFixed(1)}s  interior ${tStart.toFixed(2)}..${tEnd.toFixed(2)}s (${innerLen.toFixed(1)}s)  xfade ${xf.toFixed(1)}s -> loop ${(LFN / SR).toFixed(1)}s`);
console.log(`[seamless] envelope: ${env.map((v) => spark[Math.min(9, Math.round((v / (med * 2)) * 9))]).join('')}`);
console.log(`[seamless] loudness CV(RMS): raw interior ${(rmsVar(rawInterior, innerN) * 100).toFixed(0)}%  ->  flattened ${(rmsVar(out, LFN) * 100).toFixed(0)}%  (lower = steadier)`);

// --- write 16-bit WAV ---
const buf = Buffer.alloc(44 + LFN * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + LFN * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(LFN * 2, 40);
for (let k = 0; k < LFN; k++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[k] * 32767))), 44 + k * 2);
fs.writeFileSync(outPath, buf);
console.log(`[seamless] -> ${path.basename(outPath)} ${(LFN / SR).toFixed(1)}s (${Math.round(buf.length / 1024)}KB)`);
