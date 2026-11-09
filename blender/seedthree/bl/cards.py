"""Baked card sets and the billboard impostor for SeedThree plants in Blender.

    from seedthree.bl import cards
    set_ = cards.ensure_branch_cards(shaped, merged, {'cardRes': 512, 'cardVariants': 3})
    bb = cards.bake_impostor(tree_result, size=1024)      # the far 'BB' level: two crossed cards

ensure_branch_cards is main.js ensureBranchCards: the jobs it bakes (one foliage-only
terminal set; the willow's gravity-aligned crossed sheets; crossed sets for
crossedLod2Cards species; rosette terminal-arm cards for a mobile Joshua/yucca),
cached per design. Card materials live in the file (custom property st_cards_key),
so a reopened file or a re-grow of the same design reuses them without rendering.
The exemplar content (twig + LOD0 leaves + fruit, or an arm stub + full crown and
skirt) is built with the plant's real materials and rendered by bl/bake.py.
"""

import hashlib
import json

import bpy
from mathutils import Matrix

from .. import api
from ..core.branch_cards import prepare_branch_cards, prepare_rosette_cards, TRANSMIT
from . import meshes, materials
from .bake import bake_objects_to_textures

CARD_RES = 512
CARD_VARIANTS = 3
BILLBOARD_RES = 1024
FROND_TRANSMIT = (0.10, 0.13, 0.03)    # yucca-leaves.js frond material
SPINE_TRANSMIT = (0.86, 0.78, 0.42)    # cactus-spines.js SPINE_TRANSMIT
ROSETTE_AMBIENT = 0.03                 # both materials' thicknessAmbient


def _hash(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:16]


def card_jobs(shaped, lod=None):
    """main.js ensureBranchCards: which card set(s) the ladder needs, or [] ."""
    lod = lod or {}
    fol = shaped.get('foliage')
    if shaped.get('foliageType') == 'rosette':
        if not lod.get('mobileTarget') or shaped.get('cactus') or fol is False:
            return []
        return [{'rosette': True}]
    if shaped.get('foliageType') == 'sprayClusters':
        return []   # the app bakes a Weber-Penn set for spray shrubs that no rung places
    if not fol or (fol.get('leavesPerBranch', 1) if fol.get('leavesPerBranch') is not None else 1) <= 0:
        return []
    max_level = (shaped['params'].get('levels') or 3) - 1
    if fol.get('mode') == 'willowCurtains':
        return [{'level': max_level, 'foliageOnly': True, 'gravityAligned': True, 'crossViews': True, 'noFlutter': True}]
    crossed = bool(shaped.get('crossedLod2Cards'))
    return [{'level': max_level, 'foliageOnly': True, 'crossViews': crossed, 'noFlutter': crossed}]


def _content_objects(name, variant, shaped, merged, fruit=None):
    """The exemplar's bake content as temporary objects with the plant's real materials."""
    col = bpy.context.scene.collection
    out = []
    c = variant['content']
    twig = c.get('twig')
    if twig is not None and len(twig['index']):
        me = meshes.bark_mesh(name + ' twig', twig)
        out.append(meshes.link_object(me.name, me, col, None, [materials.bark_material(shaped, merged)]))
    leaves = c.get('leaves')
    if leaves is not None:
        mode = c.get('leafMode')
        if leaves.get('kind') == 'cards':
            me = meshes.cards_mesh(name + ' leaves', [leaves])
            mat = materials.leaf_material(shaped, merged, mode='willowCurtains' if mode == 'willowCurtains' else 'leaves')
        else:
            me = meshes.willow_mesh(name + ' leaves', leaves, leaves['domeCenter'])
            mat = materials.leaf_material(shaped, merged, mode='willowCurtains')
        if me is not None:
            out.append(meshes.link_object(me.name, me, col, None, [mat]))
    cones = c.get('cones')
    if cones is not None:
        me = meshes.cones_mesh(name + ' fronds', cones)
        if me is not None:
            out.append(meshes.link_object(me.name, me, col, None, [materials.rosette_material(shaped, merged)]))
    fr = c.get('fruit')
    if fr is not None and fruit and fruit.get('fruitPath'):
        from .build import fruit_template
        template, fmat = fruit_template(fruit['fruitPath'])
        me = meshes.fruit_mesh(name + ' fruit', fr, template, fruit['fruitOffset'])
        out.append(meshes.link_object(me.name, me, col, None, [fmat] if fmat else []))
    return out


def _remove(objs):
    for ob in objs:
        me = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        if me is not None and me.users == 0:
            bpy.data.meshes.remove(me)


def _find_mats(key):
    found = {}
    for m in bpy.data.materials:
        if m.get('st_cards_key') == key:
            found[(int(m['st_variant']), m['st_view'])] = m
    return found


def _bake_set(label, cards, shaped, merged, transmit, key, fruit=None, dilate_passes=10):
    """Render every variant's views and attach a card material per (variant, view)."""
    cached = _find_mats(key)
    need = {(vi, v['name']) for vi, var in enumerate(cards['variants']) for v in var['views']}
    if need and need <= set(cached):
        mats = cached
    else:
        for m in cached.values():
            bpy.data.materials.remove(m)
        mats = {}
        for vi, var in enumerate(cards['variants']):
            objs = _content_objects('%s v%d' % (label, vi), var, shaped, merged, fruit)
            try:
                baked = bake_objects_to_textures(objs, var['views'], size=cards['size'], dilate_passes=dilate_passes,
                                                 name='%s v%d' % (label, vi))
            finally:
                _remove(objs)
            for view, imgs in baked.items():
                m = materials.card_material('%s v%d %s' % (label, vi, view), imgs, transmit)
                m['st_cards_key'] = key
                m['st_variant'] = vi
                m['st_view'] = view
                m.use_fake_user = True
                mats[(vi, view)] = m
    for vi, var in enumerate(cards['variants']):
        var['material'] = mats.get((vi, 'front'))
        if var.get('side') is not None:
            var['side']['material'] = mats.get((vi, 'side'))
    cards['key'] = key
    return cards


def ensure_branch_cards(shaped, merged, lod=None, fruit=None):
    """The card set the LOD ladder places (main.js ensureBranchCards), baking it when the
    file has no bake of this design yet. -> a facade for build_tree's lodOpts.branchCards:
    {'byLevel': {'<level>:fol': set}, 'variants', ...} (or the rosette set), or None.
    lod: {'cardRes', 'cardVariants', 'mobileTarget'}."""
    lod = lod or {}
    jobs = card_jobs(shaped, lod)
    if not jobs:
        return None
    size = int(lod.get('cardRes') or CARD_RES)
    variants = int(lod.get('cardVariants') or CARD_VARIANTS)
    fol = shaped.get('foliage') or {}
    mat_key = (materials._key('leaf', shaped['name'], shaped.get('leaf'), fol.get('tint'), merged.get('leafColorize'),
                              merged.get('leafTintAmount'), merged.get('leafAlpha'), fol.get('transmit')),
               merged.get('barkTint'), merged.get('frondGreenTint'), merged.get('frondDryTint'),
               merged.get('frondDryestTint'), merged.get('frondDryness'))
    job = jobs[0]
    if job.get('rosette'):
        key = _hash(['rosette', shaped['name'], shaped['params'], fol, size, variants, mat_key])
        cards = prepare_rosette_cards(shaped, {'size': size, 'variants': variants})
        if not cards:
            return None
        return _bake_set('ST %s rosette cards' % shaped['name'], cards, shaped, merged, TRANSMIT, key)
    max_level = job['level']
    key = _hash([shaped['name'], {'params': shaped['params'], 'foliage': fol, 'guideLevel': shaped.get('guideLevel'),
                                   'terminalStemsAreGuides': bool(shaped.get('terminalStemsAreGuides'))},
                 size, variants, job, mat_key, bool(fruit)])
    s = prepare_branch_cards(shaped, {'size': size, 'variants': variants, 'cardLevel': job['level'],
                                      'foliageOnly': job['foliageOnly'], 'noFlutter': job['noFlutter'],
                                      'crossViews': job['crossViews'], 'gravityAligned': bool(job.get('gravityAligned'))},
                             (fruit or {}).get('fruitBounds'))
    if not s:
        return None
    _bake_set('ST %s cards' % shaped['name'], s, shaped, merged, TRANSMIT, key, fruit)
    return {'byLevel': {'%d:fol' % max_level: s}, 'variants': s['variants'], 'key': key}


def card_set_materials(foliage):
    """(materials list, slot_of) for a placed card set: one slot per (variant, view)."""
    mats, index = [], {}

    def slot_of(m):
        geo_owner = m['variant']
        k = (geo_owner, m['view'])
        if k not in index:
            index[k] = len(mats)
            mats.append(m['material'])
        return index[k]
    return mats, slot_of


# ---- the billboard impostor ---------------------------------------------------------

def bake_impostor(tree, size=BILLBOARD_RES, source_level='LOD0', centered='axis', transmit=None, name=None,
                  collection=None, cast_shadow=True):
    """bakeImpostor / the bake worker: two crossed cards (front + side views) baked from the
    plant's full-detail level, added under the plant's root as its far level 'BB', named
    <Species>_LOD<n> for export. centered='axis' frames the views on the trunk axis (the
    app's off-thread worker: the two cards' trunks meet at the cross); 'box' on the
    bounding-box centre (the main-thread bakeImpostor). cast_shadow: the app's policy,
    the pair casts the sun's shadow and receives none (light linking, bl/cast_only.py);
    False casts nothing.

    tree: a create_tree result. Returns the billboard Empty."""
    root = tree['object']
    objs = tree['objects'].get(source_level) or []
    if not objs:
        raise ValueError('[seedthree] bake_impostor: the plant has no %s level built' % source_level)
    shaped = tree['shaped']
    sink = tree['tree']['plantSink']
    # the framing box: the JS Box3 over the source level (instances as transformed AABBs)
    lv = next(l for l in tree['tree']['levels'] if l['name'] == source_level)
    st = api.stats_of({'levels': [lv]}, tree['tree'].get('assets'))
    bb = st['boundingBox']
    mn, mx = bb['min'], bb['max']
    if centered == 'axis':
        cy = (mn[1] + mx[1]) / 2
        center = (0.0, cy, 0.0)
        half_w = max(abs(mn[0]), abs(mx[0]), abs(mn[2]), abs(mx[2])) * 1.03
        half_h = ((mx[1] - mn[1]) / 2) * 1.03
        depth = half_w * 2 + 5
    else:
        center = tuple((a + b) / 2 for a, b in zip(mn, mx))
        half_w = (max(mx[0] - mn[0], mx[2] - mn[2]) / 2) * 1.03
        half_h = ((mx[1] - mn[1]) / 2) * 1.03
        depth = max(mx[0] - mn[0], mx[2] - mn[2]) + 5
    views = [{'name': n, 'dir': d, 'center': center, 'halfW': half_w, 'halfH': half_h, 'depth': depth,
              'near': 0.1, 'far': depth * 2} for n, d in (('front', (0.0, 0.0, 1.0)), ('side', (1.0, 0.0, 0.0)))]
    # bake copies of the source parts in the tree's own frame (no parent, no sink, no wind)
    col = bpy.context.scene.collection
    temps = []
    for ob in objs:
        t = bpy.data.objects.new(ob.name + ' [bake]', ob.data)
        col.objects.link(t)
        t.matrix_world = Matrix.Identity(4)
        temps.append(t)
    label = name or ('ST %s billboard' % shaped['name'])
    try:
        baked = bake_objects_to_textures(temps, views, size=size, dilate_passes=12, name=label,
                                         outward_center=(center[0], -center[2], center[1]))
    finally:
        for t in temps:
            bpy.data.objects.remove(t, do_unlink=True)
    # main.js: the species' own foliage transmit, else the broadleaf green. Rosette and cactus
    # species have none, and their billboard took the broadleaf green (4.8x the Joshua fronds'
    # (0.10, 0.13, 0.03)): it scatters the plant's own fronds' / spines' colour instead
    # (the JS's blackbrush fix, carried to the rosettes).
    own = (shaped.get('foliage') or {}).get('transmit') if isinstance(shaped.get('foliage'), dict) else None
    ambient = None                       # impostor.js: 0.16, "matches leaf/card LODs"
    if own is None and shaped.get('foliageType') == 'rosette':
        own = SPINE_TRANSMIT if shaped.get('cactus') else FROND_TRANSMIT
        ambient = ROSETTE_AMBIENT        # the fronds' / spines' own scatter floor
    transmit = tuple(transmit or own or TRANSMIT)
    geo_levels = [l for l in tree['tree']['levels']]
    slug = shaped['name'].replace(' ', '_')
    grp = bpy.data.objects.new('%s %s' % (root.name, 'BB'), None)
    grp.empty_display_type = 'PLAIN_AXES'
    grp.empty_display_size = 0.3
    target = collection or (root.users_collection[0] if root.users_collection else bpy.context.scene.collection)
    target.objects.link(grp)
    grp.parent = root
    grp.location = (0.0, 0.0, -sink)
    grp['seedthree_lod'] = 'BB'
    grp['seedthree_export_name'] = '%s_LOD%d' % (slug, len(geo_levels))
    grp['seedthree_billboard'] = True
    cards = []
    w, h = half_w * 2, half_h * 2
    cz = center[1]
    for i, view in enumerate(('front', 'side')):
        mat = materials.billboard_material('%s %s' % (label, view), baked[view], h, transmit, view=view,
                                           ambient=ambient)
        me = bpy.data.meshes.new('%s %s' % (label, view))
        # PlaneGeometry(w, h) on its own frame; front faces +z (three) = -y (Blender),
        # side faces +x with U running +z -> -z like the side bake camera (three)
        if view == 'front':
            verts = [(-w / 2, 0, -h / 2), (w / 2, 0, -h / 2), (w / 2, 0, h / 2), (-w / 2, 0, h / 2)]
        else:
            verts = [(0, -w / 2, -h / 2), (0, w / 2, -h / 2), (0, w / 2, h / 2), (0, -w / 2, h / 2)]
        me.from_pydata(verts, [], [(0, 1, 2, 3)])
        uv = me.uv_layers.new(name='UVMap')
        for li, (u, v) in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
            uv.data[li].uv = (u, v)
        # export-only bent corner normals: (x, y + 0.55 h, 0) in the card plane, normalized
        import math as _m
        nrm = []
        for (x, y) in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
            vy = y + h * 0.55
            ln = _m.hypot(x, vy) or 1.0
            if view == 'front':
                nrm.append((x / ln, 0.0, vy / ln))
            else:
                nrm.append((0.0, x / ln, vy / ln))
        me.normals_split_custom_set_from_vertices(nrm)
        me.materials.append(mat)
        ob = bpy.data.objects.new('%s %s %s' % (root.name, 'BB', 'billboard_' + view), me)
        target.objects.link(ob)
        ob.parent = grp
        ob.location = (center[0], -center[2], center[1])
        ob['seedthree_export_name'] = 'billboard_' + view
        ob['seedthree_billboard_card'] = True
        ob.visible_shadow = bool(cast_shadow)
        cards.append(ob)
    if cast_shadow:
        # The JS cards cast (a canopy blob on the ground) but do not receive, so the pair never
        # shadows itself. EEVEE has no per-object receive switch: light linking does it
        # (bl/cast_only.py): the key sun skips the cards, a shadowless twin lights them.
        from .cast_only import link
        from .sun import bound_sun
        link(cards, bound_sun())     # no sun bound yet: marked, and linked by set_sun
    grp['seedthree_bb'] = {'halfW': half_w, 'halfH': half_h, 'center': list(center)}
    tree['objects']['BB'] = cards
    tree.setdefault('billboard', {}).update({'object': grp, 'cards': cards, 'halfW': half_w, 'halfH': half_h,
                                             'center': center, 'images': baked})
    return grp
