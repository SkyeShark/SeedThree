"""The app's parallax-occlusion terrain (terrain-material.js + parallax-occlusion.js), in
EEVEE shader nodes: the "Parallax terrain (SPOM)" toggle of the Environment folder.

The JS marches the view ray through the height field in tangent space (16 layers head-on
to 48 at grazing angles, the published three.js ParallaxOcclusion with SeedThree's
computed-height generalization), refines the hit between the last two layers, samples
every rock layer at the marched UV, and darkens the colour where a 12-step march toward
the sun meets higher relief (lit x 0.7 + 0.3). The height is the DOMINANT splat layer's
own height map (desert: blended with the gravel floor's by rockness), the relief depth
0.035 rock-tile units x the layer's push x rockness (temperate) fading out from 22 m to
90 m.

EEVEE shader nodes have no loops, so the march is unrolled: 48 copies of one step group
(a step that has hit freezes), then the refinement, then 12 copies of a shadow step. The
five layer heights (+ the desert floor's) are packed into two RGBA images once per file,
so a step reads two textures. Texture arrays become those packs; the albedo / normal /
roughness layers are the separate images the inline terrain already uses.

    mat = terrain.terrain_material('temperate', species, spom=True)
"""

import bpy
import numpy as np

from .. import api as _api

STEPS = 48            # maxLayers (the march stops early on a hit; the step size follows the view angle)
MIN_LAYERS = 16
SHADOW_STEPS = 12
DEPTH = 0.035         # spomDepth: relief in rock-tile UV units
FADE = (22.0, 90.0)   # full relief inside fadeNear, flat beyond fadeFar (metres)
MIN_VIEW_Z = 0.12
SHADOW_STRENGTH = 8.0
SHADOW_BIAS = 0.03


class _T:
    """Node helper over a node tree (materials or groups)."""

    def __init__(self, nt):
        self.nt = nt
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

    def _set(self, sock, v):
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, (tuple, list)):
            sock.default_value = v
        elif v is not None:
            self.link(v, sock)

    def math(self, op, a=None, b=None, c=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b, c)):
            self._set(n.inputs[i], v)
        return n.outputs[0]

    def vmath(self, op, a=None, b=None, c=None, scale=None):
        """Vector Math; c is the third vector (MULTIPLY_ADD), scale the SCALE operand."""
        n = self.node('ShaderNodeVectorMath', operation=op)
        for i, v in enumerate((a, b, c)):
            self._set(n.inputs[i], v)
        if scale is not None:
            self._set(n.inputs['Scale'], scale)
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def mixf(self, a, b, t):
        """a + (b - a) t."""
        return self.math('MULTIPLY_ADD', self.math('SUBTRACT', b, a), t, a)

    def mixv(self, a, b, t):
        n = self.node('ShaderNodeMix', data_type='VECTOR')
        self._set(n.inputs['Factor'], t)
        self._set(n.inputs[4], a)
        self._set(n.inputs[5], b)
        return n.outputs[1]

    def xyz(self, v):
        n = self.node('ShaderNodeSeparateXYZ')
        self.link(v, n.inputs[0])
        return n.outputs

    def combine(self, x, y, z=0.0):
        n = self.node('ShaderNodeCombineXYZ')
        for i, v in enumerate((x, y, z)):
            self._set(n.inputs[i], v)
        return n.outputs[0]

    def group(self, ng, **inputs):
        n = self.node('ShaderNodeGroup')
        n.node_tree = ng
        for k, v in inputs.items():
            self._set(n.inputs[k], v)
        return n


# ---- the packed heights -----------------------------------------------------------------

def _pixels(path):
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
        return px.reshape(h, w, 4), (w, h)
    finally:
        bpy.data.images.remove(img)


def layer_bases(biome):
    """[rock base + its four variants] (the app's layer order) and the ground base."""
    if biome == 'desert':
        return ['desert_rock', 'desert_rock2', 'desert_rock3', 'desert_rock4', 'desert_sandstone'], 'desert_ground'
    return ['rock', 'rock2', 'rock3', 'rock4', 'rock5'], 'grass'


def packed_heights(biome='temperate', rock_base=None, ground_base=None, size=1024):
    """Two packed images (non-colour, channel-packed): A = heights of layers 0-3, B = (layer 4,
    the ground's height, 0, 1); a missing map reads 128/255 like the JS's fallback. Made once
    per file and packed into it."""
    import os
    layers, gbase = layer_bases(biome)
    if rock_base:
        layers[0] = rock_base
    gbase = ground_base or gbase
    names = ('SeedThree SPOM heights %s A' % biome, 'SeedThree SPOM heights %s B' % biome)
    if all(bpy.data.images.get(n) is not None for n in names):
        return [bpy.data.images[n] for n in names]
    d = os.path.join(_api.ASSETS_DIR, 'ground')

    def height(base):
        p = os.path.join(d, base + '_height.png')
        if not os.path.isfile(p):
            return np.full((size, size), 128 / 255, np.float32)
        px, (w, h) = _pixels(p)
        r = px[..., 0]
        if (w, h) != (size, size):
            ys = (np.arange(size) * h // size)
            xs = (np.arange(size) * w // size)
            r = r[ys][:, xs]
        return r
    hs = [height(b) for b in layers] + [height(gbase)]
    packs = (np.stack(hs[0:4], axis=2), np.stack([hs[4], hs[5], np.zeros_like(hs[4]), np.ones_like(hs[4])], axis=2))
    out = []
    for n, arr in zip(names, packs):
        img = bpy.data.images.get(n) or bpy.data.images.new(n, size, size, alpha=True, float_buffer=False)
        img.colorspace_settings.name = 'Non-Color'
        img.alpha_mode = 'CHANNEL_PACKED'
        img.pixels.foreach_set(arr.astype(np.float32).ravel())
        img.update()
        img.pack()
        out.append(img)
    return out


# ---- node groups ------------------------------------------------------------------------

def _new_group(name, inputs, outputs):
    ng = bpy.data.node_groups.get(name)
    if ng is not None:
        return ng, False
    ng = bpy.data.node_groups.new(name, 'ShaderNodeTree')
    for nm, kind in inputs:
        ng.interface.new_socket(name=nm, in_out='INPUT', socket_type=kind)
    for nm, kind in outputs:
        ng.interface.new_socket(name=nm, in_out='OUTPUT', socket_type=kind)
    return ng, True


def height_group(biome, packs):
    """Height(Coord): the dominant layer's height (one-hot H1 = o0..o2, H2 = (o3, o4, w)); the
    desert blends the floor's height under it by rockness w."""
    ng, fresh = _new_group('SeedThree SPOM height %s' % biome, [('Coord', 'NodeSocketVector'), ('H1', 'NodeSocketVector'),
                                                               ('H2', 'NodeSocketVector')], [('Height', 'NodeSocketFloat')])
    if not fresh:
        return ng
    t = _T(ng)
    gin, gout = t.node('NodeGroupInput'), t.node('NodeGroupOutput')
    texs = []
    for img in packs:
        n = t.node('ShaderNodeTexImage', interpolation='Linear', extension='REPEAT')
        n.image = img
        t.link(gin.outputs['Coord'], n.inputs['Vector'])
        texs.append(n)
    a, b = texs
    h2 = t.xyz(gin.outputs['H2'])
    bsep = t.node('ShaderNodeSeparateColor')
    t.link(b.outputs['Color'], bsep.inputs[0])
    rock = t.math('ADD', t.vmath('DOT_PRODUCT', a.outputs['Color'], gin.outputs['H1']),
                  t.math('ADD', t.math('MULTIPLY', a.outputs['Alpha'], h2[0]), t.math('MULTIPLY', bsep.outputs[0], h2[1])))
    h = t.mixf(bsep.outputs[1], rock, h2[2]) if biome == 'desert' else rock
    t.link(h, gout.inputs['Height'])
    return ng


def step_group(biome, hg):
    """One march step: stop once the layer depth reaches the surface depth, else step the
    UV by -DeltaUV, the layer depth by LStep and read the depth there."""
    ng, fresh = _new_group('SeedThree SPOM step %s' % biome,
                           [('UV', 'NodeSocketVector'), ('LD', 'NodeSocketFloat'), ('Depth', 'NodeSocketFloat'),
                            ('Done', 'NodeSocketFloat'), ('DeltaUV', 'NodeSocketVector'), ('LStep', 'NodeSocketFloat'),
                            ('H1', 'NodeSocketVector'), ('H2', 'NodeSocketVector')],
                           [('UV', 'NodeSocketVector'), ('LD', 'NodeSocketFloat'), ('Depth', 'NodeSocketFloat'),
                            ('Done', 'NodeSocketFloat')])
    if not fresh:
        return ng
    t = _T(ng)
    gin, gout = t.node('NodeGroupInput'), t.node('NodeGroupOutput')
    hit = t.math('SUBTRACT', 1.0, t.math('LESS_THAN', gin.outputs['LD'], gin.outputs['Depth']))   # LD >= Depth
    done = t.math('MAXIMUM', gin.outputs['Done'], hit)
    act = t.math('SUBTRACT', 1.0, done)
    nxt = t.vmath('SUBTRACT', gin.outputs['UV'], gin.outputs['DeltaUV'])
    h = t.group(hg, Coord=nxt, H1=gin.outputs['H1'], H2=gin.outputs['H2'])
    d_new = t.math('SUBTRACT', 1.0, h.outputs['Height'])
    t.link(t.mixv(gin.outputs['UV'], nxt, act), gout.inputs['UV'])
    t.link(t.math('MULTIPLY_ADD', gin.outputs['LStep'], act, gin.outputs['LD']), gout.inputs['LD'])
    t.link(t.mixf(gin.outputs['Depth'], d_new, act), gout.inputs['Depth'])
    t.link(done, gout.inputs['Done'])
    return ng


def shadow_group(biome, hg):
    """One step of the march toward the sun: rise, read the height, keep the strongest
    proximity-weighted blocker."""
    ng, fresh = _new_group('SeedThree SPOM shadow %s' % biome,
                           [('UV', 'NodeSocketVector'), ('RH', 'NodeSocketFloat'), ('Prox', 'NodeSocketFloat'),
                            ('Occ', 'NodeSocketFloat'), ('StepUV', 'NodeSocketVector'), ('Rise', 'NodeSocketFloat'),
                            ('InvSteps', 'NodeSocketFloat'), ('H1', 'NodeSocketVector'), ('H2', 'NodeSocketVector')],
                           [('UV', 'NodeSocketVector'), ('RH', 'NodeSocketFloat'), ('Prox', 'NodeSocketFloat'),
                            ('Occ', 'NodeSocketFloat')])
    if not fresh:
        return ng
    t = _T(ng)
    gin, gout = t.node('NodeGroupInput'), t.node('NodeGroupOutput')
    uv = t.vmath('ADD', gin.outputs['UV'], gin.outputs['StepUV'])
    rh = t.math('ADD', gin.outputs['RH'], gin.outputs['Rise'])
    prox = t.math('SUBTRACT', gin.outputs['Prox'], gin.outputs['InvSteps'])
    h = t.group(hg, Coord=uv, H1=gin.outputs['H1'], H2=gin.outputs['H2'])
    blocker = t.math('SUBTRACT', h.outputs['Height'], rh)
    occ = t.math('MAXIMUM', gin.outputs['Occ'], t.math('MULTIPLY', blocker, prox))
    for k, v in (('UV', uv), ('RH', rh), ('Prox', prox), ('Occ', occ)):
        t.link(v, gout.inputs[k])
    return ng


# ---- the march in a material ---------------------------------------------------------------

def dominant_onehot(t, weights):
    """The JS's chained select over the five layer weights (the last strictly greater one
    wins) as one-hot sockets."""
    dom = weights[0]
    gts = []
    for w in weights[1:]:
        gts.append(t.math('GREATER_THAN', w, dom))
        dom = t.math('MAXIMUM', dom, w)
    inv = [t.math('SUBTRACT', 1.0, g) for g in gts]
    one = []
    for i in range(5):
        v = 1.0 if i == 0 else gts[i - 1]
        for j in range(i, 4):
            v = t.math('MULTIPLY', v, inv[j]) if not isinstance(v, float) else inv[j]
        one.append(v)
    return one


def march(t, biome, rock_uv, weights, rockness, packs, sun_dir, depth_push=None):
    """Build the SPOM march in material tree helper `t`.
    rock_uv: the rock-tile UV (vector socket); weights: the five layer weights; rockness: w;
    sun_dir: world direction toward the sun (vector socket). -> (marched UV socket, lit socket)."""
    hg = height_group(biome, packs)
    sg = step_group(biome, hg)
    shg = shadow_group(biome, hg)
    one = dominant_onehot(t, weights)
    H1 = t.combine(one[0], one[1], one[2])
    H2 = t.combine(one[3], one[4], rockness)
    # the tangent frame of the UV map, the view and sun directions in it
    tan = t.node('ShaderNodeTangent', direction_type='UV_MAP', uv_map='UVMap')
    geo = t.node('ShaderNodeNewGeometry')
    N = geo.outputs['Normal']
    T = tan.outputs['Tangent']
    B = t.vmath('CROSS_PRODUCT', N, T)
    V = geo.outputs['Incoming']

    def to_ts(v):
        return t.vmath('NORMALIZE', t.combine(t.vmath('DOT_PRODUCT', v, T), t.vmath('DOT_PRODUCT', v, B),
                                               t.vmath('DOT_PRODUCT', v, N)))
    vt = t.xyz(to_ts(V))
    absz = t.math('ABSOLUTE', vt[2])
    layers = t.mixf(float(STEPS), float(MIN_LAYERS), t.math('MINIMUM', t.math('MAXIMUM', absz, 0.0), 1.0))
    lstep = t.math('DIVIDE', 1.0, layers)
    # relief depth: 0.035 x the layer push x (desert: 1, temperate: rockness) x the distance fade
    cam = t.node('ShaderNodeCameraData')
    fade = t.math('SUBTRACT', 1.0, _smooth(t, cam.outputs['View Distance'], FADE[0], FADE[1]))
    scale = t.math('MULTIPLY', DEPTH, fade)
    if depth_push is not None:
        scale = t.math('MULTIPLY', scale, depth_push(one))
    if biome != 'desert':
        scale = t.math('MULTIPLY', scale, rockness)
    shift = t.vmath('SCALE', t.combine(vt[0], vt[1], 0.0), None,
                    scale=t.math('DIVIDE', scale, t.math('MAXIMUM', absz, MIN_VIEW_Z)))
    delta = t.vmath('SCALE', shift, None, scale=lstep)
    h0 = t.group(hg, Coord=rock_uv, H1=H1, H2=H2)
    uv, ld, depth, done = rock_uv, 0.0, t.math('SUBTRACT', 1.0, h0.outputs['Height']), 0.0
    for _ in range(STEPS):
        s = t.group(sg, UV=uv, LD=ld, Depth=depth, Done=done, DeltaUV=delta, LStep=lstep, H1=H1, H2=H2)
        uv, ld, depth, done = s.outputs['UV'], s.outputs['LD'], s.outputs['Depth'], s.outputs['Done']
    # refine between the last two layers
    prev = t.vmath('ADD', uv, delta)
    after = t.math('SUBTRACT', ld, depth)
    hp = t.group(hg, Coord=prev, H1=H1, H2=H2)
    before = t.math('SUBTRACT', t.math('SUBTRACT', 1.0, hp.outputs['Height']), t.math('SUBTRACT', ld, lstep))
    wgt = t.math('DIVIDE', after, t.math('MAXIMUM', t.math('ADD', after, before), 1e-4), clamp=True)
    puv = t.mixv(uv, prev, wgt)
    # self-shadow toward the sun
    lt = t.xyz(to_ts(sun_dir))
    hf = t.group(hg, Coord=puv, H1=H1, H2=H2)
    rh = t.math('ADD', hf.outputs['Height'], SHADOW_BIAS)
    rise = t.math('DIVIDE', t.math('SUBTRACT', 1.0, rh), float(SHADOW_STEPS))
    step_uv = t.vmath('SCALE', t.combine(lt[0], lt[1], 0.0), None,
                      scale=t.math('MULTIPLY', t.math('DIVIDE', scale, t.math('MAXIMUM', lt[2], 0.1)), rise))
    suv, prox, occ = puv, 1.0, 0.0
    for _ in range(SHADOW_STEPS):
        s = t.group(shg, UV=suv, RH=rh, Prox=prox, Occ=occ, StepUV=step_uv, Rise=rise, InvSteps=1.0 / SHADOW_STEPS,
                    H1=H1, H2=H2)
        suv, rh, prox, occ = s.outputs['UV'], s.outputs['RH'], s.outputs['Prox'], s.outputs['Occ']
    lit = t.math('MULTIPLY', t.math('SUBTRACT', 1.0, t.math('MULTIPLY', occ, SHADOW_STRENGTH), clamp=True),
                 t.math('MULTIPLY', lt[2], 12.0, clamp=True))
    return puv, lit


def _smooth(t, x, lo, hi):
    n = t.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
    n.inputs['From Min'].default_value = lo
    n.inputs['From Max'].default_value = hi
    t.link(x, n.inputs['Value'])
    return n.outputs['Result']


# ---- terrain-material.js buildTerrainMaterial ---------------------------------------------

LAYER_TINT = [(1, 0), (2.2, 0.01), (1, 0), (0.45, 0), (2.4, 0.01)]     # granite, slate, fieldstone, limestone, basalt
LAYER_ROUGH_REMAP = [1, 0.78, 1.06, 0.94, 1.12]
DESERT_DEPTH_SCALE = [1.3, 0.6, 1.0, 1.4, 0.5]                           # main.js layerDepthScale (desert)
DESERT_GROUND_DEPTH = 0.4


def spom_terrain_material(biome='temperate', species=None):
    """The app's v2 terrain material with SPOM on: the five rock layers splatted by the same
    brush-sharpened selectors, sampled at the parallax-marched UV, darkened by the relief's
    self-shadow toward the sun (lit x 0.7 + 0.3), blended normals, roughness from each layer's
    own map. Temperate grass stays flat; the desert's gravel floor parallaxes too (its push
    0.4, the layers' 1.3 / 0.6 / 1.0 / 1.4 / 0.5)."""
    from .terrain import _img, _lin
    from ..bl.sun import sun_group
    desert = biome == 'desert'
    sp = species or {}
    gbase = (sp.get('groundTexture') or ('desert_ground_albedo.png' if desert else 'grass_albedo.png')).replace('_albedo.png', '')
    rbase = (sp.get('rockTexture') or ('desert_rock_albedo.png' if desert else 'rock_albedo.png')).replace('_albedo.png', '')
    name = 'ST terrain %s SPOM' % biome
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    layers, _ = layer_bases(biome)
    layers[0] = rbase
    packs = packed_heights(biome, rbase, gbase)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    t = _T(mat.node_tree)
    bsdf = t.node('ShaderNodeBsdfPrincipled')
    out = t.node('ShaderNodeOutputMaterial')
    t.link(bsdf.outputs[0], out.inputs['Surface'])
    bsdf.inputs['Metallic'].default_value = 0.0
    uv = t.node('ShaderNodeUVMap', uv_map='UVMap').outputs['UV']

    def uv_at(scale, off=(0.0, 0.0)):
        return t.vmath('MULTIPLY_ADD', uv, (scale, scale, 1.0), (off[0], off[1], 0.0))

    def tex(img, vec):
        n = t.node('ShaderNodeTexImage')
        n.image = img
        t.link(vec, n.inputs['Vector'])
        return n

    brush = _img('blend_brush.png', True)

    def sharp(wgt, s, ox, oy):
        if brush is None:
            return wgt
        sep = t.node('ShaderNodeSeparateColor')
        t.link(tex(brush, uv_at(s, (ox, oy))).outputs['Color'], sep.inputs[0])
        th = t.math('MULTIPLY_ADD', sep.outputs[0], 0.7, 0.15)
        mr = t.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
        t.link(wgt, mr.inputs['Value'])
        t.link(t.math('SUBTRACT', th, 0.22), mr.inputs['From Min'])
        t.link(t.math('ADD', th, 0.22), mr.inputs['From Max'])
        return mr.outputs['Result']
    rk = t.node('ShaderNodeAttribute', attribute_name='rockness', attribute_type='GEOMETRY').outputs['Fac']
    w = sharp(rk, 0.045, 0, 0)
    rva = t.node('ShaderNodeAttribute', attribute_name='rockVars', attribute_type='GEOMETRY')
    rv = t.node('ShaderNodeSeparateColor')
    t.link(rva.outputs['Color'], rv.inputs[0])
    vs = [sharp(rv.outputs[0], 0.031, 0.37, 0.71), sharp(rv.outputs[1], 0.026, 0.13, 0.29),
          sharp(rv.outputs[2], 0.037, 0.61, 0.47), sharp(rva.outputs['Alpha'], 0.023, 0.83, 0.09)]
    k = [t.math('SUBTRACT', 1.0, v) for v in vs]
    wl = [t.math('MULTIPLY', t.math('MULTIPLY', k[0], k[1]), t.math('MULTIPLY', k[2], k[3])),
          t.math('MULTIPLY', vs[0], t.math('MULTIPLY', k[1], t.math('MULTIPLY', k[2], k[3]))),
          t.math('MULTIPLY', vs[1], t.math('MULTIPLY', k[2], k[3])),
          t.math('MULTIPLY', vs[2], k[3]),
          vs[3]]
    rock_uv = uv_at(0.55)
    sun = t.node('ShaderNodeGroup')
    sun.node_tree = sun_group()

    def push(one):
        if not desert:
            return 1.0
        r = 0.0
        for o, d in zip(one, DESERT_DEPTH_SCALE):
            r = t.math('MULTIPLY_ADD', o, d, r) if not isinstance(r, float) else t.math('MULTIPLY', o, d)
        return t.mixf(DESERT_GROUND_DEPTH, r, w)
    puv, lit = march(t, biome, rock_uv, wl, w, packs, sun.outputs[0], depth_push=push)
    tints = [(1, 0)] * 5 if desert else LAYER_TINT
    rough_remap = [1] * 5 if desert else LAYER_ROUGH_REMAP
    rock_col = rock_n = rock_r = None
    for i, base in enumerate(layers):
        a = _img(base + '_albedo.png', False)
        n = _img(base + '_normal.png', True)
        r = _img(base + '_roughness.png', True)
        col = tex(a, puv).outputs['Color'] if a else (0.55, 0.55, 0.55)
        mul, add = tints[i]
        if (mul, add) != (1, 0):
            col = t.vmath('MULTIPLY_ADD', col, (mul,) * 3, (add,) * 3)
        nrm = tex(n, puv).outputs['Color'] if n else (0.5, 0.5, 1.0)
        if r:
            sep = t.node('ShaderNodeSeparateColor')
            t.link(tex(r, puv).outputs['Color'], sep.inputs[0])
            rgh = sep.outputs[1]
        else:
            rgh = 230 / 255
        if rock_col is None:
            rock_col, rock_n, rock_r = col, nrm, rgh
        else:
            rock_col = t.mixv(rock_col, col, wl[i])
            rock_n = t.mixv(rock_n, nrm, wl[i])
            rock_r = t.mixf(rock_r, rgh, wl[i]) if not isinstance(rock_r, float) or not isinstance(rgh, float) else rock_r
    rA = _img(rbase + '_albedo.png', False)
    macro = 1.0
    if rA:
        sep = t.node('ShaderNodeSeparateColor')
        t.link(tex(rA, uv_at(0.11)).outputs['Color'], sep.inputs[0])
        macro = t.math('MULTIPLY_ADD', sep.outputs[0], 0.8, 0.58)
    g_uv = puv if desert else uv
    gA, gN = _img(gbase + '_albedo.png', False), _img(gbase + '_normal.png', True)
    grass = tex(gA, g_uv).outputs['Color'] if gA else (*_lin(0x335926), )
    base_col = t.mixv(grass, t.vmath('SCALE', rock_col, None, scale=macro), w)
    t.link(t.vmath('SCALE', base_col, None, scale=t.math('MULTIPLY_ADD', lit, 0.7, 0.3)), bsdf.inputs['Base Color'])
    nmix = t.mixv(tex(gN, g_uv).outputs['Color'], rock_n, w) if gN else rock_n
    nm = t.node('ShaderNodeNormalMap', space='TANGENT', uv_map='UVMap')
    t.link(nmix, nm.inputs['Color'])
    t.link(nm.outputs['Normal'], bsdf.inputs['Normal'])
    rr = rock_r if isinstance(rock_r, float) else t.math('MINIMUM', t.math('MAXIMUM', t.math('MULTIPLY', rock_r, rough_remap[0]), 0.0), 1.0)
    t.link(t.mixf(0.88, rr, w) if not isinstance(rr, float) else t.mixf(0.88, rr, w), bsdf.inputs['Roughness'])
    mat['seedthree_spom'] = True
    return mat
