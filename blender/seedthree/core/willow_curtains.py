"""Weeping-willow curtains, ported from src/core/willow-curtains.js.

Vines are sampled metrically along each curved L2 feeder; each is one cubic curve
from the feeder tangent into a pendant tail, normalized to unit arc length, scaled
to its requested length (clamped by a scalloped floor), and built as crossed
segmented ribbons in one merged tree-space mesh.
"""

import math

import numpy as np

from .vmath import Q, V3, X_AXIS as X, Y_AXIS as Y, Z_AXIS as Z, UP, js_round
from .leaf_cards import WIND_DIR

DOWN = V3(0, -1, 0)
GOLDEN = (137.5 * math.pi) / 180


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _g(cfg, *keys, default=None):
    for k in keys:
        v = cfg.get(k)
        if v is not None:
            return v
    return default


def _feeder_arc(stem):
    cum = [0.0]
    pts = stem['points']
    for i in range(1, len(pts)):
        cum.append(cum[i - 1] + pts[i].distance_to(pts[i - 1]))
    return cum, cum[-1]


def _sample_feeder(stem, cum, length, frac):
    target = _clamp(frac, 0, 1) * length
    si = 0
    while si < len(cum) - 2 and cum[si + 1] < target:
        si += 1
    span = max(1e-6, cum[si + 1] - cum[si])
    t = _clamp((target - cum[si]) / span, 0, 1)
    pts = stem['points']
    point = pts[si].clone().lerp(pts[si + 1], t)
    tangent = pts[si + 1].clone().sub(pts[si]).normalize()
    oris = stem.get('orients')
    if oris and si < len(oris) and oris[si] is not None:
        orient = oris[si].clone().slerp(oris[min(si + 1, len(oris) - 1)], t)
    else:
        orient = Q().set_from_unit_vectors(Y, tangent)
    w = stem.get('winds')
    wind = w[si] * (1 - t) + w[min(si + 1, len(w) - 1)] * t if w else 0.65
    return point, tangent, orient, wind


def _unit_vine_curve(start_dir, lateral_dir, segments, buildup, lateral_amount, tail_pull,
                     arch_lift, curve_reach, terminal_sweep):
    forward = V3(start_dir.x, 0, start_dir.z)
    if forward.length_sq() < 1e-8:
        forward.cross_vectors(UP, lateral_dir)
    if forward.length_sq() < 1e-8:
        forward.set(1, 0, 0)
    forward.normalize()
    end_xz = forward.multiply_scalar(curve_reach).add_scaled(lateral_dir, lateral_amount)
    end_xz.y = 0
    p1 = start_dir.clone().multiply_scalar(0.18 + buildup * 0.75)
    p2 = end_xz.clone().add_scaled(UP, arch_lift)
    p3 = end_xz.clone().add_scaled(DOWN, tail_pull)
    sweep = end_xz.clone()
    if sweep.length_sq() < 1e-8:
        sweep.copy(lateral_dir)
    sweep.normalize()
    p2.add_scaled(sweep, terminal_sweep / 3)
    p3.add_scaled(sweep, terminal_sweep)
    points = []
    for i in range(segments + 1):
        t = i / segments
        u = 1 - t
        points.append(V3().add_scaled(p1, 3 * u * u * t).add_scaled(p2, 3 * u * t * t).add_scaled(p3, t * t * t))
    arc = 0
    for i in range(1, len(points)):
        arc += points[i].distance_to(points[i - 1])
    inv = 1 / max(1e-6, arc)
    for p in points:
        p.multiply_scalar(inv)
    return points


def build_willow_curtains(feeders, cfg, rng):
    positions, normals, uvs, thickness, anchors, winds, idx = [], [], [], [], [], [], []
    start_frac = _clamp(_g(cfg, 'startFrac', default=0.12), 0, 0.98)
    end_frac = _clamp(_g(cfg, 'endFrac', default=0.98), start_frac + 0.01, 1)
    vines_per_m = max(0.01, _g(cfg, 'vinesPerMeter', default=9))
    spacing = max(0.01, _g(cfg, 'spacing', 'vineSpacing', default=1 / vines_per_m))
    vine_keep = _clamp(_g(cfg, 'vineKeepFraction', default=1), 0, 1)
    min_per = max(0, js_round(_g(cfg, 'minPerFeeder', default=6)))
    max_per = max(min_per, js_round(_g(cfg, 'maxPerFeeder', default=36)))
    base_length = max(0.1, _g(cfg, 'length', 'vineLength', default=2.35))
    length_var = max(0, _g(cfg, 'lengthVariation', 'vineLengthVar', default=0.65))
    min_length = max(0.03, _g(cfg, 'minLength', default=0.22))
    curve_buildup = _clamp(_g(cfg, 'curveBuildup', default=0.27), 0.02, 0.8)
    curve_buildup_var = max(0, _g(cfg, 'curveBuildupVariation', default=0.08))
    lateral_var = max(0, _g(cfg, 'lateralVariation', default=0.28))
    outward_spread = max(0, _g(cfg, 'outwardSpread', default=0.55))
    initial_lift = _g(cfg, 'initialLift', default=0.08)
    tangent_influence = max(0, _g(cfg, 'tangentInfluence', default=1))
    min_launch_y = _g(cfg, 'minLaunchY', default=-1)
    arch_lift = max(0, _g(cfg, 'archLift', default=0))
    arch_lift_var = max(0, _g(cfg, 'archLiftVariation', default=0))
    curve_reach = max(0.05, _g(cfg, 'curveReach', default=0.75))
    curve_reach_var = max(0, _g(cfg, 'curveReachVariation', default=0))
    terminal_sweep = max(0, _g(cfg, 'terminalSweep', default=0.20))
    terminal_sweep_var = max(0, _g(cfg, 'terminalSweepVariation', default=0))
    tail_pull = max(0.2, _g(cfg, 'tailPull', default=1.25))
    segments = max(2, js_round(_g(cfg, 'segments', default=8)))
    sheets = max(1, js_round(_g(cfg, 'quads', default=2)))
    width_ratio = max(0.01, _g(cfg, 'widthRatio', default=1))
    attach_jitter = _clamp(_g(cfg, 'attachmentJitter', default=0.35), 0, 0.49)
    floor_base = _g(cfg, 'floor', default=0.28)
    floor_var = max(0, _g(cfg, 'floorVariation', 'floorVar', default=0.10))
    floor_wave = max(0, _g(cfg, 'floorWave', default=0.08))
    floor_lobes = max(1, js_round(_g(cfg, 'floorLobes', default=3)))
    floor_min = _g(cfg, 'floorMin', default=0.20)
    floor_max = _g(cfg, 'floorMax', default=0.60)
    floor_enabled = cfg.get('disableFloor') is not True
    attach_min_ratio = _clamp(_g(cfg, 'attachmentMinHeightRatio', default=0), 0, 0.9)
    tail_wind_gain = _clamp(_g(cfg, 'tailWindGain', default=1), 0, 1)

    canopy_top = -math.inf
    for f in feeders:
        for p in f.get('points') or []:
            canopy_top = max(canopy_top, p.y)
    if not floor_enabled:
        attach_min_h = -math.inf
    elif isinstance(cfg.get('attachmentMinHeight'), (int, float)):
        attach_min_h = cfg['attachmentMinHeight']
    else:
        attach_min_h = floor_min + max(0, canopy_top - floor_min) * attach_min_ratio

    frame_x, frame_z, outward, lateral_dir, start_dir = V3(), V3(), V3(), V3(), V3()
    tangent, side, normal = V3(), V3(), V3()
    vine_count = 0
    used_feeders = 0

    for feeder in feeders:
        if not feeder.get('points') or len(feeder['points']) < 2:
            continue
        cum, arc_len = _feeder_arc(feeder)
        if arc_len < 0.05:
            continue
        leafy = arc_len * (end_frac - start_frac)
        count = _clamp(js_round(leafy / spacing), min_per, max_per)
        if not count:
            continue
        used_feeders += 1
        phase = rng.range(0, math.pi * 2)
        for vi in range(count):
            slot = _clamp((vi + 0.5 + rng.vary(0, attach_jitter)) / count, 0.001, 0.999)
            frac = start_frac + (end_frac - start_frac) * slot
            r_point, r_tan, r_orient, r_wind = _sample_feeder(feeder, cum, arc_len, frac)
            if r_point.y < attach_min_h:
                continue
            phase += GOLDEN + rng.vary(0, 0.18)
            frame_x.copy(X).apply_quaternion(r_orient)
            frame_z.copy(Z).apply_quaternion(r_orient)
            outward.copy(frame_x).multiply_scalar(math.cos(phase)).add_scaled(frame_z, math.sin(phase))
            outward.add_scaled(r_tan, -outward.dot(r_tan))
            if outward.length_sq() < 1e-8:
                outward.cross_vectors(r_tan, UP)
            outward.normalize()
            lateral_dir.copy(frame_x).multiply_scalar(-math.sin(phase)).add_scaled(frame_z, math.cos(phase))
            lateral_dir.add_scaled(r_tan, -lateral_dir.dot(r_tan)).normalize()
            start_dir.copy(r_tan).multiply_scalar(tangent_influence) \
                .add_scaled(outward, outward_spread * rng.range(0.65, 1.15)) \
                .add_scaled(UP, initial_lift + rng.vary(0, 0.06))
            start_dir.y = max(start_dir.y, min_launch_y + rng.vary(0, 0.04))
            start_dir.normalize()
            buildup = _clamp(rng.vary(curve_buildup, curve_buildup_var), 0.02, 0.82)
            lateral = rng.vary(0, lateral_var)
            lift = max(0.02, rng.vary(arch_lift, arch_lift_var))
            reach = max(0.05, rng.vary(curve_reach, curve_reach_var))
            sweep = max(0.02, rng.vary(terminal_sweep, terminal_sweep_var))
            unit = _unit_vine_curve(start_dir, lateral_dir, segments, buildup, lateral, tail_pull, lift, reach, sweep)

            requested = max(min_length, rng.vary(base_length, length_var))
            min_unit_y = min(p.y for p in unit)
            azimuth = math.atan2(r_point.z, r_point.x)
            target_floor = _clamp(
                floor_base + floor_wave * math.sin(floor_lobes * azimuth) + rng.vary(0, floor_var),
                floor_min, floor_max)
            if floor_enabled and min_unit_y < -1e-5:
                allowed = max(0, r_point.y - target_floor)
                requested = min(requested, allowed / -min_unit_y)
            if requested < min_length:
                continue
            path = [p.clone().multiply_scalar(requested).add(r_point) for p in unit]
            cum_p = [0.0]
            for i in range(1, len(path)):
                cum_p.append(cum_p[i - 1] + path[i].distance_to(path[i - 1]))
            arc = cum_p[-1]
            if arc < min_length:
                continue
            half_w = 0.5 * arc * width_ratio
            roll = rng.range(0, math.pi * 2)
            vine_thick = 0.4 + rng.next() * 0.6
            keep_score = (used_feeders * 0.618033988749895 + (vi + 1) * 0.754877666246693) % 1
            if keep_score >= vine_keep:
                continue
            for sheet in range(sheets):
                angle = roll + (sheet * math.pi) / sheets
                side.set(math.cos(angle), 0, math.sin(angle))
                vb = len(positions)
                for i in range(len(path)):
                    prev = path[max(0, i - 1)]
                    nxt = path[min(len(path) - 1, i + 1)]
                    tangent.copy(nxt).sub(prev).normalize()
                    normal.cross_vectors(tangent, side).normalize()
                    if normal.length_sq() < 1e-8:
                        normal.cross_vectors(UP, side).normalize()
                    t = _clamp(cum_p[i] / arc, 0, 1)
                    w = min(1, r_wind + (1 - r_wind) * math.pow(t, 1.15) * tail_wind_gain)
                    cx, cy, cz = path[i].x, path[i].y, path[i].z
                    for u in (0, 1):
                        sign = 1 if u else -1
                        positions.append((cx + side.x * half_w * sign, cy, cz + side.z * half_w * sign))
                        normals.append((normal.x, normal.y, normal.z))
                        uvs.append((u, 1 - t))
                        thickness.append(vine_thick)
                        winds.append(w)
                        anchors.append((cx, cy, cz))
                for i in range(segments):
                    a = vb + i * 2
                    idx.extend((a, a + 1, a + 3, a, a + 3, a + 2))
            vine_count += 1

    if not vine_count:
        return None
    return {
        'kind': 'mesh',
        'position': np.array(positions, np.float32),
        'normal': np.array(normals, np.float32),
        'uv': np.array(uvs, np.float32),
        'aThickness': np.array(thickness, np.float32),
        'aWind': np.array(winds, np.float32),
        'aAnchorPos': np.array(anchors, np.float32),
        'index': np.array(idx, np.int64),
        'vineCount': vine_count,
        'feederCount': used_feeders,
        'withFlutter': False,
    }
