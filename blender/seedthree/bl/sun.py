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

import bpy

GROUP = 'SeedThree Sun'
NODE = 'Sun Dir'
# rotate (0, 0, 1) by the unit quaternion (w, x, y, z)
_EXPR = ('2*(x*z + w*y)', '2*(y*z - w*x)', '1 - 2*(x*x + y*y)')
_UP = (0.0, 0.0, 1.0)


def sun_group():
    ng = bpy.data.node_groups.get(GROUP)
    if ng is not None and ng.bl_idname == 'ShaderNodeTree' and NODE in ng.nodes:
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
    return ng


def bound_sun():
    """The lamp the group follows, or None (unbound, or its lamp was deleted)."""
    ng = bpy.data.node_groups.get(GROUP)
    if ng is None or ng.animation_data is None:
        return None
    for fc in ng.animation_data.drivers:
        for v in fc.driver.variables:
            ob = v.targets[0].id
            if ob is not None:
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
    sun_group()
    cur = bound_sun()
    if cur is not None:
        return cur
    found = find_sun(scene)
    if found is not None:
        return set_sun(found)
    return None
