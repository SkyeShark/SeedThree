"""SeedThree's texture tooling (scripts/texture/*.mjs) in Python: numpy + Pillow.

Each function is the script of the same name: same arguments, same defaults, same
output files and file names, the same arithmetic in the same order (JS Math.round,
Float32Array storage, Math.hypot's Kahan sum), so a map derived here equals the one
the JS writes. The image operations the JS takes from sharp (libvips) are emulated:

  blur(sigma)    libvips gaussblur at integer precision: the 20x-quantized separable
                 Gaussian cut at amplitude 0.2, edges extended by copying
  median(n)      the n x n rank filter, edges extended by copying
  greyscale()    sRGB -> linear luminance -> sRGB 8-bit (libvips B_W)
  resize(fill)   Lanczos3 on premultiplied alpha (Pillow; libvips differs by a level or two)

    from seedthree.tools import texture as T
    T.derive_pbr('assets/bark/oak_albedo.png', strength=2.5)     # -> oak_normal.png, oak_roughness.png
    T.check_tile('assets/bark/oak_albedo.png')                   # seam ratios + an offset preview
"""

import math
import os
import re

import numpy as np

try:
    from PIL import Image
except ImportError:      # inside Blender's Python: these are offline tools for system Python
    Image = None


# ---- JS arithmetic -----------------------------------------------------------------

def js_round(x):
    """Math.round: floor(x + 0.5)."""
    return np.floor(np.asarray(x, np.float64) + 0.5)


def js_hypot3(a, b, c):
    """Math.hypot(a, b, c) as V8 computes it (scale by the max, Kahan-summed squares)."""
    a, b, c = (np.abs(np.asarray(v, np.float64)) for v in (a, b, c))
    mx = np.maximum(np.maximum(a, b), c)
    safe = np.where(mx == 0, 1.0, mx)
    s = np.zeros_like(mx)
    comp = np.zeros_like(mx)
    for v in (a, b, c):
        n = v / safe
        summand = n * n - comp
        pre = s + summand
        comp = (pre - s) - summand
        s = pre
    return np.where(mx == 0, 0.0, np.sqrt(s) * safe)


def _u8(x):
    return np.clip(x, 0, 255).astype(np.uint8)


def _stem(path, pattern=r'(_albedo)?\.png$'):
    return re.sub(pattern, '', path, flags=re.I)


def _need_pil():
    if Image is None:
        raise RuntimeError('[seedthree.tools] these tools need Pillow (run them with system Python)')


# ---- sharp's image I/O conventions ----------------------------------------------------

def read_image(path, ensure_alpha=False, remove_alpha=False, greyscale=False):
    """Decode like sharp(path)[.greyscale()][.ensureAlpha()|.removeAlpha()].raw():
    -> uint8 (H, W, C) with C = 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA."""
    _need_pil()
    im = Image.open(path)
    im.load()
    if im.mode == 'P':
        im = im.convert('RGBA' if 'transparency' in im.info else 'RGB')
    elif im.mode in ('1', 'I', 'I;16', 'I;16B', 'F'):
        im = im.convert('L') if im.mode != 'I;16' else Image.fromarray((np.asarray(im, np.uint16) >> 8).astype(np.uint8))
    elif im.mode == 'CMYK':
        im = im.convert('RGB')
    a = np.asarray(im)
    if a.ndim == 2:
        a = a[..., None]
    a = a.astype(np.uint8)
    if greyscale:
        a = to_greyscale(a)
    if ensure_alpha and a.shape[2] in (1, 3):
        a = np.concatenate([a, np.full(a.shape[:2] + (1,), 255, np.uint8)], axis=2)
    if remove_alpha and a.shape[2] in (2, 4):
        a = a[..., :-1]
    return np.ascontiguousarray(a)


def write_png(path, a):
    """Write uint8 (H, W[, C]) as PNG the way sharp's .png() does: always sRGB, so a grey
    buffer becomes RGB and grey + alpha becomes RGBA (the grey replicated)."""
    _need_pil()
    a = np.asarray(a)
    if a.ndim == 2:
        a = a[..., None]
    if a.shape[2] in (1, 2):
        a = np.concatenate([np.repeat(a[..., :1], 3, axis=2), a[..., 1:]], axis=2)
    mode = {3: 'RGB', 4: 'RGBA'}[a.shape[2]]
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    Image.fromarray(np.ascontiguousarray(a.astype(np.uint8)), mode).save(path)
    return path


def _srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def to_greyscale(a):
    """sharp .greyscale(): libvips' B_W colourspace (linear luminance, sRGB-encoded)."""
    if a.shape[2] in (1, 2):
        return a
    rgb = _srgb_to_lin(a[..., :3].astype(np.float64) / 255.0)
    y = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    g = _u8(js_round(_lin_to_srgb(y) * 255))[..., None]
    return np.concatenate([g, a[..., 3:4]], axis=2) if a.shape[2] == 4 else g


def _lanczos3(x):
    x = np.asarray(x, np.float64)
    return np.where(np.abs(x) < 3, np.sinc(x) * np.sinc(x / 3), 0.0)


def _catmull_rom(x):
    x = np.abs(np.asarray(x, np.float64))
    a = -0.5
    return np.where(x < 1, (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1,
                    np.where(x < 2, a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a, 0.0))


def _resample_axis(arr, n_out, axis):
    """One axis of libvips' resize: shrinking is Lanczos3 on pixel centres; enlarging is
    the bicubic (Catmull-Rom) interpolator at input x = out x * scale - 0.5 (libvips'
    half-pixel shift, measured against sharp); edges clamp."""
    n_in = arr.shape[axis]
    if n_in == n_out:
        return arr
    s = n_in / n_out
    rows = []
    for x in range(n_out):
        if s > 1:
            c = (x + 0.5) * s - 0.5
            idx = np.arange(int(math.floor(c - 3 * s)), int(math.ceil(c + 3 * s)) + 1)
            wts = _lanczos3((idx - c) / s)
        else:
            c = x * s - 0.5
            idx = np.arange(int(math.floor(c)) - 1, int(math.floor(c)) + 3)
            wts = _catmull_rom(idx - c)
        wts = wts / wts.sum()
        rows.append(np.tensordot(wts, np.take(arr, np.clip(idx, 0, n_in - 1), axis=axis), axes=([0], [axis])))
    return np.stack(rows, axis=axis)


def resize(a, w, h, fit='fill'):
    """sharp .resize(w, h, {fit}): 'fill' stretches, 'cover' scales to cover and centre-crops
    (sharp's default). Alpha is premultiplied (truncated) around it as sharp does; the same
    size is a no-op. Matches sharp within a level or two (libvips' fixed-point phases)."""
    H0, W0 = a.shape[:2]
    if (W0, H0) == (w, h):
        return a
    if fit == 'cover':
        s = max(w / W0, h / H0)
        sw, sh = max(w, int(round(W0 * s))), max(h, int(round(H0 * s)))
    else:
        sw, sh = w, h
    x = a.astype(np.int64)
    alpha = a.shape[2] in (2, 4)
    if alpha:
        al = x[..., -1:]
        x = np.concatenate([(x[..., :-1] * al) // 255, al], axis=2)
    out = _resample_axis(_resample_axis(x.astype(np.float64), sw, 1), sh, 0)
    out = np.clip(np.floor(out + 0.5), 0, 255).astype(np.int64)
    if alpha:
        ab = out[..., -1:]
        out = np.concatenate([np.clip(np.where(ab > 0, (out[..., :-1] * 255) // np.maximum(ab, 1), 0), 0, 255), ab], axis=2)
    if fit == 'cover':
        l, t = (sw - w) // 2, (sh - h) // 2
        out = out[t:t + h, l:l + w]
    return out.astype(np.uint8)


def gaussmat(sigma, min_ampl=0.2):
    """libvips vips_gaussmat(sigma, separable, precision=integer): (mask ints, scale)."""
    sig2 = 2.0 * sigma * sigma
    max_x = min(max(0.0, 8.0 * sigma), 5000.0)
    x = 0
    while x < max_x:
        if math.exp(-(x * x) / sig2) < min_ampl:
            break
        x += 1
    width = 2 * max(x - 1, 0) + 1
    mask = []
    for i in range(width):
        xo = i - width // 2
        v = 20.0 * math.exp(-(xo * xo) / sig2)
        mask.append(int(v + 0.5) if v > 0 else int(v - 0.5))    # VIPS_RINT
    return mask, (sum(mask) or 1)


def fixed_mask(sigma):
    """The uchar convolution's fixed-point mask (libvips 8.18 convi): each element of
    gaussmat / scale as an int at 6 bits above the largest one's exponent -> (coeff, shift)."""
    m, scale = gaussmat(sigma)
    scaled = [v / scale for v in m]
    shift = 6 - int(math.ceil(math.log2(max(scaled))))
    return [int(math.floor(v * (1 << shift) + 0.5)) for v in scaled], shift


def _conv1d_fixed(a, coeff, shift, axis):
    r = len(coeff) // 2
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r, r)
    p = np.pad(a.astype(np.int64), pad, mode='edge')
    n = a.shape[axis]
    acc = np.zeros(a.shape, np.int64)
    for k, c in enumerate(coeff):
        if c:
            acc += c * np.take(p, np.arange(k, k + n), axis=axis)
    return np.clip((acc + (1 << (shift - 1))) >> shift, 0, 255)


def premultiply(a):
    """sharp's premultiply before blur / resize on an image with alpha (truncated to 8 bits)."""
    x = a.astype(np.int64)
    al = x[..., -1:]
    return np.concatenate([(x[..., :-1] * al) // 255, al], axis=2)


def unpremultiply(x):
    ab = x[..., -1:].astype(np.int64)
    col = np.where(ab > 0, (x[..., :-1].astype(np.int64) * 255) // np.maximum(ab, 1), 0)
    return np.concatenate([np.clip(col, 0, 255), ab], axis=2).astype(np.uint8)


def _blur_core(x, sigma):
    coeff, shift = fixed_mask(sigma)
    return _conv1d_fixed(_conv1d_fixed(x, coeff, shift, axis=1), coeff, shift, axis=0)


def blur(a, sigma):
    """sharp .blur(sigma) on uint8 (H, W, C), bit for bit (measured against sharp 0.35 /
    libvips 8.18): a separable fixed-point Gaussian, horizontal then vertical through an
    8-bit intermediate, edges copied; an image with alpha is premultiplied (truncated)
    first and un-premultiplied (truncated) after, the alpha blurred as it is."""
    if a.shape[2] in (2, 4):
        return unpremultiply(_blur_core(premultiply(a), sigma))
    return _blur_core(a.astype(np.int64), sigma).astype(np.uint8)


def median(a, n=5):
    """sharp .median(n): the n x n rank filter (middle rank) per channel, edges copied."""
    r = n // 2
    squeeze = a.ndim == 2
    if squeeze:
        a = a[..., None]
    p = np.pad(a, ((r, r), (r, r), (0, 0)), mode='edge')
    H, W = a.shape[:2]
    win = np.stack([p[dy:dy + H, dx:dx + W] for dy in range(n) for dx in range(n)], axis=0)
    out = np.sort(win, axis=0)[(n * n) // 2].astype(np.uint8)
    return out[..., 0] if squeeze else out


def _rgb(data):
    """r, g, b planes (float64) of an (H, W, C) buffer; a grey buffer reads as grey RGB."""
    d = data.astype(np.float64)
    if data.shape[2] >= 3:
        return d[..., 0], d[..., 1], d[..., 2]
    return d[..., 0], d[..., 0], d[..., 0]


def _alpha(data):
    return data[..., -1] if data.shape[2] in (2, 4) else np.full(data.shape[:2], 255, np.uint8)


def _wrap_shift(a, dx, dy):
    """b[y, x] = a[wrap(y + dy), wrap(x + dx)]."""
    return np.roll(np.roll(a, -dy, axis=0), -dx, axis=1)


def _clamp_shift(a, dx, dy):
    """b[y, x] = a[clamp(y + dy), clamp(x + dx)]."""
    H, W = a.shape
    ys = np.clip(np.arange(H) + dy, 0, H - 1)
    xs = np.clip(np.arange(W) + dx, 0, W - 1)
    return a[ys][:, xs]


def _sobel(L, shift):
    """The scripts' Sobel (in their addition order)."""
    gx = (shift(L, 1, -1) + 2 * shift(L, 1, 0) + shift(L, 1, 1)) - (shift(L, -1, -1) + 2 * shift(L, -1, 0) + shift(L, -1, 1))
    gy = (shift(L, -1, 1) + 2 * shift(L, 0, 1) + shift(L, 1, 1)) - (shift(L, -1, -1) + 2 * shift(L, 0, -1) + shift(L, 1, -1))
    return gx, gy


def _scharr(L, shift):
    gx = (3 * shift(L, 1, -1) + 10 * shift(L, 1, 0) + 3 * shift(L, 1, 1)) - (3 * shift(L, -1, -1) + 10 * shift(L, -1, 0) + 3 * shift(L, -1, 1))
    gy = (3 * shift(L, -1, 1) + 10 * shift(L, 0, 1) + 3 * shift(L, 1, 1)) - (3 * shift(L, -1, -1) + 10 * shift(L, 0, -1) + 3 * shift(L, 1, -1))
    return gx, gy


def _encode_normal(nx, ny, nz, in_place=True):
    """normal[o] = Math.round((n * inv * 0.5 + 0.5) * 255) per component."""
    inv = 1 / js_hypot3(nx, ny, nz)
    if in_place:
        nx, ny, nz = nx * inv, ny * inv, nz * inv
        comps = (nx, ny, nz)
    else:
        comps = (nx * inv, ny * inv, nz * inv)
    return np.stack([_u8(js_round((c * 0.5 + 0.5) * 255)) for c in comps], axis=2)


def _f32(x):
    return np.asarray(x, np.float64).astype(np.float32).astype(np.float64)


# ---- derive-pbr ---------------------------------------------------------------------------

def derive_pbr(input, strength=2.5):
    """Tangent-space normal (wrap-sampled Sobel of the albedo luminance) + roughness
    (0.95 - 0.22 lum), alpha-aware. Writes <stem>_normal.png, <stem>_roughness.png."""
    stem = _stem(input)
    normal_out, rough_out = stem + '_normal.png', stem + '_roughness.png'
    data = read_image(input, ensure_alpha=True)
    H, W = data.shape[:2]
    r, g, b = _rgb(data)
    lum = _f32((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255)
    mask = _alpha(data) > 16          # a fully opaque input (bark, ground) keeps every texel
    gx, gy = _sobel(lum, _wrap_shift)
    normal = _encode_normal(-gx * strength, -gy * strength, np.ones_like(gx))
    normal[~mask] = (128, 128, 255)
    rough = _u8(js_round(np.clip(0.95 - 0.22 * lum, 0, 1) * 255))
    rough[~mask] = 178
    write_png(normal_out, normal)
    write_png(rough_out, rough)
    print('albedo:    %s %dx%d' % (os.path.basename(input), W, H))
    print('normal  -> %s  (strength %s)' % (os.path.basename(normal_out), strength))
    print('roughness -> %s' % os.path.basename(rough_out))
    return {'normal': normal_out, 'roughness': rough_out}


# ---- derive-height -----------------------------------------------------------------------

def derive_height(in_path, out_path=None):
    """Height from a tangent-space normal map by Poisson integration in Fourier space
    (periodic, so tileable input stays tileable), 0.5 % / 99.5 % clipped, 8..255."""
    out_path = out_path or re.sub(r'_normal\.png$', '_height.png', in_path, flags=re.I)
    if out_path == in_path:
        raise ValueError('output would overwrite input - name it explicitly')
    raw = read_image(in_path, ensure_alpha=True).astype(np.float64)
    h, w = raw.shape[:2]
    if (w & (w - 1)) or (h & (h - 1)):
        raise ValueError('dimensions %dx%d must be powers of two for the FFT' % (w, h))
    nx = raw[..., 0] / 127.5 - 1
    ny = raw[..., 1] / 127.5 - 1
    nz = np.maximum(0.15, raw[..., 2] / 127.5 - 1)
    gx, gy = -nx / nz, ny / nz
    Gx, Gy = np.fft.fft2(gx), np.fft.fft2(gy)
    ky = 2 * np.pi * np.where(np.arange(h) < h / 2, np.arange(h), np.arange(h) - h) / h
    kx = 2 * np.pi * np.where(np.arange(w) < w / 2, np.arange(w), np.arange(w) - w) / w
    KX, KY = np.meshgrid(kx, ky)
    k2 = KX * KX + KY * KY
    safe = np.where(k2 < 1e-12, 1.0, k2)
    hr = (KX * Gx.imag + KY * Gy.imag) / safe
    hi = -(KX * Gx.real + KY * Gy.real) / safe
    hr[k2 < 1e-12] = 0
    hi[k2 < 1e-12] = 0
    height = np.fft.ifft2(hr + 1j * hi).real
    s = np.sort(height.ravel())
    lo, hv = s[int(math.floor(0.005 * len(s)))], s[int(math.floor(0.995 * len(s)))]
    t = np.clip((height - lo) / max(1e-9, hv - lo), 0, 1)
    out = _u8(8 + js_round(t * 247))
    write_png(out_path, out)
    print('height -> %s  (%dx%d, Poisson-integrated from %s)' % (os.path.basename(out_path), w, h, os.path.basename(in_path)))
    return out_path


# ---- derive-translucency ---------------------------------------------------------------

def derive_translucency(input, tissue=0.85, vein=6.0):
    """Leaf translucency from its cutout: tissue transmits (tissue), bright vein ridges
    (blur2 - blur12 high-pass x vein) go opaque, below the 0.35 alpha cut is black,
    then a 1 px smooth. Writes <stem>_translucency.png."""
    out = _stem(input) + '_translucency.png'
    data = read_image(input, ensure_alpha=True)
    H, W = data.shape[:2]
    alpha = _alpha(data).astype(np.float64)
    r, g, b = _rgb(data)
    lum = _u8(js_round(0.3 * r + 0.59 * g + 0.11 * b))
    lum_med = blur(lum[..., None], 2)[..., 0].astype(np.float64)
    lum_big = blur(lum[..., None], 12)[..., 0].astype(np.float64)
    v = np.clip((lum_med - lum_big) / 255 * vein, 0, 1)
    t = np.clip(tissue - v * 0.85, 0.04, 0.95)
    buf = _u8(js_round(t * 255))
    buf[alpha / 255 < 0.35] = 0
    write_png(out, blur(buf[..., None], 1.0))
    print('translucency -> %s  (%dx%d, tissue %s, veinGain %s)' % (os.path.basename(out), W, H, tissue, vein))
    return out


# ---- derive-leaf-maps --------------------------------------------------------------------

def derive_leaf_maps(albedo, height, strength=6.0, blur_sigma=1.5):
    """THE leaf map pipeline: from a de-lit albedo + its semantic height, the normal
    (clamped Sobel of the height), roughness (veins matte, tissue waxy) and translucency
    (thin tissue glows). Writes <albedo base>_normal / _roughness / _translucency.png
    (the base keeps any _albedo, as the JS does)."""
    base = re.sub(r'\.png$', '', albedo, flags=re.I)
    a = read_image(albedo, ensure_alpha=True)
    H, W = a.shape[:2]
    hd = resize(read_image(height, greyscale=True), W, H, fit='cover')
    if blur_sigma > 0:
        hd = blur(hd, blur_sigma)
    hd = hd[..., 0].astype(np.float64)
    mask = _alpha(a) > 16
    hh = hd / 255
    gx, gy = _sobel(hh, _clamp_shift)
    normal = _encode_normal(-gx * strength, gy * strength, np.ones_like(gx), in_place=False)
    normal[~mask] = (128, 128, 255)
    rough = _u8(js_round(255 * np.clip(0.82 - 0.27 * hh, 0.2, 1)))
    t = np.power(np.maximum(0, (hh - 0.12) / 0.88), 0.85)
    trans = _u8(js_round(255 * np.minimum(1, 0.06 + 0.92 * t)))
    rough[~mask] = 178
    trans[~mask] = 0
    outs = {k: '%s_%s.png' % (base, k) for k in ('normal', 'roughness', 'translucency')}
    write_png(outs['normal'], normal)
    write_png(outs['roughness'], rough)
    write_png(outs['translucency'], trans)
    print('leaf maps from %s (strength %s, blur %s):' % (os.path.basename(height), strength, blur_sigma))
    print('  -> %s_normal.png, _roughness.png, _translucency.png' % os.path.basename(base))
    return outs


# ---- derive-leaf-roughness ---------------------------------------------------------------

def derive_leaf_roughness(albedo, translucency, gloss=0.40, matte=0.90):
    """rough = matte - (matte - gloss) x translucency (glossy blade, matte veins); 0.7
    outside the alpha. Writes <stem>_roughness.png."""
    out = _stem(albedo) + '_roughness.png'
    a = read_image(albedo, ensure_alpha=True)
    H, W = a.shape[:2]
    t = resize(read_image(translucency, ensure_alpha=True), W, H, fit='fill')[..., 0].astype(np.float64) / 255
    rough = _u8(js_round(np.clip(matte - (matte - gloss) * t, 0, 1) * 255))
    rough[_alpha(a) < 16] = 178
    write_png(out, rough)
    print('leaf roughness -> %s  (gloss %s blade / matte %s veins)' % (os.path.basename(out), gloss, matte))
    return out


# ---- derive-cactus-bark -------------------------------------------------------------------

def derive_cactus_bark(src, stem, size=1024, strength=1.4):
    """Waxy saguaro skin set: the albedo resized to size, a subtle wrap-tiled Scharr normal
    of its (gamma 2.2) luminance and a tight 0.38..0.52 roughness."""
    alb = resize(read_image(src), int(size), int(size), fit='fill')
    write_png(stem + '_albedo.png', alb)
    data = read_image(stem + '_albedo.png', remove_alpha=True)
    H, W = data.shape[:2]
    r, g, b = (c / 255 for c in _rgb(data))
    lum = _f32(np.power(0.2126 * r + 0.7152 * g + 0.0722 * b, 2.2))
    gx, gy = _scharr(lum, _wrap_shift)
    normal = _encode_normal(-gx * strength, -gy * strength, np.ones_like(gx), in_place=False)
    write_png(stem + '_normal.png', normal)
    rough = _u8(js_round(np.clip(0.38 + 0.14 * (1 - lum), 0, 1) * 255))
    write_png(stem + '_roughness.png', rough)
    print('clean bark: %s_albedo/_normal/_roughness.png  %dx%d  (strength %s)' % (stem, W, H, strength))
    return {k: '%s_%s.png' % (stem, k) for k in ('albedo', 'normal', 'roughness')}


# ---- derive-spine-translucency --------------------------------------------------------------

def _smooth01(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def derive_spine_translucency(input, lo=0.15, hi=0.80, out=None):
    """A clean, mostly white glow mask of the spine (from the alpha cutout, else from
    luminance), contrast-windowed lo..hi, then a 0.8 px smooth."""
    if out is None:
        out = re.sub(r'_albedo\.png$', '_translucency.png', input, flags=re.I) if re.search(r'_albedo\.png$', input, re.I) \
            else re.sub(r'\.png$', '_translucency.png', input, flags=re.I)
    data = read_image(input, ensure_alpha=True)
    H, W = data.shape[:2]
    al = _alpha(data).astype(np.int64)
    use_alpha = (int(al.max()) - int(al.min())) > 24
    if use_alpha:
        m = al / 255
    else:
        r, g, b = _rgb(data)
        m = (0.3 * r + 0.59 * g + 0.11 * b) / 255
    buf = _u8(js_round(_smooth01((m - lo) / (hi - lo)) * 255))
    write_png(out, blur(buf[..., None], 0.8))
    print('spine translucency -> %s  (%dx%d, %s, window %s..%s)' % (
        os.path.basename(out), W, H, 'from alpha' if use_alpha else 'from luminance', lo, hi))
    return out


# ---- derive-thatch-pbr ---------------------------------------------------------------------

def _percentile_f32(values, p):
    s = np.sort(np.asarray(values, np.float32).ravel())
    i = int(js_round(p * (len(s) - 1)))
    return float(s[max(0, min(len(s) - 1, i))])


def _median3_wrap(a):
    win = np.stack([_wrap_shift(a, dx, dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)
    return np.sort(win, axis=0)[4]


def _box_blur_wrap(a, radius):
    """boxBlurWrap: the JS running sums, row by row and column by column (vectorized
    across rows / columns, so every sum takes the JS's exact sequence of additions)."""
    if radius <= 0:
        return a.copy()
    H, W = a.shape
    span = radius * 2 + 1
    a64 = a.astype(np.float64)
    horiz = np.empty((H, W), np.float32)
    s = np.zeros(H)
    for k in range(-radius, radius + 1):
        s = s + a64[:, k % W]
    for x in range(W):
        horiz[:, x] = s / span
        s = s + (a64[:, (x + radius + 1) % W] - a64[:, (x - radius) % W])
    h64 = horiz.astype(np.float64)
    out = np.empty((H, W), np.float32)
    s = np.zeros(W)
    for k in range(-radius, radius + 1):
        s = s + h64[k % H]
    for y in range(H):
        out[y] = s / span
        s = s + (h64[(y + radius + 1) % H] - h64[(y - radius) % H])
    return out


def _gauss_approx(a, radius):
    return _box_blur_wrap(_box_blur_wrap(_box_blur_wrap(a, radius), radius), radius)


def _smoothstep(a, b, v):
    t = np.clip((v - a) / max(1e-9, b - a), 0, 1)
    return t * t * (3 - 2 * t)


def derive_thatch_pbr(albedo, height, out_stem, strength=12.0, height_out=None):
    """The Joshua dead-leaf thatch normal + roughness from a semantic height: robust
    1/99 % normalization, a wrap 3x3 median, a three-scale height (broad + 0.58 mid +
    0.20 fine), a wrap Scharr normal (OpenGL +Y) and a structure-driven roughness."""
    a = read_image(albedo)
    H, W = a.shape[:2]
    os.makedirs(os.path.dirname(os.path.abspath(out_stem)) or '.', exist_ok=True)
    src = resize(read_image(height, greyscale=True), W, H, fit='fill')
    source = (src[..., 0].astype(np.float64) / 255).astype(np.float32)
    lo, hi = _percentile_f32(source, 0.01), _percentile_f32(source, 0.99)
    source = np.clip((source.astype(np.float64) - lo) / max(1e-6, hi - lo), 0, 1).astype(np.float32)
    clean = _median3_wrap(source)
    mid = _gauss_approx(clean, 1)
    broad = _gauss_approx(clean, 5)
    c64, m64, b64 = clean.astype(np.float64), mid.astype(np.float64), broad.astype(np.float64)
    mid_band = m64 - b64
    fine_band = c64 - m64
    hgt = np.clip(b64 + 0.58 * mid_band + 0.20 * fine_band, 0, 1).astype(np.float32)
    fine_mag = np.abs(fine_band).astype(np.float32)
    h64 = hgt.astype(np.float64)
    gx, gy = _scharr(h64, _wrap_shift)
    normal = _encode_normal(-(gx / 32) * strength, (gy / 32) * strength, np.ones_like(gx))
    blo, bhi = _percentile_f32(broad, 0.04), _percentile_f32(broad, 0.96)
    fhi = max(1e-6, _percentile_f32(fine_mag, 0.98))
    bb = np.clip((b64 - blo) / max(1e-6, bhi - blo), 0, 1)
    fiber = _smoothstep(0.18, 0.82, fine_mag.astype(np.float64) / fhi)
    face = np.power(_smoothstep(0.50, 0.86, bb) * (1 - 0.72 * fiber), 1.15)
    recess = 1 - _smoothstep(0.15, 0.46, bb)
    rr = np.clip(0.89 - 0.16 * face + 0.075 * recess + 0.055 * fiber, 0.72, 0.98)
    q = _u8(js_round(rr * 255))
    write_png(out_stem + '_normal.png', normal)
    write_png(out_stem + '_roughness.png', np.stack([q, q, q], axis=2))
    if height_out:
        os.makedirs(os.path.dirname(os.path.abspath(height_out)) or '.', exist_ok=True)
        write_png(height_out, _u8(js_round(h64 * 255)))
    print('semantic thatch PBR: %dx%d, strength %s' % (W, H, strength))
    print('  normal    -> %s_normal.png' % os.path.basename(out_stem))
    print('  roughness -> %s_roughness.png' % os.path.basename(out_stem))
    if height_out:
        print('  height QA -> %s' % os.path.basename(height_out))
    return {'normal': out_stem + '_normal.png', 'roughness': out_stem + '_roughness.png', 'height': height_out}


# ---- make-seamless -----------------------------------------------------------------------

def make_seamless(src, out, h=40, v=22, size=1024):
    """Mirror-blend an h-wide band at the left/right edges and a v-tall band at the
    top/bottom so opposite edges converge (the interior is untouched)."""
    data = resize(read_image(src, remove_alpha=True), int(size), int(size), fit='fill').astype(np.float64)
    H, W = data.shape[:2]
    for x in range(int(h)):
        w = 0.5 * (1 - x / h)
        L, R = data[:, x].copy(), data[:, W - 1 - x].copy()
        data[:, x] = js_round(L * (1 - w) + R * w)
        data[:, W - 1 - x] = js_round(R * (1 - w) + L * w)
    for y in range(int(v)):
        w = 0.5 * (1 - y / v)
        T, B = data[y].copy(), data[H - 1 - y].copy()
        data[y] = js_round(T * (1 - w) + B * w)
        data[H - 1 - y] = js_round(B * (1 - w) + T * w)
    write_png(out, _u8(data))
    print('seamless -> %s  (edge blend h%d/v%d)' % (out, h, v))
    return out


# ---- dilate-alpha -------------------------------------------------------------------------

def dilate_alpha(input, passes=20, out=None):
    """Flood the opaque edge colours (alpha > 12) outward, 8-neighbour average per pass,
    RGB only; the alpha is kept. Overwrites the input (or writes `out`)."""
    data = read_image(input, ensure_alpha=True)
    H, W = data.shape[:2]
    r, g, b = _rgb(data)
    rgb = np.stack([r, g, b], axis=2).astype(np.float32)
    alpha = _alpha(data).copy()
    filled = alpha > 12
    for _ in range(int(passes)):
        pad_f = np.pad(filled, 1)
        pad_c = np.pad(rgb.astype(np.float64), ((1, 1), (1, 1), (0, 0)))
        s = np.zeros((H, W, 3))
        n = np.zeros((H, W))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                f = pad_f[1 + dy:1 + dy + H, 1 + dx:1 + dx + W]
                s = s + np.where(f[..., None], pad_c[1 + dy:1 + dy + H, 1 + dx:1 + dx + W], 0.0)
                n = n + f
        new = (~filled) & (n > 0)
        if not new.any():
            break
        rgb[new] = (s[new] / n[new][:, None]).astype(np.float32)
        filled = filled | new
    out_arr = np.empty((H, W, 4), np.uint8)
    out_arr[..., :3] = np.trunc(rgb).astype(np.int64) % 256
    out_arr[..., 3] = alpha
    target = out or input
    write_png(target, out_arr)
    print('dilated (%d passes) -> %s  %dx%d' % (passes, os.path.basename(target), W, H))
    return target


# ---- apply-alpha ----------------------------------------------------------------------------

def apply_alpha(codex_out, original, out, gray=False, despill=False):
    """Weld a generated image's RGB (resized to the original) onto the original cutout's
    alpha; gray collapses it to luminance, despill clamps R and B to G (magenta cast)."""
    o = read_image(original, ensure_alpha=True)
    H, W = o.shape[:2]
    alpha = _alpha(o)
    # sharp converts to greyscale before it resizes
    rgb = resize(read_image(codex_out, remove_alpha=True, greyscale=gray), W, H, fit='fill')
    if rgb.shape[2] >= 3:
        r, g, b = (rgb[..., i].astype(np.int64) for i in range(3))
    else:
        r = g = b = rgb[..., 0].astype(np.int64)
    if despill:
        r = np.where(r > g, g, r)
        b = np.where(b > g, g, b)
    merged = np.stack([r, g, b, alpha.astype(np.int64)], axis=2).astype(np.uint8)
    write_png(out, merged)
    print('apply-alpha -> %s  (%dx%d, gray=%s, alpha from %s)' % (os.path.basename(out), W, H, gray, os.path.basename(original)))
    return out


# ---- chroma-key -------------------------------------------------------------------------------

def chroma_key(input, out=None, lo=60.0, hi=150.0):
    """Key a flat magenta background to transparency (keyness = (r + b)/2 - g, smooth
    lo..hi) and despill every pixel (R halfway, B a fifth of the way to G)."""
    out = out or input
    data = read_image(input, ensure_alpha=True).copy()
    H, W = data.shape[:2]
    r, g, b = (data[..., i].astype(np.float64) for i in range(3))
    keyness = (r + b) / 2 - g
    t = np.clip((keyness - lo) / (hi - lo), 0, 1)
    a = 1 - t * t * (3 - 2 * t)
    data[..., 3] = _u8(js_round(a * 255))
    data[..., 0] = np.where(r > g, _u8(js_round(g + (r - g) * 0.5)), data[..., 0])
    data[..., 2] = np.where(b > g, _u8(js_round(g + (b - g) * 0.2)), data[..., 2])
    keyed = int((a < 0.5).sum())
    write_png(out, data)
    cov = round(1 - keyed / (W * H), 3)
    print('{"out":"%s","transparentPixels":%d,"coverage":%s}' % (out.replace('\\', '\\\\'), keyed, cov))
    return {'out': out, 'transparentPixels': keyed, 'coverage': cov}


# ---- denoise ----------------------------------------------------------------------------------

def denoise(input, median_n=5, blur_sigma=0, out=None):
    """Edge-preserving speckle removal: an n x n median (+ an optional light blur).
    Overwrites the input (or writes `out`)."""
    a = read_image(input)
    if blur_sigma > 0 and a.shape[2] in (2, 4):
        # sharp premultiplies once for the whole pipeline when a blur is in it: the median
        # then runs on premultiplied colour too
        a = unpremultiply(_blur_core(median(premultiply(a), int(median_n)), blur_sigma))
    else:
        a = median(a, int(median_n))
        if blur_sigma > 0:
            a = blur(a, blur_sigma)
    target = out or input
    write_png(target, a)
    print('denoised (median %d%s) -> %s' % (median_n, (', blur %s' % blur_sigma) if blur_sigma else '', os.path.basename(target)))
    return target


# ---- check-tile / tile-preview ---------------------------------------------------------------

def check_tile(input, preview=None):
    """Seam error (wrapping columns / rows) against the interior's adjacent-pixel
    variation; PASS under 2x. Writes the 50 %-rolled preview (<name>.offset.png).
    -> {'seamX', 'seamY', 'baseX', 'baseY', 'ratioX', 'ratioY', 'pass', 'preview'}"""
    preview = preview or re.sub(r'\.png$', '.offset.png', input, flags=re.I)
    data = read_image(input, ensure_alpha=True)
    H, W, C = data.shape
    d = data.astype(np.int64)

    def col_diff(x0, x1):
        return float(np.abs(d[:, x0, :3] - d[:, x1, :3]).sum()) / (H * 3)

    def row_diff(y0, y1):
        return float(np.abs(d[y0, :, :3] - d[y1, :, :3]).sum()) / (W * 3)

    seam_x, seam_y = col_diff(W - 1, 0), row_diff(H - 1, 0)
    bx = by = 0.0
    n = 0
    f = 0.1
    while f < 0.9:
        bx += col_diff(int(math.floor(W * f)), int(math.floor(W * f)) + 1)
        by += row_diff(int(math.floor(H * f)), int(math.floor(H * f)) + 1)
        n += 1
        f += 0.1
    bx /= n
    by /= n
    rx, ry = seam_x / bx, seam_y / by
    ok = rx < 2.0 and ry < 2.0
    print('image:        %s  %dx%d  %dch' % (os.path.basename(input), W, H, C))
    print('seam X (L|R): %.2f  vs interior %.2f  -> %.2fx' % (seam_x, bx, rx))
    print('seam Y (T|B): %.2f  vs interior %.2f  -> %.2fx' % (seam_y, by, ry))
    print('verdict:      %s' % ('PASS (tiles cleanly)' if ok else 'FAIL (visible seam)'))
    shifted = np.roll(np.roll(data, -(H >> 1), axis=0), -(W >> 1), axis=1)
    write_png(preview, shifted)
    print('offset preview -> %s' % os.path.basename(preview))
    return {'seamX': seam_x, 'seamY': seam_y, 'baseX': bx, 'baseY': by, 'ratioX': rx, 'ratioY': ry, 'pass': ok,
            'preview': preview}


def tile_preview(src, out):
    """The image downscaled to 512 and tiled 2 x 2 on a 1024 black canvas."""
    t = resize(read_image(src), 512, 512, fit='fill')
    has_alpha = t.shape[2] in (2, 4)
    if has_alpha:      # composited over the black canvas; the result carries an opaque alpha
        al = t[..., -1:].astype(np.float64) / 255
        t = _u8(js_round(t[..., :-1].astype(np.float64) * al))
    if t.shape[2] == 1:
        t = np.repeat(t, 3, axis=2)
    if has_alpha:
        t = np.concatenate([t, np.full(t.shape[:2] + (1,), 255, np.uint8)], axis=2)
    canvas = np.zeros((1024, 1024, t.shape[2]), np.uint8)
    for y0 in (0, 512):
        for x0 in (0, 512):
            canvas[y0:y0 + 512, x0:x0 + 512] = t
    write_png(out, canvas)
    print('tiled 2x2 -> %s' % out)
    return out


# ---- make-bark-guide / make-yucca-alpha --------------------------------------------------------

def make_bark_guide(src, out):
    """Magenta guide columns (55 %, 7 px) at the saguaro rib crests U = 0.125 / 0.375 /
    0.625 / 0.875 over the bark resized to 1024."""
    data = resize(read_image(src, remove_alpha=True), 1024, 1024, fit='fill').astype(np.float64)
    H, W = data.shape[:2]
    cols = [int(js_round(f * W)) for f in (0.125, 0.375, 0.625, 0.875)]
    mag = np.array([236, 64, 220], np.float64)[:data.shape[2]]
    a = 0.55
    for cx in cols:
        for dx in range(-3, 4):
            x = cx + dx
            if 0 <= x < W:
                data[:, x] = js_round(data[:, x] * (1 - a) + mag * a)
    write_png(out, _u8(data))
    print('guide -> %s lines at x= %s' % (out, ','.join(str(c) for c in cols)))
    return out


def _hash01(n):
    s = math.sin(n * 12.9898) * 43758.5453
    return s - math.floor(s)


def make_yucca_alpha(path, out=None):
    """The frayed-strand spike alpha for the yucca leaf atlas (living | dead halves):
    an opaque core tapering to the blade edges, each fibre column cut at its own hashed
    height in the top 35 %, and fibre gaps near the tip. Writes the alpha in place."""
    data = read_image(path, ensure_alpha=True).copy()
    if data.shape[2] != 4:
        data = np.concatenate([np.repeat(data[..., :1], 3, axis=2), data[..., -1:]], axis=2)
    H, W = data.shape[:2]
    x = np.arange(W, dtype=np.float64)
    half = np.where(x < W / 2, 0, 1)
    u = (x - half * (W / 2)) / (W / 2 - 1)
    edge = np.minimum(u, 1 - u) * 2
    a_col = np.minimum(1, edge / 0.28)
    strand = np.array([_hash01(math.floor(xi * 0.7) + hh * 991) for xi, hh in zip(x, half)])
    fray = 0.65 + 0.35 * strand
    gap = np.array([_hash01(xi * 2.3 + 17) for xi in x]) > 0.93
    v = (np.arange(H, dtype=np.float64) / (H - 1))[:, None]
    a = np.broadcast_to(a_col, (H, W)).copy()
    cut = v > fray[None, :]
    a = np.where(cut, a * np.maximum(0, 1 - (v - fray[None, :]) / (1 - fray[None, :]) * 1.6), a)
    a = np.where((v > 0.5) & gap[None, :], a * 0.15, a)
    data[..., 3] = _u8(js_round(np.clip(a, 0, 1) * 255))
    target = out or path
    write_png(target, data)
    print('alpha written into %s (%dx%d, frayed-strand spike mask)' % (target, W, H))
    return target


# ---- command lines (the scripts' own) ---------------------------------------------------------

def _flag(args, name, default, cast=float):
    if name in args:
        i = args.index(name)
        return cast(args[i + 1])
    return default


def _pos(args):
    out, skip = [], False
    for i, a in enumerate(args):
        if skip:
            skip = False
            continue
        if a.startswith('--'):
            skip = a not in ('--gray', '--despill', '--list')
            continue
        out.append(a)
    return out


def _usage(msg):
    print(msg)
    return 2


def cli_derive_pbr(args):
    p = _pos(args)
    if not p:
        return _usage('usage: derive-pbr <albedo.png> [--strength N]')
    derive_pbr(p[0], _flag(args, '--strength', 2.5))


def cli_derive_height(args):
    p = _pos(args)
    if not p:
        return _usage('usage: derive-height <normal.png> [out.png]')
    derive_height(p[0], p[1] if len(p) > 1 else None)


def cli_derive_translucency(args):
    p = _pos(args)
    if not p:
        return _usage('usage: derive-translucency <leaf.png> [--tissue 0.85] [--vein 6]')
    derive_translucency(p[0], _flag(args, '--tissue', 0.85), _flag(args, '--vein', 6.0))


def cli_derive_leaf_maps(args):
    p = _pos(args)
    if len(p) < 2:
        return _usage('usage: derive-leaf-maps <albedo.png> <height.png> [--strength N] [--blur N]')
    derive_leaf_maps(p[0], p[1], _flag(args, '--strength', 6.0), _flag(args, '--blur', 1.5))


def cli_derive_leaf_roughness(args):
    p = _pos(args)
    if len(p) < 2:
        return _usage('usage: derive-leaf-roughness <albedo.png> <translucency.png> [--gloss N] [--matte N]')
    derive_leaf_roughness(p[0], p[1], _flag(args, '--gloss', 0.40), _flag(args, '--matte', 0.90))


def cli_derive_cactus_bark(args):
    p = _pos(args)
    if len(p) < 2:
        return _usage('usage: derive-cactus-bark <src> <out_stem> [--size N] [--strength N]')
    derive_cactus_bark(p[0], p[1], _flag(args, '--size', 1024, int), _flag(args, '--strength', 1.4))


def cli_derive_spine_translucency(args):
    p = _pos(args)
    if not p:
        return _usage('usage: derive-spine-translucency <spine_albedo.png> [--lo 0.15] [--hi 0.8] [--out <path>]')
    derive_spine_translucency(p[0], _flag(args, '--lo', 0.15), _flag(args, '--hi', 0.80), _flag(args, '--out', None, str))


def cli_derive_thatch_pbr(args):
    p = _pos(args)
    if len(p) < 3:
        return _usage('usage: derive-thatch-pbr <albedo.png> <height.png> <out-stem> [--strength N] [--height-out out.png]')
    derive_thatch_pbr(p[0], p[1], p[2], _flag(args, '--strength', 12.0), _flag(args, '--height-out', None, str))


def cli_make_seamless(args):
    p = _pos(args)
    if len(p) < 2:
        return _usage('usage: make-seamless <in> <out> [--h 40] [--v 22] [--size 1024]')
    make_seamless(p[0], p[1], _flag(args, '--h', 40, int), _flag(args, '--v', 22, int), _flag(args, '--size', 1024, int))


def cli_dilate_alpha(args):
    p = _pos(args)
    if not p:
        return _usage('usage: dilate-alpha <cutout.png> [--passes N]')
    dilate_alpha(p[0], _flag(args, '--passes', 20, int))


def cli_apply_alpha(args):
    p = _pos(args)
    if len(p) < 3:
        return _usage('usage: apply-alpha <codexOut.png> <original.png> <out.png> [--gray] [--despill]')
    apply_alpha(p[0], p[1], p[2], '--gray' in args, '--despill' in args)


def cli_chroma_key(args):
    p = _pos(args)
    if not p:
        return _usage('usage: chroma-key <in.png> [out.png] [--lo N --hi N]')
    chroma_key(p[0], p[1] if len(p) > 1 else None, _flag(args, '--lo', 60.0), _flag(args, '--hi', 150.0))


def cli_denoise(args):
    p = _pos(args)
    if not p:
        return _usage('usage: denoise <map.png> [--median N] [--blur N]')
    denoise(p[0], _flag(args, '--median', 5, int), _flag(args, '--blur', 0.0))


def cli_check_tile(args):
    p = _pos(args)
    if not p:
        return _usage('usage: check-tile <image.png> [--preview out.png]')
    return 0 if check_tile(p[0], _flag(args, '--preview', None, str))['pass'] else 1


def cli_tile_preview(args):
    p = _pos(args)
    if len(p) < 2:
        return _usage('usage: tile-preview <img> <out.png>')
    tile_preview(p[0], p[1])


def cli_make_bark_guide(args):
    p = _pos(args)
    if len(p) < 2:
        return _usage('usage: make-bark-guide <src> <out.png>')
    make_bark_guide(p[0], p[1])


def cli_make_yucca_alpha(args):
    p = _pos(args)
    make_yucca_alpha(p[0] if p else 'assets/leaves/yucca_leaf_albedo.png')
