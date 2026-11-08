"""Parity of the Python SeedThree core against the JS (golden_dump.mjs output).

    node blender/tests/golden_dump.mjs          # writes blender/tests/out/golden/*.json
    python blender/tests/test_parity.py [case-substring ...]

Runs under the system Python (numpy), no Blender. For every golden case it grows
the same species/seed/dials with fruit=False (the JS headless API never loads
fruit) and compares the RNG stream, every skeleton stem, and every LOD's mesh
buffers and instance data. Prints a table and writes out/parity_report.json.
"""

import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))

from seedthree import api  # noqa: E402
from seedthree.core.rng import tree_rng  # noqa: E402
from seedthree.core.weber_penn import generate_skeleton  # noqa: E402
from seedthree.core.dichotomous import generate_dichotomous  # noqa: E402
from seedthree.core.yucca_leaves import CONES  # noqa: E402
from seedthree.species import SPECIES  # noqa: E402

GOLDEN = os.path.join(HERE, 'out', 'golden')
SKEL_TOL = 1e-9
MESH_TOL = 2e-5


def maxdiff(a, b):
    a = np.asarray(a, np.float64).reshape(-1)
    b = np.asarray(b, np.float64).reshape(-1)
    if a.shape != b.shape:
        return math.inf
    if a.size == 0:
        return 0.0
    return float(np.max(np.abs(a - b)))


def rel_maxdiff(a, b):
    a = np.asarray(a, np.float64).reshape(-1)
    b = np.asarray(b, np.float64).reshape(-1)
    if a.shape != b.shape:
        return math.inf
    if a.size == 0:
        return 0.0
    return float(np.max(np.abs(a - b) / np.maximum(1.0, np.abs(b))))


def classify(js_meshes):
    out = {'bark': None, 'cards': [], 'cones': {}, 'spines': None, 'willow': None, 'fruit': None}
    for m in js_meshes:
        a = m['attrs']
        if m['instanced'] and m['name'] == 'fruit':
            out['fruit'] = m
        elif 'aSpine' in a:
            out['spines'] = m
        elif m['instanced'] and m['name'].startswith('cone'):
            out['cones'][int(m['name'][4:])] = m
        elif m['instanced'] and m['name'] == 'foliage':
            out['cards'].append(m)
        elif m['name'] == 'willow-curtains':
            out['willow'] = m
        elif 'aStemCenter' in a and not m['instanced']:
            out['bark'] = m
    return out


def tie_flips(js_index, py):
    """Quads (6 indices each in the welded dichotomous mesh) whose diagonal split
    differs. Returns (differing quads, how many of them are exact ties: both
    diagonals equal to 1e-9, where the JS and Python choice is last-bit float noise)."""
    P = py.get('position64')
    if P is None or len(js_index) != len(py['index']) or len(js_index) % 6:
        return None
    J = np.asarray(js_index).reshape(-1, 6)
    Q = py['index'].reshape(-1, 6)
    diff = np.where((J != Q).any(1))[0]
    ties = 0
    for qi in diff:
        t = Q[qi]
        a0, b0 = t[0], t[1]
        if t[3] == t[2]:      # (a0,b0,a1),(a1,b0,b1)
            a1, b1 = t[2], t[5]
        else:                 # (a0,b0,b1),(a0,b1,a1)
            b1, a1 = t[2], t[5]
        d1 = float(np.sum((P[a1] - P[b0]) ** 2))
        d2 = float(np.sum((P[a0] - P[b1]) ** 2))
        if abs(d1 - d2) <= 1e-9 * max(d1, d2, 1e-30):
            ties += 1
    return len(diff), ties


def cmp_bark(js, py):
    r = {}
    r['verts'] = (len(js['attrs']['position']['array']) // 3, len(py['position']))
    r['index_equal'] = bool(np.array_equal(np.asarray(js['index']), py['index']))
    if not r['index_equal']:
        r['tieFlips'] = tie_flips(js['index'], py)
    r['position'] = maxdiff(js['attrs']['position']['array'], py['position'])
    r['uv'] = rel_maxdiff(js['attrs']['uv']['array'], py['uv'])
    r['normal'] = maxdiff(js['attrs']['normal']['array'], py['normal'])
    r['aWind'] = maxdiff(js['attrs']['aWind']['array'], py['aWind'])
    r['aStemCenter'] = maxdiff(js['attrs']['aStemCenter']['array'], py['aStemCenter'])
    return r


def cmp_cards(js, py):
    r = {'count': (js['count'], py['count'])}
    if js['count'] != py['count']:
        return r
    r['matrix'] = maxdiff(js['instanceMatrix'], py['matrices'].astype(np.float32))
    r['aThickness'] = maxdiff(js['attrs']['aThickness']['array'][:py['count']], py['thickness'])
    r['aWindVec'] = maxdiff(js['attrs']['aWindVec']['array'][:py['count'] * 3], py['windVec'])
    r['aAnchorPos'] = maxdiff(js['attrs']['aAnchorPos']['array'][:py['count'] * 3], py['anchor'])
    return r


def cmp_cones(js_cones, py):
    r = {'types': 0, 'instances': [0, 0], 'matrix': 0.0, 'aPack': 0.0, 'aTanSpan': 0.0, 'aAnchorPos': 0.0, 'count_mismatch': []}
    for ci in range(len(CONES)):
        lst = py['slots'][ci] if py else []
        jm = js_cones.get(ci)
        jn = jm['count'] if jm else 0
        r['instances'][0] += jn
        r['instances'][1] += len(lst)
        if jn != len(lst):
            r['count_mismatch'].append((ci, jn, len(lst)))
            continue
        if not jn:
            continue
        r['types'] += 1
        r['matrix'] = max(r['matrix'], maxdiff(jm['instanceMatrix'], np.array([s['matrix'] for s in lst], np.float32)))
        pack = np.array([[s['wind'], s['windTail'], s['age'], s['thickness']] for s in lst])
        r['aPack'] = max(r['aPack'], maxdiff(np.asarray(jm['attrs']['aPack']['array'][:jn * 4]), pack))
        ts = np.array([list(s['tangent']) + [s['span']] for s in lst])
        r['aTanSpan'] = max(r['aTanSpan'], maxdiff(np.asarray(jm['attrs']['aTanSpan']['array'][:jn * 4]), ts))
        an = np.array([[s['pos'].x, s['pos'].y, s['pos'].z] for s in lst])
        r['aAnchorPos'] = max(r['aAnchorPos'], maxdiff(np.asarray(jm['attrs']['aAnchorPos']['array'][:jn * 3]), an))
    return r


def cmp_plain(js, py, keys):
    r = {'verts': (len(js['attrs']['position']['array']) // 3, len(py['position']))}
    r['index_equal'] = bool(np.array_equal(np.asarray(js['index']), py['index']))
    for jk, pk in keys:
        if jk in js['attrs']:
            r[jk] = maxdiff(js['attrs'][jk]['array'], py[pk])
    return r


def run_case(path):
    doc = json.load(open(path))
    case = doc['case']
    sp = SPECIES[case['species']]
    seed = case['seed']
    res = {'case': os.path.basename(path)}
    rng = tree_rng(sp['name'], seed)
    res['rng16'] = maxdiff(doc['rngFirst16'], [rng.next() for _ in range(16)])

    t0 = time.perf_counter()
    # fruit=True: the golden dump grows the orchard cases through the app's fruit path
    out = api.generate(species=case['species'], seed=seed, controls=case.get('controls') or {}, fruit=True)
    res['py_ms'] = round((time.perf_counter() - t0) * 1000)
    res['js_ms'] = round(doc['ms'])
    tree = out['tree']

    # skeleton (independent of the meshing)
    shaped = out['shaped']
    if sp.get('foliageType') in ('rosette', 'sprayClusters'):
        fol = shaped.get('foliage') or {}
        leaf = fol.get('leafLen') if fol.get('leafLen') is not None else fol.get('clusterSize')
        stems = generate_dichotomous(dict(shaped['params'], tipClearance=(0.5 if leaf is None else leaf) * 0.9),
                                     tree_rng(sp['name'], seed))['stems']
    else:
        stems = generate_skeleton(shaped['params'], tree_rng(sp['name'], seed))['stems']
    js_stems = doc['stems']
    res['stems'] = (len(js_stems), len(stems))
    sk = {'points': 0.0, 'radii': 0.0, 'orients': 0.0, 'winds': 0.0, 'levels_equal': True}
    if len(js_stems) == len(stems):
        for a, b in zip(js_stems, stems):
            sk['levels_equal'] &= a['level'] == b['level']
            sk['points'] = max(sk['points'], maxdiff(a['points'], [c for p in b['points'] for c in (p.x, p.y, p.z)]))
            sk['radii'] = max(sk['radii'], maxdiff(a['radii'], b['radii']))
            if a['orients']:
                qb = []
                for q in b['orients']:
                    qb += [q.x, q.y, q.z, q.w]
                sk['orients'] = max(sk['orients'], maxdiff(a['orients'], qb))
            sk['winds'] = max(sk['winds'], maxdiff(a['winds'], b['winds']))
    res['skeleton'] = sk

    res['levels'] = []
    for jl, pl in zip(doc['levels'], tree['levels']):
        c = classify(jl['meshes'])
        parts = pl['parts']
        lr = {'name': jl['name']}
        if c['bark'] is not None:
            lr['bark'] = cmp_bark(c['bark'], parts['bark'])
        fol = parts.get('foliage')
        if c['cards']:
            members = fol['members'] if fol and fol.get('kind') == 'cardsGroup' else ([fol] if fol else [])
            lr['cards'] = [cmp_cards(j, p) for j, p in zip(c['cards'], members)]
            if len(c['cards']) != len(members):
                lr['cards'].append({'card_sets': (len(c['cards']), len(members))})
        if c['cones']:
            lr['cones'] = cmp_cones(c['cones'], fol)
        if c['willow'] is not None:
            lr['willow'] = cmp_plain(c['willow'], fol, [('position', 'position'), ('uv', 'uv'), ('aThickness', 'aThickness')])
        if c['spines'] is not None:
            lr['spines'] = cmp_plain(c['spines'], parts['spines'], [('position', 'position'), ('normal', 'normal'), ('uv', 'uv')])
        if c['fruit'] is not None or parts.get('fruit'):
            jf, pf = c['fruit'], parts.get('fruit')
            jn, pn = (jf['count'] if jf else 0), (len(pf['instances']) if pf else 0)
            fr = {'count': (jn, pn)}
            if jn == pn and jn:
                fr['matrix'] = maxdiff(jf['instanceMatrix'], np.array([s['matrix'] for s in pf['instances']], np.float32))
                fr['aWindVec'] = maxdiff(jf['attrs']['aWindVec']['array'][:jn * 3], [v for s in pf['instances'] for v in s['windVec']])
                fr['aAnchorPos'] = maxdiff(jf['attrs']['aAnchorPos']['array'][:jn * 3], [v for s in pf['instances'] for v in s['anchor']])
            lr['fruit'] = fr
        res['levels'].append(lr)

    js_stats, py_stats = doc['stats'], out['stats']
    res['stats'] = {
        'js': {**js_stats['summary'], 'perLod': [l['triangles'] for l in js_stats['perLod']]},
        'py': {**py_stats['summary'], 'perLod': [l['triangles'] for l in py_stats['perLod']]},
    }
    return res


def verdict(res):
    bad = []
    if res['rng16'] > 0:
        bad.append('rng')
    if res['stems'][0] != res['stems'][1]:
        bad.append('stem count %s' % (res['stems'],))
    sk = res['skeleton']
    if max(sk['points'], sk['radii'], sk['orients'], sk['winds']) > SKEL_TOL or not sk['levels_equal']:
        bad.append('skeleton %.2e' % max(sk['points'], sk['radii'], sk['orients'], sk['winds']))
    for lv in res['levels']:
        b = lv.get('bark')
        if b:
            tf = b.get('tieFlips')
            only_ties = tf is not None and tf[0] == tf[1]
            if b['verts'][0] != b['verts'][1] or (not b['index_equal'] and not only_ties):
                bad.append('%s bark topology %s idx=%s ties=%s' % (lv['name'], b['verts'], b['index_equal'], tf))
            elif max(b['position'], b['aWind'], b['aStemCenter'], b['uv']) > MESH_TOL:
                bad.append('%s bark %.2e' % (lv['name'], max(b['position'], b['aWind'], b['aStemCenter'], b['uv'])))
            elif b['normal'] > 1e-3 and not only_ties:
                bad.append('%s bark normals %.1e' % (lv['name'], b['normal']))
        for cc in lv.get('cards', []):
            if 'card_sets' in cc:
                bad.append('%s card sets %s' % (lv['name'], cc['card_sets']))
            elif cc['count'][0] != cc['count'][1]:
                bad.append('%s cards %s' % (lv['name'], cc['count']))
            elif max(cc['matrix'], cc['aThickness'], cc['aWindVec'], cc['aAnchorPos']) > MESH_TOL:
                bad.append('%s cards %.2e' % (lv['name'], max(cc['matrix'], cc['aThickness'], cc['aWindVec'], cc['aAnchorPos'])))
        co = lv.get('cones')
        if co:
            if co['count_mismatch']:
                bad.append('%s cones %s' % (lv['name'], co['count_mismatch'][:3]))
            elif max(co['matrix'], co['aPack'], co['aTanSpan'], co['aAnchorPos']) > MESH_TOL:
                bad.append('%s cones %.2e' % (lv['name'], max(co['matrix'], co['aPack'], co['aTanSpan'], co['aAnchorPos'])))
        fr = lv.get('fruit')
        if fr:
            if fr['count'][0] != fr['count'][1]:
                bad.append('%s fruit count %s' % (lv['name'], fr['count']))
            elif fr['count'][0] and max(fr['matrix'], fr['aWindVec'], fr['aAnchorPos']) > MESH_TOL:
                bad.append('%s fruit %.2e' % (lv['name'], max(fr['matrix'], fr['aWindVec'], fr['aAnchorPos'])))
        for key in ('willow', 'spines'):
            w = lv.get(key)
            if w:
                if w['verts'][0] != w['verts'][1] or not w['index_equal']:
                    bad.append('%s %s topology %s' % (lv['name'], key, w['verts']))
                else:
                    m = max(v for k, v in w.items() if isinstance(v, float))
                    if m > MESH_TOL * 5:
                        bad.append('%s %s %.2e' % (lv['name'], key, m))
    return bad


def main():
    filt = sys.argv[1:]
    files = sorted(f for f in os.listdir(GOLDEN) if f.endswith('.json'))
    if filt:
        files = [f for f in files if any(s in f for s in filt)]
    report = []
    fails = 0
    for f in files:
        res = run_case(os.path.join(GOLDEN, f))
        bad = verdict(res)
        res['verdict'] = 'PASS' if not bad else 'FAIL'
        res['problems'] = bad
        report.append(res)
        fails += bool(bad)
        st = res['stats']
        print('%-28s %s  stems %s  LOD tris js %s py %s  h js %.3f py %.3f  w js %.3f py %.3f  %d ms (js %d)' % (
            f, res['verdict'], res['stems'][1], st['js']['perLod'], st['py']['perLod'],
            st['js'].get('heightMeters', 0), st['py'].get('heightMeters', 0),
            st['js'].get('widthMeters', 0), st['py'].get('widthMeters', 0), res['py_ms'], res['js_ms']))
        for b in bad:
            print('    -', b)
        ties = [(lv['name'], lv['bark']['tieFlips']) for lv in res['levels'] if lv.get('bark', {}).get('tieFlips')]
        if ties:
            print('    note: diagonal ties split the other way (quads differing, of which exact ties): %s' % ties)
    os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
    with open(os.path.join(HERE, 'out', 'parity_report.json'), 'w') as fh:
        json.dump(report, fh, indent=1, default=str)
    print('%d/%d cases pass' % (len(files) - fails, len(files)))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
