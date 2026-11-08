"""The add-on as a Blender extension, end to end, in a throwaway user folder:
validate the manifest, build the zip, install it, enable it, point its
preference at the checkout's assets, and grow a tree from the installed copy.

    python blender/tests/test_extension.py          (BLENDER=<blender.exe> to choose the build)

Nothing touches your own Blender preferences: BLENDER_USER_RESOURCES points at a
temp folder for every call.
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ADDON = os.path.normpath(os.path.join(HERE, '..', 'seedthree'))
ASSETS = os.path.normpath(os.path.join(HERE, '..', '..', 'assets'))
BLENDER = os.environ.get('BLENDER') or r'C:\Users\sdn52\Blender\blender-5.2.0-windows-x64\blender.exe'

GROW = r'''
import bpy, os, sys
mod = 'bl_ext.user_default.seedthree'
print('ENABLED', mod in bpy.context.preferences.addons)
prefs = bpy.context.preferences.addons[mod].preferences
prefs.assets_dir = sys.argv[-1]
st = bpy.context.scene.seedthree
st.species = 'apple'
st.seed = 5
st.auto_regrow = False
bpy.ops.seedthree.grow()
root = bpy.data.objects.get(st.last_root)
print('GREW', root.name if root else None, len(root.children) if root else 0)
missing = [i.name for i in bpy.data.images if i.source == 'FILE' and not i.packed_file
           and not os.path.isfile(bpy.path.abspath(i.filepath))]
print('IMAGES', len(bpy.data.images), 'MISSING', len(missing))
print('MISSING_NAMES', missing)
print('ADDON_FILE', bpy.types.SEEDTHREE_OT_grow.__module__, sys.modules[bpy.types.SEEDTHREE_OT_grow.__module__].__file__)
'''


def run(args, env):
    p = subprocess.run([BLENDER] + args, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace')
    return p.returncode, p.stdout + p.stderr


def main():
    tmp = tempfile.mkdtemp(prefix='seedthree_ext_')
    env = dict(os.environ, BLENDER_USER_RESOURCES=os.path.join(tmp, 'user'))
    fails = []

    def check(cond, msg, out=''):
        print(('PASS ' if cond else 'FAIL ') + msg)
        if not cond:
            fails.append(msg)
            print(out[-2000:])

    rc, out = run(['--factory-startup', '-c', 'extension', 'validate', ADDON], env)
    check('Success parsing TOML' in out and 'invalid' not in out, 'manifest validates', out)
    rc, out = run(['--factory-startup', '-c', 'extension', 'build', '--source-dir', ADDON, '--output-dir', tmp], env)
    zips = [f for f in os.listdir(tmp) if f.endswith('.zip')]
    check(len(zips) == 1, 'extension build wrote %s' % zips, out)
    if not zips:
        sys.exit(1)
    rc, out = run(['--factory-startup', '-c', 'extension', 'install-file', '-r', 'user_default', '-e',
                   os.path.join(tmp, zips[0])], env)
    check(rc == 0, 'install-file into the temp user folder (rc %d)' % rc, out)
    script = os.path.join(tmp, 'grow.py')
    with open(script, 'w') as fh:
        fh.write(GROW)
    rc, out = run(['--background', '--python', script, '--', ASSETS], env)
    lines = {ln.split(' ', 1)[0]: ln for ln in out.splitlines() if ln.split(' ', 1)[0] in ('ENABLED', 'GREW', 'IMAGES', 'ADDON_FILE')}
    check(lines.get('ENABLED') == 'ENABLED True', 'the installed extension is enabled', out)
    check(lines.get('GREW', '').endswith(' 3'), 'Grow from the installed copy: %s' % lines.get('GREW'), out)
    check(lines.get('IMAGES', '').endswith('MISSING 0'), 'textures resolve through the assets preference: %s' % lines.get('IMAGES'), out)
    check(os.path.join('extensions', 'user_default') in lines.get('ADDON_FILE', '').replace('/', os.sep),
          'the operator runs from the installed copy: %s' % lines.get('ADDON_FILE'), out)
    print('EXTENSION', 'FAIL %d' % len(fails) if fails else 'PASS')
    if not fails:
        shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(1 if fails else 0)


main()
