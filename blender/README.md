# SeedThree for Blender

The SeedThree trees in Blender 5.2: the same species presets, seeds and dials as
the web app, and the rest of the app around them. The growth code is ported line
for line from `src/core/*.js` to Python. The bark, leaf, frond, spine, card and
billboard materials are EEVEE node trees, the wind is a Geometry Nodes group, a
sidebar panel carries the app's folders, and preset JSON round-trips with the app.
The app's LOD ladder comes with it: the baked branch cards, the far billboard, the
mobile ladder with its thatch bark, distance switching, the forest ring, the GLB
export with its LOD extensions, the demo scene, the example scenes and the asset
tooling of `scripts/`.

```
blender/
  seedthree/            the add-on and library (Python package)
    core/               the generators: pure Python + numpy, no bpy
                        rng, vmath (three.js-exact math), weber_penn, branch_mesh,
                        dichotomous, leaf_cards (incl. hangingSprays), willow_curtains,
                        yucca_leaves, cactus_spines, fruit, tree (the LOD ladders,
                        desktop and mobile), branch_cards (card bakes' geometry and
                        placement), forest (grove slots), terrain_noise, scatter,
                        cloud_noise, controls
    species.py          the 20 presets (camelCase keys, as in the app's JSON)
    api.py              describe / list_species / get_schema / default_controls /
                        generate / stats_of / skeleton / to_preset / from_preset /
                        save_preset / load_preset / create_tree / duplicate_tree /
                        tree_from_root / remove_tree / set_wind / set_sun / light_probe /
                        ensure_branch_cards / bake_impostor / make_forest_ring /
                        export_glb / auto_lod / preview_level / frame_camera_to_tree /
                        build_demo_scene / example
    glb.py              GLB read / write, MSFT_lod and KHR_materials_diffuse_transmission
    bl/                 the bpy code: meshes, materials, wind, sun (backlight binding),
                        probe (light probe), build, bake (the multichannel bakes),
                        cards (card sets, the billboard), cast_only (cast-but-don't-
                        receive by light linking), lod (distance switching, framing),
                        forest (the grove), export (the .glb)
    scene/              the app's demo scene (terrain + sky, decor, atmosphere,
                        ambience, demo) and its example scenes (examples)
    tools/              scripts/texture + scripts/audio (system Python: numpy, Pillow)
    addon.py            the sidebar panel and operators
    blender_manifest.toml   the extension manifest (Blender 5.2)
  tests/                parity with the JS (generators, LOD ladders and card bakes,
                        demo-scene scatter, the asset tools, the app's own unit tests),
                        preset round-trip, Blender smoke, add-on, Blender state,
                        extension install
```

## Use it

As an add-on (Blender 5.2):
1. Either link the `blender/seedthree` folder into your Blender add-ons folder
   (a symlink or junction keeps `../../assets` reachable), or build and install
   it as an extension:
   `blender -c extension build --source-dir blender/seedthree --output-dir <dir>`,
   then Edit > Preferences > Get Extensions > Install from Disk.
2. If you installed a copy, set **SeedThree assets folder** in the add-on's
   preferences (the checkout's `assets/`).
3. The panel is in the 3D View sidebar, tab **SeedThree**:
   - Species, Seed (with randomize), Level (LOD0..LOD4, All, Auto by camera), Fruit.
   - **Grow** (at the 3D cursor) and **Regrow**, with Auto regrow on dial changes.
   - Folders: Shape & Foliage, Advanced, Leaves & Bark, **Optimization / LODs**
     (Preview level, Mobile performance target, mesh quality, rosette density,
     switch distances, budgets, densities, prunes, Bake branch cards, card and
     billboard resolution; Bake billboard, Auto LOD, Frame camera),
     **Environment** (sun azimuth / elevation, scale reference, distance haze,
     parallax terrain, ambient occlusion, forest trees; Build demo scene, Forest
     ring; like the app's, these act on the scene at once: the haze swaps to the
     range fog, the terrain material swaps, the grove rebuilds), Wind, **Light**
     (Backlight sun, Backlight route: Translucent or Glow (the app), Bake light
     probe), **Camera** (auto-rotate: a keyed orbit of the scene camera around the
     last plant), **Export** (.glb, PNG), Save & Load.
   - Save writes the app's `seedthree-preset/1` file. Load reads presets from
     the app or from this panel.

As a library (in Blender):

```python
import sys; sys.path.insert(0, r'<checkout>/blender')
from seedthree import api
print(api.describe('whiteOak', 'shape'))
out = api.create_tree(species='whiteOak', seed=1737, location=(0, 0, 0),
                      controls={'trunks': 1, 'crownShape': 2, 'leafSize': 0.38})
out['object'], out['stats']['summary'], out['preset']
api.set_wind(strength=0.3)
twin = api.duplicate_tree(out, location=(20, 6, 0), rotation_z=1.2)   # linked parts
api.set_sun(sun_lamp)               # the backlight's sun (create_tree binds the strongest one by itself)
api.light_probe([out, twin])        # after lighting: bake EEVEE's occluded sky inside the crowns

# the app's LOD ladder, the grove and the export
far = api.create_tree('whiteOak', 1737, level='ALL', billboard=True)   # LOD0..2 + the billboard (bakes)
api.auto_lod(far)                   # each level in its camera-distance band (drivers)
api.frame_camera_to_tree(far)       # the app's framing + the species' lodDistanceMultipliers
grove = api.make_forest_ring(far, count=64)
api.export_glb(far, 'white_oak.glb')                       # _LODn nodes, MSFT_lod, diffuse transmission
mobile = api.create_tree('joshuaTree', 7, level='ALL', lod={'mobileTarget': True})  # + LOD3 / LOD4

# the app's scenes
demo = api.build_demo_scene('joshuaTree', seed=7, sun_az=230, sun_el=14)
ref = api.example('reference_turntable', species='paperBirch', seed=1)
```

Without Blender, `api.generate(...)` returns the plant as plain arrays (three's
Y-up frame) with the same stats as the JS `generate()`. In Blender,
`create_tree` returns `stats['boundingBox']` in Blender axes (Z up, the root's
frame) and `stats['boundingBoxWorld']`.

The asset tools run in system Python: `python -m seedthree.tools derive-pbr
assets/bark/x_albedo.png --strength 2.5` (every `scripts/texture` and
`scripts/audio` command, same arguments).

## The LOD ladder in Blender

- **LOD0** is the hero level. **LOD1** halves the triangle budget. **LOD2** keeps a
  decimated twig skeleton and replaces each terminal twig's leaves with one
  baked branch card (or a crossed pair, or the willow's bowed gravity sheets).
  The card set is baked once per design from the LOD0 tree itself (a few
  exemplar twigs, four channels: albedo, world normal, roughness, translucency)
  and reused from the file's materials afterwards.
- The **billboard** ('BB') is two crossed cards baked from LOD0, framed on the
  trunk axis like the app's off-thread baker. As in the app it casts the
  canopy's shadow and receives none: EEVEE has no per-object receive switch, so
  the key sun skips the cards (light linking) and a shadowless twin of that sun
  lights them (`bl/cast_only.py`).
- **Mobile performance target** (`lod={'mobileTarget': True}`): LOD0 and LOD1 stay
  built but parked; the card LOD2 is the near view; LOD3 / LOD4 thin the cards
  and tubes further (nested stable subsets); Joshua trees and yuccas swap their
  dead-leaf skirts for the thatch bark (`skirtToBark`) and collapse terminal
  arms into 4-way rosette cards; the saguaro sheds ribs and spines.
- `auto_lod` switches levels with drivers on the camera distance (the app's
  THREE.LOD, without its 5 % hysteresis, which needs the previous frame);
  `preview_level` forces one, numbered as the app's dropdown.
- The forest ring instances the LOD2 level near the camera and the billboard far
  away, re-binned per frame by Geometry Nodes; each near slot sways with its own
  phase.

## How close to the web app

Run the JS dumps once (`node blender/tests/golden_dump.mjs`, `golden_dump_lods.mjs`,
`golden_dump_scene.mjs`, `golden_dump_tools.mjs`, `preset_roundtrip.mjs` writes on
demand), then the Python checks:

- `python blender/tests/test_parity.py`: 15 cases, every generator, plus fruit
  through the app's own fruit path. The RNG stream is bit-identical; skeletons
  agree to 1e-14 (libm last bits); every mesh buffer is equal in float32 at all
  three LODs; triangle counts are equal. The one difference is in the welded
  dichotomous mesh: where a quad's two diagonals are mathematically equal, the
  split follows last-bit float noise in both runtimes, and the test proves every
  differing quad is such a tie.
- `python blender/tests/test_parity_lods.py`: 15 cases of the round-two ladder,
  grown by the real JS with a recording stand-in renderer. The card and
  rosette-card bakes' exemplar framings (exact), card quads and bowed willow
  sheets (3e-8 to 6e-8), per-card thickness, the desktop card LOD2 and the mobile
  LOD3 / LOD4 placements (instance matrices to 1e-6), the willow, guide, rosette,
  cactus and shrub mobile ladders, and the hangingSprays foliage mode.
- `python blender/tests/test_parity_scene.py`: the demo scene's terrain sampler
  (1e-12), rocks and scree, fallen limbs, grass, desert scrub, the cattail clump,
  cloud placements and the cloud noise texture (byte-identical) and the forest
  slots.
- `python blender/tests/test_tools.py`: every `scripts/` command run by the app
  and by the port on the same inputs (37 checks). Every derivation is
  bit-identical, the libvips blur included (its fixed-point kernel and alpha
  premultiplication reproduced); outputs that pass through a resize differ by at
  most 2 levels; the audio loops are sample-identical; the gen-wind graph equals
  the script's own.
- `python blender/tests/test_js_suite.py`: the app's own unit tests for this
  port's systems (lod-estimator, mobile-lod-ramp, shrub-fruit, the willow sheet
  and dogwood tests of additional-species), asserted with the JS's numbers.
- `python blender/tests/test_preset_roundtrip.py`: presets saved here open with
  the app's `fromPreset` and grow identical trees; the app re-saves them
  unchanged; `to_preset` equals the JS `toPreset` on every golden case.

The Blender tier has its own checks (`blender --background --factory-startup --python <test>`):
- `smoke_build.py`: all 20 species build, every texture resolves, the wind deforms.
- `test_addon.py`: the panel's dials, Grow / Regrow / Auto regrow, Save / Load,
  the Light folder, the mobile ladder, Preview level, Auto LOD, Frame camera,
  Export .glb, the forest ring and the live Environment / Camera toggles (Forest
  trees, Ambient occlusion, Auto-rotate, Parallax terrain).
- `test_blender_state.py`: fruit regrows after File > New and after a purge;
  the sun binding follows its lamp (Euler, quaternion, parented) and rebinds,
  with its Bound flag and Irradiance (colour x strength) outputs;
  the backlight shares the diffuse's normal on a Thickness-0 card; the light
  probe fit; Z-up bounding boxes; `duplicate_tree`; `save_preset` to a folder;
  the cactus noise settings.
- `python blender/tests/test_extension.py`: validates the manifest, builds the
  extension, installs and enables it in a throwaway user folder, and grows a
  tree from the installed copy.
- The bakes, the billboard, the forest, the export, the demo scene and the
  example scenes render on the GPU: eidoverse's `blender/tests/trees2/`.

## Fixes over the JS

These are reported here for SeedThree main.

- (a) The spray shrubs (creosote, blackbrush, sagebrush) are described,
  schematized and skeletonized as dichotomous species. The JS shows them the
  Weber-Penn dials.
- (b) The material folder works: tints, colorize, alpha, flat bark, frond
  stages, spine tint and bark damage reach the materials. The JS applies them
  only inside the app.
- (c) Orchard fruit is grown. The JS headless API never loads the GLBs.
- (d) The trunk base keeps its `plantSink` (`create_tree` offsets the parts).
- (e) The canopy dome normal is in object space, so a tree off the origin
  shades evenly.
- (f) The proxy GLB export picks the bark material by what the mesh is, not by
  its name: the JS bark mesh has no name, so the headless export painted the
  bark leaf green. Here it exports brown.
- (g) The bakes' normal channel holds the raw geometric normal, as impostor.js
  says it does ("no face flip"). three r184's `normalWorld` is face-flipped on a
  DoubleSide material, so the app's front card bakes normals tilted toward the
  front camera and the side card toward the side camera, and the crossed pair
  lights differently on either side of the crossing (a seam). The billboard bake
  turns the normals of thin cut-out parts (leaves, fronds, spines) away from the
  plant's centre: their raw sign is only the generator's winding, and the Joshua
  tree's leaned toward the card's back, so its billboard lit up under a sun
  behind it. Outward, the leaves seen by a bake camera lean toward it, as the
  app's do, and the two cards still agree where they cross.
- (h) The billboard's ambient scatter uses the plant's own transmit colour and
  scatter floor for the rosette species too: the Joshua tree's and yuccas' fronds
  (0.10, 0.13, 0.03), the saguaro's spines (0.86, 0.78, 0.42), both at 0.03. The
  app passes `species.foliage?.transmit`, which those species lack, so their
  billboards took the broadleaf green (0.42, 0.62, 0.24) at the leaves' 0.16:
  the blackbrush report's bug, still open for them.
- (i) The billboard's baked normal detail turns with the card (a rotated plant, a
  grove slot's yaw) and is mirrored across the card on its back face; the app
  uses it unturned, in the plant's own frame, from either side.
- (j) The parallax terrain (SPOM) marches relief that looks like the ground.
  The app's `_height.png` maps are streaky texel-scale noise that does not
  follow the stones, slabs and cracks of their own albedo and normal maps (the
  gravel floor's has no pebbles in it at all), marched 0.035 rock tiles deep
  (25 cm) x the layer's push. Seen from eye height that is a bed of needles,
  the app's march as well as this one: reading the heights at LOD 0 as the JS
  does, or the layers without mips, leaves it unchanged. Ground seen from
  standing height (desert pavement in the Mojave and Death Valley, caliche,
  scree) is a nearly flat bed of stones a few centimetres proud. So
  `heights='normals'` (the default) integrates each layer's own normal map into
  its relief (Frankot-Chellappa: periodic, so the tile stays seamless),
  band-passed (the mesh carries shapes over ~0.3 m, the normal map the grain
  under ~3 cm), as deep as those slopes describe x 2 (1.8-4.8 cm). Six of the
  eleven ground normal maps integrate only as DirectX maps (green down:
  residual 0.05-0.06 against 0.64-0.70 as OpenGL); this material reads those six
  with their green flipped so shading and relief agree (the inline material and
  the app read all as OpenGL). The desert floor keeps its own 4 m tile, as with
  SPOM off (the app's march reads it at the 7.27 m rock tile, so its stones grow
  1.8x when the toggle goes on). `heights='app'` keeps the app's maps, depths,
  pushes and floor tile. The softer look of the temperate rock with SPOM on is
  the v2 material's per-layer roughness maps (rock3 / rock5 0.88-0.90 where the
  inline material uses rock's 0.42 for every variant), as in the app; the
  albedo itself is as sharp (mean |Laplacian| 0.022 against 0.021 off).
- The spines dial no longer mutates the shared species preset.

## Blender-specific notes

- Axes: generation runs in three's Y-up frame. Conversion to Blender
  (x, -z, y) happens once, in `bl/meshes.py`.
- Instanced parts are realized into one mesh per part: leaf cards, cones,
  branch cards and fruit. Per-instance data is stored as POINT attributes
  (`st_wind`, `st_anchor`, `st_thickness`, `st_dome`, `st_age`, `st_fx/fy/fz`,
  `st_fphase`), read by the wind group and the materials.
- Wind: one shared node group, "SeedThree Wind", carries the JS sway and
  flutter formulas. Strength and speed are Value nodes in it. It is a real
  deformation, so the Vector pass and motion blur see it. The forest ring runs
  the same group on its realized near slots with a per-slot phase anchor.
- The bakes render the exemplar content (twig + LOD0 leaves + fruit, or the
  plant's LOD0 for the billboard) in a temporary EEVEE scene through orthographic
  cameras, one render per channel per view, with each material swapped for a
  capture copy that emits one channel through the "SeedThree Bake Channel" group
  and keeps its alpha cutout. Float EXR readback, sRGB for the albedo, the app's
  10-12 pass edge dilation, packed 8-bit images: a saved .blend renders on its
  own. The albedo is the base colour exactly (the app's flat-white hemisphere
  gives 3/pi of it); the render is antialiased; edges are un-premultiplied
  before dilation.
- The JS caps rosette cones at 1024 per cone type (a WebGPU buffer size). The
  cap is kept, for parity.
- Backlight (`bl/sun.py`, `bl/materials.py`): the JS's Barré-Brisebois term for
  leaves, fronds, spines and cards, with each JS material's constants. The
  view-dependent factor k is computed in the node tree against the sun lamp
  bound to one shared group ("SeedThree Sun"). `api.set_backlight(mode)` picks
  the route for plants grown from then on (the add-on: Light > Backlight):
  - `'glow'` (opt-in) is the JS term itself, k × thicknessColor × E ×
    shadow, with no Lambert factor: the crown glows to its silhouette, and
    front-lit leaves carry the ambient scatter. It is a heavy shader (each
    Shader-to-RGB read inlines EEVEE's light loop): in a 12 GB memory-capped
    Blender holding the whole demo scene the GPU driver ran out of memory
    linking the leaf and card shaders (leaves missing, cards magenta), so it
    is not the default; check the first render of a glow shot. The group "SeedThree Sun
    Direct" reads E × shadow / π through Shader to RGB of four white
    Translucent BSDFs: one facing the sun, three the sun cannot reach. EEVEE's
    diffuse world and probe light is an L1 spherical harmonic (affine in the
    normal), so those three give the sun-facing read's world part exactly and
    it is subtracted; the glow joins the leaf as emission, so no second
    diffuse-type closure competes with the leaf's own. The Translucent reads
    are shadowed from the sun's side of the card, so a card lit from behind
    does not shadow itself (a Diffuse BSDF read facing the sun would). Other
    lamps also reach the reads, weighted by their angle to the sun.
  - `'translucent'` (the default) feeds a Translucent BSDF on the material's own shading
    normal, on a card whose Thickness is linked to 0. EEVEE then answers
    k × thicknessColor × E × max(0, −N·L) × shadow: the JS term times the
    leaf's Lambert factor.
  - Every leaf, card, frond and spine part carries the app's shadow
    `normalBias` (0.04 m) as EEVEE's per-object shadow terminator offset, with a
    geometry offset far above 1 so it applies at every angle
    (`materials.shadow_bias`). EEVEE's own bias puts the shadow lookup of a
    card lit from behind at a grazing angle on the card's dark side; the offset
    moves it toward the sun along the closure's light normal and gives part of
    that light back (numbers under Not yet ported).
  Measured in EEVEE 5.2 on the way there (eidoverse's
  `blender/tests/trees2/glow_silhouette.py` and `blender/tests/trees/backlight_check.py`):
  - A Translucent BSDF on a different normal from the diffuse (−L would have
    made the response orientation-free like the JS) makes EEVEE drop the
    Principled diffuse: the sunlit side goes black.
  - An unlinked Thickness makes EEVEE take about the object's size as the
    slab: a canopy never shadows its own transmission, and the colour acts
    twice (colour²).
  - At Thickness 0, a card lit from behind more than ~45° off its normal is
    self-shadowed: EEVEE's transmission bias (`reflect(Ng, L)`) points to the
    card's dark side there. No shadow filter, ray count or resolution removes
    it; the object's terminator offset does once its geometry offset is above 1
    (EEVEE scales it by `saturate(1 − N·L / geometry_offset)`, so at the default
    0.1 it never reaches a light-facing normal).
  - EEVEE lights the closure with the world too, unoccluded unless a Light
    Probe Volume is baked: `light_probe()` (`bl/probe.py`), about 2 s per tree.
- The saguaro damage mask is the JS's `mx_fractal_noise_float` exactly: Blender's
  Perlin is MaterialX's (same hash, gradients, fade and 0.982 scale), so the raw
  fBm Noise Texture (Normalize off) at the position in three's axes gives the
  JS values.
- The fruit GLB is imported once per file. Its material is checked alive on every
  use, so a new file, a purge or a deleted material re-imports it.
- The app's 4096² shadow frustum ends at 74 m, so its grove cards fade in an
  analytic sun occlusion beyond it; EEVEE's shadows reach every distance, so the
  grove here is shadowed for real.
- The billboard has no specular. Its smooth dome normal catches a sun behind the
  tree as one grazing glint over the whole card, and the card receives no
  shadow, so nothing dims it: on the white oak from 75 m under a 25° sun behind
  it, the specular was 85 % of the billboard's light and the grove rendered
  white, 5.2 × the tree's own luminance in linear light, 2.4 × on screen (the
  tree's leaves glint one by one and mostly shadow each other). The app keeps
  the same GGX lobe on the same normal.
  The billboard's ambient scatter follows the plant's backlight route, so the
  switch keeps the leaves' brightness: a Translucent BSDF on the card's normal in
  the default route (as the leaves have it), the JS term exactly (the bound sun's
  unshadowed light, the 'SeedThree Sun' group's Irradiance, as emission) in the
  glow route. eidoverse's `blender/tests/trees2/billboard_light_match.py`
  measures the billboard against LOD0 under a sun in front, beside and behind.
- The demo scene's tone map: three's `ACESFilmicToneMapping` scales by
  exposure / 0.6 before its curve; AgX with the 'High Contrast' look at
  log2(exposure) + 0.23 stops gives the same display values on a neutral ramp
  (mean difference 0.008, measured through Blender's OCIO against three r184's
  formula at exposures 1.3, 1.05 and 1.0; `scene/tonemap.py`). AgX's base look at
  log2(exposure) rendered the app's mid-tones darker and its shadows lifted.
- The app's sun colour is `Color.setHSL`, which in three r184 takes its values in
  the linear working space: the HSL triple is the linear colour (no sRGB decode).
- The demo scene's ring haze is a compositor pass over the Position pass. The
  film renders transparent and the sky returns from the Environment pass, so
  the haze weighs only the geometry's share of a pixel (its alpha). Each pixel
  takes the factor of its own position, as the app fogs per fragment; only
  edge pixels with no position of their own (the Position pass is not
  antialiased: the image blends the hazed terrain rim into the sky while the
  pass holds the sky's empty position) take their 2 px neighbourhood's factor,
  so neither a dark rim line nor haze-coloured blocks on leaves in front of far
  hills appear. With the haze off (the app's Distance fog toggle, and while a
  preview level is forced) the pass falls back to the app's classic range fog,
  `smoothstep(near, far, view depth)` toward the sky's fog colour (95-300 m,
  desert 55-230 m), from the Depth pass; `set_fog_on(scene, False)` drops both.
  The demo's sky needs its compositor. The parallax terrain (SPOM, `scene/spom.py`) is the app's
  optional toggle, unrolled into shader nodes (48 march steps, 12 shadow
  steps); what it marches is fix (j) above.
- The demo's volumetric clouds are Geometry Nodes volumes (`scene/atmosphere.py`):
  the app's 72³ noise as the grid `density`, its relief term
  `tex(p - 0.01) - tex(p + 0.01)` precomputed per voxel as the grid `shade`, and
  an emission + absorption Principled Volume carried by a Set Material node in
  each cloud's group (EEVEE 5.2 ignores a mesh object's own material slot for a
  Geometry Nodes volume and draws it with the default grey shader). Two EEVEE
  rules set their strength. A Geometry Nodes volume is an OBJECT-space volume,
  whose coefficients EEVEE divides by |M n| (n the normalized diagonal; 82 for
  a 105 x 90 x 33 m cloud): the shader works per unit of box length and puts
  back three's step rate along the view ray, max_i(|u_i| / scale_i). And the
  Principled Volume multiplies its absorption, not its emission, by the grid
  in its Density Attribute (`density` by default), so that field is cleared.
  Against the app's march run on the CPU over the same sky
  (`blender/tests/trees2/cloud_probe.py` in eidoverse), one cloud close up adds
  0.21 over the sky where the app's adds 0.18, and 0.28 against 0.25 seen from
  the plant; before those two rules it added 0.012 and the clouds read as faint
  smudges. Thin wisps stay a little brighter: three's transparent blend
  multiplies the premultiplied march by its alpha once more.
- The soundscape's wind bed strip carries √2: Blender pans a mono strip
  equal-power (−3 dB per channel at the centre), the app's unpanned bed plays
  at full level on both channels. The birds' exponential fades are keyed on
  every frame.

## Not yet ported

- The app's backlight look by default: the default route keeps the leaf's
  Lambert factor; the app's own term is the opt-in `'glow'` route (see the
  backlight notes: its shader failed to link once under a memory cap).
- A card lit from behind more than ~45° off its normal keeps only part of its
  backlight in either route. With the app's normalBias (0.04 m) and 2 shadow
  rays / 8 steps, 54° off keeps 96 % (translucent) / 71 % (glow), 72° off
  14 % / 0 %, 85° off 24 % / 76 %; 0.1 m keeps more but flattens close-up
  leaf-on-leaf shadows. In the glow route the shadow read is pushed along the
  sun's direction, nearly parallel to such a card.
- The GitHub fallback when no checkout is found (eidoverse's JS bridge imports
  the API from GitHub; the Blender edition needs a local checkout of this
  branch).
