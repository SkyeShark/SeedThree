"""Parity of the round-two Python port against the JS (golden_dump_lods.mjs output):
the branch-card and rosette-card bakes (exemplar framings, card quads, bowed willow
sheets, per-instance thickness), the desktop card LOD2, the mobile ladders (temperate,
willow, guide, rosette, cactus, shrub) and the hangingSprays foliage mode.

    node blender/tests/golden_dump_lods.mjs        # writes blender/tests/out/golden_lods/*.json
    python blender/tests/test_parity_lods.py [case-substring ...]

System Python (numpy), no Blender. Prints PASS/FAIL per case and per check.
"""

import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))
sys.path.insert(0, HERE)

from seedthree import api  # noqa: E402
from seedthree.core.tree import build_tree  # noqa: E402
from seedthree.core.branch_cards import prepare_branch_cards, prepare_rosette_cards  # noqa: E402
from seedthree.species import SPECIES  # noqa: E402
from test_parity import cmp_bark, cmp_cones, cmp_plain, maxdiff, MESH_TOL  # noqa: E402

GOLDEN = os.path.join(HERE, 'out', 'golden_lods')
PROBE_CAM = {'left': -1, 'right': 1, 'top': 1, 'bottom': -1, 'near': 0.1, 'far': 10}


def grow(case):
    sp = SPECIES[case['species']]
    shaped, merged = api.shaped_species(case['species'], {}, case['seed'])
    if case.get('foliage'):
        shaped['foliage'] = dict(shaped['foliage'], **case['foliage'])
    assets = api.fruit_assets(shaped)
    cards = None
    lod = dict(case['lod'])
    if case.get('cards'):
        max_level = (shaped['params'].get('levels') or 3) - 1
        if sp.get('foliageType') == 'rosette':
            if lod.get('mobileTarget') and not sp.get('cactus'):
                cards = prepare_rosette_cards(shaped, {'size': 16, 'variants': 3})
        else:
            willow = (shaped.get('foliage') or {}).get('mode') == 'willowCurtains'
            crossed = bool(shaped.get('crossedLod2Cards'))
            job = ({'gravityAligned': True, 'crossViews': True, 'noFlutter': True} if willow
                   else {'crossViews': crossed, 'noFlutter': crossed})
            s = prepare_branch_cards(shaped, dict(job, size=16, variants=3, cardLevel=max_level, foliageOnly=True),
                                     assets.get('fruitBounds'))
            if s:
                cards = {'byLevel': {'%d:fol' % max_level: s}, 'variants': s['variants']}
    if cards:
        lod['branchCards'] = cards
    tree = build_tree(shaped, case['seed'], lod, assets)
    return tree, cards


def cmp_geo(j, p):
    if j is None or p is None:
        return math.inf if (j is None) != (p is None) else 0.0
    m = 0.0
    for k in ('position', 'normal', 'uv', 'aThickness'):
        if k in j:
            m = max(m, maxdiff(j[k], p[k]))
    if j.get('index') is not None and not np.array_equal(np.asarray(j['index']), np.asarray(p['index'])):
        return math.inf
    return m


def run(path):
    doc = json.load(open(path))
    case = doc['case']
    tree, cards = grow(case)
    bad, notes = [], []

    # bakes: framings and card geometry
    if doc.get('bakes') is not None:
        cams = [c for c in doc['cameras'] if not all(abs(c[k] - v) < 1e-12 for k, v in PROBE_CAM.items())]
        pv = cards['variants']
        if len(pv) != len(doc['bakes']):
            bad.append('variants %d vs %d' % (len(doc['bakes']), len(pv)))
        else:
            py_cams = [v for var in pv for v in var['views']]
            if len(py_cams) != len(cams):
                bad.append('bake views %d vs %d' % (len(cams), len(py_cams)))
            else:
                worst = 0.0
                for jc, v in zip(cams, py_cams):
                    pos = np.array(v['center']) + np.array(v['dir']) * v['depth']
                    worst = max(worst, abs(jc['right'] - v['halfW']), abs(jc['left'] + v['halfW']),
                                abs(jc['top'] - v['halfH']), abs(jc['bottom'] + v['halfH']),
                                abs(jc['far'] - v['far']), maxdiff(jc['position'], pos))
                notes.append('framing %.1e' % worst)
                if worst > 1e-9:
                    bad.append('framing %.2e' % worst)
            worst = 0.0
            for jb, v in zip(doc['bakes'], pv):
                worst = max(worst, abs(jb['chordLen'] - v['chordLen']), cmp_geo(jb['geometry'], v['geometry']),
                            cmp_geo(jb['side'], v['side']['geometry'] if v.get('side') else None))
                if jb.get('minY') is not None and v.get('minY') is not None:
                    worst = max(worst, abs(jb['minY'] - v['minY']))
            notes.append('card geometry %.1e' % worst)
            if worst > MESH_TOL:
                bad.append('card geometry %.2e' % worst)

    py_levels = {l['name']: l for l in tree['levels']}
    for jl in doc['levels']:
        pl = py_levels.get(jl['name'])
        if pl is None:
            bad.append('missing level %s' % jl['name'])
            continue
        tag = jl['name']
        ud = jl['userData']
        for k in ('hiddenInApp', 'appOnly'):
            if bool(ud[k]) != bool(pl.get(k)):
                bad.append('%s %s %s vs %s' % (tag, k, ud[k], pl.get(k)))
        for k in ('cardLevel', 'cardKeepFraction', 'meshTerminalKeepFraction'):
            if ud.get(k) is not None and (pl.get(k) is None or abs(ud[k] - pl[k]) > 1e-12):
                bad.append('%s %s %s vs %s' % (tag, k, ud[k], pl.get(k)))
        parts = pl['parts']
        cards_js = [m for m in jl['meshes'] if m['instanced'] and m['name'].startswith('cards')]
        bark_js = [m for m in jl['meshes'] if not m['instanced'] and 'aStemCenter' in m['attrs'] and 'aSpine' not in m['attrs']]
        if bark_js:
            b = cmp_bark(bark_js[0], parts['bark'])
            tf = b.get('tieFlips')
            only_ties = tf is not None and tf[0] == tf[1]
            if b['verts'][0] != b['verts'][1] or (not b['index_equal'] and not only_ties):
                bad.append('%s bark topology %s ties %s' % (tag, b['verts'], tf))
            elif max(b['position'], b['aWind'], b['aStemCenter'], b['uv']) > MESH_TOL:
                bad.append('%s bark %.2e' % (tag, max(b['position'], b['aWind'], b['aStemCenter'], b['uv'])))
        fol = parts.get('foliage')
        if cards_js:
            pm = fol['meshes'] if fol and fol.get('kind') == 'cardSet' else []
            if len(pm) != len(cards_js):
                bad.append('%s card meshes %d vs %d' % (tag, len(cards_js), len(pm)))
            else:
                worst = 0.0
                for j, p in zip(cards_js, pm):
                    if j['count'] != p['count'] or j['name'] != p['name']:
                        bad.append('%s %s count %s vs %s %s' % (tag, j['name'], j['count'], p['name'], p['count']))
                        continue
                    n = p['count']
                    worst = max(worst, maxdiff(j['instanceMatrix'], p['matrices'].astype(np.float32)),
                                maxdiff(j['attrs']['aWindVec']['array'], p['windVec']),
                                maxdiff(j['attrs']['aAnchorPos']['array'], p['anchor']),
                                maxdiff(j['attrs']['aThickness']['array'][:n], p['thickness']),
                                maxdiff(j['attrs']['position']['array'], p['geometry']['position']))
                    if j['castShadow'] != p['castShadow'] or j['receiveShadow'] != p['receiveShadow']:
                        bad.append('%s %s shadow policy' % (tag, j['name']))
                notes.append('%s cards %d meshes %.1e' % (tag, len(pm), worst))
                if worst > MESH_TOL:
                    bad.append('%s cards %.2e' % (tag, worst))
        else:
            leaf_js = [m for m in jl['meshes'] if m['instanced'] and m['name'] == 'foliage']
            members = fol['members'] if fol and fol.get('kind') == 'cardsGroup' else ([fol] if fol and fol.get('kind') == 'cards' else [])
            if len(leaf_js) != len(members):
                bad.append('%s leaf sets %d vs %d' % (tag, len(leaf_js), len(members)))
            for j, p in zip(leaf_js, members):
                if j['count'] != p['count']:
                    bad.append('%s leaves %d vs %d' % (tag, j['count'], p['count']))
                    continue
                m = max(maxdiff(j['instanceMatrix'], p['matrices'].astype(np.float32)),
                        maxdiff(j['attrs']['aWindVec']['array'], p['windVec']),
                        maxdiff(j['attrs']['aThickness']['array'][:p['count']], p['thickness']),
                        maxdiff(j['attrs']['position']['array'], p['template']['position']))
                if m > MESH_TOL:
                    bad.append('%s leaves %.2e' % (tag, m))
            cones_js = {int(m['name'][4:]): m for m in jl['meshes'] if m['instanced'] and m['name'].startswith('cone')}
            if cones_js or (fol and fol.get('kind') == 'cones'):
                co = cmp_cones(cones_js, fol if fol and fol.get('kind') == 'cones' else None)
                if co['count_mismatch']:
                    bad.append('%s cones %s' % (tag, co['count_mismatch'][:3]))
                elif max(co['matrix'], co['aPack'], co['aTanSpan'], co['aAnchorPos']) > MESH_TOL:
                    bad.append('%s cones %.2e' % (tag, max(co['matrix'], co['aPack'], co['aTanSpan'], co['aAnchorPos'])))
            willow_js = [m for m in jl['meshes'] if m['name'] == 'willow-curtains']
            if willow_js:
                w = cmp_plain(willow_js[0], fol, [('position', 'position'), ('uv', 'uv'), ('aThickness', 'aThickness')])
                if w['verts'][0] != w['verts'][1] or not w['index_equal']:
                    bad.append('%s willow topology %s' % (tag, w['verts']))
        spines_js = [m for m in jl['meshes'] if 'aSpine' in m['attrs']]
        if bool(spines_js) != bool(parts.get('spines')):
            bad.append('%s spines present js=%s py=%s' % (tag, bool(spines_js), bool(parts.get('spines'))))
        elif spines_js:
            s = cmp_plain(spines_js[0], parts['spines'], [('position', 'position'), ('uv', 'uv')])
            if s['verts'][0] != s['verts'][1]:
                bad.append('%s spines %s' % (tag, s['verts']))
        fr_js = [m for m in jl['meshes'] if m['instanced'] and m['name'] == 'fruit']
        pf = parts.get('fruit')
        jn, pn = (fr_js[0]['count'] if fr_js else 0), (len(pf['instances']) if pf else 0)
        if jn != pn:
            bad.append('%s fruit %d vs %d' % (tag, jn, pn))
    return bad, notes


def main():
    filt = sys.argv[1:]
    files = sorted(f for f in os.listdir(GOLDEN) if f.endswith('.json'))
    if filt:
        files = [f for f in files if any(s in f for s in filt)]
    fails = 0
    for f in files:
        bad, notes = run(os.path.join(GOLDEN, f))
        fails += bool(bad)
        print('%-44s %s  %s' % (f, 'PASS' if not bad else 'FAIL', '; '.join(notes)))
        for b in bad[:12]:
            print('    -', b)
    print('%d/%d cases pass' % (len(files) - fails, len(files)))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
