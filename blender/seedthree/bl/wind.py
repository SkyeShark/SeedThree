"""SeedThree wind as ONE shared Geometry Nodes group, "SeedThree Wind".

The JS sway (src/core/wind.js) per vertex, from the attributes bl/meshes.py stores:

    t      = scene seconds x speed
    phi    = 0.35 x + 0.27 z  of the anchor in three's WORLD axes
           = 0.35 X - 0.27 Y  in Blender world axes
    sway   = 0.72 sin(1.15 t + phi) + 0.28 sin(2.63 t + 1.9 phi)
    offset = windDir x st_wind x 0.35 x strength x sway(world(st_anchor))
           + strength x (sin(f) st_fx + sin(1.31 f) st_fy + sin(0.77 f) st_fz),
             f = t x 5.2 + st_fphase                          (leaf/crown flutter)

windDir is the JS heading (0.85, 0, 0.53) -> Blender world (0.85, -0.53, 0),
rotated into each object's space through its world matrix, so a rotated tree
sways the same way as its neighbours. It is a deformation (Set Position), so
EEVEE gets real motion vectors and shadows from it. Strength and speed are two
Value nodes inside the group: set_wind() writes them, and they can be keyframed
per shot (group.nodes['Wind Strength'].outputs[0].default_value).
"""

import math

import bpy

GROUP = 'SeedThree Wind'
DIR = (0.85, -0.53, 0.0)


def _n(nt, kind, x, y, **props):
    n = nt.nodes.new(kind)
    n.location = (x, y)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def _math(nt, op, a, b=None, x=0, y=0):
    n = _n(nt, 'ShaderNodeMath', x, y, operation=op)
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def _vscale(nt, vec, s, x=0, y=0):
    n = _n(nt, 'ShaderNodeVectorMath', x, y, operation='SCALE')
    nt.links.new(vec, n.inputs[0])
    if isinstance(s, (int, float)):
        n.inputs['Scale'].default_value = s
    else:
        nt.links.new(s, n.inputs['Scale'])
    return n.outputs['Vector']


def _vadd(nt, a, b, x=0, y=0):
    n = _n(nt, 'ShaderNodeVectorMath', x, y, operation='ADD')
    nt.links.new(a, n.inputs[0])
    nt.links.new(b, n.inputs[1])
    return n.outputs['Vector']


def _attr(nt, name, vector, x, y):
    n = _n(nt, 'GeometryNodeInputNamedAttribute', x, y, data_type='FLOAT_VECTOR' if vector else 'FLOAT')
    n.inputs['Name'].default_value = name
    return n.outputs['Attribute']


def wind_group():
    ng = bpy.data.node_groups.get(GROUP)
    if ng is not None:
        return ng
    ng = bpy.data.node_groups.new(GROUP, 'GeometryNodeTree')
    ng.interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nt = ng
    gin = _n(nt, 'NodeGroupInput', -1400, 0)
    gout = _n(nt, 'NodeGroupOutput', 800, 0)
    strength = _n(nt, 'ShaderNodeValue', -1400, -300, name='Wind Strength', label='Wind Strength')
    strength.outputs[0].default_value = 0.5
    speed = _n(nt, 'ShaderNodeValue', -1400, -420, name='Wind Speed', label='Wind Speed')
    speed.outputs[0].default_value = 1.0
    st = _n(nt, 'GeometryNodeInputSceneTime', -1400, -540)
    t = _math(nt, 'MULTIPLY', st.outputs['Seconds'], speed.outputs[0], -1200, -500)

    selfo = _n(nt, 'GeometryNodeSelfObject', -1400, 300)
    oi = _n(nt, 'GeometryNodeObjectInfo', -1200, 300, transform_space='ORIGINAL')
    nt.links.new(selfo.outputs[0], oi.inputs['Object'])
    mat = oi.outputs['Transform']
    inv = _n(nt, 'FunctionNodeInvertMatrix', -1000, 380)
    nt.links.new(mat, inv.inputs[0])
    tdir = _n(nt, 'FunctionNodeTransformDirection', -800, 380)
    ln = math.sqrt(DIR[0] ** 2 + DIR[1] ** 2 + DIR[2] ** 2)
    tdir.inputs['Direction'].default_value = (DIR[0] / ln, DIR[1] / ln, DIR[2] / ln)
    nt.links.new(inv.outputs['Matrix'], tdir.inputs['Transform'])
    dir_obj = tdir.outputs[0]

    anchor = _attr(nt, 'st_anchor', True, -1200, 120)
    tp = _n(nt, 'FunctionNodeTransformPoint', -1000, 160)
    nt.links.new(anchor, tp.inputs['Vector'])
    nt.links.new(mat, tp.inputs['Transform'])
    sep = _n(nt, 'ShaderNodeSeparateXYZ', -800, 160)
    nt.links.new(tp.outputs[0], sep.inputs[0])
    phi = _math(nt, 'ADD', _math(nt, 'MULTIPLY', sep.outputs['X'], 0.35, -650, 200),
                _math(nt, 'MULTIPLY', sep.outputs['Y'], -0.27, -650, 120), -500, 160)
    s1 = _math(nt, 'SINE', _math(nt, 'ADD', _math(nt, 'MULTIPLY', t, 1.15, -650, -40), phi, -500, -40), None, -350, -40)
    s2 = _math(nt, 'SINE', _math(nt, 'ADD', _math(nt, 'MULTIPLY', t, 2.63, -650, -120),
                                 _math(nt, 'MULTIPLY', phi, 1.9, -500, -200), -500, -120), None, -350, -120)
    sway = _math(nt, 'ADD', _math(nt, 'MULTIPLY', s1, 0.72, -200, -40), _math(nt, 'MULTIPLY', s2, 0.28, -200, -120), -50, -80)
    w = _attr(nt, 'st_wind', False, -350, 60)
    amp = _math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', w, strength.outputs[0], -200, 60), 0.35, -50, 60)
    base = _vscale(nt, dir_obj, _math(nt, 'MULTIPLY', amp, sway, 100, 0), 250, 200)

    fphase = _attr(nt, 'st_fphase', False, -650, -380)
    f = _math(nt, 'ADD', _math(nt, 'MULTIPLY', t, 5.2, -500, -320), fphase, -350, -340)
    fl = None
    for i, (nm, k) in enumerate((('st_fx', 1.0), ('st_fy', 1.31), ('st_fz', 0.77))):
        v = _attr(nt, nm, True, -200, -300 - 90 * i)
        sn = _math(nt, 'SINE', _math(nt, 'MULTIPLY', f, k, -200, -560 - 60 * i) if k != 1.0 else f, None, -50, -560 - 60 * i)
        term = _vscale(nt, v, sn, 100, -300 - 90 * i)
        fl = term if fl is None else _vadd(nt, fl, term, 250, -300 - 90 * i)
    flutter = _vscale(nt, fl, strength.outputs[0], 400, -300)

    offset = _vadd(nt, base, flutter, 550, 0)
    sp = _n(nt, 'GeometryNodeSetPosition', 650, 100)
    nt.links.new(gin.outputs[0], sp.inputs['Geometry'])
    nt.links.new(offset, sp.inputs['Offset'])
    nt.links.new(sp.outputs[0], gout.inputs[0])
    return ng


def add_wind(ob):
    mod = ob.modifiers.get('SeedThree Wind') or ob.modifiers.new('SeedThree Wind', 'NODES')
    mod.node_group = wind_group()
    return mod


def set_wind(strength=None, speed=None):
    """Shared by every SeedThree tree in the file (JS default 0.5 / 1.0).
    Keyframe group.nodes['Wind Strength'].outputs[0].default_value for gusts."""
    ng = wind_group()
    if strength is not None:
        ng.nodes['Wind Strength'].outputs[0].default_value = float(strength)
    if speed is not None:
        ng.nodes['Wind Speed'].outputs[0].default_value = float(speed)
    return {'strength': ng.nodes['Wind Strength'].outputs[0].default_value,
            'speed': ng.nodes['Wind Speed'].outputs[0].default_value}
