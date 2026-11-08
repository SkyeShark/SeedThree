"""The asset tooling (seedthree.tools: scripts/texture + scripts/audio) against the app's
own scripts run by golden_dump_tools.mjs on the same inputs.

    node blender/tests/golden_dump_tools.mjs     # writes blender/tests/out/golden_tools/{inputs,js}
    python blender/tests/test_tools.py

System Python (numpy, Pillow, ffmpeg on PATH). Each Python run works on its own copy
of the inputs under out/golden_tools/py/<run>/ and every file the JS wrote is compared:
'exact' outputs must match byte for byte in pixels; outputs that pass through a libvips
blur or resize are held to a small per-pixel tolerance (reported).
"""

import json
import os
import shutil
import sys
import wave

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))

from seedthree.tools import texture as T, audio as AU, codex as CX  # noqa: E402

GOLD = os.path.join(HERE, 'out', 'golden_tools')
INP = os.path.join(GOLD, 'inputs')
JS = os.path.join(GOLD, 'js')
PY = os.path.join(GOLD, 'py')
RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok)))
    print('%s %s%s' % ('PASS' if ok else 'FAIL', name, ('  ' + detail) if detail else ''))


def stage(run, files):
    d = os.path.join(PY, run)
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    for f in files:
        shutil.copyfile(os.path.join(INP, f), os.path.join(d, f))
    return d


def px(path):
    a = np.asarray(Image.open(path)).astype(np.int64)
    return a[..., None] if a.ndim == 2 else a


def compare(run, name, tol=0, frac=0.0):
    """Pixel compare of out/golden_tools/{js,py}/<run>/<name>: tol = max |diff| allowed,
    frac = share of pixels allowed to differ at all."""
    a, b = px(os.path.join(JS, run, name)), px(os.path.join(PY, run, name))
    if a.shape != b.shape:
        check('%s/%s' % (run, name), False, 'shape js %s py %s' % (a.shape, b.shape))
        return
    d = np.abs(a - b)
    mx = int(d.max())
    share = float((d.max(axis=2) > 0).mean())
    ok = mx <= tol and share <= frac
    check('%s/%s' % (run, name), ok, 'max |diff| %d, %.3f%% of pixels differ (allowed %d / %.1f%%)' % (
        mx, share * 100, tol, frac * 100))


def main():
    if not os.path.isdir(JS):
        print('FAIL no golden data: run node blender/tests/golden_dump_tools.mjs first')
        return 1
    shutil.rmtree(PY, ignore_errors=True)

    d = stage('derive_pbr', ['oak_bark_albedo.png'])
    T.derive_pbr(os.path.join(d, 'oak_bark_albedo.png'), strength=2.5)
    compare('derive_pbr', 'oak_bark_normal.png', 1, 0.001)
    compare('derive_pbr', 'oak_bark_roughness.png')
    d = stage('derive_pbr_alpha', ['maple_leaf_albedo.png'])
    T.derive_pbr(os.path.join(d, 'maple_leaf_albedo.png'), strength=4)
    compare('derive_pbr_alpha', 'maple_leaf_normal.png', 1, 0.001)
    compare('derive_pbr_alpha', 'maple_leaf_roughness.png')

    d = stage('derive_height', ['rock_normal.png'])
    T.derive_height(os.path.join(d, 'rock_normal.png'))
    compare('derive_height', 'rock_height.png', 1, 0.001)

    d = stage('derive_translucency', ['maple_leaf_albedo.png'])
    T.derive_translucency(os.path.join(d, 'maple_leaf_albedo.png'), tissue=0.8, vein=5)
    compare('derive_translucency', 'maple_leaf_translucency.png')

    d = stage('derive_leaf_maps', ['oak_leaf_albedo.png', 'oak_leaf_height.png'])
    T.derive_leaf_maps(os.path.join(d, 'oak_leaf_albedo.png'), os.path.join(d, 'oak_leaf_height.png'))
    for k in ('normal', 'roughness', 'translucency'):
        compare('derive_leaf_maps', 'oak_leaf_albedo_%s.png' % k)

    d = stage('derive_leaf_roughness', ['maple_leaf_albedo.png', 'maple_leaf_translucency.png'])
    T.derive_leaf_roughness(os.path.join(d, 'maple_leaf_albedo.png'), os.path.join(d, 'maple_leaf_translucency.png'), gloss=0.35)
    compare('derive_leaf_roughness', 'maple_leaf_roughness.png')

    d = stage('derive_cactus_bark', ['oak_bark_albedo.png'])
    T.derive_cactus_bark(os.path.join(d, 'oak_bark_albedo.png'), os.path.join(d, 'skin'), size=256, strength=1.4)
    for k in ('albedo', 'normal', 'roughness'):
        compare('derive_cactus_bark', 'skin_%s.png' % k, 1, 0.001)

    d = stage('derive_spine_translucency', ['spines_albedo.png'])
    T.derive_spine_translucency(os.path.join(d, 'spines_albedo.png'))
    compare('derive_spine_translucency', 'spines_translucency.png')

    d = stage('derive_thatch_pbr', ['thatch_albedo.png', 'rock_height.png'])
    T.derive_thatch_pbr(os.path.join(d, 'thatch_albedo.png'), os.path.join(d, 'rock_height.png'), os.path.join(d, 'thatch'),
                        height_out=os.path.join(d, 'thatch_height_qa.png'))
    for k in ('thatch_normal.png', 'thatch_roughness.png', 'thatch_height_qa.png'):
        compare('derive_thatch_pbr', k, 1, 0.002)

    d = stage('make_seamless', ['oak_bark_albedo.png'])
    T.make_seamless(os.path.join(d, 'oak_bark_albedo.png'), os.path.join(d, 'seamless.png'), h=20, v=11, size=256)
    compare('make_seamless', 'seamless.png')

    d = stage('dilate_alpha', ['maple_leaf_albedo.png'])
    T.dilate_alpha(os.path.join(d, 'maple_leaf_albedo.png'), passes=20)
    compare('dilate_alpha', 'maple_leaf_albedo.png')

    d = stage('apply_alpha', ['codex_out.png', 'maple_leaf_albedo.png'])
    T.apply_alpha(os.path.join(d, 'codex_out.png'), os.path.join(d, 'maple_leaf_albedo.png'), os.path.join(d, 'welded.png'),
                  despill=True)
    compare('apply_alpha', 'welded.png', 3, 0.25)      # a 300 -> 256 Lanczos shrink
    d = stage('apply_alpha_gray', ['codex_out.png', 'maple_leaf_albedo.png'])
    T.apply_alpha(os.path.join(d, 'codex_out.png'), os.path.join(d, 'maple_leaf_albedo.png'), os.path.join(d, 'welded_gray.png'),
                  gray=True)
    compare('apply_alpha_gray', 'welded_gray.png', 3, 0.25)

    d = stage('chroma_key', ['leaf_on_magenta.png'])
    rep = T.chroma_key(os.path.join(d, 'leaf_on_magenta.png'), os.path.join(d, 'keyed.png'))
    compare('chroma_key', 'keyed.png')
    js_runs = {r['dir']: r for r in json.load(open(os.path.join(JS, 'runs.json')))}
    jrep = json.loads(js_runs['chroma_key']['stdout'])
    check('chroma_key report', jrep['transparentPixels'] == rep['transparentPixels'] and jrep['coverage'] == rep['coverage'],
          'js %s / py %s' % ((jrep['transparentPixels'], jrep['coverage']), (rep['transparentPixels'], rep['coverage'])))

    d = stage('denoise', ['noisy_translucency.png'])
    T.denoise(os.path.join(d, 'noisy_translucency.png'), median_n=5)
    compare('denoise', 'noisy_translucency.png', 0, 0.0)
    d = stage('denoise_blur', ['noisy_translucency.png'])
    T.denoise(os.path.join(d, 'noisy_translucency.png'), median_n=3, blur_sigma=1.2)
    compare('denoise_blur', 'noisy_translucency.png', 1, 0.001)

    d = stage('check_tile', ['oak_bark_albedo.png'])
    ct = T.check_tile(os.path.join(d, 'oak_bark_albedo.png'))
    compare('check_tile', 'oak_bark_albedo.offset.png')
    out = js_runs['check_tile']['stdout']
    want = 'seam X (L|R): %.2f  vs interior %.2f  -> %.2fx' % (ct['seamX'], ct['baseX'], ct['ratioX'])
    check('check_tile report', want in out and ('PASS' in out) == ct['pass'], want)

    d = stage('tile_preview', ['maple_leaf_albedo.png'])
    T.tile_preview(os.path.join(d, 'maple_leaf_albedo.png'), os.path.join(d, 'tiled.png'))
    compare('tile_preview', 'tiled.png', 2, 0.10)        # a 256 -> 512 bicubic enlargement

    d = stage('make_bark_guide', ['oak_bark_albedo.png'])
    T.make_bark_guide(os.path.join(d, 'oak_bark_albedo.png'), os.path.join(d, 'guide.png'))
    compare('make_bark_guide', 'guide.png', 1, 0.35)    # a 256 -> 1024 bicubic enlargement

    d = stage('make_yucca_alpha', ['yucca_leaf_albedo.png'])
    T.make_yucca_alpha(os.path.join(d, 'yucca_leaf_albedo.png'))
    compare('make_yucca_alpha', 'yucca_leaf_albedo.png')

    # ---- audio ----
    d = stage('seamless_loop', ['wind_arc.wav'])
    info = AU.seamless_loop(os.path.join(d, 'wind_arc.wav'), os.path.join(d, 'wind_loop.wav'), 3)

    def wav(p):
        with wave.open(p) as w:
            return np.frombuffer(w.readframes(w.getnframes()), '<i2').astype(np.int64), w.getframerate()
    a, sra = wav(os.path.join(JS, 'seamless_loop', 'wind_loop.wav'))
    b, srb = wav(os.path.join(d, 'wind_loop.wav'))
    same_len = len(a) == len(b) and sra == srb
    dd = int(np.abs(a - b).max()) if same_len else -1
    check('seamless_loop samples', same_len and dd <= 1, 'js %d / py %d samples, max |diff| %d LSB' % (len(a), len(b), dd))
    jout = js_runs['seamless_loop']['stdout']
    check('seamless_loop analysis', ('interior %.2f..%.2fs' % (info['tStart'], info['tEnd'])) in jout,
          'interior %.2f..%.2fs, loop %.1fs' % (info['tStart'], info['tEnd'], info['loopSeconds']))

    d = stage('loop_wind', ['wind_arc.wav'])
    AU.loop_wind(os.path.join(d, 'wind_arc.wav'), os.path.join(d, 'wind_loopwind.wav'), 3, 0.6)
    a, _ = wav(os.path.join(JS, 'loop_wind', 'wind_loopwind.wav'))
    b, _ = wav(os.path.join(d, 'wind_loopwind.wav'))
    check('loop_wind output', len(a) == len(b) and (len(a) == 0 or int(np.abs(a - b).max()) == 0),
          '%d / %d samples' % (len(a), len(b)))

    graphs = json.load(open(os.path.join(JS, 'gen_wind', 'graphs.json')))
    for g in graphs:
        mine = AU.wind_workflow(g['outName'], float(g['seconds']), g['prompt'])
        check('gen_wind graph %s' % g['outName'], json.loads(json.dumps(mine)) == g['wf'],
              'seed %d' % mine['3']['inputs']['seed'])

    # ---- codex harvest ----
    home = os.path.join(JS, 'harvest_home')
    d = os.path.join(PY, 'harvest')
    os.makedirs(d, exist_ok=True)
    root = CX.sessions_root(home)
    rep = CX.harvest_codex_image([os.path.join(d, 'h1.png'), os.path.join(d, 'h2.png')], match='willow', root=root)
    ok = all(open(os.path.join(JS, 'harvest', n), 'rb').read() == open(os.path.join(d, n), 'rb').read() for n in ('h1.png', 'h2.png'))
    check('harvest_codex_image', ok and rep['session'] == 'rollout-test.jsonl', json.dumps([s['bytes'] for s in rep['saved']]))
    lst = CX.harvest_codex_image(list_only=True, root=root)
    check('harvest_codex_image --list', json.loads(js_runs['harvest']['list']) == lst, json.dumps(lst))

    bad = [n for n, ok in RESULTS if not ok]
    print('%d/%d PASS%s' % (len(RESULTS) - len(bad), len(RESULTS), ('; FAIL: ' + ', '.join(bad)) if bad else ''))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
