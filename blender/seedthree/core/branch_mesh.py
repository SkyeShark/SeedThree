"""Weber-Penn branch tubes, ported from src/core/branch-mesh.js.

Each stem becomes a tapered generalized cylinder: rings on rotation-minimizing
(parallel transport) frames with a duplicated seam vertex, a constant integer U
wrap per stem (fractional on thin twigs) and square texels, LOD ring strides, and
a flat disc cap on tips wider than 12 mm. Output is plain numpy arrays in three's
Y-up frame: position, normal, uv, aWind, aStemCenter, index (triangles).
"""

import math

import numpy as np

from .jsutil import nz
from .vmath import V3, js_round

WORLD_UP = V3(0, 1, 0)
WORLD_X = V3(1, 0, 0)


def _tangent_at(points, i, out):
    n = len(points)
    if i == 0:
        out.copy(points[1]).sub(points[0])
    elif i == n - 1:
        out.copy(points[n - 1]).sub(points[n - 2])
    else:
        out.copy(points[i + 1]).sub(points[i - 1])
    if out.length_sq() < 1e-10:
        out.set(0, 1, 0)
    return out.normalize()


def _sides_and_stride(stem, opts, radial_scale, ring_stride):
    is_terminal = stem['level'] == stem['maxLevel']
    ts = opts.get('terminalSides')
    trs = opts.get('terminalRingStride')
    if is_terminal and ts:
        sides = max(3, js_round(ts))
    else:
        sides = max(3, js_round(stem['radialSegments'] * radial_scale))
    stride = max(ring_stride, js_round(trs)) if (is_terminal and trs) else ring_stride
    return sides, stride


def estimate_branch_triangles(stems, opts=None):
    opts = opts or {}
    radial_scale = nz(opts.get('radialScale'), 1)
    ring_stride = max(1, js_round(nz(opts.get('ringStride'), 1)))
    tris = 0
    for stem in stems:
        sides, stride = _sides_and_stride(stem, opts, radial_scale, ring_stride)
        src = len(stem['points'])
        rings = math.ceil((src - 1) / stride) + 1 if (stride > 1 and src > 2) else src
        tris += 2 * (rings - 1) * sides
        if stem['radii'][-1] > 0.012 and not stem.get('openTip'):
            tris += sides
    return tris


def build_branch_geometry(stems, opts=None):
    opts = opts or {}
    tile = nz(opts.get('tileWorldSize'), 1.5)
    radial_scale = nz(opts.get('radialScale'), 1)
    ring_stride = max(1, js_round(nz(opts.get('ringStride'), 1)))

    P, N, UV, W, C, I = [], [], [], [], [], []
    vert_base = 0
    tan = V3()
    nrm = V3()
    bin_ = V3()
    for stem in stems:
        lobes = stem.get('lobes') or 0
        lobe_depth = stem.get('lobeDepth') or 0
        seg, stride = _sides_and_stride(stem, opts, radial_scale, ring_stride)
        points, radii, stem_winds = stem['points'], stem['radii'], stem.get('winds')
        if stride > 1 and len(points) > 2:
            idxs = list(range(0, len(points) - 1, stride)) + [len(points) - 1]
            points = [points[i] for i in idxs]
            radii = [radii[i] for i in idxs]
            if stem_winds:
                stem_winds = [stem_winds[i] for i in idxs]
        rings = len(points)
        ring_verts = seg + 1

        fN, fB = [], []
        _tangent_at(points, 0, tan)
        nrm.cross_vectors(tan, WORLD_UP)
        if nrm.length_sq() < 1e-6:
            nrm.cross_vectors(tan, WORLD_X)
        nrm.normalize()
        bin_.cross_vectors(nrm, tan).normalize()
        fN.append(nrm.clone())
        fB.append(bin_.clone())
        for i in range(1, rings):
            _tangent_at(points, i, tan)
            nrm.copy(fN[i - 1]).add_scaled(tan, -fN[i - 1].dot(tan))
            if nrm.length_sq() < 1e-8:
                nrm.cross_vectors(tan, WORLD_UP)
                if nrm.length_sq() < 1e-6:
                    nrm.cross_vectors(tan, WORLD_X)
            nrm.normalize()
            bin_.cross_vectors(nrm, tan).normalize()
            fN.append(nrm.clone())
            fB.append(bin_.clone())

        ref_idx = min(rings - 1, max(0, math.floor(rings * 0.25)))
        circumference = 2 * math.pi * radii[ref_idx]
        wraps = circumference / tile
        u_scale = max(1, js_round(wraps)) if wraps >= 0.75 else wraps
        tile_v = max(0.02, circumference / u_scale)

        j = np.arange(seg + 1, dtype=np.float64)
        theta = (j / seg) * math.pi * 2
        cs, sn = np.cos(theta), np.sin(theta)
        lobe_mod = 1 + lobe_depth * np.cos(lobes * theta) if lobes > 0 else np.ones_like(theta)
        u = (j / seg) * u_scale

        pos = np.empty((rings, seg + 1, 3))
        nor = np.empty((rings, seg + 1, 3))
        uvs = np.empty((rings, seg + 1, 2))
        wnd = np.empty((rings, seg + 1))
        cen = np.empty((rings, seg + 1, 3))
        v_along = 0.0
        last_wind = 0.05
        level_frac = stem['level'] / stem['maxLevel'] if stem['maxLevel'] > 0 else 0
        for i in range(rings):
            if i > 0:
                v_along += points[i].distance_to(points[i - 1])
            v = v_along / tile_v
            axN, axB = fN[i], fB[i]
            r = radii[i]
            along = i / (rings - 1)
            if stem_winds:
                wind = stem_winds[i]
            else:
                wind = min(1, 0.15 + 0.85 * (0.5 * level_frac + 0.5 * level_frac * along + 0.15 * along))
            last_wind = wind
            rx = axN.x * cs + axB.x * sn
            ry = axN.y * cs + axB.y * sn
            rz = axN.z * cs + axB.z * sn
            rr = r * lobe_mod
            pt = points[i]
            pos[i, :, 0] = pt.x + rx * rr
            pos[i, :, 1] = pt.y + ry * rr
            pos[i, :, 2] = pt.z + rz * rr
            nor[i, :, 0] = rx
            nor[i, :, 1] = ry
            nor[i, :, 2] = rz
            uvs[i, :, 0] = u
            uvs[i, :, 1] = v
            wnd[i, :] = wind
            cen[i, :, 0] = pt.x
            cen[i, :, 1] = pt.y
            cen[i, :, 2] = pt.z
        P.append(pos.reshape(-1, 3))
        N.append(nor.reshape(-1, 3))
        UV.append(uvs.reshape(-1, 2))
        W.append(wnd.reshape(-1))
        C.append(cen.reshape(-1, 3))

        if rings > 1:
            ii, jj = np.meshgrid(np.arange(rings - 1), np.arange(seg), indexing='ij')
            a = (vert_base + ii * ring_verts + jj).reshape(-1)
            b = a + 1
            c = a + ring_verts
            d = c + 1
            I.append(np.stack([a, c, b, b, c, d], axis=1).reshape(-1))

        extra = 0
        tip_r = radii[rings - 1]
        if tip_r > 0.012 and not stem.get('openTip'):
            tp = points[rings - 1]
            _tangent_at(points, rings - 1, tan)
            axN, axB = fN[rings - 1], fB[rings - 1]
            cap_uvr = tip_r / tile
            cap_base = vert_base + rings * ring_verts
            rx = axN.x * cs + axB.x * sn
            ry = axN.y * cs + axB.y * sn
            rz = axN.z * cs + axB.z * sn
            rr = tip_r * lobe_mod
            cp = np.stack([tp.x + rx * rr, tp.y + ry * rr, tp.z + rz * rr], axis=1)
            P.append(np.vstack([cp, [[tp.x, tp.y, tp.z]]]))
            N.append(np.tile([tan.x, tan.y, tan.z], (seg + 2, 1)))
            cuv = np.stack([0.5 + cap_uvr * cs, 0.5 + cap_uvr * sn], axis=1)
            UV.append(np.vstack([cuv, [[0.5, 0.5]]]))
            W.append(np.full(seg + 2, last_wind))
            C.append(np.tile([tp.x, tp.y, tp.z], (seg + 2, 1)))
            center_idx = cap_base + (seg + 1)
            jj = np.arange(seg)
            I.append(np.stack([np.full(seg, center_idx), cap_base + jj + 1, cap_base + jj], axis=1).reshape(-1))
            extra = seg + 2
        vert_base += rings * ring_verts + extra

    def cat(lst, shape):
        return np.concatenate(lst).astype(np.float32) if lst else np.zeros(shape, np.float32)

    return {
        'position': cat(P, (0, 3)),
        'normal': cat(N, (0, 3)),
        'uv': cat(UV, (0, 2)),
        'aWind': cat(W, (0,)),
        'aStemCenter': cat(C, (0, 3)),
        'index': np.concatenate(I).astype(np.int64) if I else np.zeros(0, np.int64),
    }
