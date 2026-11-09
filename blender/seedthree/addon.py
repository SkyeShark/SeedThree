"""The SeedThree add-on UI: a 3D View sidebar tab with the web app's folders.

    Species + Seed (+ randomize), Level, Fruit, Grow / Regrow
    Shape & Foliage    Advanced (per-level Weber-Penn dials, or the L-system dials)
    Leaves & Bark (material)
    Optimization / LODs   preview level, mobile performance target, mesh quality, rosette
                          density, switch distances, budgets, densities, prunes, card and
                          billboard bakes; Bake billboard, Auto LOD, Frame camera
    Environment       the app's demo scene (sun azimuth / elevation, haze, scale reference,
                      forest trees), the forest ring around the last tree
    Wind    Light    Camera (auto-rotate)    Export (.glb, PNG)    Save & Load preset

Every dial of every species is a registered property (st_<species>__<key>), drawn
only for the active species. Grow builds at the 3D cursor; with Auto regrow on,
any dial change regrows the last tree in place.
"""

import json
import random

import bpy
from bpy.props import (BoolProperty, EnumProperty, FloatProperty, FloatVectorProperty, IntProperty,
                       PointerProperty, StringProperty)
from bpy_extras.io_utils import ExportHelper, ImportHelper

from . import api
from .core.controls import ADVANCED_LEVEL_PARAMS
from .species import SPECIES

_SPECIES_ITEMS = [(k, sp['name'], sp.get('latin') or '') for k, sp in SPECIES.items()]
_LEVEL_ITEMS = [('LOD0', 'LOD0', 'Full detail: hero plants at any distance'),
                ('LOD1', 'LOD1', 'Mid level: half the triangle budget (from 35 m in the app)'),
                ('LOD2', 'LOD2', 'Far level: baked branch cards over the kept twig skeleton (from 70 m)'),
                ('LOD3', 'LOD3', 'Mobile target only: the first cheaper card rung'),
                ('LOD4', 'LOD4', 'Mobile target only: the second cheaper card rung'),
                ('ALL', 'All levels', 'Every level built, the nearest shown'),
                ('AUTO', 'Auto (by camera)', 'Every level built, switched by the scene camera\'s distance (drivers)')]
_PREVIEW_ITEMS = [('AUTO', 'Auto', 'Switch by camera distance (the app\'s default)'),
                  ('LOD0', 'LOD0', 'The nearest visible level'), ('LOD1', 'LOD1', 'The second visible level'),
                  ('LOD2', 'LOD2', 'The third visible level'), ('BB', 'Billboard', 'The baked billboard')]
_PROPS = {}       # prop name -> (species, kind, key/path, meta)
_BUSY = [False]


def _pname(sp, key):
    return 'st_%s__%s' % (sp, key.replace('.', '__'))


def _hex_to_rgb(h):
    h = int(h)
    return (((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255)


def _rgb_to_hex(c):
    r, g, b = (max(0, min(255, int(round(v * 255)))) for v in c[:3])
    return (r << 16) | (g << 8) | b


def _on_dial(self, context):
    if _BUSY[0]:
        return
    st = context.scene.seedthree
    if st.auto_regrow and st.last_root:
        bpy.ops.seedthree.grow('EXEC_DEFAULT', replace=True)


def _make_prop(sp_key, k):
    """Blender property for one schema knob."""
    name = k['name']
    if k.get('options') is not None:
        items, default = [], None
        for label, val in k['options'].items():
            ident = json.dumps(val)
            items.append((ident, label, ''))
            if val == k['default']:
                default = ident
        return EnumProperty(name=name, items=items, default=default or items[0][0], update=_on_dial)
    if k.get('type') == 'bool':
        return BoolProperty(name=name, default=bool(k['default']), update=_on_dial)
    if k.get('type') == 'color':
        return FloatVectorProperty(name=name, subtype='COLOR_GAMMA', size=3, min=0, max=1,
                                   default=_hex_to_rgb(k['default'] if k['default'] is not None else 0xffffff), update=_on_dial)
    step = k.get('step') or 0.01
    if float(step).is_integer() and float(k['min']).is_integer() and float(k['max']).is_integer():
        return IntProperty(name=name, min=int(k['min']), max=int(k['max']), default=int(round(k['default'])), update=_on_dial)
    return FloatProperty(name=name, min=k['min'], max=k['max'], default=float(k['default']), step=max(1, int(step * 100)),
                         precision=3 if step < 0.01 else 2, update=_on_dial)


def _schema_props():
    ann = {}
    for sp_key in SPECIES:
        sch = api.get_schema(sp_key)
        for folder in ('shape', 'advanced'):
            for k in sch[folder]:
                ident = k.get('key') or k['path']
                pn = _pname(sp_key, ident)
                ann[pn] = _make_prop(sp_key, k)
                _PROPS[pn] = (sp_key, folder, ident, k)
        for k in sch['global']:
            if k['key'] == 'seed':
                continue
            pn = _pname(sp_key, k['key'])
            ann[pn] = _make_prop(sp_key, k)
            _PROPS[pn] = (sp_key, k['group'], k['key'], k)
    return ann


def _on_species(self, context):
    if _BUSY[0]:
        return
    _on_dial(self, context)


def _on_wind(self, context):
    from .bl.wind import set_wind
    set_wind(strength=self.wind_strength, speed=self.wind_speed)


def _is_sun(self, ob):
    return ob.type == 'LIGHT' and ob.data.type == 'SUN'


def _on_sun(self, context):
    from .bl.sun import set_sun
    set_sun(self.sun)


_BACKLIGHT_ITEMS = [
    ('translucent', 'Translucent', 'A Translucent BSDF on the leaf normal: the glow x the leaf\'s Lambert factor '
                                   '(it fades at the silhouette); every lamp reaches it'),
    ('glow', 'Glow (the app)', "The app's backlit glow: the sun's shadowed light through the leaf, strongest "
                              'looking toward the sun, with no Lambert factor, so the crown glows to its '
                              'silhouette and sunlit leaves carry the ambient scatter. A heavy shader (four '
                              'light reads): check the first render'),
]
from .bl.materials import BACKLIGHT_DEFAULT as _BACKLIGHT_DEFAULT  # noqa: E402  (the library's default route)


def _last_tree(context):
    st = context.scene.seedthree
    root = bpy.data.objects.get(st.last_root) if st.last_root else None
    return root if root is not None and root.get('seedthree_preset') else None


def _on_preview(self, context):
    if _BUSY[0]:
        return
    # main.js applyFog: the ring haze is dropped while a level is forced
    from .scene import atmosphere as A
    A.set_haze_enabled(context.scene, self.haze and self.preview == 'AUTO')
    root = _last_tree(context)
    if root is None:
        return
    from .bl.lod import preview
    tree = _tree_objects(root)
    cam = context.scene.camera
    which = self.preview if (self.preview != 'AUTO' or cam is not None) else 'LOD0'
    preview(tree, which, cam, **_dists(self))


def _on_dist(self, context):
    if _BUSY[0]:
        return
    # the app's monotonic switch distances, then the live LOD follows
    _BUSY[0] = True
    try:
        self.lod2Dist = max(self.lod2Dist, self.lod1Dist + 5)
        self.billboardDist = max(self.billboardDist, self.lod2Dist + 10)
    finally:
        _BUSY[0] = False
    root = _last_tree(context)
    if root is not None and root.get('seedthree_auto_lod') and context.scene.camera is not None:
        from .bl.lod import auto_lod
        auto_lod(_tree_objects(root), context.scene.camera, **_dists(self))


def _on_sky(self, context):
    """Sun azimuth / elevation drive the demo scene's sun (and nothing else)."""
    from .scene import terrain as T
    for ob in context.scene.objects:
        if ob.type == 'LIGHT' and ob.get('seedthree_sun') is not None:
            T.place_sun(ob, self.sun_az, self.sun_el, context.scene)


def _on_scale_ref(self, context):
    ob = bpy.data.objects.get('SeedThree scale reference')
    if ob is not None:
        ob.hide_render = ob.hide_viewport = not self.show_scale_ref


def _on_haze(self, context):
    from .scene import atmosphere as A
    A.set_haze_enabled(context.scene, self.haze and self.preview == 'AUTO')


def _forest_objects(root):
    label = '%s forest' % root.name
    return [o for o in (bpy.data.objects.get(label), bpy.data.objects.get(label + ' billboards')) if o is not None]


def _on_forest_count(self, context):
    """main.js onForest -> updateForest: the grove around the last tree follows the count (0 clears it)."""
    if _BUSY[0]:
        return
    root = _last_tree(context)
    if root is None or not _forest_objects(root):
        return
    for o in _forest_objects(root):
        bpy.data.objects.remove(o, do_unlink=True)
    if self.forest_count > 0:
        bpy.ops.seedthree.forest_ring('EXEC_DEFAULT')


def _on_ao(self, context):
    """The app's Ambient occlusion (N8AO) toggle: EEVEE's own horizon-scan GI / AO."""
    ee = context.scene.eevee
    if hasattr(ee, 'use_fast_gi'):
        ee.use_fast_gi = bool(self.ao)
    if hasattr(ee, 'fast_gi_method'):
        ee.fast_gi_method = 'GLOBAL_ILLUMINATION' if self.ao else 'AMBIENT_OCCLUSION_ONLY'


def _orbit_of(cam):
    p = cam.parent if cam is not None else None
    return p if p is not None and p.get('seedthree_orbit') else None


def _on_auto_rotate(self, context):
    """OrbitControls.autoRotate on the scene camera: a keyed orbit around the last tree (one
    turn per 60 s at speed 1), removed again when switched off."""
    if _BUSY[0]:
        return
    scene = context.scene
    cam = scene.camera
    if cam is None:
        return
    piv = _orbit_of(cam)
    if piv is not None:
        mw = cam.matrix_world.copy()
        cam.parent = None
        cam.matrix_world = mw
        bpy.data.objects.remove(piv, do_unlink=True)
    if not self.auto_rotate or self.auto_rotate_speed <= 0:
        return
    root = _last_tree(context)
    from mathutils import Vector
    from .scene.demo import orbit_camera
    target = Vector((0.0, 0.0, 0.0))
    if root is not None:
        pts = [o.matrix_world @ Vector(c) for o in root.children_recursive if o.type == 'MESH' for c in o.bound_box]
        target = sum(pts, Vector()) / len(pts) if pts else root.matrix_world.translation.copy()
    orbit_camera(scene, cam, target, self.auto_rotate_speed)


def _on_spom(self, context):
    """The app's Parallax terrain toggle rebuilds the biome's terrain material."""
    if _BUSY[0]:
        return
    for ob in context.scene.objects:
        if ob.get('seedthree_terrain_seed') is not None and ob.get('seedthree_biome'):
            from .scene.terrain import terrain_material
            nm = ob.get('seedthree_terrain_species') or ''
            sp = next((s for s in SPECIES.values() if s.get('name') == nm), None)
            ob.data.materials.clear()
            ob.data.materials.append(terrain_material(ob['seedthree_biome'], sp, self.spom))


class SeedThreeSettings(bpy.types.PropertyGroup):
    __annotations__ = {
        'species': EnumProperty(name='Species', items=_SPECIES_ITEMS, default='whiteOak', update=_on_species),
        'seed': IntProperty(name='Seed', min=1, max=9999, default=1, update=_on_dial),
        'level': EnumProperty(name='Level', items=_LEVEL_ITEMS, default='LOD0', update=_on_dial),
        'fruit': BoolProperty(name='Fruit', default=True, description='Hang the orchard fruit GLBs (apple, cherry)', update=_on_dial),
        'auto_regrow': BoolProperty(name='Auto regrow', default=True, description='Regrow the last tree when a dial changes'),
        'last_root': StringProperty(name='Last tree'),
        'wind_strength': FloatProperty(name='Wind strength', min=0, max=1, default=0.5, update=_on_wind),
        'wind_speed': FloatProperty(name='Wind speed', min=0.2, max=2.5, default=1.0, update=_on_wind),
        'sun': PointerProperty(name='Backlight sun', type=bpy.types.Object, poll=_is_sun, update=_on_sun,
                               description='The sun lamp the leaf, frond and spine backlight follows (every '
                                           'SeedThree plant in the file). Empty: Grow binds the strongest sun lamp'),
        'backlight': EnumProperty(name='Backlight', items=_BACKLIGHT_ITEMS, default=_BACKLIGHT_DEFAULT, update=_on_dial,
                                  description='How the leaf, frond and spine backlight reaches EEVEE, for plants '
                                              'grown from now on'),
        # Optimization / LODs (main.js optState)
        'preview': EnumProperty(name='Preview level', items=_PREVIEW_ITEMS, default='AUTO', update=_on_preview),
        'mobileTarget': BoolProperty(name='Mobile performance target', default=False, update=_on_dial,
                                     description='The card-first ladder: the baked-card LOD2 is the near view, LOD3/LOD4 '
                                                 'collapse further, the mesh LODs stay built but hidden'),
        'meshQuality': FloatProperty(name='LOD0 mesh quality', min=0.3, max=1, default=0.8, update=_on_dial),
        'lod0Density': FloatProperty(name='LOD0 rosette density', min=0.2, max=1, default=1, update=_on_dial,
                                     description='Mobile near-view rosette density (Joshua, yuccas)'),
        'lod1Dist': FloatProperty(name='LOD1 at (m)', min=5, max=80, default=35, update=_on_dist),
        'lod2Dist': FloatProperty(name='LOD2 at (m)', min=15, max=150, default=70, update=_on_dist),
        'billboardDist': FloatProperty(name='Billboard at (m)', min=30, max=300, default=120, update=_on_dist),
        'lod1Pct': FloatProperty(name='LOD1 budget (%)', min=15, max=85, default=50, update=_on_dial),
        'lod2Pct': FloatProperty(name='LOD2 budget (%)', min=4, max=40, default=15, update=_on_dial),
        'lod1Density': FloatProperty(name='LOD1 foliage density', min=0.2, max=1, default=1, update=_on_dial),
        'lod2Density': FloatProperty(name='LOD2 foliage density', min=0.2, max=1, default=1, update=_on_dial),
        'lod1Prune': FloatProperty(name='LOD1 branch prune', min=0, max=0.85, default=0, update=_on_dial),
        'lod2Prune': FloatProperty(name='LOD2 branch prune', min=0, max=0.85, default=0.35, update=_on_dial),
        'cards': BoolProperty(name='Bake branch cards', default=True, update=_on_dial,
                              description='Bake the card set the far levels place (an EEVEE render; reused per design). '
                                          'Off: the headless cluster-spray fallback'),
        'cardRes': EnumProperty(name='Card bake res', items=[('256', '256', ''), ('512', '512', ''), ('1024', '1024', '')],
                                default='512', update=_on_dial),
        'cardVariants': EnumProperty(name='Card variants', items=[('2', '2', ''), ('3', '3', ''), ('4', '4', '')],
                                     default='3', update=_on_dial),
        'billboard': BoolProperty(name='Billboard', default=False, update=_on_dial,
                                  description='Also bake the far billboard (two crossed cards) when growing'),
        'billboardRes': EnumProperty(name='Billboard res', items=[('512', '512', ''), ('1024', '1024', ''), ('2048', '2048', '')],
                                     default='1024'),
        # Environment (the app's demo scene)
        'sun_az': FloatProperty(name='Sun azimuth', min=0, max=360, default=40, update=_on_sky),
        'sun_el': FloatProperty(name='Sun elevation', min=5, max=88, default=32, update=_on_sky),
        'show_scale_ref': BoolProperty(name='Scale ref (1.8 m)', default=False, update=_on_scale_ref),
        'haze': BoolProperty(name='Distance haze', default=True, update=_on_haze,
                             description='The ring haze; off, the app\'s classic range fog (95-300 m, desert 55-230 m)'),
        'spom': BoolProperty(name='Parallax terrain (SPOM)', default=False, update=_on_spom,
                             description='The app\'s parallax-occlusion terrain material (a heavier shader): swaps the '
                                         'demo terrain\'s material, and Build demo scene uses it'),
        'ao': BoolProperty(name='Ambient occlusion', default=False, update=_on_ao,
                           description='The app\'s N8AO toggle: EEVEE\'s horizon-scan global illumination and AO'),
        'forest_count': IntProperty(name='Forest trees', min=0, max=96, step=8, default=64, update=_on_forest_count,
                                    description='The grove around the plant (Forest ring); changing it rebuilds an '
                                                'existing grove, 0 clears it'),
        # Camera
        'auto_rotate': BoolProperty(name='Auto-rotate', default=False, update=_on_auto_rotate,
                                    description='The scene camera orbits the last plant: a keyed turn, one per 60 s '
                                                'at speed 1 (OrbitControls.autoRotate)'),
        'auto_rotate_speed': FloatProperty(name='Rotate speed', min=0, max=4, default=1.0, update=_on_auto_rotate),
    }


def _settings_cls():
    ann = dict(SeedThreeSettings.__annotations__)
    ann.update(_schema_props())
    return type('SeedThreeDials', (bpy.types.PropertyGroup,), {'__annotations__': ann})


def _value(st, pn):
    sp, folder, ident, k = _PROPS[pn]
    v = getattr(st, pn)
    if k.get('options') is not None:
        return json.loads(v)
    if k.get('type') == 'color':
        return _rgb_to_hex(v)
    if isinstance(v, float):
        # Blender stores float properties as float32: 0.42 reads back 0.41999998...
        return round(v, 6)
    return v


def controls_from_ui(st):
    """The app-format controls for the active species (paramOverrides only for
    per-level dials that differ from the species default)."""
    sp = st.species
    c = {'seed': st.seed, 'paramOverrides': {}}
    for pn, (psp, folder, ident, k) in _PROPS.items():
        if psp != sp:
            continue
        v = _value(st, pn)
        if ident.startswith('paramOverrides.'):
            _, key, lvl = ident.split('.')
            if k['default'] is None or abs(v - k['default']) > 1e-6:
                c['paramOverrides'].setdefault(key, {})[lvl] = v
        else:
            c[ident] = v
    return c


def apply_controls_to_ui(st, species, controls):
    """Write a (preset) controls dict into the dials of `species`."""
    _BUSY[0] = True
    try:
        st.species = species
        if controls.get('seed') is not None:
            st.seed = int(controls['seed'])
        po = controls.get('paramOverrides') or {}
        for pn, (psp, folder, ident, k) in _PROPS.items():
            if psp != species:
                continue
            if ident.startswith('paramOverrides.'):
                _, key, lvl = ident.split('.')
                per = po.get(key) or {}
                v = per.get(lvl, per.get(int(lvl)) if lvl.isdigit() else None)
                v = k['default'] if v is None else v
            else:
                v = controls.get(ident, k['default'])
            if v is None:
                continue
            if k.get('options') is not None:
                try:
                    setattr(st, pn, json.dumps(v))
                except TypeError:
                    pass   # a value the dropdown does not offer: keep the current choice
            elif k.get('type') == 'color':
                setattr(st, pn, _hex_to_rgb(v))
            elif k.get('type') == 'bool':
                setattr(st, pn, bool(v))
            else:
                prop = st.bl_rna.properties[pn]
                v = max(prop.hard_min, min(prop.hard_max, v))
                setattr(st, pn, int(round(v)) if prop.type == 'INT' else float(v))
    finally:
        _BUSY[0] = False


def _dists(st):
    return {'lod1Dist': st.lod1Dist, 'lod2Dist': st.lod2Dist, 'billboardDist': st.billboardDist}


def _lod_opts(st):
    out = {k: getattr(st, k) for k in ('lod1Dist', 'lod2Dist', 'billboardDist', 'meshQuality', 'lod0Density', 'lod1Pct',
                                        'lod2Pct', 'lod1Density', 'lod2Density', 'lod1Prune', 'lod2Prune', 'mobileTarget')}
    out.update({'cardRes': int(st.cardRes), 'cardVariants': int(st.cardVariants), 'billboardRes': int(st.billboardRes)})
    return out


def _tree_objects(root):
    """The objects-by-level part of a grown plant (cheap: no regrowing), for the LOD helpers."""
    built = {}

    def walk(ob):
        for ch in ob.children:
            if ch.type == 'MESH':
                lvl = 'BB' if ch.get('seedthree_billboard_card') else (ch.get('seedthree_lod') or 'LOD0')
                built.setdefault(lvl, []).append(ch)
            walk(ch)
    walk(root)
    lod = json.loads(root.get('seedthree_lod_opts') or '{}')
    t = {'object': root, 'objects': built, 'lod': lod}
    if built.get('BB'):
        t['billboard'] = True
    return t


def _remove_tree(root_name):
    root = bpy.data.objects.get(root_name)
    if root is None:
        return None
    loc = root.location.copy()
    rot = root.rotation_euler.copy()
    from .bl.build import remove_tree
    remove_tree(root)
    return loc, rot


class SEEDTHREE_OT_grow(bpy.types.Operator):
    bl_idname = 'seedthree.grow'
    bl_label = 'Grow'
    bl_description = 'Grow the selected species with these dials at the 3D cursor'
    bl_options = {'REGISTER', 'UNDO'}
    replace: BoolProperty(name='Replace last', default=False)

    def execute(self, context):
        st = context.scene.seedthree
        loc, rot = tuple(context.scene.cursor.location), 0.0
        if self.replace and st.last_root:
            prev = _remove_tree(st.last_root)
            if prev:
                loc, rot = tuple(prev[0]), prev[1].z
        level = st.level
        if level == 'AUTO' and context.scene.camera is None:
            level = 'ALL'
        if level in ('LOD3', 'LOD4') and not st.mobileTarget:
            self.report({'WARNING'}, 'LOD3 / LOD4 exist with the mobile performance target only: growing LOD2')
            level = 'LOD2'
        from .bl.build import create_tree
        from .bl.materials import set_backlight
        set_backlight(st.backlight)
        out = create_tree(species=st.species, seed=st.seed, controls=controls_from_ui(st), lod=_lod_opts(st),
                          level=level, location=loc, rotation_z=rot, fruit=st.fruit, sun_light=st.sun,
                          cards=st.cards, billboard=st.billboard)
        st.last_root = out['object'].name
        if level in ('ALL', 'AUTO') and st.preview != 'AUTO':
            from .bl.lod import preview
            preview(out, st.preview, context.scene.camera, **_dists(st))
        s = out['stats']['summary']
        self.report({'INFO'}, '%s: %.1f m tall, %.1f m wide, %d triangles (LOD0)' % (
            out['object'].name, s.get('heightMeters', 0), s.get('widthMeters', 0), s['lod0Triangles']))
        return {'FINISHED'}


class _LastTreeOp:
    @classmethod
    def poll(cls, context):
        return _last_tree(context) is not None


class SEEDTHREE_OT_bake_billboard(_LastTreeOp, bpy.types.Operator):
    bl_idname = 'seedthree.bake_billboard'
    bl_label = 'Bake billboard'
    bl_description = ('(Re)bake the last tree\'s far billboard from its full-detail level: two crossed cards, '
                      'four channels each (an EEVEE render)')
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        st = context.scene.seedthree
        root = _last_tree(context)
        from .bl.build import tree_from_root
        from .bl.cards import bake_impostor
        tree = tree_from_root(root)
        old = tree.get('billboard')
        if old:
            for ob in list(old['cards']) + [old['object']]:
                bpy.data.objects.remove(ob, do_unlink=True)
            tree['objects'].pop('BB', None)
            tree.pop('billboard', None)
        src = 'LOD0' if tree['objects'].get('LOD0') else next(iter(tree['objects']))
        bake_impostor(tree, size=int(st.billboardRes), source_level=src)
        if not root.get('seedthree_auto_lod'):
            for ob in tree['objects']['BB']:
                ob.hide_render = True
                ob.hide_set(True)
        self.report({'INFO'}, 'Baked the billboard of %s (%s px)' % (root.name, st.billboardRes))
        return {'FINISHED'}


class SEEDTHREE_OT_auto_lod(_LastTreeOp, bpy.types.Operator):
    bl_idname = 'seedthree.auto_lod'
    bl_label = 'Auto LOD'
    bl_description = 'Switch the last tree\'s built levels by the scene camera\'s distance (drivers, saved with the file)'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        if context.scene.camera is None:
            self.report({'ERROR'}, 'Auto LOD needs a scene camera')
            return {'CANCELLED'}
        from .bl.lod import auto_lod
        st = context.scene.seedthree
        bands = auto_lod(_tree_objects(_last_tree(context)), context.scene.camera, **_dists(st))
        self.report({'INFO'}, 'Bands: ' + ', '.join('%s %g-%s m' % (n, b[0], 'inf' if b[1] is None else '%g' % b[1])
                                                   for n, b in bands.items()))
        return {'FINISHED'}


class SEEDTHREE_OT_frame_camera(_LastTreeOp, bpy.types.Operator):
    bl_idname = 'seedthree.frame_camera'
    bl_label = 'Frame camera'
    bl_description = ('The app\'s species switch framing: keep the camera\'s heading, look 18 degrees down at the '
                      'tree from the distance that fits it, and set the species-scaled LOD distances')
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        cam = context.scene.camera
        if cam is None:
            self.report({'ERROR'}, 'Frame camera needs a scene camera')
            return {'CANCELLED'}
        from .bl.build import tree_from_root
        from .bl.lod import frame_camera_to_tree
        st = context.scene.seedthree
        out = frame_camera_to_tree(tree_from_root(_last_tree(context)), cam)
        _BUSY[0] = True
        try:
            st.lod1Dist, st.lod2Dist, st.billboardDist = out['lod1Dist'], out['lod2Dist'], out['billboardDist']
        finally:
            _BUSY[0] = False
        self.report({'INFO'}, 'LOD1 %d m, LOD2 %d m, billboard %d m' % (out['lod1Dist'], out['lod2Dist'], out['billboardDist']))
        return {'FINISHED'}


class SEEDTHREE_OT_forest_ring(_LastTreeOp, bpy.types.Operator):
    bl_idname = 'seedthree.forest_ring'
    bl_label = 'Forest ring'
    bl_description = ('The app\'s grove around the last tree: instanced copies of its LOD2 near the camera and its '
                      'billboard far away (grow it with Level All or Auto)')
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        st = context.scene.seedthree
        from .bl.build import tree_from_root
        from .bl.forest import make_forest_ring
        tree = tree_from_root(_last_tree(context))
        if not tree['objects'].get('LOD2'):
            self.report({'ERROR'}, 'The forest instances the LOD2 level: grow with Level All or Auto')
            return {'CANCELLED'}
        smp = None
        for ob in context.scene.objects:
            if ob.get('seedthree_terrain_seed') is not None:
                from .scene.terrain import make_height_sampler
                smp = make_height_sampler(int(ob['seedthree_terrain_seed']), ob.get('seedthree_terrain_radius', 280),
                                          ob.get('seedthree_terrain_flat', 15), ob.get('seedthree_terrain_hill', 12))
                break
        f = make_forest_ring(tree, count=st.forest_count, billboard=bool(tree.get('billboard')),
                             billboard_dist=st.billboardDist, height_at=smp.height_xy if smp else None,
                             meadow_at=smp.meadow_xy if smp else None)
        self.report({'INFO'}, '%s: %d slots' % (f['object'].name, len(f['slots'])))
        return {'FINISHED'}


class SEEDTHREE_OT_demo_scene(bpy.types.Operator):
    bl_idname = 'seedthree.demo_scene'
    bl_label = 'Build demo scene'
    bl_description = ('The app\'s scene around this species and seed: biome terrain and sky, rocks, fallen limbs, '
                      'grass or scrub, clouds, the tree with every level, the forest ring, haze and the soundscape')
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        st = context.scene.seedthree
        from .scene.demo import build_demo_scene
        demo = build_demo_scene(st.species, seed=st.seed, controls=controls_from_ui(st), lod=_lod_opts(st),
                                sun_az=st.sun_az, sun_el=st.sun_el, forest_count=st.forest_count, haze=st.haze,
                                scale_ref=st.show_scale_ref, autorotate=st.auto_rotate,
                                autorotate_speed=st.auto_rotate_speed, scene=context.scene, spom=st.spom, ao=st.ao)
        st.last_root = demo['tree']['object'].name
        d = demo.get('lodDistances') or {}
        _BUSY[0] = True
        try:
            for k in ('lod1Dist', 'lod2Dist', 'billboardDist'):
                if k in d:
                    setattr(st, k, d[k])
        finally:
            _BUSY[0] = False
        self.report({'INFO'}, 'Demo scene: %s on its %s biome' % (demo['tree']['object'].name, demo['biome']))
        return {'FINISHED'}


class SEEDTHREE_OT_export_glb(_LastTreeOp, bpy.types.Operator, ExportHelper):
    bl_idname = 'seedthree.export_glb'
    bl_label = 'Export .glb'
    bl_description = ('The app\'s Download .glb: every level as <Species>_LODn nodes (MSFT_lod + screen coverages), '
                      'foliage baked to _leaves meshes, leaf translucency as KHR_materials_diffuse_transmission')
    filename_ext = '.glb'
    filter_glob: StringProperty(default='*.glb', options={'HIDDEN'})
    materials: EnumProperty(name='Materials', items=[('full', 'Full', 'The textured materials (the app\'s export)'),
                                                     ('proxy', 'Proxy', 'Two flat colours (the headless exportGLB)')],
                            default='full')
    bake_billboard: BoolProperty(name='Bake billboard if missing', default=True,
                                 description='The app always exports its far billboard level: bake it first when the '
                                             'tree has none (an EEVEE render)')

    def invoke(self, context, event):
        st = context.scene.seedthree
        self.filepath = '%s_seed%d.glb' % (SPECIES[st.species]['name'].replace(' ', '_'), st.seed)
        return ExportHelper.invoke(self, context, event)

    def execute(self, context):
        from .bl.build import tree_from_root
        from .bl.export import export_glb
        st = context.scene.seedthree
        tree = tree_from_root(_last_tree(context))
        if self.bake_billboard and not tree.get('billboard'):
            from .bl.cards import bake_impostor
            src = 'LOD0' if tree['objects'].get('LOD0') else next(iter(tree['objects']))
            bake_impostor(tree, size=int(st.billboardRes), source_level=src)
            for ob in tree['objects']['BB']:
                ob.hide_render = True
                ob.hide_set(True)
        res = export_glb(tree, self.filepath, materials=self.materials, billboard_dist=st.billboardDist)
        self.report({'INFO'}, 'Exported %s (%d KB, %d LOD group%s)' % (
            self.filepath, res['bytes'] // 1024, res['lod'], '' if res['lod'] == 1 else 's'))
        return {'FINISHED'}


class SEEDTHREE_OT_export_png(bpy.types.Operator, ExportHelper):
    bl_idname = 'seedthree.export_png'
    bl_label = 'Export PNG'
    bl_description = 'The app\'s PNG snapshot: render the scene camera to <Species>_seed<N>.png'
    filename_ext = '.png'
    filter_glob: StringProperty(default='*.png', options={'HIDDEN'})

    @classmethod
    def poll(cls, context):
        return context.scene.camera is not None

    def invoke(self, context, event):
        st = context.scene.seedthree
        self.filepath = '%s_seed%d.png' % (SPECIES[st.species]['name'].replace(' ', '_'), st.seed)
        return ExportHelper.invoke(self, context, event)

    def execute(self, context):
        sc = context.scene
        prev = (sc.render.filepath, sc.render.image_settings.file_format)
        try:
            sc.render.image_settings.file_format = 'PNG'
            sc.render.filepath = self.filepath
            bpy.ops.render.render(write_still=True)
        finally:
            sc.render.filepath, sc.render.image_settings.file_format = prev
        self.report({'INFO'}, 'Rendered ' + self.filepath)
        return {'FINISHED'}


class SEEDTHREE_OT_light_probe(bpy.types.Operator):
    bl_idname = 'seedthree.light_probe'
    bl_label = 'Bake light probe'
    bl_description = ('Fit a Light Probe Volume around every SeedThree plant in the scene and bake it: the sky '
                      'inside the canopies gets occluded. Bake after the sky and sun are final')
    bl_options = {'REGISTER', 'UNDO'}
    bake: BoolProperty(name='Bake', default=True)
    spacing: FloatProperty(name='Sample spacing (m)', min=0.25, max=10.0, default=1.5)

    def execute(self, context):
        from .bl.probe import light_probe
        roots = [o for o in context.scene.objects if o.type == 'EMPTY' and o.get('seedthree_species')]
        if not roots:
            self.report({'WARNING'}, 'No SeedThree plants in the scene')
            return {'CANCELLED'}
        ob = light_probe(roots, spacing=self.spacing, bake=self.bake)
        self.report({'INFO'}, '%s around %d plants (%d x %d x %d samples)' % (
            ob.name, len(roots), ob.data.resolution_x, ob.data.resolution_y, ob.data.resolution_z))
        return {'FINISHED'}


class SEEDTHREE_OT_randomize(bpy.types.Operator):
    bl_idname = 'seedthree.randomize'
    bl_label = 'Randomize seed'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        context.scene.seedthree.seed = 1 + random.randrange(9998)
        return {'FINISHED'}


class SEEDTHREE_OT_reset(bpy.types.Operator):
    bl_idname = 'seedthree.reset_dials'
    bl_label = 'Species defaults'
    bl_description = "Reset this species' dials to its preset"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        st = context.scene.seedthree
        apply_controls_to_ui(st, st.species, api.default_controls(st.species))
        return {'FINISHED'}


class SEEDTHREE_OT_save_preset(bpy.types.Operator, ExportHelper):
    bl_idname = 'seedthree.save_preset'
    bl_label = 'Save preset'
    bl_description = 'Write a seedthree-preset/1 JSON (opens in the web app\'s Load panel)'
    filename_ext = '.json'
    filter_glob: StringProperty(default='*.json', options={'HIDDEN'})

    def invoke(self, context, event):
        st = context.scene.seedthree
        self.filepath = api.preset_file_name(st.species, st.seed)
        return ExportHelper.invoke(self, context, event)

    def execute(self, context):
        st = context.scene.seedthree
        api.save_preset(self.filepath, st.species, st.seed, controls_from_ui(st))
        self.report({'INFO'}, 'Saved ' + self.filepath)
        return {'FINISHED'}


class SEEDTHREE_OT_load_preset(bpy.types.Operator, ImportHelper):
    bl_idname = 'seedthree.load_preset'
    bl_label = 'Load preset'
    bl_description = 'Load a seedthree-preset/1 JSON saved by the web app or this add-on'
    filename_ext = '.json'
    filter_glob: StringProperty(default='*.json', options={'HIDDEN'})

    def execute(self, context):
        st = context.scene.seedthree
        pr = api.load_preset(self.filepath)
        apply_controls_to_ui(st, pr['species'], pr['controls'])
        self.report({'INFO'}, 'Loaded %s seed %s' % (pr['species'], pr['seed']))
        if st.auto_regrow and st.last_root:
            bpy.ops.seedthree.grow('EXEC_DEFAULT', replace=True)
        return {'FINISHED'}


class _Panel:
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'SeedThree'


class SEEDTHREE_PT_main(_Panel, bpy.types.Panel):
    bl_label = 'SeedThree'

    def draw(self, context):
        st = context.scene.seedthree
        col = self.layout.column()
        col.prop(st, 'species')
        row = col.row(align=True)
        row.prop(st, 'seed')
        row.operator('seedthree.randomize', text='', icon='FILE_REFRESH')
        col.prop(st, 'level')
        if SPECIES[st.species].get('fruit'):
            col.prop(st, 'fruit')
        row = col.row(align=True)
        op = row.operator('seedthree.grow', text='Grow', icon='OUTLINER_OB_FORCE_FIELD')
        op.replace = False
        op = row.operator('seedthree.grow', text='Regrow', icon='FILE_REFRESH')
        op.replace = True
        col.prop(st, 'auto_regrow')
        col.operator('seedthree.reset_dials')


def _draw_folder(layout, st, folders):
    for pn, (sp, folder, ident, k) in _PROPS.items():
        if sp == st.species and folder in folders:
            layout.prop(st, pn)


class SEEDTHREE_PT_shape(_Panel, bpy.types.Panel):
    bl_label = 'Shape & Foliage'
    bl_parent_id = 'SEEDTHREE_PT_main'

    def draw(self, context):
        st = context.scene.seedthree
        _draw_folder(self.layout.column(), st, ('shape', 'global'))


class SEEDTHREE_PT_advanced(_Panel, bpy.types.Panel):
    bl_label = 'Advanced'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        st = context.scene.seedthree
        _draw_folder(self.layout.column(), st, ('advanced',))


class SEEDTHREE_PT_material(_Panel, bpy.types.Panel):
    bl_label = 'Leaves & Bark'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        st = context.scene.seedthree
        _draw_folder(self.layout.column(), st, ('material',))


class SEEDTHREE_PT_lod(_Panel, bpy.types.Panel):
    bl_label = 'Optimization / LODs'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        st = context.scene.seedthree
        sp = SPECIES[st.species]
        dich = sp.get('foliageType') in ('rosette', 'sprayClusters')
        rosette = sp.get('foliageType') == 'rosette'
        col = self.layout.column()
        col.prop(st, 'preview')
        col.prop(st, 'mobileTarget')
        col.prop(st, 'meshQuality')
        if rosette:
            col.prop(st, 'lod0Density')
        for k in ('lod1Dist', 'lod2Dist', 'billboardDist'):
            col.prop(st, k)
        for k in ('lod1Density', 'lod2Density') if dich else (
                'lod1Pct', 'lod1Density', 'lod1Prune', 'lod2Pct', 'lod2Density', 'lod2Prune'):
            col.prop(st, k)
        col.separator()
        col.prop(st, 'cards')
        row = col.row(align=True)
        row.prop(st, 'cardRes')
        row.prop(st, 'cardVariants')
        col.prop(st, 'billboard')
        col.prop(st, 'billboardRes')
        col.operator('seedthree.bake_billboard', icon='IMAGE_PLANE')
        row = col.row(align=True)
        row.operator('seedthree.auto_lod', icon='CAMERA_DATA')
        row.operator('seedthree.frame_camera', icon='VIEW_CAMERA')


class SEEDTHREE_PT_environment(_Panel, bpy.types.Panel):
    bl_label = 'Environment'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        st = context.scene.seedthree
        col = self.layout.column()
        col.prop(st, 'sun_az')
        col.prop(st, 'sun_el')
        col.prop(st, 'show_scale_ref')
        col.prop(st, 'haze')
        col.prop(st, 'spom')
        col.prop(st, 'ao')
        col.prop(st, 'forest_count')
        col.operator('seedthree.demo_scene', icon='WORLD')
        col.operator('seedthree.forest_ring', icon='OUTLINER_OB_POINTCLOUD')


class SEEDTHREE_PT_wind(_Panel, bpy.types.Panel):
    bl_label = 'Wind'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        st = context.scene.seedthree
        col = self.layout.column()
        col.prop(st, 'wind_strength')
        col.prop(st, 'wind_speed')
        col.label(text='Shared by every SeedThree tree; keyframe for gusts.')


class SEEDTHREE_PT_light(_Panel, bpy.types.Panel):
    bl_label = 'Light'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        st = context.scene.seedthree
        col = self.layout.column()
        col.prop(st, 'sun')
        col.prop(st, 'backlight')
        col.operator('seedthree.light_probe', icon='LIGHTPROBE_VOLUME')
        col.label(text='Bake after the sky and sun are final.')


class SEEDTHREE_PT_camera(_Panel, bpy.types.Panel):
    bl_label = 'Camera'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        st = context.scene.seedthree
        col = self.layout.column()
        col.prop(st, 'auto_rotate')
        col.prop(st, 'auto_rotate_speed')
        col.label(text='A keyed orbit of the scene camera.')


class SEEDTHREE_PT_export(_Panel, bpy.types.Panel):
    bl_label = 'Export'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        row = self.layout.row(align=True)
        row.operator('seedthree.export_glb', icon='EXPORT')
        row.operator('seedthree.export_png', icon='RENDER_STILL')


class SEEDTHREE_PT_io(_Panel, bpy.types.Panel):
    bl_label = 'Save & Load'
    bl_parent_id = 'SEEDTHREE_PT_main'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        row = self.layout.row(align=True)
        row.operator('seedthree.save_preset', icon='FILE_TICK')
        row.operator('seedthree.load_preset', icon='FILE_FOLDER')


def _on_assets_dir(self, context):
    if self.assets_dir:
        api.ASSETS_DIR = bpy.path.abspath(self.assets_dir)


class SeedThreePreferences(bpy.types.AddonPreferences):
    bl_idname = __package__
    assets_dir: StringProperty(
        name='SeedThree assets folder', subtype='DIR_PATH', update=_on_assets_dir,
        description="The checkout's assets/ (bark, leaves, fruits, ground, audio). Not needed when the add-on folder is a "
                    'link into the checkout, which finds ../../assets by itself')

    def draw(self, context):
        self.layout.prop(self, 'assets_dir')
        self.layout.label(text='In use: ' + api.ASSETS_DIR)


_CLASSES = [SeedThreePreferences, SEEDTHREE_OT_grow, SEEDTHREE_OT_bake_billboard, SEEDTHREE_OT_auto_lod,
            SEEDTHREE_OT_frame_camera, SEEDTHREE_OT_forest_ring, SEEDTHREE_OT_demo_scene, SEEDTHREE_OT_export_glb,
            SEEDTHREE_OT_export_png, SEEDTHREE_OT_light_probe, SEEDTHREE_OT_randomize, SEEDTHREE_OT_reset,
            SEEDTHREE_OT_save_preset, SEEDTHREE_OT_load_preset, SEEDTHREE_PT_main, SEEDTHREE_PT_shape,
            SEEDTHREE_PT_advanced, SEEDTHREE_PT_material, SEEDTHREE_PT_lod, SEEDTHREE_PT_environment,
            SEEDTHREE_PT_wind, SEEDTHREE_PT_light, SEEDTHREE_PT_camera, SEEDTHREE_PT_export, SEEDTHREE_PT_io]
_DIALS = []


def register():
    cls = _settings_cls()
    _DIALS[:] = [cls]
    bpy.utils.register_class(cls)
    bpy.types.Scene.seedthree = PointerProperty(type=cls)
    for c in _CLASSES:
        bpy.utils.register_class(c)
    try:
        prefs = bpy.context.preferences.addons[__package__].preferences
        if prefs.assets_dir:
            api.ASSETS_DIR = bpy.path.abspath(prefs.assets_dir)
    except (KeyError, AttributeError):
        pass


def unregister():
    for c in reversed(_CLASSES):
        bpy.utils.unregister_class(c)
    del bpy.types.Scene.seedthree
    for c in _DIALS:
        bpy.utils.unregister_class(c)
    _DIALS.clear()
