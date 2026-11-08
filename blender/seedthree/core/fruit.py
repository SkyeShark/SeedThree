"""Fruit placement, ported from src/core/fruit.js (buildFruits).

The fruit GLB is re-origined to the top-centre of its bounding box (the stem
tip), hung straight down with a small tilt and free yaw from fruiting wood, with
anti-clip rejection against every rendered stem and a maxCount cap. The JS
headless API never loads the GLBs (no fruit in eidoverse); this port does.
"""

import json
import math
import os
import struct

from .vmath import Q, V3, X_AXIS as X, Y_AXIS as Y, compose
from .leaf_cards import WIND_DIR

DEFAULTS = {'perBranch': 1, 'chance': 0.55, 'startFrac': 0.35, 'scale': 1, 'scaleVar': 0.15,
            'tiltVar': 12, 'maxCount': 120}


def glb_bounds(path):
    """Axis-aligned bounds (three's Y-up frame) of a single-mesh GLB's POSITION
    accessor, after the node's translation/scale. Returns (min, max) tuples."""
    with open(path, 'rb') as fh:
        data = fh.read()
    jlen = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + jlen])
    node = next(n for n in doc['nodes'] if 'mesh' in n)
    prim = doc['meshes'][node['mesh']]['primitives'][0]
    acc = doc['accessors'][prim['attributes']['POSITION']]
    mn, mx = list(acc['min']), list(acc['max'])
    s = node.get('scale', [1, 1, 1])
    t = node.get('translation', [0, 0, 0])
    mn = [mn[i] * s[i] + t[i] for i in range(3)]
    mx = [mx[i] * s[i] + t[i] for i in range(3)]
    return tuple(min(a, b) for a, b in zip(mn, mx)), tuple(max(a, b) for a, b in zip(mn, mx))


def prepared_bounds(bmin, bmax):
    """Bounds after prepareFruitGeometry (origin moved to the top-centre) and the
    translation that was applied."""
    cx = (bmin[0] + bmax[0]) / 2
    cz = (bmin[2] + bmax[2]) / 2
    off = (-cx, -bmax[1], -cz)
    return (tuple(bmin[i] + off[i] for i in range(3)), tuple(bmax[i] + off[i] for i in range(3))), off


def build_fruits(terminal_stems, cfg, rng, bounds, obstacles=None):
    """bounds = prepared (min, max). -> dict(kind='fruit', instances=[...]) or None."""
    c = dict(DEFAULTS)
    c.update(cfg)
    if not terminal_stems or c['perBranch'] <= 0:
        return None
    expected = len(terminal_stems) * c['perBranch'] * c['chance']
    if c['maxCount'] > 0 and expected > c['maxCount']:
        c['chance'] *= c['maxCount'] / expected
    bmin, bmax = bounds
    body_drop = -bmin[1] * 0.55
    body_r = max((bmax[0] - bmin[0]), (bmax[2] - bmin[2]), -bmin[1]) * 0.5

    q = Q()
    q_tilt = Q()
    pos = V3()
    tan = V3()
    body = V3()
    q_inv = Q()
    wv = V3()
    out = []
    for stem in terminal_stems:
        pts = stem['points']
        seg_n = len(pts) - 1
        for i in range(c['perBranch']):
            if rng.next() > c['chance']:
                continue
            frac = c['startFrac'] + (1 - c['startFrac']) * ((i + rng.next()) / c['perBranch'])
            fseg = min(seg_n - 1, math.floor(frac * seg_n))
            ft = frac * seg_n - fseg
            pos.copy(pts[fseg]).lerp(pts[fseg + 1], ft)
            tan.sub_vectors(pts[fseg + 1], pts[fseg]).normalize()
            if not c.get('bakeCard') and abs(tan.y) > 0.72:
                continue
            radii = stem.get('radii')
            twig_r = radii[fseg] * (1 - ft) + radii[fseg + 1] * ft if radii else 0.01
            pos.y -= twig_r * 0.95
            if obstacles:
                body.copy(pos)
                body.y -= body_drop
                hit = False
                lim = (twig_r + body_r) ** 2 * 0.9
                bx, by, bz = body.x, body.y, body.z
                for ob in obstacles:
                    opts, orad = ob['points'], ob.get('radii')
                    for k in range(len(opts)):
                        o = opts[k]
                        rr = (orad[k] if orad else 0.01) + body_r * 0.85
                        dx, dy, dz = bx - o.x, by - o.y, bz - o.z
                        if dx * dx + dy * dy + dz * dz < rr * rr and o is not pts[fseg]:
                            if o.distance_to_squared(pos) > lim:
                                hit = True
                                break
                    if hit:
                        break
                if hit:
                    continue
            q_tilt.set_from_axis_angle(X, (rng.vary(0, c['tiltVar']) * math.pi) / 180)
            q.set_from_axis_angle(Y, rng.range(0, math.pi * 2)).multiply(q_tilt)
            s = c['scale'] * (1 + rng.vary(0, c['scaleVar']))
            w = stem.get('winds')
            wind_base = w[fseg] * (1 - ft) + w[fseg + 1] * ft if w else 0.8
            q_inv.copy(q).invert()
            wv.copy(WIND_DIR).apply_quaternion(q_inv)
            out.append({
                'matrix': compose(pos, q, V3(s, s, s)),
                'windBase': wind_base,
                'windVec': ((wv.x / s) * wind_base, (wv.y / s) * wind_base, (wv.z / s) * wind_base),
                'anchor': (pos.x, pos.y, pos.z),
            })
    if not out:
        return None
    return {'kind': 'fruit', 'instances': out}
