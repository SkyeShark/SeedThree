"""The backlight sun: SeedThree's leaf, frond and spine glow, ported to EEVEE.

The JS materials are three's MeshSSSNodeMaterial. For each direct light it adds
a Barre-Brisebois term to the diffuse light:

    H    = normalize(L + N x distortion)
    glow = (saturate(dot(V, -H)) ^ power x scale + ambient) x thicknessColor x lightColor

L points to the light, V to the eye, N is the shading normal. In three r184
lightColor carries the sun's shadow-map sample when the mesh receives shadows
(SeedThree's foliage does), so the glow is shadowed: a leaf behind other leaves
does not glow. N is three's normalView inside the lighting model: the
material's final shading normal (for leaves, the canopy dome plus relief).

EEVEE has no custom light lobe. Each material computes the view-dependent factor
k = saturate(V . -H)^power x scale + ambient in its node tree (V = Geometry >
Incoming, L from the group below) and feeds pi x k x thicknessColor into a
Translucent BSDF on the material's own shading normal N. EEVEE answers the sun
with k x thicknessColor x E x max(0, -N.L) x shadow: the JS term times the
leaf's Lambert irradiance factor. Measured in EEVEE 5.2 (blender/tests/trees/
backlight_check.py in eidoverse, and the README) on the way there:

  - The Translucent BSDF must share the diffuse's normal. With another normal
    (say -L, which would have made the response orientation-free like the JS)
    EEVEE keeps one diffuse-type closure and the Principled diffuse is dropped.
  - The card's Thickness must be linked to 0. Unlinked, EEVEE takes about the
    object's size as the slab: a canopy never shadows its own transmission and
    the colour acts twice (colour^2).
  - At Thickness 0 EEVEE self-shadows a card lit from behind at a grazing
    angle (from ~45 degrees off the card normal, fully past ~55); no shadow
    setting removes it.
  - EEVEE lights the closure with the world too, unoccluded unless a Light
    Probe Volume is baked (bl/probe.py): bake one, or the canopy glows evenly.

L comes from ONE shared shader node group, "SeedThree Sun": the world direction
toward the bound sun lamp (the lamp's local +Z), driven by its world rotation.
The drivers are simple expressions, so they run without Python script
execution. create_tree binds the strongest sun lamp in the scene when the group
is unbound; set_sun(obj) rebinds every SeedThree plant in the file. While
unbound, the group points straight up.
"""

import math

import bpy

GROUP = 'SeedThree Sun'
NODE = 'Sun Dir'
# rotate (0, 0, 1) by the unit quaternion (w, x, y, z)
_EXPR = ('2*(x*z + w*y)', '2*(y*z - w*x)', '1 - 2*(x*x + y*y)')
_UP = (0.0, 0.0, 1.0)


BOUND = 'Sun Bound'
IRRADIANCE = 'Sun Irradiance'


def _irradiance_output(ng):
    """The group's third output, 'Irradiance': the bound lamp's colour x strength (three's
    lightColor for a directional light, unshadowed), 0 unbound. The billboard's flat ambient
    scatter reads it (the card receives no shadow, so no light loop is needed)."""
    if IRRADIANCE in ng.nodes:
        return
    ng.interface.new_socket(name='Irradiance', in_out='OUTPUT', socket_type='NodeSocketVector')
    c = ng.nodes.new('ShaderNodeCombineXYZ')
    c.name = c.label = IRRADIANCE
    c.location = (-100, -350)
    for i in range(3):
        c.inputs[i].default_value = 0.0
    out = next(n for n in ng.nodes if n.type == 'GROUP_OUTPUT')
    ng.links.new(c.outputs[0], out.inputs['Irradiance'])


def _bound_output(ng):
    """The group's second output, 'Bound': 1 while a lamp is bound (set_sun), 0 unbound. The
    glow reads only a bound sun (an unbound group points straight up at no lamp)."""
    if BOUND in ng.nodes:
        return
    ng.interface.new_socket(name='Bound', in_out='OUTPUT', socket_type='NodeSocketFloat')
    v = ng.nodes.new('ShaderNodeValue')
    v.name = v.label = BOUND
    v.location = (-100, -200)
    v.outputs[0].default_value = 0.0
    out = next(n for n in ng.nodes if n.type == 'GROUP_OUTPUT')
    ng.links.new(v.outputs[0], out.inputs['Bound'])


def sun_group():
    ng = bpy.data.node_groups.get(GROUP)
    if ng is not None and ng.bl_idname == 'ShaderNodeTree' and NODE in ng.nodes:
        _bound_output(ng)    # files from before the glow route lack it
        _irradiance_output(ng)
        return ng
    ng = bpy.data.node_groups.new(GROUP, 'ShaderNodeTree')
    ng.interface.new_socket(name='Direction', in_out='OUTPUT', socket_type='NodeSocketVector')
    cx = ng.nodes.new('ShaderNodeCombineXYZ')
    cx.name = cx.label = NODE
    cx.location = (-300, 0)
    for i, v in enumerate(_UP):
        cx.inputs[i].default_value = v
    nrm = ng.nodes.new('ShaderNodeVectorMath')
    nrm.operation = 'NORMALIZE'
    nrm.location = (-100, 0)
    out = ng.nodes.new('NodeGroupOutput')
    out.location = (100, 0)
    ng.links.new(cx.outputs[0], nrm.inputs[0])
    ng.links.new(nrm.outputs['Vector'], out.inputs[0])
    _bound_output(ng)
    _irradiance_output(ng)
    return ng


DIRECT_GROUP = 'SeedThree Sun Direct'
DIRECT_EPS_DEG = 10.0


def sun_direct_group():
    """The bound sun's DIRECT light at the shading point, E x shadow / pi, for the 'glow'
    backlight (bl/materials.py): the JS's SSS term reads lightColor, the sun's shadowed
    irradiance alone, with no world light and no Lambert factor.

    EEVEE gives no light alone, so the group reads it through Shader to RGB of four white
    Translucent BSDFs. A Translucent BSDF on normal -n is lit as E x shadow x max(0, n.L) /
    pi plus the probe / world irradiance I(n) / pi, and EEVEE's diffuse irradiance is an L1
    spherical harmonic: affine in n. Facing n = L the read is (E s + I(L)) / pi; three reads
    the sun cannot reach (n_a, n_b = 10 degrees below the sun's horizon on either side of
    L, and -L) give I(L) exactly:
        I(L) = (I(n_a) + I(n_b) - 2 sin(e) I(-L)) / (1 - sin(e)) - I(-L)
    so (E s) / pi = read(L) - I(L) / pi. The transmission route is shadowed from the side
    the sun is on, so a card lit from behind does not shadow itself (the shading normal
    of a Diffuse BSDF would put the shadow lookup on the card's dark side); the plant
    objects' shadow normal offset (materials.shadow_bias, the app's normalBias 0.04)
    keeps grazing cards clear too. Other lamps also reach these reads, weighted by
    their angle to the bound sun: light-link fill lamps away from the plants."""
    ng = bpy.data.node_groups.get(DIRECT_GROUP)
    if ng is not None and ng.bl_idname == 'ShaderNodeTree' and ng.get('st_version') == 2:
        return ng
    if ng is None:
        ng = bpy.data.node_groups.new(DIRECT_GROUP, 'ShaderNodeTree')
    else:
        ng.nodes.clear()
        ng.interface.clear()
    ng['st_version'] = 2
    ng.interface.new_socket(name='Direct', in_out='OUTPUT', socket_type='NodeSocketColor')
    N, Lk = ng.nodes, ng.links
    x = [0]

    def node(kind, **props):
        n = N.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        n.location = (x[0], 0)
        x[0] += 40
        return n

    def vm(op, a, b=None, scale=None):
        n = node('ShaderNodeVectorMath', operation=op)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (tuple, list)):
                n.inputs[i].default_value = v
            else:
                Lk.new(v, n.inputs[i])
        if scale is not None:
            n.inputs['Scale'].default_value = scale
        return n.outputs['Value'] if op in ('LENGTH', 'DOT_PRODUCT') else n.outputs['Vector']

    sun = node('ShaderNodeGroup')
    sun.node_tree = sun_group()
    L = sun.outputs[0]
    # a unit vector across L, from whichever world axis is farther from it
    c1 = vm('CROSS_PRODUCT', L, (0.0, 0.0, 1.0))
    c2 = vm('CROSS_PRODUCT', L, (1.0, 0.0, 0.0))
    use1 = node('ShaderNodeMath', operation='GREATER_THAN')
    Lk.new(vm('LENGTH', c1), use1.inputs[0])
    use1.inputs[1].default_value = 0.3
    pick = node('ShaderNodeMix', data_type='VECTOR')
    Lk.new(use1.outputs[0], pick.inputs[0])
    Lk.new(c2, pick.inputs[4])
    Lk.new(c1, pick.inputs[5])
    p = vm('NORMALIZE', pick.outputs[1])
    se = math.sin(math.radians(DIRECT_EPS_DEG))
    ce = math.cos(math.radians(DIRECT_EPS_DEG))
    below = vm('SCALE', L, scale=-se)
    na = vm('ADD', vm('SCALE', p, scale=ce), below)
    nb = vm('ADD', vm('SCALE', p, scale=-ce), below)
    negL = vm('SCALE', L, scale=-1.0)

    def read(n):
        """Shader to RGB of a white Translucent BSDF lit from the hemisphere around n."""
        t = node('ShaderNodeBsdfTranslucent')
        t.inputs['Color'].default_value = (1.0, 1.0, 1.0, 1.0)
        Lk.new(vm('SCALE', n, scale=-1.0), t.inputs['Normal'])
        s2r = node('ShaderNodeShaderToRGB')
        Lk.new(t.outputs[0], s2r.inputs[0])
        return s2r.outputs['Color']

    r_l, r_a, r_b, r_m = read(L), read(na), read(nb), read(negL)
    s = vm('SUBTRACT', vm('ADD', r_a, r_b), vm('SCALE', r_m, scale=2.0 * se))
    i_l = vm('SUBTRACT', vm('SCALE', s, scale=1.0 / (1.0 - se)), r_m)
    direct = vm('MAXIMUM', vm('SUBTRACT', r_l, i_l), (0.0, 0.0, 0.0))
    # no bound sun lamp: no glow (an unbound group points up at no lamp)
    bound = node('ShaderNodeVectorMath', operation='SCALE')
    Lk.new(direct, bound.inputs[0])
    Lk.new(sun.outputs['Bound'], bound.inputs['Scale'])
    out = node('NodeGroupOutput')
    Lk.new(bound.outputs['Vector'], out.inputs[0])
    return ng


def bound_sun():
    """The lamp the group follows, or None (unbound, or its lamp was deleted)."""
    ng = bpy.data.node_groups.get(GROUP)
    if ng is None or ng.animation_data is None:
        return None
    for fc in ng.animation_data.drivers:
        for v in fc.driver.variables:
            ob = v.targets[0].id
            if v.type == 'TRANSFORMS' and isinstance(ob, bpy.types.Object):   # (the irradiance reads the lamp data)
                return ob
    return None


def find_sun(scene=None):
    """The strongest render-visible sun lamp in the scene."""
    scene = scene or bpy.context.scene
    best = None
    for ob in scene.objects:
        if ob.get('seedthree_twin'):
            continue    # a cast-only receivers' twin (bl/cast_only.py) follows its sun; never the key
        if ob.type == 'LIGHT' and ob.data.type == 'SUN' and not ob.hide_render:
            if best is None or ob.data.energy > best.data.energy:
                best = ob
    return best


def set_sun(sun):
    """Point every SeedThree backlight at `sun` (a sun lamp object; None unbinds)."""
    if sun is not None and (sun.type != 'LIGHT' or sun.data.type != 'SUN'):
        raise TypeError('[seedthree] set_sun wants a SUN lamp object, got %r' % sun)
    ng = sun_group()
    node = ng.nodes[NODE]
    ng.nodes[BOUND].outputs[0].default_value = 0.0 if sun is None else 1.0
    irr = ng.nodes[IRRADIANCE]
    for i in range(3):
        sock = irr.inputs[i]
        sock.driver_remove('default_value')
        sock.default_value = 0.0
        if sun is None:
            continue
        drv = sock.driver_add('default_value').driver
        drv.type = 'SCRIPTED'
        drv.expression = 'e * c'
        for vname, path in (('e', 'energy'), ('c', 'color[%d]' % i)):
            v = drv.variables.new()
            v.name = vname
            v.type = 'SINGLE_PROP'
            v.targets[0].id_type = 'LIGHT'
            v.targets[0].id = sun.data
            v.targets[0].data_path = path
    for i, expr in enumerate(_EXPR):
        sock = node.inputs[i]
        sock.driver_remove('default_value')
        if sun is None:
            sock.default_value = _UP[i]
            continue
        drv = sock.driver_add('default_value').driver
        drv.type = 'SCRIPTED'
        drv.expression = expr
        for comp in 'wxyz':
            v = drv.variables.new()
            v.name = comp
            v.type = 'TRANSFORMS'
            t = v.targets[0]
            t.id = sun
            t.transform_type = 'ROT_' + comp.upper()
            t.rotation_mode = 'QUATERNION'
            t.transform_space = 'WORLD_SPACE'
    if sun is not None:
        # the billboards' cast-only light links follow the same sun (bl/cast_only.py)
        from .cast_only import relink
        relink(sun)
    return sun


def ensure_sun(sun=None, scene=None):
    """Bind `sun`; with no sun given, keep a live binding or bind the scene's strongest sun lamp."""
    if sun is not None:
        return set_sun(sun)
    ng = sun_group()
    cur = bound_sun()
    if cur is not None:
        ng.nodes[BOUND].outputs[0].default_value = 1.0   # a binding from a file older than the flag
        return cur
    found = find_sun(scene)
    if found is not None:
        return set_sun(found)
    if ng.nodes[BOUND].outputs[0].default_value:
        set_sun(None)     # the bound lamp was deleted: point up, no glow
    return None
