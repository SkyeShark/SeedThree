"""Core part data (three's Y-up tree frame) -> Blender meshes (Z-up).

The axis change happens once, here: three (x, y, z) -> Blender (x, -z, y), a +90
degree rotation about X, so triangle winding (front faces) is kept. Instanced JS
parts (leaf cards, rosette cones, fruit) are realized into one mesh per part with
every per-instance value the materials and the wind group need stored as POINT
attributes:

  st_wind     sway weight (0 at the pinned base, 1 at flexible tips)
  st_anchor   the point whose world position sets the sway phase (bark: the stem
              centreline; cards: the twig anchor; skirt cones: the branch point
              each drape vertex hangs over)
  st_fx/fy/fz flutter basis (the instance's local X/Y/Z axes x leaf height x
              per-leaf random x gate), st_fphase the flutter phase
  st_thickness, st_dome, st_age   material inputs (backlight thickness, canopy
              dome normal, frond age)
"""

import math

import bpy
import numpy as np

from ..core.yucca_leaves import cone_geo
from ..core.leaf_cards import WIND_DIR as _WD

WIND_DIR_THREE = np.array([_WD.x, _WD.y, _WD.z])


def to_bl(a):
    """(n,3) three Y-up -> Blender Z-up."""
    a = np.asarray(a, np.float64)
    return np.stack([a[:, 0], -a[:, 2], a[:, 1]], axis=1)


def _set_attr(me, name, values, kind='FLOAT'):
    values = np.asarray(values, np.float32)
    at = me.attributes.get(name)
    if at is None:
        at = me.attributes.new(name, kind, 'POINT')
    if kind == 'FLOAT_VECTOR':
        at.data.foreach_set('vector', values.reshape(-1))
    else:
        at.data.foreach_set('value', values.reshape(-1))


def build_mesh(name, positions_three, tris, uvs=None, normals_three=None, attrs=None, smooth=True):
    """Create a mesh from three-space arrays. tris: (m,3) vertex indices.
    uvs: per-vertex (n,2). normals: per-vertex custom normals (three space)."""
    P = to_bl(positions_three)
    tris = np.asarray(tris, np.int64).reshape(-1, 3)
    n, m = len(P), len(tris)
    me = bpy.data.meshes.new(name)
    me.vertices.add(n)
    me.vertices.foreach_set('co', P.astype(np.float32).ravel())
    me.loops.add(m * 3)
    me.loops.foreach_set('vertex_index', tris.astype(np.int32).ravel())
    me.polygons.add(m)
    me.polygons.foreach_set('loop_start', np.arange(0, m * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    if uvs is not None:
        uv = me.uv_layers.new(name='UVMap')
        uv.data.foreach_set('uv', np.asarray(uvs, np.float32)[tris.ravel()].ravel())
    if smooth:
        me.shade_smooth()
    if normals_three is not None:
        N = to_bl(normals_three)
        ln = np.linalg.norm(N, axis=1)
        ln[ln == 0] = 1
        me.normals_split_custom_set_from_vertices((N / ln[:, None]).astype(np.float32))
    for key, (kind, vals) in (attrs or {}).items():
        _set_attr(me, key, vals, kind)
    me.update()
    return me


def bark_mesh(name, part):
    """Weber-Penn tubes / welded dichotomous network."""
    tris = part['index'].reshape(-1, 3)
    attrs = {
        'st_wind': ('FLOAT', part['aWind']),
        'st_anchor': ('FLOAT_VECTOR', to_bl(part['aStemCenter'])),
    }
    return build_mesh(name, part['position'], tris, part['uv'], part['normal'], attrs)


def spine_mesh(name, part):
    tris = part['index'].reshape(-1, 3)
    attrs = {
        'st_wind': ('FLOAT', part['aWind']),
        'st_anchor': ('FLOAT_VECTOR', to_bl(part['aStemCenter'])),
    }
    return build_mesh(name, part['position'], tris, part['uv'], part['normal'], attrs)


def _dome(Pt, center):
    """JS dome normal (tree space, unnormalized sum): normalize(p - c) + (0, .45, 0)."""
    d = Pt - np.array([center.x, center.y, center.z])
    ln = np.linalg.norm(d, axis=1)
    ln[ln == 0] = 1
    d = d / ln[:, None]
    d[:, 1] += 0.45
    return d


def _realize(template_pos, matrices):
    """Instance matrices (n,16 column-major) applied to template points -> (n*k,3)."""
    M = np.asarray(matrices, np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    T = np.asarray(template_pos, np.float64)
    out = np.einsum('nij,kj->nki', M[:, :3, :3], T) + M[:, None, :3, 3]
    return out.reshape(-1, 3), M


def cards_mesh(name, parts, flutter_scale=1.0):
    """Leaf / spray cards (one or more buildFoliage results) as one mesh."""
    if isinstance(parts, dict):
        parts = [parts]
    Ps, Ts, UVs, A = [], [], [], {k: [] for k in ('w', 'anc', 'th', 'dome', 'fx', 'fy', 'fz', 'fp')}
    base = 0
    for part in parts:
        if not part or part['count'] == 0:
            continue
        t = part['template']
        k = len(t['position'])
        n = part['count']
        Pt, M = _realize(t['position'], part['matrices'])
        Ps.append(Pt)
        tri = t['index'].reshape(-1, 3)
        Ts.append((tri[None, :, :] + (np.arange(n) * k)[:, None, None]).reshape(-1, 3) + base)
        UVs.append(np.tile(t['uv'], (n, 1)))
        base += n * k
        A['w'].append(np.repeat(part['windBase'], k))
        A['anc'].append(np.repeat(part['anchor'], k, axis=0))
        A['th'].append(np.repeat(part['thickness'], k))
        A['dome'].append(_dome(Pt, part['domeCenter']))
        # flutter (foliageWindPosition): vec3(sin f, .6 sin 1.31f, sin .77f) * 0.05*flutterScale
        # * rnd * localY * gate, in the instance frame; gate = clamp(|aWindVec| * 2.5).
        gate = np.clip(np.linalg.norm(part['windVec'], axis=1) * 2.5, 0, 1)
        rnd = part['thickness']
        local_y = np.maximum(np.asarray(t['position'], np.float64)[:, 1], 0)
        amp = (0.05 * part.get('flutterScale', flutter_scale) * rnd * gate)[:, None] * local_y[None, :]  # (n,k)
        cols = M[:, :3, :3]  # columns = instance local axes (scaled)
        for key, ci, mul in (('fx', 0, 1.0), ('fy', 1, 0.6), ('fz', 2, 1.0)):
            A[key].append((cols[:, None, :, ci] * (amp * mul)[:, :, None]).reshape(-1, 3))
        A['fp'].append(np.repeat(rnd * 37.7, k))
    if not Ps:
        return None
    P = np.concatenate(Ps)
    attrs = {
        'st_wind': ('FLOAT', np.concatenate(A['w'])),
        'st_anchor': ('FLOAT_VECTOR', to_bl(np.concatenate(A['anc']))),
        'st_thickness': ('FLOAT', np.concatenate(A['th'])),
        'st_dome': ('FLOAT_VECTOR', to_bl(np.concatenate(A['dome']))),
        'st_fx': ('FLOAT_VECTOR', to_bl(np.concatenate(A['fx']))),
        'st_fy': ('FLOAT_VECTOR', to_bl(np.concatenate(A['fy']))),
        'st_fz': ('FLOAT_VECTOR', to_bl(np.concatenate(A['fz']))),
        'st_fphase': ('FLOAT', np.concatenate(A['fp'])),
    }
    return build_mesh(name, P, np.concatenate(Ts), np.concatenate(UVs), None, attrs, smooth=False)


def card_set_mesh(name, card_set, slot_of):
    """Baked branch / rosette cards (core.branch_cards.build_card_foliage) realized as one
    mesh: every card mesh of the set (variant x front/side view) becomes a material slot,
    slot_of(mesh) -> material index. Wind, dome and backlight data as cards_mesh; the
    crossed sets (noFlutter) get no flutter, so a crossed pair stays welded."""
    from ..core.vmath import V3
    parts, slots = [], []
    for m in card_set['meshes']:
        if not m['count']:
            continue
        parts.append({
            'template': m['geometry'], 'count': m['count'], 'matrices': m['matrices'],
            'thickness': m['thickness'], 'windBase': m['weights'], 'windVec': m['windVec'],
            'anchor': m['anchor'], 'domeCenter': V3(*card_set['center']),
            'flutterScale': 1.0 if m['withFlutter'] else 0.0,
        })
        slots.append((slot_of(m), m['count'] * (len(m['geometry']['index']) // 3)))
    if not parts:
        return None
    me = cards_mesh(name, parts)
    idx = np.concatenate([np.full(n, s, np.int32) for s, n in slots])
    me.polygons.foreach_set('material_index', idx)
    me.update()
    return me


def willow_mesh(name, part, dome_center):
    Pt = part['position'].astype(np.float64)
    attrs = {
        'st_wind': ('FLOAT', part['aWind']),
        'st_anchor': ('FLOAT_VECTOR', to_bl(part['aAnchorPos'])),
        'st_thickness': ('FLOAT', part['aThickness']),
        'st_dome': ('FLOAT_VECTOR', to_bl(_dome(Pt, dome_center))),
    }
    return build_mesh(name, Pt, part['index'].reshape(-1, 3), part['uv'], part['normal'], attrs)


def cones_mesh(name, part):
    """Joshua / yucca rosette cones (crown + dead skirt) realized as one mesh."""
    rseg = part['coneRadialSegs']
    Ps, Ns, Ts, UVs = [], [], [], []
    A = {k: [] for k in ('w', 'anc', 'th', 'age', 'fx', 'fy', 'fz', 'fp')}
    base = 0
    for ci, lst in enumerate(part['slots']):
        if not lst:
            continue
        g = cone_geo(ci, rseg)
        k = len(g['position'])
        n = len(lst)
        mats = np.array([s['matrix'] for s in lst])
        Pt, M = _realize(g['position'], mats)
        Ps.append(Pt)
        # normals through the inverse-transpose (non-uniform drape scale)
        L = M[:, :3, :3]
        Linv_t = np.linalg.inv(L).transpose(0, 2, 1)
        Ns.append(np.einsum('nij,kj->nki', Linv_t, g['normal'].astype(np.float64)).reshape(-1, 3))
        tri = g['index'].reshape(-1, 3)
        Ts.append((tri[None, :, :] + (np.arange(n) * k)[:, None, None]).reshape(-1, 3) + base)
        UVs.append(np.tile(g['uv'], (n, 1)))
        base += n * k
        ly = np.asarray(g['position'], np.float64)[:, 1]  # cone-local Y: 0 apex, <0 down the drape
        tnorm = np.clip(-ly / 0.8, 0, 1)
        apex = np.array([s['wind'] for s in lst])
        rim = np.array([s['windTail'] for s in lst])
        A['w'].append((apex[:, None] * (1 - tnorm[None, :]) + rim[:, None] * tnorm[None, :]).reshape(-1))
        anc = np.array([[s['pos'].x, s['pos'].y, s['pos'].z] for s in lst])
        tan = np.array([s['tangent'] for s in lst])
        span = np.array([s['span'] for s in lst])
        walk = np.minimum(ly, 0)[None, :, None] * span[:, None, None] * tan[:, None, :]
        A['anc'].append((anc[:, None, :] + walk).reshape(-1, 3))
        th = np.array([s['thickness'] for s in lst])
        A['th'].append(np.repeat(th, k))
        A['age'].append(np.repeat([s['age'] for s in lst], k))
        local = np.maximum(ly, 0)
        amp = (0.05 * th)[:, None] * local[None, :]
        for key, c_i, mul in (('fx', 0, 1.0), ('fy', 1, 0.6), ('fz', 2, 1.0)):
            A[key].append((L[:, None, :, c_i] * (amp * mul)[:, :, None]).reshape(-1, 3))
        A['fp'].append(np.repeat(th * 37.7, k))
    if not Ps:
        return None
    attrs = {
        'st_wind': ('FLOAT', np.concatenate(A['w'])),
        'st_anchor': ('FLOAT_VECTOR', to_bl(np.concatenate(A['anc']))),
        'st_thickness': ('FLOAT', np.concatenate(A['th'])),
        'st_age': ('FLOAT', np.concatenate(A['age'])),
        'st_fx': ('FLOAT_VECTOR', to_bl(np.concatenate(A['fx']))),
        'st_fy': ('FLOAT_VECTOR', to_bl(np.concatenate(A['fy']))),
        'st_fz': ('FLOAT_VECTOR', to_bl(np.concatenate(A['fz']))),
        'st_fphase': ('FLOAT', np.concatenate(A['fp'])),
    }
    return build_mesh(name, np.concatenate(Ps), np.concatenate(Ts), np.concatenate(UVs), np.concatenate(Ns), attrs)


def fruit_mesh(name, part, template, offset):
    """Fruit instances realized from the imported GLB template.
    template = dict(position (k,3) three space, normal, uv, index) as authored;
    offset = prepareFruitGeometry translation (stem tip to origin)."""
    T = np.asarray(template['position'], np.float64) + np.asarray(offset)
    mats = np.array([s['matrix'] for s in part['instances']])
    Pt, M = _realize(T, mats)
    n, k = len(mats), len(T)
    L = M[:, :3, :3]
    N = np.einsum('nij,kj->nki', np.linalg.inv(L).transpose(0, 2, 1), np.asarray(template['normal'], np.float64)).reshape(-1, 3)
    tri = np.asarray(template['index']).reshape(-1, 3)
    tris = (tri[None, :, :] + (np.arange(n) * k)[:, None, None]).reshape(-1, 3)
    attrs = {
        'st_wind': ('FLOAT', np.repeat([s['windBase'] for s in part['instances']], k)),
        'st_anchor': ('FLOAT_VECTOR', to_bl(np.repeat([s['anchor'] for s in part['instances']], k, axis=0))),
    }
    return build_mesh(name, Pt, tris, np.tile(template['uv'], (n, 1)), N, attrs)


def link_object(name, me, collection, parent=None, materials=()):
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    for m in materials:
        me.materials.append(m)
    if parent is not None:
        ob.parent = parent
    return ob
