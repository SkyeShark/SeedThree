"""SeedThree for Blender: the headless API, mirroring src/api/seedthree.js.

Pure Python (no bpy) for everything except create_tree / duplicate_tree /
set_wind / set_sun / light_probe, which live in seedthree.bl and are re-exported
here lazily:

    from seedthree import api
    print(api.describe())                      # species menu
    print(api.describe('whiteOak', 'shape'))   # one folder of dials
    out = api.generate(species='whiteOak', seed=1737)
    out['stats']['summary']                    # heights, widths, LOD0 triangles
    api.to_preset(species='whiteOak', seed=1737, controls={...})   # app JSON

Fixes over the JS API (reported upstream): the three spray shrubs are described
and schematized as the dichotomous species they are (a); the material folder is
applied by the Blender materials (b); orchard fruit is grown (c).
"""

import json
import os

from .species import SPECIES, DEFAULT_SPECIES
from .core.controls import ADVANCED_LEVEL_PARAMS, CROWN_SHAPES, apply_species_controls, controls_from_species
from .core.jsutil import nz
from .core.rng import tree_rng
from .core.tree import MESHQ_DEFAULT, build_tree, foliage_tris, _tris
from .core.weber_penn import generate_skeleton
from .core.dichotomous import generate_dichotomous
from .core.yucca_leaves import cone_geo
from .core.fruit import glb_bounds, prepared_bounds

PRESET_FORMAT = 'seedthree-preset/1'
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.environ.get('SEEDTHREE_ASSETS') or os.path.normpath(os.path.join(PACKAGE_DIR, '..', '..', 'assets'))


def _species_or_throw(key):
    sp = SPECIES.get(key)
    if not sp:
        raise KeyError('[seedthree] unknown species "%s". Known: %s' % (key, ', '.join(SPECIES)))
    return sp


def _is_dichotomous(sp):
    return sp.get('foliageType') in ('rosette', 'sprayClusters')


def list_species():
    return [{
        'key': k, 'name': sp['name'], 'latin': sp.get('latin'), 'biome': sp.get('biome'),
        'foliageType': sp.get('foliageType') or 'leaves', 'cactus': bool(sp.get('cactus')),
        'generator': 'dichotomous-lsystem' if _is_dichotomous(sp) else 'weber-penn',
    } for k, sp in SPECIES.items()]


def _knob(entry, sp, group):
    k = {'key': entry['key'], 'name': entry['name'], 'group': group, 'default': entry['get'](sp)}
    if entry.get('dropdown') is not None:
        k['options'] = entry['dropdown']
    else:
        k.update({'min': entry['min'], 'max': entry['max'], 'step': entry['step']})
    return k


def _global_knobs(sp):
    rosette = sp.get('foliageType') == 'rosette'
    cactus = bool(sp.get('cactus'))
    fol = sp.get('foliage') or {}
    out = [
        {'key': 'seed', 'name': 'Seed', 'group': 'global', 'min': 1, 'max': 9999, 'step': 1, 'default': 1},
        {'key': 'showLeaves', 'name': 'Show leaves', 'group': 'global', 'type': 'bool', 'default': True},
        {'key': 'tileWorldSize', 'name': 'Bark tiling (m)', 'group': 'global', 'min': 0.6, 'max': 3.0, 'step': 0.05,
         'default': nz(sp.get('tileWorldSize'), 1.5)},
        {'key': 'barkTint', 'name': 'Bark tint', 'group': 'material', 'type': 'color', 'default': 0xffffff},
        {'key': 'barkFlat', 'name': 'Bark flat shading', 'group': 'material', 'type': 'bool', 'default': False},
    ]
    if not rosette:
        out += [
            {'key': 'leafColorize', 'name': 'Leaf tint', 'group': 'material', 'type': 'color', 'default': 0xffffff},
            {'key': 'leafTintAmount', 'name': 'Leaf tint amount', 'group': 'material', 'min': 0, 'max': 1, 'step': 0.01, 'default': 0},
            {'key': 'leafAngle', 'name': 'Leaf angle', 'group': 'material', 'min': 0, 'max': 100, 'step': 1, 'default': nz(fol.get('downAngle'), 52)},
            {'key': 'leafStart', 'name': 'Leaf start', 'group': 'material', 'min': 0, 'max': 1, 'step': 0.01, 'default': nz(fol.get('startFrac'), 0.1)},
            {'key': 'leafSizeVar', 'name': 'Leaf size variance', 'group': 'material', 'min': 0, 'max': 1, 'step': 0.01, 'default': nz(fol.get('sizeVar'), 0.3)},
            {'key': 'leafAlpha', 'name': 'Leaf alpha test', 'group': 'material', 'min': 0, 'max': 1, 'step': 0.01, 'default': nz(fol.get('alphaTest'), 0.4)},
            {'key': 'leafQuads', 'name': 'Leaf billboard', 'group': 'material', 'options': {'Single': 1, 'Crossed (double)': 2}, 'default': nz(fol.get('quads'), 2)},
        ]
    if rosette and not cactus:
        out += [
            {'key': 'frondGreenTint', 'name': 'Frond green tint', 'group': 'material', 'type': 'color', 'default': 0xffffff},
            {'key': 'frondDryTint', 'name': 'Frond dry tint', 'group': 'material', 'type': 'color', 'default': 0xffffff},
            {'key': 'frondDryestTint', 'name': 'Frond dryest tint', 'group': 'material', 'type': 'color', 'default': 0xffffff},
            {'key': 'frondDryness', 'name': 'Frond dryness', 'group': 'material', 'min': 0, 'max': 1, 'step': 0.01, 'default': 0},
        ]
    if cactus:
        out += [
            {'key': 'spineTint', 'name': 'Spine tint', 'group': 'material', 'type': 'color', 'default': 0xffffff},
            {'key': 'barkDamage', 'name': 'Bark damage', 'group': 'material', 'min': 0, 'max': 1, 'step': 0.01, 'default': nz(sp.get('barkDamage'), 0.35)},
        ]
    return out


LOD_OPTIONS = [
    {'key': 'meshQuality', 'name': 'Branch/trunk quality', 'min': 0.3, 'max': 1, 'step': 0.05, 'default': 0.8},
    {'key': 'lod0Density', 'name': 'LOD0 rosette density', 'min': 0.2, 'max': 1, 'step': 0.05, 'default': 1},
    {'key': 'lod1Dist', 'name': 'LOD1 at (m)', 'min': 5, 'max': 80, 'step': 1, 'default': 35},
    {'key': 'lod2Dist', 'name': 'LOD2 at (m)', 'min': 15, 'max': 150, 'step': 1, 'default': 70},
    {'key': 'billboardDist', 'name': 'Billboard at (m)', 'min': 30, 'max': 300, 'step': 1, 'default': 120},
    {'key': 'lod1Pct', 'name': 'LOD1 budget (%)', 'min': 15, 'max': 85, 'step': 5, 'default': 50, 'temperateOnly': True},
    {'key': 'lod2Pct', 'name': 'LOD2 budget (%)', 'min': 4, 'max': 40, 'step': 1, 'default': 15, 'temperateOnly': True},
    {'key': 'lod1Density', 'name': 'LOD1 density', 'min': 0.2, 'max': 1, 'step': 0.05, 'default': 1},
    {'key': 'lod2Density', 'name': 'LOD2 density', 'min': 0.2, 'max': 1, 'step': 0.05, 'default': 1},
    {'key': 'lod1Prune', 'name': 'LOD1 prune', 'min': 0, 'max': 0.85, 'step': 0.05, 'default': 0, 'temperateOnly': True},
    {'key': 'lod2Prune', 'name': 'LOD2 prune', 'min': 0, 'max': 0.85, 'step': 0.05, 'default': 0.35, 'temperateOnly': True},
    {'key': 'mobileTarget', 'name': 'Mobile performance target', 'type': 'bool', 'default': False},
]
# The app's bake settings (main.js optState), read by create_tree / the bakes.
BAKE_OPTIONS = [
    {'key': 'cardRes', 'name': 'Card resolution', 'options': {'256': 256, '512': 512, '1024': 1024}, 'default': 512},
    {'key': 'cardVariants', 'name': 'Card variants', 'min': 1, 'max': 4, 'step': 1, 'default': 3},
    {'key': 'billboardRes', 'name': 'Billboard resolution', 'options': {'512': 512, '1024': 1024, '2048': 2048}, 'default': 1024},
]


def get_schema(species_key):
    sp = _species_or_throw(species_key)
    dich = _is_dichotomous(sp)
    shape = [_knob(e, sp, 'shape') for e in sp.get('controls') or []]
    if dich:
        advanced = [_knob(e, sp, 'advanced') for e in sp.get('advancedControls') or []]
    else:
        levels = nz(sp['params'].get('levels'), 3)
        advanced = []
        for m in ADVANCED_LEVEL_PARAMS:
            lo = 0 if m['trunk'] else 1
            for lvl in range(lo, levels):
                arr = sp['params'].get(m['key'])
                v = arr[lvl] if isinstance(arr, list) and lvl < len(arr) else None
                advanced.append({'path': 'paramOverrides.%s.%d' % (m['key'], lvl), 'name': '%s · L%d' % (m['name'], lvl),
                                 'group': 'advanced', 'min': m['min'], 'max': m['max'], 'step': m['step'],
                                 'default': m['dflt'] if v is None else v})
        fd = sp['params'].get('forceDir') or {}
        advanced += [
            {'key': 'forceDirX', 'name': 'Force dir X', 'group': 'advanced', 'min': -1, 'max': 1, 'step': 0.01, 'default': nz(fd.get('x'), 0)},
            {'key': 'forceDirY', 'name': 'Force dir Y', 'group': 'advanced', 'min': -1, 'max': 1, 'step': 0.01, 'default': nz(fd.get('y'), 1)},
            {'key': 'forceDirZ', 'name': 'Force dir Z', 'group': 'advanced', 'min': -1, 'max': 1, 'step': 0.01, 'default': nz(fd.get('z'), 0)},
            {'key': 'forceStrength', 'name': 'Force strength', 'group': 'advanced', 'min': 0, 'max': 0.12, 'step': 0.001, 'default': nz(sp['params'].get('forceStrength'), 0)},
        ]
    return {
        'species': species_key, 'name': sp['name'], 'latin': sp.get('latin'), 'biome': sp.get('biome'),
        'foliageType': sp.get('foliageType') or 'leaves', 'cactus': bool(sp.get('cactus')),
        'generator': 'dichotomous-lsystem' if dich else 'weber-penn',
        'shape': shape, 'advanced': advanced, 'global': _global_knobs(sp),
        'lod': [o for o in LOD_OPTIONS if not o.get('temperateOnly') or not dich],
    }


def default_controls(species_key):
    return controls_from_species(_species_or_throw(species_key))


def _fmt_knob(k):
    ident = k.get('key') or k.get('path')
    if k.get('options') is not None:
        opts = ', '.join('%s:%s' % (n, v) for n, v in k['options'].items())
        return '  %s — %s; one of {%s} (default %s)' % (ident, k['name'], opts, k['default'])
    if k.get('type') == 'bool':
        return '  %s — %s; True|False (default %s)' % (ident, k['name'], k['default'])
    if k.get('type') == 'color':
        return '  %s — %s; hex color (default 0x%x)' % (ident, k['name'], k['default'] if k['default'] is not None else 0xffffff)
    return '  %s — %s; %s..%s step %s (default %s)' % (ident, k['name'], k['min'], k['max'], k['step'], k['default'])


def describe(species_key=None, folder=None, call='generate'):
    """Text menu: no args -> species list; a species -> quick start + folder index;
    (species, folder) -> one folder of dials ('shape' | 'advanced' | 'global' |
    'material' | 'lod')."""
    if not species_key:
        rows = ['  %-16s %s%s — %s, %s' % (s['key'], s['name'], ' (%s)' % s['latin'] if s['latin'] else '',
                                              s['biome'], s['generator']) for s in list_species()]
        return '\n'.join([
            'SeedThree species — pick one, then design by SEED first:', *rows, '',
            "Quick start:  %s(species='whiteOak', seed=1..9999)" % call,
            'Every seed is a different individual of the species — iterating the seed is',
            'often enough. A tree designed for a shot sets its dials too, behind folders:',
            "  describe('<species>')            → that species' quick-start + folder index",
            "  describe('<species>', '<folder>') → open one folder's dials",
        ])
    schema = get_schema(species_key)
    folders = {
        'shape': schema['shape'], 'advanced': schema['advanced'],
        'global': [k for k in schema['global'] if k['group'] == 'global'],
        'material': [k for k in schema['global'] if k['group'] == 'material'],
        'lod': schema['lod'],
    }
    if folder:
        knobs = folders.get(folder)
        if knobs is None:
            return 'Unknown folder "%s". Folders: %s' % (folder, ', '.join(folders))
        hint = ''
        if folder == 'advanced' and schema['generator'] == 'weber-penn':
            hint = ('\nPer-level dials are paths: controls[\'paramOverrides\'][<param>][<level>], e.g.\n'
                    "  %s(species, seed=..., dials={'paramOverrides': {'downAngle': {1: 50}}})" % call)
        elif folder == 'lod':
            hint = "\nPass these as the `lod` argument, not inside the dials."
        return '\n'.join(['%s — %s (%d dials):' % (schema['name'], folder, len(knobs))] + [_fmt_knob(k) for k in knobs]) + hint
    counts = ' · '.join('%s (%d)' % (n, len(a)) for n, a in folders.items())
    return '\n'.join([
        '%s%s — %s, %s.' % (schema['name'], ' (%s)' % schema['latin'] if schema['latin'] else '', schema['biome'], schema['generator']),
        '',
        "Quick start:  %s(species='%s', seed=1..9999)" % (call, species_key),
        'The SEED picks the individual. Read the returned stats (tris, height, width),',
        'then design it for the shot with the shape folder before reaching further.',
        '',
        "Closed folders — open with describe('%s', '<folder>'):" % species_key,
        '  ' + counts,
    ])


def merge_controls(species_key, controls=None, seed=None):
    controls = controls or {}
    base = controls_from_species(_species_or_throw(species_key))
    merged = dict(base)
    merged.update(controls)
    merged['paramOverrides'] = dict(base.get('paramOverrides') or {})
    for k, per in (controls.get('paramOverrides') or {}).items():
        d = dict((base.get('paramOverrides') or {}).get(k) or {})
        d.update(per or {})
        merged['paramOverrides'][k] = d
    if seed is not None:
        merged['seed'] = seed
    return merged


def shaped_species(species_key, controls=None, seed=None):
    sp = _species_or_throw(species_key)
    merged = merge_controls(species_key, controls, seed)
    return apply_species_controls(sp, merged), merged


def fruit_assets(shaped, assets_dir=None):
    fr = shaped.get('fruit')
    if not fr or not fr.get('mesh'):
        return {}
    path = os.path.join(assets_dir or ASSETS_DIR, 'fruits', fr['mesh'])
    if not os.path.isfile(path):
        return {}
    bmin, bmax = glb_bounds(path)
    (pmin, pmax), offset = prepared_bounds(bmin, bmax)
    return {'fruitBounds': (pmin, pmax), 'fruitOffset': offset, 'fruitPath': path,
            'fruitTris': _glb_tris(path)}


def _glb_tris(path):
    import struct
    with open(path, 'rb') as fh:
        data = fh.read()
    jlen = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + jlen])
    node = next(n for n in doc['nodes'] if 'mesh' in n)
    prim = doc['meshes'][node['mesh']]['primitives'][0]
    if 'indices' in prim:
        return doc['accessors'][prim['indices']]['count'] // 3
    return doc['accessors'][prim['attributes']['POSITION']]['count'] // 3


def generate(species=DEFAULT_SPECIES, seed=1, controls=None, lod=None, fruit=True, assets_dir=None):
    """Grow a plant as plain data (no bpy): {'tree', 'stats', 'preset', 'shaped'}.
    fruit=False reproduces the JS headless API exactly (it never loads fruit)."""
    shaped, merged = shaped_species(species, controls, seed)
    assets = fruit_assets(shaped, assets_dir) if fruit else {}
    tree = build_tree(shaped, seed, lod or {}, assets)
    tree['assets'] = assets
    return {'tree': tree, 'stats': stats_of(tree, assets), 'preset': to_preset(species, seed, merged), 'shaped': shaped}


# ---- stats (same counting rules as the JS statsOf) ----------------------------

def _corners(bmin, bmax):
    import itertools
    return [(x, y, z) for x, y, z in itertools.product((bmin[0], bmax[0]), (bmin[1], bmax[1]), (bmin[2], bmax[2]))]


def _instanced_box(local_min, local_max, matrices):
    """InstancedMesh.computeBoundingBox: each instance's transformed local AABB."""
    import numpy as np
    if len(matrices) == 0:
        return None
    C = np.array(_corners(local_min, local_max) if local_min is not None else [], np.float64)
    M = np.asarray(matrices, np.float64).reshape(-1, 4, 4).transpose(0, 2, 1)  # row-major
    pts = np.einsum('nij,kj->nki', M[:, :3, :3], C) + M[:, None, :3, 3]
    pts = pts.reshape(-1, 3)
    return pts.min(axis=0), pts.max(axis=0)


def _part_meshes(part):
    """[(triangles_per_instance, instances or None, verts, local_box, matrices|None, exact_positions|None)]"""
    import numpy as np
    out = []
    if part is None:
        return out
    kind = part.get('kind')
    if kind == 'cardsGroup':
        for m in part['members']:
            out += _part_meshes(m)
    elif kind == 'cardSet':
        for m in part['meshes']:
            g = m['geometry']
            P = np.asarray(g['position'], np.float64)
            out.append((len(g['index']) // 3, m['count'], len(P), (P.min(0), P.max(0)), m['matrices'], None))
    elif kind == 'cards':
        t = part['template']
        P = t['position'].astype(np.float64)
        out.append((len(t['index']) // 3, part['count'], len(P), (P.min(0), P.max(0)), part['matrices'], None))
    elif kind == 'cones':
        for ci, lst in enumerate(part['slots']):
            if not lst:
                continue
            g = cone_geo(ci, part['coneRadialSegs'])
            P = g['position'].astype(np.float64)
            out.append((len(g['index']) // 3, len(lst), len(P), (P.min(0), P.max(0)),
                        np.array([s['matrix'] for s in lst]), None))
    elif kind == 'fruit':
        b = part.get('bounds')
        out.append((part.get('trisPer', 0), len(part['instances']), part.get('vertsPer', 0), b,
                    np.array([s['matrix'] for s in part['instances']]), None))
    else:
        P = part['position'].astype(np.float64)
        out.append((len(part['index']) // 3, None, len(P), None, None, P))
    return out


def stats_of(tree, assets=None):
    import numpy as np
    assets = assets or {}
    per_lod = []
    box = None
    for li, lv in enumerate(tree['levels']):
        tris = verts = meshes = instances = 0
        bmins, bmaxs = [], []
        for key in ('bark', 'spines', 'foliage', 'fruit'):
            part = lv['parts'].get(key)
            if part is not None and key == 'fruit':
                part = dict(part, bounds=assets.get('fruitBounds'), trisPer=assets.get('fruitTris', 0))
            for tpi, inst, nv, lbox, mats, exact in _part_meshes(part):
                meshes += 1
                tris += tpi * (inst if inst is not None else 1)
                instances += inst or 0
                verts += nv
                if li == 0:
                    if exact is not None and len(exact):
                        bmins.append(exact.min(0))
                        bmaxs.append(exact.max(0))
                    elif mats is not None and lbox is not None and len(mats):
                        r = _instanced_box(lbox[0], lbox[1], mats)
                        if r:
                            bmins.append(r[0])
                            bmaxs.append(r[1])
        per_lod.append({'name': lv['name'], 'distance': lv['distance'], 'meshes': meshes, 'instances': instances,
                        'triangles': int(round(tris)), 'verts': verts,
                        'appOnly': bool(lv.get('appOnly')), 'hiddenInApp': bool(lv.get('hiddenInApp'))})
        if li == 0 and bmins:
            box = (np.min(bmins, axis=0), np.max(bmaxs, axis=0))
    summary = {'lodCount': len(per_lod)}
    bbox = None
    if box is not None:
        s = box[1] - box[0]
        summary.update({'widthMeters': round(float(max(s[0], s[2])), 3), 'heightMeters': round(float(s[1]), 3),
                        'depthMeters': round(float(min(s[0], s[2])), 3)})
        bbox = {'min': [float(v) for v in box[0]], 'max': [float(v) for v in box[1]]}
    summary['lod0Triangles'] = per_lod[0]['triangles'] if per_lod else 0
    return {'summary': summary, 'perLod': per_lod, 'boundingBox': bbox}


def skeleton(species=DEFAULT_SPECIES, seed=1, controls=None):
    """Stem/tip counts for a design, no meshing (same RNG convention as the build)."""
    sp = _species_or_throw(species)
    shaped, _ = shaped_species(species, controls, seed)
    if _is_dichotomous(sp):
        fol = shaped.get('foliage') or {}
        leaf_len = fol.get('leafLen') if fol.get('leafLen') is not None else fol.get('clusterSize')
        sk = generate_dichotomous(dict(shaped['params'], tipClearance=nz(leaf_len, 0.5) * 0.9), tree_rng(sp['name'], seed))
        return {'generator': 'dichotomous-lsystem', 'stems': len(sk['stems']), 'terminals': len(sk['terminalStems'])}
    sk = generate_skeleton(shaped['params'], tree_rng(sp['name'], seed))
    by_level = {}
    for s in sk['stems']:
        by_level[s['level']] = by_level.get(s['level'], 0) + 1
    return {'generator': 'weber-penn', 'stems': len(sk['stems']), 'tips': len(sk['tips']), 'stemsByLevel': by_level}


# ---- presets (app-compatible seedthree-preset/1) ------------------------------

def to_preset(species=DEFAULT_SPECIES, seed=1, controls=None):
    merged = merge_controls(species, controls, seed)
    return {'format': PRESET_FORMAT, 'species': species, 'controls': merged}


def from_preset(preset):
    if isinstance(preset, str):
        preset = json.loads(preset)
    key = (preset or {}).get('species')
    if key not in SPECIES:
        raise KeyError('[seedthree] preset has unknown species "%s"' % key)
    controls = controls_from_species(SPECIES[key])
    controls.update(preset.get('controls') or {})
    return {'species': key, 'seed': nz(controls.get('seed'), 1), 'controls': controls}


def _json_clean(v):
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        return int(v)
    if isinstance(v, dict):
        return {str(k): _json_clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_json_clean(x) for x in v]
    return v


def preset_json(preset):
    """The JSON text the app's Save preset writes (2-space indent)."""
    return json.dumps(_json_clean(preset), indent=2, ensure_ascii=False)


def save_preset(path, species=DEFAULT_SPECIES, seed=1, controls=None):
    """Write the app's JSON to `path`; a folder gets the app's file name,
    <Name>_seed<N>.seedthree.json. Returns the file written."""
    if os.path.isdir(path):
        path = os.path.join(path, preset_file_name(species, seed))
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(preset_json(to_preset(species, seed, controls)))
    return path


def load_preset(path):
    with open(path, 'r', encoding='utf-8') as fh:
        return from_preset(json.load(fh))


def preset_file_name(species, seed):
    sp = _species_or_throw(species)
    return '%s_seed%s.seedthree.json' % (sp['name'].replace(' ', '_'), seed)


# ---- Blender tier (needs bpy) ----------------------------------------------------

def create_tree(*args, **kwargs):
    from .bl.build import create_tree as _ct
    return _ct(*args, **kwargs)


def duplicate_tree(*args, **kwargs):
    from .bl.build import duplicate_tree as _dt
    return _dt(*args, **kwargs)


def tree_from_root(root):
    """create_tree's result dict for a plant grown earlier, from its root Empty (bl/build.py)."""
    from .bl.build import tree_from_root as _tr
    return _tr(root)


def remove_tree(tree):
    """Delete a grown plant (the dict or its root Empty) with everything under it."""
    from .bl.build import remove_tree as _rm
    return _rm(tree['object'] if isinstance(tree, dict) else tree)


def set_wind(strength=None, speed=None):
    from .bl.wind import set_wind as _sw
    return _sw(strength=strength, speed=speed)


def set_backlight(mode):
    """How the leaf / frond / spine / card backlight reaches EEVEE, for plants grown from now on:
    'translucent' (the default: a Translucent BSDF, the JS term x the leaf's Lambert factor; every
    lamp reaches it physically) or 'glow' (opt-in: the JS term itself, k x tcol x sun x shadow,
    orientation-free: the crown glows backlit to its silhouette and front-lit leaves carry the
    ambient scatter, as in the app; read from the bound sun through Shader to RGB with the world
    light cancelled, bl/sun.py; a heavy shader: check the first render, see bl/materials.py)."""
    from .bl.materials import set_backlight as _sb
    return _sb(mode)


def set_sun(sun):
    """Bind the leaf/frond/spine backlight of every SeedThree plant in the file to a sun lamp."""
    from .bl.sun import set_sun as _ss
    return _ss(sun)


def light_probe(trees, spacing=1.5, margin=0.1, bake=True, name=None, spread=0.5):
    """A baked Light Probe Volume around the plants: occluded sky inside the canopy (see bl/probe.py)."""
    from .bl.probe import light_probe as _lp, NAME
    return _lp(trees, spacing=spacing, margin=margin, name=name or NAME, bake=bake, spread=spread)


def ensure_branch_cards(species=DEFAULT_SPECIES, seed=1, controls=None, lod=None, fruit=True):
    """Bake (or reuse) the card set a design's LOD ladder places (main.js ensureBranchCards)."""
    from .bl.cards import ensure_branch_cards as _eb
    shaped, merged = shaped_species(species, controls, seed)
    return _eb(shaped, merged, lod, fruit_assets(shaped) if fruit else {})


def bake_impostor(tree, size=1024, source_level='LOD0', centered='axis', cast_shadow=True):
    """The far billboard level 'BB' of a grown plant: two crossed baked cards (impostor.js) that
    cast the sun's shadow and receive none (bl/cast_only.py)."""
    from .bl.cards import bake_impostor as _bi
    return _bi(tree, size=size, source_level=source_level, centered=centered, cast_shadow=cast_shadow)


def make_forest_ring(tree, count=64, seed=None, near_level='LOD2', billboard=True, billboard_dist=None,
                     height_at=None, meadow_at=None, collection=None, name=None, wind=True):
    """The app's grove: instanced copies of the plant around it, LOD2 near / billboards far."""
    from .bl.forest import make_forest_ring as _mf
    return _mf(tree, count=count, seed=seed, near_level=near_level, billboard=billboard,
               billboard_dist=billboard_dist, height_at=height_at, meadow_at=meadow_at, collection=collection,
               name=name, wind=wind)


def export_glb(tree, path, materials='full', billboard_dist=None, level=None):
    """Write the plant as a .glb (export-glb.js; materials='proxy' is the headless exportGLB's two
    flat colours; level= one level alone, as exportGLB(levelObject))."""
    from .bl.export import export_glb as _ex
    return _ex(tree, path, materials=materials, billboard_dist=billboard_dist, level=level)


def build_demo_scene(species=DEFAULT_SPECIES, seed=1, **kwargs):
    """The app's scene around one plant: biome terrain and sky, rocks, limbs, grass or scrub,
    clouds, the tree with every level, the forest ring, haze, the soundscape (scene/demo.py)."""
    from .scene.demo import build_demo_scene as _bd
    return _bd(species, seed, **kwargs)


def example(name, **kwargs):
    """One of the app's example scenes: 'reference_turntable' (scripts/reference) or
    'example_scene' (src/api/example-eidoverse-scene.js); see scene/examples.py."""
    from .scene.examples import EXAMPLES
    return EXAMPLES[name](**kwargs)


def preview_level(tree, which='AUTO', camera=None, **distances):
    """The app's Preview level: 'AUTO' (by camera distance) or force 'LOD0' / 'LOD1' / 'LOD2' /
    'BB' (the n-th visible level, as the app's dropdown)."""
    from .bl.lod import preview as _pv
    return _pv(tree, which, camera, **distances)


def auto_lod(tree, camera=None, **distances):
    """Show each built level in its camera-distance band (THREE.LOD as drivers)."""
    from .bl.lod import auto_lod as _al
    return _al(tree, camera, **distances)


def frame_camera_to_tree(tree, camera=None, elevation_deg=18.0):
    """main.js frameCameraToTree: fit the camera, derive the species-scaled LOD distances."""
    from .bl.lod import frame_camera_to_tree as _fc
    return _fc(tree, camera, elevation_deg=elevation_deg)
