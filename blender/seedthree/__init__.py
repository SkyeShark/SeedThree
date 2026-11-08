"""SeedThree for Blender: the same procedural trees and plants as the SeedThree web
app (same species presets, seeds and dials), grown in Python and rendered with
EEVEE materials.

As a library:   from seedthree import api; api.describe(); api.create_tree(...)
As an add-on:   install the `seedthree` folder (Edit > Preferences > Add-ons >
                Install from Disk, or symlink it into your add-ons folder); the
                panel lives in the 3D View sidebar, tab "SeedThree".
"""

bl_info = {
    'name': 'SeedThree',
    'author': 'SeedThree contributors',
    'version': (0, 1, 0),
    'blender': (5, 2, 0),
    'location': 'View3D > Sidebar > SeedThree',
    'description': 'Grow SeedThree trees and plants (same presets, seeds and dials as the web app)',
    'category': 'Add Mesh',
}


def register():
    from .addon import register as _register
    _register()


def unregister():
    from .addon import unregister as _unregister
    _unregister()
