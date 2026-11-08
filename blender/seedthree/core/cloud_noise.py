"""three's ImprovedNoise (Ken Perlin's reference permutation) and the app's cloud noise
texture and cloud placements (src/core/clouds.js), pure numpy."""

import math

import numpy as np

# ---- three's ImprovedNoise (Ken Perlin's reference permutation) ------------------------

_P = [151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240,
      21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88,
      237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231,
      83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1,
      216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173,
      186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16,
      58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43,
      172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34,
      242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199,
      106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243,
      141, 128, 195, 78, 66, 215, 61, 156, 180]
_PERM = np.array(_P + _P, np.int64)


def _fade(t):
    return t * t * t * (t * (t * 6 - 15) + 10)


def _grad(h, x, y, z):
    h = h & 15
    u = np.where(h < 8, x, y)
    v = np.where(h < 4, y, np.where((h == 12) | (h == 14), x, z))
    return np.where((h & 1) == 0, u, -u) + np.where((h & 2) == 0, v, -v)


def improved_noise(x, y, z):
    """three/addons/math/ImprovedNoise.js noise(x, y, z), vectorized."""
    x, y, z = (np.asarray(a, np.float64) for a in (x, y, z))
    fx, fy, fz = np.floor(x), np.floor(y), np.floor(z)
    X, Y, Z = fx.astype(np.int64) & 255, fy.astype(np.int64) & 255, fz.astype(np.int64) & 255
    x, y, z = x - fx, y - fy, z - fz
    xm, ym, zm = x - 1, y - 1, z - 1
    u, v, w = _fade(x), _fade(y), _fade(z)
    p = _PERM
    A = p[X] + Y
    AA, AB = p[A] + Z, p[A + 1] + Z
    B = p[X + 1] + Y
    BA, BB = p[B] + Z, p[B + 1] + Z

    def lerp(t, a, b):
        return a + t * (b - a)
    return lerp(w, lerp(v, lerp(u, _grad(p[AA], x, y, z), _grad(p[BA], xm, y, z)),
                        lerp(u, _grad(p[AB], x, ym, z), _grad(p[BB], xm, ym, z))),
                lerp(v, lerp(u, _grad(p[AA + 1], x, y, zm), _grad(p[BA + 1], xm, y, zm)),
                        lerp(u, _grad(p[AB + 1], x, ym, zm), _grad(p[BB + 1], xm, ym, zm))))


def cloud_noise(size=72):
    """clouds.js makeNoiseTexture: (128 + 128 noise) x falloff^2 into a Uint8Array (x fastest)."""
    s = 0.05
    z, y, x = np.meshgrid(np.arange(size), np.arange(size), np.arange(size), indexing='ij')
    d = 1.0 - np.sqrt(((x - size / 2) / size) ** 2 + ((y - size / 2) / size) ** 2 + ((z - size / 2) / size) ** 2)
    val = (128 + 128 * improved_noise(x * s / 1.5, y * s, z * s / 1.5)) * d * d
    return (np.floor(val).astype(np.int64) % 256).astype(np.uint8).ravel()


def _hash(n):
    s = math.sin(n * 127.1 + 311.7) * 43758.5453
    return s - math.floor(s)


def cloud_placements(count=5, spread=55, altitude=70):
    out = []
    for i in range(count):
        ang = _hash(i * 3.1 + 1) * math.pi * 2
        rad = spread + _hash(i * 2.7 + 5) * 110
        alt = altitude + _hash(i * 1.9 + 3) * 40
        w = 55 + _hash(i * 4.3 + 7) * 55
        h = 22 + _hash(i * 5.7 + 2) * 14
        out.append({'pos': (math.cos(ang) * rad, alt, math.sin(ang) * rad), 'scale': (w, h, w * 0.85)})
    return out


