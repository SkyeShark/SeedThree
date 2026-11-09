"""The app's scene decoration in Blender: scatter rocks and scree (rocks.js), fallen
limbs (fallen-limbs.js), meadow grass (grass.js), desert scrub (scrub.js), and the
ground-cover card clumps with the cattail preset (ground-cover.js, cattails.js).

Every scatter runs the app's own RNG stream ('rocks:<seed>', 'limbs:<seed>',
'grass:<seed>', 'scrub:<seed>') over the terrain sampler, so the stones, limbs and
tufts land where the app puts them. The JS instances them; here each set is realized
into one mesh (the instance data a material or the wind needs rides as point
attributes), so a saved .blend renders on its own.

Grass and scrub bend in the shared wind like the app's grassWindPosition: the root is
pinned, the bend grows with the square of the blade height, each tuft bends along its
own turned wind heading (the app skips the per-instance heading on purpose: natural
chaos), with the app's near-uniform phase. Ground-cover clumps sway coherently along
the world heading (groundCoverWindPosition). Both read the strength and speed of the
shared "SeedThree Wind" group through drivers.
"""

import math
import os

import bpy
import numpy as np

from .. import api as _api
from ..core.rng import Rng
from ..core.vmath import Q, V3, compose
from ..core.leaf_cards import WIND_DIR
from ..core.scatter import (euler_xyz_quat, icosahedron, displace_rock, rock_scatter, limb_geometry,  # noqa: F401
                             limb_scatter, tuft_geometry, shrub_geometry, card_clump_geometry, grass_scatter,
                             scrub_scatter, LIMB_PARAMS)

TAU = math.pi * 2


def _to_bl(a):
    a = np.asarray(a, np.float64)
    return np.stack([a[..., 0], -a[..., 2], a[..., 1]], axis=-1)


def _mat(m16):
    return np.asarray(m16, np.float64).reshape(4, 4).T


def realize(template, matrices, extra=None):
    """Instance a template (three space: position, normal, uv, index) by column-major
    matrices -> Blender-space arrays (P, N, UV per vertex, tris) + repeated extras."""
    T = np.asarray(template['position'], np.float64)
    Nt = np.asarray(template.get('normal', np.zeros_like(T)), np.float64)
    M = np.stack([_mat(m) for m in matrices]) if len(matrices) else np.zeros((0, 4, 4))
    n, k = len(M), len(T)
    P = (np.einsum('nij,kj->nki', M[:, :3, :3], T) + M[:, None, :3, 3]).reshape(-1, 3)
    Linv = np.linalg.inv(M[:, :3, :3]).transpose(0, 2, 1) if n else M[:, :3, :3]
    N = np.einsum('nij,kj->nki', Linv, Nt).reshape(-1, 3)
    N /= np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]
    tri = np.asarray(template['index'], np.int64).reshape(-1, 3)
    tris = (tri[None] + (np.arange(n) * k)[:, None, None]).reshape(-1, 3)
    UV = np.tile(np.asarray(template['uv'], np.float64), (n, 1))
    return _to_bl(P), _to_bl(N), UV, tris, M


def build_mesh(name, P, tris, UV=None, N=None, attrs=None, smooth=True):
    from ..bl.meshes import _set_attr
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(P))
    me.vertices.foreach_set('co', np.asarray(P, np.float32).ravel())
    me.loops.add(len(tris) * 3)
    me.loops.foreach_set('vertex_index', np.asarray(tris, np.int32).ravel())
    me.polygons.add(len(tris))
    me.polygons.foreach_set('loop_start', np.arange(0, len(tris) * 3, 3, dtype=np.int32))
    me.update(calc_edges=True)
    if UV is not None:
        uvl = me.uv_layers.new(name='UVMap')
        uvl.data.foreach_set('uv', np.asarray(UV, np.float32)[np.asarray(tris).ravel()].ravel())
    if smooth:
        me.shade_smooth()
    if N is not None:
        Nn = np.asarray(N, np.float64)
        Nn /= np.maximum(np.linalg.norm(Nn, axis=1), 1e-12)[:, None]
        me.normals_split_custom_set_from_vertices(Nn.astype(np.float32))
    for key, (kind, vals) in (attrs or {}).items():
        if kind == 'FLOAT_COLOR':
            at = me.attributes.new(key, 'FLOAT_COLOR', 'POINT')
            v = np.asarray(vals, np.float32)
            if v.shape[1] == 3:
                v = np.concatenate([v, np.ones((len(v), 1), np.float32)], 1)
            at.data.foreach_set('color', v.ravel())
        else:
            _set_attr(me, key, vals, kind)
    me.update()
    return me


def _leaf_img(name, non_color):
    p = os.path.join(_api.ASSETS_DIR, 'leaves', name)
    if not os.path.isfile(p):
        return None
    img = bpy.data.images.load(p, check_existing=True)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    return img


def _link(ob_name, me, collection):
    ob = bpy.data.objects.new(ob_name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    return ob


def triplanar_rock_material(name='ST scatter rocks', albedo='rock_albedo.png', normal='rock_normal.png',
                            rough='rock_roughness.png', scale=0.35):
    """rocks.js: albedo / roughness / normal by world-space triplanar projection (three's
    TriplanarTexturesNode: weights |n| / sum), the normal map as a world-locked additive
    deviation x 0.7 over the smooth normal."""
    from ..bl.materials import _G
    from .terrain import _img
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    g = _G(mat)
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    out = g.node('ShaderNodeOutputMaterial')
    g.link(bsdf.outputs[0], out.inputs['Surface'])
    bsdf.inputs['Metallic'].default_value = 0.0
    geo = g.node('ShaderNodeNewGeometry')
    # three axes: p3 = (X, Z, -Y), n3 likewise
    def swz(sock):
        s = g.node('ShaderNodeSeparateXYZ')
        g.link(sock, s.inputs[0])
        c = g.node('ShaderNodeCombineXYZ')
        g.link(s.outputs['X'], c.inputs[0])
        g.link(s.outputs['Z'], c.inputs[1])
        g.link(g.math('MULTIPLY', s.outputs['Y'], -1.0), c.inputs[2])
        return c.outputs[0]
    p3 = swz(geo.outputs['Position'])
    n3 = swz(geo.outputs['Normal'])
    bf = g.vmath('ABSOLUTE', n3)
    bf = g.vmath('NORMALIZE', bf)
    bsum = g.vmath('DOT_PRODUCT', bf, (1.0, 1.0, 1.0))
    bf = g.vmath('DIVIDE', bf, None)
    g.link(g.vmath('SCALE', (1.0, 1.0, 1.0), None, scale=bsum), bf.node.inputs[1])
    bsep = g.node('ShaderNodeSeparateXYZ')
    g.link(bf, bsep.inputs[0])
    psep = g.node('ShaderNodeSeparateXYZ')
    g.link(p3, psep.inputs[0])

    def plane(a, b):
        c = g.node('ShaderNodeCombineXYZ')
        g.link(g.math('MULTIPLY', psep.outputs[a], scale), c.inputs[0])
        g.link(g.math('MULTIPLY', psep.outputs[b], scale), c.inputs[1])
        return c.outputs[0]
    uvs = (plane('Y', 'Z'), plane('Z', 'X'), plane('X', 'Y'))

    def tri(img):
        acc = None
        for i, axis in enumerate('XYZ'):
            t = g.tex(img)
            g.link(uvs[i], t.inputs['Vector'])
            term = g.vmath('SCALE', t.outputs['Color'], None, scale=bsep.outputs[axis])
            acc = term if acc is None else g.vmath('ADD', acc, term)
        return acc
    a = _img(albedo, False)
    if a:
        g.link(tri(a), bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = (0.25, 0.23, 0.2, 1)
    r = _img(rough, True)
    if r:
        rs = g.node('ShaderNodeSeparateXYZ')
        g.link(tri(r), rs.inputs[0])
        g.link(rs.outputs['Y'], bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 1.0
    nm = _img(normal, True)
    if nm:
        d = g.vmath('MULTIPLY_ADD', tri(nm), (2.0, 2.0, 2.0))
        d.node.inputs[2].default_value = (-1.0, -1.0, -2.0)
        ds = g.node('ShaderNodeSeparateXYZ')
        g.link(d, ds.inputs[0])
        dbl = g.node('ShaderNodeCombineXYZ')      # three (x, y, z) -> Blender (x, -z, y)
        g.link(ds.outputs['X'], dbl.inputs[0])
        g.link(g.math('MULTIPLY', ds.outputs['Z'], -1.0), dbl.inputs[1])
        g.link(ds.outputs['Y'], dbl.inputs[2])
        n = g.vmath('MULTIPLY_ADD', dbl.outputs[0], (0.7, 0.7, 0.7))
        g.link(geo.outputs['Normal'], n.node.inputs[2])
        g.link(g.vmath('NORMALIZE', n), bsdf.inputs['Normal'])
    return mat


def build_rocks(sampler, seed=1, flat_radius=15, count=32, scree=12000, material=None, collection=None,
                rock_base='rock'):
    """rocks.js buildRocks: three displaced-icosahedron boulder variants scattered over the
    terrain (seated on the lowest footprint point), plus scree pebbles where the ground is
    rocky. -> {'boulders': object, 'scree': object, 'count'}."""
    variants, per, scree_geo, mats = rock_scatter(sampler, seed, flat_radius, count, scree)
    mat = material or triplanar_rock_material('ST scatter rocks %s' % rock_base, rock_base + '_albedo.png',
                                              rock_base + '_normal.png', rock_base + '_roughness.png')
    out = {}
    Ps, Ns, Ts, base = [], [], [], 0
    for v, ms in zip(variants, per):
        if not ms:
            continue
        P, N, UV, tris, _ = realize(v, ms)
        Ps.append(P)
        Ns.append(N)
        Ts.append(tris + base)
        base += len(P)
    me = build_mesh('SeedThree boulders', np.concatenate(Ps), np.concatenate(Ts), None, np.concatenate(Ns))
    me.materials.append(mat)
    out['boulders'] = _link('SeedThree boulders', me, collection)
    if mats:
        P, N, UV, tris, _ = realize(scree_geo, mats)
        me = build_mesh('SeedThree scree', P, tris, None, N)
        me.materials.append(mat)
        ob = _link('SeedThree scree', me, collection)
        ob.visible_shadow = False   # pebbles: not worth the shadow pass (the app)
        out['scree'] = ob
    out['count'] = (count, len(mats))
    return out


# ---- fallen limbs ---------------------------------------------------------------------------

def build_fallen_limbs(sampler, species, controls=None, seed=1, flat_radius=15, count=14, collection=None):
    """fallen-limbs.js: three gnarled limb variants lying on the terrain, pitched to the slope
    under both ends, seated by their lowest corner 1.5 cm into the ground, in the species'
    bark (a static grey-pulled copy: dead wood does not sway)."""
    from ..bl.materials import bark_material
    variants, per = limb_scatter(sampler, seed, flat_radius, count)
    Ps, Ns, UVs, Ts, base = [], [], [], [], 0
    for v, ms in zip(variants, per):
        if not ms:
            continue
        P, N, UV, tris, _ = realize(v, ms)
        Ps.append(P)
        Ns.append(N)
        UVs.append(UV)
        Ts.append(tris + base)
        base += len(P)
    me = build_mesh('SeedThree fallen limbs', np.concatenate(Ps), np.concatenate(Ts), np.concatenate(UVs),
                    np.concatenate(Ns))
    src = bark_material(species, dict(controls or {}, barkTint=0xc9c4b8))
    me.materials.append(src)
    return _link('SeedThree fallen limbs', me, collection)


# ---- grass / scrub / ground cover ------------------------------------------------------------

CATTAIL_TEXTURE_FILES = {'albedo': 'cattail_reed_card.png', 'normal': 'cattail_reed_card_normal.png',
                         'roughness': 'cattail_reed_card_roughness.png',
                         'translucency': 'cattail_reed_card_translucency.png'}
CATTAIL_CARD_SPEC = {'quads': 4, 'width': 0.78, 'tiltMin': 0.025, 'tiltSpan': 0.12, 'heightMin': 0.9,
                     'heightSpan': 0.2, 'baseSpread': 0.08}


def card_material(name, albedo, normal=None, rough=None, trans=None, transmit=(0.3, 0.42, 0.16),
                  consts=(0.3, 0.026, 5.0, 1.5), alpha=0.38, relief=0.4, roughness=0.96):
    """The grass / scrub / ground-cover card material: texture x per-instance tint
    (st_tint), alpha test, world-UP normal plus the normal map's relief (card orientation
    contributes nothing), the backlight with the tint's green x translucency x transmit."""
    from ..bl.materials import _G, _settings
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    mat = bpy.data.materials.new(name)
    g = _G(mat)
    out = g.node('ShaderNodeOutputMaterial')
    bsdf = g.node('ShaderNodeBsdfPrincipled')
    t = g.tex(albedo)
    tint = g.attr('st_tint')
    g.link(g.mix_rgb(t.outputs['Color'], tint.outputs['Color'], 1.0, 'MULTIPLY'), bsdf.inputs['Base Color'])
    keep = g.math('GREATER_THAN', t.outputs['Alpha'], alpha)
    if rough is not None:
        g.link(g.channel(g.tex(rough).outputs['Color'], 1), bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0.0
    up = (0.0, 0.0, 1.0)
    if normal is not None:
        geo = g.node('ShaderNodeNewGeometry')
        rel = g.vmath('SUBTRACT', g.normal_map(normal), geo.outputs['Normal'])
        n = g.vmath('MULTIPLY_ADD', rel, (relief,) * 3)
        n.node.inputs[2].default_value = up
        n = g.vmath('NORMALIZE', n)
    else:
        cn = g.node('ShaderNodeCombineXYZ')
        cn.inputs[2].default_value = 1.0
        n = cn.outputs[0]
    g.link(n, bsdf.inputs['Normal'])
    tsep = g.node('ShaderNodeSeparateColor')
    g.link(tint.outputs['Color'], tsep.inputs[0])
    amount = tsep.outputs[1]
    if trans is not None:
        amount = g.math('MULTIPLY', amount, g.channel(g.tex(trans).outputs['Color'], 0))
    tl = g.backlight(transmit, amount, n, consts, 0.0)
    add = g.node('ShaderNodeAddShader')
    g.link(bsdf.outputs[0], add.inputs[0])
    g.link(tl, add.inputs[1])
    tr = g.node('ShaderNodeBsdfTransparent')
    mix = g.node('ShaderNodeMixShader')
    g.link(keep, mix.inputs[0])
    g.link(tr.outputs[0], mix.inputs[1])
    g.link(add.outputs[0], mix.inputs[2])
    g.link(mix.outputs[0], out.inputs['Surface'])
    _settings(mat, alpha=True, translucent=True, thickness=0.0)
    return mat


def _bend_attrs(template, mats, tints, kind):
    """Per-vertex wind data for realized tufts / clumps. grass: the bend vector is the
    instance-turned wind heading (R S windDir), the phase position the template's own x/z
    (the app's near-uniform phase), k = (local height)^2. ground cover: the world heading,
    the clump anchor as the phase position, k = uv.y^2."""
    T = np.asarray(template['position'], np.float64)
    k_n = len(T)
    M = np.stack([_mat(m) for m in mats])
    wd = np.array([WIND_DIR.x, WIND_DIR.y, WIND_DIR.z])
    if kind == 'grass':
        gdir = np.einsum('nij,j->ni', M[:, :3, :3], wd)
        gdir = np.repeat(gdir, k_n, axis=0)
        ph = np.tile(T[:, [0, 2]], (len(M), 1))
        kk = np.tile(np.maximum(T[:, 1], 0) ** 2, len(M))
    else:
        gdir = np.tile(wd, (len(M) * k_n, 1))
        ph = np.repeat(M[:, [0, 2], 3], k_n, axis=0)
        kk = np.tile(np.asarray(template['uv'], np.float64)[:, 1] ** 2, len(M))
    return {
        'st_gdir': ('FLOAT_VECTOR', _to_bl(gdir)),
        'st_gph': ('FLOAT_VECTOR', np.stack([ph[:, 0], ph[:, 1], np.zeros(len(ph))], 1)),
        'st_gk': ('FLOAT', kk),
        'st_tint': ('FLOAT_COLOR', np.repeat(np.asarray(tints, np.float64), k_n, axis=0)),
    }


def grass_wind_group(kind='grass'):
    """grassWindPosition (kind 'grass': amp 0.22, phase scale 2.2, jitter 0.25 at 3.1 Hz) or
    groundCoverWindPosition ('cover': amp 0.16 / the clump's amount, phase 2, jitter 0.18 at 3)."""
    from ..bl.wind import wind_group, _n, _math, _vscale, _attr
    name = 'SeedThree Grass Wind' if kind == 'grass' else 'SeedThree Ground Cover Wind'
    ng = bpy.data.node_groups.get(name)
    if ng is not None:
        return ng
    ng = bpy.data.node_groups.new(name, 'GeometryNodeTree')
    ng.interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    amt = ng.interface.new_socket(name='Amount', in_out='INPUT', socket_type='NodeSocketFloat')
    amt.default_value = 0.22 if kind == 'grass' else 0.16
    ng.interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nt = ng
    gin = _n(nt, 'NodeGroupInput', -1200, 0)
    gout = _n(nt, 'NodeGroupOutput', 800, 0)
    main = wind_group()
    strength = _n(nt, 'ShaderNodeValue', -1200, -300, name='Wind Strength', label='Wind Strength')
    speed = _n(nt, 'ShaderNodeValue', -1200, -420, name='Wind Speed', label='Wind Speed')
    for node, src in ((strength, 'Wind Strength'), (speed, 'Wind Speed')):
        node.outputs[0].default_value = main.nodes[src].outputs[0].default_value
        drv = node.outputs[0].driver_add('default_value').driver
        drv.type = 'SCRIPTED'
        drv.expression = 'v'
        v = drv.variables.new()
        v.name = 'v'
        v.type = 'SINGLE_PROP'
        v.targets[0].id_type = 'NODETREE'
        v.targets[0].id = main
        v.targets[0].data_path = 'nodes["%s"].outputs[0].default_value' % src
    st = _n(nt, 'GeometryNodeInputSceneTime', -1200, -540)
    t = _math(nt, 'MULTIPLY', st.outputs['Seconds'], speed.outputs[0], -1000, -500)
    ph = _attr(nt, 'st_gph', True, -1000, 100)
    sep = _n(nt, 'ShaderNodeSeparateXYZ', -850, 100)
    nt.links.new(ph, sep.inputs[0])
    px, pz = sep.outputs['X'], sep.outputs['Y']   # stored as (x, z) of three
    pscale = 2.2 if kind == 'grass' else 2.0
    phi = _math(nt, 'MULTIPLY', _math(nt, 'ADD', _math(nt, 'MULTIPLY', px, 0.35, -700, 160),
                                     _math(nt, 'MULTIPLY', pz, 0.27, -700, 80), -550, 120), pscale, -400, 120)
    s1 = _math(nt, 'SINE', _math(nt, 'ADD', _math(nt, 'MULTIPLY', t, 1.15, -550, -40), phi, -400, -40), None, -250, -40)
    s2 = _math(nt, 'SINE', _math(nt, 'ADD', _math(nt, 'MULTIPLY', t, 2.63, -550, -120),
                                 _math(nt, 'MULTIPLY', phi, 1.9, -400, -200), -400, -120), None, -250, -120)
    sway = _math(nt, 'ADD', _math(nt, 'MULTIPLY', s1, 0.72, -100, -40), _math(nt, 'MULTIPLY', s2, 0.28, -100, -120), 50, -80)
    jf, ja = (3.1, 0.25) if kind == 'grass' else (3.0, 0.18)
    jt = _math(nt, 'ADD', _math(nt, 'ADD', _math(nt, 'MULTIPLY', t, jf, -550, -300),
                                _math(nt, 'MULTIPLY', pz, 1.7, -550, -380), -400, -330),
               _math(nt, 'MULTIPLY', px, 1.3, -550, -450), -250, -350)
    jit = _math(nt, 'MULTIPLY', _math(nt, 'SINE', jt, None, -100, -350), ja, 50, -350)
    amp = _math(nt, 'MULTIPLY', strength.outputs[0], gin.outputs['Amount'], -100, -250)
    total = _math(nt, 'MULTIPLY', _math(nt, 'ADD', sway, jit, 200, -150), amp, 350, -150)
    k = _attr(nt, 'st_gk', False, 200, -300)
    off = _vscale(nt, _attr(nt, 'st_gdir', True, 200, 100), _math(nt, 'MULTIPLY', total, k, 450, -200), 550, 50)
    sp = _n(nt, 'GeometryNodeSetPosition', 650, 100)
    nt.links.new(gin.outputs[0], sp.inputs['Geometry'])
    nt.links.new(off, sp.inputs['Offset'])
    nt.links.new(sp.outputs[0], gout.inputs[0])
    return ng


def _add_grass_wind(ob, kind='grass', amount=None):
    mod = ob.modifiers.new('SeedThree %s wind' % kind, 'NODES')
    mod.node_group = grass_wind_group(kind)
    if amount is not None:
        # Blender 5.2 keeps a nodes modifier's inputs at mod.properties.inputs.<identifier>.value
        sock = next(s for s in mod.node_group.interface.items_tree
                    if getattr(s, 'in_out', None) == 'INPUT' and s.name == 'Amount')
        getattr(mod.properties.inputs, sock.identifier).value = float(amount)
    return mod


def build_grass(sampler, seed=1, flat_radius=15, count=13000, collection=None, wind=True):
    """grass.js buildGrass: wide meadow fans + narrow tall clumps over the whole terrain,
    thinning outward, a root clearing at the trunk, bare where the ground turns rocky,
    with green-to-straw tints that follow the rock mask."""
    tex = _leaf_img('grass_tuft.png', False)
    if tex is None:
        return None
    variants = grass_scatter(sampler, seed, flat_radius, count)
    mat = card_material('ST grass tufts', tex, _leaf_img('grass_tuft_normal.png', True),
                        _leaf_img('grass_tuft_roughness.png', True), None, (0.45, 0.65, 0.22),
                        (0.4, 0.06, 5.0, 2.6), 0.42, 0.6, 0.95)
    return _cards_object('SeedThree grass', variants, mat, 'grass', collection, wind)


def _cards_object(name, buckets, mat, kind, collection, wind, amount=None, mats_by_bucket=None):
    Ps, Ns, UVs, Ts, At, base = [], [], [], [], {}, 0
    slot_faces = []
    for bi, v in enumerate(buckets):
        if not v['mats']:
            continue
        P, N, UV, tris, _ = realize(v['geo'], v['mats'])
        Ps.append(P)
        Ns.append(N)
        UVs.append(UV)
        Ts.append(tris + base)
        slot_faces.append((bi, len(tris)))
        base += len(P)
        for kk, (kind_, vals) in _bend_attrs(v['geo'], v['mats'], v['tint'], kind).items():
            At.setdefault(kk, (kind_, []))[1].append(vals)
    if not Ps:
        return None
    attrs = {k: (kd, np.concatenate(vs)) for k, (kd, vs) in At.items()}
    up = np.tile([0.0, 0.0, 1.0], (base, 1))
    me = build_mesh(name, np.concatenate(Ps), np.concatenate(Ts), np.concatenate(UVs), up, attrs, smooth=True)
    if mats_by_bucket:
        used = []
        for bi, _ in slot_faces:
            used.append(mats_by_bucket[bi])
        for m in used:
            me.materials.append(m)
        idx = np.concatenate([np.full(nf, si, np.int32) for si, (bi, nf) in enumerate(slot_faces)])
        me.polygons.foreach_set('material_index', idx)
    else:
        me.materials.append(mat)
    ob = _link(name, me, collection)
    if wind:
        _add_grass_wind(ob, 'grass' if kind == 'grass' else 'cover', amount)
    return ob


SCRUB_DEFS = [
    {'base': 'sagebrush', 'tint': (0.62, 0.68, 0.52), 'height': 0.55, 'share': 1.1, 'quads': 9, 'transmit': (0.32, 0.40, 0.20)},
    {'base': 'blackbrush', 'tint': (0.40, 0.42, 0.47), 'height': 0.48, 'share': 1.0, 'quads': 8, 'transmit': (0.20, 0.22, 0.20)},
    {'base': 'creosote', 'tint': (0.50, 0.62, 0.40), 'height': 0.80, 'share': 0.9, 'quads': 7, 'transmit': (0.30, 0.44, 0.18)},
]


def build_scrub(sampler, seed=1, flat_radius=15, count=2600, shrubs=None, collection=None, wind=True):
    """scrub.js buildScrub with main.js's three desert shrub cards (sagebrush, blackbrush,
    creosote): sparse, thinning near the trunk, bare on the harshest rock."""
    defs = []
    for d in (shrubs or SCRUB_DEFS):
        tex = _leaf_img(d['base'] + '_albedo.png', False)
        if tex is not None:
            defs.append(dict(d, texture=tex, normal=_leaf_img(d['base'] + '_normal.png', True),
                             translucency=_leaf_img(d['base'] + '_translucency.png', True)))
    if not defs:
        return None
    buckets = scrub_scatter(sampler, defs, seed, flat_radius, count)
    mats = [card_material('ST scrub %s' % b['s']['base'], b['s']['texture'], b['s']['normal'], None,
                          b['s']['translucency'], b['s'].get('transmit', (0.34, 0.42, 0.18)), (0.35, 0.05, 5.0, 2.2),
                          0.42, 0.5, 0.96) for b in buckets]
    return _cards_object('SeedThree scrub', buckets, None, 'grass', collection, wind, mats_by_bucket=mats)


def ground_cover_material(textures, name='SeedThree ground cover', transmit=(0.3, 0.42, 0.16), alpha=0.38):
    """ground-cover.js createGroundCoverMaterial."""
    return card_material(name, textures['albedo'], textures.get('normal'), textures.get('roughness'),
                         textures.get('translucency'), transmit, (0.3, 0.026, 5.0, 1.5), alpha, 0.4, 0.96)


def load_ground_cover_textures(sources):
    """loadGroundCoverTextures: albedo required, the other maps optional (leaf-folder names
    or absolute paths)."""
    def ld(p, nc):
        if not p:
            return None
        if os.path.isabs(p):
            if not os.path.isfile(p):
                return None
            img = bpy.data.images.load(p, check_existing=True)
            img.colorspace_settings.name = 'Non-Color' if nc else 'sRGB'
            return img
        return _leaf_img(p, nc)
    out = {'albedo': ld(sources.get('albedo'), False), 'normal': ld(sources.get('normal'), True),
           'roughness': ld(sources.get('roughness'), True), 'translucency': ld(sources.get('translucency'), True)}
    if out['albedo'] is None:
        raise ValueError('SeedThree ground-cover albedo missing (%s)' % sources.get('albedo'))
    return out


def ground_cover_wind_vector(yaw, scale):
    """groundCoverWindVector: the world heading in one instance's frame, / its scale."""
    q = Q().set_from_axis_angle(V3(0, 1, 0), -yaw)
    v = V3(WIND_DIR.x, WIND_DIR.y, WIND_DIR.z).apply_quaternion(q)
    return (v.x / scale[0] if scale[0] else v.x, v.y / scale[1] if scale[1] else v.y,
            v.z / scale[2] if scale[2] else v.z)


def make_ground_cover(placements, spec, textures, name='SeedThree ground cover', transmit=(0.3, 0.42, 0.16),
                      wind_amount=0.16, collection=None, wind=True):
    """Instanced card clumps at application-chosen placements (ground-cover.js leaves the
    habitat to the app): placements = [{'pos': (x, y, z) three, 'yaw', 'scale': (sx, sy, sz),
    'tint': (r, g, b)}]. Swaying coherently along the world heading
    (groundCoverWindPosition)."""
    geo = card_clump_geometry(spec)
    Y = V3(0, 1, 0)
    mats, tints = [], []
    for p in placements:
        q = Q().set_from_axis_angle(Y, p.get('yaw', 0.0))
        s = p.get('scale', (1, 1, 1))
        mats.append(compose(V3(*p['pos']), q, V3(*s)))
        tints.append(p.get('tint', (1.0, 1.0, 1.0)))
    mat = ground_cover_material(textures, name, transmit)
    return _cards_object(name, [{'geo': geo, 'mats': mats, 'tint': tints}], mat, 'cover', collection, wind,
                         amount=wind_amount)


def make_cattails(placements, collection=None, wind=True, **spec_overrides):
    """cattails.js: the reed-card preset (4 cards, 0.78 wide, 0.9-1.1 tall) with its
    textures, transmit (0.28, 0.42, 0.13) and wind amount 0.22."""
    textures = load_ground_cover_textures(CATTAIL_TEXTURE_FILES)
    return make_ground_cover(placements, dict(CATTAIL_CARD_SPEC, **spec_overrides), textures, 'SeedThree cattails',
                             (0.28, 0.42, 0.13), 0.22, collection, wind)


# ground-cover.js / cattails.js names, for code written against the JS module. Per-instance
# tint, anchor and wind vector (addGroundCoverInstanceAttributes) are POINT attributes of the
# realized clumps (make_ground_cover); textures are file data (no disposeGroundCoverTextures).

def create_ground_cover_material(textures, name='SeedThree ground cover', transmit=(0.3, 0.42, 0.16), alpha_test=0.38):
    """createGroundCoverMaterial({name, textures, transmit, alphaTest}); the wind amount lives on
    make_ground_cover (the sway is a Geometry Nodes deformation here, not the material's)."""
    return ground_cover_material(textures, name, transmit, alpha_test)


def create_card_clump_geometry(spec):
    """createCardClumpGeometry: the deterministic crossed-card clump (core.scatter)."""
    return card_clump_geometry(spec)


def create_cattail_geometry(overrides=None):
    """createCattailGeometry: the clump with CATTAIL_CARD_SPEC (+ overrides)."""
    return card_clump_geometry(dict(CATTAIL_CARD_SPEC, **(overrides or {})))


def create_cattail_material(textures=None, name='SeedThree cattails', transmit=(0.28, 0.42, 0.13), alpha_test=0.38):
    """createCattailMaterial: the ground-cover material with the reeds' transmit (textures
    default to CATTAIL_TEXTURE_FILES from the leaves folder)."""
    return ground_cover_material(textures or load_ground_cover_textures(CATTAIL_TEXTURE_FILES), name, transmit,
                                 alpha_test)
