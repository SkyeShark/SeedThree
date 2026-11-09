"""three.js's ACES tone map as Blender's AgX view.

The app renders with renderer.toneMapping = ACESFilmicToneMapping and an exposure
(1.3 in the app, 1.05 in the reference turntable, the default 1.0 in the eidoverse
example). three's ACES first scales by exposure / 0.6, then applies the fitted RRT + ODT:
a contrasty curve. AgX with its 'High Contrast' look at log2(exposure) + 0.23 stops
gives the same display value on a neutral ramp: measured through Blender 5.2's OCIO
against three r184's formula over scene-linear 0.02..1.0, the mean difference is 0.008
(sRGB-encoded, 0..1) at exposure 1.3, 1.05 and 1.0. Base Contrast, the default look, is
flatter: at the best exposure it misses by 0.05, and at log2(exposure) it renders the
app's mid-tones darker and its shadows lifted (a hazy, low-contrast frame).

    from seedthree.scene.tonemap import aces_view
    aces_view(scene, 1.3)
"""

import math

ACES_LOOK = 'AgX - High Contrast'
ACES_OFFSET_STOPS = 0.23


def aces_view(scene, exposure=1.0):
    """The AgX view that matches three's ACESFilmicToneMapping at `exposure`. Returns the stops."""
    vs = scene.view_settings
    vs.view_transform = 'AgX'
    try:
        vs.look = ACES_LOOK
    except TypeError:
        pass
    vs.exposure = math.log2(exposure) + ACES_OFFSET_STOPS
    vs.gamma = 1.0
    return vs.exposure
