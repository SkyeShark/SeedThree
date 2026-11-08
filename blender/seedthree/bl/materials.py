"""SeedThree's materials rebuilt as EEVEE node trees (the JS ones are WebGPU TSL).

  bark      Principled: albedo (sRGB) x Bark tint, tangent normal map, roughness
            from the map's G channel (three's convention), metallic 0.
  cactus    clean <-> damaged skin blended by mx_fractal_noise_float (3 octaves)
            of the world position in three's axes x 0.55 + the seed offset,
            m = 0.5 n + 0.5 against the Bark-damage threshold: the JS mask, value
            for value (Blender's Perlin is MaterialX's: same hash, gradients,
            fade and 0.982 scale). Plus the ivory crest tint from fract(u * ribsPerTile).
  leaves    texture x species tint (linear), luminance-preserving colorize (Leaf
            tint + amount), alpha clip at the Leaf-alpha dial, canopy DOME normal
            normalize(normalize(dome) + 0.9 x the normal map's relief), dome =
            normalize(p - c) + 0.45 up (stored per vertex), and the JS backlight.
  rosette   Joshua fronds: green -> dry (age .42-.6) -> driest (.6-.92) texture
            ramp with per-stage tints and Frond dryness, dim backlight.
  spines    saguaro areole cards, gold backlight.

Backlight: three's MeshSSSNodeMaterial (Barre-Brisebois) term against the sun
bound in bl/sun.py, with each JS material's own constants (leaves: distortion
0.3, ambient 0.16, power 6, scale 3; fronds 0.2/0.03/8/1.2; spines
0.35/0.03/5/2.5). It is a Translucent BSDF on the material's own shading normal
with colour pi x (saturate(V . -H)^power x scale + ambient) x thicknessColor, on
a card of Thickness 0: EEVEE answers that x E x max(0, -N.L) x the sun's shadow
(bl/sun.py has the measurements behind each choice).

Every dial of the app's material folder is applied here (the JS API only applies
them inside the app: bug (b)).
"""

import hashlib
import json
import math
import os

import bpy

from .. import api as _api   # _api.ASSETS_DIR is read at call time (the add-on preference can move it)
from .sun import sun_group

# three's MeshSSSNodeMaterial constants per JS material: (distortion, ambient, power, scale)
BB_LEAVES = (0.3, 0.16, 6.0, 3.0)      # leaf-cards.js makeFoliageMaterial
BB_FRONDS = (0.2, 0.03, 8.0, 1.2)      # yucca-leaves.js makeYuccaMaterial
BB_SPINES = (0.35, 0.03, 5.0, 2.5)     # cactus-spines.js
# The translucent cards' Material Output Thickness (metres). 0: a thin sheet, shadowed by any
# occluder, but EEVEE self-shadows cards whose plane is near the sun direction. Above 0: occluders
# closer than this are skipped (like three's shadow bias), grazing cards keep more glow, and
# the colour is fed as its square root (EEVEE answers colour^2 for a slab).
SLAB = 0.0
# How the backlight reaches EEVEE (set_backlight): 'translucent' (a Translucent BSDF on the
# shading normal: the JS term x the leaf's Lambert factor max(0, -N.L)) or 'glow' (the JS term
# itself, orientation-free: the sun's shadowed light read through Shader to RGB, added as
# emission; the silhouette keeps glowing). Materials are keyed by the mode.
BACKLIGHT = 'translucent'
BACKLIGHT_MODES = ('translucent', 'glow')


def set_backlight(mode):
    """The backlight route for materials built from now on: 'translucent' or 'glow'."""
    global BACKLIGHT
    if mode not in BACKLIGHT_MODES:
        raise ValueError('[seedthree] backlight mode %r: one of %s' % (mode, ', '.join(BACKLIGHT_MODES)))
    BACKLIGHT = mode
    return mode


def srgb_to_linear_hex(h):
    r, g, b = ((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b))


def _lum(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def _image(path, non_color):
    if not path or not os.path.isfile(path):
        return None
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    if not non_color:
        img.alpha_mode = 'STRAIGHT'
    return img


def _maps(sub, file, extra=()):
    """albedo/normal/roughness(/translucency) paths, named like main.js loadSpeciesAssets."""
    base = file[:-len('_albedo.png')] if file.endswith('_albedo.png') else file[:-4]
    d = os.path.join(_api.ASSETS_DIR, sub)
    out = {'albedo': os.path.join(d, file), 'normal': os.path.join(d, base + '_normal.png'),
           'roughness': os.path.join(d, base + '_roughness.png'), 'base': base}
    for e in extra:
        out[e] = os.path.join(d, '%s_%s.png' % (base, e))
    return out


_VERSION = 3   # bump when a node tree changes, so a saved file's older material is not reused


def _key(*parts):
    mode = (BACKLIGHT,) if BACKLIGHT != 'translucent' else ()   # the default keeps round one's keys
    return hashlib.sha1(json.dumps((_VERSION, SLAB) + mode + parts, sort_keys=True, default=str).encode()).hexdigest()[:12]


def _find(key):
    for m in bpy.data.materials:
        if m.get('st_key') == key:
            return m
    return None


class _G:
    """Tiny node-graph helper."""

    def __init__(self, mat):
        mat.use_nodes = True
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.x = 0

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        n.location = (self.x, 0)
        self.x += 40
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def tex(self, img):
        n = self.node('ShaderNodeTexImage')
        n.image = img
        return n

    def math(self, op, a=None, b=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs[0]

    def vmath(self, op, a=None, b=None, scale=None):
        n = self.node('ShaderNodeVectorMath', operation=op)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (tuple, list)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        if scale is not None:
            if isinstance(scale, (int, float)):
                n.inputs['Scale'].default_value = scale
            else:
                self.link(scale, n.inputs['Scale'])
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def mix_rgb(self, a, b, fac, blend='MIX', clamp=False):
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=clamp)
        for sock, v in ((n.inputs[6], a), (n.inputs[7], b)):
            if isinstance(v, (tuple, list)):
                sock.default_value = tuple(v) + ((1.0,) if len(v) == 3 else ())
            else:
                self.link(v, sock)
        if isinstance(fac, (int, float)):
            n.inputs[0].default_value = fac
        else:
            self.link(fac, n.inputs[0])
        return n.outputs[2]

    def smoothstep(self, x, lo, hi):
        n = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
        n.inputs['From Min'].default_value = lo
        n.inputs['From Max'].default_value = hi
        if isinstance(x, (int, float)):
            n.inputs['Value'].default_value = x
        else:
            self.link(x, n.inputs['Value'])
        return n.outputs['Result']

    def attr(self, name, kind='GEOMETRY'):
        n = self.node('ShaderNodeAttribute', attribute_name=name, attribute_type=kind)
        return n

    def channel(self, color_out, idx):
        n = self.node('ShaderNodeSeparateColor')
        self.link(color_out, n.inputs[0])
        return n.outputs[idx]

    def normal_map(self, img, strength=1.0):
        if img is None:
            return None
        t = self.tex(img)
        nm = self.node('ShaderNodeNormalMap', space='TANGENT', uv_map='UVMap')
        nm.inputs['Strength'].default_value = strength
        self.link(t.outputs['Color'], nm.inputs['Color'])
        return nm.outputs['Normal']

    def backlight(self, transmit, amount, n, consts, slab):
        """three's SSS (Barre-Brisebois) term against the bound sun, as a Translucent BSDF.
        thicknessColor = transmit (constant RGB) x amount (scalar socket, or None for 1);
        n: the material's shading normal, shared with its Principled BSDF (None = geometry
        normal); consts: (distortion, ambient, power, scale); slab: the material's
        Thickness (see _settings). Returns the BSDF output.

        The Translucent BSDF MUST use the diffuse's normal: EEVEE 5.2 keeps one
        diffuse-type closure per pixel, and with two different normals the Principled
        diffuse is dropped (measured: the sunlit side goes black)."""
        distortion, ambient, power, scale = consts
        sun = self.node('ShaderNodeGroup')
        sun.node_tree = sun_group()
        L = sun.outputs[0]
        geo = self.node('ShaderNodeNewGeometry')
        if n is None:
            n = geo.outputs['Normal']
        h = self.vmath('MULTIPLY_ADD', n, (distortion, distortion, distortion))
        self.link(L, h.node.inputs[2])                       # L + N x distortion
        h = self.vmath('NORMALIZE', h)
        vh = self.vmath('DOT_PRODUCT', geo.outputs['Incoming'], h)
        s = self.math('MULTIPLY', vh, -1.0, clamp=True)       # saturate(dot(V, -H))
        k = self.math('ADD', self.math('MULTIPLY', self.math('POWER', s, float(power)), float(scale)), float(ambient))
        k = self.math('MULTIPLY', k, math.pi)                 # the Translucent BSDF divides by pi
        if amount is not None:
            k = self.math('MULTIPLY', k, amount)
        if BACKLIGHT == 'glow':
            # The JS term has no Lambert factor: glow = k x tcol x E x shadow. A white Diffuse BSDF
            # whose normal points AT the sun is lit E x shadow / pi (plus the sky around the sun);
            # Shader to RGB reads that light and the glow joins as emission, so no second
            # diffuse-type closure competes with the leaf's own (which made EEVEE drop it).
            dif = self.node('ShaderNodeBsdfDiffuse')
            dif.inputs['Color'].default_value = (1.0, 1.0, 1.0, 1.0)
            self.link(L, dif.inputs['Normal'])
            s2r = self.node('ShaderNodeShaderToRGB')
            self.link(dif.outputs[0], s2r.inputs[0])
            col = self.vmath('SCALE', tuple(transmit), None, scale=k)
            glow = self.vmath('MULTIPLY', s2r.outputs['Color'], col)
            em = self.node('ShaderNodeEmission')
            em.inputs['Strength'].default_value = 1.0
            self.link(glow, em.inputs['Color'])
            return em.outputs[0]
        rgb = tuple(transmit)
        if slab > 0:
            # with a Thickness above 0 EEVEE answers colour^2 (the slab's two faces): feed the root
            k = self.math('SQRT', k)
            rgb = tuple(math.sqrt(c) for c in rgb)
        col = self.vmath('SCALE', rgb, None, scale=k)
        tl = self.node('ShaderNodeBsdfTranslucent')
        self.link(col, tl.inputs['Color'])
        self.link(n, tl.inputs['Normal'])   # the sun arrives x max(0, -N.L): Lambert transmission
        return tl.outputs[0]


def _settings(mat, alpha=False, translucent=False, thickness=0.0):
    mat.use_backface_culling = False
    try:
        mat.surface_render_method = 'DITHERED'
    except (AttributeError, TypeError):
        pass
    for attr, val in (('use_transparent_shadow', True),):
        if hasattr(mat, attr):
            setattr(mat, attr, val)
    if translucent:
        if hasattr(mat, 'thickness_mode'):
            mat.thickness_mode = 'SLAB'
        if hasattr(mat, 'use_thickness_from_shadow'):
            mat.use_thickness_from_shadow = False
        # The Thickness is always linked (measured in backlight_check.py and the README):
        #  - unlinked, EEVEE takes about the OBJECT's size, so a canopy's own leaves never shadow
        #    its transmission, and it answers colour^2 x E / pi;
        #  - 0 is a thin sheet: colour x E / pi, shadowed by every occluder;
        #  - t > 0 skips occluders closer than t and answers colour^2 x E / pi.
        out = next((n for n in mat.node_tree.nodes if n.type == 'OUTPUT_MATERIAL'), None)
        if out is not None and 'Thickness' in out.inputs and not out.inputs['Thickness'].is_linked:
            val = mat.node_tree.nodes.new('ShaderNodeValue')
            val.name = val.label = 'Card thickness'
            val.outputs[0].default_value = float(thickness)
            mat.node_tree.links.new(val.outputs[0], out.inputs['Thickness'])


def bark_material(species, controls, flat=False):
    tint = controls.get('barkTint', 0xffffff)
    tint = 0xffffff if tint is None else int(tint)
    m = _maps('bark', species['bark'])
    key = _key('bark', species['name'], tint, bool(controls.get('barkFlat')))
    mat = _find(key)
    if mat:
        return mat
    mat = bpy.data.materials.new('ST %s bark' % species['name'])
    mat['st_key'] = key
    g = _G(mat)
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    out = g.node('ShaderNodeOutputMaterial')
    g.link(bsdf.outputs[0], out.inputs['Surface'])
    alb = _image(m['albedo'], False)
    if alb:
        t = g.tex(alb)
        col = g.mix_rgb(t.outputs['Color'], srgb_to_linear_hex(tint), 1.0, 'MULTIPLY')
        g.link(col, bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = (0.15, 0.09, 0.05, 1)
    rimg = _image(m['roughness'], True)
    if rimg:
        g.link(g.channel(g.tex(rimg).outputs['Color'], 1), bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 0.92
    nimg = _image(m['normal'], True)
    if nimg:
        g.link(g.normal_map(nimg), bsdf.inputs['Normal'])
    bsdf.inputs['Metallic'].default_value = 0.0
    _settings(mat)
    return mat


def cactus_bark_material(species, controls, seed):
    tint = int(controls.get('barkTint') or 0xffffff)
    damage = controls.get('barkDamage')
    damage = species.get('barkDamage', 0.35) if damage is None else damage
    rpt = max(1, species['params'].get('ribsPerTile') or 4)
    import math
    h = abs(math.sin((float(seed) or 0) * 12.9898) * 43758.5453)
    seed_off = (h % 10, (h * 1.37) % 10, (h * 2.71) % 10)
    key = _key('cactus', species['name'], tint, damage, rpt, seed_off)
    mat = _find(key)
    if mat:
        return mat
    dm = _maps('bark', species['bark'])
    clean_base = dm['base'][:-len('_skin')] + '_skin_clean' if dm['base'].endswith('_skin') else dm['base'] + '_clean'
    cm = _maps('bark', clean_base + '_albedo.png')
    mat = bpy.data.materials.new('ST %s skin' % species['name'])
    mat['st_key'] = key
    g = _G(mat)
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    out = g.node('ShaderNodeOutputMaterial')
    g.link(bsdf.outputs[0], out.inputs['Surface'])
    dA, cA = _image(dm['albedo'], False), _image(cm['albedo'], False)
    dR, cR = _image(dm['roughness'], True), _image(cm['roughness'], True)
    nimg = _image(cm['normal'], True) or _image(dm['normal'], True)
    # n = mx_fractal_noise_float(positionWorld x 0.55 + seed, 3, 2, 0.5); positionWorld in
    # three's axes (X, Z, -Y), so the scars land where the app puts them.
    geo = g.node('ShaderNodeNewGeometry')
    sep = g.node('ShaderNodeSeparateXYZ')
    g.link(geo.outputs['Position'], sep.inputs[0])
    p3 = g.node('ShaderNodeCombineXYZ')
    g.link(sep.outputs['X'], p3.inputs[0])
    g.link(sep.outputs['Z'], p3.inputs[1])
    g.link(g.math('MULTIPLY', sep.outputs['Y'], -1.0), p3.inputs[2])
    p = g.vmath('MULTIPLY_ADD', p3.outputs[0], (0.55, 0.55, 0.55))
    p.node.inputs[2].default_value = seed_off
    noise = g.node('ShaderNodeTexNoise', noise_dimensions='3D', noise_type='FBM', normalize=False)
    noise.inputs['Scale'].default_value = 1.0
    noise.inputs['Detail'].default_value = 2.0      # octaves 0..2 = 3
    noise.inputs['Roughness'].default_value = 0.5
    noise.inputs['Lacunarity'].default_value = 2.0
    noise.inputs['Distortion'].default_value = 0.0
    g.link(p, noise.inputs['Vector'])
    m = g.math('ADD', g.math('MULTIPLY', noise.outputs['Fac'], 0.5), 0.5)   # Normalize off: Fac is the raw octave sum
    t = 1.08 + (-0.08 - 1.08) * damage
    d = g.smoothstep(m, t - 0.18, t + 0.18)
    if cA and dA:
        blended = g.mix_rgb(g.tex(cA).outputs['Color'], g.tex(dA).outputs['Color'], d)
    else:
        blended = g.tex(dA or cA).outputs['Color']
    uvn = g.node('ShaderNodeUVMap', uv_map='UVMap')
    u = g.node('ShaderNodeSeparateXYZ')
    g.link(uvn.outputs['UV'], u.inputs[0])
    fr = g.math('FRACT', g.math('MULTIPLY', u.outputs['X'], float(rpt)))
    tri = g.math('SUBTRACT', 1.0, g.math('MULTIPLY', g.math('ABSOLUTE', g.math('SUBTRACT', fr, 0.5)), 2.0))
    crest = g.math('MULTIPLY', g.smoothstep(tri, 0.62, 0.92), 0.45)
    lifted = g.vmath('MULTIPLY_ADD', blended, (1.18, 1.15, 1.02))
    lifted.node.inputs[2].default_value = (0.06, 0.055, 0.04)
    col = g.mix_rgb(blended, lifted, crest)
    col = g.mix_rgb(col, srgb_to_linear_hex(tint), 1.0, 'MULTIPLY')
    g.link(col, bsdf.inputs['Base Color'])
    if cR and dR:
        r = g.mix_rgb(g.tex(cR).outputs['Color'], g.tex(dR).outputs['Color'], d)
        g.link(g.channel(r, 1), bsdf.inputs['Roughness'])
    if nimg:
        g.link(g.normal_map(nimg), bsdf.inputs['Normal'])
    _settings(mat)
    return mat


def leaf_material(species, controls, mode='leaves'):
    fol = species.get('foliage') or {}
    tint = fol.get('tint', 0x88a24a)
    colorize = int(controls.get('leafColorize') or 0xffffff) if controls.get('leafColorize') is not None else 0xffffff
    amount = float(controls.get('leafTintAmount') or 0)
    alpha = controls.get('leafAlpha')
    alpha = fol.get('alphaTest', 0.4) if alpha is None else alpha
    transmit = tuple(fol.get('transmit') or (0.42, 0.62, 0.24))
    key = _key('leaf', species['name'], species['leaf'], tint, colorize, amount, alpha, transmit, mode)
    mat = _find(key)
    if mat:
        return mat
    m = _maps('leaves', species['leaf'], ('translucency',))
    mat = bpy.data.materials.new('ST %s %s' % (species['name'], 'sprays' if mode == 'clusters' else 'leaves'))
    mat['st_key'] = key
    g = _G(mat)
    out = g.node('ShaderNodeOutputMaterial')
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    alb = _image(m['albedo'], False)
    tex = g.tex(alb) if alb else None
    tint_lin = srgb_to_linear_hex(tint)
    if tex:
        base = g.mix_rgb(tex.outputs['Color'], tint_lin, 1.0, 'MULTIPLY')
        if amount > 0:
            cl = srgb_to_linear_hex(colorize)
            lum = g.vmath('DOT_PRODUCT', base, (0.2126, 0.7152, 0.0722))
            k = g.math('DIVIDE', lum, max(_lum(cl), 0.08))
            rec = g.vmath('SCALE', cl, None, scale=k)
            rec = g.vmath('MINIMUM', rec, (1.0, 1.0, 1.0))
            base = g.mix_rgb(base, rec, amount)
        g.link(base, bsdf.inputs['Base Color'])
        keep = g.math('GREATER_THAN', tex.outputs['Alpha'], float(alpha))
    else:
        bsdf.inputs['Base Color'].default_value = (0.1, 0.2, 0.05, 1)
        keep = None
    rimg = _image(m['roughness'], True)
    if rimg:
        g.link(g.channel(g.tex(rimg).outputs['Color'], 1), bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 0.82
    # canopy dome normal + the normal map's relief (card orientation contributes nothing):
    # normalize(normalize(dome) + 0.9 x relief), as leaf-cards.js
    dome = g.attr('st_dome')
    vt = g.node('ShaderNodeVectorTransform', vector_type='VECTOR', convert_from='OBJECT', convert_to='WORLD')
    g.link(dome.outputs['Vector'], vt.inputs[0])
    n = g.vmath('NORMALIZE', vt.outputs[0])
    nimg = _image(m['normal'], True)
    if nimg:
        geo = g.node('ShaderNodeNewGeometry')
        relief = g.vmath('SUBTRACT', g.normal_map(nimg), geo.outputs['Normal'])
        dome_n = n
        n = g.vmath('MULTIPLY_ADD', relief, (0.9, 0.9, 0.9))
        g.link(dome_n, n.node.inputs[2])
        n = g.vmath('NORMALIZE', n)
    g.link(n, bsdf.inputs['Normal'])
    # backlight: thicknessColor = translucency.r x per-leaf thickness x species transmit
    amount = g.attr('st_thickness').outputs['Fac']
    timg = _image(m.get('translucency'), True)
    if timg:
        amount = g.math('MULTIPLY', amount, g.channel(g.tex(timg).outputs['Color'], 0))
    tl = g.backlight(transmit, amount, n, BB_LEAVES, SLAB)
    add = g.node('ShaderNodeAddShader')
    g.link(bsdf.outputs[0], add.inputs[0])
    g.link(tl, add.inputs[1])
    surf = add.outputs[0]
    if keep is not None:
        tr = g.node('ShaderNodeBsdfTransparent')
        mix = g.node('ShaderNodeMixShader')
        g.link(keep, mix.inputs[0])
        g.link(tr.outputs[0], mix.inputs[1])
        g.link(surf, mix.inputs[2])
        surf = mix.outputs[0]
    g.link(surf, out.inputs['Surface'])
    _settings(mat, alpha=True, translucent=True, thickness=SLAB)
    mat['st_gltf_dt'] = True              # leaf-cards.js userData.gltfDiffuseTransmission
    mat['st_transmit'] = list(transmit)
    return mat


def rosette_material(species, controls):
    green_t = srgb_to_linear_hex(int(controls.get('frondGreenTint') or 0xffffff))
    dry_t = srgb_to_linear_hex(int(controls.get('frondDryTint') or 0xffffff))
    dryest_t = srgb_to_linear_hex(int(controls.get('frondDryestTint') or 0xffffff))
    dryness = float(controls.get('frondDryness') or 0)
    key = _key('rosette', species['name'], green_t, dry_t, dryest_t, dryness)
    mat = _find(key)
    if mat:
        return mat
    m = _maps('leaves', species['leaf'], ('translucency',))
    base = m['base']
    dry_p = os.path.join(_api.ASSETS_DIR, 'leaves', base + '_dry_albedo.png')
    dryest_p = os.path.join(_api.ASSETS_DIR, 'leaves', base + '_dryest_albedo.png')
    mat = bpy.data.materials.new('ST %s fronds' % species['name'])
    mat['st_key'] = key
    g = _G(mat)
    out = g.node('ShaderNodeOutputMaterial')
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    age = g.attr('st_age').outputs['Fac']
    age2 = g.math('ADD', g.math('MULTIPLY', age, 1 - dryness), dryness)
    green = g.tex(_image(m['albedo'], False))
    rgb = g.mix_rgb(green.outputs['Color'], green_t, 1.0, 'MULTIPLY')
    alpha = green.outputs['Alpha']
    dimg, deimg = _image(dry_p, False), _image(dryest_p, False)
    if dimg:
        d = g.tex(dimg)
        t = g.smoothstep(age2, 0.42, 0.6)
        rgb = g.mix_rgb(rgb, g.mix_rgb(d.outputs['Color'], dry_t, 1.0, 'MULTIPLY'), t)
        alpha = g.math('ADD', g.math('MULTIPLY', alpha, g.math('SUBTRACT', 1.0, t)), g.math('MULTIPLY', d.outputs['Alpha'], t))
    if deimg:
        d = g.tex(deimg)
        t = g.smoothstep(age2, 0.6, 0.92)
        rgb = g.mix_rgb(rgb, g.mix_rgb(d.outputs['Color'], dryest_t, 1.0, 'MULTIPLY'), t)
        alpha = g.math('ADD', g.math('MULTIPLY', alpha, g.math('SUBTRACT', 1.0, t)), g.math('MULTIPLY', d.outputs['Alpha'], t))
    g.link(rgb, bsdf.inputs['Base Color'])
    keep = g.math('GREATER_THAN', alpha, 0.4)
    rimg = _image(m['roughness'], True)
    if rimg:
        g.link(g.channel(g.tex(rimg).outputs['Color'], 1), bsdf.inputs['Roughness'])
    nimg = _image(m['normal'], True)
    nrm = g.normal_map(nimg) if nimg else None
    if nrm is not None:
        g.link(nrm, bsdf.inputs['Normal'])
    amount = g.math('ADD', g.math('MULTIPLY', g.attr('st_thickness').outputs['Fac'], 0.5), 0.5)
    timg = _image(m.get('translucency'), True)
    if timg:
        amount = g.math('MULTIPLY', amount, g.channel(g.tex(timg).outputs['Color'], 0))
    tl = g.backlight((0.10, 0.13, 0.03), amount, nrm, BB_FRONDS, SLAB)
    add = g.node('ShaderNodeAddShader')
    g.link(bsdf.outputs[0], add.inputs[0])
    g.link(tl, add.inputs[1])
    tr = g.node('ShaderNodeBsdfTransparent')
    mix = g.node('ShaderNodeMixShader')
    g.link(keep, mix.inputs[0])
    g.link(tr.outputs[0], mix.inputs[1])
    g.link(add.outputs[0], mix.inputs[2])
    g.link(mix.outputs[0], out.inputs['Surface'])
    _settings(mat, alpha=True, translucent=True, thickness=SLAB)
    return mat


def _decode_baked_normal(g, img):
    """A baked world-normal map (three axes, x0.5+0.5) -> a Blender-axes vector socket."""
    t = g.tex(img)
    t.interpolation = 'Linear'
    v = g.vmath('MULTIPLY_ADD', t.outputs['Color'], (2.0, 2.0, 2.0))
    v.node.inputs[2].default_value = (-1.0, -1.0, -1.0)
    sep = g.node('ShaderNodeSeparateXYZ')
    g.link(v, sep.inputs[0])
    cmb = g.node('ShaderNodeCombineXYZ')
    g.link(sep.outputs['X'], cmb.inputs[0])
    g.link(g.math('MULTIPLY', sep.outputs['Z'], -1.0), cmb.inputs[1])
    g.link(sep.outputs['Y'], cmb.inputs[2])
    return cmb.outputs[0]


def card_material(name, imgs, transmit=None, key=None):
    """branch-cards.js makeCardMaterial: the baked albedo / roughness, alpha test 0.35, the
    canopy-dome normal (st_dome, the card set's dome origin) plus 0.45 x the baked
    world-normal detail, normalize(dome + 0.45 detail), and the leaves' backlight with the
    card transmit (0.42, 0.62, 0.24) x baked translucency x per-card thickness."""
    transmit = tuple(transmit or (0.42, 0.62, 0.24))
    mat = bpy.data.materials.new(name)
    if key:
        mat['st_key'] = key
    g = _G(mat)
    out = g.node('ShaderNodeOutputMaterial')
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    alb = g.tex(imgs['albedo'])
    g.link(alb.outputs['Color'], bsdf.inputs['Base Color'])
    keep = g.math('GREATER_THAN', alb.outputs['Alpha'], 0.35)
    g.link(g.channel(g.tex(imgs['rough']).outputs['Color'], 1), bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = 0.0
    dome = g.attr('st_dome')
    vt = g.node('ShaderNodeVectorTransform', vector_type='VECTOR', convert_from='OBJECT', convert_to='WORLD')
    g.link(dome.outputs['Vector'], vt.inputs[0])
    n = g.vmath('MULTIPLY_ADD', _decode_baked_normal(g, imgs['normal']), (0.45, 0.45, 0.45))
    g.link(vt.outputs[0], n.node.inputs[2])
    n = g.vmath('NORMALIZE', n)
    g.link(n, bsdf.inputs['Normal'])
    amount = g.math('MULTIPLY', g.attr('st_thickness').outputs['Fac'], g.channel(g.tex(imgs['trans']).outputs['Color'], 0))
    tl = g.backlight(transmit, amount, n, BB_LEAVES, SLAB)
    add = g.node('ShaderNodeAddShader')
    g.link(bsdf.outputs[0], add.inputs[0])
    g.link(tl, add.inputs[1])
    tr = g.node('ShaderNodeBsdfTransparent')
    mix = g.node('ShaderNodeMixShader')
    g.link(keep, mix.inputs[0])
    g.link(tr.outputs[0], mix.inputs[1])
    g.link(add.outputs[0], mix.inputs[2])
    g.link(mix.outputs[0], out.inputs['Surface'])
    _settings(mat, alpha=True, translucent=True, thickness=SLAB)
    mat['st_card'] = True
    mat['st_transmit'] = list(transmit)
    return mat


BB_BILLBOARD = (0.0, 0.16, 6.0, 0.0)   # impostor.js: distortion 0, ambient 0.16, power 6, scale 0 (no backlit bloom)


def billboard_material(name, imgs, card_h, transmit=None, key=None):
    """impostor.js makeCardMaterial: baked albedo / roughness, alpha test 0.35, the canopy-dome
    normal around the card's own origin with the sphere centre dropped 0.55 x card height
    (no radial points down), +0.45 up, then + 0.55 x the baked world-normal detail; the
    flat ambient scatter (0.16 x 0.7 x translucency x the species transmit), no directional
    backlight."""
    transmit = tuple(transmit or (0.42, 0.62, 0.24))
    mat = bpy.data.materials.new(name)
    if key:
        mat['st_key'] = key
    g = _G(mat)
    out = g.node('ShaderNodeOutputMaterial')
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    alb = g.tex(imgs['albedo'])
    g.link(alb.outputs['Color'], bsdf.inputs['Base Color'])
    keep = g.math('GREATER_THAN', alb.outputs['Alpha'], 0.35)
    g.link(g.channel(g.tex(imgs['rough']).outputs['Color'], 1), bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = 0.0
    geo = g.node('ShaderNodeNewGeometry')
    oi = g.node('ShaderNodeObjectInfo')
    d = g.vmath('SUBTRACT', geo.outputs['Position'], oi.outputs['Location'])
    d = g.vmath('ADD', d, (0.0, 0.0, card_h * 0.55))
    d = g.vmath('ADD', g.vmath('NORMALIZE', d), (0.0, 0.0, 0.45))
    d = g.vmath('NORMALIZE', d)
    n = g.vmath('MULTIPLY_ADD', _decode_baked_normal(g, imgs['normal']), (0.55, 0.55, 0.55))
    g.link(d, n.node.inputs[2])
    n = g.vmath('NORMALIZE', n)
    g.link(n, bsdf.inputs['Normal'])
    amount = g.math('MULTIPLY', g.channel(g.tex(imgs['trans']).outputs['Color'], 0), 0.7)
    tl = g.backlight(transmit, amount, n, BB_BILLBOARD, SLAB)
    add = g.node('ShaderNodeAddShader')
    g.link(bsdf.outputs[0], add.inputs[0])
    g.link(tl, add.inputs[1])
    tr = g.node('ShaderNodeBsdfTransparent')
    mix = g.node('ShaderNodeMixShader')
    g.link(keep, mix.inputs[0])
    g.link(tr.outputs[0], mix.inputs[1])
    g.link(add.outputs[0], mix.inputs[2])
    g.link(mix.outputs[0], out.inputs['Surface'])
    _settings(mat, alpha=True, translucent=True, thickness=SLAB)
    mat['st_billboard'] = True
    mat['st_transmit'] = list(transmit)
    return mat


def thatch_bark_material(species, controls):
    """tree.js makeThatchBarkMaterial: the dead-leaf thatch clads the branches up top and
    blends down to bare trunk bark: m = smoothstep(0.6, 1.1, height), albedo
    mix(bark, thatch x (0.85, 0.82, 0.75), m), roughness mix, the thatch normal map.
    Height is measured from the plant's root (the JS reads world Y with the hero at the
    origin; here a Joshua on a hill keeps its bare lower trunk). Falls back to plain bark
    (with the thatch maps when only they exist), as the JS does."""
    tb = species.get('thatchBark')
    if not tb:
        return bark_material(species, controls)
    th = _maps('bark', tb)
    bk = _maps('bark', species['bark'])
    tA, bA = _image(th['albedo'], False), _image(bk['albedo'], False)
    if not tA or not bA:
        return bark_material(species, controls)
    tint = controls.get('barkTint', 0xffffff)
    tint = 0xffffff if tint is None else int(tint)
    sink = float(species.get('plantSink', 0.2) or 0.0)
    key = _key('thatch', species['name'], tb, tint, sink)
    mat = _find(key)
    if mat:
        return mat
    mat = bpy.data.materials.new('ST %s thatch bark' % species['name'])
    mat['st_key'] = key
    g = _G(mat)
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    out = g.node('ShaderNodeOutputMaterial')
    g.link(bsdf.outputs[0], out.inputs['Surface'])
    tc = g.node('ShaderNodeTexCoord')
    sep = g.node('ShaderNodeSeparateXYZ')
    g.link(tc.outputs['Object'], sep.inputs[0])
    h = g.math('SUBTRACT', sep.outputs['Z'], sink)   # the parts hang `sink` below the root
    m = g.smoothstep(h, 0.6, 1.1)
    thatch = g.mix_rgb(g.tex(tA).outputs['Color'], (0.85, 0.82, 0.75), 1.0, 'MULTIPLY')
    col = g.mix_rgb(g.tex(bA).outputs['Color'], thatch, m)
    col = g.mix_rgb(col, srgb_to_linear_hex(tint), 1.0, 'MULTIPLY')
    g.link(col, bsdf.inputs['Base Color'])
    tR = _image(th['roughness'], True) or _image(bk['roughness'], True)
    bR = _image(bk['roughness'], True) or tR
    if tR and bR:
        r = g.mix_rgb(g.tex(bR).outputs['Color'], g.tex(tR).outputs['Color'], m)
        g.link(g.channel(r, 1), bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 1.0
    nimg = _image(th['normal'], True) or _image(bk['normal'], True)
    if nimg:
        g.link(g.normal_map(nimg), bsdf.inputs['Normal'])
    bsdf.inputs['Metallic'].default_value = 0.0
    _settings(mat)
    return mat


def spine_material(species, controls):
    tint = srgb_to_linear_hex(int(controls.get('spineTint') or 0xffffff))
    key = _key('spine', species['name'], tint)
    mat = _find(key)
    if mat:
        return mat
    m = _maps('leaves', species.get('spine') or species['leaf'], ('translucency',))
    mat = bpy.data.materials.new('ST %s spines' % species['name'])
    mat['st_key'] = key
    g = _G(mat)
    out = g.node('ShaderNodeOutputMaterial')
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    alb = _image(m['albedo'], False)
    keep = None
    if alb:
        t = g.tex(alb)
        g.link(g.mix_rgb(t.outputs['Color'], tint, 1.0, 'MULTIPLY'), bsdf.inputs['Base Color'])
        keep = g.math('GREATER_THAN', t.outputs['Alpha'], 0.4)
    else:
        bsdf.inputs['Base Color'].default_value = (0.69, 0.58, 0.35, 1)
    rimg = _image(m['roughness'], True)
    if rimg:
        g.link(g.channel(g.tex(rimg).outputs['Color'], 1), bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 0.85
    nimg = _image(m['normal'], True)
    nrm = g.normal_map(nimg) if nimg else None
    if nrm is not None:
        g.link(nrm, bsdf.inputs['Normal'])
    timg = _image(m.get('translucency'), True)
    amount = g.channel(g.tex(timg).outputs['Color'], 0) if timg else None
    tl = g.backlight((0.86, 0.78, 0.42), amount, nrm, BB_SPINES, SLAB)    # SPINE_TRANSMIT
    add = g.node('ShaderNodeAddShader')
    g.link(bsdf.outputs[0], add.inputs[0])
    g.link(tl, add.inputs[1])
    surf = add.outputs[0]
    if keep is not None:
        tr = g.node('ShaderNodeBsdfTransparent')
        mix = g.node('ShaderNodeMixShader')
        g.link(keep, mix.inputs[0])
        g.link(tr.outputs[0], mix.inputs[1])
        g.link(surf, mix.inputs[2])
        surf = mix.outputs[0]
    g.link(surf, out.inputs['Surface'])
    _settings(mat, alpha=True, translucent=True, thickness=SLAB)
    mat['st_gltf_dt'] = True              # cactus-spines.js userData.gltfDiffuseTransmission
    mat['st_transmit'] = [0.86, 0.78, 0.42]
    return mat
