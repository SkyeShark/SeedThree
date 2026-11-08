"""Headless checks (no render) of the Blender tier's state handling:

  fruit     orchard fruit grows again after File > New (read_factory_settings) and
            after deleting the trees and purging (the GLB cache holds a Material)
  sun       the backlight's "SeedThree Sun" group binds the strongest sun lamp, its
            drivers give the lamp's world +Z for any rotation (also parented),
            set_sun rebinds, a deleted lamp unbinds, and the drivers run without
            Python script execution
  boxes     stats['boundingBox'] is Z up in the root's frame and matches the built
            meshes; stats['boundingBoxWorld'] matches them in world space
  duplicate duplicate_tree copies the root and every part, linked, out of step in the wind
  presets   save_preset to a folder writes <Name>_seed<N>.seedthree.json
  cactus    the damage noise is the raw octave sum (Normalize off), three's axes

    blender --background --factory-startup --python blender/tests/test_blender_state.py
"""

import math
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Euler, Matrix, Vector  # noqa: E402

from seedthree import api  # noqa: E402
from seedthree.bl import sun as bsun  # noqa: E402

fails = []


def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond:
        fails.append(msg)


def fruit_count(out):
    return sum(len(o.data.polygons) for o in out['objects']['LOD0'] if o.name.endswith('fruit'))


def evaluated_points(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        a = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get('co', a)
        a = a.reshape(-1, 3).astype(np.float64)
        M = np.array(o.matrix_world)
        pts.append((a, a @ M[:3, :3].T + M[:3, 3]))
        ev.to_mesh_clear()
    return pts


# ---- fruit across files ----------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
a = api.create_tree('apple', 5, wind=False)
n1 = fruit_count(a)
bpy.ops.wm.read_factory_settings(use_empty=True)
try:
    b = api.create_tree('apple', 5, wind=False)
    fm = next(o for o in b['objects']['LOD0'] if o.name.endswith('fruit')).data.materials[0]
    check(fruit_count(b) == n1 and fm.name in bpy.data.materials, 'apple fruit regrows after a new file (%d tris, %s)' % (n1, fm.name))
except Exception as e:  # noqa: BLE001
    check(False, 'apple fruit after a new file raised %s: %s' % (type(e).__name__, e))
bpy.ops.wm.read_homefile(use_empty=True)
try:
    c = api.create_tree('cherry', 6, wind=False)
    n_c = fruit_count(c)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for m in [m for m in bpy.data.materials if m.use_fake_user]:
        m.use_fake_user = False
    bpy.data.orphans_purge(do_recursive=True)
    d = api.create_tree('cherry', 6, wind=False)
    check(fruit_count(d) == n_c > 0, 'cherry fruit regrows after its material was purged (%d tris)' % n_c)
except Exception as e:  # noqa: BLE001
    check(False, 'cherry fruit after a purge raised %s: %s' % (type(e).__name__, e))

# ---- the backlight sun ---------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
print('[state] auto-run python scripts:', bpy.context.preferences.filepaths.use_scripts_auto_execute)


def lamp(name, energy, rot):
    ob = bpy.data.objects.new(name, bpy.data.lights.new(name, 'SUN'))
    ob.data.energy = energy
    ob.rotation_euler = rot
    scene.collection.objects.link(ob)
    return ob


def sun_dir():
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ng = bpy.data.node_groups[bsun.GROUP].evaluated_get(dg)
    v = Vector([s.default_value for s in ng.nodes[bsun.NODE].inputs[:3]])
    return v.normalized()


weak = lamp('weak', 1.0, (0.3, 0.2, 0.1))
strong = lamp('strong', 4.0, (0.9, -0.4, 2.2))
t = api.create_tree('whiteOak', 3, wind=False)
check(t['sun'] == strong and bsun.bound_sun() == strong, 'create_tree bound the strongest sun lamp (%s)' % (t['sun'].name if t['sun'] else None))
worst = 0.0
for rot in ((0.0, 0.0, 0.0), (0.9, -0.4, 2.2), (math.radians(83), 0.0, math.radians(215)), (2.5, 1.1, -0.7)):
    strong.rotation_euler = rot
    bpy.context.view_layer.update()
    want = (strong.matrix_world.to_3x3() @ Vector((0, 0, 1))).normalized()
    worst = max(worst, (sun_dir() - want).length)
strong.rotation_mode = 'QUATERNION'
strong.rotation_quaternion = Euler((0.4, 0.3, 1.0)).to_quaternion()
parent = bpy.data.objects.new('rig', None)
scene.collection.objects.link(parent)
parent.rotation_euler = (0.0, 0.7, 0.3)
strong.parent = parent
bpy.context.view_layer.update()
want = (strong.matrix_world.to_3x3() @ Vector((0, 0, 1))).normalized()
worst = max(worst, (sun_dir() - want).length)
check(worst < 1e-5, 'the Sun group follows the lamp\'s world +Z through Euler, quaternion and parenting (max error %.2e)' % worst)
api.set_sun(weak)
weak.rotation_euler = (0.2, 0.0, 0.0)
bpy.context.view_layer.update()
want = (weak.matrix_world.to_3x3() @ Vector((0, 0, 1))).normalized()
check(bsun.bound_sun() == weak and (sun_dir() - want).length < 1e-5, 'set_sun rebinds every plant to another lamp')
bpy.data.objects.remove(weak, do_unlink=True)
check(bsun.bound_sun() is None, 'deleting the bound lamp leaves the group unbound')
t2 = api.create_tree('whiteOak', 4, wind=False)
check(t2['sun'] == strong, 'the next create_tree rebinds to the remaining sun lamp')
for part in ('foliage',):
    mat = next(o for o in t['objects']['LOD0'] if o.name.endswith(part)).data.materials[0]
    nodes = mat.node_tree.nodes
    groups = [n.node_tree.name for n in nodes if n.type == 'GROUP']
    tl = [n for n in nodes if n.type == 'BSDF_TRANSLUCENT']
    pr = [n for n in nodes if n.type == 'BSDF_PRINCIPLED']
    shared = (len(tl) == 1 and len(pr) == 1 and tl[0].inputs['Normal'].is_linked and pr[0].inputs['Normal'].is_linked
              and tl[0].inputs['Normal'].links[0].from_socket == pr[0].inputs['Normal'].links[0].from_socket)
    check(groups == [bsun.GROUP] and shared,
          'the leaf backlight reads the Sun group and shares the Principled\'s normal (EEVEE drops the diffuse otherwise)')
    out = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL')
    th = out.inputs['Thickness'].links[0].from_node if out.inputs['Thickness'].is_linked else None
    check(th is not None and th.type == 'VALUE' and th.outputs[0].default_value == 0.0,
          'the leaf card\'s Thickness is linked to 0 (unlinked = colour^2 and no canopy shadow)')
sj = api.create_tree('joshuaTree', 7, wind=False, location=(30, 0, 0))
sg = api.create_tree('saguaro', 3, wind=False, location=(40, 0, 0))
for out_, part in ((sj, 'fronds'), (sg, 'spines')):
    mat = next(o for o in out_['objects']['LOD0'] if o.name.endswith(part)).data.materials[0]
    nodes = mat.node_tree.nodes
    tl = next(n for n in nodes if n.type == 'BSDF_TRANSLUCENT')
    pr = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    same = (tl.inputs['Normal'].is_linked and pr.inputs['Normal'].is_linked
            and tl.inputs['Normal'].links[0].from_socket == pr.inputs['Normal'].links[0].from_socket)
    check(same, 'the %s backlight shares the Principled\'s normal' % part)

# ---- light probe fit (the bake itself renders on the GPU: the trees render probes bake it) --------
from seedthree.bl import probe as bprobe  # noqa: E402
bpy.ops.wm.read_factory_settings(use_empty=True)
o1 = api.create_tree('whiteOak', 1737, location=(0, 0, 0), wind=False)
o2 = api.create_tree('whiteOak', 42, location=(30, 10, 0), wind=False)
pb = api.light_probe([o1, o2], spacing=1.5, bake=False)
lo, hi = bprobe.plants_box([o1, o2])
c, s = pb.location, pb.scale
inside = all(c[i] - s[i] <= lo[i] + 1e-6 and c[i] + s[i] >= hi[i] - 1e-6 for i in range(3))
res = (pb.data.resolution_x, pb.data.resolution_y, pb.data.resolution_z)
check(pb.type == 'LIGHT_PROBE' and pb.data.type == 'VOLUME' and inside and all(2 <= r <= 64 for r in res),
      'light_probe fits a Light Probe Volume around two oaks: centre %s, half size %s, resolution %s' % (
          [round(v, 1) for v in c], [round(v, 1) for v in s], res))
pb2 = api.light_probe(o1, bake=False)
check(pb2 == pb and pb.scale.x < s.x + 1e-6, 'light_probe refits the same probe object')

# ---- boxes -----------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
loc, rot = (3.0, -2.0, 1.5), 0.6
o = api.create_tree('whiteOak', 1737, location=loc, rotation_z=rot, wind=False)
bpy.context.view_layer.update()
pts = evaluated_points(o['objects']['LOD0'])
root_inv = np.array(o['object'].matrix_world.inverted())
local = np.concatenate([w @ root_inv[:3, :3].T + root_inv[:3, 3] for _, w in pts])
world = np.concatenate([w for _, w in pts])
bb, bw = o['stats']['boundingBox'], o['stats']['boundingBoxWorld']
# the JS box takes each leaf instance's transformed card box, so it may stand a little proud of the vertices
inside = np.all(local.min(0) >= np.array(bb['min']) - 1e-3) and np.all(local.max(0) <= np.array(bb['max']) + 1e-3)
e_local = max(np.abs(local.min(0) - bb['min']).max(), np.abs(local.max(0) - bb['max']).max())
check(inside and e_local < 0.3, 'boundingBox (Z up, root frame) holds the built meshes, within %.3f m of them: %s' % (
    e_local, [round(v, 2) for v in bb['min'] + bb['max']]))
check(abs((bb['max'][2] - bb['min'][2]) - o['stats']['summary']['heightMeters']) < 1e-3, 'the box height is on Z')
lo_w, hi_w = np.array(bw['min']), np.array(bw['max'])
check(np.all(world.min(0) >= lo_w - 0.05) and np.all(world.max(0) <= hi_w + 0.05),
      'boundingBoxWorld contains every world vertex')

# ---- duplicate ---------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
src = api.create_tree('apple', 5, level='ALL')
n_src = len(src['object'].children)
cp = api.duplicate_tree(src, location=(20.0, 5.0, 0.0))     # same rotation: only the wind phase can differ
turned = api.duplicate_tree(src, location=(-20.0, 0.0, 0.0), rotation_z=1.0)
check(abs(turned['object'].rotation_euler.z - 1.0) < 1e-6 and len(turned['object'].children) == n_src,
      'a second copy takes its own rotation')
kids = cp['object'].children
check(len(kids) == n_src and all(k.data in [c.data for c in src['object'].children] for k in kids),
      'duplicate_tree copied the root and its %d parts with linked meshes' % n_src)
check(sorted(cp['objects']) == ['LOD0', 'LOD1', 'LOD2'] and all(k.hide_render == s.hide_render for k, s in
      zip(sorted(kids, key=lambda x: x.name), sorted(src['object'].children, key=lambda x: x.name))),
      'the copy keeps the levels and which ones render')
check(cp['object']['seedthree_species'] == 'apple' and tuple(cp['object'].location) == (20.0, 5.0, 0.0),
      'the copy keeps its custom properties and takes the new location')
scene = bpy.context.scene
scene.frame_set(12)
a_pts = evaluated_points([next(o for o in src['objects']['LOD0'] if o.name.endswith('foliage'))])[0][0]
b_pts = evaluated_points([next(o for o in cp['objects']['LOD0'] if o.name.endswith('foliage'))])[0][0]
check(np.abs(a_pts - b_pts).max() > 1e-3, 'the copy sways out of step with the original (max local difference %.3f m)'
      % np.abs(a_pts - b_pts).max())

# ---- presets to a folder -------------------------------------------------------------------
d = tempfile.mkdtemp()
p = api.save_preset(d, 'whiteOak', 1737, {'trunks': 1})
check(os.path.basename(p) == 'White_Oak_seed1737.seedthree.json' and os.path.isfile(p), 'save_preset(<folder>) wrote %s' % os.path.basename(p))
p2 = api.save_preset(os.path.join(d, 'x.json'), 'whiteOak', 2)
check(os.path.isfile(p2) and p2.endswith('x.json'), 'save_preset(<file>) writes that file')

# ---- cactus noise ------------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
s = api.create_tree('saguaro', 3, wind=False)
skin = next(o for o in s['objects']['LOD0'] if o.name.endswith('bark')).data.materials[0]
nz = next(n for n in skin.node_tree.nodes if n.type == 'TEX_NOISE')
check(nz.normalize is False and nz.noise_type == 'FBM' and nz.inputs['Detail'].default_value == 2.0,
      'saguaro damage noise: raw fBm octave sum (normalize %s, %s, detail %s)' % (nz.normalize, nz.noise_type, nz.inputs['Detail'].default_value))

print('STATE', 'FAIL %d' % len(fails) if fails else 'PASS')
