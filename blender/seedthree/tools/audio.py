"""SeedThree's audio tooling (scripts/audio/*.mjs) in Python.

  gen_wind       an ambient wind clip from Stable Audio 3 (medium) through a running
                 ComfyUI (127.0.0.1:8188): the app's exact node graph and seed
  loop_wind      ffmpeg overlap-add loop: trim the edges, fade the head in and the tail
                 out (equal power) and mix them at t = 0, loudnorm to -24 LUFS
  seamless_loop  decode to mono float, flatten the loudness envelope, equal-power
                 head/tail crossfade, peak-normalize, write a 16-bit WAV (no MP3 padding)

    from seedthree.tools import audio
    audio.seamless_loop('raw_wind.mp3', 'wind_temperate.wav', xfade=3)

numpy for the sample math (float32 storage, JS rounding), ffmpeg / ffprobe from PATH.
"""

import json
import math
import os
import re
import shutil
import struct
import subprocess
import time
import urllib.parse
import urllib.request

import numpy as np

HOST, PORT = '127.0.0.1', 8188
SR = 32000


def _ffmpeg(name='ffmpeg'):
    p = shutil.which(name)
    if not p:
        raise RuntimeError('[seedthree.tools] %s is not on PATH' % name)
    return p


def _duration(path):
    out = subprocess.run([_ffmpeg('ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                         capture_output=True, check=True)
    return float(out.stdout.decode().strip())


# ---- gen-wind ------------------------------------------------------------------------

def wind_seed(out_name, seconds):
    """The JS seed: a rolling hash of out_name + String(seconds)."""
    s = 0
    secs = int(seconds) if float(seconds).is_integer() else seconds
    for ch in out_name + str(secs):
        s = (s * 131 + ord(ch)) % 2147483647
    return s


def wind_workflow(out_name, seconds, prompt):
    """The ComfyUI API graph gen-wind.mjs submits (CLIPLoader t5gemma for the text,
    EmptyLatentAudio for the length, 50 LCM steps at cfg 7, MP3 V0)."""
    seconds = float(seconds)
    secs = int(seconds) if seconds.is_integer() else seconds
    seed = wind_seed(out_name, seconds)
    return {
        '25': {'class_type': 'CheckpointLoaderSimple', 'inputs': {'ckpt_name': 'stable_audio_3_medium_base.safetensors'}},
        '26': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 't5gemma_b_b_ul2.safetensors', 'type': 'stable_audio',
                                                      'device': 'default'}},
        '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': prompt, 'clip': ['26', 0]}},
        '7': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '', 'clip': ['26', 0]}},
        '11': {'class_type': 'EmptyLatentAudio', 'inputs': {'seconds': secs, 'batch_size': 1}},
        '3': {'class_type': 'KSampler', 'inputs': {'seed': seed, 'steps': 50, 'cfg': 7, 'sampler_name': 'lcm',
                                                   'scheduler': 'simple', 'denoise': 1, 'model': ['25', 0],
                                                   'positive': ['6', 0], 'negative': ['7', 0], 'latent_image': ['11', 0]}},
        '12': {'class_type': 'VAEDecodeAudio', 'inputs': {'samples': ['3', 0], 'vae': ['25', 2]}},
        '19': {'class_type': 'SaveAudioMP3', 'inputs': {'audio': ['12', 0],
                                                        'filename_prefix': 'seedthree/' + re.sub(r'\.mp3$', '', out_name),
                                                        'quality': 'V0'}},
    }


def _req(method, path, body=None, host=HOST, port=PORT, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request('http://%s:%d%s' % (host, port, path), data=data, method=method,
                               headers={'Content-Type': 'application/json'} if data else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def gen_wind(out_name, seconds=20, prompt='', out_dir='assets/audio', host=HOST, port=PORT, poll=2.5, tries=300):
    """Submit the wind graph to ComfyUI, poll its history, download the MP3 to
    out_dir/out_name. Needs a running ComfyUI with the Stable Audio 3 weights."""
    if not out_name or not prompt:
        raise ValueError('usage: gen_wind(out.mp3, seconds, prompt)')
    wf = wind_workflow(out_name, seconds, prompt)
    print('[gen-wind] submit %s (%ss, seed=%d)' % (out_name, seconds, wf['3']['inputs']['seed']))
    st, buf = _req('POST', '/prompt', {'prompt': wf}, host, port)
    if st != 200:
        raise RuntimeError('[gen-wind] submit failed %s %s' % (st, buf[:400]))
    pid = json.loads(buf)['prompt_id']
    print('[gen-wind] prompt_id', pid)
    outputs = None
    for i in range(tries):
        time.sleep(poll)
        st, buf = _req('GET', '/history/' + pid, None, host, port)
        if st == 200:
            entry = json.loads(buf).get(pid) or {}
            status = entry.get('status') or {}
            if status.get('status_str') == 'error':
                raise RuntimeError('[gen-wind] ComfyUI error: %s' % json.dumps(status.get('messages'))[:400])
            if entry.get('outputs'):
                outputs = entry['outputs']
                break
        if i % 8 == 0:
            print('[gen-wind] ...waiting (%ds)' % round(i * poll))
    if not outputs:
        raise RuntimeError('[gen-wind] timed out')
    f = None
    for node_out in outputs.values():
        arr = node_out.get('audio') or node_out.get('mp3') or node_out.get('files')
        if arr:
            f = arr[0]
            break
    if not f:
        raise RuntimeError('[gen-wind] no audio in outputs')
    q = urllib.parse.urlencode({'filename': f['filename'], 'subfolder': f.get('subfolder') or '', 'type': f.get('type') or 'output'})
    st, data = _req('GET', '/view?' + q, None, host, port, timeout=120)
    if st != 200:
        raise RuntimeError('[gen-wind] view failed %s' % st)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.abspath(os.path.join(out_dir, out_name))
    with open(out_path, 'wb') as fh:
        fh.write(data)
    print('[gen-wind] wrote %s (%dKB) from %s' % (out_path, round(len(data) / 1024), f['filename']))
    return out_path


# ---- loop-wind ----------------------------------------------------------------------------

def loop_wind_filter(dur, xfade=3.0, edge=0.6):
    """The overlap-add loop filter graph for a clip of `dur` seconds -> (graph, final loop
    length, crossfade)."""
    inner = dur - 2 * edge
    if inner < 4:
        raise ValueError('clip too short (%ss) to loop' % dur)
    xf = xfade
    if xf > inner / 2 - 0.5:
        xf = max(1, inner / 2 - 0.5)
    lf = inner - xf
    e0, e1 = edge, dur - edge
    fc = ';'.join([
        '[0:a]atrim=%.3f:%.3f,asetpts=N/SR/TB[inner]' % (e0, e1),
        '[inner]asplit[m][t]',
        '[m]atrim=0:%.3f,asetpts=N/SR/TB,afade=t=in:st=0:d=%.3f:curve=qsin[main]' % (lf, xf),
        '[t]atrim=%.3f:%.3f,asetpts=N/SR/TB,afade=t=out:st=0:d=%.3f:curve=qsin[tail]' % (lf, inner, xf),
        '[main][tail]amix=inputs=2:normalize=0[mix]',
        '[mix]loudnorm=I=-24:TP=-3:LRA=7[o]',
    ])
    return fc, lf, xf


def loop_wind(in_path, out_path, xfade=3.0, edge=0.6):
    """Turn a raw wind clip into a seamless, quiet loop with ffmpeg (WAV out = gapless)."""
    in_path, out_path = os.path.abspath(in_path), os.path.abspath(out_path)
    if not os.path.isfile(in_path):
        raise FileNotFoundError(in_path)
    dur = _duration(in_path)
    fc, lf, xf = loop_wind_filter(dur, xfade, edge)
    codec = ['-c:a', 'pcm_s16le'] if out_path.lower().endswith('.wav') else ['-b:a', '128k']
    subprocess.run([_ffmpeg(), '-y', '-i', in_path, '-filter_complex', fc, '-map', '[o]', '-ac', '1', '-ar', '32000']
                   + codec + [out_path], check=True, capture_output=True)
    out_dur = _duration(out_path)
    print('[loop-wind] %s (%.1fs) -> %s seamless loop %.1fs, xfade %.1fs (%dKB)' % (
        os.path.basename(in_path), dur, os.path.basename(out_path), out_dur, xf, round(os.path.getsize(out_path) / 1024)))
    return out_path


# ---- seamless-loop ----------------------------------------------------------------------------

def decode_mono(in_path, sr=SR):
    """ffmpeg -> mono float32 samples at sr."""
    p = subprocess.run([_ffmpeg(), '-v', 'error', '-i', in_path, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'],
                       capture_output=True)
    if p.returncode != 0:
        raise RuntimeError('decode failed: %s' % p.stderr[:300])
    return np.frombuffer(p.stdout[:len(p.stdout) // 4 * 4], '<f4')


def _js_round(x):
    return math.floor(x + 0.5)


def seamless_loop_samples(s, xfade=3.0, sr=SR):
    """The JS processing on float32 samples -> (loop samples float32, info dict)."""
    s = np.asarray(s, np.float32)
    N = len(s)
    dur = N / sr
    win, hop = 1600, 800
    starts = np.arange(0, N - win + 1, hop)
    s64 = s.astype(np.float64)
    env = []
    for i in starts:   # the JS's sequential sum per window (exact double accumulation)
        seg = s64[i:i + win]
        a = 0.0
        for v in (seg * seg).tolist():
            a += v
        env.append(math.sqrt(a / win))
    tt = [i / sr for i in starts]
    srt = sorted(env)
    med = (srt[len(env) >> 1] if env else 0) or 1e-6
    loud = 0.5 * med
    last = len(env) - 1
    while last > 0 and env[last] < loud:
        last -= 1
    first = 0
    while first < len(env) and env[first] < loud:
        first += 1
    first = min(first, len(env) - 1)
    t_start = max(0.0, tt[first] + 1.2)
    t_end = min(dur, tt[last] + win / sr - 0.15)
    inner_len = t_end - t_start
    if inner_len < 6:
        t_start, t_end = dur * 0.12, dur * 0.88
        inner_len = t_end - t_start
    iw0, iw1 = math.floor(t_start * sr / hop), math.floor(t_end * sr / hop)
    interior = env[iw0:iw1]
    target = (sorted(interior)[len(interior) >> 1] if interior else 0) or med
    gw = [max(0.25, min(4, target / max(e, 0.25 * med))) for e in env]
    sm = _js_round(1.2 * sr / hop)
    gws = []
    for i in range(len(gw)):
        a = c = 0.0
        for k in range(-sm, sm + 1):
            j = i + k
            if 0 <= j < len(gw):
                a += gw[j]
                c += 1
        gws.append(a / c)
    gws = np.array(gws)

    def gain_at(k):
        wf = k / hop
        i0 = np.minimum(len(gws) - 1, np.floor(wf)).astype(np.int64)
        i1 = np.minimum(len(gws) - 1, i0 + 1)
        f = wf - i0
        return gws[i0] * (1 - f) + gws[i1] * f

    xf = xfade
    if xf > inner_len / 2 - 0.5:
        xf = max(1, inner_len / 2 - 0.5)
    i0 = _js_round(t_start * sr)
    inner_n, xf_n = _js_round(inner_len * sr), _js_round(xf * sr)
    lfn = inner_n - xf_n
    k = np.arange(inner_n)
    inner = (s64[i0 + k] * gain_at((i0 + k).astype(np.float64))).astype(np.float32)
    out = inner[:lfn].astype(np.float64)
    kk = np.arange(xf_n)
    x = (kk / xf_n) * (math.pi / 2)
    out[:xf_n] = inner[:xf_n].astype(np.float64) * np.sin(x) + inner[lfn:lfn + xf_n].astype(np.float64) * np.cos(x)
    out = out.astype(np.float32)
    peak = float(np.max(np.abs(out))) if lfn else 0.0
    g = 0.7 / peak if peak > 0 else 1.0
    out = (out.astype(np.float64) * g).astype(np.float32)

    def rms_var(arr):
        w = _js_round(0.5 * sr)
        r = []
        for i in range(0, len(arr) - w + 1, w):
            seg = arr[i:i + w].astype(np.float64)
            r.append(math.sqrt(float((seg * seg).sum()) / w))
        if not r:
            return 0.0
        m = sum(r) / len(r)
        return math.sqrt(sum((c - m) ** 2 for c in r) / len(r)) / m

    info = {'duration': dur, 'tStart': t_start, 'tEnd': t_end, 'innerLen': inner_len, 'xfade': xf,
            'loopSeconds': lfn / sr, 'cvRaw': rms_var(s[i0:i0 + inner_n]), 'cvFlat': rms_var(out),
            'envelope': env, 'median': med}
    return out, info


def write_wav16(path, samples, sr=SR):
    """16-bit mono PCM, the JS's writer: round(clamp(v x 32767))."""
    v = np.asarray(samples, np.float64) * 32767
    q = np.clip(np.floor(v + 0.5), -32767, 32767).astype('<i2')
    with open(path, 'wb') as fh:
        n = len(q)
        fh.write(b'RIFF' + struct.pack('<I', 36 + n * 2) + b'WAVE')
        fh.write(b'fmt ' + struct.pack('<IHHIIHH', 16, 1, 1, sr, sr * 2, 2, 16))
        fh.write(b'data' + struct.pack('<I', n * 2))
        fh.write(q.tobytes())
    return path


def seamless_loop(in_path, out_path, xfade=3.0):
    """A genuinely seamless ambient loop from a clip with an arc (swell / fade-out)."""
    in_path, out_path = os.path.abspath(in_path), os.path.abspath(out_path)
    s = decode_mono(in_path)
    out, info = seamless_loop_samples(s, xfade)
    spark = ' .:-=+*#%@'
    med = info['median']
    print('[seamless] %s %.1fs  interior %.2f..%.2fs (%.1fs)  xfade %.1fs -> loop %.1fs' % (
        os.path.basename(in_path), info['duration'], info['tStart'], info['tEnd'], info['innerLen'], info['xfade'],
        info['loopSeconds']))
    print('[seamless] envelope: ' + ''.join(spark[min(9, _js_round((v / (med * 2)) * 9))] for v in info['envelope']))
    print('[seamless] loudness CV(RMS): raw interior %d%%  ->  flattened %d%%  (lower = steadier)' % (
        _js_round(info['cvRaw'] * 100), _js_round(info['cvFlat'] * 100)))
    write_wav16(out_path, out)
    print('[seamless] -> %s %.1fs (%dKB)' % (os.path.basename(out_path), len(out) / SR, round((44 + len(out) * 2) / 1024)))
    info['path'] = out_path
    return info


# ---- command lines ------------------------------------------------------------------------------

def cli_gen_wind(args):
    if len(args) < 3:
        print('usage: gen-wind <out.mp3> <seconds> "<prompt>"')
        return 2
    gen_wind(args[0], float(args[1] or 20), args[2])


def cli_loop_wind(args):
    if len(args) < 2:
        print('usage: loop-wind <in.mp3> <out.mp3> [xfade=3] [edge=0.6]')
        return 2
    loop_wind(args[0], args[1], float(args[2]) if len(args) > 2 else 3.0, float(args[3]) if len(args) > 3 else 0.6)


def cli_seamless_loop(args):
    if len(args) < 2:
        print('usage: seamless-loop <in> <out.wav> [xfade=3]')
        return 2
    seamless_loop(args[0], args[1], float(args[2]) if len(args) > 2 else 3.0)
