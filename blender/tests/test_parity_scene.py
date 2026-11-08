"""Parity of the demo-scene port against the JS (golden_dump_scene.mjs output): the terrain
sampler, rocks / scree, fallen limbs, grass, scrub, the cattail clump, cloud placements
and noise, and the forest slots.

    node blender/tests/golden_dump_scene.mjs
    python blender/tests/test_parity_scene.py

System Python (numpy), no Blender.
"""

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))

from seedthree.core.terrain_noise import make_height_sampler  # noqa: E402
from seedthree.core import scatter as SC  # noqa: E402
from seedthree.core.cloud_noise import cloud_noise, cloud_placements  # noqa: E402
from seedthree.core.forest import forest_slots  # noqa: E402

TOL = 2e-5
fails = 0


def check(name, ok, detail=''):
    global fails
    fails += not ok
    print('%s %s%s' % ('PASS' if ok else 'FAIL', name, (': ' + detail) if detail else ''))


def md(a, b):
    a, b = np.asarray(a, np.float64).ravel(), np.asarray(b, np.float64).ravel()
    return float(np.max(np.abs(a - b))) if a.shape == b.shape and a.size else (0.0 if a.size == b.size == 0 else np.inf)


def main():
    doc = json.load(open(os.path.join(HERE, 'out', 'golden_scene', 'scene.json')))
    smp = make_height_sampler(1, 280, 15, 12)
    P = np.array(doc['sampler']['pts'])
    for key, fn in (('height', smp.height_at), ('rock', smp.rockness_at), ('meadow', smp.meadow_at)):
        d = md(doc['sampler'][key], fn(P[:, 0], P[:, 1]))
        check('terrain %s' % key, d < 1e-12, '%.1e' % d)
    variants, per, scree_geo, scree = SC.rock_scatter(smp, 1, 15, 32, 12000)
    js = doc['rocks']
    py = [(v, m) for v, m in zip(variants, per) if m] + [(scree_geo, scree)]
    check('rock meshes', len(js) == len(py), '%d vs %d' % (len(js), len(py)))
    for i, (j, (g, mats)) in enumerate(zip(js, py)):
        check('rock set %d count' % i, j['count'] == len(mats), '%d vs %d' % (j['count'], len(mats)))
        if j['count'] == len(mats):
            check('rock set %d matrices' % i, md(j['matrices'], np.array(mats, np.float32)) < TOL,
                  '%.1e' % md(j['matrices'], np.array(mats, np.float32)))
            # three's mergeVertices also compares UVs, so the icosphere's UV seam stays split in the
            # JS (183 / 57 vertices); compare the displaced positions as sets
            jp = np.unique(np.round(np.array(j['position']).reshape(-1, 3), 5), axis=0)
            pp = np.unique(np.round(np.asarray(g['position']), 5), axis=0)
            same = len(jp) == len(pp)
            check('rock set %d geometry (unique positions)' % i, same and md(jp, pp) < 2e-5,
                  '%d vs %d unique, %.1e' % (len(jp), len(pp), md(jp, pp) if same else -1))
    lv, lper = SC.limb_scatter(smp, 1, 15, 16)
    for i, (j, g, mats) in enumerate(zip(doc['limbs'], lv, lper)):
        ok = j['count'] == len(mats)
        check('limb %d placements' % i, ok and md(j['matrices'], np.array(mats, np.float32)) < 1e-4,
              '%d vs %d %.1e' % (j['count'], len(mats), md(j['matrices'], np.array(mats, np.float32)) if ok else -1))
        jp = np.array(j['position']).reshape(-1, 3)
        check('limb %d geometry' % i, len(jp) == len(g['position']) and md(jp, g['position']) < 1e-5,
              '%d vs %d verts' % (len(jp), len(g['position'])))
    gv = SC.grass_scatter(smp, 1, 15, 13000)
    for i, (j, v) in enumerate(zip(doc['grass'], gv)):
        ok = j['count'] == len(v['mats'])
        check('grass %d' % i, ok and md(j['matrices'], np.array(v['mats'], np.float32)) < TOL and
              md(j['inst']['aTint'], v['tint']) < 1e-6, '%d vs %d' % (j['count'], len(v['mats'])))
        check('grass %d geometry' % i, md(j['position'], v['geo']['position']) < 1e-6)
    smpD = make_height_sampler(7, 280, 15, 12)
    defs = [dict(base='sagebrush', tint=(0.62, 0.68, 0.52), height=0.55, share=1.1, quads=9),
            dict(base='blackbrush', tint=(0.40, 0.42, 0.47), height=0.48, share=1.0, quads=8),
            dict(base='creosote', tint=(0.50, 0.62, 0.40), height=0.80, share=0.9, quads=7)]
    sb = SC.scrub_scatter(smpD, defs, 7, 15, 2600)
    for i, (j, b) in enumerate(zip(doc['scrub'], sb)):
        ok = j['count'] == len(b['mats'])
        check('scrub %d' % i, ok and md(j['matrices'], np.array(b['mats'], np.float32)) < TOL and
              md(j['inst']['aTint'], b['tint']) < 1e-6 and md(j['position'], b['geo']['position']) < 1e-6,
              '%d vs %d' % (j['count'], len(b['mats'])))
    from seedthree.core.scatter import card_clump_geometry
    cg = card_clump_geometry({'quads': 4, 'width': 0.78, 'tiltMin': 0.025, 'tiltSpan': 0.12, 'heightMin': 0.9,
                              'heightSpan': 0.2, 'baseSpread': 0.08})
    check('cattail clump geometry', md(doc['cattail']['position'], cg['position']) < 1e-6 and
          md(doc['cattail']['uv'], cg['uv']) < 1e-6)
    cp = cloud_placements(8, 190, 85)
    check('cloud placements', md([c['pos'] + c['scale'] for c in doc['clouds']],
                                 [list(c['pos']) + list(c['scale']) for c in cp]) < 1e-9)
    n24 = cloud_noise(24)
    d = np.abs(np.array(doc['cloudNoise24']) - n24.astype(np.int64))
    check('cloud noise texture (24^3, uint8)', int(d.max()) == 0, 'max |diff| %d, %d differ' % (d.max(), (d > 0).sum()))
    sl = forest_slots(64, 1, smp.height_at, smp.meadow_at, (0.0, 6.0, 0.0))
    check('forest slots', md([s['mtx'] for s in doc['forest']], [s['matrix'] for s in sl]) < 1e-9 and
          md([s['origin'] for s in doc['forest']], [s['origin'] for s in sl]) < 1e-9)
    print('%s scene parity' % ('ALL PASS' if not fails else '%d FAIL' % fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
