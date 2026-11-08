"""light_probe(): a baked Light Probe Volume fitted around SeedThree plants.

EEVEE lights a closure's indirect (world) light from its probes. With only the
world probe that light is unoccluded, so inside a canopy every leaf sees the
whole sky. The JS backlight (bl/sun.py) amplifies what reaches the leaves'
translucency when the view looks toward the sun, so without a volume probe a
backlit canopy (under the crown, a low sun behind it) glows evenly, like
frosted glass. A baked volume probe gives each leaf the sky its position
actually sees: the inside of the crown goes dark, and the sunlit sprays and sky
gaps glow. The bark and the leaves' diffuse light get the same occlusion.
Bake after the sky and sun are final; re-bake when they change.
"""

import math

import bpy
from mathutils import Vector

NAME = 'SeedThree Light Probe'


def _roots(trees):
    items = trees if isinstance(trees, (list, tuple)) else [trees]
    return [t['object'] if isinstance(t, dict) else t for t in items]


def plants_box(trees):
    """World AABB of the plants' render-visible parts, with the wind's current pose."""
    bpy.context.view_layer.update()
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for root in _roots(trees):
        for ch in root.children_recursive:
            if ch.hide_render or ch.type != 'MESH':
                continue
            for c in ch.bound_box:
                w = ch.matrix_world @ Vector(c)
                lo = Vector(map(min, lo, w))
                hi = Vector(map(max, hi, w))
    if lo.x == math.inf:
        raise ValueError('[seedthree] light_probe: no visible plant parts')
    return lo, hi


def light_probe(trees, spacing=1.5, margin=0.1, name=NAME, bake=True, collection=None, spread=0.5):
    """Fit (or refit) a Light Probe Volume around one or more plants and bake it.

    trees: a create_tree result / root Empty, or a list of them. spacing: metres
    between probe samples (resolution = size / spacing, 2..64 per axis). margin:
    extra height above and below, as a fraction. spread: extra width on every side,
    as a fraction: the volume's edge must lie where the canopy no longer shades the
    ground, or the ground shows the box as a dark rectangle (EEVEE fades to the
    world right at the outermost samples). Returns the probe object."""
    lo, hi = plants_box(trees)
    size = hi - lo
    ob = bpy.data.objects.get(name)
    if ob is None or ob.type != 'LIGHT_PROBE' or ob.data.type != 'VOLUME':
        ob = bpy.data.objects.new(name, bpy.data.lightprobes.new(name, 'VOLUME'))
        col = collection or bpy.context.scene.collection
        if isinstance(col, str):
            col = bpy.data.collections.get(col) or bpy.context.scene.collection
        col.objects.link(ob)
    ob.location = (lo + hi) / 2
    ob.rotation_euler = (0.0, 0.0, 0.0)
    grow = (1 + 2 * spread, 1 + 2 * spread, 1 + 2 * margin)
    ob.scale = [max(s, 0.5) / 2 * g for s, g in zip(size, grow)]
    pd = ob.data
    for axis, s, g in zip('xyz', size, grow):
        setattr(pd, 'resolution_' + axis, max(2, min(64, int(math.ceil(s * g / spacing)))))
    if bake:
        bake_probe(ob)
    return ob


def bake_probe(ob):
    """Bake one Light Probe Volume (EEVEE renders it on the GPU: seconds per tree)."""
    vl = bpy.context.view_layer
    with bpy.context.temp_override(active_object=ob, object=ob, selected_objects=[ob]):
        prev = vl.objects.active
        vl.objects.active = ob
        try:
            res = bpy.ops.object.lightprobe_cache_bake(subset='ACTIVE')
        finally:
            vl.objects.active = prev
    if 'FINISHED' not in res:
        raise RuntimeError('[seedthree] light probe bake returned %s' % res)
    return ob
