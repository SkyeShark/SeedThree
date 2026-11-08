"""The SeedThree app's demo scene in Blender: terrain and sky (terrain), rocks, limbs,
grass, scrub and ground cover (decor), clouds and haze (atmosphere), the soundscape
(ambience), and build_demo_scene (demo) that puts them together around a plant; the
app's two example scenes (examples: the eidoverse reference turntable and the
eidoverse example scene)."""

from .demo import build_demo_scene, scale_reference, orbit_camera  # noqa: F401
from .examples import EXAMPLES, reference_turntable, example_scene  # noqa: F401
