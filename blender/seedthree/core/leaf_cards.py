"""Leaf and spray cards, ported from src/core/leaf-cards.js (buildFoliage,
keepSpraySubset, makeLeafGeometry).

Cards are anchored at their base on the terminal stem centreline, oriented by
the branch frame, pitched by a down-angle, spun by golden-angle phyllotaxy (or
whorls), bent toward light, drooped by gravity, and tapered toward the tip.
The JS builds an InstancedMesh; here the result is plain data: a card template
and per-instance matrices plus the per-instance attributes the materials and
wind read (aThickness, wind weight, wind heading, anchor).
"""

import math

import numpy as np

from .jsutil import nz
from .vmath import Q, V3, X_AXIS as X, Y_AXIS as Y, UP, compose, js_round

DOWN = V3(0, -1, 0)
GOLDEN = (137.5 * math.pi) / 180
WIND_DIR = V3(0.85, 0, 0.53).normalize()


def make_leaf_geometry(quads=2, top_anchored=False):
    """Base-anchored quad(s): base edge at y=0, tip at y=1, width along x, normal +Z.
    quads=2 adds a second quad rotated 90 degrees about the length axis."""
    base = [(-0.5, 0), (0.5, 0), (0.5, 1), (-0.5, 1)]
    uv = [(0, 1), (1, 1), (1, 0), (0, 0)] if top_anchored else [(0, 0), (1, 0), (1, 1), (0, 1)]
    pos, nrm, uvs, idx = [], [], [], []
    b = 0
    for q in range(quads):
        a = (q * math.pi) / quads
        ca, sa = math.cos(a), math.sin(a)
        for i in range(4):
            x, y = base[i]
            pos.append((x * ca, y, x * sa))
            nrm.append((-sa, 0.0, ca))
            uvs.append(uv[i])
        idx += [b, b + 1, b + 2, b, b + 2, b + 3]
        b += 4
    return {
        'position': np.array(pos, np.float32),
        'normal': np.array(nrm, np.float32),
        'uv': np.array(uvs, np.float32),
        'index': np.array(idx, np.int64),
    }


DEFAULTS = {
    'leavesPerBranch': 14,
    'size': 0.55,
    'sizeVar': 0.3,
    'widthRatio': 0.62,
    'taper': 0.35,
    'startFrac': 0.1,
    'downAngle': 52,
    'downAngleV': 18,
    'droop': 22,
    'droopV': 12,
    'bend': 0,
    'whorlSize': 1,
    'rotate': 90,
    'rotateV': 0,
    'quads': 2,
    'tint': 0x88a24a,
    'flutterScale': 1,
    'alphaTest': 0.4,
    'trunkClearRadius': 0,
    'domeStrength': 0.45,
    'mode': 'leaves',
    'clustersPerBranch': 3,
    'clusterSize': 1.3,
    'clusterSizeVar': 0.3,
    'clusterQuads': 2,
}


def foliage_config(cfg):
    c = dict(DEFAULTS)
    c.update(cfg)
    if c['mode'] == 'clusters':
        c.update({
            'leavesPerBranch': c['clustersPerBranch'],
            'size': c['clusterSize'],
            'sizeVar': c['clusterSizeVar'],
            'quads': c['clusterQuads'],
            'startFrac': nz(cfg.get('startFrac'), 0.35),
            'taper': 0.25,
            'widthRatio': 1.0,
        })
    return c


def dome_center(terminal_stems):
    """Canopy-dome origin the foliage normals point away from: centroid of the
    terminal tips in X/Z, sat at the canopy bottom (never above a leaf)."""
    center = V3()
    min_y, max_y = math.inf, -math.inf
    for s in terminal_stems:
        center.add(s['points'][-1])
        for p in s['points']:
            min_y = min(min_y, p.y)
            max_y = max(max_y, p.y)
    crown_span = max(0.5, max_y - min_y)
    center.divide_scalar(len(terminal_stems))
    dome = V3(center.x, min(min_y - 0.5, center.y - 1), center.z)
    return dome, min_y, crown_span


def build_foliage(terminal_stems, cfg, rng):
    """-> dict(kind='cards', template, matrices[n,16], thickness[n], windBase[n],
    windVec[n,3] (instance-local heading x weight / scale, as in JS),
    anchor[n,3], domeCenter V3, count) or a willow-curtain mesh dict, or None."""
    c = foliage_config(cfg)
    hanging = c['mode'] == 'hangingSprays'
    willow = c['mode'] == 'willowCurtains'
    if not terminal_stems or c['leavesPerBranch'] <= 0:
        return None

    dome, min_y, crown_span = dome_center(terminal_stems)
    if willow:
        from .willow_curtains import build_willow_curtains
        out = build_willow_curtains(terminal_stems, c, rng)
        if out is not None:
            out['domeCenter'] = dome
        return out

    template = make_leaf_geometry(c['quads'], hanging)
    count = len(terminal_stems) * c['leavesPerBranch']
    mats, wbase, wvec, anchors = [], [], [], []

    q = Q()
    q_frame = Q()
    q1 = Q()
    q2 = Q()
    qb = Q()
    pos = V3()
    scl = V3()
    n = V3()
    guide = V3()
    droop_axis = V3()
    q_inv = Q()
    wv = V3()

    leaf_whorl = max(1, js_round(nz(c.get('whorlSize'), 1)))
    leaf_whorl_nodes = math.ceil(c['leavesPerBranch'] / leaf_whorl)
    leaf_rotate = (nz(c.get('rotate'), 90) * math.pi) / 180
    leaf_rotate_v = (max(0, nz(c.get('rotateV'), 0)) * math.pi) / 180
    trunk_clear = c['trunkClearRadius']

    def push(windbase, s_vec):
        q_inv.copy(q).invert()
        wv.copy(WIND_DIR).apply_quaternion(q_inv)
        wvec.append(((wv.x / s_vec.x) * windbase, (wv.y / s_vec.y) * windbase, (wv.z / s_vec.z) * windbase))
        wbase.append(windbase)
        anchors.append((pos.x, pos.y, pos.z))
        mats.append(compose(pos, q, s_vec))

    for stem in terminal_stems:
        pts, oris = stem['points'], stem['orients']
        seg_n = len(pts) - 1
        phyllo = rng.range(0, math.pi * 2)
        whorl_frac = 0
        whorl_plane = phyllo

        if hanging:
            guide.copy(pts[-1]).sub(pts[0])
            chord = guide.length()
            if chord < 1e-4:
                continue
            guide.divide_scalar(chord)
            guide_len = max(chord, nz(stem.get('length'), chord))
            q1.set_from_unit_vectors(Y, guide)
            sprays = max(0, js_round(c['leavesPerBranch']))
            for i in range(sprays):
                pos.copy(pts[0])
                wb = stem['winds'][0] if stem.get('winds') else 0.75
                q2.set_from_axis_angle(Y, rng.range(0, math.pi * 2))
                q.copy(q1).multiply(q2)
                s = guide_len * c['size'] * max(0.2, 1 + rng.vary(0, c['sizeVar']))
                if c.get('hangFloor') is not None and guide.y < -0.02:
                    s = min(s, max(0, (pos.y - c['hangFloor']) / -guide.y))
                if s < 0.03:
                    continue
                scl.set(s * c['widthRatio'], s, s)
                push(wb, scl)
            continue

        for i in range(c['leavesPerBranch']):
            whorl_slot = i % leaf_whorl
            leaf_roll = phyllo
            if leaf_whorl > 1:
                node_index = i // leaf_whorl
                if whorl_slot == 0:
                    whorl_frac = c['startFrac'] + (1 - c['startFrac']) * ((node_index + rng.next()) / leaf_whorl_nodes)
                    whorl_plane += leaf_rotate + rng.vary(0, leaf_rotate_v)
                frac = whorl_frac
                leaf_roll = whorl_plane + (math.pi * 2 * whorl_slot) / leaf_whorl
            else:
                frac = c['startFrac'] + (1 - c['startFrac']) * ((i + rng.next()) / c['leavesPerBranch'])
            fseg = min(seg_n - 1, math.floor(frac * seg_n))
            ft = frac * seg_n - fseg
            pos.copy(pts[fseg]).lerp(pts[fseg + 1], ft)
            if trunk_clear > 0:
                h_frac = (pos.y - min_y) / crown_span
                eff = trunk_clear * max(0, 1 - h_frac / 0.65)
                if eff > 0 and math.hypot(pos.x, pos.z) < eff:
                    continue
            q_frame.copy(oris[fseg]).slerp(oris[fseg + 1], ft)
            w = stem.get('winds')
            wb = w[fseg] * (1 - ft) + w[fseg + 1] * ft if w else 0.9

            if leaf_whorl > 1:
                q2.set_from_axis_angle(Y, leaf_roll)
            else:
                phyllo += GOLDEN + rng.vary(0, 0.3)
                q2.set_from_axis_angle(Y, phyllo)
            down = (c['downAngle'] + rng.vary(0, c['downAngleV'])) * math.pi / 180
            q1.set_from_axis_angle(X, down)
            q.copy(q_frame).multiply(q2).multiply(q1)

            if c['bend'] > 0:
                n.set(0, 0, 1).apply_quaternion(q)
                tpos = math.atan2(pos.z, pos.x)
                tbend = tpos - math.atan2(n.z, n.x)
                qb.set_from_axis_angle(UP, c['bend'] * tbend)
                q.premultiply(qb)
                n.set(0, 0, 1).apply_quaternion(q)
                fbend = math.atan2(math.hypot(n.x, n.z), n.y)
                qb.set_from_axis_angle(X, c['bend'] * fbend)
                q.multiply(qb)

            if c['droop'] > 0:
                n.set(0, 1, 0).apply_quaternion(q)
                droop_axis.cross_vectors(n, DOWN)
                if droop_axis.length_sq() > 1e-6:
                    droop_axis.normalize()
                    qb.set_from_axis_angle(droop_axis, (c['droop'] + rng.vary(0, c['droopV'])) * math.pi / 180)
                    q.premultiply(qb)

            s = c['size'] * (1 - c['taper'] * frac) * (1 + rng.vary(0, c['sizeVar']))
            scl.set(s * c['widthRatio'], s, s)
            push(wb, scl)

    # Per-instance thickness is drawn for every SLOT (count), after placement, and
    # instance k takes the k-th draw (JS addThicknessAttribute over the full count).
    thick = [0.4 + rng.next() * 0.6 for _ in range(count)]
    k = len(mats)
    return {
        'kind': 'cards',
        'template': template,
        'matrices': np.array(mats, np.float64).reshape(-1, 16),
        'thickness': np.array(thick[:k], np.float64),
        'windBase': np.array(wbase, np.float64),
        'windVec': np.array(wvec, np.float64).reshape(-1, 3),
        'anchor': np.array(anchors, np.float64).reshape(-1, 3),
        'domeCenter': dome,
        'count': k,
        'flutterScale': c.get('flutterScale', 1),
        'withFlutter': True,
    }


def keep_spray_subset(fol, keep, shell=0.7):
    """Nested, silhouette-first subset of a card set, in place (keepSpraySubset)."""
    n = fol['count']
    keep_n = max(1, min(n, js_round(n * max(0, min(1, keep)))))
    if keep_n >= n:
        return fol
    m = fol['matrices']
    # Float32 instance matrices in JS: mirror that precision for the ranking.
    t = m[:, 12:15].astype(np.float32).astype(np.float64)
    c = V3()
    for i in range(n):
        c.add(V3(t[i, 0], t[i, 1], t[i, 2]))
    c.divide_scalar(n)
    r = np.zeros(n)
    r_max = 1e-6
    for i in range(n):
        r[i] = math.sqrt((t[i, 0] - c.x) ** 2 + (t[i, 1] - c.y) ** 2 + (t[i, 2] - c.z) ** 2)
        r[i] = float(np.float32(r[i]))
        r_max = max(r_max, r[i])
    golden = 0.6180339887498949
    scored = [(shell * (1 - r[i] / r_max) + (1 - shell) * (((i + 1) * golden) % 1), i) for i in range(n)]
    scored.sort(key=lambda e: (e[0], e[1]))
    order = sorted(i for _, i in scored[:keep_n])
    for key in ('matrices', 'thickness', 'windBase', 'windVec', 'anchor'):
        fol[key] = fol[key][order]
    fol['count'] = keep_n
    return fol
