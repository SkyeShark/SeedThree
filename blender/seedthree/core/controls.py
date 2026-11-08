"""The dial vocabulary, ported from src/ui/controls.js: crown shapes, the
per-level Advanced dials, controlsFromSpecies and applySpeciesControls.

Keys stay camelCase on purpose: preset JSON round-trips with the web app.
"""

import copy

from .jsutil import nz

CROWN_SHAPES = {
    'Conical': 0, 'Spherical': 1, 'Hemispherical': 2, 'Cylindrical': 3,
    'Tapered cyl.': 4, 'Flame': 5, 'Inverse conical': 6, 'Tend flame': 7,
}

ADVANCED_LEVEL_PARAMS = [
    {'key': 'downAngle', 'name': 'Down angle', 'min': 0, 'max': 135, 'step': 1, 'trunk': False, 'dflt': 0},
    {'key': 'branches', 'name': 'Children', 'min': 0, 'max': 60, 'step': 1, 'trunk': False, 'dflt': 0},
    {'key': 'curveV', 'name': 'Gnarliness', 'min': 0, 'max': 120, 'step': 1, 'trunk': True, 'dflt': 40},
    {'key': 'curve', 'name': 'Curve', 'min': -90, 'max': 90, 'step': 1, 'trunk': True, 'dflt': 0},
    {'key': 'length', 'name': 'Length ×', 'min': 0.02, 'max': 1.5, 'step': 0.01, 'trunk': False, 'dflt': 0.4},
    {'key': 'taper', 'name': 'Taper', 'min': 0, 'max': 1, 'step': 0.01, 'trunk': True, 'dflt': 1},
    {'key': 'twist', 'name': 'Twist', 'min': -0.5, 'max': 0.5, 'step': 0.01, 'trunk': True, 'dflt': 0},
    {'key': 'curveRes', 'name': 'Sections', 'min': 2, 'max': 20, 'step': 1, 'trunk': True, 'dflt': 8},
    {'key': 'radialSegments', 'name': 'Segments', 'min': 3, 'max': 16, 'step': 1, 'trunk': True, 'dflt': 6},
]


def _get(d, key, default=None):
    if d is None or d is False:
        return default
    v = d.get(key)
    return default if v is None else v


def controls_from_species(species):
    params = species.get('params') or {}
    fol = species.get('foliage') if species.get('foliage') else {}
    force_dir = params.get('forceDir') or {}
    c = {
        'seed': 1, 'showLeaves': True, 'tileWorldSize': nz(species.get('tileWorldSize'), 1.5),
        'paramOverrides': {},
        'forceDirX': nz(force_dir.get('x'), 0),
        'forceDirY': nz(force_dir.get('y'), 1),
        'forceDirZ': nz(force_dir.get('z'), 0),
        'forceStrength': nz(params.get('forceStrength'), 0),
        'leafColorize': 0xffffff,
        'leafTintAmount': 0,
        'leafAngle': _get(fol, 'downAngle', 52),
        'leafStart': _get(fol, 'startFrac', 0.1),
        'leafSizeVar': _get(fol, 'sizeVar', 0.3),
        'leafAlpha': _get(fol, 'alphaTest', 0.4),
        'leafQuads': _get(fol, 'quads', 2),
        'barkTint': nz(species.get('barkTint'), 0xffffff),
        'barkFlat': False,
        'frondGreenTint': 0xffffff,
        'frondDryTint': 0xffffff,
        'frondDryestTint': 0xffffff,
        'frondDryness': 0,
        'spineTint': 0xffffff,
        'barkDamage': nz(species.get('barkDamage'), 0.35),
    }
    for d in species.get('controls') or []:
        c[d['key']] = d['get'](species)
    for d in species.get('advancedControls') or []:
        c[d['key']] = d['get'](species)
    return c


def _level_items(per_level):
    """Object.entries order for integer-like keys: ascending numeric."""
    items = []
    for k, v in per_level.items():
        try:
            items.append((int(k), v))
        except (TypeError, ValueError):
            continue
    items.sort(key=lambda kv: kv[0])
    return items


def apply_species_controls(species, c):
    """A species-like dict with params/foliage overridden by the controls."""
    s = dict(species)
    s['params'] = copy.deepcopy(species.get('params') or {})
    f = species.get('foliage')
    s['foliage'] = False if f is False else dict(f or {})
    # spines are deep-copied too: the JS setter mutates the shared preset object.
    if species.get('spines') is not None:
        s['spines'] = dict(species['spines'])
    s['tileWorldSize'] = nz(c.get('tileWorldSize'), species.get('tileWorldSize'))
    for d in species.get('controls') or []:
        if d['key'] in c:
            d['set'](s, c[d['key']])
    for d in species.get('advancedControls') or []:
        if d['key'] in c:
            d['set'](s, c[d['key']])
    if c.get('tileWorldSize') is not None:
        s['params']['tileWorldSize'] = c['tileWorldSize']
    po = c.get('paramOverrides')
    if po:
        for key, per_level in po.items():
            if not per_level:
                continue
            cur = s['params'].get(key) if isinstance(s['params'].get(key), list) else []
            meta = next((m for m in ADVANCED_LEVEL_PARAMS if m['key'] == key), None)
            arr = []
            for i in range(4):
                arr.append(cur[i] if i < len(cur) else (meta['dflt'] if meta else 0))
            for lvl, v in _level_items(per_level):
                while len(arr) <= lvl:
                    arr.append(None)
                arr[lvl] = v
            s['params'][key] = arr
    s['params']['forceDir'] = {'x': nz(c.get('forceDirX'), 0), 'y': nz(c.get('forceDirY'), 1),
                               'z': nz(c.get('forceDirZ'), 0)}
    s['params']['forceStrength'] = nz(c.get('forceStrength'),
                                      nz((species.get('params') or {}).get('forceStrength'), 0))
    if s['foliage'] is not False:
        is_curtain = s['foliage'].get('mode') in ('hangingSprays', 'willowCurtains')
        if not is_curtain:
            if 'leafAngle' in c and c['leafAngle'] is not None:
                s['foliage']['downAngle'] = c['leafAngle']
            if 'leafStart' in c and c['leafStart'] is not None:
                s['foliage']['startFrac'] = c['leafStart']
            if 'leafSizeVar' in c and c['leafSizeVar'] is not None:
                s['foliage']['sizeVar'] = c['leafSizeVar']
        else:
            s['foliage']['sizeVar'] = 0
        if 'leafQuads' in c and c['leafQuads'] is not None:
            s['foliage']['quads'] = c['leafQuads']
    if c.get('showLeaves') is False:
        s['foliage'] = False
    return s
