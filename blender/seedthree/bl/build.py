"""create_tree(): grow a SeedThree plant into the open Blender scene.

    from seedthree import api
    out = api.create_tree(species='whiteOak', seed=1737, controls={'leafSize': 0.5},
                          level='LOD0', location=(0, 0, 0))
    out['object']          # the root Empty (children: bark, foliage, spines, fruit)
    out['stats']['summary']
    out['preset']          # seedthree-preset/1, opens in the web app's Load panel

The root sits at `location`; its children hang plantSink below it (the JS LOD
offset), so the trunk base is buried by the species' sink. level='LOD0'|'LOD1'|
'LOD2' builds one level; level='ALL' builds all three (LOD1/2 hidden). Films use
LOD0: LOD1 and LOD2 are the realtime ladder without its card bakes (see README).

stats['boundingBox'] is in Blender axes (Z up) in the root Empty's frame, the sink
included; stats['boundingBoxWorld'] is the axis-aligned world box at the given
location and rotation. (generate(), without bpy, keeps three's Y-up frame like the JS.)

duplicate_tree() copies a grown plant as a new root with linked part meshes.
"""

import json

import bpy
import numpy as np
from mathutils import Matrix, Vector

from .. import api
from . import meshes, materials
from .sun import ensure_sun
from .wind import add_wind

_FRUIT_CACHE = {}   # GLB path -> (template arrays, material); the material is checked alive on every use


def _alive(idblock):
    """False once Blender has freed the ID (a new or loaded file, a purge, a delete)."""
    if idblock is None:
        return True
    try:
        idblock.name
        return True
    except ReferenceError:
        return False


def _collection(collection):
    if collection is None:
        return bpy.context.scene.collection
    if isinstance(collection, str):
        col = bpy.data.collections.get(collection)
        if col is None:
            col = bpy.data.collections.new(collection)
            bpy.context.scene.collection.children.link(col)
        return col
    return collection


def fruit_template(path):
    """Import the fruit GLB once per file: (template in three space, material)."""
    hit = _FRUIT_CACHE.get(path)
    if hit is not None and _alive(hit[1]):
        return hit
    _FRUIT_CACHE.pop(path, None)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in new if o.type == 'MESH')
    me = src.data
    mw = np.array(src.matrix_world)
    n = len(me.vertices)
    co = np.empty(n * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3).astype(np.float64)
    co = co @ mw[:3, :3].T + mw[:3, 3]
    nr = np.empty(n * 3, np.float32)
    me.vertices.foreach_get('normal', nr)
    nr = nr.reshape(-1, 3).astype(np.float64) @ mw[:3, :3].T
    me.calc_loop_triangles()
    tris = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get('vertices', tris)
    loops_t = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get('loops', loops_t)
    uv_loop = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv_loop)
    uv_loop = uv_loop.reshape(-1, 2)
    uv = np.zeros((n, 2), np.float32)
    uv[tris] = uv_loop[loops_t]
    # Blender (X, Y, Z) -> three (X, Z, -Y)
    to3 = lambda a: np.stack([a[:, 0], a[:, 2], -a[:, 1]], axis=1)
    template = {'position': to3(co), 'normal': to3(nr), 'uv': uv, 'index': tris}
    mat = me.materials[0] if me.materials else None
    if mat is not None and mat.use_nodes:
        # JS makeFruitMaterial: metalness 0, roughness = the baked map at factor 1.
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                for l in list(node.inputs['Metallic'].links):
                    mat.node_tree.links.remove(l)
                node.inputs['Metallic'].default_value = 0.0
                for l in node.inputs['Roughness'].links:
                    fn = l.from_node
                    if fn.type == 'MATH' and fn.operation == 'MULTIPLY':
                        for s in fn.inputs:
                            if not s.is_linked:
                                s.default_value = 1.0
        mat.use_fake_user = True
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    _FRUIT_CACHE[path] = (template, mat)
    return _FRUIT_CACHE[path]


def _child(name, me, root, col, mat, sink, wind, flat=False):
    if flat:
        me.shade_flat()
    ob = meshes.link_object(name, me, col, root, [mat] if mat else [])
    ob.location = (0.0, 0.0, -sink)
    if wind:
        add_wind(ob)
    return ob


def _blender_boxes(stats, sink, location, rotation_z):
    """three Y-up tree-local box -> Blender Z-up in the root's frame (sink included) + world AABB."""
    bb = stats.get('boundingBox')
    if not bb:
        return stats
    mn, mx = bb['min'], bb['max']
    lo = [mn[0], -mx[2], mn[1] - sink]
    hi = [mx[0], -mn[2], mx[1] - sink]
    M = Matrix.Translation(Vector(location)) @ Matrix.Rotation(rotation_z, 4, 'Z')
    pts = [M @ Vector((x, y, z)) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    out = dict(stats)
    out['boundingBox'] = {'min': lo, 'max': hi}
    out['boundingBoxWorld'] = {'min': [min(p[i] for p in pts) for i in range(3)],
                               'max': [max(p[i] for p in pts) for i in range(3)]}
    return out


LEVEL_NAMES = ('LOD0', 'LOD1', 'LOD2', 'LOD3', 'LOD4', 'BB')


def _wanted(level, tree):
    names = [l['name'] for l in tree['levels']]
    if level in ('ALL', 'AUTO'):
        return names
    if isinstance(level, (list, tuple)):
        return [n for n in level if n in names]
    return [level or 'LOD0']


def create_tree(species='whiteOak', seed=1, controls=None, lod=None, level='LOD0', location=(0.0, 0.0, 0.0),
                rotation_z=0.0, collection=None, name=None, wind=True, fruit=True, sun_light=None, cards=True,
                billboard=False):
    """level: 'LOD0'..'LOD4' (LOD3/LOD4 exist with lod={'mobileTarget': True}), a list of
    them, 'ALL' (every geometry level; the first visible, the rest hidden) or 'AUTO'
    (every level, switched by camera distance: see bl/lod.py auto_lod). cards: bake (or
    reuse) the branch / rosette card set when a wanted level places cards (desktop LOD2,
    the mobile rungs); False keeps the cluster-spray fallback of the headless JS.
    billboard: also bake the far billboard impostor (level 'BB')."""
    lod = dict(lod or {})
    shaped0, merged0 = api.shaped_species(species, controls, seed)
    fruit_info = api.fruit_assets(shaped0) if fruit else {}
    probe = {'levels': [{'name': n} for n in ('LOD0', 'LOD1', 'LOD2') + (('LOD3', 'LOD4') if lod.get('mobileTarget') else ())]}
    wanted0 = _wanted(level, probe)
    card_levels = {'LOD2', 'LOD3', 'LOD4'}
    if cards and set(wanted0) & card_levels and 'branchCards' not in lod:
        from .cards import ensure_branch_cards
        bc = ensure_branch_cards(shaped0, merged0, lod, fruit_info)
        if bc:
            lod['branchCards'] = bc
    gen = api.generate(species=species, seed=seed, controls=controls, lod=lod, fruit=fruit)
    tree, shaped, stats = gen['tree'], gen['shaped'], gen['stats']
    merged = gen['preset']['controls']
    col = _collection(collection)
    sun = ensure_sun(sun_light, bpy.context.scene)   # the backlight's sun (shared by every plant in the file)
    sp_name = shaped['name']
    root = bpy.data.objects.new(name or '%s seed %s' % (sp_name, seed), None)
    root.empty_display_type = 'PLAIN_AXES'
    root.empty_display_size = 0.5
    root.location = location
    root.rotation_euler = (0.0, 0.0, rotation_z)
    col.objects.link(root)
    root['seedthree_preset'] = api.preset_json(gen['preset'])
    root['seedthree_species'] = species
    root['seedthree_seed'] = seed
    root['allow_intersect'] = True
    sink = tree['plantSink']
    wanted = _wanted(level, tree)
    flat = bool(merged.get('barkFlat'))
    if shaped.get('cactus'):
        bark_mat = materials.cactus_bark_material(shaped, merged, seed)
    else:
        bark_mat = materials.bark_material(shaped, merged)
    built = {}
    level_meta = []
    for lv in tree['levels']:
        level_meta.append({k: lv.get(k) for k in ('name', 'distance', 'hiddenInApp', 'appOnly', 'cardLevel',
                                                    'cardKeepFraction', 'meshTerminalKeepFraction', 'thatchBark')})
        if lv['name'] not in wanted:
            continue
        objs = []
        parts = lv['parts']
        tag = '%s %s' % (root.name, lv['name'])
        me = meshes.bark_mesh(tag + ' bark', parts['bark'])
        lv_bark = bark_mat
        if lv.get('thatchBark') and shaped.get('thatchBark'):
            lv_bark = materials.thatch_bark_material(shaped, merged)
        objs.append(_child(tag + ' bark', me, root, col, lv_bark, sink, wind, flat))
        fol = parts.get('foliage')
        if fol is not None:
            kind = fol.get('kind')
            if kind == 'cardSet':
                from .cards import card_set_materials
                cs = (lod.get('branchCards') or {})
                cset = cs['byLevel'].get(fol.get('cardsKey')) if isinstance(cs.get('byLevel'), dict) else cs
                cset = cset or cs
                for m in fol['meshes']:
                    var = cset['variants'][m['variant']]
                    m['material'] = var['material'] if m['view'] == 'front' else var['side']['material']
                mats, slot_of = card_set_materials(fol)
                me = meshes.card_set_mesh(tag + ' cards', fol, slot_of)
                if me is not None:
                    ob = meshes.link_object(me.name, me, col, root, mats)
                    ob.location = (0.0, 0.0, -sink)
                    if wind:
                        add_wind(ob)
                    objs.append(ob)
                me = None
            elif kind in ('cards', 'cardsGroup'):
                members = fol['members'] if kind == 'cardsGroup' else [fol]
                me = meshes.cards_mesh(tag + ' foliage', members)
                mat = materials.leaf_material(shaped, merged)
            elif kind == 'mesh':
                me = meshes.willow_mesh(tag + ' foliage', fol, fol['domeCenter'])
                mat = materials.leaf_material(shaped, merged, mode='willowCurtains')
            elif kind == 'cones':
                me = meshes.cones_mesh(tag + ' fronds', fol)
                mat = materials.rosette_material(shaped, merged)
            else:
                me = None
            if me is not None:
                objs.append(_child(me.name, me, root, col, mat, sink, wind))
        sp = parts.get('spines')
        if sp is not None:
            me = meshes.spine_mesh(tag + ' spines', sp)
            objs.append(_child(tag + ' spines', me, root, col, materials.spine_material(shaped, merged), sink, wind))
        fr = parts.get('fruit')
        if fr is not None and tree['assets'].get('fruitPath'):
            template, fmat = fruit_template(tree['assets']['fruitPath'])
            me = meshes.fruit_mesh(tag + ' fruit', fr, template, tree['assets']['fruitOffset'])
            objs.append(_child(tag + ' fruit', me, root, col, fmat, sink, wind))
        slug = shaped['name'].replace(' ', '_')
        for o in objs:
            o['seedthree_lod'] = lv['name']
            o['seedthree_export_level'] = '%s_%s' % (slug, lv['name'])
            if lv.get('appOnly'):
                o['seedthree_app_only'] = True
            if lv.get('hiddenInApp'):
                o['seedthree_hidden_in_app'] = True
        built[lv['name']] = objs
    shown = next((n for n in wanted if not next((l for l in tree['levels'] if l['name'] == n), {}).get('hiddenInApp')),
                 wanted[0]) if level in ('ALL', 'AUTO') else wanted[0]
    for n, objs in built.items():
        if n != shown:
            for o in objs:
                o.hide_render = True
                o.hide_set(True)
    root['seedthree_levels'] = json.dumps(level_meta)
    root['seedthree_mobile'] = bool(lod.get('mobileTarget'))
    root['seedthree_lod_opts'] = json.dumps({k: v for k, v in lod.items() if k != 'branchCards'})
    root['seedthree_cards'] = bool(cards)
    root['seedthree_fruit'] = bool(fruit)
    stats = _blender_boxes(stats, sink, location, rotation_z)
    out = {'object': root, 'objects': built, 'stats': stats, 'preset': gen['preset'], 'shaped': shaped, 'tree': tree,
           'sun': sun, 'lod': {k: v for k, v in lod.items() if k != 'branchCards'}, 'cards': lod.get('branchCards')}
    if billboard:
        from .cards import bake_impostor
        src = 'LOD0' if 'LOD0' in built else next(iter(built))
        bake_impostor(out, size=int(lod.get('billboardRes') or 1024), source_level=src)
        if level not in ('ALL', 'AUTO') and wanted[0] != 'BB':
            for o in out['objects']['BB']:
                o.hide_render = True
                o.hide_set(True)
    if level == 'AUTO':
        from .lod import auto_lod
        auto_lod(out)
    return out


def tree_from_root(root):
    """create_tree's result dict for a plant grown earlier (its root Empty, e.g. in a saved
    file or from the add-on): the objects by level from the root's children, and the
    generation data regrown from the preset on the root (deterministic, no meshes built;
    a card set reuses the file's baked card materials). What export_glb, bake_impostor,
    make_forest_ring and the LOD helpers take."""
    pr = json.loads(root['seedthree_preset'])
    species, controls = pr['species'], pr['controls']
    seed = controls.get('seed', 1)
    lod = json.loads(root.get('seedthree_lod_opts') or '{}')
    built = {}
    bb_empty = None

    def walk(ob):
        nonlocal bb_empty
        for ch in ob.children:
            if ch.type == 'MESH':
                lvl = 'BB' if ch.get('seedthree_billboard_card') else (ch.get('seedthree_lod') or 'LOD0')
                built.setdefault(lvl, []).append(ch)
            elif ch.get('seedthree_billboard'):
                bb_empty = ch
            walk(ch)
    walk(root)
    fruit = bool(root.get('seedthree_fruit', True))
    shaped0, merged0 = api.shaped_species(species, controls, seed)
    if root.get('seedthree_cards', True) and set(built) & {'LOD2', 'LOD3', 'LOD4'}:
        from .cards import ensure_branch_cards
        bc = ensure_branch_cards(shaped0, merged0, lod, api.fruit_assets(shaped0) if fruit else {})
        if bc:
            lod['branchCards'] = bc
    gen = api.generate(species=species, seed=seed, controls=controls, lod=lod, fruit=fruit)
    stats = _blender_boxes(gen['stats'], gen['tree']['plantSink'], tuple(root.location), root.rotation_euler.z)
    out = {'object': root, 'objects': built, 'stats': stats, 'preset': gen['preset'], 'shaped': gen['shaped'],
           'tree': gen['tree'], 'sun': None, 'lod': {k: v for k, v in lod.items() if k != 'branchCards'},
           'cards': lod.get('branchCards')}
    if bb_empty is not None and built.get('BB'):
        info = dict(bb_empty.get('seedthree_bb') or {})
        out['billboard'] = {'object': bb_empty, 'cards': built['BB'], 'halfW': info.get('halfW'),
                            'halfH': info.get('halfH'), 'center': tuple(info.get('center') or (0, 0, 0))}
    return out


def remove_tree(root):
    """Delete a grown plant: its root and every object under it (the billboard's cards too)."""
    def walk(ob):
        for ch in list(ob.children):
            walk(ch)
            me = ch.data
            bpy.data.objects.remove(ch, do_unlink=True)
            if me is not None and getattr(me, 'users', 1) == 0 and isinstance(me, bpy.types.Mesh):
                bpy.data.meshes.remove(me)
    walk(root)
    bpy.data.objects.remove(root, do_unlink=True)


def duplicate_tree(tree, location=None, rotation_z=None, collection=None, name=None, linked=True):
    """Copy a grown plant: a new root Empty with copies of every part object.

    tree: the dict create_tree returned, or its root Empty. linked=True shares the
    part meshes (Alt+D): no new geometry is stored, and the wind still deforms each
    copy on its own, out of step with the original because the sway phase follows
    world position. Returns {'object': new root, 'objects': {level: [objects]}}.
    """
    root = tree['object'] if isinstance(tree, dict) else tree
    if collection is not None:
        col = _collection(collection)
    else:
        col = root.users_collection[0] if root.users_collection else bpy.context.scene.collection
    new_root = root.copy()
    new_root.name = name or root.name
    col.objects.link(new_root)
    if location is not None:
        new_root.location = location
    if rotation_z is not None:
        new_root.rotation_euler = (0.0, 0.0, rotation_z)
    by_level = {}

    def copy_children(src, dst):
        for ch in src.children:
            c = ch.copy()
            if not linked and ch.data is not None:
                c.data = ch.data.copy()
            if ch.name.startswith(root.name):
                c.name = new_root.name + ch.name[len(root.name):]
            c.parent = dst
            c.matrix_parent_inverse = ch.matrix_parent_inverse.copy()
            col.objects.link(c)
            try:
                c.hide_set(ch.hide_get())
            except RuntimeError:
                pass   # not in the active view layer
            if ch.type == 'MESH':
                level = ch.get('seedthree_lod') or next((w for w in ch.name.split() if w in LEVEL_NAMES), 'LOD0')
                if ch.get('seedthree_billboard_card'):
                    level = 'BB'
                by_level.setdefault(level, []).append(c)
            copy_children(ch, c)   # the billboard Empty carries its two cards
    copy_children(root, new_root)
    cast = [o for objs in by_level.values() for o in objs if 'seedthree_cast_only' in o]
    if cast:
        from .cast_only import link
        from .sun import bound_sun
        link(cast, bound_sun())   # the copied billboard casts without receiving, like the original
    return {'object': new_root, 'objects': by_level}
