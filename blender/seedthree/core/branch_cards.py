"""Baked branch cards and rosette cards: the geometry half of src/core/branch-cards.js.

The JS bakes a few exemplar terminal subtrees of the LOD0 tree (twig + its real
leaves + fruit) into albedo / normal / roughness / translucency textures, then
places one card per terminal twig on the reduced LODs. This module is that code
without the GPU: the exemplar picks, their content, the bake framing (one
orthographic view per card face), the card quads (flat or the willow's bowed
sheets), the per-instance thickness, and buildCardFoliage's placement. The
Blender renders that turn a framing into textures live in seedthree/bl/bake.py.

    cards = prepare_branch_cards(shaped, {'variants': 3, 'foliageOnly': True}, fruit_bounds)
    cards['variants'][0]['views']        # [{'name': 'front', 'center', 'halfW', 'halfH', 'depth', 'dir'}]
    cards['variants'][0]['content']      # {'twig', 'leaves', 'fruit'}: what the bake renders
    placed = build_card_foliage(terminal_stems, cards, rng, {'growScale': 1, 'keepFraction': 1})

Everything is in three's Y-up tree frame; bl/meshes.py converts to Blender.
"""

import math

import numpy as np

from .jsutil import nz
from .rng import Rng
from .vmath import Q, V3, compose, js_round
from .weber_penn import generate_skeleton
from .dichotomous import generate_dichotomous, build_merged_mesh
from .yucca_leaves import build_yucca_foliage, cone_geo
from .branch_mesh import build_branch_geometry
from .leaf_cards import build_foliage, WIND_DIR
from .fruit import build_fruits

MAX_CARD_INSTANCES = 4096   # aThickness allocation on the shared card geometry
TRANSMIT = (0.42, 0.62, 0.24)
Y = V3(0, 1, 0)


def _first(*vals):
    """JS a ?? b ?? c."""
    for v in vals:
        if v is not None:
            return v
    return None


def chord_vec(stem, out=None):
    out = out or V3()
    return out.copy(stem['points'][-1]).sub(stem['points'][0])


def stem_arc_len(stem):
    """Arc length (sum of segments): the stable size reference for card scaling."""
    p = stem['points']
    total = 0.0
    for i in range(1, len(p)):   # a plain loop: Python's sum() compensates and drifts from the JS bits
        total += p[i].distance_to(p[i - 1])
    return total


def children_map(stems):
    m = {}
    for s in stems:
        pid = s.get('parentId')
        if pid is None or pid < 0:
            continue
        m.setdefault(pid, []).append(s)
    return m


def subtree_of(root, by_parent):
    out = [root]
    stack = [root['id']]
    while stack:
        kids = by_parent.get(stack.pop())
        if not kids:
            continue
        for k in kids:
            out.append(k)
            stack.append(k['id'])
    return out


def _rebased(subtree, base, q):
    out = []
    for s in subtree:
        d = dict(s)
        d['points'] = [p.clone().sub(base).apply_quaternion(q) for p in s['points']]
        if s.get('orients') is not None:
            d['orients'] = [q.clone().multiply(o) for o in s['orients']]
        out.append(d)
    return out


def rebase_subtree(subtree, root):
    """The whole subtree in the root's frame: base at the origin, chord along +Y."""
    base = root['points'][0]
    chord = chord_vec(root)
    if chord.length_sq() < 1e-6:
        chord.copy(root['points'][1]).sub(root['points'][0])
    chord.normalize()
    q = Q().set_from_unit_vectors(chord, V3(0, 1, 0))
    return _rebased(subtree, base, q)


def horizontal_stem_dir(stem, out=None):
    out = chord_vec(stem, out)
    out.y = 0
    pts = stem['points']
    if out.length_sq() < 1e-6 and len(pts) > 1:
        out.copy(pts[1]).sub(pts[0])
        out.y = 0
    if out.length_sq() < 1e-6:
        out.copy(pts[0])
        out.y = 0
    if out.length_sq() < 1e-6:
        out.set(1, 0, 0)
    return out.normalize()


def stem_yaw_frame(stem, out=None):
    """Yaw-only frame mapping +X to the stem's horizontal chord (willow sheets keep gravity on Y)."""
    d = horizontal_stem_dir(stem)
    out = out or Q()
    return out.set_from_axis_angle(V3(0, 1, 0), math.atan2(-d.z, d.x))


def rebase_gravity_subtree(subtree, root):
    base = root['points'][0]
    q = stem_yaw_frame(root).invert()
    return _rebased(subtree, base, q)


# ---- card geometry ------------------------------------------------------------

def card_quad_geometry(center, half_w, half_h, view='front'):
    """One quad spanning the bake framing in stem-local space. 'front' lies in z=0
    (front camera at +z); 'side' in x=0 with U running +z -> -z (the side camera
    at +x looking -x has screen-right = -z), so a crossed pair shares one transform."""
    y0, y1 = center.y - half_h, center.y + half_h
    if view == 'side':
        z0, z1 = center.z + half_w, center.z - half_w
        pos = [(0, y0, z0), (0, y0, z1), (0, y1, z1), (0, y1, z0)]
        nrm = [(1, 0, 0)] * 4
    else:
        x0, x1 = center.x - half_w, center.x + half_w
        pos = [(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0)]
        nrm = [(0, 0, 1)] * 4
    return {
        'position': np.array(pos, np.float32), 'normal': np.array(nrm, np.float32),
        'uv': np.array([(0, 0), (1, 0), (1, 1), (0, 1)], np.float32),
        'index': np.array([0, 1, 2, 0, 2, 3], np.int64),
    }


def compute_vertex_normals(P, I):
    """three's BufferGeometry.computeVertexNormals for indexed geometry (float32 out)."""
    P = np.asarray(P, np.float64)
    tri = np.asarray(I, np.int64).reshape(-1, 3)
    a, b, c = P[tri[:, 0]], P[tri[:, 1]], P[tri[:, 2]]
    fn = np.cross(c - b, a - b)
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, tri[:, k], fn)
    ln = np.linalg.norm(N, axis=1)
    ln[ln == 0] = 1
    return (N / ln[:, None]).astype(np.float32)


def bowed_card_geometry(center, half_w, half_h, view='front', horizontal_scale=1, vertical_scale=1, cols=5, rows=7):
    """The willow's gravity sheets: a shallow cylindrical bow plus an in-plane arc."""
    cols = max(2, js_round(cols))
    rows = max(2, js_round(rows))
    cross_bow = half_w * 0.18
    long_bow = min(half_h * 0.18, half_w * 0.55)
    in_plane = min(half_h * 0.065, half_w * 0.18)
    surface_half_w = max(0.001, half_w - in_plane * 0.5)
    pos, uvs, idx = [], [], []
    y0 = center.y - half_h
    for r in range(rows):
        v = r / (rows - 1)
        y = y0 + v * half_h * 2 * vertical_scale
        curve = long_bow * math.sin(math.pi * v)
        arc = in_plane * (v * (2 - v) - 0.5)
        for c in range(cols):
            u = c / (cols - 1)
            across = u * 2 - 1
            depth = cross_bow * (1 - across * across) + curve - (cross_bow + long_bow) * 0.5
            if view == 'side':
                pos.append((depth * horizontal_scale, y, center.z + (-across * surface_half_w + arc) * horizontal_scale))
            else:
                pos.append((center.x + (across * surface_half_w + arc) * horizontal_scale, y, depth * horizontal_scale))
            uvs.append((u, v))
    for r in range(rows - 1):
        for c in range(cols - 1):
            a = r * cols + c
            b, d = a + 1, (r + 1) * cols + c
            e = d + 1
            idx += [a, b, e, a, e, d]
    P = np.array(pos, np.float32)
    I = np.array(idx, np.int64)
    return {'position': P, 'normal': compute_vertex_normals(P, I), 'uv': np.array(uvs, np.float32), 'index': I}


def thickness_values(count, rng):
    """addThicknessAttribute: 0.4..1 per instance slot."""
    return np.array([0.4 + rng.next() * 0.6 for _ in range(count)], np.float64)


# ---- bounding boxes (three's Box3.setFromObject over a bake group) -------------

def _f32(a):
    return np.asarray(a, np.float64).astype(np.float32).astype(np.float64)


def mesh_box(positions):
    P = np.asarray(positions, np.float32).astype(np.float64)
    if len(P) == 0:
        return None
    return P.min(0), P.max(0)


def instanced_box(template_positions, matrices):
    """InstancedMesh.computeBoundingBox: each instance's transformed template AABB (8 corners)."""
    T = np.asarray(template_positions, np.float32).astype(np.float64)
    M = _f32(matrices).reshape(-1, 16)
    if len(T) == 0 or len(M) == 0:
        return None
    lo, hi = T.min(0), T.max(0)
    C = np.array([(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    R = M.reshape(-1, 4, 4).transpose(0, 2, 1)
    pts = np.einsum('nij,kj->nki', R[:, :3, :3], C) + R[:, None, :3, 3]
    pts = pts.reshape(-1, 3)
    return pts.min(0), pts.max(0)


def union(boxes):
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        return None
    return np.min([b[0] for b in boxes], axis=0), np.max([b[1] for b in boxes], axis=0)


def foliage_box(part):
    if part is None:
        return None
    if part.get('kind') == 'cards':
        return instanced_box(part['template']['position'], part['matrices'])
    if part.get('kind') == 'cones':
        boxes = []
        for ci, lst in enumerate(part['slots']):
            if lst:
                boxes.append(instanced_box(cone_geo(ci, part['coneRadialSegs'])['position'],
                                           np.array([s['matrix'] for s in lst])))
        return union(boxes)
    if 'position' in part:
        return mesh_box(part['position'])
    return None


def fruit_box(part, fruit_bounds):
    if part is None or not fruit_bounds:
        return None
    bmin, bmax = fruit_bounds
    tmpl = np.array([bmin, bmax], np.float64)
    return instanced_box(tmpl, np.array([s['matrix'] for s in part['instances']]))


def _views(center, half_w_by_view, half_h, depth, cross):
    out = [{'name': 'front', 'dir': (0.0, 0.0, 1.0), 'halfW': half_w_by_view['front']}]
    if cross:
        out.append({'name': 'side', 'dir': (1.0, 0.0, 0.0), 'halfW': half_w_by_view['side']})
    for v in out:
        v.update({'center': (center.x, center.y, center.z), 'halfH': half_h, 'depth': depth,
                  'near': 0.1, 'far': depth * 2})
    return out


# ---- bakeBranchCards (geometry half) ---------------------------------------------

def prepare_branch_cards(species, opts=None, fruit_bounds=None):
    """The exemplars, framings and card quads of bakeBranchCards.

    species: an applySpeciesControls result. opts: {variants (3), size (512), cardLevel
    (deepest), foliageOnly, crossViews, gravityAligned, noFlutter}. fruit_bounds: the
    prepared fruit GLB bounds (orchard species bake fruit into the cards).
    -> {'variants': [...], 'foliageOnly', 'preserveGuideLength', 'gravityAligned',
        'floorMin', 'noFlutter', 'size', 'center': [x, y, z] (the dome uniform)} or None."""
    opts = opts or {}
    variant_count = nz(opts.get('variants'), 3)
    size = nz(opts.get('size'), 512)
    fol = species.get('foliage') or {}
    willow = fol.get('mode') == 'willowCurtains'
    gravity = willow and bool(opts.get('gravityAligned'))
    cross_views = gravity or bool(opts.get('crossViews'))
    floor_min = _first(fol.get('floorMin'), fol.get('curtainFloorMin'),
                       (species.get('params') or {}).get('terminalFloorMin'), 0)

    rng = Rng('%s:cards' % species['name'])
    stems = generate_skeleton(species['params'], rng)['stems']
    max_level = stems[0]['maxLevel'] if stems else 0
    card_level = _first(opts.get('cardLevel'), max_level)
    by_parent = children_map(stems)
    roots = [s for s in stems if s['level'] == card_level and len(s['points']) >= 2 and chord_vec(s).length_sq() > 1e-4]
    if not roots:
        return None
    ordered = sorted(roots, key=stem_arc_len)
    picks = [ordered[math.floor(f * (len(ordered) - 1))] for f in (0.25, 0.45, 0.65, 0.85)[:min(variant_count, 4)]]

    thickness_rng = Rng('%s:cards:thickness' % species['name'])
    guide_level = species.get('guideLevel')
    if guide_level is None and species.get('terminalStemsAreGuides'):
        guide_level = max_level
    variants = []
    for vi, stem in enumerate(picks):
        source = subtree_of(stem, by_parent)
        sub = rebase_gravity_subtree(source, stem) if gravity else rebase_subtree(source, stem)
        sub_terminals = [s for s in sub if s['level'] == max_level]
        branch_stems = sub if guide_level is None else [s for s in sub if s['level'] != guide_level]
        twig = None
        if not opts.get('foliageOnly') and branch_stems:
            twig = build_branch_geometry(branch_stems, {'tileWorldSize': nz(species.get('tileWorldSize'), 1.5)})
            twig['kind'] = 'bark'
        frng = Rng('%s:cards:%d' % (species['name'], vi))
        leaf_stems = sub_terminals if sub_terminals else sub
        if not opts.get('foliageOnly') or willow:
            bake_stems = leaf_stems
        else:
            # foliage-only cards bake their leaves on a STRAIGHTENED twig along the chord
            bake_stems = []
            for s in leaf_stems:
                acc = 0.0
                pts = []
                for j, p in enumerate(s['points']):
                    if j > 0:
                        acc += p.distance_to(s['points'][j - 1])
                    pts.append(V3(0, acc, 0))
                d = dict(s)
                d['points'] = pts
                d['orients'] = [Q() for _ in s['orients']]
                bake_stems.append(d)
        bake_mode = 'willowCurtains' if willow else ('hangingSprays' if fol.get('mode') == 'hangingSprays' else 'leaves')
        bake_cfg = dict(fol)
        bake_cfg.update({'mode': bake_mode, 'trunkClearRadius': 0, 'hangFloor': None, 'curtainFloor': None,
                         'floor': None, 'floorMin': None, 'terminalFloor': None, 'terminalFloorMin': None,
                         'disableFloor': True})
        if willow:
            bake_cfg['vineKeepFraction'] = nz(fol.get('groupedCardVineKeepFraction'), 1)
        leaves = build_foliage(bake_stems, bake_cfg, frng)
        fruit = None
        if species.get('fruit') and fruit_bounds:
            fruit_rng = Rng('%s:cards:fruit:%d' % (species['name'], vi))
            per_card = dict(species['fruit'], bakeCard=True, maxCount=5, perBranch=1)
            fruit = build_fruits(bake_stems, per_card, fruit_rng, fruit_bounds)
        if twig is None and leaves is None and fruit is None:
            continue
        box = union([mesh_box(twig['position']) if twig is not None else None,
                     foliage_box(leaves), fruit_box(fruit, fruit_bounds)])
        center = V3(*((box[0] + box[1]) / 2))
        sz = box[1] - box[0]
        half_w = {'front': max(0.01, sz[0] * 0.51), 'side': max(0.01, sz[2] * 0.51)}
        half_h = (sz[1] / 2) * 1.02
        depth = max(sz[0], sz[2]) + 2
        views = _views(center, half_w, half_h, depth, cross_views)

        def card_geo(view):
            hw = half_w[view]
            if gravity:
                hs = max(0.5, min(1, nz(fol.get('groupedCardHorizontalScale'), 1)))
                vs = max(0.75, min(1.5, nz(fol.get('groupedCardVerticalScale'), 1)))
                geo = bowed_card_geometry(center, hw, half_h, view, hs, vs)
                geo['willowBowed'] = {'center': (center.x, center.y, center.z), 'halfW': hw, 'halfH': half_h,
                                      'view': view, 'horizontalScale': hs, 'verticalScale': vs}
            else:
                geo = card_quad_geometry(center, hw, half_h, view)
            geo['aThickness'] = thickness_values(MAX_CARD_INSTANCES, thickness_rng)
            return geo

        geometry = card_geo('front')
        side = None
        if cross_views:
            sgeo = card_geo('side')
            sgeo['aThickness'] = geometry['aThickness'].copy()   # matched thickness across the pair
            side = {'geometry': sgeo, 'view': views[1]}
        variants.append({
            'geometry': geometry, 'view': views[0], 'side': side, 'views': views,
            'chordLen': stem_arc_len(stem), 'minY': center.y - half_h, 'floorMin': floor_min,
            'content': {'twig': twig, 'leaves': leaves, 'fruit': fruit, 'leafMode': bake_mode},
            'box': (box[0].tolist(), box[1].tolist()),
        })
    if not variants:
        return None
    return {
        'variants': variants, 'center': [0.0, 0.0, 0.0],
        'foliageOnly': bool(opts.get('foliageOnly')),
        'preserveGuideLength': fol.get('mode') == 'hangingSprays',
        'gravityAligned': gravity, 'floorMin': floor_min,
        'noFlutter': bool(opts.get('noFlutter')), 'size': size, 'cardLevel': card_level,
    }


def prepare_rosette_cards(species, opts=None):
    """bakeRosetteCards (geometry half): terminal Joshua/yucca arms (stub + full crown and
    skirt) baked in one front view; one bake serves a 4-way crossed placement."""
    opts = opts or {}
    variant_count = min(nz(opts.get('variants'), 3), 3)
    size = nz(opts.get('size'), 512)
    fol = species.get('foliage') or {}
    rng = Rng('%s:rcards' % species['name'])
    sk_params = dict(species['params'], tipClearance=nz(fol.get('leafLen'), 0.5) * 0.9)
    terms = [s for s in (generate_dichotomous(sk_params, rng)['terminalStems'] or [])
             if len(s['points']) >= 2 and chord_vec(s).length_sq() > 1e-4]
    if not terms:
        return None
    ordered = sorted(terms, key=stem_arc_len)
    picks = [ordered[math.floor(f * (len(ordered) - 1))] for f in (0.3, 0.6, 0.85)[:variant_count]]
    thickness_rng = Rng('%s:rcards:thickness' % species['name'])
    variants = []
    for vi, stem in enumerate(picks):
        base = stem['points'][0]
        chord = chord_vec(stem).normalize()
        q = Q().set_from_unit_vectors(chord, V3(0, 1, 0))
        local = _rebased([stem], base, q)[0]
        local['terminal'] = True
        local['children'] = []
        tube = build_merged_mesh([local], dict(species['params'], ribDepth=0, radialSegs=8))
        tube['kind'] = 'bark'
        frng = Rng('%s:rcards:%d' % (species['name'], vi))
        cones = build_yucca_foliage([local], dict(fol, density=1, coneRadialSegs=8), frng, [local])
        box = union([mesh_box(tube['position']), foliage_box(cones)])
        center = V3(*((box[0] + box[1]) / 2))
        sz = box[1] - box[0]
        half_w = (max(sz[0], sz[2]) / 2) * 1.02
        half_h = (sz[1] / 2) * 1.02
        depth = max(sz[0], sz[2]) + 2
        views = _views(center, {'front': half_w, 'side': half_w}, half_h, depth, False)
        geometry = card_quad_geometry(center, half_w, half_h)
        geometry['aThickness'] = thickness_values(MAX_CARD_INSTANCES, thickness_rng)
        variants.append({
            'geometry': geometry, 'view': views[0], 'side': None, 'views': views,
            'chordLen': stem_arc_len(stem), 'minY': center.y - half_h, 'floorMin': None,
            'content': {'twig': tube, 'cones': cones, 'leafMode': 'rosette'},
            'box': (box[0].tolist(), box[1].tolist()),
        })
    if not variants:
        return None
    return {'variants': variants, 'center': [0.0, 0.0, 0.0], 'rosette': True, 'noFlutter': True,
            'foliageOnly': False, 'preserveGuideLength': False, 'gravityAligned': False, 'size': size}


# ---- placement ------------------------------------------------------------------

def stable_stem_subset(stems, keep_fraction):
    """Exact low-discrepancy subset ranked by stable stem identity: every lower keep is
    a strict subset of every higher one; source order is kept."""
    keep = max(0, min(1, keep_fraction))
    if keep >= 1:
        return list(stems)
    if keep <= 0 or not stems:
        return []
    golden = 0.6180339887498949
    ranked = []
    for index, stem in enumerate(stems):
        ident = stem.get('id')
        ident = index if ident is None else ident
        ranked.append((((ident + 1) * golden) % 1, ident, index))
    ranked.sort(key=lambda e: (e[0], e[1]))
    keep_n = max(0, min(len(stems), js_round(len(stems) * keep)))
    survivors = {e[2] for e in ranked[:keep_n]}
    return [s for i, s in enumerate(stems) if i in survivors]


def build_card_foliage(terminal_stems, cards, rng, opts=None):
    """buildCardFoliage: one card (or a crossed fan) per stem, bucketed to the nearest-size
    exemplar. -> {'meshes': [...], 'center': dome origin} or None; each mesh:
    {'variant', 'view' ('front'|'side'), 'geometry', 'count', 'matrices' (n,16),
     'windVec' (n,3), 'anchor' (n,3), 'weights' (n), 'thickness' (n), 'withFlutter',
     'castShadow', 'receiveShadow'}. Also sets cards['center'] (the JS centerUniform)."""
    opts = opts or {}
    grow = nz(opts.get('growScale'), 1.2)
    keep = nz(opts.get('keepFraction'), 1)
    stable = bool(opts.get('stableKeep'))
    copies = _first(opts.get('copies'), 2 if opts.get('crossed') else 1)
    variants = cards['variants']
    gravity = bool(cards.get('gravityAligned'))
    if not terminal_stems or not variants:
        return None

    center = V3()
    min_y = math.inf
    for s in terminal_stems:
        center.add(s['points'][-1])
        for p in s['points']:
            min_y = min(min_y, p.y)
    center.divide_scalar(len(terminal_stems))
    dome = [center.x, min(min_y - 0.5, center.y - 1), center.z]
    cards['center'] = dome

    survivors = None
    if stable and keep < 1:
        survivors = {id(s) for s in stable_stem_subset(terminal_stems, keep)}
    buckets = [[] for _ in variants]
    for stem in terminal_stems:
        if survivors is not None:
            if id(stem) not in survivors:
                continue
        elif keep < 1 and rng.next() > keep:
            continue
        a = stem_arc_len(stem)
        best, best_d = 0, math.inf
        for vi, v in enumerate(variants):
            d = abs(a - v['chordLen'])
            if d < best_d:
                best_d, best = d, vi
        buckets[best].append(stem)

    meshes = []
    q = Q()
    q_roll = Q()
    q_chord = Q()
    q_inv = Q()
    chord = V3()
    wv = V3()
    for vi, lst in enumerate(buckets):
        if not lst:
            continue
        variant = variants[vi]
        paired = copies > 1 and variant.get('side') is not None
        grid = opts.get('cardGrid')

        def mk(geo):
            recipe = geo.get('willowBowed')
            if recipe and grid:
                g = bowed_card_geometry(V3(*recipe['center']), recipe['halfW'], recipe['halfH'], recipe['view'],
                                        recipe['horizontalScale'], recipe['verticalScale'], grid['cols'], grid['rows'])
                g['aThickness'] = geo['aThickness']
                return g
            return geo
        max_stems = MAX_CARD_INSTANCES if paired else MAX_CARD_INSTANCES // max(1, copies)
        placed = lst[:max_stems]
        parts = [('front', mk(variant['geometry']))]
        if paired:
            parts.append(('side', mk(variant['side']['geometry'])))
        mats, wvecs, anchors, weights = [], [], [], []
        use_tip = (opts['windAt'] == 'tip') if opts.get('windAt') else copies > 1
        for stem in placed:
            w = stem.get('winds')
            if use_tip:
                weight = (w[-1] if w else None)
                weight = _first(weight, w[0] if w else None, 0.6)
            else:
                weight = _first(w[0] if w else None, 0.6)
            pos = stem['points'][0]
            chord_vec(stem, chord)
            chord_len = chord.length()
            ref_len = stem_arc_len(stem)
            if ref_len < 1e-3:
                continue
            if gravity:
                stem_yaw_frame(stem, q_chord)
            elif chord_len > 0.15 * ref_len:
                q_chord.set_from_unit_vectors(Y, chord.divide_scalar(chord_len))
            else:
                q_chord.set_from_unit_vectors(Y, chord.copy(stem['points'][1]).sub(stem['points'][0]).normalize())
            roll = 0 if gravity else rng.range(0, math.pi * 2)
            s = (ref_len / variant['chordLen']) * grow
            if cards.get('foliageOnly') and not cards.get('preserveGuideLength'):
                s = min(1.15, max(0.75, s))
            if gravity and variant['minY'] < -1e-4:
                floor = _first(variant.get('floorMin'), cards.get('floorMin'), opts.get('floorMin'))
                if floor is not None and math.isfinite(floor):
                    allowed = pos.y - floor
                    if allowed <= 0:
                        continue
                    s = min(s, allowed / -variant['minY'])
            if s < 0.03:
                continue
            rolls = [roll] if paired else [roll + ci * math.pi / copies for ci in range(copies)]
            for r in rolls:
                q_roll.set_from_axis_angle(Y, r)
                q.copy(q_chord).multiply(q_roll)
                q_inv.copy(q).invert()
                wv.copy(WIND_DIR).apply_quaternion(q_inv).multiply_scalar(weight / s)
                mats.append(compose(pos, q, V3(s, s, s)))
                wvecs.append((wv.x, wv.y, wv.z))
                anchors.append((pos.x, pos.y, pos.z))
                weights.append(weight)
        k = len(mats)
        for mi, (view, geo) in enumerate(parts):
            meshes.append({
                'variant': vi, 'view': view, 'geometry': geo, 'count': k,
                'name': 'cards%d%s' % (vi, ('_side' if mi else '_front') if paired else ''),
                'matrices': np.array(mats, np.float64).reshape(-1, 16),
                'windVec': np.array(wvecs, np.float64).reshape(-1, 3),
                'anchor': np.array(anchors, np.float64).reshape(-1, 3),
                'weights': np.array(weights, np.float64),
                'thickness': np.asarray(geo['aThickness'][:k], np.float64),
                'withFlutter': not cards.get('noFlutter'),
                'castShadow': (not gravity) or (not paired) or mi == 0,
                'receiveShadow': not gravity,
            })
    if not meshes:
        return None
    return {'kind': 'cardSet', 'meshes': meshes, 'center': dome}


def card_set_tris(part):
    if not part:
        return 0
    return sum((len(m['geometry']['index']) // 3) * m['count'] for m in part['meshes'])
