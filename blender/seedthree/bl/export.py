"""GLB export of a grown SeedThree plant: src/core/export-glb.js (the app's Download
GLB) and src/api/seedthree.js exportGLB (the headless proxy-material export).

    from seedthree.bl.export import export_glb
    export_glb(tree, 'white_oak.glb')                    # the app's export
    export_glb(tree, 'white_oak_proxy.glb', materials='proxy')

The app's export bakes every level to a plain hierarchy:

    <Species (seed N)>                 the plant root, sunk by plantSink
      <Species>_LOD0 .. _LOD2         one node per level (app-only mobile rungs LOD3/LOD4 are
                                      skipped; the hidden mobile mesh levels do export)
        <level>_branches              the bark (and spines) as real meshes
        <level>_leaves                every instanced part (leaves, cards, fronds, fruit) merged,
                                      one primitive per material, vertex normals bent 0.85 toward
                                      the up-biased canopy dome (fruit keeps its own normals)
      <Species>_LOD<n>                the billboard: billboard_front / billboard_side

with the `_LODn` names Unity / Unreal pipelines key on, MSFT_lod on the LOD0 node with
extras.MSFT_screencoverage from the live switch distances, and
KHR_materials_diffuse_transmission on the leaf, card and spine materials (glb.py).
Materials become plain glTF PBR: the albedo (x the tint factor), normal and roughness
maps, MASK at the material's alpha test, double sided.

materials='proxy' is the headless JS exportGLB: two flat colours (leaf green 0x6a7f4f,
bark brown 0x6b4f3a, roughness 1), no extensions. The JS chooses by mesh NAME, and its
bark mesh has none, so the bark exports green (the bark-green bug); here the bark
and spines are chosen by what they are and export brown.
"""

import math
import os
import tempfile

import bpy
import numpy as np

from .. import glb as G

ROLES = ('bark', 'spines', 'foliage', 'cards', 'fronds', 'fruit')
PLAIN = ('bark', 'spines')
PROXY_LEAF = 0x6a7f4f
PROXY_BARK = 0x6b4f3a


def role_of(ob):
    """'bark' | 'spines' | 'foliage' | 'cards' | 'fronds' | 'fruit': the last word of a part's
    name (create_tree names them '<root> <level> <role>'; Blender's .001 suffix ignored)."""
    import re
    words = re.sub(r'\.\d+$', '', ob.name).split()
    w = words[-1] if words else ''
    return w if w in ROLES else ('bark' if 'bark' in ob.name else 'foliage')


# ---- three's bounding volumes over instanced parts (the export's dome origin) ----

def _geo_sphere(P):
    P = np.asarray(P, np.float64)
    c = (P.min(0) + P.max(0)) / 2
    return c, float(np.sqrt(((P - c) ** 2).sum(1).max()))


def instanced_dome_origin(template_positions, matrices):
    """InstancedMesh.computeBoundingSphere (union, in instance order) -> its centre with y set
    to the instanced bounding box's min.y - 0.5 (export-glb.js), three axes."""
    gc, gr = _geo_sphere(template_positions)
    M = np.asarray(matrices, np.float64).astype(np.float32).astype(np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)
    center, radius, empty = np.zeros(3), -1.0, True
    for R in M:
        c = R[:3, :3] @ gc + R[:3, 3]
        r = gr * math.sqrt(max((R[:3, i] ** 2).sum() for i in range(3)))
        if empty:
            center, radius, empty = c.copy(), r, False
            continue
        if np.array_equal(center, c):
            radius = max(radius, r)
            continue
        d = c - center
        ln = np.linalg.norm(d)
        for p in (c + d / ln * r, c - d / ln * r):
            v = p - center
            l2 = v @ v
            if l2 > radius * radius:
                l = math.sqrt(l2)
                delta = (l - radius) * 0.5
                center = center + v * (delta / l)
                radius += delta
    from ..core.branch_cards import instanced_box
    box = instanced_box(template_positions, matrices)
    return np.array([center[0], box[0][1] - 0.5, center[2]])


def _groups_for(part):
    """[(template positions, matrices, face count)] per JS InstancedMesh, in mesh face order."""
    from ..core.yucca_leaves import cone_geo
    kind = part.get('kind') if part else None
    out = []
    if kind == 'cardSet':
        for m in part['meshes']:
            if m['count']:
                out.append((m['geometry']['position'], m['matrices'], m['count'] * (len(m['geometry']['index']) // 3)))
    elif kind == 'cardsGroup':
        for mm in part['members']:
            out += _groups_for(mm)
    elif kind == 'cards':
        out.append((part['template']['position'], part['matrices'], part['count'] * (len(part['template']['index']) // 3)))
    elif kind == 'cones':
        for ci, lst in enumerate(part['slots']):
            if lst:
                g = cone_geo(ci, part['coneRadialSegs'])
                out.append((g['position'], np.array([s['matrix'] for s in lst]), len(lst) * (len(g['index']) // 3)))
    return out


def _bent_mesh(src_me, groups, bend, name):
    """A copy of the mesh with corner normals lerped toward the dome (Blender axes)."""
    me = src_me.copy()
    me.name = name
    n_loops = len(me.loops)
    P = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', P)
    P = P.reshape(-1, 3).astype(np.float64)
    loop_v = np.empty(n_loops, np.int32)
    me.loops.foreach_get('vertex_index', loop_v)
    N = np.empty(n_loops * 3, np.float32)
    me.corner_normals.foreach_get('vector', N)
    N = N.reshape(-1, 3).astype(np.float64)
    if bend > 0 and groups:
        # face -> dome origin of its JS InstancedMesh
        loop_start = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get('loop_start', loop_start)
        origin_of_loop = np.zeros((n_loops, 3))
        f0 = 0
        for tmpl, mats, nfaces in groups:
            o3 = instanced_dome_origin(tmpl, mats)
            o_bl = np.array([o3[0], -o3[2], o3[1]])
            l0 = loop_start[f0] if f0 < len(loop_start) else n_loops
            f1 = f0 + nfaces
            l1 = loop_start[f1] if f1 < len(loop_start) else n_loops
            origin_of_loop[l0:l1] = o_bl
            f0 = f1
        p = P[loop_v] - origin_of_loop
        p /= np.maximum(np.linalg.norm(p, axis=1), 1e-12)[:, None]
        p[:, 2] += 0.45
        p /= np.maximum(np.linalg.norm(p, axis=1), 1e-12)[:, None]
        N = N + (p - N) * bend
        N /= np.maximum(np.linalg.norm(N, axis=1), 1e-12)[:, None]
    me.normals_split_custom_set(N.astype(np.float32).tolist())
    return me


# ---- export materials ----------------------------------------------------------------

def _hex_lin(h):
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(((h >> 16) & 255) / 255), lin(((h >> 8) & 255) / 255), lin((h & 255) / 255), 1.0)


def _images(src):
    imgs = [n.image for n in src.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image is not None] if src.use_nodes else []
    out = {'albedo': None, 'normal': None, 'rough': None, 'trans': None}
    for im in imgs:
        nm = im.name.lower()
        if nm.endswith(' normal') or '_normal' in nm:
            out['normal'] = out['normal'] or im
        elif nm.endswith(' rough') or '_roughness' in nm:
            out['rough'] = out['rough'] or im
        elif nm.endswith(' trans') or '_translucency' in nm:
            out['trans'] = out['trans'] or im
    albedos = [im for im in imgs if im not in out.values()]
    pref = None
    if 'thatch' in src.name:
        pref = next((im for im in albedos if 'thatch' in im.name.lower()), None)
    elif 'skin' in src.name:
        pref = next((im for im in albedos if '_clean' not in im.name.lower()), None)
    elif 'fronds' in src.name:
        pref = next((im for im in albedos if '_dry' not in im.name.lower()), None)
    out['albedo'] = pref or (albedos[0] if albedos else None)
    if 'thatch' in src.name:
        for k, tag in (('normal', 'thatch'), ('rough', 'thatch')):
            alt = next((n.image for n in src.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image is not None
                        and tag in n.image.name.lower() and (('normal' in n.image.name.lower()) == (k == 'normal'))
                        and (('rough' in n.image.name.lower()) == (k == 'rough'))), None)
            out[k] = alt or out[k]
    return out


def _factor(src):
    """The tint the albedo texture is multiplied by (the glTF baseColorFactor)."""
    if not src.use_nodes:
        return None
    for n in src.node_tree.nodes:
        if n.type == 'MIX' and getattr(n, 'data_type', '') == 'RGBA' and n.blend_type == 'MULTIPLY':
            a, b = n.inputs[6], n.inputs[7]
            if a.is_linked and a.links[0].from_node.type == 'TEX_IMAGE' and not b.is_linked:
                return tuple(b.default_value)
    return None


def _cutoff(src):
    if not src.use_nodes:
        return None
    for n in src.node_tree.nodes:
        if n.type == 'MATH' and n.operation == 'GREATER_THAN' and n.outputs[0].is_linked and \
                any(l.to_node.type == 'MIX_SHADER' for l in n.outputs[0].links):
            return float(n.inputs[1].default_value)
    return None


def export_material(src, proxy=None):
    """A plain glTF PBR copy of a SeedThree material (or a flat proxy colour)."""
    name = src.name if proxy is None else ('proxy leaf' if proxy == PROXY_LEAF else 'proxy bark')
    m = bpy.data.materials.new('GLB ' + name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    bsdf.inputs['Metallic'].default_value = 0.0
    m.use_backface_culling = False
    if proxy is not None:
        bsdf.inputs['Base Color'].default_value = _hex_lin(proxy)
        bsdf.inputs['Roughness'].default_value = 1.0
        return m
    im = _images(src)
    alb = None
    if im['albedo'] is not None:
        alb = nt.nodes.new('ShaderNodeTexImage')
        alb.image = im['albedo']
        f = _factor(src)
        if f is not None and any(abs(c - 1.0) > 1e-6 for c in f[:3]):
            mix = nt.nodes.new('ShaderNodeMix')
            mix.data_type = 'RGBA'
            mix.blend_type = 'MULTIPLY'
            mix.inputs[0].default_value = 1.0
            nt.links.new(alb.outputs['Color'], mix.inputs[6])
            mix.inputs[7].default_value = f
            nt.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
        else:
            nt.links.new(alb.outputs['Color'], bsdf.inputs['Base Color'])
    else:
        p = next((n for n in src.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if src.use_nodes else None
        if p is not None:
            bsdf.inputs['Base Color'].default_value = p.inputs['Base Color'].default_value
    if im['rough'] is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = im['rough']
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(t.outputs['Color'], sep.inputs[0])
        nt.links.new(sep.outputs[1], bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = 1.0
    if im['normal'] is not None:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = im['normal']
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    cut = _cutoff(src)
    if cut is not None and alb is not None:
        lt = nt.nodes.new('ShaderNodeMath')
        lt.operation = 'LESS_THAN'
        nt.links.new(alb.outputs['Alpha'], lt.inputs[0])
        lt.inputs[1].default_value = cut
        inv = nt.nodes.new('ShaderNodeMath')
        inv.operation = 'SUBTRACT'
        inv.inputs[0].default_value = 1.0
        nt.links.new(lt.outputs[0], inv.inputs[1])
        nt.links.new(inv.outputs[0], bsdf.inputs['Alpha'])
    return m


def _png_bytes(img):
    if img is None:
        return None
    if img.packed_file is not None:
        return bytes(img.packed_file.data)
    p = bpy.path.abspath(img.filepath)
    if p and os.path.isfile(p):
        with open(p, 'rb') as fh:
            return fh.read()
    return None


# ---- the export -------------------------------------------------------------------

def export_glb(tree, path, materials='full', billboard_dist=None, level=None):
    """Write the plant as a .glb. tree: a create_tree result (grow with level='ALL' and
    billboard=True for the app's full LOD set). level: export that one level only (the JS
    headless exportGLB(levelObject) use: no MSFT_lod, still the <Species>_<level> node; also
    'LOD3' / 'LOD4' of a mobile tree, or 'BB'). Returns {'path', 'bytes', 'nodes', 'lod'}."""
    if level is not None:
        if not tree['objects'].get(level):
            raise ValueError('[seedthree] export_glb: the plant has no %s level built' % level)
        one = dict(tree)
        one['objects'] = {level: tree['objects'][level]}
        one['tree'] = dict(tree['tree'], levels=[dict(lv, appOnly=False) for lv in tree['tree']['levels']
                                                 if lv['name'] == level])
        if level != 'BB':
            one.pop('billboard', None)
        else:
            one['tree']['levels'] = []
        tree = one
    root = tree['object']
    shaped = tree['shaped']
    tdata = tree['tree']
    seed = root.get('seedthree_seed', 1)
    slug = shaped['name'].replace(' ', '_')
    sink = tdata['plantSink']
    proxy = materials == 'proxy'
    scene = bpy.context.scene
    col = bpy.data.collections.new('SeedThree GLB export')
    scene.collection.children.link(col)
    made_objs, made_meshes, made_mats = [], [], []
    mat_map = {}

    def emat(src, role):
        if proxy:
            # the JS: instanced parts by name (leaf|card|frond|rosette|spine|cluster -> leaf green,
            # else bark brown: fruit exports brown); plain meshes by name (bark -> brown; the fix)
            colr = PROXY_BARK if role in ('bark', 'fruit') else PROXY_LEAF
            key = ('proxy', colr)
            if key not in mat_map:
                mat_map[key] = export_material(None if src is None else src, proxy=colr)
                made_mats.append(mat_map[key])
            return mat_map[key]
        if src is None:
            return None
        if src.name not in mat_map:
            mat_map[src.name] = export_material(src)
            made_mats.append(mat_map[src.name])
        return mat_map[src.name]

    def empty(name, parent=None, loc=(0, 0, 0)):
        e = bpy.data.objects.new(name, None)
        col.objects.link(e)
        e.parent = parent
        e.location = loc
        made_objs.append(e)
        return e

    def mesh_ob(name, me, parent, loc=(0, 0, 0)):
        o = bpy.data.objects.new(name, me)
        col.objects.link(o)
        o.parent = parent
        o.location = loc
        made_objs.append(o)
        return o

    exp_root = empty('%s (seed %s)' % (shaped['name'], seed), None, (0.0, 0.0, -sink))
    levels_live = []
    try:
        for lv in tdata['levels']:
            if lv.get('appOnly'):
                continue
            objs = tree['objects'].get(lv['name'])
            if not objs:
                continue
            lg = empty('%s_%s' % (slug, lv['name']), exp_root)
            levels_live.append((lv['name'], lv['distance'], lv.get('hiddenInApp')))
            plain = [o for o in objs if role_of(o) in PLAIN]
            inst = [o for o in objs if role_of(o) not in PLAIN]
            for i, o in enumerate(plain):
                me = o.data.copy()
                me.name = '%s_branches%s' % (lg.name, ('_%d' % i) if len(plain) > 2 else '')
                made_meshes.append(me)
                for si, sm in enumerate(o.data.materials):   # replaced in place: clear() resets face indices
                    me.materials[si] = emat(sm, role_of(o))
                mesh_ob(me.name, me, lg)
            if inst:
                parts = []
                for o in inst:
                    role = role_of(o)
                    part = lv['parts'].get('fruit') if role == 'fruit' else lv['parts'].get('foliage')
                    groups = [] if role == 'fruit' else _groups_for(part)
                    me = _bent_mesh(o.data, groups, 0.0 if role == 'fruit' else 0.85, '%s_leaves_part' % lg.name)
                    made_meshes.append(me)
                    for si, sm in enumerate(o.data.materials):
                        me.materials[si] = emat(sm, role)
                    parts.append(mesh_ob(me.name, me, lg))
                if len(parts) > 1:
                    for o in parts[1:]:
                        made_objs.remove(o)    # join deletes them
                    with bpy.context.temp_override(active_object=parts[0], selected_editable_objects=parts,
                                                   object=parts[0]):
                        bpy.ops.object.join()
                leaves = parts[0]
                leaves.name = leaves.data.name = '%s_leaves' % lg.name
        bbinfo = tree.get('billboard')
        if bbinfo:
            grp = bbinfo['object']
            bd = billboard_dist if billboard_dist is not None else float((tree.get('lod') or {}).get('billboardDist') or 120)
            lg = empty(grp['seedthree_export_name'], exp_root)
            levels_live.append(('BB', bd, False))
            for card in bbinfo['cards']:
                me = card.data.copy()
                made_meshes.append(me)
                for si, sm in enumerate(card.data.materials):
                    me.materials[si] = emat(sm, 'foliage')
                mesh_ob(card['seedthree_export_name'], me, lg, tuple(card.location))
        bpy.context.view_layer.update()
        for o in bpy.context.view_layer.objects:
            if o is not None:
                o.select_set(False)
        for o in made_objs:
            if o.name in bpy.context.view_layer.objects:
                o.select_set(True)
        tmp = path + '.tmp.glb'
        bpy.ops.export_scene.gltf(filepath=tmp, export_format='GLB', use_selection=True, export_yup=True,
                                  export_apply=False, export_animations=False, export_cameras=False,
                                  export_lights=False, export_extras=False, export_materials='EXPORT',
                                  export_image_format='AUTO', export_attributes=False)
        doc, binary = G.read_glb(tmp)
        os.remove(tmp)
        lod_count = 0
        if not proxy:
            # coverages from the live LOD order (the app sorts its levels by distance; the mobile
            # ladder parks the hidden mesh levels at 1e7)
            mobile = bool(root.get('seedthree_mobile'))
            dists = []
            for name, d, hidden in levels_live:
                dists.append(1e7 if (mobile and hidden) else d)
            for lv in tdata['levels']:
                if lv.get('appOnly'):
                    dists.append(lv['distance'])
            dists.sort()
            height = tree['stats']['summary'].get('heightMeters') or 0
            n = len(levels_live)
            cov = G.screen_coverage(height, dists[1:n]) if len(dists) >= n else None
            lod_count = G.add_msft_lod(doc, {slug: cov} if cov else None)
            by_mat = {}
            for src_name, em in mat_map.items():
                src = bpy.data.materials.get(src_name)
                if src is None or not (src.get('st_gltf_dt') or src.get('st_card')):
                    continue
                by_mat[em.name] = {'factor': 1.0, 'color': list(src.get('st_transmit') or (0.42, 0.62, 0.24)),
                                   'png': _png_bytes(_images(src)['trans']),
                                   'texName': '%s translucency' % src_name}
            _dt_done, binary = G.add_diffuse_transmission(doc, binary, by_mat)
        size = G.write_glb(path, doc, binary)
        return {'path': path, 'bytes': size, 'nodes': [n.get('name') for n in doc.get('nodes', [])], 'lod': lod_count,
                'doc': doc}
    finally:
        for o in made_objs:
            if o.name in bpy.data.objects:
                bpy.data.objects.remove(o, do_unlink=True)
        for me in made_meshes:
            if me.name in bpy.data.meshes and me.users == 0:
                bpy.data.meshes.remove(me)
        for m in made_mats:
            if m.name in bpy.data.materials:
                bpy.data.materials.remove(m)
        bpy.data.collections.remove(col)
