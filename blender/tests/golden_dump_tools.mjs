// Golden outputs of the app's scripts/ (texture + audio) for test_tools.py: every
// script runs, as the app runs it, on small inputs made here from the real assets.
//
//   node blender/tests/golden_dump_tools.mjs [outDir]
//
// Inputs (256 px, made with sharp from assets/) land in <outDir>/inputs; each script
// gets its own copy under <outDir>/js/<script>/ and writes beside it, exactly as in the
// app. Nothing is written into the JS checkout. gen-wind cannot reach a ComfyUI here:
// its node graph is evaluated from the script's own source with the same arguments.

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsRoot = process.env.SEEDTHREE_JS || path.resolve(here, '../../../SeedThree');
const outDir = path.resolve(process.argv[2] || path.join(here, 'out', 'golden_tools'));
const require = createRequire(path.join(jsRoot, 'package.json'));
const sharp = require('sharp');
const A = (p) => path.join(jsRoot, 'assets', p);
const inputs = path.join(outDir, 'inputs');
fs.rmSync(path.join(outDir, 'js'), { recursive: true, force: true });
fs.mkdirSync(inputs, { recursive: true });

const small = async (src, name, size = 256) => {
  const out = path.join(inputs, name);
  await sharp(A(src)).resize(size, size, { fit: 'fill' }).png().toFile(out);
  return out;
};
await small('bark/white_oak_albedo.png', 'oak_bark_albedo.png');
await small('leaves/red_maple_single_albedo.png', 'maple_leaf_albedo.png');
await small('leaves/red_maple_single_translucency.png', 'maple_leaf_translucency.png');
await small('leaves/white_oak_single_albedo.png', 'oak_leaf_albedo.png');
await small('leaves/white_oak_single_height.png', 'oak_leaf_height.png');
await small('leaves/saguaro_spines_albedo.png', 'spines_albedo.png');
await small('ground/rock_normal.png', 'rock_normal.png');
await small('bark/joshua_thatch_albedo.png', 'thatch_albedo.png');
await small('ground/rock_height.png', 'rock_height.png');
await small('leaves/yucca_rosette_albedo.png', 'yucca_leaf_albedo.png');
await small('bark/saguaro_skin_albedo.png', 'saguaro_skin_albedo.png').catch(() => null);
// a magenta-keyed card (the leaf over #FF00FF) and an opaque "generated" copy for apply-alpha
{
  const leaf = await sharp(path.join(inputs, 'maple_leaf_albedo.png')).png().toBuffer();
  await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } } })
    .composite([{ input: leaf }]).removeAlpha().png().toFile(path.join(inputs, 'leaf_on_magenta.png'));
  await sharp(path.join(inputs, 'maple_leaf_albedo.png')).flatten({ background: '#ff00ff' }).modulate({ brightness: 1.1 })
    .resize(300, 300, { fit: 'fill' }).png().toFile(path.join(inputs, 'codex_out.png'));
}
// a noisy translucency for denoise (speckle on the leaf map)
{
  const { data, info } = await sharp(path.join(inputs, 'maple_leaf_translucency.png')).raw().toBuffer({ resolveWithObject: true });
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < data.length; i += info.channels) if (rnd() < 0.04) data[i] = data[i + 1] = data[i + 2] = rnd() < 0.5 ? 0 : 255;
  await sharp(data, { raw: info }).png().toFile(path.join(inputs, 'noisy_translucency.png'));
}
// an 'arc' wind clip: noise under a swell, 14 s at 32 kHz, as a WAV
{
  const SR = 32000, N = SR * 14;
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(N * 2, 40);
  let s = 777, lp = 0;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  for (let k = 0; k < N; k++) {
    const t = k / SR;
    const arc = Math.min(1, t / 2) * (t > 11 ? Math.max(0, 1 - (t - 11) / 3) : 1) * (0.6 + 0.4 * Math.sin(t * 0.7));
    lp += (rnd() - lp) * 0.08;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, lp * 2.5 * arc)) * 20000), 44 + k * 2);
  }
  fs.writeFileSync(path.join(inputs, 'wind_arc.wav'), buf);
}

const runs = [];
function run(script, dir, files, args) {
  const d = path.join(outDir, 'js', dir);
  fs.mkdirSync(d, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(inputs, f), path.join(d, f));
  const full = args.map((a) => (typeof a === 'string' && a.startsWith('@') ? path.join(d, a.slice(1)) : String(a)));
  const r = spawnSync(process.execPath, [path.join(jsRoot, 'scripts', script), ...full], { cwd: d, encoding: 'utf8' });
  runs.push({ script, dir, args: args.map(String), status: r.status, stdout: r.stdout.trim().slice(0, 2000), stderr: (r.stderr || '').trim().slice(0, 600) });
  if (r.status !== 0 && !(script.includes('check-tile') && r.status === 1)) console.error(`[tools] ${script} exited ${r.status}: ${r.stderr}`);
}

run('texture/derive-pbr.mjs', 'derive_pbr', ['oak_bark_albedo.png'], ['@oak_bark_albedo.png', '--strength', 2.5]);
run('texture/derive-pbr.mjs', 'derive_pbr_alpha', ['maple_leaf_albedo.png'], ['@maple_leaf_albedo.png', '--strength', 4]);
run('texture/derive-height.mjs', 'derive_height', ['rock_normal.png'], ['@rock_normal.png']);
run('texture/derive-translucency.mjs', 'derive_translucency', ['maple_leaf_albedo.png'], ['@maple_leaf_albedo.png', '--tissue', 0.8, '--vein', 5]);
run('texture/derive-leaf-maps.mjs', 'derive_leaf_maps', ['oak_leaf_albedo.png', 'oak_leaf_height.png'], ['@oak_leaf_albedo.png', '@oak_leaf_height.png']);
run('texture/derive-leaf-roughness.mjs', 'derive_leaf_roughness', ['maple_leaf_albedo.png', 'maple_leaf_translucency.png'], ['@maple_leaf_albedo.png', '@maple_leaf_translucency.png', '--gloss', 0.35]);
run('texture/derive-cactus-bark.mjs', 'derive_cactus_bark', ['oak_bark_albedo.png'], ['@oak_bark_albedo.png', '@skin', '--size', 256, '--strength', 1.4]);
run('texture/derive-spine-translucency.mjs', 'derive_spine_translucency', ['spines_albedo.png'], ['@spines_albedo.png']);
run('texture/derive-thatch-pbr.mjs', 'derive_thatch_pbr', ['thatch_albedo.png', 'rock_height.png'], ['@thatch_albedo.png', '@rock_height.png', '@thatch', '--height-out', '@thatch_height_qa.png']);
run('texture/make-seamless.mjs', 'make_seamless', ['oak_bark_albedo.png'], ['@oak_bark_albedo.png', '@seamless.png', '--h', 20, '--v', 11, '--size', 256]);
run('texture/dilate-alpha.mjs', 'dilate_alpha', ['maple_leaf_albedo.png'], ['@maple_leaf_albedo.png', '--passes', 20]);
run('texture/apply-alpha.mjs', 'apply_alpha', ['codex_out.png', 'maple_leaf_albedo.png'], ['@codex_out.png', '@maple_leaf_albedo.png', '@welded.png', '--despill']);
run('texture/apply-alpha.mjs', 'apply_alpha_gray', ['codex_out.png', 'maple_leaf_albedo.png'], ['@codex_out.png', '@maple_leaf_albedo.png', '@welded_gray.png', '--gray']);
run('texture/chroma-key.mjs', 'chroma_key', ['leaf_on_magenta.png'], ['@leaf_on_magenta.png', '@keyed.png']);
run('texture/denoise.mjs', 'denoise', ['noisy_translucency.png'], ['@noisy_translucency.png', '--median', 5]);
run('texture/denoise.mjs', 'denoise_blur', ['noisy_translucency.png'], ['@noisy_translucency.png', '--median', 3, '--blur', 1.2]);
run('texture/check-tile.mjs', 'check_tile', ['oak_bark_albedo.png'], ['@oak_bark_albedo.png']);
run('texture/tile-preview.mjs', 'tile_preview', ['maple_leaf_albedo.png'], ['@maple_leaf_albedo.png', '@tiled.png']);
run('texture/make-bark-guide.mjs', 'make_bark_guide', ['oak_bark_albedo.png'], ['@oak_bark_albedo.png', '@guide.png']);
run('texture/make-yucca-alpha.mjs', 'make_yucca_alpha', ['yucca_leaf_albedo.png'], ['@yucca_leaf_albedo.png']);
run('audio/seamless-loop.mjs', 'seamless_loop', ['wind_arc.wav'], ['@wind_arc.wav', '@wind_loop.wav', 3]);
run('audio/loop-wind.mjs', 'loop_wind', ['wind_arc.wav'], ['@wind_arc.wav', '@wind_loopwind.wav', 3, 0.6]);

// gen-wind: the graph the script would POST, evaluated from its own source text
{
  const src = fs.readFileSync(path.join(jsRoot, 'scripts', 'audio', 'gen-wind.mjs'), 'utf8');
  const seedSrc = src.match(/let seed = 0;[^\n]*/)[0];
  const wfSrc = src.match(/const wf = (\{[\s\S]*?\n {2}\});/)[1];
  const graphs = [];
  for (const [outName, secsArg, prompt] of [['wind_test.mp3', '20', 'steady wind through tall grass'], ['gust.mp3', '7.5', 'gusts']]) {
    const seconds = Number(secsArg || 20);
    // eslint-disable-next-line no-new-func
    const wf = new Function('outName', 'seconds', 'prompt', `${seedSrc}\nreturn ${wfSrc};`)(outName, seconds, prompt);
    graphs.push({ outName, seconds: secsArg, prompt, wf });
  }
  fs.mkdirSync(path.join(outDir, 'js', 'gen_wind'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'js', 'gen_wind', 'graphs.json'), JSON.stringify(graphs, null, 1));
}

// harvest-codex-image: a fake ~/.codex/sessions with two generated PNGs
{
  const home = path.join(outDir, 'js', 'harvest_home');
  const sess = path.join(home, '.codex', 'sessions', '2026', '11', '07');
  fs.mkdirSync(sess, { recursive: true });
  const png = (n) => sharp({ create: { width: 64 + n, height: 64, channels: 3, background: { r: 40 * n, g: 120, b: 30 } } }).png().toBuffer();
  const imgs = [await png(1), await png(2)];
  const lines = [JSON.stringify({ payload: { type: 'message', text: 'paint a willow leaf' } })];
  for (const b of imgs) {
    const r = 'data:image/png;base64,' + b.toString('base64') + ' '.repeat(5000);
    lines.push(JSON.stringify({ payload: { type: 'image_generation_call', result: r } }));
    lines.push(JSON.stringify({ payload: { type: 'image_generation_end', result: r } }));
  }
  fs.writeFileSync(path.join(sess, 'rollout-test.jsonl'), lines.join('\n') + '\n');
  const d = path.join(outDir, 'js', 'harvest');
  fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const r = spawnSync(process.execPath, [path.join(jsRoot, 'scripts', 'texture', 'harvest-codex-image.mjs'), '--match', 'willow',
    path.join(d, 'h1.png'), path.join(d, 'h2.png')], { env, encoding: 'utf8' });
  const l = spawnSync(process.execPath, [path.join(jsRoot, 'scripts', 'texture', 'harvest-codex-image.mjs'), '--list'], { env, encoding: 'utf8' });
  runs.push({ script: 'texture/harvest-codex-image.mjs', dir: 'harvest', status: r.status, stdout: r.stdout.trim(), list: l.stdout.trim() });
}

fs.writeFileSync(path.join(outDir, 'js', 'runs.json'), JSON.stringify(runs, null, 1));
console.log(`[tools] ${runs.length} script runs -> ${path.join(outDir, 'js')}`);
