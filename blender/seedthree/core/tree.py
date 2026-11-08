"""Tree assembly and the LOD logic, ported from src/core/tree.js (buildTree,
buildDichotomousTree, lodLevels): the desktop ladder, the baked-card LOD2, and
the mobile performance ladder (mobileTarget: LOD0/LOD1 kept as hidden bake
sources, the card LOD2 promoted to the near view, two app-only card rungs LOD3
and LOD4; rosette and cactus species get their own mobile rungs with skirtToBark,
thatch bark and terminal rosette cards).

build_tree(shaped_species, seed, opts, assets) -> {
    'levels': [ {name, distance, hiddenInApp, appOnly, thatchBark, cardLevel, ...,
                 parts: {bark, foliage, spines, fruit}, leafInstances} ],
    'stems', 'tips', 'plantSink', 'generator' }

opts are the JS lodOpts: meshQuality, lod0Density, lod1Dist, lod2Dist, lod1Pct, lod2Pct,
lod1Density, lod2Density, lod1Prune, lod2Prune, mobileTarget, and branchCards: a card
set from core/branch_cards.prepare_branch_cards (or {'byLevel': {'<level>:fol': set}}),
or prepare_rosette_cards for rosette species. Without branchCards the card levels
fall back to cluster sprays (the JS headless behaviour). Every part is plain data in
three's Y-up tree frame (bl/meshes.py converts to Blender).
"""

import math

from .rng import tree_rng
from .jsutil import nz
from .vmath import js_round
from .weber_penn import generate_skeleton
from .branch_mesh import build_branch_geometry, estimate_branch_triangles
from .leaf_cards import build_foliage, keep_spray_subset
from .dichotomous import generate_dichotomous, build_merged_mesh, stem_foliage_view
from .yucca_leaves import build_yucca_foliage, cone_geo
from .cactus_spines import build_cactus_spines
from .fruit import build_fruits
from .branch_cards import build_card_foliage, stable_stem_subset, card_set_tris

MESHQ_DEFAULT = 0.8


def _tris(part):
    """Triangle count of a built part (instanced parts count every instance)."""
    if part is None:
        return 0
    kind = part.get('kind')
    if kind == 'cards':
        return (len(part['template']['index']) // 3) * part['count']
    if kind == 'cardSet':
        return card_set_tris(part)
    if kind == 'cones':
        rseg = part['coneRadialSegs']
        total = 0
        for ci, lst in enumerate(part['slots']):
            if lst:
                total += (len(cone_geo(ci, rseg)['index']) // 3) * len(lst)
        return total
    if kind == 'fruit':
        return part.get('trisPer', 0) * len(part['instances'])
    return len(part['index']) // 3


def _card_set(branch_cards, key, card_level):
    """lodOpts.branchCards.byLevel lookup with the JS fallbacks."""
    by = branch_cards.get('byLevel') if isinstance(branch_cards, dict) else None
    if by:
        return by.get(key) or by.get('%s:full' % card_level) or branch_cards
    return branch_cards


def lod_levels(species, opts=None):
    opts = opts or {}
    f = species.get('foliage') or {}
    max_l = nz((species.get('params') or {}).get('levels'), 3) - 1
    willow = f.get('mode') == 'willowCurtains'
    q = min(1, nz(opts.get('meshQuality'), MESHQ_DEFAULT) / MESHQ_DEFAULT)
    leaves_on = nz(f.get('leavesPerBranch'), 1) > 0
    if f.get('mode') == 'hangingSprays' or willow:
        clusters = dict(f, leavesPerBranch=nz(f.get('leavesPerBranch'), 1) if leaves_on else 0)
    else:
        clusters = dict(f, mode='clusters', clustersPerBranch=nz(f.get('clustersPerBranch'), 3) if leaves_on else 0)
    pct1 = nz(opts.get('lod1Pct'), 50) / 100
    pct2 = nz(opts.get('lod2Pct'), 15) / 100
    keep2 = nz(opts.get('lod2Density'), 1)
    base = [
        {'name': 'LOD0', 'distance': 0, 'radialScale': q, 'ringStride': 1, 'foliage': f},
        {
            'name': 'LOD1', 'distance': nz(opts.get('lod1Dist'), 35), 'budgetFrac': pct1,
            'radialScale': q * pct1, 'ringStride': 2 if pct1 < 0.3 else 1,
            'prune': nz(opts.get('lod1Prune'), 0),
            'foliage': dict(f, leavesPerBranch=(max(1, js_round(nz(f.get('leavesPerBranch'), 14) * pct1 * nz(opts.get('lod1Density'), 1))) if leaves_on else 0),
                            size=nz(f.get('size'), 0.55) * 1.0),
        },
        {
            'name': 'LOD2', 'distance': nz(opts.get('lod2Dist'), 70), 'budgetFrac': pct2,
            'radialScale': min(1, q * pct2 * 2.4), 'ringStride': 2, 'keepTwigs': True,
            'prune': 0 if species.get('preserveLod2Tips') else nz(opts.get('lod2Prune'), 0.35),
            'foliage': clusters,
            'cards': {'growScale': 1.0, 'keepFraction': keep2, 'crossed': bool(species.get('crossedLod2Cards'))},
        },
    ]
    if willow:
        lod1_segments = max(6, min(nz(f.get('segments'), 12), 7))
        lod1_keep = max(0, min(1, nz(opts.get('lod1Density'), 1)))
        base[1]['prune'] = 0
        base[1]['foliage'] = dict(f, segments=lod1_segments, vineKeepFraction=lod1_keep,
                                  vinesPerMeter=nz(f.get('vinesPerMeter'), 9))
        base[2].update({'cardLevel': max_l, 'prune': 0, 'cards': {
            'growScale': 1, 'keepFraction': keep2, 'crossed': True, 'gravityAligned': True, 'stableKeep': True,
            'floorMin': nz(f.get('floorMin'), 0.28)}})
    if not opts.get('mobileTarget'):
        return base

    # MOBILE PERFORMANCE TARGET: LOD0/LOD1 stay built (bake source + what the dials edit)
    # but are hiddenInApp; LOD2's cards become the near view; LOD3/LOD4 are app-only rungs.
    base[0]['hiddenInApp'] = True
    base[1]['hiddenInApp'] = True
    guide_level = species.get('guideLevel')
    if guide_level is None and species.get('terminalStemsAreGuides'):
        guide_level = max_l

    def rung(name, dist, card_level, keep_twigs, radial_scale, ring_stride, keep, prune):
        return {
            'name': name, 'distance': dist, 'prune': prune, 'cardLevel': card_level, 'keepTwigs': keep_twigs,
            'radialScale': max(0.15, min(1, radial_scale * q)), 'ringStride': ring_stride,
            'appOnly': name in ('LOD3', 'LOD4'), 'foliage': clusters, 'budgetFrac': 0,
            'cards': {'growScale': 1.0, 'keepFraction': keep,
                      'crossed': card_level < max_l or bool(species.get('crossedLod2Cards')), 'stableKeep': True},
        }

    if willow:
        def willow_rung(name, dist, radial_scale, ring_stride, keep, crossed, card_grid=None):
            r = rung(name, dist, max_l, True, radial_scale, ring_stride, keep, 0)
            r['cards'] = {'growScale': 1, 'keepFraction': keep, 'crossed': crossed, 'stableKeep': True,
                          'gravityAligned': True, 'floorMin': nz(f.get('floorMin'), 0.28)}
            if card_grid:
                r['cards']['cardGrid'] = card_grid
            return r
        near = willow_rung('LOD2', 0, 0.6, 2, 1, True)
        near.update({'appOnly': False, 'hiddenInApp': False, 'terminalSides': 3, 'terminalRingStride': 4})
        base[2].update(near)
        grouped_feeder_keep = max(0, min(1, nz(f.get('groupedCardFeederKeepFraction'), 0.70)))
        mid_keep = min(1, nz(opts.get('lod1Density'), 1))
        r3 = willow_rung('LOD3', nz(opts.get('lod1Dist'), 35), 0.5, 3, mid_keep, True, {'cols': 4, 'rows': 5})
        r3.update({'terminalSides': 3, 'terminalRingStride': 5})
        base.append(r3)
        far_keep = min(mid_keep, grouped_feeder_keep * min(1, nz(opts.get('lod2Density'), 1)))
        r4 = willow_rung('LOD4', nz(opts.get('lod2Dist'), 70), 0.4, 4, far_keep, False, {'cols': 4, 'rows': 5})
        r4.update({'terminalSides': 3, 'terminalRingStride': 6})
        base.append(r4)
        return base

    guide_cards = guide_level == max_l
    density1 = max(0, min(1, nz(opts.get('lod1Density'), 1)))
    density2 = max(0, min(1, nz(opts.get('lod2Density'), 1)))
    near = rung('LOD2', 0, max_l, True, 0.6, 2, 1, 0)
    near.update({'appOnly': False, 'hiddenInApp': False, 'terminalSides': 3, 'terminalRingStride': 4,
                 'meshTerminalKeepFraction': 1})
    base[2].update(near)
    mid_card_keep = (0.5 if guide_cards else 1) * density1
    mid_tube_keep = 1 if guide_cards else min(mid_card_keep, 0.4 * density1)
    r3 = rung('LOD3', nz(opts.get('lod1Dist'), 35), max_l, True, 0.5, 3, mid_card_keep, 0)
    r3.update({'terminalSides': 3, 'terminalRingStride': 4, 'meshTerminalKeepFraction': mid_tube_keep})
    base.append(r3)
    far_card_keep = min(mid_card_keep, (0.18 if guide_cards else 0.4) * density2)
    far_tube_keep = 1 if guide_cards else min(mid_tube_keep, far_card_keep, 0.2 * density2)
    r4 = rung('LOD4', nz(opts.get('lod2Dist'), 70), max_l, True, 0.4 if guide_cards else 0.5,
              4 if guide_cards else 3, far_card_keep, 0)
    r4.update({'terminalSides': 3, 'terminalRingStride': 4, 'meshTerminalKeepFraction': far_tube_keep})
    base.append(r4)
    return base


def _thin_guide_roots(roots, prune):
    by_parent = {}
    order = []
    for stem in roots:
        pid = stem.get('parentId')
        if pid not in by_parent:
            by_parent[pid] = []
            order.append(pid)
        by_parent[pid].append(stem)
    keep = set()
    for pid in order:
        group = sorted(by_parent[pid], key=lambda s: nz(s.get('id'), 0))
        keep_n = max(1, math.ceil(len(group) * (1 - prune)))
        if keep_n == 1:
            keep.add(id(group[len(group) // 2]))
        else:
            for i in range(keep_n):
                keep.add(id(group[js_round(i * (len(group) - 1) / (keep_n - 1))]))
    return [s for s in roots if id(s) in keep]


def _level_meta(lv):
    meta = {'hiddenInApp': bool(lv.get('hiddenInApp')), 'appOnly': bool(lv.get('appOnly'))}
    if lv.get('cardLevel') is not None:
        meta['cardLevel'] = lv['cardLevel']
    if lv.get('cards'):
        meta['cardKeepFraction'] = nz(lv['cards'].get('keepFraction'), 1)
    if lv.get('meshTerminalKeepFraction') is not None:
        meta['meshTerminalKeepFraction'] = lv['meshTerminalKeepFraction']
    return meta


def build_tree(species, seed, opts=None, assets=None):
    """species = an applySpeciesControls result. assets: {'fruitBounds': ...} lets
    orchard species hang fruit (the JS headless API never does)."""
    opts = opts or {}
    assets = assets or {}
    if species.get('foliageType') in ('rosette', 'sprayClusters'):
        return _build_dichotomous_tree(species, seed, opts, assets)

    rng = tree_rng(species['name'], seed)
    sk = generate_skeleton(species['params'], rng)
    stems, tips = sk['stems'], sk['tips']
    max_level = stems[0]['maxLevel'] if stems else 0
    terminal = [s for s in stems if s['level'] == s['maxLevel']]
    leaves_on = species.get('foliage') is not False and nz((species.get('foliage') or {}).get('leavesPerBranch'), 1) > 0
    guide_level = species.get('guideLevel')
    if guide_level is None and species.get('terminalStemsAreGuides'):
        guide_level = max_level
    branch_cards = opts.get('branchCards')
    total0 = 0
    levels = []
    for i, lv in enumerate(lod_levels(species, opts)):
        use_cards = bool(lv.get('cards') and branch_cards and leaves_on) and species.get('foliageType') != 'rosette'
        card_level = min(max_level, nz(lv.get('cardLevel'), max_level)) if use_cards else max_level
        mesh_stems = [s for s in stems if s['level'] < card_level] if (use_cards and not lv.get('keepTwigs')) else stems
        card_roots = [s for s in stems if s['level'] == card_level and len(s['points']) >= 2] if use_cards else terminal
        level_terminals = terminal
        prune = lv.get('prune') or 0
        if use_cards:
            if prune > 0 and card_roots:
                ys = sorted(s['points'][0].y for s in card_roots)
                y_cap = ys[min(len(ys) - 1, math.floor(len(ys) * 0.8))]
                cands = sorted([s for s in card_roots if s['points'][0].y <= y_cap], key=lambda s: s['radii'][0])
                if guide_level == card_level:
                    target = min(len(cands), math.floor(len(card_roots) * prune))
                    cprune = target / len(cands) if cands else 0
                    kept = {id(s) for s in _thin_guide_roots(cands, cprune)}
                    drop = {id(s) for s in cands if id(s) not in kept}
                else:
                    drop = {id(s) for s in cands[:math.floor(len(card_roots) * prune)]}
                card_roots = [s for s in card_roots if id(s) not in drop]
                if lv.get('keepTwigs'):
                    mesh_stems = [s for s in mesh_stems if id(s) not in drop]
        elif prune > 0:
            deepest = max(s['level'] for s in mesh_stems)
            if deepest > 0:
                cands = sorted([s for s in mesh_stems if s['level'] == deepest], key=lambda s: s['radii'][0])
                if guide_level == deepest:
                    kept = _thin_guide_roots(cands, prune)
                else:
                    kept = cands[math.floor(len(cands) * prune):]
                keep_ids = {id(s) for s in kept}
                drop = {id(s) for s in cands if id(s) not in keep_ids}
                mesh_stems = [s for s in mesh_stems if id(s) not in drop]
                level_terminals = [s for s in level_terminals if id(s) not in drop]
        if guide_level is not None:
            mesh_stems = [s for s in mesh_stems if s['level'] != guide_level]

        foliage = None
        leaf_instances = 0
        if use_cards:
            tkeep = max(0, min(1, nz(lv.get('meshTerminalKeepFraction'), 1)))
            if tkeep < 1:
                tk = {id(s) for s in stable_stem_subset([s for s in mesh_stems if s['level'] == max_level], tkeep)}
                mesh_stems = [s for s in mesh_stems if s['level'] != max_level or id(s) in tk]
            card_opts = lv['cards']
            keep_fraction = max(0, min(1, nz(lv['cards'].get('keepFraction'), 1)))
            if guide_level == card_level and keep_fraction < 1:
                card_roots = (stable_stem_subset(card_roots, keep_fraction) if lv['cards'].get('stableKeep')
                              else _thin_guide_roots(card_roots, 1 - keep_fraction))
                card_opts = dict(lv['cards'], keepFraction=1)
            set_key = '%s:%s' % (card_level, 'fol' if lv.get('keepTwigs') else 'full')
            cards_set = _card_set(branch_cards, set_key, card_level)
            foliage = build_card_foliage(card_roots, cards_set, tree_rng(species['name'], seed, 'cards%d' % i), card_opts)
            if foliage:
                foliage['cardsKey'] = set_key
                leaf_instances = sum(m['count'] for m in foliage['meshes'])
        elif species.get('foliage') is not False:
            cfg = lv['foliage']
            tag = 'willow-direct' if (cfg.get('mode') == 'willowCurtains' and i < 2) else 'foliage%d' % i
            foliage = build_foliage(level_terminals, cfg, tree_rng(species['name'], seed, tag))
            if foliage:
                leaf_instances = foliage.get('vineCount', foliage.get('count', 0))
        fol_tris = _tris(foliage)

        fruit = None
        fb = assets.get('fruitBounds')
        if species.get('fruit') and fb and i < 2 and species.get('foliage') is not False:
            fcfg = species['fruit'] if i == 0 else dict(
                species['fruit'], maxCount=js_round(nz(species['fruit'].get('maxCount'), 120) * 0.25))
            fruit_stems = level_terminals
            if guide_level is not None:
                deepest_wood = max(s['level'] for s in mesh_stems)
                fruit_stems = [s for s in mesh_stems if s['level'] == deepest_wood]
            fruit = build_fruits(fruit_stems, fcfg, tree_rng(species['name'], seed, 'fruit%d' % i), fb, mesh_stems)
            if fruit:
                fruit['trisPer'] = assets.get('fruitTris', 0)
                leaf_instances += len(fruit['instances'])
                fol_tris += _tris(fruit)

        gopts = {'tileWorldSize': nz(species.get('tileWorldSize'), 1.5),
                 'radialScale': lv['radialScale'], 'ringStride': lv['ringStride'],
                 'terminalSides': lv.get('terminalSides'), 'terminalRingStride': lv.get('terminalRingStride')}
        solved = gopts
        if lv.get('budgetFrac') and total0 > 0:
            target = max(100, total0 * lv['budgetFrac'] - fol_tris)

            def solve_at(stride):
                def est(rs):
                    return estimate_branch_triangles(mesh_stems, dict(gopts, ringStride=stride, radialScale=rs))
                mn, mx = est(0.1), est(1)
                if target <= mn:
                    return {'ringStride': stride, 'radialScale': 0.1, 'triangles': mn, 'atMax': False}
                if target >= mx:
                    return {'ringStride': stride, 'radialScale': 1, 'triangles': mx, 'atMax': True}
                lo, hi = 0.1, 1
                for _ in range(28):
                    mid = (lo + hi) * 0.5
                    if est(mid) <= target:
                        lo = mid
                    else:
                        hi = mid
                below = {'ringStride': stride, 'radialScale': lo, 'triangles': est(lo), 'atMax': False}
                above = {'ringStride': stride, 'radialScale': hi, 'triangles': est(hi), 'atMax': False}
                return above if abs(target - above['triangles']) < abs(target - below['triangles']) else below

            sol = solve_at(gopts['ringStride'])
            if sol['atMax'] and gopts['ringStride'] > 1:
                denser = solve_at(1)
                if abs(target - denser['triangles']) < abs(target - sol['triangles']):
                    sol = denser
            solved = dict(gopts, radialScale=sol['radialScale'], ringStride=sol['ringStride'])
        bark = build_branch_geometry(mesh_stems, solved)
        bark['kind'] = 'bark'
        if i == 0:
            total0 = len(bark['index']) // 3 + fol_tris
        rec = {'name': lv['name'], 'distance': lv['distance'], 'leafInstances': leaf_instances,
               'parts': {'bark': bark, 'foliage': foliage, 'fruit': fruit},
               'branchOpts': solved, 'useCards': use_cards}
        rec.update(_level_meta(lv))
        levels.append(rec)
    return {
        'generator': 'weber-penn', 'levels': levels, 'stems': stems, 'tips': tips,
        'terminalStems': terminal, 'plantSink': nz(species.get('plantSink'), 0.2),
        'mobileBuilt': bool(opts.get('mobileTarget')),
    }


def _build_dichotomous_tree(species, seed, opts, assets):
    fol = species.get('foliage')
    fol_d = fol if fol else {}
    leaf_len = fol_d.get('leafLen')
    if leaf_len is None:
        leaf_len = fol_d.get('clusterSize')
    sk_params = dict(species['params'], tipClearance=nz(leaf_len, 0.5) * 0.9)
    sk = generate_dichotomous(sk_params, tree_rng(species['name'], seed))
    stems, terminal = sk['stems'], sk['terminalStems']
    params = species['params']
    q = max(0.3, nz(opts.get('meshQuality'), MESHQ_DEFAULT))
    qn = min(1.25, q / MESHQ_DEFAULT)
    d0 = nz(opts.get('lod0Density'), 1)
    d1, d2 = nz(opts.get('lod1Density'), 1), nz(opts.get('lod2Density'), 1)

    def cs(b):
        return max(3, js_round(b))

    def rs(b):
        return max(4, js_round(b * qn))
    low_q = max(0, (MESHQ_DEFAULT - q) / (MESHQ_DEFAULT - 0.3))

    def ring(spacing, angle):
        return {'ringMaxSpacing': spacing + 0.6 * low_q, 'ringKeepAngle': angle + 15 * low_q}
    shrub = species.get('foliageType') == 'sprayClusters'
    native = nz(params.get('radialSegs'), 10)
    if shrub:
        levels = [
            dict(name='LOD0', distance=0, radialSegs=rs(native), rosetteDensity=1, **ring(0, 0)),
            dict(name='LOD1', distance=nz(opts.get('lod1Dist'), 35), radialSegs=min(rs(4), native), rosetteDensity=d1, **ring(0.5, 18)),
            dict(name='LOD2', distance=nz(opts.get('lod2Dist'), 80), radialSegs=min(3, native), rosetteDensity=0.9 * d2, **ring(0.9, 26)),
        ]
    else:
        levels = [
            dict(name='LOD0', distance=0, radialSegs=rs(native), rosetteDensity=1, coneRadialSegs=cs(12), **ring(0, 0)),
            dict(name='LOD1', distance=nz(opts.get('lod1Dist'), 35), radialSegs=rs(6), rosetteDensity=0.6 * d1, coneRadialSegs=cs(8), **ring(0.35, 12)),
            dict(name='LOD2', distance=nz(opts.get('lod2Dist'), 80), radialSegs=rs(6), rosetteDensity=0.35 * d2, coneRadialSegs=cs(4), **ring(0.6, 18)),
        ]
    if species.get('cactus'):
        rc = nz(params.get('ribCount'), 16)
        levels[0].update(radialSegs=rc * 4, ribDepth=params.get('ribDepth'), spineDensity=1)
        levels[1].update(radialSegs=rc * 2, ribDepth=params.get('ribDepth') * 0.85, spineDensity=0.5 * d1)
        levels[2].update(radialSegs=max(14, rc), ribDepth=0, spineDensity=0)

    if opts.get('mobileTarget'):
        levels[0]['hiddenInApp'] = True
        levels[1]['hiddenInApp'] = True
        if shrub:
            levels[2]['radialSegs'] = min(rs(5), native)
            levels[2]['rosetteDensity'] = 0.6 * d0
            levels[2].update(ring(0.5, 18))
            levels.append(dict(name='LOD3', distance=nz(opts.get('lod1Dist'), 35), appOnly=True,
                               radialSegs=min(rs(4), native), rosetteDensity=0.35 * d1, **ring(0.9, 26)))
            levels.append(dict(name='LOD4', distance=nz(opts.get('lod2Dist'), 70), appOnly=True,
                               radialSegs=4, rosetteDensity=0.2 * d2, **ring(1.3, 34)))
        elif species.get('cactus'):
            rc = nz(params.get('ribCount'), 16)
            levels[2]['radialSegs'] = rc * 2
            levels[2]['ribDepth'] = params.get('ribDepth') * 0.85
            levels[2]['spineDensity'] = 0.3 * d2
            levels[2].update(ring(0.25, 3))
            levels.append(dict(name='LOD3', distance=nz(opts.get('lod1Dist'), 35), appOnly=True, radialSegs=12,
                               ribDepth=0, spineDensity=0, rosetteDensity=0, **ring(0.6, 20)))
            levels.append(dict(name='LOD4', distance=nz(opts.get('lod2Dist'), 70), appOnly=True, radialSegs=8,
                               ribDepth=0, spineDensity=0, rosetteDensity=0, **ring(1.0, 30)))
        else:
            levels[2].update(skirtToBark=True, thatchBark=True, skirtTopLen=0.4, coneRadialSegs=cs(6),
                             rosetteDensity=0.48 * d0)
            if q >= MESHQ_DEFAULT:
                near_sides = js_round(8 + ((q - MESHQ_DEFAULT) / (1 - MESHQ_DEFAULT)) * 4)
            else:
                near_sides = max(4, js_round(4 + ((q - 0.3) / (MESHQ_DEFAULT - 0.3)) * 4))
            levels[2]['radialSegs'] = near_sides
            levels[2].update(ring(0.45, 15))
            if q >= 0.95:
                levels[2]['ringMaxSpacing'] = 0
            levels.append(dict(name='LOD3', distance=nz(opts.get('lod1Dist'), 35), appOnly=True, skirtToBark=True,
                               thatchBark=True, skirtTopLen=0.2, radialSegs=near_sides, coneRadialSegs=3,
                               rosetteDensity=0.35 * d1, rosetteCards=True, cardCopies=4,
                               cardKeepFraction=max(0, min(1, d1))))
            levels.append(dict(name='LOD4', distance=nz(opts.get('lod2Dist'), 70), appOnly=True, skirtToBark=True,
                               thatchBark=True, skirtTopLen=0, radialSegs=5, ringMaxSpacing=1.2, ringKeepAngle=35,
                               coneRadialSegs=3, rosetteDensity=0.18 * d2, rosetteCards=True, cardCopies=2,
                               cardKeepFraction=max(0, min(1, d2))))

    branch_cards = opts.get('branchCards')
    out_levels = []
    for i, lv in enumerate(levels):
        card_keep = max(0, min(1, nz(lv.get('cardKeepFraction'), 1)))
        use_rosette_cards = bool(lv.get('rosetteCards') and card_keep > 0 and branch_cards
                                 and branch_cards.get('rosette') and branch_cards.get('variants'))
        term_ids = {id(s) for s in terminal} if use_rosette_cards else None
        mesh_params = dict(params, radialSegs=lv['radialSegs'],
                           ribDepth=lv['ribDepth'] if lv.get('ribDepth') is not None else params.get('ribDepth'))
        if lv.get('ringMaxSpacing'):
            mesh_params['ringMaxSpacing'] = lv['ringMaxSpacing']
            mesh_params['ringKeepAngle'] = lv['ringKeepAngle']
        if term_ids is not None:
            mesh_params['skipStem'] = lambda s, _t=term_ids: id(s) in _t
        bark = build_merged_mesh(stems, mesh_params)
        bark['kind'] = 'bark'
        spines = None
        if species.get('cactus'):
            sp_cfg = dict(species.get('spines') or {})
            sp_cfg['density'] = nz(lv.get('spineDensity'), 1) * nz((species.get('spines') or {}).get('density'), 1)
            spines = build_cactus_spines(bark['ribCrests'], sp_cfg, tree_rng(species['name'], seed, 'spines%d' % i))
        foliage = None
        leaf_instances = 0
        density = nz(lv.get('rosetteDensity'), 1)
        if use_rosette_cards:
            foliage = build_card_foliage(terminal, branch_cards, tree_rng(species['name'], seed, 'rcards%d' % i), {
                'copies': nz(lv.get('cardCopies'), 4), 'keepFraction': card_keep, 'growScale': 1, 'windAt': 'base'})
            if foliage:
                foliage['cardsKey'] = 'rosette'
                leaf_instances = sum(m['count'] for m in foliage['meshes'])
        elif shrub and fol is not False and density > 0:
            full = nz(fol.get('clustersPerBranch'), 2)
            spray_keep = max(1, js_round(full * density)) / full
            cfg = dict(fol, mode='clusters', clustersPerBranch=full)

            def view(s):
                return stem_foliage_view(s, mesh_params)
            f_main = build_foliage([view(s) for s in terminal], cfg, tree_rng(species['name'], seed, 'sprays0'))
            if f_main and spray_keep < 1:
                keep_spray_subset(f_main, spray_keep)
            f_par = None
            p_frac = nz(fol.get('parentSprays'), 0)
            if p_frac > 0:
                parents = [s for s in stems if not s['terminal'] and any(ch['terminal'] for ch in s['children'])]
                if parents:
                    f_par = build_foliage([view(s) for s in parents],
                                          dict(cfg, clustersPerBranch=max(1, js_round(cfg['clustersPerBranch'] * p_frac))),
                                          tree_rng(species['name'], seed, 'psprays0'))
                    if f_par and spray_keep < 1:
                        keep_spray_subset(f_par, spray_keep)
            parts = [x for x in (f_main, f_par) if x]
            if parts:
                foliage = {'kind': 'cardsGroup', 'members': parts,
                           'domeCenter': f_main['domeCenter'] if f_main else parts[0]['domeCenter']}
                leaf_instances = sum(x['count'] for x in parts)
        elif (not shrub) and fol is not False and not species.get('cactus') and density > 0:
            cfg = dict(fol, density=lv.get('rosetteDensity'), coneRadialSegs=lv.get('coneRadialSegs'),
                       skirtToBark=lv.get('skirtToBark'), skirtTopLen=lv.get('skirtTopLen'))
            foliage = build_yucca_foliage(terminal, cfg, tree_rng(species['name'], seed, 'rosette%d' % i), stems)
            if foliage:
                leaf_instances = sum(len(s) for s in foliage['slots'])
        fruit = None
        fb = assets.get('fruitBounds')
        if species.get('fruit') and fb and i < 2 and fol is not False:
            fcfg = species['fruit'] if i == 0 else dict(
                species['fruit'], maxCount=max(1, js_round(nz(species['fruit'].get('maxCount'), 120) * 0.35)))
            fruit = build_fruits(terminal, fcfg, tree_rng(species['name'], seed, 'fruit%d' % i), fb, stems)
            if fruit:
                fruit['trisPer'] = assets.get('fruitTris', 0)
                leaf_instances += len(fruit['instances'])
        rec = {'name': lv['name'], 'distance': lv['distance'], 'leafInstances': leaf_instances,
               'parts': {'bark': bark, 'foliage': foliage, 'spines': spines, 'fruit': fruit},
               'meshParams': {k: v for k, v in mesh_params.items() if k != 'skipStem'},
               'thatchBark': bool(lv.get('thatchBark')), 'useCards': use_rosette_cards}
        rec.update(_level_meta(lv))
        out_levels.append(rec)
    return {
        'generator': 'dichotomous-lsystem', 'levels': out_levels, 'stems': stems, 'tips': [],
        'terminalStems': terminal, 'plantSink': nz(species.get('plantSink'), 0.2),
        'mobileBuilt': bool(opts.get('mobileTarget')),
    }


def foliage_tris(part):
    if part is None:
        return 0
    if part.get('kind') == 'cardsGroup':
        return sum(_tris(m) for m in part['members'])
    return _tris(part)
