"""The app's billboard forest ring: slot placement (main.js updateForest), pure Python.

A grove of the hero's own species around the meadow: 60% of the trees in the near
band (38-95 m), the rest farther out (95-200 m, area-uniform), where far trees are
reject-sampled into the meadow pockets (meadowAt > 0.35, up to 8 tries). Each slot
has a uniform scale 0.5-1.1, a free yaw and sits 0.3 x scale into the ground. The
RNG stream is the app's ('forest:<seed>').

    slots = forest_slots(64, seed=1, height_at=lambda x, z: 0.0, meadow_at=None)

Coordinates are three's (x, y up, z); height_at / meadow_at take three (x, z).
"""

import math

from .rng import Rng
from .vmath import Q, V3, compose

Y = V3(0, 1, 0)


def forest_slots(count=64, seed=1, height_at=None, meadow_at=None, center_local=(0.0, 6.0, 0.0)):
    """-> [{'pos': (x, y, z), 's', 'rot', 'matrix' (16), 'origin': canopy centre in the world}]."""
    rng = Rng('forest:%s' % _num(seed))
    height_at = height_at or (lambda x, z: 0.0)
    n = int(count)
    out = []
    q = Q()
    for i in range(n):
        x = z = r = 0.0
        for _ in range(8):
            a = rng.range(0, math.pi * 2)
            r = rng.range(38, 95) if i < n * 0.6 else 95 + 105 * math.sqrt(rng.next())
            x = math.cos(a) * r
            z = math.sin(a) * r
            if r < 95 or ((meadow_at(x, z) if meadow_at else 0) or 0) > 0.35:
                break
        s = rng.range(0.5, 1.1)
        rot = rng.range(0, math.pi * 2)
        q.set_from_axis_angle(Y, rot)
        pos = V3(x, height_at(x, z) - 0.3 * s, z)
        m = compose(pos, q, V3(s, s, s))
        c = V3(*center_local).apply_quaternion(q).multiply_scalar(s).add(pos)
        out.append({'pos': (pos.x, pos.y, pos.z), 's': s, 'rot': rot, 'matrix': m, 'origin': (c.x, c.y, c.z),
                    'ground': height_at(x, z)})
    return out


def _num(v):
    from .rng import js_num_str
    return js_num_str(v)
