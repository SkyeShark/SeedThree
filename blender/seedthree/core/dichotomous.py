"""Dichotomous / rosette plant generator (Joshua tree, saguaro, desert shrubs),
ported from src/core/dichotomous.js.

A stochastic L-system (F -> F[+F][-F]) grows short bent segments that fork in a
V, with repel steering, crown clearance, continuation kinks, the saguaro arm
gates and trunk flare/pinch. build_merged_mesh welds the whole skeleton into ONE
tube network (parent last ring stitched to every child's first ring, shorter
diagonal splits, rotation-minimizing frames, fluted ribs with rib-locked UVs, rib
fade at fork bases, domed star caps closed by a degenerate apex ring, averaged
normals at coincident points, rib-crest anchors for the spines).
"""

import math

import numpy as np

from .jsutil import is_finite, nz, to_int32
from .vmath import Q, V3, X_AXIS as X, Y_AXIS as Y, UP, js_round


def _smoothstep01(t):
    t = 0 if t < 0 else 1 if t > 1 else t
    return t * t * (3 - 2 * t)


DEFAULTS = {
    'firstForkHeight': 1.6, 'armLength': 0.9, 'armFalloff': 0.86, 'forkGenerations': 6,
    'branchiness': 0.62, 'forkSpread': 32, 'forkTriChance': 0.15, 'armAsymmetric': False,
    'armMinHeightFrac': 0, 'armMaxOrder': 99, 'armGenerations': 0, 'curlUp': 0.35,
    'armBend': 16, 'gnarliness': 12, 'continuationKink': 8,
    'forkRadiusKeep': 0.86, 'forkBaseScale': 1.0, 'trunkRadius': 0.16, 'trunkFlare': 1.7,
    'trunkPinch': 0, 'trunkSegRes': 9, 'branchRepel': 0.7, 'tipClearance': 0,
    'minRadius': 0.02, 'radialSegs': 10, 'ribCount': 0, 'ribDepth': 0, 'segCurveRes': 4,
    'trunks': 1, 'trunkSplayDeg': 14, 'tileWorldSize': 0.8, 'windWeightScale': 1,
}


def tropism(d, amount):
    if amount <= 0:
        return d
    dot = max(-1, min(1, d.dot(UP)))
    decl = math.acos(dot)
    if decl < 1e-4:
        return d
    axis = V3().cross_vectors(d, UP)
    if axis.length_sq() < 1e-8:
        return d
    axis.normalize()
    return d.clone().apply_axis_angle(axis, amount * decl).normalize()


def perp(d):
    a = UP if abs(d.y) < 0.9 else X
    return V3().cross_vectors(d, a).normalize()


def _grow_segment(origin, dir0, length, radius0, radius1, p, rng, res_override=None):
    res = max(1, res_override if res_override is not None else p['segCurveRes'])
    points = [origin.clone()]
    radii = [radius0]
    d = dir0.clone().normalize()
    pos = origin.clone()
    bend_per = ((p['armBend'] + rng.vary(0, p['gnarliness'])) * math.pi) / 180 / res
    bend_axis = perp(d)
    for i in range(1, res + 1):
        d.apply_axis_angle(bend_axis, bend_per)
        if p['gnarliness'] > 0:
            d.apply_axis_angle(perp(d), (rng.vary(0, p['gnarliness']) * math.pi) / 180 / res)
        d.copy(tropism(d, p['curlUp'] / res))
        pos.add_scaled(d, length / res)
        points.append(pos.clone())
        radii.append(radius0 + (radius1 - radius0) * (i / res))
    return {'points': points, 'radii': radii, 'endDir': d.clone().normalize()}


def frames_for(points):
    orients, tangents = [], []
    n = len(points)
    for i in range(n):
        t = V3()
        if i == 0:
            t.sub_vectors(points[1], points[0])
        elif i == n - 1:
            t.sub_vectors(points[n - 1], points[n - 2])
        else:
            t.sub_vectors(points[i + 1], points[i - 1])
        t.normalize()
        tangents.append(t)
        orients.append(Q().set_from_unit_vectors(Y, t))
    return orients, tangents


def _make_stem(seg, level, max_level, wind_base, flex_gain, p):
    orients, _ = frames_for(seg['points'])
    pts = seg['points']
    total = 0
    for i in range(1, len(pts)):
        total += pts[i].distance_to(pts[i - 1])
    n = len(pts)
    winds = [min(1, wind_base + flex_gain * math.pow(i / (n - 1) if n > 1 else 0, 1.15)) for i in range(n)]
    return {
        'points': pts, 'radii': seg['radii'], 'orients': orients, 'winds': winds,
        'level': level, 'maxLevel': max_level, 'total': total, 'terminal': False,
        'lobes': 0, 'lobeDepth': 0, 'radialSegments': p['radialSegs'], 'children': [],
    }


def generate_dichotomous(user_params, rng):
    p = dict(DEFAULTS)
    p.update(user_params)
    stems = []
    terminal_stems = []
    expected_height = p['firstForkHeight'] * p['forkGenerations']
    arm_min_height = nz(p.get('armMinHeightFrac'), 0) * expected_height

    all_pts = []
    tips = []

    def repel_dir(pos, d, ln):
        strength = nz(p.get('branchRepel'), 0)
        if strength <= 0:
            return d
        clr = nz(p.get('tipClearance'), 0)
        probe = pos.clone().add_scaled(d, ln * 0.8)
        reach = ln * 0.6 + clr
        R2 = reach ** 2
        near2 = (ln * 0.5) ** 2
        rx = ry = rz = 0.0
        px, py, pz = probe.x, probe.y, probe.z
        qx, qy, qz = pos.x, pos.y, pos.z
        for pt in all_pts:
            dx, dy, dz = pt.x - qx, pt.y - qy, pt.z - qz
            if dx * dx + dy * dy + dz * dz < near2:
                continue
            ex, ey, ez = px - pt.x, py - pt.y, pz - pt.z
            dsq = ex * ex + ey * ey + ez * ez
            if R2 > dsq > 1e-4:
                s = 1 / dsq
                rx += ex * s
                ry += ey * s
                rz += ez * s
        crown_gap2 = (clr * 1.7) ** 2
        for t in tips:
            if t.distance_to_squared(pos) < near2:
                continue
            dsq = probe.distance_to_squared(t)
            if crown_gap2 > dsq > 1e-4:
                s = crown_gap2 / dsq
                rx += (px - t.x) * s
                ry += (py - t.y) * s
                rz += (pz - t.z) * s
        rep = V3(rx, ry, rz)
        if rep.length_sq() < 1e-8:
            return d
        return d.clone().add_scaled(rep.normalize(), strength).normalize()

    def grow(origin, d, radius, length, depth, level, wind_base, flare_base,
             base_is_fork=False, is_ground_base=False):
        flex_gain = [0.3, 0.4, 0.5, 0.55][min(level, 3)]
        r1 = max(p['minRadius'], radius * 0.96)
        seg = _grow_segment(origin, d, length, radius, r1, p, rng,
                            nz(p.get('trunkSegRes'), 9) if level == 0 else None)
        radii = seg['radii']
        nr = len(radii)
        if flare_base:
            for i in range(nr):
                z = i / (nr - 1)
                if z < 0.4:
                    radii[i] = flare_base * (1 - z / 0.4) + radii[i] * (z / 0.4)
        if level == 0 and is_ground_base and nz(p.get('trunkFlare'), 0) > 0:
            for i in range(nr):
                z = i / (nr - 1)
                flare = 1 + p['trunkFlare'] * (1 - z / 0.35) if z < 0.35 else 1
                amp = 0.10 + 0.16 * (1 - z)
                und = 1 + amp * (math.sin(z * 8.3) * 0.6 + math.sin(z * 21.7 + 1.9) * 0.4)
                radii[i] *= flare * und
        if level == 0 and is_ground_base and nz(p.get('trunkPinch'), 0) > 0:
            for i in range(nr):
                z = i / (nr - 1)
                if z < 0.12:
                    radii[i] *= 1 - p['trunkPinch'] * (1 - z / 0.12)
        stem = _make_stem(seg, level, p['forkGenerations'], wind_base, flex_gain, p)
        stem['baseIsFork'] = base_is_fork
        stems.append(stem)
        all_pts.extend(seg['points'])
        end_pos = seg['points'][-1]
        end_dir = seg['endDir']
        end_radius = radii[-1]
        wind_tip = min(1, wind_base + flex_gain)

        if depth <= 1:
            stem['terminal'] = True
            terminal_stems.append(stem)
            tips.append(end_pos.clone())
            return stem

        fork = rng.next() < p['branchiness']

        def continue_main_axis():
            cdir = end_dir.clone()
            cdir.apply_axis_angle(perp(cdir), (rng.vary(0, nz(p.get('continuationKink'), 8)) * math.pi) / 180).normalize()
            cdir = repel_dir(end_pos, tropism(cdir, p['curlUp'] * 0.4), length)
            stem['children'].append(grow(end_pos, cdir, end_radius * 0.98, length, depth - 1, level,
                                         wind_tip, end_radius, False))

        can_arm = level < nz(p.get('armMaxOrder'), 99) and end_pos.y >= arm_min_height
        if p.get('armAsymmetric') and fork and can_arm:
            child_r = max(p['minRadius'], end_radius * p['forkRadiusKeep'])
            mdir = tropism(end_dir.clone(), p['curlUp'] * 0.5)
            mdir.apply_axis_angle(perp(mdir), (rng.vary(0, 5) * math.pi) / 180).normalize()
            mdir = repel_dir(end_pos, mdir, length)
            stem['children'].append(grow(end_pos, mdir, end_radius * 0.985, length, depth - 1, level,
                                         wind_tip, end_radius, False))
            n_arms = 2 if rng.next() < p['forkTriChance'] else 1
            plane_az = rng.range(0, math.pi * 2)
            for k in range(n_arms):
                az = plane_az + k * math.pi + rng.vary(0, 0.5)
                tilt_axis = perp(end_dir).apply_axis_angle(end_dir, az)
                spread = ((p['forkSpread'] + rng.vary(0, 10)) * math.pi) / 180
                adir = end_dir.clone().apply_axis_angle(tilt_axis, spread).normalize()
                adir = repel_dir(end_pos, adir, p['armLength'])
                if p.get('armGenerations') and p['armGenerations'] > 0:
                    arm_depth = max(2, min(p['armGenerations'], js_round(
                        max(0, expected_height * 1.05 - end_pos.y) / (p['armLength'] * 0.7))))
                else:
                    arm_depth = depth - 1
                stem['children'].append(grow(end_pos, adir, child_r, p['armLength'], arm_depth, level + 1,
                                             wind_tip, end_radius * nz(p.get('forkBaseScale'), 1), True))
        elif p.get('armAsymmetric'):
            continue_main_axis()
        elif fork:
            nc = 3 if rng.next() < p['forkTriChance'] else 2
            plane_az = rng.range(0, math.pi * 2)
            axis = perp(end_dir)
            child_r = max(p['minRadius'], end_radius * p['forkRadiusKeep'])
            child_len = p['armLength'] if level == 0 else length * p['armFalloff']
            for k in range(nc):
                az = plane_az + (k * math.pi * 2) / nc
                spin = Q().set_from_axis_angle(end_dir, az)
                tilt_axis = axis.clone().apply_quaternion(spin)
                spread = ((p['forkSpread'] + rng.vary(0, 6)) * math.pi) / 180
                cdir = end_dir.clone().apply_axis_angle(tilt_axis, spread).normalize()
                cdir = repel_dir(end_pos, cdir, child_len)
                child = grow(end_pos, cdir, child_r, child_len, depth - 1, level + 1, wind_tip,
                             end_radius * nz(p.get('forkBaseScale'), 1), nc >= 2)
                stem['children'].append(child)
        else:
            continue_main_axis()
        return stem

    trunk_len = p['firstForkHeight']
    n_trunks = max(1, to_int32(p.get('trunks')))
    for t in range(n_trunks):
        d = UP.clone()
        if n_trunks > 1:
            az = (math.pi * 2 * t) / n_trunks
            d.apply_axis_angle(X, (p['trunkSplayDeg'] * math.pi) / 180).apply_axis_angle(UP, az).normalize()
        grow(V3(0, 0, 0), d, p['trunkRadius'], trunk_len, p['forkGenerations'], 0, 0, 0, False, True)

    wws = nz(p.get('windWeightScale'), 1)
    if wws != 1:
        for s in stems:
            s['winds'] = [w * wws for w in s['winds']]

    return {'stems': stems, 'terminalStems': terminal_stems, 'params': p}


def decimated_stem_view(stem, p):
    if nz(p.get('ringMaxSpacing'), 0) <= 0 or len(stem['points']) <= 2:
        return stem
    keep_ang = (nz(p.get('ringKeepAngle'), 15) * math.pi) / 180
    pts = stem['points']
    keep = [0]
    gap = 0
    bend = 0
    r_kept = stem['radii'][0]
    da, db = V3(), V3()
    for i in range(1, len(pts) - 1):
        gap += pts[i].distance_to(pts[i - 1])
        da.sub_vectors(pts[i], pts[i - 1]).normalize()
        db.sub_vectors(pts[i + 1], pts[i]).normalize()
        bend += da.angle_to(db)
        r_drift = abs(stem['radii'][i] - r_kept) / max(r_kept, 1e-4)
        if bend >= keep_ang or gap >= p['ringMaxSpacing'] or r_drift >= 0.12:
            keep.append(i)
            gap = 0
            bend = 0
            r_kept = stem['radii'][i]
    keep.append(len(pts) - 1)
    n = len(keep)
    points, radii, winds = [None] * n, [None] * n, [None] * n
    for k in range(n):
        i = keep[k]
        if k == 0 or k == n - 1:
            points[k] = pts[i]
            radii[k] = stem['radii'][i]
            winds[k] = stem['winds'][i]
            continue
        lo = math.ceil((keep[k - 1] + i) / 2)
        hi = math.floor((i + keep[k + 1]) / 2)
        c = V3()
        r = w = 0
        m = 0
        for j in range(lo, hi + 1):
            c.add(pts[j])
            r += stem['radii'][j]
            w += stem['winds'][j]
            m += 1
        points[k] = c.divide_scalar(m)
        radii[k] = r / m
        winds[k] = w / m
    return {'points': points, 'radii': radii, 'winds': winds}


def stem_foliage_view(stem, p):
    sv = decimated_stem_view(stem, p)
    if sv is stem:
        return stem
    orients, _ = frames_for(sv['points'])
    out = dict(stem)
    out.update({'points': sv['points'], 'radii': sv['radii'], 'winds': sv['winds'], 'orients': orients})
    return out


def build_merged_mesh(stems, params):
    p = dict(DEFAULTS)
    p.update(params)
    if p.get('ribDepth') is None:  # JS: an explicit undefined ribDepth compares like 0
        p['ribDepth'] = 0
    rc = p.get('ribCount')
    p['ribCount'] = max(0, js_round(rc if is_finite(rc) else 0))
    rsg = p.get('radialSegs')
    p['radialSegs'] = max(3, js_round(rsg if is_finite(rsg) else 3))
    if p['ribCount'] > 0 and p['ribDepth'] > 0:
        rpt_src = p.get('ribsPerTile')
        rpt = max(1, js_round(rpt_src if is_finite(rpt_src) else 4))
        p['ribCount'] = max(rpt, js_round(p['ribCount'] / rpt) * rpt)
        p['radialSegs'] = max(p['radialSegs'], p['ribCount'] * 2)
        p['radialSegs'] = js_round(p['radialSegs'] / p['ribCount']) * p['ribCount']
    seg = p['radialSegs']
    ring_len = seg + 1
    pos, uvs, wind, cen, idx = [], [], [], [], []
    crest_anchors = []
    collect_crests = p['ribCount'] > 0 and p['ribDepth'] > 0
    rib_count = p['ribCount']
    swap_uv = bool(p.get('barkGrainU'))
    two_pi_j = [(j / seg) * math.pi * 2 for j in range(seg + 1)]
    cos_j = [math.cos(a) for a in two_pi_j]
    sin_j = [math.sin(a) for a in two_pi_j]

    def dsq(i, k):
        a3, b3 = i * 3, k * 3
        dx = pos[a3] - pos[b3]
        dy = pos[a3 + 1] - pos[b3 + 1]
        dz = pos[a3 + 2] - pos[b3 + 2]
        return dx * dx + dy * dy + dz * dz

    def stitch(a, b):
        for j in range(seg):
            a0, a1, b0, b1 = a + j, a + j + 1, b + j, b + j + 1
            if dsq(a1, b0) <= dsq(a0, b1):
                idx.extend((a0, b0, a1, a1, b0, b1))
            else:
                idx.extend((a0, b0, b1, a0, b1, a1))

    def ring_vertices(center, tangent, ref_dir, radius, uv_y, u_scale, rib_depth, prev_tangent, u_phase):
        n = ref_dir.clone()
        if prev_tangent is not None:
            dot = max(-1, min(1, prev_tangent.dot(tangent)))
            if dot < 0.999999:
                ax = V3().cross_vectors(prev_tangent, tangent)
                if ax.length_sq() > 1e-12:
                    n.apply_axis_angle(ax.normalize(), math.acos(dot))
        n.add_scaled(tangent, -n.dot(tangent))
        if n.length_sq() < 1e-8:
            n.copy(perp(tangent))
        n.normalize()
        b = V3().cross_vectors(n, tangent).normalize()
        nx, ny, nz_, bx, by, bz = n.x, n.y, n.z, b.x, b.y, b.z
        cx, cy, cz = center.x, center.y, center.z
        for j in range(seg + 1):
            a = two_pi_j[j]
            ca, sa = cos_j[j], sin_j[j]
            dx = nx * ca + bx * sa
            dy = ny * ca + by * sa
            dz = nz_ * ca + bz * sa
            rr = radius * (1 + rib_depth * math.cos(rib_count * a)) if rib_depth > 0 else radius
            pos.extend((cx + dx * rr, cy + dy * rr, cz + dz * rr))
            u = (j / seg) * u_scale + u_phase
            if swap_uv:
                uvs.extend((uv_y, u))
            else:
                uvs.extend((u, uv_y))
            cen.extend((cx, cy, cz))
        return n

    decimate = nz(p.get('ringMaxSpacing'), 0) > 0
    skip = p.get('skipStem')

    def emit_stem(stem, ref_dir0, v_y0, tan0=None):
        sv = decimated_stem_view(stem, p) if decimate else stem
        spts, srad, swind = sv['points'], sv['radii'], sv['winds']
        _, tangents = frames_for(spts)
        if tan0 is not None:
            tangents[0] = tan0.clone()
        ref = ref_dir0.clone()
        v_y = v_y0
        rings = []
        ref_idx = min(len(srad) - 1, math.floor(len(srad) * 0.5))
        circ_ref = 2 * math.pi * srad[ref_idx]
        fluted = p['ribCount'] > 0
        ribs_per_tile = nz(p.get('ribsPerTile'), 4)
        u_phase = 0
        if fluted:
            u_scale = max(1, js_round(p['ribCount'] / ribs_per_tile))
            u_phase = 0.5 / ribs_per_tile
            tile_v = max(0.05, p['tileWorldSize'])
        else:
            wraps = circ_ref / p['tileWorldSize']
            u_scale = max(1, js_round(wraps)) if wraps >= 0.75 else wraps
            tile_v = max(0.02, circ_ref / u_scale)
        fade_fork = stem.get('baseIsFork') and p['ribDepth'] > 0
        stem_len = 0
        for i in range(1, len(spts)):
            stem_len += spts[i].distance_to(spts[i - 1])
        fade_len = max(0.25, stem_len * 0.4)
        arc = 0
        for i in range(len(spts)):
            base = len(pos) // 3
            if i > 0:
                dl = spts[i].distance_to(spts[i - 1])
                v_y += dl / tile_v
                arc += dl
            rd = p['ribDepth'] * _smoothstep01(arc / fade_len) if fade_fork else p['ribDepth']
            ref = ring_vertices(spts[i], tangents[i], ref, srad[i], v_y, u_scale, rd,
                                tangents[i - 1] if i > 0 else None, u_phase)
            wind.extend([swind[i]] * ring_len)
            if collect_crests and rd > 0.02:
                c, tn, rad = spts[i], tangents[i], srad[i]
                bvec = V3().cross_vectors(ref, tn).normalize()
                rr = rad * (1 + rd)
                for k in range(rib_count):
                    a = (k / rib_count) * math.pi * 2
                    cd = ref.clone().multiply_scalar(math.cos(a)).add_scaled(bvec, math.sin(a))
                    crest_anchors.append({
                        'pos': V3(c.x + cd.x * rr, c.y + cd.y * rr, c.z + cd.z * rr),
                        'normal': cd.clone(), 'tangent': tn.clone(), 'center': c.clone(),
                        'radius': rad, 'wind': swind[i], 'rib': k,
                    })
            rings.append(base)
            if i > 0:
                stitch(rings[i - 1], base)
        last_base = rings[-1]
        last_tan = tangents[-1]
        kids = [c for c in stem['children'] if not skip(c)] if skip else stem['children']
        for child in kids:
            is_cont = child['level'] == stem['level']
            first = emit_stem(child, ref, v_y, last_tan if is_cont else None)
            stitch(last_base, first)
        if not kids:
            cap_r = srad[-1]
            cap_c = spts[-1]
            cap_wind = swind[-1]
            n_dome = 3
            n_cap = ref.clone().add_scaled(last_tan, -ref.dot(last_tan))
            if n_cap.length_sq() < 1e-8:
                n_cap.copy(perp(last_tan))
            n_cap.normalize()
            b_cap = V3().cross_vectors(n_cap, last_tan).normalize()
            prev = last_base
            cap_vy = v_y
            for s in range(1, n_dome + 1):
                ang = (s / (n_dome + 1)) * (math.pi / 2)
                dC = cap_c.clone().add_scaled(last_tan, cap_r * math.sin(ang))
                base = len(pos) // 3
                cap_vy += (cap_r / (n_dome + 1)) / tile_v
                ring_vertices(dC, last_tan, ref, cap_r * math.cos(ang), cap_vy, u_scale, p['ribDepth'], None, u_phase)
                wind.extend([cap_wind] * ring_len)
                stitch(prev, base)
                prev = base
                ring_r = cap_r * math.cos(ang)
                if collect_crests and s == n_dome:
                    rr = ring_r * (1 + p['ribDepth'])
                    for k in range(rib_count):
                        a = (k / rib_count) * math.pi * 2
                        cd = n_cap.clone().multiply_scalar(math.cos(a)).add_scaled(b_cap, math.sin(a))
                        nrm = cd.clone().multiply_scalar(math.cos(ang)).add_scaled(last_tan, math.sin(ang)).normalize()
                        crest_anchors.append({
                            'pos': V3(dC.x + cd.x * rr, dC.y + cd.y * rr, dC.z + cd.z * rr),
                            'normal': nrm, 'tangent': last_tan.clone(), 'center': cap_c.clone(),
                            'radius': ring_r, 'wind': cap_wind, 'rib': k, 'cap': True,
                        })
            aC = cap_c.clone().add_scaled(last_tan, cap_r)
            apex_base = len(pos) // 3
            apex_vy = cap_vy + (cap_r / (n_dome + 1)) / tile_v
            for j in range(seg + 1):
                pos.extend((aC.x, aC.y, aC.z))
                u = (j / seg) * u_scale + u_phase
                if swap_uv:
                    uvs.extend((apex_vy, u))
                else:
                    uvs.extend((u, apex_vy))
                wind.append(cap_wind)
                cen.extend((cap_c.x, cap_c.y, cap_c.z))
            stitch(prev, apex_base)
        return rings[0]

    child_ids = set()
    for s in stems:
        for c in s['children']:
            child_ids.add(id(c))
    for s in stems:
        if id(s) in child_ids:
            continue
        t0 = V3().sub_vectors(s['points'][1], s['points'][0]).normalize()
        emit_stem(s, perp(t0), 0)

    P64 = np.array(pos, np.float64).reshape(-1, 3)
    P32 = P64.astype(np.float32)
    I = np.array(idx, np.int64)
    normals = _compute_vertex_normals(P32, I)
    _weld_normals(P32, normals)
    return {
        'position': P32,
        'position64': P64,
        'normal': normals.astype(np.float32),
        'uv': np.array(uvs, np.float64).reshape(-1, 2).astype(np.float32),
        'aWind': np.array(wind, np.float32),
        'aStemCenter': np.array(cen, np.float64).reshape(-1, 3).astype(np.float32),
        'index': I,
        'ribCrests': crest_anchors,
    }


def _compute_vertex_normals(P32, I):
    """three's computeVertexNormals: area-weighted face normals (cb x ab)."""
    P = P32.astype(np.float64)
    tri = I.reshape(-1, 3)
    pA, pB, pC = P[tri[:, 0]], P[tri[:, 1]], P[tri[:, 2]]
    fn = np.cross(pC - pB, pA - pB)
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, tri[:, k], fn)
    ln = np.linalg.norm(N, axis=1)
    ln[ln == 0] = 1
    return N / ln[:, None]


def _weld_normals(P32, N):
    """Average shading normals over position-coincident vertices (fork joints,
    the U seam), keyed like the JS (Math.round(p * 1e4))."""
    q = np.floor(P32.astype(np.float64) * 1e4 + 0.5).astype(np.int64)
    _, inv, counts = np.unique(q, axis=0, return_inverse=True, return_counts=True)
    inv = inv.reshape(-1)
    multi = counts[inv] > 1
    if not multi.any():
        return
    S = np.zeros((len(counts), 3))
    np.add.at(S, inv, N.astype(np.float64))
    ln = np.linalg.norm(S, axis=1)
    ln[ln == 0] = 1
    S /= ln[:, None]
    N[multi] = S[inv[multi]]
