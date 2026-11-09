"""The app's environment (src/core/environment.js) in Blender: the analytic terrain
sampler, the terrain ring with its vertex-painted grass / five-rock blend, the
gradient sky with the glowing sun, and the app's two lights.

    from seedthree.scene import terrain
    smp = terrain.make_height_sampler(seed=1, R=280, flatR=15, hillH=12)
    smp.height_at(x, z), smp.rockness_at(x, z), smp.meadow_at(x, z)     # three's x, z
    env = terrain.build_environment(biome='temperate', seed=1, radius=280)

The sampler is the JS's integer-hash value noise (4-octave fBm), value for value, so
the hills, the rock / meadow masks, the scatter and the forest slots land where the
app puts them. Everything takes and returns three's coordinates (x, y up, z);
Blender places it at (x, -z, y).
"""

import math
import os

import bpy
import numpy as np

from .. import api as _api

BIOMES = {
    'temperate': {'zenith': 0x3f6ea8, 'horizon': 0xc6dcec, 'fog': 0xc6dcec, 'sun': 0xfff4d6},
    'desert': {'zenith': 0x7a9cc4, 'horizon': 0xdcc6a0, 'fog': 0xd8be95, 'sun': 0xffeec2},
}


from ..core.terrain_noise import hash2, smooth, value_noise, fbm, HeightSampler, make_height_sampler  # noqa: F401


def _lin(h):
    def c(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255))


def ground_dir():
    return os.path.join(_api.ASSETS_DIR, 'ground')


def _img(name, non_color):
    p = os.path.join(ground_dir(), name)
    if not os.path.isfile(p):
        return None
    img = bpy.data.images.load(p, check_existing=True)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    return img


# ---- the terrain ring ------------------------------------------------------------------

ROCK_SELECTORS = [
    {'f': 0.022, 'ox': 91, 's': 41, 't': 0.47},
    {'f': 0.017, 'ox': -47, 's': 71, 't': 0.53},
    {'f': 0.026, 'ox': 133, 's': 97, 't': 0.56},
    {'f': 0.014, 'ox': -211, 's': 123, 't': 0.59},
]


def terrain_mesh(sampler, R=75, segs=320, tile=4.0, name='SeedThree terrain'):
    """PlaneGeometry(2R, 2R, segs, segs) laid flat, heights from the sampler, per-vertex
    rockness and the four rock-variant selectors, UVs x (2R / tile)."""
    n1 = segs + 1
    ix, iy = np.meshgrid(np.arange(n1), np.arange(n1))
    ix, iy = ix.ravel(), iy.ravel()
    x = ix * (2 * R / segs) - R
    z = iy * (2 * R / segs) - R
    y = sampler.height_at(x, z)
    rock = sampler.rockness_at(x, z)
    rv = np.stack([smooth(np.clip((fbm(x * c['f'] + c['ox'], z * c['f'], sampler.seed + c['s']) - c['t']) * 6 + 0.5, 0, 1))
                   for c in ROCK_SELECTORS], axis=1)
    tiles = (R * 2) / tile
    u = ix / segs * tiles
    v = (1 - iy / segs) * tiles
    gi = np.arange(segs)
    A = (gi[None, :] + n1 * gi[:, None]).ravel()
    B = (gi[None, :] + n1 * (gi[:, None] + 1)).ravel()
    C = (gi[None, :] + 1 + n1 * (gi[:, None] + 1)).ravel()
    D = (gi[None, :] + 1 + n1 * gi[:, None]).ravel()
    tris = np.concatenate([np.stack([A, B, D], 1), np.stack([B, C, D], 1)])
    P = np.stack([x, -z, y], 1).astype(np.float32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(P))
    me.vertices.foreach_set('co', P.ravel())
    me.loops.add(len(tris) * 3)
    me.loops.foreach_set('vertex_index', tris.astype(np.int32).ravel())
    me.polygons.add(len(tris))
    me.polygons.foreach_set('loop_start', np.arange(0, len(tris) * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    uvl = me.uv_layers.new(name='UVMap')
    UV = np.stack([u, v], 1).astype(np.float32)
    uvl.data.foreach_set('uv', UV[tris.ravel()].ravel())
    me.shade_smooth()
    at = me.attributes.new('rockness', 'FLOAT', 'POINT')
    at.data.foreach_set('value', rock.astype(np.float32))
    at = me.attributes.new('rockVars', 'FLOAT_COLOR', 'POINT')
    at.data.foreach_set('color', rv.astype(np.float32).ravel())
    me.update()
    return me


def terrain_material(biome='temperate', species=None, spom=False):
    """The inline 5-way blend: grass <-> rock by the brush-sharpened rockness, five rock
    variants by their selectors, a macro patina, blended normals and roughness. spom=True is
    the app's Parallax terrain toggle: the v2 material with the parallax-occlusion march
    (scene/spom.py)."""
    if spom:
        from .spom import spom_terrain_material
        return spom_terrain_material(biome, species)
    from ..bl.materials import _G
    desert = biome == 'desert'
    sp = species or {}
    gbase = (sp.get('groundTexture') or 'grass_albedo.png').replace('_albedo.png', '')
    rbase = (sp.get('rockTexture') or 'rock_albedo.png').replace('_albedo.png', '')
    variants = ['desert_rock2', 'desert_rock3', 'desert_rock4', 'desert_sandstone'] if desert else ['rock2', 'rock3', 'rock4', 'rock5']
    name = 'ST terrain %s' % biome
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    g = _G(mat)
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    out = g.node('ShaderNodeOutputMaterial')
    g.link(bsdf.outputs[0], out.inputs['Surface'])
    bsdf.inputs['Metallic'].default_value = 0.0
    uvn = g.node('ShaderNodeUVMap', uv_map='UVMap')
    uv = uvn.outputs['UV']

    def tex_at(img, scale=1.0, off=(0.0, 0.0)):
        n = g.tex(img)
        if scale != 1.0 or off != (0.0, 0.0):
            v = g.vmath('MULTIPLY_ADD', uv, (scale, scale, 1.0))
            v.node.inputs[2].default_value = (off[0], off[1], 0.0)
            g.link(v, n.inputs['Vector'])
        else:
            g.link(uv, n.inputs['Vector'])
        return n

    brush = _img('blend_brush.png', True)

    def sharp(wgt, s, ox, oy):
        if brush is None:
            return wgt
        b = g.channel(tex_at(brush, s, (ox, oy)).outputs['Color'], 0)
        th = g.math('ADD', g.math('MULTIPLY', b, 0.7), 0.15)
        mr = g.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
        g.link(wgt, mr.inputs['Value'])
        g.link(g.math('SUBTRACT', th, 0.22), mr.inputs['From Min'])
        g.link(g.math('ADD', th, 0.22), mr.inputs['From Max'])
        return mr.outputs['Result']
    rk = g.attr('rockness').outputs['Fac']
    w = sharp(rk, 0.045, 0, 0)
    rva = g.attr('rockVars')
    rv = g.node('ShaderNodeSeparateColor')
    g.link(rva.outputs['Color'], rv.inputs[0])
    rv_alpha = rva.outputs['Alpha']
    vs = [sharp(rv.outputs[0], 0.031, 0.37, 0.71), sharp(rv.outputs[1], 0.026, 0.13, 0.29),
          sharp(rv.outputs[2], 0.037, 0.61, 0.47), sharp(rv_alpha, 0.023, 0.83, 0.09)]
    grassA, rockA = _img(gbase + '_albedo.png', False), _img(rbase + '_albedo.png', False)
    rm = [[1, 0]] * 4 if desert else [[2.2, 0.01], [1, 0], [0.45, 0], [2.4, 0.01]]
    if grassA is None or rockA is None:
        bsdf.inputs['Base Color'].default_value = (*_lin(0x2f5a2a), 1)
        bsdf.inputs['Roughness'].default_value = 1.0
        return mat
    rock_col = tex_at(rockA, 0.55).outputs['Color']
    for vi, vb in enumerate(variants):
        img = _img(vb + '_albedo.png', False)
        if img is None:
            continue
        c = g.vmath('MULTIPLY_ADD', tex_at(img, 0.55).outputs['Color'], (rm[vi][0],) * 3)
        c.node.inputs[2].default_value = (rm[vi][1],) * 3
        rock_col = g.mix_rgb(rock_col, c, vs[vi])
    macro = g.math('ADD', g.math('MULTIPLY', g.channel(tex_at(rockA, 0.11).outputs['Color'], 0), 0.8), 0.58)
    rock_col = g.vmath('SCALE', rock_col, None, scale=macro)
    col = g.mix_rgb(tex_at(grassA, 1.0).outputs['Color'], rock_col, w)
    g.link(col, bsdf.inputs['Base Color'])
    gN, rN = _img(gbase + '_normal.png', True), _img(rbase + '_normal.png', True)
    if gN and rN:
        rock_n = tex_at(rN, 0.55).outputs['Color']
        for vi, vb in enumerate(variants):
            img = _img(vb + '_normal.png', True)
            if img is not None:
                rock_n = g.mix_rgb(rock_n, tex_at(img, 0.55).outputs['Color'], vs[vi])
        nmix = g.mix_rgb(tex_at(gN, 1.0).outputs['Color'], rock_n, w)
        nm = g.node('ShaderNodeNormalMap', space='TANGENT', uv_map='UVMap')
        g.link(nmix, nm.inputs['Color'])
        g.link(nm.outputs['Normal'], bsdf.inputs['Normal'])
    rR = _img(rbase + '_roughness.png', True)
    if rR:
        rr = g.channel(tex_at(rR, 0.55).outputs['Color'], 1)
        for vi, k in enumerate((0.78, 1.06, 0.94, 1.12)):
            mod = g.math('MULTIPLY', rr, k)
            if k > 1:
                mod = g.math('MINIMUM', mod, 1.0)
            rr = g.math('ADD', g.math('MULTIPLY', rr, g.math('SUBTRACT', 1.0, vs[vi])), g.math('MULTIPLY', mod, vs[vi]))
        rough = g.math('ADD', g.math('MULTIPLY', 0.88, g.math('SUBTRACT', 1.0, w)), g.math('MULTIPLY', rr, w))
        g.link(rough, bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 1.0
    return mat


# ---- sky, sun and the app's lights -----------------------------------------------------

def sun_direction(az_deg=40.0, el_deg=32.0):
    """main.js sunDirWorld (three axes): (cos e cos a, sin e, cos e sin a)."""
    a, e = math.radians(az_deg), math.radians(el_deg)
    return (math.cos(e) * math.cos(a), math.sin(e), math.cos(e) * math.sin(a))


def sun_color_intensity(el_deg):
    """main.js updateSun: warms and dims toward the horizon. three r184's Color.setHSL(h, s,
    l) takes its colour space argument's default, the linear working space, so the HSL
    triple is already the linear colour (no sRGB decode)."""
    import colorsys
    t = min(1.0, max(0.0, el_deg / 60.0))
    h, s, l = 0.095 + 0.045 * t, 0.55 - 0.35 * t, 0.62 + 0.24 * t
    r, g, b = colorsys.hls_to_rgb(h, l, s)
    return (r, g, b), 2.2 + 1.1 * t


def world_sky(biome='temperate', sun_dir=(0.6, 0.53, 0.55), name=None, hemi=(0x9fc0ff, 0x3a4a2a, 1.2)):
    """The world: camera rays see the app's gradient dome (horizon -> zenith over
    smoothstep(dir.y + 0.15)) with the additive sun glow (a 120 m sprite and a 34 m core at
    700 m: ~4.9 and 1.4 degrees); every other ray sees the app's HemisphereLight (sky
    0x9fc0ff above, ground 0x3a4a2a below, x 1.2), as world radiance 1.2 / pi so a
    Lambert surface gets three's irradiance."""
    from ..bl.materials import _G
    b = BIOMES.get(biome, BIOMES['temperate'])
    w = bpy.data.worlds.new(name or ('SeedThree %s sky' % biome))
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    L = nt.links.new
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    L(tc.outputs['Generated'], sep.inputs[0])

    def math_node(op, a, bb=None):
        n = nt.nodes.new('ShaderNodeMath')
        n.operation = op
        for i, v in enumerate((a, bb)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                L(v, n.inputs[i])
        return n.outputs[0]
    t = math_node('ADD', sep.outputs['Z'], 0.15)
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.interpolation_type = 'SMOOTHSTEP'
    mr.clamp = True
    L(t, mr.inputs['Value'])
    grad = nt.nodes.new('ShaderNodeMix')
    grad.data_type = 'RGBA'
    L(mr.outputs['Result'], grad.inputs[0])
    grad.inputs[6].default_value = (*_lin(b['horizon']), 1)
    grad.inputs[7].default_value = (*_lin(b['zenith']), 1)
    # sun glow: angle to the sun direction (Blender axes)
    sd = (sun_dir[0], -sun_dir[2], sun_dir[1])
    dot = nt.nodes.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    L(tc.outputs['Generated'], dot.inputs[0])
    dot.inputs[1].default_value = sd
    dot.name = dot.label = 'Sun Dot'
    ang = math_node('ARCCOSINE', dot.outputs['Value'])
    glow_r, core_r = math.atan(60 / 700), math.atan(17 / 700)
    # glow sprite: alpha 0.9 at 0 -> 0.5 at 0.25 -> 0 at the rim; core: 1 to 0.5, 0.6 at 0.75, 0 at the rim
    gl = nt.nodes.new('ShaderNodeValToRGB')
    L(math_node('DIVIDE', ang, glow_r), gl.inputs[0])
    e = gl.color_ramp.elements
    e[0].position, e[0].color = 0.0, (0.9, 0.9, 0.9, 1)
    e[1].position, e[1].color = 1.0, (0, 0, 0, 1)
    mid = e.new(0.25)
    mid.color = (0.5, 0.5, 0.5, 1)
    co = nt.nodes.new('ShaderNodeValToRGB')
    L(math_node('DIVIDE', ang, core_r), co.inputs[0])
    e = co.color_ramp.elements
    e[0].position, e[0].color = 0.0, (1, 1, 1, 1)
    e[1].position, e[1].color = 1.0, (0, 0, 0, 1)
    for p, v in ((0.5, 1.0), (0.75, 0.6)):
        el = e.new(p)
        el.color = (v, v, v, 1)
    suncol = _lin(b['sun'])
    add = nt.nodes.new('ShaderNodeMath')
    add.operation = 'ADD'
    s1 = nt.nodes.new('ShaderNodeSeparateColor')
    L(gl.outputs['Color'], s1.inputs[0])
    s2 = nt.nodes.new('ShaderNodeSeparateColor')
    L(co.outputs['Color'], s2.inputs[0])
    L(s1.outputs[0], add.inputs[0])
    L(s2.outputs[0], add.inputs[1])
    above = math_node('GREATER_THAN', sep.outputs['Z'], -0.05)
    glow = math_node('MULTIPLY', add.outputs[0], above)
    sunrgb = nt.nodes.new('ShaderNodeVectorMath')
    sunrgb.operation = 'SCALE'
    sunrgb.inputs[0].default_value = suncol
    L(glow, sunrgb.inputs['Scale'])
    sky = nt.nodes.new('ShaderNodeVectorMath')
    sky.operation = 'ADD'
    L(grad.outputs[2], sky.inputs[0])
    L(sunrgb.outputs['Vector'], sky.inputs[1])
    # lighting: the hemisphere light
    hemi_mix = nt.nodes.new('ShaderNodeMix')
    hemi_mix.data_type = 'RGBA'
    L(math_node('GREATER_THAN', sep.outputs['Z'], 0.0), hemi_mix.inputs[0])
    hemi_mix.inputs[6].default_value = (*_lin(hemi[1]), 1)
    hemi_mix.inputs[7].default_value = (*_lin(hemi[0]), 1)
    lp = nt.nodes.new('ShaderNodeLightPath')
    pick = nt.nodes.new('ShaderNodeMix')
    pick.data_type = 'RGBA'
    L(lp.outputs['Is Camera Ray'], pick.inputs[0])
    L(hemi_mix.outputs[2], pick.inputs[6])
    L(sky.outputs['Vector'], pick.inputs[7])
    strength = math_node('ADD', math_node('MULTIPLY', lp.outputs['Is Camera Ray'], 1.0 - hemi[2] / math.pi), hemi[2] / math.pi)
    bg = nt.nodes.new('ShaderNodeBackground')
    L(pick.outputs[2], bg.inputs['Color'])
    L(strength, bg.inputs['Strength'])
    out = nt.nodes.new('ShaderNodeOutputWorld')
    L(bg.outputs[0], out.inputs['Surface'])
    w['seedthree_fog'] = list(_lin(b['fog']))
    return w


def sun_lamp(scene, az_deg=40.0, el_deg=32.0, name='SeedThree sun', angle_deg=0.53):
    """The app's DirectionalLight: colour / intensity from updateSun (three's intensity is
    irradiance, as Blender's sun strength)."""
    col, inten = sun_color_intensity(el_deg)
    ld = bpy.data.lights.get(name) or bpy.data.lights.new(name, 'SUN')
    ld.color = col
    ld.energy = inten
    ld.angle = math.radians(angle_deg)
    ob = bpy.data.objects.get(name) or bpy.data.objects.new(name, ld)
    if ob.name not in scene.collection.objects:
        scene.collection.objects.link(ob)
    d3 = sun_direction(az_deg, el_deg)
    from mathutils import Vector
    d = Vector((d3[0], -d3[2], d3[1]))
    ob.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    ob['seedthree_sun'] = {'az': az_deg, 'el': el_deg}
    return ob


def place_sun(sun_ob, az_deg, el_deg, scene=None):
    """main.js updateSun on a lamp made by sun_lamp: its direction, colour and strength, and
    the sun glow of the scene's SeedThree sky (the app moves the sun sprite with it)."""
    scene = scene or bpy.context.scene
    sun_lamp(scene, az_deg, el_deg, name=sun_ob.name)
    w = scene.world
    if w is not None and w.use_nodes and 'Sun Dot' in w.node_tree.nodes:
        d3 = sun_direction(az_deg, el_deg)
        w.node_tree.nodes['Sun Dot'].inputs[1].default_value = (d3[0], -d3[2], d3[1])
    return sun_ob


def build_environment(scene=None, biome='temperate', seed=1, radius=280, flat_radius=15, hill_height=12,
                      species=None, sun_az=40.0, sun_el=32.0, segs=320, collection=None, spom=False):
    """buildEnvironment + main.js buildBiome's lights: the terrain ring, the sky world and the
    sun lamp. spom: the app's Parallax terrain toggle. -> {'terrain', 'world', 'sun', 'sampler', 'fog'}."""
    scene = scene or bpy.context.scene
    smp = make_height_sampler(seed, radius, flat_radius, hill_height)
    me = terrain_mesh(smp, radius, segs)
    me.materials.append(terrain_material(biome, species, spom))
    ob = bpy.data.objects.new('SeedThree terrain', me)
    (collection or scene.collection).objects.link(ob)
    # the sampler's inputs, so the forest ring / scatter can find the hills again
    ob['seedthree_terrain_seed'] = int(seed)
    ob['seedthree_terrain_radius'] = float(radius)
    ob['seedthree_terrain_flat'] = float(flat_radius)
    ob['seedthree_terrain_hill'] = float(hill_height)
    ob['seedthree_biome'] = biome                       # for the add-on's Parallax terrain toggle
    ob['seedthree_terrain_species'] = (species or {}).get('name', '')
    w = world_sky(biome, sun_direction(sun_az, sun_el))
    scene.world = w
    sun = sun_lamp(scene, sun_az, sun_el)
    return {'terrain': ob, 'world': w, 'sun': sun, 'sampler': smp, 'fog': BIOMES[biome]['fog']}
