"""The app's two example scenes, built in Blender:

  reference_turntable   scripts/reference/eidoverse-tree-reference.js (+ the
                        render-eidoverse-tree.ps1 launcher): a neutral, repeatable
                        three-probe turntable of one species at LOD0, wind off
  example_scene         src/api/example-eidoverse-scene.js: how a film plants a SeedThree
                        tree (white oak seed 42, wind 0.35, the app's shadow-ready sun,
                        an orbiting camera)

    from seedthree.scene.examples import EXAMPLES
    shot = EXAMPLES['reference_turntable'](species='paperBirch', seed=1)
    shot['probe_frames']        # the three frames the reference compares (left 3/4, front, right 3/4)

Everything is keyed (the camera path), so the saved .blend renders any frame on its own.
three -> Blender axes: (x, y, z) -> (x, -z, y). The JS ACES tone map becomes AgX 'High
Contrast' at log2(exposure) + 0.23 stops (tonemap.py).
"""

import math

import bpy
from mathutils import Vector

from .. import api

REFERENCE_SPECIES = ('paperBirch', 'quakingAspen', 'americanSycamore', 'floweringDogwood', 'weepingWillow')


def _lin(h):
    def c(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255))


def _bl(v):
    return Vector((v[0], -v[2], v[1]))


def hemisphere_world(sky, ground, intensity, name, background=None, background_strength=1.0):
    """three's HemisphereLight as the world: sky colour above the horizon, ground colour
    below, radiance intensity / pi (a Lambert surface then gets three's irradiance).
    background: the scene.background colour camera rays see (hex; three draws it flat,
    through the tone map like the frame) at background_strength; None shows the
    hemisphere itself."""
    w = bpy.data.worlds.new(name)
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    gt = nt.nodes.new('ShaderNodeMath')
    gt.operation = 'GREATER_THAN'
    nt.links.new(sep.outputs['Z'], gt.inputs[0])
    gt.inputs[1].default_value = 0.0
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    nt.links.new(gt.outputs[0], mix.inputs[0])
    mix.inputs[6].default_value = (*_lin(ground), 1)
    mix.inputs[7].default_value = (*_lin(sky), 1)
    bg = nt.nodes.new('ShaderNodeBackground')
    nt.links.new(mix.outputs[2], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = intensity / math.pi
    out = nt.nodes.new('ShaderNodeOutputWorld')
    surf = bg.outputs[0]
    if background is not None:
        flat = nt.nodes.new('ShaderNodeBackground')
        flat.inputs['Color'].default_value = (*_lin(background), 1)
        flat.inputs['Strength'].default_value = float(background_strength)
        lp = nt.nodes.new('ShaderNodeLightPath')
        pick = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(lp.outputs['Is Camera Ray'], pick.inputs[0])
        nt.links.new(bg.outputs[0], pick.inputs[1])
        nt.links.new(flat.outputs[0], pick.inputs[2])
        surf = pick.outputs[0]
    nt.links.new(surf, out.inputs['Surface'])
    return w


def _scene_basics(scene, w, h, aces_exposure, samples, fps=30):
    """aces_exposure: the JS renderer.toneMappingExposure (ACES), as the matching AgX view."""
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = int(w), int(h)
    scene.render.resolution_percentage = 100
    scene.render.fps = fps
    scene.eevee.taa_render_samples = samples
    for attr, val in (('use_shadows', True), ('use_raytracing', True)):
        if hasattr(scene.eevee, attr):
            setattr(scene.eevee, attr, val)
    from .tonemap import aces_view
    aces_view(scene, aces_exposure)


def _camera(scene, fov_v_deg, near, far, name):
    cd = bpy.data.cameras.new(name)
    cd.sensor_fit = 'VERTICAL'
    cd.sensor_height = 24.0
    cd.lens = 12.0 / math.tan(math.radians(fov_v_deg) / 2)
    cd.clip_start, cd.clip_end = near, far
    cam = bpy.data.objects.new(name, cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def _key_linear(ob, path, frame, index=-1):
    ob.keyframe_insert(path, index=index, frame=frame)


def _linear_keys(ob):
    ad = ob.animation_data
    if ad is None or ad.action is None:
        return
    from .ambience import _fcurves
    for fc in _fcurves(ad.action):
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'


def _sun(scene, color, intensity, name, angle_deg=0.53):
    ld = bpy.data.lights.new(name, 'SUN')
    ld.color = _lin(color)
    ld.energy = intensity
    ld.angle = math.radians(angle_deg)
    ob = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(ob)
    return ob


def _aim(ob, frm, to):
    ob.location = frm
    # compatible with the previous key, so the keyed Euler never wraps between frames
    ob.rotation_euler = (Vector(to) - Vector(frm)).to_track_quat('-Z', 'Y').to_euler('XYZ', ob.rotation_euler)


def reference_turntable(species='paperBirch', seed=1, width=960, height=960, fps=30, duration=0.8, samples=32,
                        scene=None, light_probe=True):
    """eidoverse-tree-reference.js: the species at LOD0 with the wind off, framed by a 47-degree
    camera that fits its height and width with a 12 % margin, swinging from the left
    three-quarter (-38 degrees) over the front to the right three-quarter (+68) at 5.5 %
    of the tree's height above its centre; a hemisphere 0xeaf4ff / 0x46503f x 1.45, a sun
    0xfff1d8 x 3.2 from (-0.85, 1.45, 0.75) x size, a 0x70786d ground 2.4 x the crown, the
    flat 0xaeb9bf backdrop, ACES at exposure 1.05.
    -> {'tree', 'camera', 'sun', 'ground', 'frames', 'probe_frames', 'dimensions'}"""
    scene = scene or bpy.context.scene
    frames = max(1, int(round(duration * fps)))
    scene.frame_start, scene.frame_end = 1, frames
    _scene_basics(scene, width, height, 1.05, samples, fps)
    # scene.background 0xaeb9bf: the flat backdrop behind the ground card
    scene.world = hemisphere_world(0xeaf4ff, 0x46503f, 1.45, 'SeedThree reference sky', background=0xaeb9bf)
    cam = _camera(scene, 47, 0.05, 500, 'SeedThree reference camera')
    sun = _sun(scene, 0xfff1d8, 3.2, 'SeedThree reference sun')
    api.set_wind(strength=0.0, speed=1.0)
    tree = api.create_tree(species=species, seed=seed, level='LOD0', sun_light=sun)
    bb = tree['stats']['boundingBoxWorld']
    lo, hi = Vector(bb['min']), Vector(bb['max'])
    size = hi - lo                                  # Blender axes: z is the height
    center = (lo + hi) / 2
    width_m, depth_m, height_m = size.x, size.y, size.z
    aspect = width / height
    vf = math.radians(47)
    hf = 2 * math.atan(math.tan(vf / 2) * aspect)
    dist = max(height_m / (2 * math.tan(vf / 2)), max(width_m, depth_m) / (2 * math.tan(hf / 2))) * 1.12
    cam.data.clip_start = max(0.02, dist / 500)
    cam.data.clip_end = max(100, dist * 8)
    ext = max(12, max(width_m, depth_m) * 2.4)
    me = bpy.data.meshes.new('SeedThree reference ground')
    s = ext / 2
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new('SeedThree reference ground', me)
    ground.location = (center.x, center.y, lo.z - 0.015)
    scene.collection.objects.link(ground)
    gm = bpy.data.materials.new('SeedThree reference ground')
    gm.use_nodes = True
    p = gm.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*_lin(0x70786d), 1)
    p.inputs['Roughness'].default_value = 0.92
    me.materials.append(gm)
    scale = max(height_m, width_m, depth_m)
    sun_pos = center + _bl((-0.85 * scale, 1.45 * scale, 0.75 * scale))
    _aim(sun, sun_pos, center)
    # the camera: three's angle a about +Y puts it at (sin a, ., cos a) x dist around the target
    duration_s = max(1 / fps, (frames - 1) / fps)
    for f in range(1, frames + 1):
        t = (f - 1) / fps
        prog = min(1.0, max(0.0, t / duration_s))
        a = math.radians(-38 + 106 * prog)
        pos = center + _bl((math.sin(a) * dist, height_m * 0.055, math.cos(a) * dist))
        _aim(cam, pos, center)
        cam.keyframe_insert('location', frame=f)
        cam.keyframe_insert('rotation_euler', frame=f)
    _linear_keys(cam)
    if light_probe:
        api.light_probe(tree)
    probes = sorted({1, (frames + 1) // 2, frames})
    return {'tree': tree, 'camera': cam, 'sun': sun, 'ground': ground, 'frames': frames, 'probe_frames': probes,
            'dimensions': {'width': width_m, 'height': height_m, 'depth': depth_m}, 'distance': dist}


def example_scene(width=1280, height=720, fps=30, seconds=8.0, samples=32, scene=None, light_probe=True):
    """example-eidoverse-scene.js: a white oak (seed 42, LOD0, wind 0.35) under the app's
    shadow-ready sun (0xfff0dd x 3.2 from (14, 18, 10)) and a hemisphere 0xcfe6ff /
    0x5a4a36 x 1.1, a 45-degree camera circling at 24 m radius, 6.5 m up, looking at
    (0, 5.5, 0): angle 0.6 + 0.1 t. The JS leaves the ground to the film; a plain
    0x6b6b5a ground catches the shadows here. -> {'tree', 'camera', 'sun', 'ground'}"""
    scene = scene or bpy.context.scene
    frames = max(1, int(round(seconds * fps)))
    scene.frame_start, scene.frame_end = 1, frames
    _scene_basics(scene, width, height, 1.0, samples, fps)
    # the JS leaves the sky to the film (its frame clears to black); a plain sky in the
    # hemisphere's own colour stands in, with no ground-coloured band below the horizon
    scene.world = hemisphere_world(0xcfe6ff, 0x5a4a36, 1.1, 'SeedThree example sky', background=0xcfe6ff,
                                   background_strength=1.1 / math.pi)
    cam = _camera(scene, 45, 0.1, 300, 'SeedThree example camera')
    sun = _sun(scene, 0xfff0dd, 3.2, 'SeedThree example sun')
    _aim(sun, _bl((14, 18, 10)), (0, 0, 0))
    api.set_wind(strength=0.35)
    tree = api.create_tree(species='whiteOak', seed=42, level='LOD0', sun_light=sun)
    me = bpy.data.meshes.new('SeedThree example ground')
    s = 60
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new('SeedThree example ground', me)
    scene.collection.objects.link(ground)
    gm = bpy.data.materials.new('SeedThree example ground')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*_lin(0x6b6b5a), 1)
    me.materials.append(gm)
    target = _bl((0, 5.5, 0))
    for f in range(1, frames + 1):
        t = (f - 1) / fps
        a = 0.6 + t * 0.1
        _aim(cam, _bl((math.cos(a) * 24, 6.5, math.sin(a) * 24)), target)
        cam.keyframe_insert('location', frame=f)
        cam.keyframe_insert('rotation_euler', frame=f)
    _linear_keys(cam)
    if light_probe:
        api.light_probe(tree)
    return {'tree': tree, 'camera': cam, 'sun': sun, 'ground': ground, 'frames': frames}


EXAMPLES = {
    'reference_turntable': reference_turntable,
    'example_scene': example_scene,
}
