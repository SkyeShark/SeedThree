// Generate an ambient wind clip with Stable Audio 3 (medium) via the RUNNING
// ComfyUI on :8188, using the exact node wiring from the user's working API graph
// (Downloads/audio_stable_audio_3_medium_base.json): the text encoder is a
// separate CLIPLoader(t5gemma_b_b_ul2, type=stable_audio) — NOT the checkpoint's
// CLIP (that's None for this ckpt) — and there is no ConditioningStableAudio node;
// duration is set purely by EmptyLatentAudio. The reprompt LLM chain is bypassed:
// we feed our own SFX-style prompt straight into CLIPTextEncode.
//
// Submits, polls history, downloads the MP3 via /view → assets/audio/<out>.
// Usage: node scripts/audio/gen-wind.mjs <out.mp3> <seconds> "<prompt>"
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const HOST = '127.0.0.1', PORT = 8188;
const [outName, secsArg, prompt] = process.argv.slice(2);
const seconds = Number(secsArg || 20);
if (!outName || !prompt) { console.error('usage: gen-wind.mjs <out.mp3> <seconds> "<prompt>"'); process.exit(2); }

function req(method, pathname, body) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: HOST, port: PORT, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (resp) => { const d = []; resp.on('data', (c) => d.push(c)); resp.on('end', () => res({ status: resp.statusCode, buf: Buffer.concat(d) })); });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let seed = 0; for (const ch of (outName + seconds)) seed = (seed * 131 + ch.charCodeAt(0)) % 2147483647;
  const wf = {
    '25': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stable_audio_3_medium_base.safetensors' } },
    '26': { class_type: 'CLIPLoader', inputs: { clip_name: 't5gemma_b_b_ul2.safetensors', type: 'stable_audio', device: 'default' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['26', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['26', 0] } },
    '11': { class_type: 'EmptyLatentAudio', inputs: { seconds, batch_size: 1 } },
    '3': { class_type: 'KSampler', inputs: { seed, steps: 50, cfg: 7, sampler_name: 'lcm', scheduler: 'simple', denoise: 1,
      model: ['25', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0] } },
    '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['3', 0], vae: ['25', 2] } },
    '19': { class_type: 'SaveAudioMP3', inputs: { audio: ['12', 0], filename_prefix: 'seedthree/' + outName.replace(/\.mp3$/, ''), quality: 'V0' } },
  };
  console.log(`[gen-wind] submit ${outName} (${seconds}s, seed=${seed})`);
  const sub = await req('POST', '/prompt', { prompt: wf });
  if (sub.status !== 200) { console.error('[gen-wind] submit failed', sub.status, sub.buf.toString().slice(0, 400)); process.exit(1); }
  const promptId = JSON.parse(sub.buf.toString()).prompt_id;
  console.log('[gen-wind] prompt_id', promptId);

  let outputs = null, err = null;
  for (let i = 0; i < 300; i++) {
    await sleep(2500);
    const h = await req('GET', '/history/' + promptId);
    if (h.status === 200) {
      const entry = JSON.parse(h.buf.toString())[promptId];
      if (entry?.status?.status_str === 'error') { err = entry.status.messages?.find((m) => m[0] === 'execution_error'); break; }
      if (entry?.outputs && Object.keys(entry.outputs).length) { outputs = entry.outputs; break; }
    }
    if (i % 8 === 0) console.log(`[gen-wind] ...waiting (${Math.round(i * 2.5)}s)`);
  }
  if (err) { console.error('[gen-wind] ComfyUI error:', JSON.stringify(err[1]?.exception_message || err).slice(0, 400)); process.exit(1); }
  if (!outputs) { console.error('[gen-wind] timed out'); process.exit(1); }

  let file = null;
  for (const nodeOut of Object.values(outputs)) {
    const arr = nodeOut.audio || nodeOut.mp3 || nodeOut.files;
    if (arr && arr.length) { file = arr[0]; break; }
  }
  if (!file) { console.error('[gen-wind] no audio in outputs:', JSON.stringify(outputs).slice(0, 300)); process.exit(1); }
  const q = `filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder || '')}&type=${encodeURIComponent(file.type || 'output')}`;
  const v = await req('GET', '/view?' + q);
  if (v.status !== 200) { console.error('[gen-wind] view failed', v.status); process.exit(1); }
  const outPath = path.resolve('assets/audio', outName);
  fs.writeFileSync(outPath, v.buf);
  console.log(`[gen-wind] wrote ${outPath} (${Math.round(v.buf.length / 1024)}KB) from ${file.filename}`);
}
main().catch((e) => { console.error('[gen-wind] error', e); process.exit(1); });
