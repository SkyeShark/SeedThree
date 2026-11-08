"""SeedThree's multichannel bakes in EEVEE: branch cards, rosette cards and the
crossplane billboard impostor (src/core/impostor.js bakeGroupToTextures /
bakeImpostor, src/core/branch-cards.js bakeBranchCards / bakeRosetteCards).

The JS renders a throwaway scene through orthographic cameras four times per
view, swapping every mesh's material for a capture material per channel:

  albedo        the source's base colour (the JS lights flat white: 3/pi of it)
  normal        the geometric shading normal in WORLD space x 0.5 + 0.5 (three axes)
  rough         the roughness map's G (three's convention), or the constant
  trans         the diffuse-transmission (translucency) map's R, or 0

keeps the source's alpha cutout, reads the pixels back, converts albedo to sRGB,
dilates every channel's opaque edge colours 10-12 pixels into the transparent
margin, and builds textures. Here the same: one capture copy per source material
with an emission switch ("SeedThree Bake Channel"), an EEVEE render per channel to
a float EXR in a temporary scene, numpy for the readback, sRGB, alpha and dilation,
and packed 8-bit images (so a saved .blend renders on its own).

Differences, each on purpose: the albedo is the base colour exactly (not 3/pi of
it); the render is antialiased (the JS render target has no MSAA) and premultiplied
edges are un-premultiplied before dilation; sRGB is encoded from float (the JS
quantizes linear to 8 bits first, which bands dark greens); the normal channel holds
the raw smooth normal, not turned toward the camera on back faces, as impostor.js
intends (three r184 face-flips it on DoubleSide materials, which tilts every front
card's detail toward the front camera and every side card's toward the side camera:
a lighting seam down the crossing).
"""

import math
import os
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Vector

CHANNELS = ('albedo', 'normal', 'rough', 'trans')
GROUP = 'SeedThree Bake Channel'


# ---- pixel processing (impostor.js processPixels / dilate) ---------------------

def lin_to_srgb(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def dilate(data, passes):
    """Flood opaque edge colours into transparent margins (colour only; alpha stays 0)
    so filtering at the alpha edge never blends toward black. data: (h, w, 4) uint8,
    top row first; alpha > 8 counts as filled. Matches the JS pass for pass."""
    filled = data[..., 3] > 8
    for _ in range(passes):
        f = filled
        rgb = data[..., :3].astype(np.float64)
        sums = np.zeros(rgb.shape)
        cnt = np.zeros(f.shape)
        sums[:, 1:] += np.where(f[:, :-1, None], rgb[:, :-1], 0)
        cnt[:, 1:] += f[:, :-1]
        sums[:, :-1] += np.where(f[:, 1:, None], rgb[:, 1:], 0)
        cnt[:, :-1] += f[:, 1:]
        sums[1:] += np.where(f[:-1, :, None], rgb[:-1], 0)
        cnt[1:] += f[:-1]
        sums[:-1] += np.where(f[1:, :, None], rgb[1:], 0)
        cnt[:-1] += f[1:]
        new = (~f) & (cnt > 0)
        if not new.any():
            break
        data[new, :3] = np.clip(np.rint(sums[new] / cnt[new][:, None]), 0, 255).astype(np.uint8)
        filled = f | new
    return data


def process_pixels(rgba, dilate_passes, srgb):
    """Float RGBA (top row first, straight alpha) -> dilated uint8 RGBA."""
    rgb = rgba[..., :3]
    if srgb:
        rgb = lin_to_srgb(rgb)
    out = np.empty(rgba.shape, np.uint8)
    out[..., :3] = np.clip(np.rint(np.clip(rgb, 0, 1) * 255), 0, 255)
    out[..., 3] = np.clip(np.rint(np.clip(rgba[..., 3], 0, 1) * 255), 0, 255)
    return dilate(out, dilate_passes)


def image_from_pixels(name, data, srgb, pack=True):
    """A packed 8-bit image from uint8 RGBA (top row first)."""
    h, w = data.shape[:2]
    old = bpy.data.images.get(name)
    if old is not None:
        bpy.data.images.remove(old)
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    img.alpha_mode = 'STRAIGHT'
    img.pixels.foreach_set((data[::-1].astype(np.float32) / 255.0).ravel())
    img.update()
    if pack:
        img.pack()
    return img


# ---- capture materials ----------------------------------------------------------

def channel_group():
    ng = bpy.data.node_groups.get(GROUP)
    if ng is not None and ng.bl_idname == 'ShaderNodeTree' and 'Channel' in ng.nodes and 'RawNormal' in ng.nodes:
        return ng
    if ng is not None:
        ng.name = GROUP + ' (old)'
    ng = bpy.data.node_groups.new(GROUP, 'ShaderNodeTree')
    for nm, kind in (('Base', 'NodeSocketColor'), ('Rough', 'NodeSocketFloat'), ('Trans', 'NodeSocketFloat'),
                     ('Alpha', 'NodeSocketFloat')):
        ng.interface.new_socket(name=nm, in_out='INPUT', socket_type=kind)
    ng.interface.new_socket(name='Color', in_out='OUTPUT', socket_type='NodeSocketColor')
    N = ng.nodes
    L = ng.links
    gin = N.new('NodeGroupInput')
    gout = N.new('NodeGroupOutput')
    ch = N.new('ShaderNodeValue')
    ch.name = ch.label = 'Channel'
    ch.outputs[0].default_value = 0.0
    geo = N.new('ShaderNodeNewGeometry')
    # The raw geometric normal, NOT turned toward the camera on back faces: impostor.js
    # bakes "raw world-space geometric normals (no face flip)" so that the front and the
    # side card agree where they cross. (three r184's normalWorld is face-flipped on a
    # DoubleSide material, so the app's bake records camera-facing normals and its two
    # cards light differently: a seam down the crossing.)
    flip = N.new('ShaderNodeMath')
    flip.name = 'RawNormal'
    flip.operation = 'MULTIPLY_ADD'
    L.new(geo.outputs['Backfacing'], flip.inputs[0])
    flip.inputs[1].default_value = -2.0
    flip.inputs[2].default_value = 1.0
    raw = N.new('ShaderNodeVectorMath')
    raw.operation = 'SCALE'
    L.new(geo.outputs['Normal'], raw.inputs[0])       # the smooth normal (three's normalViewGeometry)
    L.new(flip.outputs[0], raw.inputs['Scale'])
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(raw.outputs['Vector'], sep.inputs[0])
    n3 = N.new('ShaderNodeCombineXYZ')            # Blender (x, y, z) -> three (x, z, -y)
    L.new(sep.outputs['X'], n3.inputs[0])
    L.new(sep.outputs['Z'], n3.inputs[1])
    neg = N.new('ShaderNodeMath')
    neg.operation = 'MULTIPLY'
    neg.inputs[1].default_value = -1.0
    L.new(sep.outputs['Y'], neg.inputs[0])
    L.new(neg.outputs[0], n3.inputs[2])
    enc = N.new('ShaderNodeVectorMath')
    enc.operation = 'MULTIPLY_ADD'
    L.new(n3.outputs[0], enc.inputs[0])
    enc.inputs[1].default_value = (0.5, 0.5, 0.5)
    enc.inputs[2].default_value = (0.5, 0.5, 0.5)
    rough = N.new('ShaderNodeCombineXYZ')
    for i in range(3):
        L.new(gin.outputs['Rough'], rough.inputs[i])
    trans = N.new('ShaderNodeCombineXYZ')
    L.new(gin.outputs['Trans'], trans.inputs[0])
    L.new(gin.outputs['Alpha'], trans.inputs[1])
    acc = None
    for idx, sock in enumerate((gin.outputs['Base'], enc.outputs['Vector'], rough.outputs[0], trans.outputs[0])):
        cmp = N.new('ShaderNodeMath')
        cmp.operation = 'COMPARE'
        L.new(ch.outputs[0], cmp.inputs[0])
        cmp.inputs[1].default_value = float(idx)
        cmp.inputs[2].default_value = 0.5
        sc = N.new('ShaderNodeVectorMath')
        sc.operation = 'SCALE'
        L.new(sock, sc.inputs[0])
        L.new(cmp.outputs[0], sc.inputs['Scale'])
        if acc is None:
            acc = sc.outputs['Vector']
        else:
            ad = N.new('ShaderNodeVectorMath')
            ad.operation = 'ADD'
            L.new(acc, ad.inputs[0])
            L.new(sc.outputs['Vector'], ad.inputs[1])
            acc = ad.outputs['Vector']
    L.new(acc, gout.inputs['Color'])
    return ng


def set_channel(name):
    channel_group().nodes['Channel'].outputs[0].default_value = float(CHANNELS.index(name))


def _src_socket(sock):
    return sock.links[0].from_socket if sock.is_linked else None


def capture_material(src):
    """A copy of `src` whose surface is Emission(channel switch), keeping its alpha cutout."""
    name = '%s [bake capture]' % src.name
    old = bpy.data.materials.get(name)
    if old is not None:
        bpy.data.materials.remove(old)
    mat = src.copy()
    mat.name = name
    nt = mat.node_tree
    nodes = nt.nodes
    out = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None) or \
        next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None)
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    grp = nodes.new('ShaderNodeGroup')
    grp.node_tree = channel_group()
    if bsdf is not None:
        for sname, gname in (('Base Color', 'Base'), ('Roughness', 'Rough')):
            s = _src_socket(bsdf.inputs[sname])
            if s is not None:
                nt.links.new(s, grp.inputs[gname])
            else:
                dv = bsdf.inputs[sname].default_value
                grp.inputs[gname].default_value = tuple(dv) if gname == 'Base' else float(dv)
    else:
        grp.inputs['Base'].default_value = (0.5, 0.5, 0.5, 1.0)
        grp.inputs['Rough'].default_value = 1.0
    # alpha cutout: Mix(Transparent, surface) on the output; keep = alpha > threshold
    mix = None
    if out is not None and out.inputs['Surface'].is_linked:
        n = out.inputs['Surface'].links[0].from_node
        if n.type == 'MIX_SHADER' and n.inputs[1].is_linked and n.inputs[1].links[0].from_node.type == 'BSDF_TRANSPARENT':
            mix = n
    alpha_src = None
    if mix is not None and mix.inputs[0].is_linked:
        keep = mix.inputs[0].links[0].from_node
        if keep.type == 'MATH' and keep.operation == 'GREATER_THAN' and keep.inputs[0].is_linked:
            alpha_src = keep.inputs[0].links[0].from_socket
    if alpha_src is not None:
        nt.links.new(alpha_src, grp.inputs['Alpha'])
    else:
        grp.inputs['Alpha'].default_value = 1.0
    tex = next((n for n in nodes if n.type == 'TEX_IMAGE' and n.image is not None and 'translucency' in n.image.name.lower()), None)
    if tex is not None:
        sep = nodes.new('ShaderNodeSeparateColor')
        nt.links.new(tex.outputs['Color'], sep.inputs[0])
        nt.links.new(sep.outputs[0], grp.inputs['Trans'])
    else:
        grp.inputs['Trans'].default_value = 0.0
    em = nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(grp.outputs['Color'], em.inputs['Color'])
    if mix is not None:
        nt.links.new(em.outputs[0], mix.inputs[2])
    elif out is not None:
        nt.links.new(em.outputs[0], out.inputs['Surface'])
    if out is not None and 'Thickness' in out.inputs:
        for l in list(out.inputs['Thickness'].links):
            nt.links.remove(l)
    return mat


# ---- the render ---------------------------------------------------------------------

def _to_bl(v):
    return Vector((v[0], -v[2], v[1]))


def _bake_scene(size, samples):
    sc = bpy.data.scenes.new('SeedThree Bake')
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = samples
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    sc.render.resolution_x = sc.render.resolution_y = int(size)
    sc.render.resolution_percentage = 100
    sc.render.use_compositing = False
    sc.render.use_sequencer = False
    im = sc.render.image_settings
    im.media_type = 'IMAGE'
    im.file_format = 'OPEN_EXR'
    im.color_depth = '32'
    im.color_mode = 'RGBA'
    sc.world = None
    cam = bpy.data.objects.new('SeedThree Bake Camera', bpy.data.cameras.new('SeedThree Bake Camera'))
    cam.data.type = 'ORTHO'
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam


def _place_camera(sc, cam, view):
    """A JS OrthographicCamera(-halfW, halfW, halfH, -halfH, near, far) at center + dir x depth
    looking at center (three axes) -> Blender, with pixel aspect for a non-square frame."""
    hw, hh = view['halfW'], view['halfH']
    c = _to_bl(view['center'])
    d = _to_bl(view['dir'])
    cam.location = c + d * view['depth']
    side = abs(view['dir'][0]) > 0.5
    cam.rotation_euler = (math.pi / 2, 0.0, math.pi / 2 if side else 0.0)
    cam.data.ortho_scale = 2 * max(hw, hh)
    cam.data.clip_start = view.get('near', 0.1)
    cam.data.clip_end = view.get('far', view['depth'] * 2)
    if hw >= hh:
        sc.render.pixel_aspect_x, sc.render.pixel_aspect_y = hw / hh, 1.0
    else:
        sc.render.pixel_aspect_x, sc.render.pixel_aspect_y = 1.0, hh / hw


def _read_exr(path, size):
    img = bpy.data.images.load(path)
    try:
        px = np.empty(size * size * 4, np.float32)
        img.pixels.foreach_get(px)
    finally:
        bpy.data.images.remove(img)
    return px.reshape(size, size, 4)[::-1].astype(np.float64)   # top row first


def bake_objects_to_textures(objects, views, size=1024, dilate_passes=12, samples=16, name='bake', pack=True,
                             keep_files=None):
    """bakeGroupToTextures: render `objects` (Blender objects, any scene) through each
    view in four channels. views: core framings (three axes: center, dir, halfW, halfH,
    depth, near, far, name). -> {view name: {channel: packed bpy image}}.
    The objects are linked into a temporary scene with capture materials swapped in,
    then restored. keep_files: a folder to also write the channel PNGs into."""
    sc, cam = _bake_scene(size, samples)
    tmp = tempfile.mkdtemp(prefix='seedthree_bake_')
    swaps = []
    mods = []
    captures = {}
    try:
        for ob in objects:
            sc.collection.objects.link(ob)
            for m in ob.modifiers:
                if m.show_render:
                    m.show_render = False
                    mods.append(m)
            for slot in ob.material_slots:
                if slot.material is None:
                    continue
                cap = captures.get(slot.material.name)
                if cap is None:
                    cap = captures[slot.material.name] = capture_material(slot.material)
                swaps.append((slot, slot.material))
                slot.link = 'OBJECT' if slot.link == 'OBJECT' else slot.link
                slot.material = cap
        out = {}
        for view in views:
            _place_camera(sc, cam, view)
            raw = {}
            for ch in CHANNELS:
                set_channel(ch)
                path = os.path.join(tmp, '%s_%s.exr' % (view['name'], ch))
                sc.render.filepath = path
                bpy.ops.render.render(write_still=True, scene=sc.name)
                if not os.path.isfile(path):
                    raise RuntimeError('[seedthree] bake render wrote nothing: %s' % path)
                raw[ch] = _read_exr(path, size)
            cov = raw['albedo'][..., 3]
            safe = np.where(cov > 1e-6, cov, 1.0)[..., None]
            tex_alpha = np.clip(raw['trans'][..., 1] / safe[..., 0], 0, 1)
            alpha = np.where(cov > 1e-6, cov * tex_alpha, 0.0)
            imgs = {}
            for ch in CHANNELS:
                rgba = raw[ch].copy()
                rgba[..., :3] = rgba[..., :3] / safe
                if ch == 'trans':
                    rgba[..., 1] = rgba[..., 0]
                    rgba[..., 2] = rgba[..., 0]
                rgba[..., 3] = alpha
                data = process_pixels(rgba, dilate_passes, srgb=(ch == 'albedo'))
                img = image_from_pixels('%s %s %s' % (name, view['name'], ch), data, ch == 'albedo', pack)
                if keep_files:
                    os.makedirs(keep_files, exist_ok=True)
                    img.filepath_raw = os.path.join(keep_files, '%s_%s_%s.png' % (name.replace(' ', '_'), view['name'], ch))
                    img.file_format = 'PNG'
                    img.save()
                    if pack:
                        img.pack()
                imgs[ch] = img
            out[view['name']] = imgs
        return out
    finally:
        for slot, mat in swaps:
            slot.material = mat
        for m in mods:
            m.show_render = True
        for ob in objects:
            if ob.name in sc.collection.objects:
                sc.collection.objects.unlink(ob)
        for cap in captures.values():
            bpy.data.materials.remove(cap)
        camdata = cam.data
        bpy.data.objects.remove(cam)
        bpy.data.cameras.remove(camdata)
        bpy.data.scenes.remove(sc)
        for f in os.listdir(tmp):
            try:
                os.remove(os.path.join(tmp, f))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass
