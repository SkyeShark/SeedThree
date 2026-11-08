"""Joshua-tree / yucca rosettes, ported from src/core/yucca-leaves.js.

A rosette is 10 nested STRAIGHT crown cones (open 14..120 deg, golden-angle
rolled, doubled at full density) plus a dead-leaf skirt of 8 bands (open
132..158 deg, bend 20..54 deg) placed every thatchStep down each arm, fork-knuckle
cones, hang caps and chord aiming. Age = distance to the nearest green crown
(fully dry at 1.8 m) and drives the green -> dry -> driest texture ramp. Cones
carry a planar radial UV over the circle-of-blades sprite.
"""

import math

import numpy as np

from .vmath import Q, V3, Y_AXIS as Y, compose, js_round
from .leaf_cards import WIND_DIR

GOLDEN = math.pi * (3 - math.sqrt(5))


def _hash1(n):
    s = math.sin(n * 127.1) * 43758.5453
    return s - math.floor(s)


def cone_geometry(open_=60, bend=0, radial_segs=12, length_segs=3, waviness=0.30):
    collar_r, uv_r = 0.015, 0.5
    open_r, bend_r = (open_ * math.pi) / 180, (bend * math.pi) / 180
    rr, hh = [collar_r], [0.0]
    for i in range(1, length_segs + 1):
        ai = open_r + bend_r * ((i - 0.5) / length_segs)
        dt = 1 / length_segs
        rr.append(rr[i - 1] + math.sin(ai) * dt)
        hh.append(hh[i - 1] + math.cos(ai) * dt)
    pos, uvs, idx = [], [], []
    for i in range(length_segs + 1):
        t = i / length_segs
        for j in range(radial_segs + 1):
            az = (j / radial_segs) * math.pi * 2
            jw = j % radial_segs
            y = hh[i] + (_hash1(jw * 3.17 + open_ * 0.7) - 0.5) * waviness * t * t
            pos.append((math.cos(az) * rr[i], y, math.sin(az) * rr[i]))
            uvs.append((0.5 + math.cos(az) * uv_r * t, 0.5 + math.sin(az) * uv_r * t))
    cols = radial_segs + 1
    for i in range(length_segs):
        for j in range(radial_segs):
            p = i * cols + j
            idx += [p, p + cols, p + 1, p + 1, p + cols, p + cols + 1]
    P = np.array(pos, np.float32)
    I = np.array(idx, np.int64)
    from .dichotomous import _compute_vertex_normals
    return {'position': P, 'uv': np.array(uvs, np.float32), 'index': I,
            'normal': _compute_vertex_normals(P, I).astype(np.float32)}


CROWN = [
    {'open': 14, 'bend': 0, 'lseg': 3, 'lenMul': 0.70, 'age': 0.05},
    {'open': 30, 'bend': 0, 'lseg': 3, 'lenMul': 0.90, 'age': 0.11},
    {'open': 46, 'bend': 0, 'lseg': 3, 'lenMul': 1.00, 'age': 0.17},
    {'open': 54, 'bend': 2, 'lseg': 3, 'lenMul': 1.00, 'age': 0.20},
    {'open': 62, 'bend': 6, 'lseg': 4, 'lenMul': 1.00, 'age': 0.23},
    {'open': 78, 'bend': 0, 'lseg': 3, 'lenMul': 1.00, 'age': 0.29},
    {'open': 90, 'bend': 0, 'lseg': 3, 'lenMul': 1.00, 'age': 0.32},
    {'open': 92, 'bend': 8, 'lseg': 4, 'lenMul': 1.00, 'age': 0.35},
    {'open': 106, 'bend': 14, 'lseg': 4, 'lenMul': 1.00, 'age': 0.40},
    {'open': 120, 'bend': 22, 'lseg': 4, 'lenMul': 0.98, 'age': 0.45},
]
SKIRT_BANDS = 8
SKIRT = []
for _b in range(SKIRT_BANDS):
    _f = _b / (SKIRT_BANDS - 1)
    SKIRT.append({'open': 132 + 26 * _f, 'bend': 20 + 34 * _f, 'lseg': 4 + js_round(_f), 'skirt': True})
CROWN_N = len(CROWN)
CONES = CROWN + SKIRT
_CONE_CACHE = {}
_CONE_YMIN = {}


def cone_geo(i, rseg=12):
    key = (i, rseg)
    if key not in _CONE_CACHE:
        c = CONES[i]
        _CONE_CACHE[key] = cone_geometry(c['open'], c['bend'], rseg, c['lseg'])
    return _CONE_CACHE[key]


def cone_y_min(i):
    if i not in _CONE_YMIN:
        c = CONES[i]
        open_r, bend_r, n = (c['open'] * math.pi) / 180, (c['bend'] * math.pi) / 180, c['lseg']
        h = hmin = 0
        for k in range(1, n + 1):
            h += math.cos(open_r + bend_r * ((k - 0.5) / n)) / n
            hmin = min(hmin, h)
        _CONE_YMIN[i] = max(0.05, abs(hmin))
    return _CONE_YMIN[i]


DEFAULTS = {'leafLen': 0.6, 'leafLenVar': 0.12, 'thatchStep': 0.14, 'density': 1}
CAP = 1024  # the JS pre-allocates 1024 instances per cone type; kept for parity


class _Frame:
    __slots__ = ('pos', 'quat', 'wind', 'radius', 'total')

    def __init__(self):
        self.pos = V3()
        self.quat = Q()
        self.wind = 0.5
        self.radius = 0.1
        self.total = 0


def _frame_at(stem, back, out):
    pts, oris = stem['points'], stem['orients']
    total = 0
    seg_len = []
    for i in range(len(pts) - 1):
        l = pts[i].distance_to(pts[i + 1])
        seg_len.append(l)
        total += l
    rem = total - back
    si = 0
    while si < len(seg_len) - 1 and rem > seg_len[si]:
        rem -= seg_len[si]
        si += 1
    st = max(0, min(1, rem / seg_len[si] if seg_len[si] > 0 else 0))
    out.pos.copy(pts[si]).lerp(pts[si + 1], st)
    out.quat.copy(oris[si]).slerp(oris[si + 1], st)
    w = stem.get('winds')
    out.wind = w[si] * (1 - st) + w[si + 1] * st if w else 0.5
    r = stem.get('radii')
    out.radius = r[si] * (1 - st) + r[si + 1] * st if r else 0.1
    out.total = total
    return out


def build_yucca_foliage(terminal_stems, cfg, rng, all_stems=None):
    """-> dict(kind='cones', slots=[[instance...] per cone type], coneRadialSegs) or None.
    Each instance: pos V3, quat Q, len, yScale, wind, windTail, age, thickness,
    matrix (16), tangent (3)."""
    c = dict(DEFAULTS)
    c.update(cfg)
    if not terminal_stems:
        return None
    slots = [[] for _ in CONES]
    rp = _Frame()
    rp_tail = _Frame()
    q = Q()
    q_roll = Q()
    shift = V3()
    chord = V3()
    SKIRT_UPSHIFT = 0.06

    def emit(ci, pos, quat, wind, ln, age, spin=0, y_scale=1, wind_tail=None, roll_jit=math.pi * 2):
        q_roll.set_from_axis_angle(Y, spin + rng.range(0, roll_jit))
        q.copy(quat).multiply(q_roll)
        slots[ci].append({'pos': pos.clone(), 'quat': q.clone(), 'len': ln, 'yScale': y_scale, 'wind': wind,
                          'windTail': wind if wind_tail is None else wind_tail,
                          'age': max(0, min(1, age))})

    max_y = -1e9
    for s in terminal_stems:
        max_y = max(max_y, s['points'][-1].y)
    base_y = 0

    green_tops = []
    density = c.get('density')
    density = 1 if density is None else density
    crown_copies = 2 if density >= 1 else 1
    crown_frac = max(0.15, min(1, density / 0.5)) if c.get('skirtToBark') else 1
    for stem in terminal_stems:
        _frame_at(stem, 0.02, rp)
        green_tops.append(rp.pos.clone())
        crown_acc = 0
        for ci in range(CROWN_N):
            lm, ag = CONES[ci]['lenMul'], CONES[ci]['age']
            for d in range(crown_copies):
                crown_acc += crown_frac
                if crown_acc < 1:
                    continue
                crown_acc -= 1
                ln = c['leafLen'] * lm * (1 + rng.vary(0, c['leafLenVar']))
                age = ag + rng.vary(0, 0.04)
                emit(ci, rp.pos, rp.quat, rp.wind, ln, age, ci * GOLDEN + d * GOLDEN * 0.5, 1, None, 0.5)

    DRY_SPAN = 1.8

    def dist_to_green(pt):
        best = math.inf
        for g in green_tops:
            d = g.distance_to_squared(pt)
            if d < best:
                best = d
        return math.sqrt(best) if green_tops else DRY_SPAN

    def dry_age(pt):
        return 0.42 + 0.58 * min(1, dist_to_green(pt) / DRY_SPAN)

    skirt_stems = terminal_stems if c.get('skirtToBark') else (all_stems if all_stems is not None else terminal_stems)
    step = c.get('thatchStep')
    step = 0.12 if step is None else step
    baby_tree = len(terminal_stems) > 0 and all(s['level'] == 0 for s in terminal_stems)
    baby_bare_y = max_y * 0.35
    for stem in skirt_stems:
        is_trunk = stem['level'] == 0
        children = stem.get('children') or []
        trunk_fork = is_trunk and len(children) >= 2
        if is_trunk and not trunk_fork and not baby_tree:
            continue
        _frame_at(stem, 0, rp)
        total = rp.total
        is_cont_par = len(children) == 1 and children[0]['level'] == stem['level']
        start = 0.12 if (stem.get('terminal') or is_cont_par) else 0.0
        if trunk_fork:
            end = min(total * 0.99, 0.45)
        elif c.get('skirtToBark'):
            stl = c.get('skirtTopLen')
            end = min(total * 0.99, start + (0.3 if stl is None else stl))
        else:
            end = total * 0.99
        keep_acc = 0
        back = start
        while back < end:
            _frame_at(stem, back, rp)
            shift.set(0, 1, 0).apply_quaternion(rp.quat)
            cap_boost = max(0, 1 - (back - start) / 0.25) * 0.07
            rp.pos.add_scaled(shift, SKIRT_UPSHIFT + cap_boost)
            if baby_tree and is_trunk and rp.pos.y < baby_bare_y:
                back += step
                continue
            down_frac = max(0, min(1, (max_y - rp.pos.y) / max(0.6, max_y - base_y)))
            keep_acc += max(0.12, 1 - down_frac * 2 * (1 - density))
            if keep_acc < 1:
                back += step
                continue
            keep_acc -= 1
            band = min(SKIRT_BANDS - 1, math.floor(down_frac * SKIRT_BANDS))
            band_open = CONES[CROWN_N + band]['open'] * math.pi / 180
            sin_o = max(0.35, math.sin(band_open))
            ln = max(c['leafLen'] * 0.72, (rp.radius + 0.14 + 0.26 * down_frac) / sin_o) * (1 + rng.vary(0, c['leafLenVar']))
            cone_len = min(ln, c['leafLen'] * 0.7) if (is_trunk and trunk_fork) else ln
            y_min = cone_y_min(CROWN_N + band)
            y_scale = 1
            if trunk_fork:
                y_scale = min(1, 0.5 / (y_min * cone_len))
            if baby_tree and is_trunk:
                y_scale = min(y_scale, max(0, rp.pos.y - baby_bare_y) / (y_min * cone_len))
            y_scale = min(y_scale, (c['leafLen'] * 0.5) / (y_min * cone_len))
            drape_m = y_min * cone_len * y_scale
            _frame_at(stem, min(total * 0.999, back + drape_m), rp_tail)
            chord.sub_vectors(rp.pos, rp_tail.pos)
            if chord.length_sq() > 1e-6:
                q_aim = Q().set_from_unit_vectors(Y, chord.normalize())
            else:
                q_aim = rp.quat
            age = dry_age(rp.pos) + rng.vary(0, 0.03)
            emit(CROWN_N + band, rp.pos, q_aim, rp.wind, cone_len, age, back * 4.0, y_scale, rp_tail.wind)
            back += step

    tan = V3()
    kpos = V3()
    for stem in skirt_stems:
        children = stem.get('children') or []
        if stem['level'] < 1 or len(children) < 2:
            continue
        _frame_at(stem, 0, rp)
        if rp.total < 0.12:
            continue
        tan.set(0, 1, 0).apply_quaternion(rp.quat)
        kpos.copy(rp.pos).add_scaled(tan, 0.15)
        down_frac = max(0, min(1, (max_y - rp.pos.y) / max(0.6, max_y - base_y)))
        band = min(SKIRT_BANDS - 1, math.floor(down_frac * SKIRT_BANDS))
        sin_o = max(0.35, math.sin(CONES[CROWN_N + band]['open'] * math.pi / 180))
        ln = max(c['leafLen'] * 0.62, (rp.radius + 0.22) / sin_o) * (1 + rng.vary(0, c['leafLenVar']))
        drape_m = 0.8 * ln
        _frame_at(stem, min(rp.total * 0.999, drape_m), rp_tail)
        age = dry_age(kpos) + rng.vary(0, 0.03)
        emit(CROWN_N + band, kpos, rp.quat, rp.wind, ln, age, 2.1, 1, rp_tail.wind)

    cone_rseg = max(3, js_round(c.get('coneRadialSegs') if c.get('coneRadialSegs') is not None else 12))
    scl = V3()
    q_inv = Q()
    wv = V3()
    tan_l = V3()
    any_inst = False
    for ci in range(len(CONES)):
        lst = slots[ci][:CAP]
        slots[ci] = lst
        for s in lst:
            ys = s['yScale']
            scl.set(s['len'], s['len'] * ys, s['len'])
            s['matrix'] = compose(s['pos'], s['quat'], scl)
            q_inv.copy(s['quat']).invert()
            wv.copy(WIND_DIR).apply_quaternion(q_inv)
            s['windVec'] = (wv.x / s['len'], wv.y / (s['len'] * ys), wv.z / s['len'])
            tan_l.set(0, 1, 0).apply_quaternion(s['quat'])
            s['tangent'] = (tan_l.x, tan_l.y, tan_l.z)
            s['thickness'] = 0.3 + 0.25 * rng.next() if s['age'] > 0.6 else 0.08 + 0.1 * rng.next()
            s['span'] = s['len'] * ys
            any_inst = True
    if not any_inst:
        return None
    return {'kind': 'cones', 'slots': slots, 'coneRadialSegs': cone_rseg}
