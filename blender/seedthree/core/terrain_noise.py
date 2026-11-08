"""The app's analytic terrain (src/core/environment.js makeHeightSampler): integer-hash
value noise, 4-octave fBm, the terrain-ring height, the rockness mask and the meadow
pockets, value for value. Pure numpy; three's coordinates (x, y up, z)."""

import numpy as np


def hash2(ix, iz, seed):
    ix = np.asarray(ix, np.int64)
    iz = np.asarray(iz, np.int64)
    h = (ix * 374761393 + iz * 668265263 + int(seed) * 2147483647) & 0xFFFFFFFF
    x = h ^ (h >> 13)
    x = (x * 1274126177) & 0xFFFFFFFF
    return ((x ^ (x >> 16)) & 0xFFFFFFFF) / 4294967296.0


def smooth(t):
    return t * t * (3 - 2 * t)


def value_noise(x, z, seed):
    x = np.asarray(x, np.float64)
    z = np.asarray(z, np.float64)
    ix, iz = np.floor(x), np.floor(z)
    fx, fz = x - ix, z - iz
    ix = ix.astype(np.int64)
    iz = iz.astype(np.int64)
    a, b = hash2(ix, iz, seed), hash2(ix + 1, iz, seed)
    c, d = hash2(ix, iz + 1, seed), hash2(ix + 1, iz + 1, seed)
    u, v = smooth(fx), smooth(fz)
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v


def fbm(x, z, seed):
    s, amp, freq = 0.0, 0.5, 1.0
    for o in range(4):
        s = s + amp * value_noise(np.asarray(x) * freq, np.asarray(z) * freq, seed + o * 17)
        amp *= 0.5
        freq *= 2
    return s


class HeightSampler:
    """makeHeightSampler: heightAt / rocknessAt / meadowAt over three's (x, z), scalars or arrays."""

    def __init__(self, seed=1, R=75, flatR=15, hillH=12):
        self.seed, self.R, self.flatR, self.hillH = seed, R, flatR, hillH

    def ramp(self, x, z):
        return smooth(np.clip((np.hypot(x, z) - self.flatR) / 70, 0, 1))

    def height_at(self, x, z):
        x = np.asarray(x, np.float64)
        z = np.asarray(z, np.float64)
        rp = self.ramp(x, z)
        n = fbm(x * 0.06, z * 0.06, self.seed)
        h = rp * self.hillH * (0.35 + 0.9 * n) + rp * 0.5 * (fbm(x * 0.25, z * 0.25, self.seed + 5) - 0.5)
        h = np.where(np.hypot(x, z) <= self.flatR, 0.0, h)
        return float(h) if h.ndim == 0 else h

    def meadow_at(self, x, z):
        n = fbm(np.asarray(x, np.float64) * 0.018 + 31, np.asarray(z, np.float64) * 0.018 - 17, self.seed + 23)
        m = smooth(np.clip((n - 0.42) / 0.25, 0, 1))
        return float(m) if np.ndim(m) == 0 else m

    def rockness_at(self, x, z):
        x = np.asarray(x, np.float64)
        z = np.asarray(z, np.float64)
        r = np.minimum(1, self.ramp(x, z) * 1.15 + 0.15 * (fbm(x * 0.3, z * 0.3, self.seed + 9) - 0.5)) \
            * (1 - 0.85 * self.meadow_at(x, z))
        return float(r) if np.ndim(r) == 0 else r

    # Blender world X / Y adapters (three (x, z) = Blender (X, -Y))
    def height_xy(self, X, Y):
        return self.height_at(X, -np.asarray(Y))

    def meadow_xy(self, X, Y):
        return self.meadow_at(X, -np.asarray(Y))

    def rockness_xy(self, X, Y):
        return self.rockness_at(X, -np.asarray(Y))


def make_height_sampler(seed=1, R=75, flatR=15, hillH=12):
    return HeightSampler(seed, R, flatR, hillH)


