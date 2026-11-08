"""The 20 SeedThree species presets, ported from src/species/*.js.

Values are copied verbatim (camelCase keys, so preset JSON round-trips with the web
app). Each shape dial is {key, name, min, max, step | dropdown, get(s), set(s, v)}
exactly like the JS schema; set() writes into an applySpeciesControls copy.
"""

from .core.controls import CROWN_SHAPES
from .core.vmath import js_round


def _p(key):
    def get(s):
        return s['params'][key]

    def set_(s, v):
        s['params'][key] = v
    return get, set_


def _dial(key, name, mn, mx, step, get, set_, dropdown=None):
    d = {'key': key, 'name': name, 'get': get, 'set': set_}
    if dropdown is not None:
        d['dropdown'] = dropdown
    else:
        d.update({'min': mn, 'max': mx, 'step': step})
    return d


def _set_round(key):
    def set_(s, v):
        s['params'][key] = js_round(v)
    return set_


def _arr_get(key, i, dflt):
    def get(s):
        a = s['params'].get(key)
        v = a[i] if a is not None and i < len(a) else None
        return dflt if v is None else v
    return get


def _arr_set(key, i, rnd=False):
    def set_(s, v):
        s['params'][key][i] = js_round(v) if rnd else v
    return set_


def _mul_set(key):
    def set_(s, v):
        s['params'][key] *= v
    return set_


def _fol_get(key, dflt=None):
    def get(s):
        v = s['foliage'].get(key)
        return dflt if v is None else v
    return get


def _fol_set(key, rnd=False):
    def set_(s, v):
        s['foliage'][key] = js_round(v) if rnd else v
    return set_


def _param_get(key, dflt):
    def get(s):
        v = s['params'].get(key)
        return dflt if v is None else v
    return get


def _set_trunks_from_splits(s, v):
    s['params']['baseSplits'] = js_round(v) - 1


def _get_trunks_from_splits(s):
    return 1 + (s['params'].get('baseSplits') or 0)


def _one(_s):
    return 1


def _broadleaf_controls(height_max=30, levels_max=3):
    return [
        _dial('height', 'Height (m)', 4, height_max, 0.5, *_p('scale')),
        _dial('levels', 'Branch levels', 2, levels_max, 1, _param_get('levels', 3), _set_round('levels')),
        _dial('crownShape', 'Crown shape', None, None, None, _param_get('shape', 2), _set_round('shape'), dropdown=CROWN_SHAPES),
        _dial('branchDensity', 'Branch density', 2, 45, 1, _arr_get('branches', 1, 20), _arr_set('branches', 1, rnd=True)),
        _dial('branchAngle', 'Branch angle', 15, 95, 1, _arr_get('downAngle', 1, 50), _arr_set('downAngle', 1)),
        _dial('gnarliness', 'Gnarliness', 0, 120, 1, _arr_get('curveV', 1, 40), _arr_set('curveV', 1)),
        _dial('trunks', 'Trunks', 1, 4, 1, _get_trunks_from_splits, _set_trunks_from_splits),
        _dial('trunkThickness', 'Trunk thickness', 0.4, 2.2, 0.05, _one, _mul_set('ratio')),
        _dial('leafSize', 'Leaf size', 0.2, 1.5, 0.05, _fol_get('size', 0.6), _fol_set('size')),
        _dial('leavesPerBranch', 'Leaves / branch', 0, 30, 1, _fol_get('leavesPerBranch', 14), _fol_set('leavesPerBranch', rnd=True)),
    ]


BROADLEAF_CONTROLS = _broadleaf_controls()

white_oak = {
    'name': 'White Oak', 'latin': 'Quercus alba',
    'bark': 'white_oak_albedo.png', 'leaf': 'white_oak_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.55,
    'controls': _broadleaf_controls(height_max=26, levels_max=4),
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.3, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'tint': 0xdfe8c8, 'leavesPerBranch': 14, 'size': 0.6, 'downAngle': 52, 'bend': 0,
    },
    'params': {
        'scale': 13, 'scaleV': 2, 'levels': 3, 'ratio': 0.035, 'ratioPower': 1.3,
        'baseSize': 0.18, 'shape': 1, 'flare': 0.8, 'attractionUp': 0.7,
        'baseSplits': 1, 'baseSplitAngle': 18,
        'length': [1.0, 0.5, 0.42, 0.35], 'lengthV': [0.0, 0.12, 0.12, 0.1],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [12, 7, 5, 3],
        'curve': [6, 30, 35, 0], 'curveBack': [0, -20, 0, 0], 'curveV': [16, 80, 80, 70],
        'downAngle': [0, 68, 55, 50], 'downAngleV': [0, 18, 20, 20],
        'rotate': [0, 140, 140, 140], 'rotateV': [0, 30, 30, 30],
        'branches': [0, 26, 14, 0], 'radialSegments': [14, 10, 6, 5],
    },
}

red_maple = {
    'name': 'Red Maple', 'latin': 'Acer rubrum',
    'bark': 'red_maple_albedo.png', 'leaf': 'red_maple_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.3, 'controls': BROADLEAF_CONTROLS,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.2, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'tint': 0xdce4b4, 'leavesPerBranch': 7, 'size': 0.55, 'downAngle': 50, 'bend': 0,
        'trunkClearRadius': 0.85,
    },
    'params': {
        'scale': 15, 'scaleV': 2, 'levels': 3, 'ratio': 0.028, 'ratioPower': 1.3,
        'baseSize': 0.18, 'shape': 1, 'flare': 0.45, 'attractionUp': 0.5,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'length': [1.0, 0.5, 0.16, 0.14], 'lengthV': [0.0, 0.1, 0.08, 0.06],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [12, 6, 4, 3],
        'curve': [4, 18, 12, 0], 'curveBack': [0, 0, 0, 0], 'curveV': [8, 38, 42, 42],
        'downAngle': [0, 48, 55, 58], 'downAngleV': [0, 12, 14, 14],
        'rotate': [0, 137, 137, 137], 'rotateV': [0, 20, 20, 20],
        'branches': [0, 34, 20, 0], 'radialSegments': [12, 8, 6, 4],
    },
}

tulip_poplar = {
    'name': 'Tulip Poplar', 'latin': 'Liriodendron tulipifera',
    'bark': 'tulip_poplar_albedo.png', 'leaf': 'tulip_poplar_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.7, 'controls': BROADLEAF_CONTROLS,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.2, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'tint': 0xcfe8b4, 'leavesPerBranch': 7, 'size': 0.6, 'downAngle': 48, 'bend': 0,
        'trunkClearRadius': 0.8,
    },
    'params': {
        'scale': 26, 'scaleV': 2.5, 'levels': 3, 'ratio': 0.024, 'ratioPower': 1.35,
        'baseSize': 0.42, 'shape': 4, 'flare': 0.4, 'attractionUp': 0.85,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'length': [1.0, 0.4, 0.15, 0.13], 'lengthV': [0.0, 0.1, 0.07, 0.06],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [12, 6, 4, 3],
        'curve': [4, 16, 10, 0], 'curveBack': [0, 0, 0, 0], 'curveV': [8, 34, 38, 38],
        'downAngle': [0, 45, 50, 52], 'downAngleV': [0, 12, 14, 14],
        'rotate': [0, 140, 140, 140], 'rotateV': [0, 20, 20, 20],
        'branches': [0, 36, 20, 0], 'radialSegments': [14, 8, 6, 4],
    },
}

sweetgum = {
    'name': 'Sweetgum', 'latin': 'Liquidambar styraciflua',
    'bark': 'sweetgum_albedo.png', 'leaf': 'sweetgum_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.4, 'controls': BROADLEAF_CONTROLS,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.25, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'tint': 0xcfe4ac, 'leavesPerBranch': 7, 'size': 0.55, 'downAngle': 55, 'bend': 0,
        'trunkClearRadius': 0.75,
    },
    'params': {
        'scale': 16, 'scaleV': 2, 'levels': 3, 'ratio': 0.025, 'ratioPower': 1.3,
        'baseSize': 0.12, 'shape': 0, 'flare': 0.4, 'attractionUp': 0.15,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'length': [1.0, 0.45, 0.16, 0.14], 'lengthV': [0.0, 0.1, 0.08, 0.06],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [12, 6, 4, 3],
        'curve': [3, 14, 8, 0], 'curveBack': [0, 0, 0, 0], 'curveV': [8, 28, 32, 32],
        'downAngle': [0, 55, 62, 66], 'downAngleV': [0, 12, 14, 14],
        'rotate': [0, 137, 137, 137], 'rotateV': [0, 20, 20, 20],
        'branches': [0, 40, 22, 0], 'radialSegments': [12, 8, 6, 4],
    },
}

american_beech = {
    'name': 'American Beech', 'latin': 'Fagus grandifolia',
    'bark': 'american_beech_albedo.png', 'leaf': 'american_beech_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.5, 'controls': BROADLEAF_CONTROLS,
    'terminalStemsAreGuides': True,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.3, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'tint': 0xd6e6b0, 'leavesPerBranch': 5, 'size': 0.40, 'sizeVar': 0.20,
        'startFrac': 0.10, 'downAngle': 54, 'bend': 0, 'trunkClearRadius': 0.7,
    },
    'params': {
        'scale': 16, 'scaleV': 2, 'levels': 4, 'ratio': 0.03, 'ratioPower': 1.3,
        'baseSize': 0.2, 'shape': 1, 'flare': 0.6, 'attractionUp': 0.18,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'decurrentTrunk': True, 'decurrentTrunkExtension': 0.018,
        'length': [1.0, 0.58, 0.26, 0.12], 'lengthV': [0.0, 0.10, 0.06, 0.03],
        'lengthAbsolute': [None, None, None, 0.55], 'lengthAbsoluteV': [0, 0, 0, 0.12],
        'lengthMin': [0, 0, 0, 0.35], 'lengthMax': [None, None, None, 0.75],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [12, 10, 6, 4],
        'curve': [4, 16, 6, 3], 'curveBack': [0, 14, 4, 0], 'curveV': [8, 16, 14, 10],
        'downAngle': [0, 88, 44, 55], 'downAngleV': [0, 9, 7, 10], 'downAngleProgress': [0, -42, -8, 0],
        'rotate': [0, 137, 172, 180], 'rotateV': [0, 25, 20, 12],
        'branches': [0, 24, 18, 12], 'radialSegments': [12, 9, 6, 4],
        'branchStart': [0, 0.10, 0.12, 0.05], 'branchEnd': [1, 0.94, 0.98, 0.98],
        'branchDistPower': [1, 1.0, 0.90, 1.0], 'branchJitter': [0, 0.020, 0.018, 0.015],
    },
}

pine = {
    'name': 'Ponderosa Pine', 'latin': 'Pinus ponderosa',
    'bark': 'pine_albedo.png', 'leaf': 'pine_needle_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.2, 'controls': BROADLEAF_CONTROLS,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.1, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'tint': 0xcdd8c0, 'leavesPerBranch': 9, 'size': 0.7, 'downAngle': 62, 'bend': 0, 'startFrac': 0.15,
    },
    'params': {
        'scale': 30, 'scaleV': 3, 'levels': 3, 'ratio': 0.02, 'ratioPower': 1.4,
        'baseSize': 0.12, 'shape': 0, 'flare': 0.5, 'attractionUp': 0.0,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'length': [1.0, 0.34, 0.34, 0.28], 'lengthV': [0.0, 0.08, 0.1, 0.1],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [14, 6, 4, 3],
        'curve': [2, 12, 16, 0], 'curveBack': [0, 0, 0, 0], 'curveV': [4, 18, 24, 24],
        'downAngle': [0, 82, 80, 74], 'downAngleV': [0, 10, 12, 12],
        'rotate': [0, 137, 137, 137], 'rotateV': [0, 22, 22, 22],
        'branches': [0, 46, 16, 0], 'radialSegments': [12, 6, 4, 3],
    },
}

loblolly = {
    'name': 'Loblolly Pine', 'latin': 'Pinus taeda',
    'bark': 'loblolly_albedo.png', 'leaf': 'loblolly_needle_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.2, 'controls': BROADLEAF_CONTROLS,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.2, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'tint': 0xccd6b8, 'leavesPerBranch': 8, 'size': 0.85, 'downAngle': 55, 'bend': 0, 'startFrac': 0.2,
    },
    'params': {
        'scale': 30, 'scaleV': 3, 'levels': 3, 'ratio': 0.018, 'ratioPower': 1.4,
        'baseSize': 0.5, 'shape': 0, 'flare': 0.4, 'attractionUp': 0.15,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'length': [1.0, 0.35, 0.34, 0.28], 'lengthV': [0.0, 0.1, 0.1, 0.1],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [14, 6, 4, 3],
        'curve': [2, 12, 14, 0], 'curveBack': [0, 0, 0, 0], 'curveV': [5, 22, 26, 26],
        'downAngle': [0, 72, 68, 62], 'downAngleV': [0, 12, 14, 14],
        'rotate': [0, 137, 137, 137], 'rotateV': [0, 24, 24, 24],
        'branches': [0, 40, 16, 0], 'radialSegments': [12, 6, 4, 3],
    },
}

douglas_fir = {
    'name': 'Douglas Fir', 'latin': 'Pseudotsuga menziesii',
    'bark': 'douglas_fir_albedo.png', 'leaf': 'douglas_fir_needle_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.3, 'controls': BROADLEAF_CONTROLS,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.1, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'tint': 0xc6d2b4, 'leavesPerBranch': 10, 'size': 0.6, 'downAngle': 65, 'bend': 0, 'startFrac': 0.15,
    },
    'params': {
        'scale': 34, 'scaleV': 3, 'levels': 3, 'ratio': 0.02, 'ratioPower': 1.4,
        'baseSize': 0.12, 'shape': 0, 'flare': 0.5, 'attractionUp': 0.0,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'length': [1.0, 0.34, 0.34, 0.28], 'lengthV': [0.0, 0.08, 0.1, 0.1],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [14, 6, 4, 3],
        'curve': [2, 16, 22, 0], 'curveBack': [0, 0, 0, 0], 'curveV': [4, 18, 24, 24],
        'downAngle': [0, 84, 82, 78], 'downAngleV': [0, 10, 12, 12],
        'rotate': [0, 137, 137, 137], 'rotateV': [0, 22, 22, 22],
        'branches': [0, 52, 18, 0], 'radialSegments': [12, 6, 4, 3],
    },
}

apple = {
    'name': 'Cultivated Apple', 'latin': 'Malus domestica',
    'bark': 'apple_bark_albedo.png', 'leaf': 'apple_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.2, 'controls': BROADLEAF_CONTROLS,
    'terminalStemsAreGuides': True,
    'fruit': {'mesh': 'apple.glb', 'perBranch': 2, 'chance': 0.7, 'startFrac': 0.3, 'maxCount': 170},
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 0.72, 'clusterSizeVar': 0.18, 'clusterQuads': 2,
        'tint': 0xc8dda5, 'leavesPerBranch': 9, 'size': 0.24, 'sizeVar': 0.2,
        'startFrac': 0.1, 'downAngle': 50, 'bend': 0, 'trunkClearRadius': 0.45,
    },
    'params': {
        'scale': 5.2, 'scaleV': 0.5, 'levels': 4, 'ratio': 0.036, 'ratioPower': 1.35,
        'baseSize': 0.32, 'shape': 2, 'flare': 0.55,
        'attractionUp': 0.35, 'attractionUpMinLevel': 1,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'decurrentTrunk': True, 'decurrentTrunkExtension': 0.015,
        'length': [1.0, 0.62, 0.32, 0.14], 'lengthV': [0.0, 0.12, 0.08, 0.04],
        'lengthAbsolute': [None, None, None, 0.42], 'lengthAbsoluteV': [0, 0, 0, 0.10],
        'lengthMin': [0, 0, 0, 0.28], 'lengthMax': [None, None, None, 0.60],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [10, 9, 6, 4],
        'curve': [8, 20, 10, 4], 'curveBack': [0, -8, 6, 0], 'curveV': [12, 22, 30, 20],
        'downAngle': [0, 64, 48, 56], 'downAngleV': [0, 12, 10, 12], 'downAngleProgress': [0, -14, -6, 0],
        'rotate': [0, 137, 150, 160], 'rotateV': [0, 28, 24, 18],
        'branches': [0, 8, 17, 16], 'radialSegments': [11, 8, 5, 4],
        'branchStart': [0, 0.08, 0.12, 0.05], 'branchEnd': [1, 0.85, 0.98, 0.98],
        'branchDistPower': [1, 1.0, 0.92, 1.0], 'branchJitter': [0, 0.020, 0.018, 0.015],
    },
}

cherry = {
    'name': 'Sweet Cherry', 'latin': 'Prunus avium',
    'bark': 'cherry_bark_albedo.png', 'leaf': 'cherry_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.3, 'controls': BROADLEAF_CONTROLS,
    'terminalStemsAreGuides': True,
    'fruit': {'mesh': 'cherry_pair.glb', 'perBranch': 1, 'chance': 0.6, 'startFrac': 0.3, 'maxCount': 130},
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 0.68, 'clusterSizeVar': 0.2, 'clusterQuads': 2,
        'tint': 0xcce0a9, 'leavesPerBranch': 8, 'size': 0.28, 'sizeVar': 0.18,
        'startFrac': 0.1, 'downAngle': 46, 'bend': 0, 'trunkClearRadius': 0.5,
    },
    'params': {
        'scale': 6.5, 'scaleV': 0.6, 'levels': 4, 'ratio': 0.031, 'ratioPower': 1.3,
        'baseSize': 0.3, 'shape': 1, 'flare': 0.3,
        'attractionUp': 0.5, 'attractionUpMinLevel': 2,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'decurrentTrunk': True, 'decurrentTrunkExtension': 0.02,
        'length': [1.0, 0.5, 0.3, 0.13], 'lengthV': [0.0, 0.10, 0.07, 0.04],
        'lengthAbsolute': [None, None, None, 0.5], 'lengthAbsoluteV': [0, 0, 0, 0.12],
        'lengthMin': [0, 0, 0, 0.32], 'lengthMax': [None, None, None, 0.7],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [10, 9, 6, 4],
        'curve': [4, 12, 8, 3], 'curveBack': [0, 6, 4, 0], 'curveV': [8, 16, 18, 14],
        'downAngle': [0, 48, 42, 50], 'downAngleV': [0, 10, 9, 12], 'downAngleProgress': [0, -18, -6, 0],
        'rotate': [0, 137, 165, 175], 'rotateV': [0, 25, 22, 16],
        'branches': [0, 8, 16, 14], 'radialSegments': [10, 8, 5, 4],
        'branchStart': [0, 0.16, 0.12, 0.05], 'branchEnd': [1, 0.94, 0.98, 0.98],
        'branchDistPower': [1, 1.0, 0.90, 1.0], 'branchJitter': [0, 0.018, 0.016, 0.014],
    },
}

paper_birch = {
    'name': 'Paper Birch', 'latin': 'Betula papyrifera',
    'bark': 'paper_birch_albedo.png', 'leaf': 'paper_birch_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.0, 'controls': BROADLEAF_CONTROLS,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.05, 'clusterSizeVar': 0.28, 'clusterQuads': 2,
        'tint': 0xd7e6b5, 'leavesPerBranch': 28, 'size': 0.20, 'sizeVar': 0.22, 'widthRatio': 0.68,
        'startFrac': 0.18, 'downAngle': 50, 'droop': 18, 'bend': 0, 'trunkClearRadius': 0.32,
    },
    'params': {
        'scale': 18, 'scaleV': 2, 'levels': 3, 'ratio': 0.0095, 'ratioPower': 1.3,
        'baseSize': 0.12, 'shape': 1, 'flare': 0.25, 'attractionUp': 0.25,
        'baseSplits': 0, 'baseSplitAngle': 12,
        'length': [1.0, 0.36, 0.16, 0.14], 'lengthV': [0.0, 0.09, 0.08, 0.06],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [12, 6, 4, 3],
        'curve': [3, 5, 8, 0], 'curveBack': [0, 0, 0, 0], 'curveV': [8, 34, 42, 38],
        'downAngle': [0, 80, 55, 55], 'downAngleV': [0, 10, 14, 16], 'downAngleProgress': [0, -34, -10, 0],
        'rotate': [0, 137, 137, 137], 'rotateV': [0, 24, 24, 24],
        'branches': [0, 24, 28, 0], 'radialSegments': [10, 6, 4, 3],
        'branchStart': [0, 0.12, 0.22, 0], 'branchEnd': [1, 0.94, 0.98, 1],
        'branchDistPower': [1, 1, 0.72, 1], 'branchJitter': [0, 0.015, 0.025, 0],
        'lengthScaleBase': [1, 1, 1, 1], 'lengthScaleTip': [1, 0.55, 1.10, 1],
    },
}

quaking_aspen = {
    'name': 'Quaking Aspen', 'latin': 'Populus tremuloides',
    'bark': 'quaking_aspen_albedo.png', 'leaf': 'quaking_aspen_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.25, 'controls': BROADLEAF_CONTROLS,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.0, 'clusterSizeVar': 0.28, 'clusterQuads': 2,
        'tint': 0xd9e8b9, 'leavesPerBranch': 38, 'size': 0.22, 'sizeVar': 0.22, 'widthRatio': 1.0, 'flutterScale': 1.7,
        'startFrac': 0.15, 'downAngle': 48, 'droop': 12, 'bend': 0, 'trunkClearRadius': 0.22,
    },
    'params': {
        'scale': 20, 'scaleV': 2, 'levels': 3, 'ratio': 0.007, 'ratioPower': 1.35,
        'baseSize': 0.52, 'shape': 1, 'flare': 0.25, 'attractionUp': 0.22,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'length': [1.0, 0.23, 0.20, 0.14], 'lengthV': [0.0, 0.08, 0.08, 0.06],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [12, 5, 4, 3],
        'curve': [2, 8, 8, 0], 'curveBack': [0, 0, 0, 0], 'curveV': [5, 18, 28, 28],
        'downAngle': [0, 62, 58, 58], 'downAngleV': [0, 6, 12, 14], 'downAngleProgress': [0, -14, -6, 0],
        'rotate': [0, 144, 137, 137], 'rotateV': [0, 16, 18, 20],
        'branches': [0, 20, 24, 0], 'radialSegments': [10, 6, 4, 3],
        'branchStart': [0, 0.52, 0.38, 0], 'branchEnd': [1, 0.96, 0.98, 1],
        'branchDistPower': [1, 1, 0.72, 1], 'branchJitter': [0, 0.012, 0.025, 0],
        'lengthScaleTip': [1, 0.50, 1.10, 1],
    },
}

american_sycamore = {
    'name': 'American Sycamore', 'latin': 'Platanus occidentalis',
    'bark': 'american_sycamore_albedo.png', 'leaf': 'american_sycamore_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 2.2, 'controls': BROADLEAF_CONTROLS,
    'terminalStemsAreGuides': True,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 3, 'clusterSize': 1.6, 'clusterSizeVar': 0.32, 'clusterQuads': 2,
        'tint': 0xd8e2bc, 'leavesPerBranch': 12, 'size': 0.26, 'sizeVar': 0.22, 'widthRatio': 1.02, 'quads': 1,
        'taper': 0.08, 'startFrac': 0.06, 'downAngle': 54, 'droop': 14, 'bend': 0, 'trunkClearRadius': 0.70,
    },
    'params': {
        'scale': 27, 'scaleV': 3, 'levels': 4, 'ratio': 0.036, 'ratioPower': 1.20,
        'baseSize': 0.10, 'shape': 1, 'flare': 1.0, 'attractionUp': 0.18,
        'baseSplits': 0, 'baseSplitAngle': 18,
        'trunkForkHeight': 0.22, 'trunkForkCount': 2,
        'trunkForkAngle': 26, 'trunkForkAngleV': 8,
        'trunkForkRadiusKeep': 0.73, 'trunkForkBaseTaper': 0.18, 'trunkForkFlareScale': 0.94,
        'decurrentTrunk': True, 'decurrentTrunkExtension': 0.018,
        'length': [1.0, 0.52, 0.30, 0.20], 'lengthV': [0.0, 0.12, 0.13, 0.10],
        'lengthAbsolute': [None, None, None, 1.10], 'lengthAbsoluteV': [0, 0, 0, 0.22],
        'lengthMin': [0, 0, 0, 0.65], 'lengthMax': [None, 13.5, None, 1.55],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [14, 9, 6, 3],
        'curve': [3, 22, 12, 4], 'curveBack': [0, -18, -18, -10], 'curveV': [8, 34, 62, 48],
        'zigzagAngle': [0, 0, 10, 7], 'zigzagAngleV': [0, 0, 3, 2],
        'downAngle': [0, 74, 62, 55], 'downAngleV': [0, 14, 24, 22], 'downAngleProgress': [0, -30, -8, 0],
        'rotate': [0, 146, 90, 90], 'rotateV': [0, 24, 38, 35],
        'branches': [0, 10, 22, 40], 'radialSegments': [16, 12, 7, 4],
        'branchStart': [0, 0.10, 0.20, 0.10], 'branchEnd': [1, 0.86, 0.98, 0.98],
        'branchDistPower': [1, 1.15, 0.72, 0.82], 'branchJitter': [0, 0.015, 0.025, 0.018],
        'lengthScaleBase': [1, 1.25, 1, 1], 'lengthScaleTip': [1, 0.85, 1.12, 1],
    },
}

flowering_dogwood = {
    'name': 'Flowering Dogwood', 'latin': 'Cornus florida',
    'bark': 'flowering_dogwood_albedo.png', 'leaf': 'flowering_dogwood_single_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 0.65, 'controls': BROADLEAF_CONTROLS,
    'preserveLod2Tips': True, 'crossedLod2Cards': True,
    'foliage': {
        'mode': 'leaves', 'clustersPerBranch': 4, 'clusterSize': 1.05, 'clusterSizeVar': 0.28, 'clusterQuads': 2,
        'tint': 0xd3dfad, 'leavesPerBranch': 44, 'size': 0.15, 'sizeVar': 0.20, 'widthRatio': 1.0,
        'taper': 0.10, 'startFrac': 0.52, 'downAngle': 50, 'droop': 8, 'bend': 0.65,
        'whorlSize': 2, 'rotate': 90, 'rotateV': 5, 'trunkClearRadius': 0.18,
    },
    'params': {
        'scale': 6.6, 'scaleV': 0.7, 'levels': 3, 'ratio': 0.022, 'ratioPower': 1.15,
        'baseSize': 0.10, 'shape': 2, 'flare': 0.30, 'attractionUp': 0.45,
        'baseSplits': 0, 'baseSplitAngle': 16,
        'trunkForkHeight': 0.24, 'trunkForkCount': 2,
        'trunkForkAngle': 38, 'trunkForkAngleV': 8,
        'trunkForkRadiusKeep': 0.72, 'trunkForkBaseTaper': 0.20, 'trunkForkFlareScale': 0.94,
        'length': [1.0, 0.46, 0.22, 0.15], 'lengthV': [0.0, 0.16, 0.10, 0.08],
        'taper': [1.0, 1.0, 1.0, 1.0], 'curveRes': [10, 9, 5, 3],
        'curve': [4, 0, 12, 0], 'curveBack': [0, -34, -8, 0], 'curveV': [8, 28, 34, 22],
        'downAngle': [0, 98, 54, 52], 'downAngleV': [0, 12, 16, 14], 'downAngleProgress': [0, -18, -10, 0],
        'rotate': [0, 90, 90, 90], 'rotateV': [0, 24, 16, 8],
        'whorlSize': [1, 2, 2, 1],
        'branches': [0, 12, 36, 0], 'radialSegments': [10, 7, 5, 3],
        'branchStart': [0, 0.10, 0.16, 0], 'branchEnd': [1, 0.78, 0.98, 1],
        'branchDistPower': [1, 1.08, 0.68, 1], 'branchJitter': [0, 0.045, 0.03, 0],
        'lengthScaleBase': [1, 1.10, 0.90, 1], 'lengthScaleTip': [1, 1.22, 1.08, 1],
        'decurrentTrunk': True, 'decurrentTrunkExtension': 0.015,
    },
}


def _willow_vine_get(s):
    v = s['foliage'].get('vineSpacing')
    return v if v is not None else (1 / s['foliage']['vinesPerMeter'])


def _len1_mul(s, v):
    s['params']['length'][1] *= v


weeping_willow = {
    'name': 'Weeping Willow', 'latin': 'Salix babylonica',
    'bark': 'weeping_willow_albedo.png', 'leaf': 'weeping_willow_spray_albedo.png',
    'biome': 'temperate', 'tileWorldSize': 1.35,
    'controls': [
        _dial('height', 'Height (m)', 6, 24, 0.5, *_p('scale')),
        _dial('scaffolds', 'Primary scaffolds', 5, 14, 1, _arr_get('branches', 1, None), _arr_set('branches', 1, rnd=True)),
        _dial('crownSpread', 'Crown spread', 0.7, 1.35, 0.05, _one, _len1_mul),
        _dial('feederSpacing', 'Feeder spacing (m)', 0.45, 1.2, 0.05, _arr_get('branchSpacing', 2, None), _arr_set('branchSpacing', 2)),
        _dial('curtainSpacing', 'Vine spacing (m)', 0.05, 0.3, 0.01, _willow_vine_get, _fol_set('vineSpacing')),
        _dial('curtainLength', 'Vine length (m)', 2.0, 7.0, 0.1, _fol_get('length'), _fol_set('length')),
        _dial('trunkThickness', 'Trunk thickness', 0.65, 1.6, 0.05, _one, _mul_set('ratio')),
    ],
    'lodDistanceMultipliers': {'lod1': 2.5, 'lod2': 6.5, 'billboard': 10.5},
    'foliage': {
        'mode': 'willowCurtains', 'tint': 0xd2e3ad,
        'leavesPerBranch': 1, 'size': 1, 'sizeVar': 0, 'widthRatio': 0.55,
        'quads': 2, 'alphaTest': 0.35,
        'vinesPerMeter': 9, 'minPerFeeder': 6, 'maxPerFeeder': 36,
        'startFrac': 0.12, 'endFrac': 0.98, 'attachmentJitter': 0.35,
        'attachmentMinHeightRatio': 0.30,
        'length': 5.8, 'lengthVariation': 1.3, 'minLength': 3.4,
        'curveBuildup': 0.32, 'curveBuildupVariation': 0.10,
        'tangentInfluence': 0.50, 'outwardSpread': 0.75,
        'initialLift': 0.18, 'minLaunchY': 0.12,
        'archLift': 0.58, 'archLiftVariation': 0.16,
        'curveReach': 0.92, 'curveReachVariation': 0.22,
        'terminalSweep': 0.22, 'terminalSweepVariation': 0.05,
        'groupedCardHorizontalScale': 0.95, 'groupedCardVerticalScale': 1.20,
        'groupedCardVineKeepFraction': 0.50, 'groupedCardFeederKeepFraction': 0.80,
        'lateralVariation': 0.34, 'tailPull': 1.6,
        'segments': 12,
        'floor': 0.42, 'floorVariation': 0.08, 'floorWave': 0.10,
        'floorLobes': 3, 'floorMin': 0.28, 'floorMax': 0.60,
    },
    'params': {
        'scale': 13, 'scaleV': 1.5, 'levels': 3, 'ratio': 0.04, 'ratioPower': 1.3,
        'baseSize': 0.14, 'shape': 2, 'flare': 0.75, 'attractionUp': 0,
        'forceDir': {'x': 0, 'y': 1, 'z': 0}, 'forceStrength': 0,
        'baseSplits': 0, 'baseSplitAngle': 0,
        'length': [1, 0.62, 0.42], 'lengthV': [0, 0.08, 0.10],
        'lengthScaleBase': [1, 1, 0.70], 'lengthScaleTip': [1, 1, 1.20],
        'taper': [1, 1, 1], 'curveRes': [12, 10, 7],
        'curve': [4, -28, 12], 'curveBack': [0, 70, 22], 'curveV': [7, 18, 24],
        'downAngle': [0, 64, 65], 'downAngleProgress': [0, -26, -20],
        'downAngleV': [0, 10, 20],
        'rotate': [0, 137, 110], 'rotateV': [0, 25, 40], 'whorlSize': [1, 1, 1],
        'branchStart': [0, 0.14, 0.20], 'branchEnd': [1, 0.98, 0.98],
        'branchDistPower': [1, 1.20, 0.78], 'branchJitter': [0, 0.015, 0.035],
        'branchSpacing': [0, 0, 0.75], 'branchMin': [0, 0, 3], 'branchMax': [0, 0, 8],
        'branches': [0, 9, 10],
        'radialSegments': [12, 9, 5],
    },
}


def _trunk_mul(s, v):
    s['params']['trunkRadius'] *= v


joshua_tree = {
    'name': 'Joshua Tree', 'latin': 'Yucca brevifolia',
    'bark': 'joshua_tree_albedo.png', 'thatchBark': 'joshua_thatch_albedo.png',
    'leaf': 'yucca_rosette_albedo.png', 'biome': 'desert',
    'groundTexture': 'desert_ground_albedo.png', 'rockTexture': 'desert_rock_albedo.png',
    'tileWorldSize': 0.8, 'plantSink': 0.15, 'foliageType': 'rosette',
    'controls': [
        _dial('trunkHeight', 'Trunk height (m)', 0.8, 4, 0.1, *_p('firstForkHeight')),
        _dial('armLength', 'Arm length (m)', 0.4, 1.6, 0.05, *_p('armLength')),
        _dial('forkGenerations', 'Fork generations', 2, 8, 1, _param_get('forkGenerations', None), _set_round('forkGenerations')),
        _dial('branchiness', 'Branchiness', 0.3, 0.9, 0.05, *_p('branchiness')),
        _dial('forkSpread', 'Fork spread (°)', 12, 50, 1, *_p('forkSpread')),
        _dial('armBend', 'Arm bend (°)', 0, 40, 1, *_p('armBend')),
        _dial('gnarliness', 'Gnarliness', 0, 30, 1, *_p('gnarliness')),
        _dial('curlUp', 'Arm curl-up', 0, 0.8, 0.05, *_p('curlUp')),
        _dial('trunks', 'Trunks (rare >1)', 1, 4, 1, _param_get('trunks', None), _set_round('trunks')),
        _dial('trunkThickness', 'Trunk thickness', 0.5, 2, 0.05, _one, _trunk_mul),
        _dial('rosetteSize', 'Rosette size', 0.4, 1.3, 0.05, _fol_get('leafLen'), _fol_set('leafLen')),
        _dial('rosetteVar', 'Rosette variation', 0, 0.4, 0.02, _fol_get('leafLenVar'), _fol_set('leafLenVar')),
    ],
    'advancedControls': [
        _dial('armFalloff', 'Arm falloff / gen', 0.5, 1, 0.02, _param_get('armFalloff', 0.86), _p('armFalloff')[1]),
        _dial('forkTriChance', 'Trident chance', 0, 0.6, 0.05, _param_get('forkTriChance', 0.15), _p('forkTriChance')[1]),
        _dial('forkRadiusKeep', 'Arm thickness keep', 0.5, 1, 0.02, _param_get('forkRadiusKeep', 0.86), _p('forkRadiusKeep')[1]),
        _dial('forkBaseScale', 'Arm base neck', 0.4, 1.2, 0.02, _param_get('forkBaseScale', 1.0), _p('forkBaseScale')[1]),
        _dial('branchRepel', 'Branch repel', 0, 1.5, 0.05, _param_get('branchRepel', 0.7), _p('branchRepel')[1]),
        _dial('trunkFlare', 'Trunk base flare', 1, 3, 0.05, _param_get('trunkFlare', 1.7), _p('trunkFlare')[1]),
        _dial('trunkSegRes', 'Trunk ring detail', 3, 16, 1, _param_get('trunkSegRes', 9), _set_round('trunkSegRes')),
        _dial('trunkSplayDeg', 'Multi-trunk splay (°)', 0, 40, 1, _param_get('trunkSplayDeg', 14), _p('trunkSplayDeg')[1]),
    ],
    'foliage': {'leafLen': 0.5, 'leafLenVar': 0.15, 'thatchStep': 0.085},
    'params': {
        'firstForkHeight': 1.2, 'armLength': 0.95, 'armFalloff': 0.87, 'forkGenerations': 6,
        'branchiness': 0.6, 'forkSpread': 50, 'curlUp': 0.28, 'armBend': 8, 'gnarliness': 12,
        'continuationKink': 9, 'forkRadiusKeep': 0.86, 'trunkRadius': 0.17, 'radialSegs': 10,
        'trunks': 1, 'branchRepel': 0.9,
    },
}


def _rib_set(s, v):
    s['params']['ribCount'] = js_round(v / 4) * 4
    s['params']['radialSegs'] = max(48, s['params']['ribCount'] * 4)


def _spine_get(s):
    sp = s.get('spines') or {}
    v = sp.get('density')
    return 1 if v is None else v


def _spine_set(s, v):
    s['spines']['density'] = v


saguaro = {
    'name': 'Saguaro', 'latin': 'Carnegiea gigantea',
    'bark': 'saguaro_skin_albedo.png', 'spine': 'saguaro_spines_albedo.png',
    'leaf': 'saguaro_spines_albedo.png', 'biome': 'desert',
    'groundTexture': 'desert_ground_albedo.png', 'rockTexture': 'desert_rock_albedo.png',
    'tileWorldSize': 0.8, 'plantSink': 0.1, 'foliageType': 'rosette', 'cactus': True,
    'barkDamage': 0.28,
    'controls': [
        _dial('trunkHeight', 'Column growth (m/seg)', 0.7, 2.2, 0.1, *_p('firstForkHeight')),
        _dial('armLength', 'Arm length (m)', 0.6, 2, 0.1, *_p('armLength')),
        _dial('forkGenerations', 'Column segments', 3, 8, 1, _param_get('forkGenerations', None), _set_round('forkGenerations')),
        _dial('branchiness', 'Arm frequency', 0.0, 0.7, 0.05, *_p('branchiness')),
        _dial('forkSpread', 'Arm splay (°)', 40, 90, 2, *_p('forkSpread')),
        _dial('curlUp', 'Arm curl-up', 0.2, 0.85, 0.05, *_p('curlUp')),
        _dial('ribCount', 'Ribs', 12, 24, 4, _param_get('ribCount', None), _rib_set),
        _dial('ribDepth', 'Rib depth', 0.04, 0.2, 0.01, *_p('ribDepth')),
        _dial('trunkThickness', 'Column thickness', 0.5, 2, 0.05, _one, _trunk_mul),
        _dial('spineDensity', 'Spine density', 0.15, 1, 0.05, _spine_get, _spine_set),
    ],
    'advancedControls': [
        _dial('armAsymmetric', 'Arm style', None, None, None, _param_get('armAsymmetric', True), _p('armAsymmetric')[1],
              dropdown={'Candelabra (asymmetric)': True, 'Symmetric V': False}),
        _dial('armMinHeightFrac', 'Arm min height', 0, 0.8, 0.05, _param_get('armMinHeightFrac', 0.2), _p('armMinHeightFrac')[1]),
        _dial('armMaxOrder', 'Arm max order', 1, 4, 1, _param_get('armMaxOrder', 1), _set_round('armMaxOrder')),
        _dial('armGenerations', 'Arm length (segments)', 0, 8, 1, _param_get('armGenerations', 5), _set_round('armGenerations')),
        _dial('armFalloff', 'Arm falloff / gen', 0.5, 1, 0.02, _param_get('armFalloff', 0.9), _p('armFalloff')[1]),
        _dial('forkTriChance', '2-arm chance', 0, 0.6, 0.05, _param_get('forkTriChance', 0.15), _p('forkTriChance')[1]),
        _dial('forkRadiusKeep', 'Arm thickness keep', 0.5, 1, 0.02, _param_get('forkRadiusKeep', 0.72), _p('forkRadiusKeep')[1]),
        _dial('forkBaseScale', 'Arm base neck', 0.4, 1.2, 0.02, _param_get('forkBaseScale', 0.58), _p('forkBaseScale')[1]),
        _dial('branchRepel', 'Branch repel', 0, 1.5, 0.05, _param_get('branchRepel', 0.6), _p('branchRepel')[1]),
        _dial('trunkSegRes', 'Column ring detail', 3, 16, 1, _param_get('trunkSegRes', 9), _set_round('trunkSegRes')),
    ],
    'foliage': False,
    'spines': {'density': 1, 'size': 0.12, 'widthFrac': 0.85, 'embed': 0.45, 'sizeVar': 0.28, 'splay': 1.0},
    'params': {
        'firstForkHeight': 1.3, 'armLength': 1.1, 'armFalloff': 0.9, 'forkGenerations': 5,
        'branchiness': 0.55, 'armAsymmetric': True, 'armMinHeightFrac': 0.25, 'armMaxOrder': 1,
        'armGenerations': 4, 'forkSpread': 83, 'curlUp': 0.8, 'armBend': 1, 'gnarliness': 4,
        'forkRadiusKeep': 0.8, 'forkBaseScale': 0.58, 'trunkRadius': 0.34, 'trunkFlare': 0,
        'trunkPinch': 0.12, 'trunkSegRes': 6, 'ribCount': 16, 'ribsPerTile': 4, 'ribDepth': 0.12,
        'radialSegs': 64, 'trunks': 1, 'branchRepel': 0.6,
    },
}

creosote = {
    'name': 'Creosote Bush', 'latin': 'Larrea tridentata', 'category': 'shrub',
    'bark': 'creosote_branch_albedo.png', 'leaf': 'creosote_albedo.png', 'biome': 'desert',
    'groundTexture': 'desert_ground_albedo.png', 'rockTexture': 'desert_rock_albedo.png',
    'tileWorldSize': 0.5, 'plantSink': 0.015, 'foliageType': 'sprayClusters',
    'controls': [
        _dial('stems', 'Stems from crown', 3, 8, 1, _param_get('trunks', None), _set_round('trunks')),
        _dial('stemSplay', 'Stem splay (°)', 12, 40, 1, *_p('trunkSplayDeg')),
        _dial('armLength', 'Segment length (m)', 0.25, 0.8, 0.05, *_p('armLength')),
        _dial('forkGenerations', 'Fork generations', 3, 7, 1, _param_get('forkGenerations', None), _set_round('forkGenerations')),
        _dial('branchiness', 'Branchiness', 0.4, 0.9, 0.05, *_p('branchiness')),
        _dial('forkSpread', 'Fork spread (°)', 14, 40, 1, *_p('forkSpread')),
        _dial('gnarliness', 'Gnarliness', 4, 28, 1, *_p('gnarliness')),
        _dial('sprayCount', 'Sprays per twig', 1, 10, 1, _fol_get('clustersPerBranch'), _fol_set('clustersPerBranch', rnd=True)),
        _dial('spraySize', 'Spray size', 0.25, 0.9, 0.05, _fol_get('clusterSize'), _fol_set('clusterSize')),
    ],
    'advancedControls': [
        _dial('armFalloff', 'Segment falloff / gen', 0.6, 1, 0.02, _param_get('armFalloff', 0.85), _p('armFalloff')[1]),
        _dial('forkRadiusKeep', 'Twig thickness keep', 0.6, 1, 0.02, _param_get('forkRadiusKeep', 0.82), _p('forkRadiusKeep')[1]),
        _dial('curlUp', 'Curl-up', 0, 0.7, 0.05, _param_get('curlUp', 0.3), _p('curlUp')[1]),
        _dial('branchRepel', 'Branch repel', 0, 1.5, 0.05, _param_get('branchRepel', 0.6), _p('branchRepel')[1]),
    ],
    'foliage': {
        'clustersPerBranch': 8, 'clusterSize': 0.58, 'clusterSizeVar': 0.35, 'clusterQuads': 2,
        'alphaTest': 0.4, 'tint': 0xffffff, 'transmit': [0.30, 0.44, 0.18],
        'downAngle': 24, 'downAngleV': 12, 'droop': 14, 'startFrac': 0.22, 'parentSprays': 0.5, 'rotate': 137,
    },
    'params': {
        'trunks': 5, 'trunkSplayDeg': 38, 'firstForkHeight': 0.12, 'armLength': 0.55, 'armFalloff': 0.85,
        'forkGenerations': 4, 'branchiness': 0.78, 'forkSpread': 30, 'forkTriChance': 0.1, 'curlUp': 0.15,
        'armBend': 12, 'gnarliness': 14, 'continuationKink': 10, 'forkRadiusKeep': 0.78,
        'trunkRadius': 0.022, 'trunkFlare': 1.2, 'branchRepel': 0.6, 'minRadius': 0.004,
        'radialSegs': 7, 'segCurveRes': 3, 'tileWorldSize': 0.5, 'barkGrainU': True, 'windWeightScale': 0.3,
    },
}

blackbrush = {
    'name': 'Blackbrush', 'latin': 'Coleogyne ramosissima', 'category': 'shrub',
    'bark': 'blackbrush_branch_albedo.png', 'leaf': 'blackbrush_albedo.png', 'biome': 'desert',
    'groundTexture': 'desert_ground_albedo.png', 'rockTexture': 'desert_rock_albedo.png',
    'tileWorldSize': 0.4, 'plantSink': 0.015, 'barkTint': 0xbfc7d9, 'foliageType': 'sprayClusters',
    'controls': [
        _dial('stems', 'Stems from crown', 4, 9, 1, _param_get('trunks', None), _set_round('trunks')),
        _dial('stemSplay', 'Stem splay (°)', 16, 45, 1, *_p('trunkSplayDeg')),
        _dial('armLength', 'Segment length (m)', 0.15, 0.45, 0.02, *_p('armLength')),
        _dial('forkGenerations', 'Fork generations', 3, 7, 1, _param_get('forkGenerations', None), _set_round('forkGenerations')),
        _dial('branchiness', 'Branchiness', 0.5, 0.95, 0.05, *_p('branchiness')),
        _dial('gnarliness', 'Gnarliness', 8, 35, 1, *_p('gnarliness')),
        _dial('sprayCount', 'Sprays per twig', 1, 5, 1, _fol_get('clustersPerBranch'), _fol_set('clustersPerBranch', rnd=True)),
        _dial('spraySize', 'Spray size', 0.2, 0.7, 0.05, _fol_get('clusterSize'), _fol_set('clusterSize')),
    ],
    'advancedControls': [
        _dial('armFalloff', 'Segment falloff / gen', 0.6, 1, 0.02, _param_get('armFalloff', 0.82), _p('armFalloff')[1]),
        _dial('forkSpread', 'Fork spread (°)', 18, 45, 1, _param_get('forkSpread', 30), _p('forkSpread')[1]),
        _dial('forkRadiusKeep', 'Twig thickness keep', 0.6, 1, 0.02, _param_get('forkRadiusKeep', 0.8), _p('forkRadiusKeep')[1]),
        _dial('branchRepel', 'Branch repel', 0, 1.5, 0.05, _param_get('branchRepel', 0.5), _p('branchRepel')[1]),
    ],
    'foliage': {
        'clustersPerBranch': 3, 'clusterSize': 0.36, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'alphaTest': 0.52, 'tint': 0xb7c0e2, 'transmit': [0.20, 0.21, 0.19],
        'downAngle': 32, 'downAngleV': 14, 'droop': 16, 'startFrac': 0.2, 'parentSprays': 0.35, 'rotate': 137,
    },
    'params': {
        'trunks': 6, 'trunkSplayDeg': 42, 'firstForkHeight': 0.08, 'armLength': 0.32, 'armFalloff': 0.82,
        'forkGenerations': 4, 'branchiness': 0.85, 'forkSpread': 34, 'forkTriChance': 0.12, 'curlUp': 0.1,
        'armBend': 14, 'gnarliness': 22, 'continuationKink': 14, 'forkRadiusKeep': 0.76,
        'trunkRadius': 0.015, 'trunkFlare': 1.15, 'branchRepel': 0.5, 'minRadius': 0.0035,
        'radialSegs': 6, 'segCurveRes': 3, 'tileWorldSize': 0.4, 'windWeightScale': 0.25,
    },
}

sagebrush = {
    'name': 'Big Sagebrush', 'latin': 'Artemisia tridentata', 'category': 'shrub',
    'bark': 'blackbrush_branch_albedo.png', 'leaf': 'sagebrush_albedo.png', 'biome': 'desert',
    'groundTexture': 'desert_ground_albedo.png', 'rockTexture': 'desert_rock_albedo.png',
    'tileWorldSize': 0.45, 'plantSink': 0.015, 'foliageType': 'sprayClusters',
    'controls': [
        _dial('stems', 'Stems from crown', 2, 6, 1, _param_get('trunks', None), _set_round('trunks')),
        _dial('stemSplay', 'Stem splay (°)', 10, 30, 1, *_p('trunkSplayDeg')),
        _dial('armLength', 'Segment length (m)', 0.2, 0.6, 0.02, *_p('armLength')),
        _dial('forkGenerations', 'Fork generations', 3, 6, 1, _param_get('forkGenerations', None), _set_round('forkGenerations')),
        _dial('curlUp', 'Upsweep', 0.2, 0.8, 0.05, *_p('curlUp')),
        _dial('branchiness', 'Branchiness', 0.5, 0.9, 0.05, *_p('branchiness')),
        _dial('sprayCount', 'Sprays per twig', 2, 6, 1, _fol_get('clustersPerBranch'), _fol_set('clustersPerBranch', rnd=True)),
        _dial('spraySize', 'Spray size', 0.15, 0.5, 0.02, _fol_get('clusterSize'), _fol_set('clusterSize')),
    ],
    'advancedControls': [
        _dial('forkSpread', 'Fork spread (°)', 12, 32, 1, _param_get('forkSpread', 20), _p('forkSpread')[1]),
        _dial('gnarliness', 'Gnarliness', 4, 20, 1, _param_get('gnarliness', 10), _p('gnarliness')[1]),
        _dial('trunkFlare', 'Stem base flare', 1, 2.2, 0.05, _param_get('trunkFlare', 1.5), _p('trunkFlare')[1]),
        _dial('startFrac', 'Foliage start', 0, 0.6, 0.05, _fol_get('startFrac', 0.15), _fol_set('startFrac')),
    ],
    'foliage': {
        'clustersPerBranch': 3, 'clusterSize': 0.48, 'clusterSizeVar': 0.3, 'clusterQuads': 2,
        'alphaTest': 0.42, 'tint': 0xffffff, 'transmit': [0.32, 0.40, 0.20],
        'downAngle': 30, 'downAngleV': 12, 'droop': 10, 'startFrac': 0.15, 'parentSprays': 0.6, 'rotate': 137,
    },
    'params': {
        'trunks': 3, 'trunkSplayDeg': 26, 'firstForkHeight': 0.15, 'armLength': 0.36, 'armFalloff': 0.86,
        'forkGenerations': 4, 'branchiness': 0.8, 'forkSpread': 24, 'forkTriChance': 0.08, 'curlUp': 0.28,
        'armBend': 10, 'gnarliness': 10, 'continuationKink': 8, 'forkRadiusKeep': 0.78,
        'trunkRadius': 0.02, 'trunkFlare': 1.15, 'branchRepel': 0.55, 'minRadius': 0.004,
        'radialSegs': 7, 'segCurveRes': 3, 'tileWorldSize': 0.45, 'windWeightScale': 0.3,
    },
}

SPECIES = {
    'whiteOak': white_oak,
    'redMaple': red_maple,
    'tulipPoplar': tulip_poplar,
    'sweetgum': sweetgum,
    'americanBeech': american_beech,
    'pine': pine,
    'loblolly': loblolly,
    'douglasFir': douglas_fir,
    'apple': apple,
    'cherry': cherry,
    'paperBirch': paper_birch,
    'quakingAspen': quaking_aspen,
    'americanSycamore': american_sycamore,
    'floweringDogwood': flowering_dogwood,
    'weepingWillow': weeping_willow,
    'joshuaTree': joshua_tree,
    'saguaro': saguaro,
    'creosote': creosote,
    'blackbrush': blackbrush,
    'sagebrush': sagebrush,
}

DEFAULT_SPECIES = 'whiteOak'
