"""A three.js-exact subset of Vector3 / Quaternion / Matrix4 (r184 formulas).

The generators are ported line by line from the JS, so these keep three's own
formulas (applyQuaternion, slerp, setFromUnitVectors, normalize as multiply by
1/len, ...) instead of mathutils. Everything is float64 like JS numbers. Methods
mutate and return self, so chained JS reads the same in Python.
"""

import math


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def js_round(x):
    """Math.round: halves round up (toward +inf), unlike Python's round()."""
    return math.floor(x + 0.5)


class V3:
    __slots__ = ('x', 'y', 'z')

    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x = x
        self.y = y
        self.z = z

    def __repr__(self):
        return 'V3(%r, %r, %r)' % (self.x, self.y, self.z)

    def set(self, x, y, z):
        self.x = x
        self.y = y
        self.z = z
        return self

    def clone(self):
        return V3(self.x, self.y, self.z)

    def copy(self, v):
        self.x = v.x
        self.y = v.y
        self.z = v.z
        return self

    def to_tuple(self):
        return (self.x, self.y, self.z)

    def add(self, v):
        self.x += v.x
        self.y += v.y
        self.z += v.z
        return self

    def sub(self, v):
        self.x -= v.x
        self.y -= v.y
        self.z -= v.z
        return self

    def add_scaled(self, v, s):
        self.x += v.x * s
        self.y += v.y * s
        self.z += v.z * s
        return self

    def sub_vectors(self, a, b):
        self.x = a.x - b.x
        self.y = a.y - b.y
        self.z = a.z - b.z
        return self

    def multiply_scalar(self, s):
        self.x *= s
        self.y *= s
        self.z *= s
        return self

    def divide_scalar(self, s):
        return self.multiply_scalar(1 / s)

    def negate(self):
        self.x = -self.x
        self.y = -self.y
        self.z = -self.z
        return self

    def dot(self, v):
        return self.x * v.x + self.y * v.y + self.z * v.z

    def length_sq(self):
        return self.x * self.x + self.y * self.y + self.z * self.z

    def length(self):
        return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z)

    def normalize(self):
        return self.divide_scalar(self.length() or 1)

    def cross_vectors(self, a, b):
        ax, ay, az = a.x, a.y, a.z
        bx, by, bz = b.x, b.y, b.z
        self.x = ay * bz - az * by
        self.y = az * bx - ax * bz
        self.z = ax * by - ay * bx
        return self

    def apply_quaternion(self, q):
        vx, vy, vz = self.x, self.y, self.z
        qx, qy, qz, qw = q.x, q.y, q.z, q.w
        tx = 2 * (qy * vz - qz * vy)
        ty = 2 * (qz * vx - qx * vz)
        tz = 2 * (qx * vy - qy * vx)
        self.x = vx + qw * tx + qy * tz - qz * ty
        self.y = vy + qw * ty + qz * tx - qx * tz
        self.z = vz + qw * tz + qx * ty - qy * tx
        return self

    def apply_axis_angle(self, axis, angle):
        return self.apply_quaternion(Q().set_from_axis_angle(axis, angle))

    def distance_to_squared(self, v):
        dx = self.x - v.x
        dy = self.y - v.y
        dz = self.z - v.z
        return dx * dx + dy * dy + dz * dz

    def distance_to(self, v):
        return math.sqrt(self.distance_to_squared(v))

    def lerp(self, v, a):
        self.x += (v.x - self.x) * a
        self.y += (v.y - self.y) * a
        self.z += (v.z - self.z) * a
        return self

    def angle_to(self, v):
        den = math.sqrt(self.length_sq() * v.length_sq())
        if den == 0:
            return math.pi / 2
        return math.acos(clamp(self.dot(v) / den, -1, 1))


class Q:
    __slots__ = ('x', 'y', 'z', 'w')

    def __init__(self, x=0.0, y=0.0, z=0.0, w=1.0):
        self.x = x
        self.y = y
        self.z = z
        self.w = w

    def __repr__(self):
        return 'Q(%r, %r, %r, %r)' % (self.x, self.y, self.z, self.w)

    def clone(self):
        return Q(self.x, self.y, self.z, self.w)

    def copy(self, q):
        self.x, self.y, self.z, self.w = q.x, q.y, q.z, q.w
        return self

    def to_tuple(self):
        return (self.x, self.y, self.z, self.w)

    def set_from_axis_angle(self, axis, angle):
        half = angle / 2
        s = math.sin(half)
        self.x = axis.x * s
        self.y = axis.y * s
        self.z = axis.z * s
        self.w = math.cos(half)
        return self

    def set_from_unit_vectors(self, vf, vt):
        r = vf.dot(vt) + 1
        if r < 1e-8:
            r = 0
            if abs(vf.x) > abs(vf.z):
                self.x, self.y, self.z, self.w = -vf.y, vf.x, 0.0, r
            else:
                self.x, self.y, self.z, self.w = 0.0, -vf.z, vf.y, r
        else:
            self.x = vf.y * vt.z - vf.z * vt.y
            self.y = vf.z * vt.x - vf.x * vt.z
            self.z = vf.x * vt.y - vf.y * vt.x
            self.w = r
        return self.normalize()

    def dot(self, q):
        return self.x * q.x + self.y * q.y + self.z * q.z + self.w * q.w

    def length(self):
        return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w)

    def normalize(self):
        l = self.length()
        if l == 0:
            self.x, self.y, self.z, self.w = 0.0, 0.0, 0.0, 1.0
        else:
            l = 1 / l
            self.x *= l
            self.y *= l
            self.z *= l
            self.w *= l
        return self

    def invert(self):
        self.x = -self.x
        self.y = -self.y
        self.z = -self.z
        return self

    def _mul(self, a, b):
        qax, qay, qaz, qaw = a.x, a.y, a.z, a.w
        qbx, qby, qbz, qbw = b.x, b.y, b.z, b.w
        self.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby
        self.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz
        self.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx
        self.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz
        return self

    def multiply(self, q):
        return self._mul(self, q)

    def premultiply(self, q):
        return self._mul(q, self)

    def slerp(self, qb, t):
        x, y, z, w = qb.x, qb.y, qb.z, qb.w
        d = self.dot(qb)
        if d < 0:
            x, y, z, w = -x, -y, -z, -w
            d = -d
        s = 1 - t
        if d < 0.9995:
            theta = math.acos(d)
            sn = math.sin(theta)
            s = math.sin(s * theta) / sn
            t = math.sin(t * theta) / sn
            self.x = self.x * s + x * t
            self.y = self.y * s + y * t
            self.z = self.z * s + z * t
            self.w = self.w * s + w * t
        else:
            self.x = self.x * s + x * t
            self.y = self.y * s + y * t
            self.z = self.z * s + z * t
            self.w = self.w * s + w * t
            self.normalize()
        return self


def compose(pos, q, scl):
    """Matrix4.compose -> 16 floats, column-major (three's te[] layout)."""
    x, y, z, w = q.x, q.y, q.z, q.w
    x2, y2, z2 = x + x, y + y, z + z
    xx, xy, xz = x * x2, x * y2, x * z2
    yy, yz, zz = y * y2, y * z2, z * z2
    wx, wy, wz = w * x2, w * y2, w * z2
    sx, sy, sz = scl.x, scl.y, scl.z
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0.0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0.0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0.0,
        pos.x, pos.y, pos.z, 1.0,
    ]


X_AXIS = V3(1, 0, 0)
Y_AXIS = V3(0, 1, 0)
Z_AXIS = V3(0, 0, 1)
UP = V3(0, 1, 0)


def q_around(axis, deg):
    return Q().set_from_axis_angle(axis, (deg * math.pi) / 180)
