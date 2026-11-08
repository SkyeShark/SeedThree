"""The SeedThree app's own unit tests (test/*.test.js) that cover this port's LOD ladder,
card placement, willow sheets and shrub fruit, asserted on the Python port with the
JS's exact numbers:

  lod-estimator.test.js       estimate_branch_triangles == emitted triangles; dogwood flags
  mobile-lod-ramp.test.js     stable_stem_subset is exact / ordered / nested; the mobile
                              ladders' card and tube keeps
  shrub-fruit.test.js         a fruiting dichotomous shrub: real fruit on LOD0/LOD1 only
  additional-species.test.js  the willow sheet bakes (17 / 9 vines, floor clip), the
                              willow sheet LOD thinning (31 / 17 / 45 roots, nested), the
                              willow rung constants, dogwood's fork and desktop budgets

    python blender/tests/test_js_suite.py

System Python (numpy), no Blender.
"""

import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))

from seedthree import api  # noqa: E402
from seedthree.species import SPECIES  # noqa: E402
from seedthree.core.rng import Rng  # noqa: E402
from seedthree.core.vmath import V3, Q  # noqa: E402
from seedthree.core.weber_penn import generate_skeleton  # noqa: E402
from seedthree.core.branch_mesh import build_branch_geometry, estimate_branch_triangles  # noqa: E402
from seedthree.core.branch_cards import stable_stem_subset, build_card_foliage  # noqa: E402
from seedthree.core.willow_curtains import build_willow_curtains  # noqa: E402
from seedthree.core.fruit import prepared_bounds  # noqa: E402
from seedthree.core.tree import build_tree  # noqa: E402

RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok)))
    print('%s %s%s' % ('PASS' if ok else 'FAIL', name, ('  ' + detail) if detail else ''))


def levels_by_name(tree):
    return {lv['name']: lv for lv in tree['levels']}


def meta(lv):
    """A built level's userData (build_tree copies the JS's level.userData keys onto it)."""
    return {k: lv.get(k) for k in ('cardLevel', 'cardKeepFraction', 'meshTerminalKeepFraction', 'hiddenInApp', 'appOnly')}


def test_lod_estimator():
    dog = SPECIES['floweringDogwood']
    stems = generate_skeleton(dog['params'], Rng('%s:estimator' % dog['name']))['stems']
    for opts in ({}, {'radialScale': 0.72}, {'radialScale': 0.31, 'ringStride': 2}, {'radialScale': 0.1, 'ringStride': 3},
                 {'radialScale': 0.4, 'ringStride': 2, 'terminalSides': 3, 'terminalRingStride': 4}):
        g = build_branch_geometry(stems, opts)
        check('estimator %s' % opts, len(g['index']) // 3 == estimate_branch_triangles(stems, opts),
              '%d == %d' % (len(g['index']) // 3, estimate_branch_triangles(stems, opts)))
    check('dogwood preserveLod2Tips + crossedLod2Cards', dog.get('preserveLod2Tips') is True and dog.get('crossedLod2Cards') is True)


def test_mobile_lod_ramp():
    stems = [{'id': i} for i in range(100)]
    full, mid, far = (stable_stem_subset(stems, k) for k in (1, 0.5, 0.18))
    ids = [s['id'] for s in mid]
    check('stable subsets exact', (len(full), len(mid), len(far)) == (100, 50, 18), str((len(full), len(mid), len(far))))
    check('stable subsets ordered + nested', full == stems and ids == sorted(ids) and all(s in mid for s in far))
    for sp in ('paperBirch', 'quakingAspen', 'floweringDogwood'):
        t = api.generate(species=sp, seed=1, lod={'mobileTarget': True}, fruit=False)['tree']
        d = {n: meta(lv) for n, lv in levels_by_name(t).items()}
        got = [(d[n].get('cardKeepFraction'), d[n].get('meshTerminalKeepFraction')) for n in ('LOD2', 'LOD3', 'LOD4')]
        ok = got == [(1, 1), (1, 0.4), (0.4, 0.2)] and d['LOD2']['cardLevel'] == d['LOD3']['cardLevel'] == d['LOD4']['cardLevel']
        check('mobile ladder keeps %s' % sp, ok, str(got))
    t = api.generate(species='americanSycamore', seed=1, lod={'mobileTarget': True}, fruit=False)['tree']
    d = {n: meta(lv) for n, lv in levels_by_name(t).items()}
    got = [d[n].get('cardKeepFraction') for n in ('LOD2', 'LOD3', 'LOD4')]
    check('mobile ladder keeps americanSycamore', got == [1, 0.5, 0.18] and d['LOD2']['cardLevel'] == d['LOD4']['cardLevel'], str(got))


def test_shrub_fruit():
    sp = dict(SPECIES['blackbrush'], name='Fruit integration shrub',
              fruit={'mesh': 'test-fruit.glb', 'perBranch': 3, 'chance': 1, 'startFrac': 0.18, 'maxCount': 12})
    (pmin, pmax), off = prepared_bounds((-0.004, -0.006, -0.004), (0.004, 0.006, 0.004))
    assets = {'fruitBounds': (pmin, pmax), 'fruitOffset': off, 'fruitTris': 12}
    t = build_tree(sp, 7, {}, assets)
    counts = [len((lv['parts'].get('fruit') or {}).get('instances') or []) for lv in t['levels']]
    check('shrub fruit by LOD', 0 < counts[0] <= 12 and 0 < counts[1] <= 4 and counts[2] == 0, str(counts))
    t2 = build_tree(sp, 7, {}, assets)
    check('shrub fruit deterministic regrow', counts == [len((lv['parts'].get('fruit') or {}).get('instances') or [])
                                                          for lv in t2['levels']])


def test_willow_sheets():
    q = Q().set_from_unit_vectors(V3(0, 1, 0), V3(1, 0, 0))
    feeder = {'points': [V3(0, 0, 0), V3(2, 0, 0)], 'orients': [q, q.clone()], 'winds': [0.6, 0.8]}
    wf = SPECIES['weepingWillow']['foliage']
    cfg = dict(wf, spacing=0.1, floor=None, floorMin=None)
    free = build_willow_curtains([feeder], dict(cfg, disableFloor=True), Rng('willow:canonical-sheet'))
    check('willow free sheet 17 vines below the feeder', free is not None and free['vineCount'] == 17 and
          float(np.asarray(free['position'])[:, 1].min()) < 0, str(free and free['vineCount']))
    grouped = build_willow_curtains([feeder], dict(cfg, disableFloor=True, vineKeepFraction=wf['groupedCardVineKeepFraction']),
                                    Rng('willow:canonical-sheet'))
    check('willow grouped sheet 9 vines', grouped is not None and grouped['vineCount'] == 9, str(grouped and grouped['vineCount']))
    clipped = build_willow_curtains([feeder], cfg, Rng('willow:canonical-sheet'))
    check('willow floor-clipped sheet is None', clipped is None)

    n = 56
    feeders = [{'id': i, 'parentId': i // 7, 'points': [V3(i, 10, 0), V3(i + 1, 10, 0)], 'winds': [0.5, 0.7]} for i in range(n)]
    geo = {'position': np.array([(-0.5, -1, 0), (0.5, -1, 0), (0.5, 1, 0), (-0.5, 1, 0)], np.float32),
           'index': np.array([0, 1, 2, 0, 2, 3]), 'aThickness': np.zeros(4096),
           'willowBowed': {'center': (0, 0, 0), 'halfW': 0.5, 'halfH': 1, 'view': 'front', 'horizontalScale': 1,
                           'verticalScale': 1}}
    cards = {'variants': [{'geometry': geo, 'chordLen': 1, 'minY': -1, 'side': None}], 'gravityAligned': True,
             'foliageOnly': True, 'floorMin': 0}

    def roots(part):
        return {int(np.floor(m['matrices'][i][12] + 0.5)) for m in part['meshes'] for i in range(m['count'])}

    def build(keep, seed, **extra):
        return build_card_foliage(feeders, cards, Rng(seed), dict({'growScale': 1, 'keepFraction': keep, 'stableKeep': True}, **extra))
    coarse = build(1, 'willow-sheet-coarse', crossed=True, cardGrid={'cols': 4, 'rows': 5})
    mid, repeat = build(0.55, 'willow-sheet-mid'), build(0.55, 'different-rng-must-not-reshuffle')
    tuned = build(wf['groupedCardFeederKeepFraction'], 'willow-sheet-tuned')
    far = build(0.30, 'willow-sheet-far')
    rm, rr, rf = roots(mid), roots(repeat), roots(far)
    check('willow sheet thinning 31 / 17 / 45 roots', (len(rm), len(rf), len(roots(tuned))) == (31, 17, 45),
          str((len(rm), len(rf), len(roots(tuned)))))
    check('willow coarse rung: 2 x 56 cards of 24 triangles', sum(m['count'] for m in coarse['meshes']) == n * 2 and
          all(len(m['geometry']['index']) // 3 == 24 for m in coarse['meshes']))
    check('willow thinning independent of the rng, nested', rr == rm and rf <= rm)
    check('willow rung constants', SPECIES['weepingWillow'].get('lodDistanceMultipliers') == {'lod1': 2.5, 'lod2': 6.5, 'billboard': 10.5}
          and (wf['groupedCardHorizontalScale'], wf['groupedCardVerticalScale'], wf['groupedCardVineKeepFraction'],
               wf['groupedCardFeederKeepFraction']) == (0.95, 1.2, 0.5, 0.8))


def test_dogwood_budgets():
    dog = SPECIES['floweringDogwood']
    ok_all, notes = True, []
    for seed in (1, 2, 7, 13, 31):
        stems = generate_skeleton(dog['params'], Rng('%s:%d' % (dog['name'], seed)))['stems']
        bole = next(s for s in stems if s.get('role') == 'sharedBole')
        max_y = max(p.y for s in stems for p in s['points'])
        bole_ratio = bole['points'][-1].y / max_y
        g = api.generate(species='floweringDogwood', seed=seed, fruit=False)
        sm, per = g['stats']['summary'], g['stats']['perLod']
        spread = sm['widthMeters'] / sm['heightMeters']
        r1, r2 = per[1]['triangles'] / per[0]['triangles'], per[2]['triangles'] / per[0]['triangles']
        ok = 0.19 < bole_ratio < 0.27 and 1.05 < spread < 1.4 and 0.49 < r1 < 0.53 and 0.14 < r2 < 0.16
        ok_all &= ok
        notes.append('%d: fork %.3f spread %.2f LOD1 %.3f LOD2 %.3f' % (seed, bole_ratio, spread, r1, r2))
    check('dogwood low fork + desktop LOD budgets', ok_all and dog['foliage']['clustersPerBranch'] % 2 == 0, '; '.join(notes))


def main():
    for t in (test_lod_estimator, test_mobile_lod_ramp, test_shrub_fruit, test_willow_sheets, test_dogwood_budgets):
        t()
    bad = [n for n, ok in RESULTS if not ok]
    print('%d/%d PASS%s' % (len(RESULTS) - len(bad), len(RESULTS), ('; FAIL: ' + ', '.join(bad)) if bad else ''))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
