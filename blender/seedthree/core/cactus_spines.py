"""Saguaro spine areoles, ported from src/core/cactus-spines.js.

Two alpha cards crossed at 90 degrees about the outward rib-crest normal, seated
on the exact crest vertices handed over by build_merged_mesh, sunk ~45% into the
skin, with bent normals fanned from a centre below the base so the cross reads as
a rounded tuft. The apex dome ring gets no cards.
"""

import numpy as np

from .vmath import V3

DEFAULTS = {'size': 0.13, 'widthFrac': 0.85, 'embed': 0.45, 'sizeVar': 0.25, 'density': 1, 'splay': 1.0}


def build_cactus_spines(crest_anchors, cfg, rng):
    c = dict(DEFAULTS)
    c.update(cfg)
    if not crest_anchors or c['density'] <= 0:
        return None
    pos, nrm, uvs, wind, center, idx = [], [], [], [], [], []
    H = c['size']
    W = c['size'] * c['widthFrac']
    h_low, h_high = -H * c['embed'], H * (1 - c['embed'])
    half_w = W * 0.5
    corners = [(-1, h_low), (1, h_low), (-1, h_high), (1, h_high)]
    t1, t2, wp, nn = V3(), V3(), V3(), V3()

    def emit_plane(P, Pc, N, wdir, w, sc):
        b0 = len(pos)
        for xs, h in corners:
            x = xs * half_w * sc
            hh = h * sc
            wp.copy(P).add_scaled(wdir, x).add_scaled(N, hh)
            pos.append((wp.x, wp.y, wp.z))
            nn.copy(wdir).multiply_scalar(xs * c['splay']).add_scaled(N, (hh / H) + 0.55)
            if nn.length_sq() < 1e-8:
                nn.copy(N)
            nn.normalize()
            nrm.append((nn.x, nn.y, nn.z))
            uvs.append((xs * 0.5 + 0.5, (h - h_low) / H))
            wind.append(w)
            center.append((Pc.x, Pc.y, Pc.z))
        idx.extend((b0, b0 + 1, b0 + 2, b0 + 2, b0 + 1, b0 + 3))

    for a in crest_anchors:
        if a.get('cap'):
            continue
        if c['density'] < 1 and rng.next() > c['density']:
            continue
        N = a['normal']
        t1.copy(a['tangent']).add_scaled(N, -a['tangent'].dot(N))
        if t1.length_sq() < 1e-8:
            t1.set(N.z, N.x, N.y)
            t1.add_scaled(N, -t1.dot(N))
        t1.normalize()
        t2.cross_vectors(N, t1).normalize()
        sc = 1 + rng.vary(0, c['sizeVar'])
        push = max(0, H * c['embed'] * sc - a['radius'])
        P = a['pos'].clone().add_scaled(N, push)
        emit_plane(P, a['center'], N, t1, a['wind'], sc)
        emit_plane(P, a['center'], N, t2, a['wind'], sc)

    if not pos:
        return None
    return {
        'kind': 'spines',
        'position': np.array(pos, np.float32),
        'normal': np.array(nrm, np.float32),
        'uv': np.array(uvs, np.float32),
        'aWind': np.array(wind, np.float32),
        'aStemCenter': np.array(center, np.float32),
        'index': np.array(idx, np.int64),
    }
