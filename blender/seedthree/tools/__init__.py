"""SeedThree's asset tooling (the app's scripts/ folder) in Python.

    python -m seedthree.tools derive-pbr assets/bark/oak_albedo.png --strength 2.5
    python -m seedthree.tools seamless-loop raw_wind.mp3 wind_loop.wav 3

Every script of scripts/texture and scripts/audio has a function here with the same
name in snake_case and a command with the script's own name and arguments:

    texture  derive_pbr, derive_height, derive_translucency, derive_leaf_maps,
             derive_leaf_roughness, derive_cactus_bark, derive_spine_translucency,
             derive_thatch_pbr, make_seamless, dilate_alpha, apply_alpha, chroma_key,
             denoise, check_tile, tile_preview, make_bark_guide, make_yucca_alpha
    codex    harvest_codex_image
    audio    gen_wind (Stable Audio 3 through ComfyUI), loop_wind (ffmpeg crossfade
             loop), seamless_loop (flattened envelope + equal-power wrap)

They run in system Python with numpy and Pillow (the audio ones call ffmpeg /
ffprobe from PATH). They are the tools that made assets/; the add-on uses the
assets as they are and never runs these at grow time.
"""

COMMANDS = {
    'derive-pbr': ('texture', 'cli_derive_pbr'),
    'derive-height': ('texture', 'cli_derive_height'),
    'derive-translucency': ('texture', 'cli_derive_translucency'),
    'derive-leaf-maps': ('texture', 'cli_derive_leaf_maps'),
    'derive-leaf-roughness': ('texture', 'cli_derive_leaf_roughness'),
    'derive-cactus-bark': ('texture', 'cli_derive_cactus_bark'),
    'derive-spine-translucency': ('texture', 'cli_derive_spine_translucency'),
    'derive-thatch-pbr': ('texture', 'cli_derive_thatch_pbr'),
    'make-seamless': ('texture', 'cli_make_seamless'),
    'dilate-alpha': ('texture', 'cli_dilate_alpha'),
    'apply-alpha': ('texture', 'cli_apply_alpha'),
    'chroma-key': ('texture', 'cli_chroma_key'),
    'denoise': ('texture', 'cli_denoise'),
    'check-tile': ('texture', 'cli_check_tile'),
    'tile-preview': ('texture', 'cli_tile_preview'),
    'make-bark-guide': ('texture', 'cli_make_bark_guide'),
    'make-yucca-alpha': ('texture', 'cli_make_yucca_alpha'),
    'harvest-codex-image': ('codex', 'cli_harvest_codex_image'),
    'gen-wind': ('audio', 'cli_gen_wind'),
    'loop-wind': ('audio', 'cli_loop_wind'),
    'seamless-loop': ('audio', 'cli_seamless_loop'),
}


def run(argv):
    """Run one command the way `node scripts/<kind>/<name>.mjs <args>` runs it. -> exit code."""
    import importlib
    if not argv or argv[0] not in COMMANDS:
        print('usage: python -m seedthree.tools <command> [args]\ncommands: ' + ', '.join(sorted(COMMANDS)))
        return 2
    mod, fn = COMMANDS[argv[0]]
    m = importlib.import_module('%s.%s' % (__name__, mod))
    rc = getattr(m, fn)(argv[1:])
    return 0 if rc is None else int(rc)
