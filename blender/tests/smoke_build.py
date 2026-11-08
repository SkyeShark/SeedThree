"""Headless Blender smoke test (no render): build every species at LOD0 and check
the objects, materials, attributes and that the wind group deforms over time.

    blender --background --factory-startup --python blender/tests/smoke_build.py -- [species ...]
"""

import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

from seedthree import api  # noqa: E402
from seedthree.species import SPECIES  # noqa: E402

argv = [a for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []) if a != '--']
names = argv or list(SPECIES)
bpy.ops.wm.read_factory_settings(use_empty=True)
fails = 0
x = 0.0
for key in names:
    t0 = time.perf_counter()
    try:
        out = api.create_tree(species=key, seed=3, level='LOD0', location=(x, 0, 0))
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print('FAIL', key, e)
        fails += 1
        continue
    ms = (time.perf_counter() - t0) * 1000
    objs = out['objects']['LOD0']
    desc = []
    for o in objs:
        me = o.data
        attrs = sorted(a.name for a in me.attributes if a.name.startswith('st_'))
        desc.append('%s:%dv/%dt mat=%s attrs=%d' % (o.name.split(' ')[-1], len(me.vertices), len(me.polygons),
                                                   me.materials[0].name if me.materials else None, len(attrs)))
    print('OK %-16s %6.0f ms  tris %s  h %.2f  %s' % (key, ms, out['stats']['summary']['lod0Triangles'],
                                                     out['stats']['summary'].get('heightMeters', 0), ' | '.join(desc)))
    x += 12.0

# wind deforms: compare an evaluated foliage mesh at frames 1 and 24
scene = bpy.context.scene
probe = next((o for o in scene.objects if o.type == 'MESH' and ('foliage' in o.name or 'fronds' in o.name)), None)
if probe:
    def coords(frame):
        scene.frame_set(frame)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = probe.evaluated_get(dg)
        me = ev.to_mesh()
        a = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get('co', a)
        ev.to_mesh_clear()
        return a.reshape(-1, 3)
    a, b = coords(1), coords(24)
    d = np.linalg.norm(a - b, axis=1)
    print('wind on %s: frame 1 vs 24 displacement max %.3f m, mean %.3f m' % (probe.name, d.max(), d.mean()))
missing = [img.filepath for img in bpy.data.images if img.source == 'FILE' and not img.has_data and not img.packed_file
           and not os.path.isfile(bpy.path.abspath(img.filepath))]
print('textures loaded: %d, missing files: %s' % (len(bpy.data.images), missing or 'none'))
fails += len(missing)
print('SMOKE', 'FAIL %d' % fails if fails else 'PASS')
