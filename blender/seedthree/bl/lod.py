"""Distance LOD for SeedThree plants in Blender: THREE.LOD, main.js applyLodMobile and
frameCameraToTree (with each species' lodDistanceMultipliers).

    tree = api.create_tree('whiteOak', 1737, level='ALL', billboard=True)
    lod.frame_camera_to_tree(tree, scene.camera)     # fit the camera; species-scaled switch distances
    lod.auto_lod(tree)                                # each level shown in its distance band

auto_lod adds drivers on every level object's hide_render / hide_viewport: a
level shows while the camera's distance to the plant lies in [its distance, the next
level's). They are simple expressions over a distance variable, so a saved .blend
switches on its own with Python auto-execution off, frame by frame as the camera
moves. THREE.LOD's 5% hysteresis needs the previous frame's choice, which a driver
cannot hold, so the bands switch exactly at the distances.

Desktop: LOD0 at 0, LOD1 at lod1Dist, LOD2 at lod2Dist, the billboard at billboardDist.
Mobile (applyLodMobile): the hidden mesh levels never show, the card LOD2 is the near
view (0), LOD3 at lod1Dist, LOD4 at lod2Dist, the billboard at billboardDist.
"""

import json
import math

import bpy
from mathutils import Vector

DEFAULT_MULT = {'lod1': 1.5, 'lod2': 3.0, 'billboard': 5.5}
HIDE_DIST = 1e7


def _levels(tree):
    root = tree['object']
    return json.loads(root.get('seedthree_levels') or '[]')


def level_distances(tree, lod1Dist=None, lod2Dist=None, billboardDist=None):
    """{level: switch distance or None (never shown)} for the built levels."""
    lod = tree.get('lod') or {}
    mobile = bool(tree['object'].get('seedthree_mobile'))
    stored = tree['object'].get('seedthree_lod_dist')
    stored = json.loads(stored) if stored else {}
    d1 = lod1Dist if lod1Dist is not None else stored.get('lod1Dist', lod.get('lod1Dist'))
    d2 = lod2Dist if lod2Dist is not None else stored.get('lod2Dist', lod.get('lod2Dist'))
    bb = billboardDist if billboardDist is not None else stored.get('billboardDist', lod.get('billboardDist', 120))
    out = {}
    for lv in _levels(tree):
        n = lv['name']
        if mobile and lv.get('hiddenInApp'):
            out[n] = None
        elif mobile and n == 'LOD2':
            out[n] = 0.0
        elif n in ('LOD1', 'LOD3'):
            out[n] = float(d1 if d1 is not None else lv['distance'])
        elif n in ('LOD2', 'LOD4'):
            out[n] = float(d2 if d2 is not None else lv['distance'])
        else:
            out[n] = float(lv['distance'])
    if tree.get('billboard') or 'BB' in tree.get('objects', {}):
        out['BB'] = float(bb)
    return out


def _clear(ob):
    for path in ('hide_render', 'hide_viewport'):
        try:
            ob.driver_remove(path)
        except TypeError:
            pass


def auto_lod(tree, camera=None, **dists):
    """Show each built level in its camera-distance band (drivers). Returns {level: (lo, hi)}."""
    camera = camera or bpy.context.scene.camera
    if camera is None:
        raise ValueError('[seedthree] auto_lod needs a camera (scene.camera or camera=)')
    root = tree['object']
    dist = level_distances(tree, **dists)
    built = [n for n in dist if dist[n] is not None and tree['objects'].get(n)]
    built.sort(key=lambda n: dist[n])
    bands = {}
    for i, n in enumerate(built):
        lo = dist[n]
        hi = dist[built[i + 1]] if i + 1 < len(built) else None
        bands[n] = (lo, hi)
    for n, objs in tree['objects'].items():
        for ob in objs:
            _clear(ob)
            if n not in bands:
                ob.hide_render = True
                ob.hide_viewport = True
                continue
            lo, hi = bands[n]
            expr = 'd < %r' % lo if hi is None else '(d < %r) or (d >= %r)' % (lo, hi)
            for path in ('hide_render', 'hide_viewport'):
                drv = ob.driver_add(path).driver
                drv.type = 'SCRIPTED'
                drv.expression = expr
                v = drv.variables.new()
                v.name = 'd'
                v.type = 'LOC_DIFF'
                v.targets[0].id = camera
                v.targets[1].id = root
    root['seedthree_auto_lod'] = json.dumps({n: list(b) for n, b in bands.items()})
    return bands


def remove_auto_lod(tree, show='LOD0'):
    for n, objs in tree['objects'].items():
        for ob in objs:
            _clear(ob)
            ob.hide_render = ob.hide_viewport = n != show
    tree['object'].pop('seedthree_auto_lod', None)


def visible_levels(tree, **dists):
    """The built levels the app renders, nearest first (a mobile tree skips its hidden mesh
    LODs: its near view is the card LOD2, as the app's HUD renumbers it)."""
    d = level_distances(tree, **dists)
    return [n for n, v in sorted(((n, v) for n, v in d.items() if v is not None), key=lambda t: t[1])
            if tree['objects'].get(n)]


def preview(tree, which='AUTO', camera=None, **dists):
    """The app's Preview level: 'AUTO' switches by camera distance (auto_lod); 'LOD0' /
    'LOD1' / 'LOD2' force the n-th VISIBLE geometry level (so on a mobile tree 'LOD0' is the
    card LOD2, like the app's dropdown); 'BB' the billboard (or the farthest level).
    Returns the bands (AUTO) or the level shown."""
    if str(which).upper() == 'AUTO':
        return auto_lod(tree, camera, **dists)
    vis = visible_levels(tree, **dists) or list(tree['objects'])
    if which == 'BB':
        target = 'BB' if 'BB' in vis else vis[-1]
    else:
        geo = [n for n in vis if n != 'BB'] or vis
        target = geo[min(int(str(which)[3:] or 0), len(geo) - 1)]
    remove_auto_lod(tree, show=target)
    return target


def _fov(cam_ob, scene):
    cd = cam_ob.data
    r = scene.render
    aspect = (r.resolution_x * r.pixel_aspect_x) / max(1e-9, r.resolution_y * r.pixel_aspect_y)
    sw, sh = cd.sensor_width, cd.sensor_height
    fit = cd.sensor_fit
    if fit == 'VERTICAL':
        v = 2 * math.atan(sh / (2 * cd.lens))
        h = 2 * math.atan(math.tan(v / 2) * aspect)
    elif fit == 'HORIZONTAL' or aspect >= 1:
        h = 2 * math.atan(sw / (2 * cd.lens))
        v = 2 * math.atan(math.tan(h / 2) / aspect)
    else:
        v = 2 * math.atan(sw / (2 * cd.lens))
        h = 2 * math.atan(math.tan(v / 2) * aspect)
    return v, h


def frame_camera_to_tree(tree, camera=None, elevation_deg=18.0, margin=1.08, min_distance=2.0, max_distance=300.0,
                         apply_auto_lod=None):
    """main.js frameCameraToTree: keep the camera's heading, look down 18 degrees at the
    plant's box centre from the distance that fits the box (x 1.08), then derive the switch
    distances from that framing: lod1 = base x mult.lod1, lod2 = max(lod1 + 5, base x mult.lod2),
    billboard = max(lod2 + 10, base x mult.billboard), mult = the species'
    lodDistanceMultipliers or (1.5, 3.0, 5.5). They are stored on the root and returned."""
    scene = bpy.context.scene
    camera = camera or scene.camera
    if camera is None:
        raise ValueError('[seedthree] frame_camera_to_tree needs a camera')
    bpy.context.view_layer.update()
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for objs in tree['objects'].values():
        for ob in objs:
            if ob.type != 'MESH':
                continue
            for c in ob.bound_box:
                w = ob.matrix_world @ Vector(c)
                lo = Vector(map(min, lo, w))
                hi = Vector(map(max, hi, w))
    center = (lo + hi) / 2
    size = hi - lo
    vfov, hfov = _fov(camera, scene)
    half_h = size.z / 2
    half_w = max(size.x, size.y) / 2
    dist = max(half_h / math.tan(vfov / 2), half_w / math.tan(hfov / 2)) * margin
    dist = min(max(dist, min_distance + 1), max_distance - 1)
    d = camera.location - center
    if d.length_squared < 1e-6:
        d = Vector((16.0, -20.0, 4.5))
    az = math.atan2(d.y, d.x)
    el = math.radians(elevation_deg)
    direction = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el))).normalized()
    camera.location = center + direction * dist
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    sink = tree['tree']['plantSink']
    origin = tree['object'].matrix_world.translation - Vector((0.0, 0.0, sink))
    base = (camera.location - origin).length
    mult = tree['shaped'].get('lodDistanceMultipliers') or DEFAULT_MULT
    d1 = int(math.floor(base * mult['lod1'] + 0.5))
    d2 = max(d1 + 5, int(math.floor(base * mult['lod2'] + 0.5)))
    bb = max(d2 + 10, int(math.floor(base * mult['billboard'] + 0.5)))
    out = {'lodBaseDist': base, 'lod1Dist': d1, 'lod2Dist': d2, 'billboardDist': bb}
    tree['object']['seedthree_lod_dist'] = json.dumps(out)
    if apply_auto_lod or (apply_auto_lod is None and tree['object'].get('seedthree_auto_lod')):
        auto_lod(tree, camera)
    return out
