"""The SeedThree app's demo scene in Blender (src/main.js): a plant on its biome.

    from seedthree.scene import build_demo_scene
    demo = build_demo_scene('whiteOak', seed=1)          # the app's first screen, as a shot
    demo = build_demo_scene('joshuaTree', seed=7, sun_az=230, sun_el=12, frames=240, autorotate=True)

What main.js builds, in order: the biome (environment.js: the gradient sky with its sun
glow, the terrain ring with the grass / five-rock blend, the sun and hemisphere lights;
rocks and scree, fallen limbs of the species' bark, meadow grass or desert scrub), the
eight volumetric clouds, the hero plant (every LOD level, the far billboard, switched by
camera distance), the frozen grove of 64 instanced copies around it, the ring haze, the
ambient soundscape, the 1.8 m scale reference, and the camera framed to the plant the
way a species switch frames it (with the species' LOD distances), optionally orbiting
(the app's auto-rotate). Keyed: the wind, the camera orbit, the LOD drivers and the
forest rebin all play from a saved .blend.

Defaults follow the app: sun azimuth 40, elevation 32 (late afternoon), wind 0.5 / 1.0,
haze on, AO (N8AO) off, ACES exposure 1.3 -> AgX at log2(1.3) stops.
"""

import math

import bpy
from mathutils import Vector

from .. import api
from . import terrain as T
from . import decor as D
from . import atmosphere as A
from . import ambience as S


def _scene_settings(scene, w, h, samples, ao):
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    ee = scene.eevee
    ee.taa_render_samples = samples
    for attr, val in (('use_shadows', True), ('use_raytracing', True), ('shadow_ray_count', 2),
                      ('shadow_step_count', 8), ('volumetric_end', 900.0), ('volumetric_tile_size', '8'),
                      ('use_volumetric_shadows', False)):
        if hasattr(ee, attr):
            try:
                setattr(ee, attr, val)
            except TypeError:
                pass
    if hasattr(ee, 'fast_gi_method'):
        try:
            ee.fast_gi_method = 'GLOBAL_ILLUMINATION' if ao else 'AMBIENT_OCCLUSION_ONLY'
        except TypeError:
            pass
    if hasattr(ee, 'use_fast_gi'):
        ee.use_fast_gi = bool(ao)
    vs = scene.view_settings
    vs.view_transform = 'AgX'
    try:
        vs.look = 'AgX - Base Contrast'
    except TypeError:
        pass
    vs.exposure = math.log2(1.3)


def scale_reference(scene, visible=True):
    """The app's 1.8 m human-height box (0.5 x 1.8 x 0.3, orange-red) at three (5, 0.9, 3)."""
    me = bpy.data.meshes.new('SeedThree scale reference')
    sx, sy, sz = 0.25, 0.15, 0.9
    v = [(x, y, z) for x in (-sx, sx) for y in (-sy, sy) for z in (-sz, sz)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me.from_pydata(v, [], f)
    ob = bpy.data.objects.new('SeedThree scale reference', me)
    scene.collection.objects.link(ob)
    ob.location = (5.0, -3.0, 0.9)
    m = bpy.data.materials.new('SeedThree scale reference')
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*T._lin(0xff5a3c), 1)
    p.inputs['Roughness'].default_value = 0.7
    me.materials.append(m)
    ob.hide_render = ob.hide_viewport = not visible
    return ob


def orbit_camera(scene, cam, target, speed=1.0, frame_start=None, frame_end=None):
    """OrbitControls.autoRotate: 2.0 = one orbit per 30 s at 60 fps, so `speed` x 1/60 turn
    per second around the target; keyed on an Empty the camera is parented to."""
    fps = scene.render.fps / scene.render.fps_base
    f0 = scene.frame_start if frame_start is None else frame_start
    f1 = scene.frame_end if frame_end is None else frame_end
    piv = bpy.data.objects.new('SeedThree orbit', None)
    scene.collection.objects.link(piv)
    piv.location = target
    mw = cam.matrix_world.copy()
    cam.parent = piv
    cam.matrix_parent_inverse = piv.matrix_world.inverted()
    cam.matrix_world = mw
    turns_per_s = speed / 60.0
    for f in (f0, f1):
        piv.rotation_euler = (0.0, 0.0, 2 * math.pi * turns_per_s * (f - f0) / fps)
        piv.keyframe_insert('rotation_euler', index=2, frame=f)
    if piv.animation_data and piv.animation_data.action:
        from .ambience import _fcurves
        for fc in _fcurves(piv.animation_data.action):
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'
            fc.extrapolation = 'LINEAR'
    return piv


def build_demo_scene(species='whiteOak', seed=1, controls=None, lod=None, sun_az=40.0, sun_el=32.0,
                     forest_count=64, haze=True, clouds=True, decoration=True, audio=True, scale_ref=False,
                     ao=False, level='AUTO', billboard=True, cards=True, autorotate=False, autorotate_speed=1.0,
                     frames=None, wind=(0.5, 1.0), radius=280, resolution=(1280, 720), samples=32, scene=None,
                     light_probe=True, terrain_segs=320, spom=False):
    """Build the app's scene around one plant. spom: the app's Parallax terrain toggle (off by
    default there too). Returns a dict of what it made."""
    scene = scene or bpy.context.scene
    if frames:
        scene.frame_start, scene.frame_end = 1, int(frames)
    _scene_settings(scene, resolution[0], resolution[1], samples, ao)
    shaped, merged = api.shaped_species(species, controls, seed)
    biome = shaped.get('biome') or 'temperate'
    desert = biome == 'desert'
    env = T.build_environment(scene, biome, seed, radius, 15, 12, shaped, sun_az, sun_el, terrain_segs, spom=spom)
    smp = env['sampler']
    out = {'environment': env, 'biome': biome}
    if decoration:
        rbase = (shaped.get('rockTexture') or 'rock_albedo.png').replace('_albedo.png', '')
        out['rocks'] = D.build_rocks(smp, seed, 15, 44 if desert else 32, rock_base=rbase)
        out['limbs'] = D.build_fallen_limbs(smp, shaped, merged, seed, 15, 10 if desert else 16)
        out['ground'] = D.build_scrub(smp, seed, 15) if desert else D.build_grass(smp, seed, 15)
    if clouds:
        out['clouds'] = A.build_clouds(count=8, altitude=85, spread=190)
    api.set_wind(strength=wind[0], speed=wind[1])
    tree = api.create_tree(species=species, seed=seed, controls=controls, lod=lod,
                           level='ALL' if level == 'AUTO' else level, billboard=billboard, cards=cards,
                           sun_light=env['sun'])
    out['tree'] = tree
    camd = bpy.data.cameras.new('SeedThree camera')
    camd.sensor_fit = 'VERTICAL'
    camd.sensor_height = 24.0
    camd.lens = 12.0 / math.tan(math.radians(25))     # three's 50-degree vertical fov
    camd.clip_start, camd.clip_end = 0.1, 1600.0
    cam = bpy.data.objects.new('SeedThree camera', camd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = (16.0, -20.0, 13.0)
    from ..bl.lod import frame_camera_to_tree, auto_lod
    dists = frame_camera_to_tree(tree, cam)
    out['lodDistances'] = dists
    if level == 'AUTO':
        auto_lod(tree, cam)
    if forest_count and billboard:
        out['forest'] = api.make_forest_ring(tree, count=forest_count, seed=seed, billboard_dist=dists['billboardDist'],
                                             height_at=smp.height_xy, meadow_at=smp.meadow_xy)
    if haze:
        if desert:
            col, dens, start = T._lin(0xcabfa2), 1.9, 40.0
        else:
            f, r = T._lin(env['fog']), T._lin(0xa8998a)
            col, dens, start = tuple(a + (b - a) * 0.18 for a, b in zip(f, r)), 1.0, 110.0
        out['haze'] = A.build_haze(scene, col, dens, start)
    if audio:
        out['audio'] = S.build_ambience(scene, biome, seed)
    out['scaleRef'] = scale_reference(scene, scale_ref)
    if autorotate:
        h = tree['stats']['summary'].get('heightMeters', 8)
        out['orbit'] = orbit_camera(scene, cam, Vector((0.0, 0.0, h * 0.5)), autorotate_speed)
    if light_probe:
        api.light_probe(tree)
    out['camera'] = cam
    return out
