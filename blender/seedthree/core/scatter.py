"""The demo scene's scatters, pure Python (no bpy): rocks.js, fallen-limbs.js, grass.js,
scrub.js, ground-cover.js geometry and placement, each on the app's own RNG stream.
Matrices are three's column-major 16-float instance matrices in three's axes; the
Blender side (scene/decor.py) realizes them."""

import math

import numpy as np

from .rng import Rng
from .vmath import Q, V3, compose

TAU = math.pi * 2


def euler_xyz_quat(x, y, z):
    """three Quaternion.setFromEuler(new Euler(x, y, z)) (order XYZ)."""
    c1, c2, c3 = math.cos(x / 2), math.cos(y / 2), math.cos(z / 2)
    s1, s2, s3 = math.sin(x / 2), math.sin(y / 2), math.sin(z / 2)
    return Q(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
             c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3)


def icosahedron(detail=0):
    """IcosahedronGeometry(1, detail) (PolyhedronGeometry subdivision) + mergeVertices."""
    t = (1 + math.sqrt(5)) / 2
    V = np.array([-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
                  t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1], np.float64).reshape(-1, 3)
    I = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
         3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1]
    verts = []
    cols = detail + 1
    for f in range(0, len(I), 3):
        a, b, c = V[I[f]], V[I[f + 1]], V[I[f + 2]]
        v = []
        for i in range(cols + 1):
            aj = a + (c - a) * (i / cols)
            bj = b + (c - b) * (i / cols)
            rows = cols - i
            v.append([aj if (j == 0 and i == cols) else aj + (bj - aj) * (j / rows) for j in range(rows + 1)])
        for i in range(cols):
            for j in range(2 * (cols - i) - 1):
                k = j // 2
                if j % 2 == 0:
                    verts += [v[i][k + 1], v[i + 1][k], v[i][k]]
                else:
                    verts += [v[i][k + 1], v[i + 1][k + 1], v[i + 1][k]]
    P = np.array(verts)
    P /= np.linalg.norm(P, axis=1)[:, None]
    P = P.astype(np.float32).astype(np.float64)
    keys = np.round(P * 1e4).astype(np.int64)
    _, first, inv = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    order = np.argsort(first)          # mergeVertices keeps first-seen order
    remap = np.empty_like(order)
    remap[order] = np.arange(len(order))
    return P[first[order]], remap[inv.ravel()].reshape(-1, 3)


def displace_rock(P, tris, rng, squash):
    """rocks.js displaceRock: smooth low-frequency lumps from four random plane waves."""
    from .branch_cards import compute_vertex_normals
    waves = []
    for _ in range(4):
        d = V3(rng.vary(0, 1), rng.vary(0, 1), rng.vary(0, 1)).normalize()
        waves.append((np.array([d.x, d.y, d.z]), rng.range(1.0, 2.4), rng.range(0.05, 0.13), rng.range(0, TAU)))
    n = P / np.linalg.norm(P, axis=1)[:, None]
    d = np.ones(len(P))
    for dirv, freq, amp, phase in waves:
        d += amp * np.sin((n @ dirv) * freq * math.pi + phase)
    out = n * d[:, None]
    out[:, 1] *= squash
    out = out.astype(np.float32).astype(np.float64)
    return {'position': out, 'normal': compute_vertex_normals(out, tris.ravel()), 'index': tris.ravel(),
            'uv': np.zeros((len(out), 2))}


def rock_scatter(sampler, seed=1, flat_radius=15, count=32, scree=12000):
    """rocks.js buildRocks: (variants, per-variant matrices, scree geometry, scree matrices)."""
    rng = Rng('rocks:%s' % seed)
    P3, T3 = icosahedron(3)
    variants = []
    for _ in range(3):
        squash = rng.range(0.55, 0.8)
        variants.append(displace_rock(P3, T3, rng, squash))
    max_r = sampler.R * 0.75
    h = sampler.height_at
    per = [[] for _ in variants]
    for i in range(count):
        a = rng.range(0, TAU)
        r = 3.5 + (max_r - 3.5) * math.sqrt(rng.next())
        s = rng.range(0.3, 2.2 if r > flat_radius else 0.9) * (1.4 if i % 3 == 0 else 0.8)
        x, z = math.cos(a) * r, math.sin(a) * r
        q = euler_xyz_quat(rng.vary(0, 0.2), rng.range(0, TAU), rng.vary(0, 0.2))
        fr = s * 0.8
        seat = min(h(x, z), h(x + fr, z), h(x - fr, z), h(x, z + fr), h(x, z - fr))
        per[i % 3].append(compose(V3(x, seat + s * rng.range(0.0, 0.2), z), q, V3(s, s, s)))
    P1, T1 = icosahedron(1)
    scree_geo = displace_rock(P1, T1, rng, 0.55)
    mats = []
    guard = scree * 5
    while len(mats) < scree and guard > 0:
        guard -= 1
        a = rng.range(0, TAU)
        r = 3 + (max_r - 3) * math.sqrt(rng.next())
        x, z = math.cos(a) * r, math.sin(a) * r
        if sampler.rockness_at(x, z) < rng.range(0.4, 0.7):
            continue
        s = rng.range(0.05, 0.28)
        q = euler_xyz_quat(rng.vary(0, 0.4), rng.range(0, TAU), rng.vary(0, 0.4))
        mats.append(compose(V3(x, h(x, z) - s * 0.3, z), q, V3(s, s, s)))
    return variants, per, scree_geo, mats


LIMB_PARAMS = {
    'trunks': 1, 'firstForkHeight': 0.28, 'armLength': 0.24, 'armFalloff': 0.8, 'forkGenerations': 3,
    'branchiness': 0.75, 'forkSpread': 34, 'forkTriChance': 0.1, 'curlUp': 0, 'armBend': 14, 'gnarliness': 26,
    'continuationKink': 18, 'forkRadiusKeep': 0.7, 'trunkRadius': 0.028, 'trunkFlare': 1.25, 'trunkSegRes': 4,
    'branchRepel': 0.3, 'minRadius': 0.004, 'radialSegs': 6, 'segCurveRes': 2, 'tileWorldSize': 0.5,
}


def limb_geometry(seed_tag):
    """One dead limb: a short kinked dichotomous branch grown on +Y, laid along +X."""
    from .dichotomous import generate_dichotomous, build_merged_mesh
    sk = generate_dichotomous(dict(LIMB_PARAMS), Rng('limb:%s' % seed_tag))
    g = build_merged_mesh(sk['stems'], dict(LIMB_PARAMS))
    P = np.asarray(g['position'], np.float64)
    N = np.asarray(g['normal'], np.float64)
    rot = lambda a: np.stack([a[:, 1], -a[:, 0], a[:, 2]], 1)   # rotateZ(-pi/2)
    return {'position': rot(P).astype(np.float32).astype(np.float64), 'normal': rot(N), 'uv': g['uv'],
            'index': g['index']}


def limb_scatter(sampler, seed=1, flat_radius=15, count=14):
    rng = Rng('limbs:%s' % seed)
    max_r = sampler.R * 0.6
    variants = [limb_geometry('%s:%d' % (seed, i)) for i in range(3)]
    h = sampler.height_at
    per = [[] for _ in variants]
    for i in range(count):
        vi = i % 3
        geo = variants[vi]
        lo, hi = geo['position'].min(0), geo['position'].max(0)
        a = rng.range(0, TAU)
        r = rng.range(1.6, flat_radius * 0.7) if rng.next() < 0.6 else \
            flat_radius * 0.7 + (max_r - flat_radius * 0.7) * rng.next()
        x, z = math.cos(a) * r, math.sin(a) * r
        s = rng.range(0.6, 1.5)
        yaw = rng.range(0, TAU)
        half = ((hi[0] - lo[0]) * s) / 2
        dx, dz = math.cos(yaw), -math.sin(yaw)
        hA, hB = h(x - dx * half, z - dz * half), h(x + dx * half, z + dz * half)
        pitch = math.atan2(hB - hA, half * 2)
        q = euler_xyz_quat(0, yaw, 0).multiply(euler_xyz_quat(rng.vary(0, 0.25), 0, -pitch))
        min_y = math.inf
        for cx in (lo[0], hi[0]):
            for cy in (lo[1], hi[1]):
                for cz in (lo[2], hi[2]):
                    min_y = min(min_y, V3(cx * s, cy * s, cz * s).apply_quaternion(q).y)
        ground = min(hA, hB, h(x, z))
        per[vi].append(compose(V3(x, ground - min_y - 0.015, z), q, V3(s, s, s)))
    return variants, per


def _quads_geometry(quads):
    P, N, UV, I = [], [], [], []
    b = 0
    for corners in quads:
        for (p, uv) in corners:
            P.append(p)
            N.append((0, 1, 0))
            UV.append(uv)
        I += [b, b + 1, b + 2, b, b + 2, b + 3]
        b += 4
    return {'position': np.array(P, np.float32).astype(np.float64), 'normal': np.array(N, np.float64),
            'uv': np.array(UV, np.float64), 'index': np.array(I)}


def tuft_geometry(planes=2, width=1.0):
    quads = []
    for q in range(planes):
        a = q * math.pi / planes
        ca, sa = math.cos(a), math.sin(a)
        quads.append([((lx * ca, ly, lx * sa), (lx / width + 0.5, ly))
                      for lx, ly in ((-0.5 * width, 0), (0.5 * width, 0), (0.5 * width, 1), (-0.5 * width, 1))])
    return _quads_geometry(quads)


def _hash01(n):
    v = math.sin(n * 12.9898) * 43758.5453
    return v - math.floor(v)


def _fan(quads, width, az_of, tilt_of, h_of, w_of, off_of):
    out = []
    for q in range(quads):
        az, tilt, hh, w, off = az_of(q), tilt_of(q), h_of(q), w_of(q), off_of(q)
        ca, sa = math.cos(az), math.sin(az)
        cx, cz = ca * off, sa * off
        upx, upy, upz = math.sin(tilt) * ca, math.cos(tilt), math.sin(tilt) * sa
        rx, rz = -sa, ca
        out.append([((cx + rx * lx + upx * ly * hh, upy * ly * hh, cz + rz * lx + upz * ly * hh), (lx / w + 0.5, ly))
                    for lx, ly in ((-0.5 * w, 0), (0.5 * w, 0), (0.5 * w, 1), (-0.5 * w, 1))])
    return _quads_geometry(out)


def shrub_geometry(quads=8, width=1.0):
    """scrub.js shrubGeometry."""
    return _fan(quads, width, lambda q: (q / quads) * TAU + (_hash01(q) - 0.5) * 1.0,
                lambda q: 0.22 + _hash01(q + 7) * 0.55, lambda q: 0.6 + _hash01(q + 3) * 0.55,
                lambda q: width * (0.7 + _hash01(q + 11) * 0.5), lambda q: 0.10 * _hash01(q + 5))


def card_clump_geometry(spec):
    """ground-cover.js createCardClumpGeometry."""
    n = spec['quads']
    return _fan(n, spec['width'], lambda q: (q / n) * TAU + (_hash01(q + 1.7) - 0.5) * 0.95,
                lambda q: spec['tiltMin'] + _hash01(q + 7.1) * spec['tiltSpan'],
                lambda q: spec['heightMin'] + _hash01(q + 3.3) * spec['heightSpan'],
                lambda q: spec['width'] * (0.76 + _hash01(q + 11.4) * 0.52),
                lambda q: spec['baseSpread'] * _hash01(q + 5.2))


def grass_scatter(sampler, seed=1, flat_radius=15, count=13000):
    """grass.js buildGrass: [{'geo', 'mats', 'tint'}] for the two tuft variants."""
    rng = Rng('grass:%s' % seed)
    max_r = min(sampler.R * 0.8, 210)
    variants = [{'geo': tuft_geometry(2, 1.0), 'share': 0.62, 'tall': 1.0},
                {'geo': tuft_geometry(3, 0.6), 'share': 0.38, 'tall': 1.4}]
    for v in variants:
        v['cap'] = math.ceil(count * v['share'])
        v['mats'], v['tint'] = [], []
    placed, guard = 0, count * 4
    Y = V3(0, 1, 0)
    while placed < count and guard > 0:
        guard -= 1
        v = variants[0 if rng.next() < variants[0]['share'] else 1]
        if len(v['mats']) >= v['cap']:
            continue
        a = rng.range(0, TAU)
        r = 1.2 + (max_r - 1.6) * rng.next()
        x, z = math.cos(a) * r, math.sin(a) * r
        rocky = sampler.rockness_at(x, z)
        if rocky > rng.range(0.6, 0.95):
            continue
        if r < 9 and rng.next() > 0.18 + 0.82 * ((r - 1.2) / 7.8):
            continue
        q = Q().set_from_axis_angle(Y, rng.range(0, TAU))
        hh = rng.range(0.55, 1.15) * (1.3 if r > flat_radius else 1) * v['tall']
        sx = hh * rng.range(1.4, 2.1) / v['tall']
        sz = hh * rng.range(1.4, 2.1) / v['tall']
        v['mats'].append(compose(V3(x, sampler.height_at(x, z) - 0.02, z), q, V3(sx, hh, sz)))
        dry = min(1, max(0, (rocky - 0.15) * 1.6)) + (0.3 if rng.next() < 0.1 else 0)
        v['tint'].append((rng.range(0.55, 1.0) + dry * 0.45, rng.range(0.55, 1.25) * (1 - dry * 0.35),
                          rng.range(0.45, 0.8) * (1 - dry * 0.55)))
        placed += 1
    return variants


def scrub_scatter(sampler, defs, seed=1, flat_radius=15, count=2600):
    """scrub.js buildScrub: one bucket per shrub definition."""
    rng = Rng('scrub:%s' % seed)
    max_r = min(sampler.R * 0.8, 210)
    total = sum(d.get('share', 1) for d in defs)
    buckets = [{'s': d, 'geo': shrub_geometry(d.get('quads', 8), d.get('width', 1)),
                'cap': math.ceil(count * d.get('share', 1) / total) + 1, 'mats': [], 'tint': []} for d in defs]
    placed, guard = 0, count * 5
    Y = V3(0, 1, 0)
    while placed < count and guard > 0:
        guard -= 1
        pick = rng.range(0, total)
        bi = 0
        while bi < len(defs) - 1:
            pick -= defs[bi].get('share', 1)
            if pick <= 0:
                break
            bi += 1
        b = buckets[bi]
        if len(b['mats']) >= b['cap']:
            continue
        a = rng.range(0, TAU)
        r = 1.6 + (max_r - 2) * rng.next()
        x, z = math.cos(a) * r, math.sin(a) * r
        if sampler.rockness_at(x, z) > rng.range(0.72, 0.98):
            continue
        if r < 10 and rng.next() > 0.10 + 0.9 * ((r - 1.6) / 8.4):
            continue
        q = Q().set_from_axis_angle(Y, rng.range(0, TAU))
        hh = b['s'].get('height', 0.55) * rng.range(0.7, 1.35)
        wr = hh * rng.range(1.0, 1.5)
        b['mats'].append(compose(V3(x, sampler.height_at(x, z) - 0.02, z), q, V3(wr, hh, wr)))
        t = b['s'].get('tint', (0.7, 0.75, 0.55))
        dry = 0.22 if rng.next() < 0.22 else 0
        b['tint'].append((t[0] * rng.range(0.85, 1.12) + dry, t[1] * rng.range(0.85, 1.12) * (1 - dry * 0.4),
                          t[2] * rng.range(0.82, 1.1) * (1 - dry * 0.5)))
        placed += 1
    return buckets
