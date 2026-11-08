"""The billboard forest ring with per-instance LOD and instanced wind (main.js
updateForest / rebinForest, tree.js forestBarkMaterial, branch-cards.js
forestCardMaterial, wind.js instancedBarkWindPosition), as one Geometry Nodes object.

    from seedthree.bl.forest import make_forest_ring
    forest = make_forest_ring(tree, count=64, seed=1, height_at=terrain.height_at)

The grove is the hero plant's own species, GPU-instanced in the app; here one object
whose Geometry Nodes instance the plant's near level (LOD2, the hybrid card level, by
default) on every slot nearer to the active camera than the billboard distance, and
the baked billboard on the rest: the app's per-instance LOD rebin, re-evaluated per
frame as the camera moves. The near trees are realized so each can sway on its own:

  phase      every vertex of a slot takes its sway sample at the slot's base (the app's
             per-slot aAnchorPos: a distant copy sways coherently, cards welded to wood)
  direction  the world wind heading for every slot (the app pre-rotates aWindVec by the
             slot's inverse yaw; realized geometry needs no inverse)
  amplitude  the plant's own per-vertex weights (bark aWind, card tip / base weights),
             so a slot's scale does not change how far it moves (aWindVec's 1/s)
  flutter    the card / leaf flutter axes turned with the slot's yaw and scale
  dome       the canopy-dome vector turned with the slot (forestCardMaterial's per-slot
             aTreeOrigin)

The far billboards do not sway (the app's do not either). They live in a second object
on the same slots ('<forest> billboards'), so they alone can cast the sun's shadow
without receiving it, the app's billboard policy (bl/cast_only.py). The app fades an
analytic sun occlusion onto grove cards beyond its 74 m shadow frustum; EEVEE's shadows
reach every distance, so the near cards here are shadowed for real instead.
"""

import math

import bpy
import numpy as np

from ..core.forest import forest_slots
from .wind import wind_group


def _n(nt, kind, x, y, **props):
    n = nt.nodes.new(kind)
    n.location = (x, y)
    for k, v in props.items():
        setattr(n, k, v)
    return n


def _attr(nt, name, kind, x, y):
    n = _n(nt, 'GeometryNodeInputNamedAttribute', x, y, data_type=kind)
    n.inputs['Name'].default_value = name
    return n.outputs['Attribute']


def _store(nt, geo, name, kind, value, x, y):
    n = _n(nt, 'GeometryNodeStoreNamedAttribute', x, y, data_type=kind, domain='POINT')
    nt.links.new(geo, n.inputs['Geometry'])
    n.inputs['Name'].default_value = name
    nt.links.new(value, n.inputs['Value'])
    return n.outputs['Geometry']


def _source_collection(name, objs, offset_z=0.0):
    """A collection (not linked to the scene) of wind-free copies of the given parts, in the
    plant's own frame."""
    col = bpy.data.collections.get(name)
    if col is not None:
        for ob in list(col.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
    else:
        col = bpy.data.collections.new(name)
    for ob in objs:
        if ob.type != 'MESH':
            continue
        c = bpy.data.objects.new(ob.name + ' [forest]', ob.data)
        col.objects.link(c)
        c.location = (0.0, 0.0, offset_z)
    return col


def forest_group(name, near_col, bb_col, bb_dist, half_h, wind=True, part='both'):
    """part: 'near' (the swaying near level only), 'far' (the realized billboards only) or 'both'."""
    ng = bpy.data.node_groups.get(name)
    if ng is not None:
        bpy.data.node_groups.remove(ng)
    ng = bpy.data.node_groups.new(name, 'GeometryNodeTree')
    ng.interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    nt = ng
    L = nt.links.new
    gin = _n(nt, 'NodeGroupInput', -1600, 0)
    gout = _n(nt, 'NodeGroupOutput', 1400, 0)
    bbd = _n(nt, 'ShaderNodeValue', -1600, -300, name='Billboard Distance', label='Billboard Distance')
    bbd.outputs[0].default_value = float(bb_dist if bb_col is not None else 1e9)
    # slot positions kept for the per-slot wind phase
    pts = _store(nt, gin.outputs[0], 'st_slot', 'FLOAT_VECTOR', _n(nt, 'GeometryNodeInputPosition', -1600, 200).outputs[0],
                 -1400, 100)
    cam = _n(nt, 'GeometryNodeInputActiveCamera', -1600, -450)
    oi = _n(nt, 'GeometryNodeObjectInfo', -1400, -450, transform_space='ORIGINAL')
    L(cam.outputs[0], oi.inputs['Object'])
    dist = _n(nt, 'ShaderNodeVectorMath', -1200, -300, operation='DISTANCE')
    L(_n(nt, 'GeometryNodeInputPosition', -1400, -250).outputs[0], dist.inputs[0])
    L(oi.outputs['Location'], dist.inputs[1])
    far = _n(nt, 'ShaderNodeMath', -1000, -300, operation='GREATER_THAN')
    L(dist.outputs['Value'], far.inputs[0])
    L(bbd.outputs[0], far.inputs[1])
    near = _n(nt, 'ShaderNodeMath', -800, -200, operation='SUBTRACT')
    near.inputs[0].default_value = 1.0
    L(far.outputs[0], near.inputs[1])
    rot = _n(nt, 'ShaderNodeCombineXYZ', -1000, -600)
    L(_attr(nt, 'st_rot', 'FLOAT', -1200, -600), rot.inputs[2])
    scl = _attr(nt, 'st_scale', 'FLOAT', -1200, -700)

    ci = _n(nt, 'GeometryNodeCollectionInfo', -800, 300, transform_space='ORIGINAL')
    ci.inputs['Collection'].default_value = near_col
    ci.inputs['Separate Children'].default_value = False
    ci.inputs['Reset Children'].default_value = False
    iop = _n(nt, 'GeometryNodeInstanceOnPoints', -600, 200)
    L(pts, iop.inputs['Points'])
    L(near.outputs[0], iop.inputs['Selection'])
    L(ci.outputs[0], iop.inputs['Instance'])
    L(rot.outputs[0], iop.inputs['Rotation'])
    L(scl, iop.inputs['Scale'])
    real = _n(nt, 'GeometryNodeRealizeInstances', -400, 200)
    L(iop.outputs[0], real.inputs[0])
    geo = real.outputs[0]
    # per-slot wind: phase at the slot base; flutter axes and dome turned with the slot
    geo = _store(nt, geo, 'st_anchor', 'FLOAT_VECTOR', _attr(nt, 'st_slot', 'FLOAT_VECTOR', -400, 0), -200, 200)
    ang = _attr(nt, 'st_rot', 'FLOAT', -400, -100)
    sc2 = _attr(nt, 'st_scale', 'FLOAT', -400, -200)
    x = 0
    for nm, scaled in (('st_fx', True), ('st_fy', True), ('st_fz', True), ('st_dome', False)):
        vr = _n(nt, 'ShaderNodeVectorRotate', x, -100, rotation_type='Z_AXIS')
        L(_attr(nt, nm, 'FLOAT_VECTOR', x - 150, -150), vr.inputs['Vector'])
        L(ang, vr.inputs['Angle'])
        val = vr.outputs[0]
        if scaled:
            sm = _n(nt, 'ShaderNodeVectorMath', x + 100, -150, operation='SCALE')
            L(val, sm.inputs[0])
            L(sc2, sm.inputs['Scale'])
            val = sm.outputs['Vector']
        geo = _store(nt, geo, nm, 'FLOAT_VECTOR', val, x + 200, 200)
        x += 250
    if wind:
        wg = _n(nt, 'GeometryNodeGroup', x + 200, 200)
        wg.node_tree = wind_group()
        L(geo, wg.inputs[0])
        geo = wg.outputs[0]
    join = _n(nt, 'GeometryNodeJoinGeometry', 1200, 0)
    if bb_col is not None and part in ('far', 'both'):
        # far: the billboard pair, card centre at ground + s (halfH - 0.4); slots sit 0.3 s deep
        off = _n(nt, 'ShaderNodeCombineXYZ', -800, -800)
        mz = _n(nt, 'ShaderNodeMath', -1000, -850, operation='MULTIPLY')
        L(scl, mz.inputs[0])
        mz.inputs[1].default_value = float(half_h - 0.1)
        L(mz.outputs[0], off.inputs[2])
        sp = _n(nt, 'GeometryNodeSetPosition', -600, -700)
        L(gin.outputs[0], sp.inputs['Geometry'])
        L(off.outputs[0], sp.inputs['Offset'])
        bci = _n(nt, 'GeometryNodeCollectionInfo', -800, -1000, transform_space='ORIGINAL')
        bci.inputs['Collection'].default_value = bb_col
        bci.inputs['Separate Children'].default_value = False
        bci.inputs['Reset Children'].default_value = False
        biop = _n(nt, 'GeometryNodeInstanceOnPoints', -400, -700)
        L(sp.outputs[0], biop.inputs['Points'])
        L(far.outputs[0], biop.inputs['Selection'])
        L(bci.outputs[0], biop.inputs['Instance'])
        L(rot.outputs[0], biop.inputs['Rotation'])
        L(scl, biop.inputs['Scale'])
        # kept as instances: each card's material reads its own instance origin (Object Info)
        L(biop.outputs[0], join.inputs[0])
    if part in ('near', 'both'):
        L(geo, join.inputs[0])
    L(join.outputs[0], gout.inputs[0])
    return ng


def make_forest_ring(tree, count=64, seed=None, near_level='LOD2', billboard=True, billboard_dist=None,
                     height_at=None, meadow_at=None, collection=None, name=None, wind=True):
    """The grove around the hero: `count` slots (the app's forestCount, 64) of the plant's
    `near_level`, the baked billboard beyond `billboard_dist` from the active camera.

    tree: a create_tree result with near_level built (grow with level='ALL' or the
    level itself) and, for billboard=True, its billboard (create_tree(..., billboard=True)
    or cards.bake_impostor). height_at(x, y) / meadow_at(x, y): Blender world X/Y -> the
    ground height / the meadow mask (the demo terrain provides both); None = flat.
    Returns the forest object; its modifier's group has a 'Billboard Distance' value."""
    root = tree['object']
    seed = seed if seed is not None else root.get('seedthree_seed', 1)
    near_objs = tree['objects'].get(near_level)
    if not near_objs:
        raise ValueError('[seedthree] make_forest_ring: the plant has no %s level built' % near_level)
    bb = tree.get('billboard') if billboard else None
    if billboard and bb is None:
        raise ValueError('[seedthree] make_forest_ring: bake the billboard first (create_tree(..., billboard=True))')
    lod = tree.get('lod') or {}
    bb_dist = billboard_dist if billboard_dist is not None else float(lod.get('billboardDist') or 120)
    center = (0.0, 6.0, 0.0)
    cards = tree.get('cards')
    for part in (l['parts'].get('foliage') for l in tree['tree']['levels'] if l['name'] == near_level):
        if part and part.get('kind') == 'cardSet':
            center = tuple(part['center'])
    h3 = (lambda x, z: height_at(x, -z)) if height_at else None
    m3 = (lambda x, z: meadow_at(x, -z)) if meadow_at else None
    slots = forest_slots(count, seed, h3, m3, center)
    label = name or ('%s forest' % root.name)
    me = bpy.data.meshes.new(label)
    P = np.array([(s['pos'][0], -s['pos'][2], s['pos'][1]) for s in slots], np.float32)
    me.vertices.add(len(P))
    me.vertices.foreach_set('co', P.ravel())
    for nm, vals in (('st_rot', [s['rot'] for s in slots]), ('st_scale', [s['s'] for s in slots]),
                     ('st_ground', [s['ground'] for s in slots])):
        at = me.attributes.new(nm, 'FLOAT', 'POINT')
        at.data.foreach_set('value', np.array(vals, np.float32))
    me.update()
    col = collection or (root.users_collection[0] if root.users_collection else bpy.context.scene.collection)
    # the grove takes the near level's bark and foliage only (main.js: spines and fruit are
    # hero-only near detail)
    from .export import role_of
    grove_parts = [o for o in near_objs if role_of(o) in ('bark', 'cards', 'foliage', 'fronds')] or near_objs
    near_col = _source_collection('%s near source' % label, grove_parts, 0.0)
    bb_col = None
    half_h = 1.0
    if bb is not None:
        bb_col = bpy.data.collections.get('%s billboard source' % label) or bpy.data.collections.new('%s billboard source' % label)
        for o in list(bb_col.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        for card in bb['cards']:
            c = bpy.data.objects.new(card.name + ' [forest]', card.data)
            bb_col.objects.link(c)
            c.location = (0.0, 0.0, 0.0)
            c.visible_shadow = card.visible_shadow
        half_h = bb['halfH']
    # two objects on the same slots: the swaying near trees, and the far billboards (so the
    # billboards alone can cast without receiving, as in the app)
    ob = bpy.data.objects.new(label, me)
    col.objects.link(ob)
    ng = forest_group('%s grove' % label, near_col, bb_col, bb_dist, half_h, wind, part='near')
    ob.modifiers.new('SeedThree Forest', 'NODES').node_group = ng
    ob['seedthree_forest'] = True
    ob['allow_intersect'] = True
    groups = [ng]
    ob_far = None
    if bb_col is not None:
        ob_far = bpy.data.objects.new(label + ' billboards', me)
        col.objects.link(ob_far)
        ng_far = forest_group('%s grove billboards' % label, near_col, bb_col, bb_dist, half_h, False, part='far')
        ob_far.modifiers.new('SeedThree Forest', 'NODES').node_group = ng_far
        ob_far['seedthree_forest'] = True
        ob_far['allow_intersect'] = True
        groups.append(ng_far)
        if any('seedthree_cast_only' in c for c in bb['cards']):
            from .cast_only import link
            from .sun import bound_sun, find_sun
            link([ob_far] + list(bb_col.objects), bound_sun() or find_sun())
    return {'object': ob, 'billboard_object': ob_far, 'slots': slots, 'near': near_col, 'billboards': bb_col,
            'group': ng, 'groups': groups, 'billboardDist': bb_dist}


def set_billboard_distance(forest, dist):
    """Move the near-trees / billboards switch of a forest ring (both of its objects)."""
    if isinstance(forest, dict):
        groups = forest.get('groups') or [forest['group']]
    else:
        groups = [forest.modifiers['SeedThree Forest'].node_group]
    for ng in groups:
        ng.nodes['Billboard Distance'].outputs[0].default_value = float(dist)
