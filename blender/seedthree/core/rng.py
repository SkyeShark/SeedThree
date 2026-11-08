"""Deterministic seeded RNG, bit-exact with src/core/rng.js.

xmur3 hashes the seed string to a 32-bit state word, then splitmix32 runs as the
generator. All 32-bit arithmetic is masked to uint32 so Math.imul, |0 and >>> come
out the same as in JavaScript.

One Rng is threaded through a whole tree generation in a fixed (parent before
children) order, so a given (species, seed) always reproduces the same tree.
"""

import math

_MASK = 0xFFFFFFFF


def _imul(a, b):
    return ((a & _MASK) * (b & _MASK)) & _MASK


def js_num_str(v):
    """Format a number the way a JS template literal does (1737.0 -> '1737')."""
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if math.isfinite(v) and v == int(v) and abs(v) < 1e21:
            return str(int(v))
        r = repr(v)
        return r
    return str(v)


def _utf16_units(s):
    data = s.encode('utf-16-le')
    for i in range(0, len(data), 2):
        yield data[i] | (data[i + 1] << 8)


def xmur3(s):
    units = list(_utf16_units(s))
    h = (1779033703 ^ len(units)) & _MASK
    for cu in units:
        h = _imul(h ^ cu, 3432918353)
        h = ((h << 13) & _MASK) | (h >> 19)

    def gen():
        nonlocal h
        h = _imul(h ^ (h >> 16), 2246822507)
        h = _imul(h ^ (h >> 13), 3266489909)
        h ^= h >> 16
        return h & _MASK

    return gen


class Rng:
    __slots__ = ('_state',)

    def __init__(self, seed):
        if isinstance(seed, (int, float)) and not isinstance(seed, bool):
            seed_str = 'n:' + js_num_str(seed)
        else:
            seed_str = str(seed)
        self._state = xmur3(seed_str)() & _MASK

    def next(self):
        """Uniform float in [0, 1). splitmix32."""
        self._state = (self._state + 0x9E3779B9) & _MASK
        z = self._state
        z ^= z >> 16
        z = _imul(z, 0x21F0AAAD)
        z ^= z >> 15
        z = _imul(z, 0x735A2D97)
        z ^= z >> 15
        return (z & _MASK) / 4294967296.0

    def range(self, lo, hi):
        return lo + (hi - lo) * self.next()

    def vary(self, base, spread):
        """base +- spread. Always consumes one draw, even when spread is 0."""
        return base + (self.next() * 2 - 1) * spread

    def int(self, lo, hi):
        return math.floor(self.range(lo, hi + 1))

    def chance(self, p):
        return self.next() < p

    def pick(self, arr):
        return arr[math.floor(self.next() * len(arr))]


def tree_rng(species_name, seed, tag=None):
    """The seed-string convention every SeedThree stream uses:
    '<display name>:<seed>' plus an optional ':<tag>' (foliage0, cards1, ...)."""
    s = species_name + ':' + js_num_str(seed)
    if tag:
        s += ':' + tag
    return Rng(s)
