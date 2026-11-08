"""Cast a shadow, receive none: the app's billboard policy, in EEVEE.

impostor.js gives its crossed billboard cards castShadow = true and receiveShadow =
false: the pair throws a canopy blob on the ground (so the hero's shadow does not
vanish at the last LOD switch) but never shadows itself (self-shadow banding across
flat crossed cards is what looks bad). The app's forest billboards do the same.

EEVEE has no per-object "receive shadows" switch. Light linking gives the same
result: the sun stops lighting the listed objects (its receiver collection excludes
them) and a shadowless twin of it lights only them. The objects still cast the sun's
shadow on everything else. The twin copies the sun's transform (a constraint) and its
energy, colour and angle (drivers), so it follows any animation of the sun.

    from seedthree.bl import cast_only
    cast_only.link([card_a, card_b], sun)      # sun = the scene's key light
    cast_only.unlink([card_a, card_b])
"""

import bpy

TWIN = 'SeedThree sun (cast-only receivers)'
TWIN_RECEIVERS = 'SeedThree cast-only receivers'
SUN_RECEIVERS = 'SeedThree sun receivers'


def _collection(name):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
    return col


def _entry(col, ob):
    """The collection's light-linking entry of `ob` (collection_objects follows col.objects'
    order; its items do not name their object)."""
    for i, o in enumerate(col.objects):
        if o == ob:
            return col.collection_objects[i]
    return None


def link_state(col, ob):
    """'INCLUDE' / 'EXCLUDE' for an object in a receiver collection, or None."""
    e = _entry(col, ob) if col is not None else None
    return e.light_linking.link_state if e is not None else None


def _set_state(col, ob, state):
    if ob.name not in col.objects:
        col.objects.link(ob)
    _entry(col, ob).light_linking.link_state = state


def twin_of(sun):
    """The shadowless twin that follows `sun` (made on first use)."""
    for ob in bpy.data.objects:
        if ob.get('seedthree_twin_of') == sun.name and ob.type == 'LIGHT':
            return ob
    data = sun.data.copy()
    data.name = TWIN
    data.use_shadow = False
    twin = bpy.data.objects.new(TWIN, data)
    twin['seedthree_twin_of'] = sun.name
    twin['seedthree_twin'] = True
    for col in sun.users_collection:
        col.objects.link(twin)
    if not twin.users_collection:
        bpy.context.scene.collection.objects.link(twin)
    c = twin.constraints.new('COPY_TRANSFORMS')
    c.target = sun
    for path, n in (('energy', 1), ('color', 3), ('angle', 1)):
        for i in range(n):
            fc = data.driver_add(path, i) if n > 1 else data.driver_add(path)
            drv = fc.driver
            drv.type = 'AVERAGE'
            v = drv.variables.new()
            v.type = 'SINGLE_PROP'
            v.targets[0].id_type = 'LIGHT'
            v.targets[0].id = sun.data
            v.targets[0].data_path = '%s[%d]' % (path, i) if n > 1 else path
    twin.light_linking.receiver_collection = _collection(TWIN_RECEIVERS)
    return twin


def link(objects, sun):
    """Make `objects` cast `sun`'s shadow without receiving it (or any shadow from it). With no
    sun yet the objects are only marked; set_sun (bl/sun.py) links them when a sun is bound."""
    for ob in objects:
        ob['seedthree_cast_only'] = sun.name if sun is not None else ''
        ob.visible_shadow = True
    if sun is None:
        return None
    twin = twin_of(sun)
    recv = sun.light_linking.receiver_collection
    if recv is None:
        recv = sun.light_linking.receiver_collection = _collection(SUN_RECEIVERS)
    tw = twin.light_linking.receiver_collection or _collection(TWIN_RECEIVERS)
    twin.light_linking.receiver_collection = tw
    for ob in objects:
        _set_state(recv, ob, 'EXCLUDE')
        _set_state(tw, ob, 'INCLUDE')
        ob.visible_shadow = True
        ob['seedthree_cast_only'] = sun.name
    return twin


def unlink(objects):
    for ob in objects:
        for col in (bpy.data.collections.get(SUN_RECEIVERS), bpy.data.collections.get(TWIN_RECEIVERS)):
            if col is not None and ob.name in col.objects:
                col.objects.unlink(ob)
        ob.pop('seedthree_cast_only', None)


def relink(sun):
    """Point every cast-only object in the file (billboard cards, forest billboards) at `sun`."""
    obs = [ob for ob in bpy.data.objects if 'seedthree_cast_only' in ob and ob.type != 'LIGHT']
    if obs and sun is not None and all(ob['seedthree_cast_only'] == sun.name for ob in obs) and \
            sun.light_linking.receiver_collection is not None:
        return obs
    if obs:
        link(obs, sun)
    return obs
