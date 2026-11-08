"""Weber & Penn parametric tree skeleton, ported line by line from
src/core/weber-penn.js (same draws in the same order, three's Y-up frame).

generate_skeleton(params, rng) -> {'stems', 'tips', 'params'}. Each stem is a dict:
level, points [V3], radii, orients [Q] (local +Y = tangent), winds, length,
radialSegments, lobes, lobeDepth, maxLevel, openTip, role, id, parentId.
"""

import copy
import math

from .jsutil import at, is_finite, nz, to_int32
from .vmath import Q, V3, X_AXIS as X, Y_AXIS as Y, Z_AXIS as Z, UP, js_round, q_around


def shape_ratio(shape, ratio):
    if shape == 0:
        return 0.2 + 0.8 * ratio
    if shape == 1:
        return 0.2 + 0.8 * math.sin(math.pi * ratio)
    if shape == 2:
        return 0.2 + 0.8 * math.sin(0.5 * math.pi * ratio)
    if shape == 3:
        return 1.0
    if shape == 4:
        return 0.5 + 0.5 * ratio
    if shape == 5:
        return ratio / 0.7 if ratio <= 0.7 else (1 - ratio) / 0.3
    if shape == 6:
        return 1.0 - 0.8 * ratio
    if shape == 7:
        return 0.5 + 0.5 * ratio / 0.7 if ratio <= 0.7 else 0.5 + 0.5 * (1 - ratio) / 0.3
    return 1.0


def unit_taper(n):
    if n is None:
        return 0
    if n < 1:
        return n
    if n < 2:
        return 2 - n
    return 0


DEFAULTS = {
    'seed': 'tree',
    'scale': 12, 'scaleV': 2,
    'levels': 3,
    'ratio': 0.03,
    'ratioPower': 1.2,
    'baseSize': 0.25,
    'shape': 2,
    'flare': 0.6,
    'lobes': 0, 'lobeDepth': 0,
    'attractionUp': 0.5,
    'attractionUpMinLevel': 2,
    'forceDir': {'x': 0, 'y': 1, 'z': 0},
    'forceStrength': 0,
    'forceMinLevel': 0,
    'forceLevelScale': None,
    'baseSplits': 0,
    'baseSplitAngle': 20,
    'trunkForkHeight': None,
    'trunkForkCount': 2,
    'trunkForkAngle': 24,
    'trunkForkAngleV': 6,
    'trunkForkRadiusKeep': 0.72,
    'trunkForkBaseTaper': 0.18,
    'trunkForkFlareScale': 1,
    'decurrentTrunk': False,
    'decurrentTrunkExtension': 0.018,
    'forkChance': 0.82,
    'length': [1.0, 0.45, 0.4, 0.35],
    'lengthV': [0.0, 0.1, 0.1, 0.1],
    'taper': [1.0, 1.0, 1.0, 1.0],
    'curveRes': [10, 6, 4, 3],
    'curve': [10, 40, 40, 0],
    'curveBack': [0, 0, 0, 0],
    'curveV': [40, 60, 60, 60],
    'zigzagAngle': [0, 0, 0, 0],
    'zigzagAngleV': [0, 0, 0, 0],
    'downAngle': [0, 60, 50, 45],
    'downAngleV': [0, 20, 20, 20],
    'rotate': [0, 140, 140, 140],
    'rotateV': [0, 20, 20, 20],
    'whorlSize': [1, 1, 1, 1],
    'twist': [0, 0, 0, 0],
    'branchStart': None,
    'branchEnd': None,
    'branchDistPower': None,
    'downAngleProgress': [0, 0, 0, 0],
    'lengthScaleBase': [1, 1, 1, 1],
    'lengthScaleTip': [1, 1, 1, 1],
    'branchJitter': None,
    'branchSpacing': None,
    'branchMin': None,
    'branchMax': None,
    'lengthAbsolute': None,
    'lengthAbsoluteV': None,
    'lengthMin': None,
    'lengthMax': None,
    'terminalFloor': None,
    'terminalFloorV': 0,
    'terminalFloorWave': 0,
    'terminalFloorLobes': 3,
    'terminalFloorMin': None,
    'terminalFloorMax': None,
    'branches': [0, 30, 12, 0],
    'tipCluster': [0, 0, 0, 0],
    'radialSegments': [10, 8, 6, 5],
}


def default_params():
    return copy.deepcopy(DEFAULTS)


def _num(v):
    """JS arithmetic on undefined/null: undefined -> NaN, null -> 0."""
    return v


def generate_skeleton(user_params, rng):
    p = copy.deepcopy(DEFAULTS)
    p.update(user_params)  # shallow merge: a species array replaces the default wholesale
    stems = []
    tips = []

    trunk_len = p['scale'] + rng.vary(0, p['scaleV'])
    if nz(at(p.get('tipCluster'), 1), 0) > 0.5:
        trunk_len *= 0.45 + 1.1 * nz(p.get('baseSize'), 0.5)
    trunk_radius = trunk_len * p['ratio']

    tfh = p.get('trunkForkHeight')
    fork_height = max(0.05, min(0.85, tfh)) if is_finite(tfh) else None
    fork_count = max(2, js_round(nz(p.get('trunkForkCount'), 2)))
    use_shared_bole = fork_height is not None and to_int32(p.get('baseSplits')) == 0

    if use_shared_bole:
        _build_stem(
            level=0, origin=V3(0, 0, 0), orient=Q(), length=trunk_len * fork_height,
            radius=trunk_radius, taper_override=nz(p.get('trunkForkBaseTaper'), 0.18),
            curve_res_override=max(2, js_round(nz(at(p.get('curveRes'), 0), 10) * fork_height)),
            curve_scale=fork_height, suppress_children=True, open_tip=True, role='sharedBole',
            p=p, rng=rng, stems=stems, tips=tips)
        base = stems[0]
        fork_origin = base['points'][-1].clone()
        fork_orient = base['orients'][-1].clone()
        fork_radius = base['radii'][-1]
        fork_wind = base['winds'][-1]
        fork_plane_az = rng.range(0, 360)
        total_primary = max(0, js_round(nz(at(p.get('branches'), 1), 0)))
        quota_base = total_primary // fork_count
        quota_extra = total_primary % fork_count
        for t in range(fork_count):
            angle = max(1, rng.vary(nz(p.get('trunkForkAngle'), 24), nz(p.get('trunkForkAngleV'), 6)))
            orient = fork_orient.clone() \
                .multiply(q_around(Y, fork_plane_az + (360 / fork_count) * t)) \
                .multiply(q_around(X, angle))
            compensation = min(1.35, 1 / max(0.72, math.cos(angle * math.pi / 180)))
            leader_length = trunk_len * (1 - fork_height) * compensation
            _build_stem(
                level=0, origin=fork_origin, orient=orient, length=leader_length,
                radius=fork_radius * nz(p.get('trunkForkRadiusKeep'), 0.72),
                curve_res_override=max(2, js_round(
                    nz(at(p.get('curveRes'), 0), 10) * (1 - fork_height) * compensation)),
                curve_scale=1 - fork_height, skip_base_flare=True,
                flare_base=fork_radius * nz(p.get('trunkForkFlareScale'), 1),
                wind_base=fork_wind, child_count_override=quota_base + (1 if t < quota_extra else 0),
                decurrent_eligible=True, role='trunkLeader', parent_id=base['id'],
                p=p, rng=rng, stems=stems, tips=tips)
    else:
        n_trunks = 1 + to_int32(p.get('baseSplits'))
        for t in range(n_trunks):
            orient = Q()
            if n_trunks > 1:
                az = (360 / n_trunks) * t + rng.vary(0, 20)
                orient.multiply(q_around(Y, az))
                orient.multiply(q_around(X, rng.vary(p['baseSplitAngle'], 8)))
            _build_stem(
                level=0, origin=V3(0, 0, 0), orient=orient, length=trunk_len,
                radius=trunk_radius, decurrent_eligible=(n_trunks == 1),
                p=p, rng=rng, stems=stems, tips=tips)

    return {'stems': stems, 'tips': tips, 'params': p}


def _build_stem(level, origin, orient, length, radius, p, rng, stems, tips, parent_id=None,
                curve_res_override=None, curve_scale=1, taper_override=None,
                suppress_children=False, skip_base_flare=False, flare_base=None,
                wind_base=0.05, child_count_override=None, decurrent_eligible=False,
                open_tip=False, role=None):
    curve_res = max(2, curve_res_override if curve_res_override is not None
                    else to_int32(at(p['curveRes'], level)))
    seg_len = length / curve_res
    taper_value = taper_override if taper_override is not None else at(p['taper'], level)
    u_taper = unit_taper(taper_value)

    curve = nz(at(p['curve'], level), 0) * curve_scale
    curve_back = nz(at(p['curveBack'], level), 0) * curve_scale
    curve_v = nz(at(p['curveV'], level), 0) * curve_scale
    zigzag = max(0, nz(at(p.get('zigzagAngle'), level), 0))
    zigzag_v = max(0, nz(at(p.get('zigzagAngleV'), level), 0))
    zigzag_phase = -1 if (zigzag > 0 and rng.next() < 0.5) else 1
    zigzag_heading = 0

    points = [origin.clone()]
    radii = [radius]
    orients = [orient.clone()]

    o = orient.clone()
    pos = origin.clone()
    levels = p['levels']
    attraction_up = p.get('attractionUp')
    attr_min = nz(p.get('attractionUpMinLevel'), 2)
    twist = nz(at(p.get('twist'), level), 0)
    force_strength = p.get('forceStrength')
    level_force = None
    if force_strength is not None:
        level_force = force_strength * nz(at(p.get('forceLevelScale'), level), 1)

    for i in range(1, curve_res + 1):
        if curve_back == 0:
            seg_curve = curve / curve_res
        else:
            seg_curve = (curve if i <= curve_res / 2 else curve_back) / (curve_res / 2)
        seg_curve += rng.vary(0, curve_v / curve_res)
        o.multiply(q_around(X, seg_curve))
        if zigzag > 0:
            amplitude = max(0, rng.vary(zigzag, zigzag_v))
            target_heading = zigzag_phase * (amplitude if i % 2 else -amplitude)
            o.multiply(q_around(Z, target_heading - zigzag_heading))
            zigzag_heading = target_heading

        if level >= attr_min and attraction_up != 0:
            _apply_tropism(o, attraction_up / curve_res)

        if twist:
            o.multiply(Q().set_from_axis_angle(Y, twist))

        if level_force and level >= nz(p.get('forceMinLevel'), 0):
            _apply_force(o, p['forceDir'], level_force * seg_len,
                         radius * (1 - u_taper * (i / curve_res)))

        fwd = Y.clone().apply_quaternion(o).normalize()
        pos.add_scaled(fwd, seg_len)

        z = i / curve_res
        r = radius * (1 - u_taper * z)
        if level == levels - 1 and taper_value is not None and taper_value >= 0.99:
            r = radius * (1 - z)
        r = max(r, 0.002)

        points.append(pos.clone())
        radii.append(r)
        orients.append(o.clone())

    resolved_length = length
    if level == levels - 1 and p.get('terminalFloor') is not None and len(points) > 1:
        arc_length = 0
        for i in range(1, len(points)):
            arc_length += points[i - 1].distance_to(points[i])
        chord = points[-1].clone().sub(origin)
        chord_length = chord.length()
        downward = max(0, -chord.y / chord_length) if chord_length > 1e-5 else 0
        azimuth = math.atan2(origin.z, origin.x)
        fmin = p.get('terminalFloorMin')
        fmax = p.get('terminalFloorMax')
        floor = max(
            -math.inf if fmin is None else fmin,
            min(
                math.inf if fmax is None else fmax,
                p['terminalFloor']
                + nz(p.get('terminalFloorWave'), 0) * math.sin(nz(p.get('terminalFloorLobes'), 3) * azimuth)
                + rng.vary(0, nz(p.get('terminalFloorV'), 0)),
            ),
        )
        card_drop = arc_length * downward
        allowed_drop = origin.y - floor
        if card_drop > allowed_drop and card_drop > 1e-5:
            scale = max(0.02, max(0, allowed_drop) / card_drop)
            for i in range(1, len(points)):
                points[i].sub(origin).multiply_scalar(scale).add(origin)
            arc_length *= scale
        resolved_length = arc_length

    if level == 0 and not skip_base_flare and p['flare'] > 0:
        n = len(points)
        for i in range(n):
            z = i / (n - 1)
            if z < 0.15:
                radii[i] *= 1 + p['flare'] * (1 - z / 0.15)

    if flare_base:
        n = len(points)
        for i in range(n):
            z = i / (n - 1)
            if z < 0.35:
                radii[i] = flare_base * (1 - z / 0.35) + radii[i] * (z / 0.35)

    flex_gain = [0.3, 0.4, 0.5, 0.55][min(level, 3)]
    wind_tip = min(1, wind_base + flex_gain)
    n = len(points)
    winds = [wind_base + (wind_tip - wind_base) * math.pow(i / (n - 1), 1.15) for i in range(n)]

    rs = at(p['radialSegments'], level)
    stem = {
        'level': level,
        'points': points,
        'radii': radii,
        'orients': orients,
        'winds': winds,
        'length': resolved_length,
        'radialSegments': 6 if rs is None else rs,
        'lobes': p.get('lobes') if level == 0 else 0,
        'lobeDepth': p.get('lobeDepth'),
        'maxLevel': levels - 1,
        'openTip': open_tip,
        'role': role,
    }
    stem['id'] = len(stems)
    stem['parentId'] = -1 if parent_id is None else parent_id
    stems.append(stem)

    if level == levels - 1:
        tips.append({'position': points[-1].clone(), 'orient': orients[-1].clone(),
                     'length': resolved_length})
    if suppress_children:
        return stem

    child_level = level + 1
    if child_level >= levels:
        return stem
    if is_finite(child_count_override):
        n_children = max(0, js_round(child_count_override))
    else:
        n_children = _child_count(level, child_level, p, rng, length)
    if n_children <= 0:
        return stem

    default_start = p['baseSize'] if level == 0 else 0.1
    offset_start = max(0, min(0.98, nz(at(p.get('branchStart'), child_level), default_start)))
    offset_end = max(offset_start + 0.01, min(1, nz(at(p.get('branchEnd'), child_level), 1)))
    dist_power = max(0.05, nz(at(p.get('branchDistPower'), child_level), 1))
    azimuth = rng.range(0, 360)
    tip_c = nz(at(p.get('tipCluster'), child_level), 0)
    whorl_size = max(1, to_int32(at(p.get('whorlSize'), child_level)))
    whorl_nodes = math.ceil(n_children / whorl_size)
    fork_plane_az = rng.range(0, 360)
    fork_radius = radius * nz(p.get('forkRadiusKeep'), 0.85)
    jitter = nz(at(p.get('branchJitter'), child_level), 0)
    rotate = at(p['rotate'], child_level)
    rotate_v = at(p['rotateV'], child_level)

    jitter_node = -1
    node_jitter = 0
    max_child_frac = -math.inf
    for c in range(n_children):
        whorl_slot = c % whorl_size
        node_index = c // whorl_size
        if node_index != jitter_node:
            jitter_node = node_index
            node_jitter = rng.vary(0, jitter)
        node_t = ((node_index if whorl_size > 1 else c) + 0.5) / (whorl_nodes if whorl_size > 1 else n_children)
        spawn_t = math.pow(node_t, dist_power)
        frac = max(offset_start, min(offset_end, offset_start + (offset_end - offset_start) * spawn_t + node_jitter))
        if tip_c > 0:
            frac = frac * (1 - tip_c) + 1.0 * tip_c
        max_child_frac = max(max_child_frac, frac)
        seg = frac * curve_res
        si = min(curve_res - 1, math.floor(seg))
        st = seg - si

        cpos = points[si].clone().lerp(points[si + 1], st)
        cor = orients[si].clone().slerp(orients[si + 1], st)
        pradius_here = radii[si] * (1 - st) + radii[si + 1] * st

        down = (p['downAngle'][child_level]
                + nz(at(p.get('downAngleProgress'), child_level), 0) * spawn_t
                + rng.vary(0, p['downAngleV'][child_level]))
        c_orient = cor.clone()
        if tip_c > 0.5:
            if n_children == 1:
                c_orient.multiply(q_around(Y, rng.range(0, 360)))
                c_orient.multiply(q_around(X, rng.vary(0, 7)))
            else:
                c_orient.multiply(q_around(Y, fork_plane_az + (360 / n_children) * c + rng.vary(0, 12)))
                c_orient.multiply(q_around(X, down))
        elif whorl_size > 1:
            if whorl_slot == 0:
                azimuth += rotate + rng.vary(0, rotate_v)
            around = azimuth + (360 / whorl_size) * whorl_slot + rng.vary(0, rotate_v * 0.15)
            c_orient.multiply(q_around(Y, around))
            c_orient.multiply(q_around(X, down))
        else:
            azimuth += rotate + rng.vary(0, rotate_v)
            c_orient.multiply(q_around(Y, azimuth))
            c_orient.multiply(q_around(X, down))

        shape_frac = shape_ratio(p['shape'], 1 - spawn_t) if level == 0 else 1
        placement_scale = (nz(at(p.get('lengthScaleBase'), child_level), 1) * (1 - spawn_t)
                           + nz(at(p.get('lengthScaleTip'), child_level), 1) * spawn_t)
        absolute_length = at(p.get('lengthAbsolute'), child_level)
        if is_finite(absolute_length):
            raw_length = (absolute_length + rng.vary(0, nz(at(p.get('lengthAbsoluteV'), child_level), 0))) * placement_scale
        else:
            len_factor = p['length'][child_level] + rng.vary(0, p['lengthV'][child_level])
            raw_length = length * len_factor * shape_frac * placement_scale
        lmax = at(p.get('lengthMax'), child_level)
        child_len = max(nz(at(p.get('lengthMin'), child_level), 0.05),
                        min(math.inf if lmax is None else lmax, raw_length))
        if tip_c > 0.5:
            child_radius = (radius * 0.97 if n_children == 1 else fork_radius) * (0.94 + 0.12 * rng.next())
        else:
            pipe_radius = radius * math.pow(child_len / length, p['ratioPower'])
            child_radius = min(pipe_radius, pradius_here * 0.9)

        _build_stem(
            level=child_level, origin=cpos, orient=c_orient, length=child_len, radius=child_radius,
            wind_base=winds[si] * (1 - st) + winds[si + 1] * st,
            flare_base=pradius_here if tip_c > 0.5 else None,
            p=p, rng=rng, stems=stems, tips=tips, parent_id=stem['id'])

    if decurrent_eligible and p.get('decurrentTrunk') and math.isfinite(max_child_frac):
        _trim_stem_to_fraction(stem, min(1, max_child_frac + max(0, nz(p.get('decurrentTrunkExtension'), 0.018))))
    return stem


def _trim_stem_to_fraction(stem, fraction):
    f = max(0.02, min(1, fraction))
    if f >= 0.999999 or len(stem['points']) < 2:
        return
    last = len(stem['points']) - 1
    sample = f * last
    i = min(last - 1, math.floor(sample))
    t = sample - i
    end_point = stem['points'][i].clone().lerp(stem['points'][i + 1], t)
    end_radius = stem['radii'][i] * (1 - t) + stem['radii'][i + 1] * t
    end_orient = stem['orients'][i].clone().slerp(stem['orients'][i + 1], t)
    end_wind = stem['winds'][i] * (1 - t) + stem['winds'][i + 1] * t
    keep = i + 1
    stem['points'][keep:] = [end_point]
    stem['radii'][keep:] = [end_radius]
    stem['orients'][keep:] = [end_orient]
    stem['winds'][keep:] = [end_wind]
    arc = 0
    pts = stem['points']
    for j in range(1, len(pts)):
        arc += pts[j].distance_to(pts[j - 1])
    stem['length'] = arc


def _child_count(level, child_level, p, rng, parent_length):
    base = nz(at(p['branches'], child_level), 0)
    if base <= 0:
        return 0
    if nz(at(p.get('tipCluster'), child_level), 0) > 0.5:
        fc = nz(p.get('forkChance'), 0.82)
        r = rng.next()
        if r < 1 - fc:
            return 1
        if r > 1 - 0.2 * fc:
            return 3
        return 2
    if level == 0:
        return js_round(base)
    spacing = at(p.get('branchSpacing'), child_level)
    if spacing is not None and spacing > 0:
        default_start = p['baseSize'] if level == 0 else 0.1
        start = nz(at(p.get('branchStart'), child_level), default_start)
        end = nz(at(p.get('branchEnd'), child_level), 1)
        occupied = parent_length * max(0, end - start)
        mn = max(1, nz(at(p.get('branchMin'), child_level), 1))
        mx = max(mn, nz(at(p.get('branchMax'), child_level), math.inf))
        count = max(1, js_round(occupied / spacing))
        return max(mn, min(mx, count))
    return max(1, js_round(base * 0.6))


def _apply_force(o, d, strength, radius):
    target = V3(d['x'], d['y'], d['z'])
    if target.length_sq() < 1e-9:
        return
    target.normalize()
    fwd = Y.clone().apply_quaternion(o)
    axis = V3().cross_vectors(fwd, target)
    sin_full = axis.length()
    if sin_full < 1e-6:
        return
    axis.divide_scalar(sin_full)
    full_angle = math.atan2(sin_full, fwd.dot(target))
    step = strength / max(radius, 0.05)
    clamped = max(-full_angle, min(full_angle, step))
    o.premultiply(Q().set_from_axis_angle(axis, clamped))


def _apply_tropism(o, amount):
    fwd = Y.clone().apply_quaternion(o)
    target = UP if amount >= 0 else UP.clone().negate()
    axis = V3().cross_vectors(fwd, target)
    if axis.length_sq() < 1e-8:
        return
    axis.normalize()
    declination = math.acos(max(-1, min(1, fwd.dot(target))))
    angle = abs(amount) * declination
    o.premultiply(Q().set_from_axis_angle(axis, angle))
