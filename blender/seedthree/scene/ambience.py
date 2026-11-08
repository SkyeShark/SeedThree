"""The app's ambient soundscape (src/audio/ambience.js) as keyed sequencer sound strips.

The app plays a whisper-quiet looping wind bed per biome (wind_<biome>.wav at 0.01,
faded in over 1.6 s) and, every 6-18 s (temperate: crow, mallard) or 8-24 s (desert:
roadrunner, cactus wren), one bird call: a random variant, playback rate 0.96-1.05,
peak 0.06-0.14, a 0.35 s (or 30%) fade in and a 0.8 s (or 45%) fade out, panned
+-0.7. Here the same schedule is laid out over the shot's frame range as sound strips
with keyed volume envelopes, from a seeded RNG instead of Math.random, so the audio
renders with the film and repeats run to run.

    from seedthree.scene import ambience
    ambience.build_ambience(scene, biome='temperate', seed=1)
"""

import math
import os

import bpy

from .. import api as _api
from ..core.rng import Rng

BIRD_KINDS = {'temperate': ['crow', 'mallard'], 'desert': ['roadrunner', 'cactus_wren']}
INTERVAL = {'temperate': (6, 18), 'desert': (8, 24)}
WIND_LEVEL = 0.01
BIRD_PEAK = (0.06, 0.14)


def audio_dir():
    return os.path.join(_api.ASSETS_DIR, 'audio')


def variants_of(kind):
    out = []
    for f in sorted(os.listdir(audio_dir())):
        stem, ext = os.path.splitext(f)
        if ext.lower() in ('.mp3', '.wav') and (stem == kind or stem.startswith(kind + '_')):
            out.append(os.path.join(audio_dir(), f))
    return out


def _seq(scene):
    if scene.sequence_editor is None:
        scene.sequence_editor_create()
    return scene.sequence_editor


def _strips(ed):
    return ed.strips if hasattr(ed, 'strips') else ed.sequences


def _key_volume(strip, frames_values):
    for f, v in frames_values:
        strip.volume = v
        strip.keyframe_insert('volume', frame=f)
    ad = strip.id_data.animation_data
    if ad and ad.action:
        for fc in _fcurves(ad.action):
            if fc.data_path.endswith('.volume') and strip.name in fc.data_path:
                for kp in fc.keyframe_points:
                    kp.interpolation = 'LINEAR'


def _fcurves(action):
    fcs = getattr(action, 'fcurves', None)
    if fcs is not None:
        return list(fcs)
    out = []
    for layer in getattr(action, 'layers', []):
        for strip in layer.strips:
            for bag in getattr(strip, 'channelbags', []):
                out += list(bag.fcurves)
    return out


def _set_rate(st, f, dur):
    """The app's playbackRate (pitch follows, no correction): Blender 5.2 retimes a sound strip
    by moving its end retiming key."""
    try:
        st.pitch_correction = False
    except AttributeError:
        pass
    keys = getattr(st, 'retiming_keys', None)
    try:
        if keys is not None and len(keys) >= 2:
            keys[-1].timeline_frame = int(round(f + dur))
            return True
    except (AttributeError, TypeError, RuntimeError):
        pass
    if hasattr(st, 'pitch'):
        st.pitch = st.frame_final_duration / max(dur, 1e-6)
        return True
    return False


def build_ambience(scene=None, biome='temperate', seed=1, frame_start=None, frame_end=None, channel=1,
                   wind=True, birds=True):
    """Lay the soundscape over the scene's frame range. Returns the strips."""
    scene = scene or bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    f0 = scene.frame_start if frame_start is None else frame_start
    f1 = scene.frame_end if frame_end is None else frame_end
    ed = _seq(scene)
    strips = _strips(ed)
    made = []
    b = 'desert' if biome == 'desert' else 'temperate'
    if wind:
        path = os.path.join(audio_dir(), 'wind_%s.wav' % b)
        if os.path.isfile(path):
            snd = bpy.data.sounds.load(path, check_existing=True)
            length = max(1, int(round(snd.frame_duration if hasattr(snd, 'frame_duration') else 0)))
            f = f0
            k = 0
            while f <= f1:
                st = strips.new_sound('SeedThree wind %d' % k, path, channel, f)
                st.volume = WIND_LEVEL
                made.append(st)
                dur = st.frame_final_duration
                if k == 0:
                    _key_volume(st, [(f, 0.0001), (f + int(round(1.6 * fps)), WIND_LEVEL)])
                f += max(1, dur)
                k += 1
    if birds:
        rng = Rng('ambience:%s:%s' % (b, seed))
        kinds = BIRD_KINDS[b]
        lo, hi = INTERVAL[b]
        t = f0 / fps
        n = 0
        while True:
            t += rng.range(lo, hi)
            f = int(round(t * fps))
            if f > f1:
                break
            kind = kinds[int(math.floor(rng.next() * len(kinds)))]
            vs = variants_of(kind)
            if not vs:
                continue
            path = vs[int(math.floor(rng.next() * len(vs)))]
            st = strips.new_sound('SeedThree %s %d' % (kind, n), path, channel + 1 + (n % 3), f)
            rate = rng.range(0.96, 1.05)
            dur = st.frame_final_duration / rate
            _set_rate(st, f, dur)
            peak = rng.range(*BIRD_PEAK)
            fin = min(0.35, dur / fps * 0.3)
            fout = min(0.8, dur / fps * 0.45)
            st.pan = rng.range(-0.7, 0.7)
            st.frame_final_end = f + int(math.ceil(dur))
            env = [(f, 0.0001), (f + fin * fps, peak), (f + max(fin * fps, dur - fout * fps), peak), (f + dur, 0.0001)]
            _key_volume(st, env)
            made.append(st)
            n += 1
    return made
