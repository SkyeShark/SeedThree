"""Small helpers that keep JavaScript semantics where the port needs them.

  nz(v, d)      v ?? d          (keeps 0 and False, replaces only None)
  at(arr, i)    arr?.[i]        (None for a missing array or index)
  to_int32(v)   v | 0           (truncates; None/NaN -> 0)
  is_finite(v)  Number.isFinite (False for None)
"""

import math


def nz(v, d):
    return d if v is None else v


def at(arr, i):
    if arr is None:
        return None
    try:
        if i < 0 or i >= len(arr):
            return None
        return arr[i]
    except TypeError:
        return None


def to_int32(v):
    if v is None or isinstance(v, bool) and not v:
        return 0
    if v is True:
        return 1
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(f):
        return 0
    i = int(f)  # truncation toward zero
    i &= 0xFFFFFFFF
    return i - 0x100000000 if i >= 0x80000000 else i


def is_finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def truthy(v):
    """JS truthiness for the values these params hold."""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)):
        return v != 0 and not (isinstance(v, float) and math.isnan(v))
    return bool(v) or isinstance(v, (dict, list))
