"""Headless check of the add-on: register, dial a species through the scene
properties, Grow, auto-regrow on a dial change, Save preset, Load preset (the
web-app JSON) into the dials of another species and back.

    blender --background --factory-startup --python blender/tests/test_addon.py
"""

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))

import bpy  # noqa: E402

import seedthree  # noqa: E402
from seedthree import api, addon  # noqa: E402

bpy.ops.wm.read_factory_settings(use_empty=True)
seedthree.register()
scene = bpy.context.scene
st = scene.seedthree
fails = []


def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        fails.append(msg)


# dials of the white oak through the panel's properties
st.auto_regrow = False
st.species = 'whiteOak'
st.seed = 1737
st.st_whiteOak__trunks = 1
st.st_whiteOak__crownShape = '2'
st.st_whiteOak__leafSize = 0.38
st.st_whiteOak__paramOverrides__downAngle__1 = 64
bpy.ops.seedthree.grow()
root = bpy.data.objects.get(st.last_root)
check(root is not None and len(root.children) == 2, 'Grow built %s with %d children' % (st.last_root, len(root.children) if root else -1))
pr = json.loads(root['seedthree_preset'])
check(pr['controls']['trunks'] == 1 and pr['controls']['crownShape'] == 2 and pr['controls']['paramOverrides'] == {'downAngle': {'1': 64}},
      'the panel dials reached the build: %s' % {k: pr['controls'][k] for k in ('trunks', 'crownShape', 'leafSize', 'paramOverrides')})
ref = api.generate('whiteOak', 1737, {'trunks': 1, 'crownShape': 2, 'leafSize': 0.38, 'paramOverrides': {'downAngle': {1: 64}}})
tris = sum(len(o.data.polygons) for o in root.children)
check(tris == ref['stats']['summary']['lod0Triangles'], 'triangles in Blender %d == generate() %d' % (tris, ref['stats']['summary']['lod0Triangles']))

# auto regrow on a dial change replaces the tree in place
st.auto_regrow = True
before = st.last_root
st.seed = 42
check(st.last_root and bpy.data.objects.get(st.last_root) is not None and len([o for o in bpy.data.objects if o.type == 'EMPTY']) == 1,
      'auto regrow replaced %s with %s (one tree in the file)' % (before, st.last_root))

# save, then load into a different species and back
path = os.path.join(tempfile.mkdtemp(), 'oak.seedthree.json')
bpy.ops.seedthree.save_preset(filepath=path)
saved = json.load(open(path))
check(saved['format'] == 'seedthree-preset/1' and saved['species'] == 'whiteOak' and saved['controls']['seed'] == 42,
      'Save preset wrote %s' % os.path.basename(path))
st.auto_regrow = False
st.species = 'joshuaTree'
st.st_whiteOak__trunks = 3
bpy.ops.seedthree.load_preset(filepath=path)
check(st.species == 'whiteOak' and st.seed == 42 and st.st_whiteOak__trunks == 1 and st.st_whiteOak__crownShape == '2'
      and st.st_whiteOak__paramOverrides__downAngle__1 == 64,
      'Load preset restored species, seed and dials')
again = addon.controls_from_ui(st)
check(api._json_clean(api.to_preset('whiteOak', 42, again)) == api._json_clean(saved),
      'controls survive a save/load cycle unchanged')

# every species registers its dials and grows from the panel
st.auto_regrow = False
for key in ('joshuaTree', 'saguaro', 'creosote', 'weepingWillow'):
    st.species = key
    bpy.ops.seedthree.grow()
    r = bpy.data.objects.get(st.last_root)
    check(r is not None and len(r.children) >= 2, 'Grow %s -> %d objects' % (key, len(r.children) if r else 0))

# the Light folder: the backlight sun picker and the light probe operator (fit only: baking renders on the GPU)
from seedthree.bl import sun as bsun  # noqa: E402
lamp = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
scene.collection.objects.link(lamp)
st.sun = lamp
check(bsun.bound_sun() == lamp, 'the Backlight sun picker binds the Sun group to %s' % lamp.name)
res = bpy.ops.seedthree.light_probe(bake=False)
pb = bpy.data.objects.get('SeedThree Light Probe')
check('FINISHED' in res and pb is not None and pb.data.type == 'VOLUME',
      'Bake light probe fitted a Light Probe Volume around the plants')

# Optimization / LODs without bakes (cards off = the cluster fallback; bakes render on the GPU and
# are covered by eidoverse's blender/tests/trees2): the mobile ladder, the preview level, auto LOD,
# the camera framing, the forest ring and the GLB export
st.auto_regrow = False
st.species = 'whiteOak'
st.seed = 1737
st.cards = False
st.billboard = False
st.mobileTarget = True
st.level = 'ALL'
bpy.ops.seedthree.grow()
root = bpy.data.objects.get(st.last_root)
levels = sorted({ch.get('seedthree_lod') for ch in root.children})
check(levels == ['LOD0', 'LOD1', 'LOD2', 'LOD3', 'LOD4'], 'mobile target grows the ladder: %s' % levels)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (12, -18, 6)
st.preview = 'LOD0'
shown = sorted({ch.get('seedthree_lod') for ch in root.children if not ch.hide_render})
check(shown == ['LOD2'], 'preview LOD0 of a mobile tree shows its near card rung: %s' % shown)
st.preview = 'LOD2'
shown = sorted({ch.get('seedthree_lod') for ch in root.children if not ch.hide_render})
check(shown == ['LOD4'], 'preview LOD2 of a mobile tree shows LOD4: %s' % shown)
st.preview = 'AUTO'
drv = {ch.get('seedthree_lod') for ch in root.children if ch.animation_data and ch.animation_data.drivers}
parked = {ch.get('seedthree_lod') for ch in root.children
          if ch.hide_render and not (ch.animation_data and ch.animation_data.drivers)}
check(drv == {'LOD2', 'LOD3', 'LOD4'} and parked == {'LOD0', 'LOD1'},
      'preview Auto drives the card rungs by camera distance %s; the mesh LODs stay parked %s' % (sorted(drv), sorted(parked)))
bpy.ops.seedthree.frame_camera()
check(st.lod1Dist > 5 and st.lod2Dist >= st.lod1Dist + 5 and st.billboardDist >= st.lod2Dist + 10,
      'frame camera set species-scaled distances %.0f / %.0f / %.0f' % (st.lod1Dist, st.lod2Dist, st.billboardDist))
glb = os.path.join(tempfile.mkdtemp(), 'oak.glb')
res = bpy.ops.seedthree.export_glb(filepath=glb, bake_billboard=False)   # the bake renders: covered on the GPU
from seedthree import glb as G  # noqa: E402
if os.path.isfile(glb):
    doc, _ = G.read_glb(glb)
    names = [n.get('name') for n in doc['nodes']]
    check('FINISHED' in res and 'White_Oak_LOD0' in names and 'White_Oak_LOD3' not in names and
          'MSFT_lod' in (doc.get('extensionsUsed') or []), 'export .glb: %s (app-only LOD3/LOD4 skipped)' % [
              n for n in names if 'LOD' in n and '_' not in n.split('LOD')[-1]])
else:
    check(False, 'export .glb wrote nothing')
one = os.path.join(tempfile.mkdtemp(), 'oak_lod1_proxy.glb')
from seedthree.bl.build import tree_from_root  # noqa: E402
api.export_glb(tree_from_root(bpy.data.objects[st.last_root]), one, materials='proxy', level='LOD1')
doc1, _ = G.read_glb(one)
n1 = [n.get('name') for n in doc1['nodes']]
check('White_Oak_LOD1' in n1 and 'White_Oak_LOD0' not in n1 and not doc1.get('extensionsUsed'),
      'export one level (proxy): %s' % [n for n in n1 if 'LOD' in n])
st.mobileTarget = False
bpy.ops.seedthree.grow(replace=True)
res = bpy.ops.seedthree.forest_ring()
forest = [o for o in scene.objects if o.get('seedthree_forest')]
check('FINISHED' in res and len(forest) == 1, 'forest ring (no billboard baked): %s' % [o.name for o in forest])
n_before = len(bpy.data.objects)
bpy.ops.seedthree.grow(replace=True)
check(len(bpy.data.objects) <= n_before, 'regrow removes the whole old tree (%d -> %d objects)' % (n_before, len(bpy.data.objects)))

seedthree.unregister()
print('ADDON', 'FAIL %d' % len(fails) if fails else 'PASS')
