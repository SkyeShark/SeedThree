"""The app's atmosphere in Blender: the volumetric clouds (src/core/clouds.js) and the
ring haze (main.js's TSL fog node).

Clouds: the JS raymarches a 72^3 Perlin-noise density texture (three's ImprovedNoise,
spherical falloff) inside a few scaled boxes, unlit: each step adds
smoothstep(threshold +- range, density) x opacity of a colour shaded by the noise
difference along the box diagonal (3 x shade) and a ramp (x + y) 0.25 + 0.2, plus the
cloud tint. Here the same texture becomes a Blender volume (Geometry Nodes: a Volume
Cube over the noise values, one cube per cloud at the app's hashed place and size, and
a second grid 'shade' holding the JS's diagonal difference per voxel) with an emission +
absorption volume shader reading both grids: the same density, threshold, opacity and
colour recipe, integrated by EEVEE's volume pass. Two EEVEE rules decide its strength.
A Geometry Nodes volume is an OBJECT-space volume: EEVEE divides its coefficients by
|M n| (n the normalized box diagonal, 82 for a 105 x 90 x 33 m cloud), so the shader
works per unit of box length and multiplies that factor back where the JS's step rate
needs it. And the Principled Volume multiplies its absorption (not its emission) by the
grid named in its Density Attribute ('density' by default): the shader computes the
density itself, so that attribute is cleared. Measured against the app's march run on
the CPU over the same sky (eidoverse's blender/tests/trees2/cloud_probe.py): one cloud
close up adds 0.21 over the sky where the app's adds 0.18 (seen from the plant, 0.28
against 0.25); before these two rules were kept it added 0.012. (three's transparent
blending multiplies the premultiplied march by its alpha once more; EEVEE integrates
once, so thin wisps read a little brighter.)

Haze: density from WORLD position, pooling toward the terrain rim and hugging low
altitude, plus a hard wall over the last ~30 m: factor = smoothstep(start, start + 140,
r) x exp(-0.045 max(y, 0)) x 0.9 density + smoothstep(245, 278, r), r = the horizontal
radius. A compositor pass on EEVEE's Position pass mixes the frame toward the haze
colour by it (the sky behind has no position and stays clear, as the dome does in the
app). When the haze is off (the app's Distance fog toggle, or a forced preview level)
the app falls back to its classic range fog, three's scene.fog: smoothstep(near, far,
view depth) toward the sky's fog colour (near 95 / far 300 m, desert 55 / 230); the same
pass does that from the Depth pass.
"""

import math

import bpy
import numpy as np

from ..core.cloud_noise import improved_noise, cloud_noise, cloud_placements  # noqa: F401


def shade_values(data, size):
    """clouds.js's relief term at every voxel centre, x fastest like the noise:
    tex(p - 0.01) - tex(p + 0.01), read the way the JS reads it. Its density read adds 0.5 to
    the box coordinate p (-0.5..0.5); this one does not, so three's clamp-to-edge makes the
    reads in the box's lower half along an axis take the texture's first texel there. The
    texture is a LinearFilter Data3DTexture: trilinear, texel centres at (i + 0.5) / size."""
    tex = data.astype(np.float32).reshape(size, size, size) / 255.0        # [z, y, x]
    i = np.arange(size, dtype=np.float32)

    def read(off):
        q = np.clip(i - size / 2 + off, 0, size - 1)        # texel coordinate of p + off / size
        i0 = np.minimum(np.floor(q).astype(np.int64), size - 2)
        f = q - i0
        t = tex[:, :, i0] * (1 - f) + tex[:, :, i0 + 1] * f
        t = t[:, i0, :] * (1 - f)[None, :, None] + t[:, i0 + 1, :] * f[None, :, None]
        return t[i0] * (1 - f)[:, None, None] + t[i0 + 1] * f[:, None, None]
    o = 0.01 * size
    return (read(-o) - read(o)).astype(np.float32).ravel()


def _cloud_volume_group(size, data):
    """GN: a Volume Cube over the unit box whose density samples the noise points by voxel index,
    a second cube sampling the JS's shade term, stored into the first as the grid 'shade'
    ('Store Shade Grid'), and a Set Material node ('Set Cloud Material'; build_clouds gives
    each cloud a copy of the group carrying its own material): EEVEE 5.2 renders a Geometry
    Nodes volume on a mesh object with its default volume shader unless the volume carries a
    material (measured: the object's own slot was ignored, the cloud drew as a grey smudge)."""
    name = 'SeedThree Cloud Volume'
    ng = bpy.data.node_groups.get(name)
    if ng is not None and 'Store Shade Grid' in ng.nodes:
        return ng
    if ng is not None:
        ng.name = name + ' (old)'
    # the noise as a point cloud mesh with a 'noise' attribute (0..1) and the shade term, in
    # x-fastest order
    me = bpy.data.meshes.new('SeedThree cloud noise')
    me.vertices.add(len(data))
    me['seedthree_size'] = size
    at = me.attributes.new('noise', 'FLOAT', 'POINT')
    at.data.foreach_set('value', (data.astype(np.float32) / 255.0))
    at = me.attributes.new('shade', 'FLOAT', 'POINT')
    at.data.foreach_set('value', shade_values(data, size))
    me.update()
    src = bpy.data.objects.new('SeedThree cloud noise', me)
    src.hide_render = True
    src.hide_viewport = True
    ng = bpy.data.node_groups.new(name, 'GeometryNodeTree')
    ng.interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    N, L = ng.nodes, ng.links
    gout = N.new('NodeGroupOutput')
    oi = N.new('GeometryNodeObjectInfo')
    oi.inputs['Object'].default_value = src
    cube = N.new('GeometryNodeVolumeCube')
    for k in ('Resolution X', 'Resolution Y', 'Resolution Z'):
        cube.inputs[k].default_value = size
    cube.inputs['Min'].default_value = (-0.5, -0.5, -0.5)
    cube.inputs['Max'].default_value = (0.5, 0.5, 0.5)
    pos = N.new('GeometryNodeInputPosition')
    # Blender cube (X, Y, Z) is three (x, -z, y): the texture's (x, y, z) = (X, Z, -Y) + 0.5
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(pos.outputs[0], sep.inputs[0])

    def idx(sock, neg=False):
        m = N.new('ShaderNodeMath')
        m.operation = 'MULTIPLY_ADD'
        L.new(sock, m.inputs[0])
        m.inputs[1].default_value = -size if neg else size
        m.inputs[2].default_value = size * 0.5 - 0.5
        r = N.new('ShaderNodeMath')
        r.operation = 'ROUND'
        L.new(m.outputs[0], r.inputs[0])
        c = N.new('ShaderNodeClamp')
        L.new(r.outputs[0], c.inputs['Value'])
        c.inputs['Min'].default_value = 0
        c.inputs['Max'].default_value = size - 1
        return c.outputs[0]
    ix, iy, iz = idx(sep.outputs['X']), idx(sep.outputs['Z']), idx(sep.outputs['Y'], neg=True)
    lin = N.new('ShaderNodeMath')
    lin.operation = 'MULTIPLY_ADD'
    L.new(iz, lin.inputs[0])
    lin.inputs[1].default_value = size * size
    l2 = N.new('ShaderNodeMath')
    l2.operation = 'MULTIPLY_ADD'
    L.new(iy, l2.inputs[0])
    l2.inputs[1].default_value = size
    L.new(ix, l2.inputs[2])
    L.new(l2.outputs[0], lin.inputs[2])
    def sampled(attr_name, into):
        attr = N.new('GeometryNodeInputNamedAttribute')
        attr.data_type = 'FLOAT'
        attr.inputs['Name'].default_value = attr_name
        si = N.new('GeometryNodeSampleIndex')
        si.data_type = 'FLOAT'
        si.domain = 'POINT'
        L.new(oi.outputs['Geometry'], si.inputs['Geometry'])
        L.new(attr.outputs[0], si.inputs['Value'])
        L.new(lin.outputs[0], si.inputs['Index'])
        L.new(si.outputs[0], into.inputs['Density'])
    sampled('noise', cube)
    # the shade term on the same voxels: a second cube's grid, stored into the first as 'shade'
    cube2 = N.new('GeometryNodeVolumeCube')
    for k in ('Resolution X', 'Resolution Y', 'Resolution Z'):
        cube2.inputs[k].default_value = size
    cube2.inputs['Min'].default_value = (-0.5, -0.5, -0.5)
    cube2.inputs['Max'].default_value = (0.5, 0.5, 0.5)
    sampled('shade', cube2)
    get = N.new('GeometryNodeGetNamedGrid')
    get.data_type = 'FLOAT'
    get.inputs['Name'].default_value = 'density'
    L.new(cube2.outputs[0], get.inputs['Volume'])
    store = N.new('GeometryNodeStoreNamedGrid')
    store.data_type = 'FLOAT'
    store.name = store.label = 'Store Shade Grid'
    store.inputs['Name'].default_value = 'shade'
    L.new(cube.outputs[0], store.inputs['Volume'])
    L.new(get.outputs['Grid'], store.inputs['Grid'])
    sm = N.new('GeometryNodeSetMaterial')
    sm.name = sm.label = 'Set Cloud Material'
    L.new(store.outputs[0], sm.inputs['Geometry'])
    L.new(sm.outputs[0], gout.inputs[0])
    return ng


def cloud_material(tint=0xe6eef7, range_=0.16, threshold=0.30, opacity=0.13, steps=60, name='SeedThree clouds v2'):
    """The raymarch recipe as an emission + absorption volume. Each JS step takes
    a = smoothstep(threshold +- range, density) x opacity of what is left and adds that share
    of col = 3 x shade + (x + y) 0.25 + 0.2 (+ the tint). As a continuous medium that is an
    absorption of -ln(1 - a) per step, and three's RaymarchingBox takes `steps` x max_i |d_i|
    steps per unit of box length (d the ray's direction in box space), which per metre along
    a world ray u is -ln(1 - a) x steps x max_i(|u_i| / scale_i). EEVEE divides an OBJECT-space
    volume's coefficients by |M n| (n = the normalized (1, 1, 1)), so the shader computes
    -ln(1 - a) x steps x max_i(|u_i| x 'Ray Scale'_i), with Ray Scale = |M n| / scale per
    cloud (build_clouds sets it), and emits that absorption x col. The Principled Volume's
    Density Attribute is cleared: it would multiply the absorption (not the emission) by the
    density grid once more."""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    from ..bl.materials import srgb_to_linear_hex
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes, nt.links
    out = N.new('ShaderNodeOutputMaterial')
    dens = N.new('ShaderNodeAttribute')
    dens.attribute_type = 'GEOMETRY'
    dens.attribute_name = 'density'

    def math(op, a, b=None, clamp=False):
        n = N.new('ShaderNodeMath')
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                L.new(v, n.inputs[i])
        return n.outputs[0]
    mr = N.new('ShaderNodeMapRange')
    mr.interpolation_type = 'SMOOTHSTEP'
    mr.clamp = True
    mr.inputs['From Min'].default_value = threshold - range_
    mr.inputs['From Max'].default_value = threshold + range_
    L.new(dens.outputs['Fac'], mr.inputs['Value'])
    a = math('MULTIPLY', mr.outputs['Result'], opacity)
    sigma = math('MULTIPLY', math('MULTIPLY', math('LOGARITHM', math('SUBTRACT', 1.0, a), 2.718281828459045), -1.0),
                 float(steps))
    # three's step rate along the view ray u (the world view direction; the clouds are not
    # rotated), with EEVEE's OBJECT-space 1 / |M n| undone: max_i(|u_i| x Ray Scale_i)
    geo = N.new('ShaderNodeNewGeometry')
    absu = N.new('ShaderNodeVectorMath')
    absu.operation = 'ABSOLUTE'
    L.new(geo.outputs['Incoming'], absu.inputs[0])
    rs = N.new('ShaderNodeCombineXYZ')
    rs.name = rs.label = 'Ray Scale'
    for i in range(3):
        rs.inputs[i].default_value = 1.0
    per_axis = N.new('ShaderNodeVectorMath')
    per_axis.operation = 'MULTIPLY'
    L.new(absu.outputs[0], per_axis.inputs[0])
    L.new(rs.outputs[0], per_axis.inputs[1])
    su = N.new('ShaderNodeSeparateXYZ')
    L.new(per_axis.outputs[0], su.inputs[0])
    rate = math('MAXIMUM', math('MAXIMUM', su.outputs['X'], su.outputs['Y']), su.outputs['Z'])
    sig = math('MULTIPLY', sigma, rate)
    # colour: 3 x shade + (positionRay.x + positionRay.y) x 0.25 + 0.2 in the box's own frame
    # (three y = Blender Z), + the tint
    tc = N.new('ShaderNodeTexCoord')
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(tc.outputs['Object'], sep.inputs[0])
    shade = N.new('ShaderNodeAttribute')
    shade.attribute_type = 'GEOMETRY'
    shade.attribute_name = 'shade'
    ramp = math('MULTIPLY', math('ADD', sep.outputs['X'], sep.outputs['Z']), 0.25)
    col_v = math('ADD', math('ADD', ramp, 0.2), math('MULTIPLY', shade.outputs['Fac'], 3.0))
    tint_lin = srgb_to_linear_hex(tint)
    cmb = N.new('ShaderNodeCombineXYZ')
    for i in range(3):
        L.new(math('ADD', col_v, tint_lin[i]), cmb.inputs[i])
    vol = N.new('ShaderNodeVolumePrincipled')
    vol.inputs['Color'].default_value = (0, 0, 0, 1)
    vol.inputs['Density Attribute'].default_value = ''
    L.new(sig, vol.inputs['Density'])
    vol.inputs['Absorption Color'].default_value = (0, 0, 0, 1)
    L.new(cmb.outputs[0], vol.inputs['Emission Color'])
    L.new(sig, vol.inputs['Emission Strength'])
    L.new(vol.outputs[0], out.inputs['Volume'])
    return m


def build_clouds(count=5, size=72, spread=55, altitude=70, tint=0xe6eef7, collection=None):
    """buildVolumetricClouds: `count` cloud boxes at the app's hashed places and sizes. Each
    cloud's material carries its box's Ray Scale, so a cloud rescaled later needs a rebuild."""
    data = cloud_noise(size)
    ng = _cloud_volume_group(size, data)
    mat = cloud_material(tint)
    out = []
    for i, c in enumerate(cloud_placements(count, spread, altitude)):
        me = bpy.data.meshes.new('SeedThree cloud %d' % i)
        ob = bpy.data.objects.new('SeedThree cloud %d' % i, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        x, y, z = c['pos']
        ob.location = (x, -z, y)
        w, h, d = c['scale']
        ob.scale = (w, d, h)
        m = mat.copy()
        mn = math.sqrt((w * w + d * d + h * h) / 3.0)          # |M n| of the box's scale
        rs = m.node_tree.nodes['Ray Scale']
        for k, s in enumerate((w, d, h)):
            rs.inputs[k].default_value = mn / s
        ob.data.materials.append(m)
        ngi = ng.copy()                    # this cloud's volume carries its own material
        ngi.name = '%s %d' % (ng.name, i)
        ngi.nodes['Set Cloud Material'].inputs['Material'].default_value = m
        mod = ob.modifiers.new('SeedThree cloud volume', 'NODES')
        mod.node_group = ngi
        ob.visible_shadow = False
        out.append(ob)
    return out


# ---- haze ---------------------------------------------------------------------------------------

def _cnode(tree, *kinds):
    for k in kinds:
        try:
            return tree.nodes.new(k)
        except RuntimeError:
            continue
    raise RuntimeError('no compositor node among %s' % (kinds,))


def build_haze(scene, color=(0.78, 0.83, 0.88), density=1.0, start=110.0, enabled=True, fog_color=None,
               fog_near=95.0, fog_far=300.0):
    """main.js hazeNode as a compositor pass over EEVEE's Position pass. Returns the tree; the
    'Haze Density' / 'Haze Start' values can be keyframed.

    fog_color / fog_near / fog_far: the app's classic range fog (scene.fog), which takes over
    while the haze is off (set_haze_enabled(scene, False), the app's Distance fog toggle and
    its forced preview levels); fog_color defaults to the haze colour.

    The frame renders with a transparent film and the sky comes back from the Environment
    pass, so the haze mixes only the geometry's share of each pixel (its alpha): out =
    image x (1 - f) + haze x f x alpha + sky x (1 - alpha). Each pixel takes the factor of its
    own position, as the app's per-fragment fog does, so a leaf in front of hazed hills keeps
    its colour. EEVEE's Position and Depth passes are not antialiased: an edge pixel can hold
    the sky's empty position while its image still blends geometry in (a dark dashed line
    along the hazed terrain rim). Only such pixels, with no position of their own, take
    their 2 px neighbourhood's factor."""
    for vl in scene.view_layers:
        vl.use_pass_position = True
        vl.use_pass_environment = True
        vl.use_pass_z = True
    scene.render.film_transparent = True
    tree = bpy.data.node_groups.new('SeedThree haze', 'CompositorNodeTree')
    scene.compositing_node_group = tree
    scene.render.use_compositing = True
    N, L = tree.nodes, tree.links
    rl = N.new('CompositorNodeRLayers')
    out = N.new('NodeGroupOutput')
    if not tree.interface.items_tree:
        tree.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')

    def math(op, a, b=None):
        n = _cnode(tree, 'ShaderNodeMath', 'CompositorNodeMath')
        n.operation = op
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                L.new(v, n.inputs[i])
        return n.outputs[0]

    def value(name, v):
        n = _cnode(tree, 'ShaderNodeValue', 'CompositorNodeValue')
        n.name = n.label = name
        n.outputs[0].default_value = v
        return n.outputs[0]

    def smoothstep(x, lo, hi):
        mr = _cnode(tree, 'ShaderNodeMapRange', 'CompositorNodeMapRange')
        try:
            mr.interpolation_type = 'SMOOTHSTEP'
        except (AttributeError, TypeError):
            pass
        mr.clamp = True if hasattr(mr, 'clamp') else None
        L.new(x, mr.inputs['Value'])
        for key, v in (('From Min', lo), ('From Max', hi)):
            if isinstance(v, (int, float)):
                mr.inputs[key].default_value = v
            else:
                L.new(v, mr.inputs[key])
        return mr.outputs[0]
    sep = _cnode(tree, 'ShaderNodeSeparateXYZ', 'CompositorNodeSeparateXYZ')
    L.new(rl.outputs['Position'], sep.inputs[0])
    r = math('SQRT', math('ADD', math('MULTIPLY', sep.outputs[0], sep.outputs[0]),
                          math('MULTIPLY', sep.outputs[1], sep.outputs[1])))
    st = value('Haze Start', start)
    dn = value('Haze Density', density)
    band = smoothstep(r, st, math('ADD', st, 140.0))
    alt = math('EXPONENT', math('MULTIPLY', math('MAXIMUM', sep.outputs[2], 0.0), -0.045))
    ring = math('MULTIPLY', math('MULTIPLY', band, alt), math('MULTIPLY', 0.9, dn))
    ring = math('ADD', ring, smoothstep(r, 245.0, 278.0))
    ring = math('MINIMUM', math('MAXIMUM', ring, 0.0), 1.0)
    # the classic range fog the app falls back to: smoothstep(near, far, view depth)
    depth = rl.outputs['Depth'] if 'Depth' in rl.outputs else rl.outputs['Z']
    rng = smoothstep(depth, value('Fog Near', fog_near), value('Fog Far', fog_far))
    en = value('Haze Enabled', 1.0 if enabled else 0.0)
    on = value('Fog On', 1.0)
    f = math('ADD', math('MULTIPLY', ring, en), math('MULTIPLY', rng, math('SUBTRACT', 1.0, en)))
    # the sky has no position: only where the frame holds geometry (radius > 0)
    has = math('GREATER_THAN', r, 1e-4)
    f = math('MULTIPLY', math('MULTIPLY', f, has), on)
    # Edge pixels with no position of their own (the image blends geometry into the sky
    # there, the pass holds the sky's empty position) borrow their 2 px neighbourhood's
    # factor (a grayscale dilation); every pixel with a position keeps its own factor.
    try:
        dil = tree.nodes.new('CompositorNodeDilateErode')
        L.new(f, dil.inputs['Mask'])
        if 'Size' in dil.inputs:
            dil.inputs['Size'].default_value = 2
            if 'Type' in dil.inputs:
                dil.inputs['Type'].default_value = 'Steps'
        else:
            dil.mode, dil.distance = 'STEP', 2
        dil.name = dil.label = 'Haze edge'
        f = math('ADD', f, math('MULTIPLY', dil.outputs['Mask'], math('SUBTRACT', 1.0, has)))
    except (RuntimeError, KeyError, TypeError, AttributeError):
        pass

    def mixc(blend, fac, a, b):
        """ShaderNodeMix (RGBA): blend(a, b) by fac; a / b sockets or RGBA tuples."""
        n = _cnode(tree, 'ShaderNodeMix')
        n.data_type = 'RGBA'
        n.blend_type = blend
        for sock, v in ((n.inputs[0], fac), (n.inputs[6], a), (n.inputs[7], b)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            elif isinstance(v, tuple):
                sock.default_value = v
            else:
                L.new(v, sock)
        return n.outputs[2]
    alpha = rl.outputs['Alpha']
    black = (0.0, 0.0, 0.0, 1.0)
    fogc = tuple(fog_color or color)
    tint = mixc('MIX', en, (*fogc, 1.0), (*color, 1.0))                      # the haze or the range fog colour
    tint.node.name = tint.node.label = 'Fog Colour'
    geo = mixc('MIX', f, rl.outputs['Image'], black)                         # image x (1 - f)
    geo = mixc('ADD', 1.0, geo, mixc('MIX', math('MULTIPLY', f, alpha), black, tint))  # + colour f alpha
    sky = mixc('MIX', alpha, rl.outputs['Env'] if 'Env' in rl.outputs else rl.outputs['Environment'], black)
    res = mixc('ADD', 1.0, geo, sky)                                          # + sky x (1 - alpha)
    opaque = _cnode(tree, 'CompositorNodeSetAlpha')
    L.new(res, opaque.inputs['Image'])
    opaque.inputs['Alpha'].default_value = 1.0
    if 'Type' in opaque.inputs:
        try:
            opaque.inputs['Type'].default_value = 'Replace Alpha'
        except TypeError:
            pass
    elif hasattr(opaque, 'mode'):
        opaque.mode = 'REPLACE_ALPHA'
    L.new(opaque.outputs['Image'], out.inputs[0])
    return tree


def set_haze_enabled(scene, enabled):
    """The app's Distance fog toggle on a scene whose compositor is the SeedThree haze: on, the
    ring haze; off, the classic range fog the app falls back to (main.js applyFog)."""
    tree = scene.compositing_node_group
    if tree is not None and 'Haze Enabled' in tree.nodes:
        tree.nodes['Haze Enabled'].outputs[0].default_value = 1.0 if enabled else 0.0
        return True
    return False


def set_fog_on(scene, on):
    """Every fog of the SeedThree pass on or off (the app always has one of the two; a film may
    want neither)."""
    tree = scene.compositing_node_group
    if tree is not None and 'Fog On' in tree.nodes:
        tree.nodes['Fog On'].outputs[0].default_value = 1.0 if on else 0.0
        return True
    return False
