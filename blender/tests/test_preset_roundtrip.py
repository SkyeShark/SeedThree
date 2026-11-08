"""Preset round-trip between the Blender port and the web app.

    python blender/tests/test_preset_roundtrip.py

1. Python writes seedthree-preset/1 files (api.save_preset) for designed trees.
2. The JS app code (preset_roundtrip.mjs) loads each with its own fromPreset,
   grows it, and re-serializes it with toPreset.
3. Pass when the JS tree has the same LOD triangle counts and dimensions as the
   Python tree, and the JS re-save carries the same controls as the file.
Also checks the golden dumps' JS toPreset output against Python's to_preset.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))

from seedthree import api  # noqa: E402

OUT = os.path.join(HERE, 'out', 'presets')
DESIGNS = [
    ('whiteOak', 1737, {'height': 14.5, 'levels': 4, 'trunks': 1, 'trunkThickness': 1.4, 'crownShape': 2,
                        'branchDensity': 24, 'branchAngle': 64, 'gnarliness': 80, 'leafSize': 0.38,
                        'leavesPerBranch': 24, 'paramOverrides': {'length': {'1': 0.56, '2': 0.46, '3': 0.4},
                                                                  'branches': {'2': 18, '3': 12},
                                                                  'downAngle': {'3': 45}, 'curveV': {'3': 60}}}),
    ('joshuaTree', 7, {'forkGenerations': 5, 'armBend': 14, 'rosetteSize': 0.6, 'frondDryness': 0.2}),
    ('saguaro', 3, {'ribCount': 20, 'armLength': 1.3, 'armAsymmetric': True, 'spineDensity': 0.7}),
    ('creosote', 5, {'stems': 6, 'sprayCount': 6, 'leafColorize': 0xb0c890, 'leafTintAmount': 0.3}),
    ('weepingWillow', 2, {'curtainLength': 5.0, 'scaffolds': 10}),
]


def norm(v):
    return json.loads(json.dumps(api._json_clean(v)))


def main():
    os.makedirs(OUT, exist_ok=True)
    files, py = [], {}
    for sp, seed, dials in DESIGNS:
        path = os.path.join(OUT, api.preset_file_name(sp, seed))
        api.save_preset(path, sp, seed, dials)
        files.append(path)
        loaded = api.load_preset(path)
        g = api.generate(species=loaded['species'], seed=loaded['seed'], controls=loaded['controls'], fruit=False)
        py[os.path.basename(path)] = {'stats': g['stats']['summary'], 'perLod': [l['triangles'] for l in g['stats']['perLod']],
                                      'file': json.load(open(path))}
    res = subprocess.run(['node', os.path.join(HERE, 'preset_roundtrip.mjs')] + files, capture_output=True, text=True)
    if res.returncode:
        print(res.stderr)
        return 1
    js = json.loads(res.stdout.strip().splitlines()[-1])
    fails = 0
    for name, p in py.items():
        j = js[name]
        same_tris = j['perLod'] == p['perLod']
        same_dims = all(abs(j['stats'].get(k, 0) - p['stats'].get(k, 0)) < 1e-3
                        for k in ('heightMeters', 'widthMeters', 'depthMeters'))
        same_file = norm(j['resaved']) == norm(p['file'])
        ok = same_tris and same_dims and same_file
        fails += not ok
        print('%-40s %s  tris py %s js %s  h py %.3f js %.3f  resave-identical %s' % (
            name, 'PASS' if ok else 'FAIL', p['perLod'], j['perLod'], p['stats'].get('heightMeters', 0),
            j['stats'].get('heightMeters', 0), same_file))
        if not same_file:
            a, b = norm(j['resaved'])['controls'], norm(p['file'])['controls']
            for k in sorted(set(a) | set(b)):
                if a.get(k) != b.get(k):
                    print('    %s: js %r py %r' % (k, a.get(k), b.get(k)))
    # golden dumps: the JS toPreset of each case vs Python to_preset
    gdir = os.path.join(HERE, 'out', 'golden')
    if os.path.isdir(gdir):
        for f in sorted(os.listdir(gdir)):
            doc = json.load(open(os.path.join(gdir, f)))
            c = doc['case']
            mine = api.to_preset(c['species'], c['seed'], c.get('controls') or {})
            same = norm(mine) == norm(doc['preset'])
            fails += not same
            print('%-40s %s  to_preset == JS toPreset' % (f, 'PASS' if same else 'FAIL'))
    print('preset round-trip:', 'FAIL %d' % fails if fails else 'PASS')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
