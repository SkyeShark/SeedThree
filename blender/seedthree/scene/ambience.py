"""The app's ambient soundscape (src/audio/ambience.js) as keyed sequencer sound strips.

The app plays a whisper-quiet looping wind bed per biome (wind_<biome>.wav at 0.01,
faded in linearly over 1.6 s under the master gain's 0.35 s approach) and, every
6-18 s (temperate: crow, mallard) or 8-24 s (desert: roadrunner, cactus wren), one
bird call: a random variant, playback rate 0.96-1.05, peak 0.06-0.14, an exponential
0.35 s (or 30%) fade in and 0.8 s (or 45%) fade out from and to 0.0001, panned
+-0.7. Here the same schedule is laid out over the shot's frame range as sound strips
with keyed volume envelopes (the ramps keyed on every frame), from a seeded RNG
instead of Math.random, so the audio renders with the film and repeats run to run.

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
FLOOR = 0.0001        # the JS ramps start from and end at 0.0001 (exponential ramps cannot reach 0)
WIND_FADE = 1.6       # s, linearRampToValueAtTime
MASTER_TAU = 0.35     # s, master.gain.setTargetAtTime(1, now, 0.35) at enable
# The app's wind bed is a mono buffer with no panner: Web Audio up-mixes it to both channels
# at full level. Blender pans a mono strip equal-power (-3 dB per channel at the centre), as
# the app's StereoPannerNode does for the birds, so the bed's strip volume carries sqrt(2)
# (measured in eidoverse's blender/tests/trees2/ambience_mixdown.py).
BED_GAIN = math.sqrt(2.0)


def bird_envelope(f, dur, fps, peak):
    """[(frame, gain)] of one call (ambience.js playBird): exponential ramp FLOOR -> peak over
    fin, hold, exponential ramp peak -> FLOOR ending at the call's end; one key per frame on
    the ramps (dur in frames)."""
    fin = min(0.35, dur / fps * 0.3) * fps
    fout_start = max(fin, dur - min(0.8, dur / fps * 0.45) * fps)
    keys = []
    n = max(1, int(math.ceil(fin)))
    for i in range(n + 1):
        t = fin * i / n
        keys.append((f + t, FLOOR * (peak / FLOOR) ** (t / fin if fin > 0 else 1.0)))
    span = dur - fout_start
    n = max(1, int(math.ceil(span)))
    for i in range(n + 1):
        t = span * i / n
        keys.append((f + fout_start + t, peak * (FLOOR / peak) ** (t / span if span > 0 else 1.0)))
    return keys


def wind_envelope(f, fps, level=WIND_LEVEL):
    """[(frame, gain)] of the bed's start: the linear 1.6 s fade from FLOOR x the master's
    exponential approach to 1 (time constant 0.35 s), one key per frame until the master
    is within 0.1% of 1 (7 time constants), then the level itself."""
    n = int(math.ceil(max(WIND_FADE, 7 * MASTER_TAU) * fps))
    keys = []
    for i in range(n):
        t = i / fps
        bed = FLOOR + (level - FLOOR) * min(1.0, t / WIND_FADE)
        keys.append((f + i, bed * (1.0 - math.exp(-t / MASTER_TAU))))
    keys.append((f + n, level))
    return keys


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
            f = f0
            k = 0
            while f <= f1:   # the looping bed: copies end to end (the WAV loops gaplessly)
                st = strips.new_sound('SeedThree wind %d' % k, path, channel, f)
                st.volume = WIND_LEVEL * BED_GAIN
                made.append(st)
                dur = st.frame_final_duration
                if k == 0:
                    _key_volume(st, [(fr, v * BED_GAIN) for fr, v in wind_envelope(f, fps)])
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
            _key_volume(st, bird_envelope(f, dur, fps, peak))
            st['st_call'] = {'kind': kind, 'file': os.path.basename(path), 'rate': rate, 'peak': peak,
                             'fin_s': fin, 'fout_s': fout, 'dur_frames': dur}
            made.append(st)
            n += 1
    return made
