"""Reproducible Blender source generation, retopology and PBR bake.

Blender 5.x: blender -b --python scripts/bake_shrub_fruit.py -- bilberry
Names: bilberry, juniper, raspberry. Metres, Z-up in Blender, Y-up in GLB.
These are authored procedural sources, not Tripo/Orrery outputs.
"""
import bpy, math, random, sys, pathlib, json
from mathutils import Vector

kind = sys.argv[sys.argv.index('--')+1]
random.seed(719)
root = pathlib.Path(__file__).resolve().parents[1]
out = root / 'assets' / 'fruits'
out.mkdir(parents=True, exist_ok=True)
name = {'bilberry':'bilberry_berry','juniper':'juniper_berry','raspberry':'raspberry_cluster'}[kind]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.render.bake.use_selected_to_active = True
scene.render.bake.cage_extrusion = .001
scene.render.bake.max_ray_distance = .004
scene.render.bake.margin = 8
scene.render.bake.use_pass_direct = False
scene.render.bake.use_pass_indirect = False
scene.render.bake.use_pass_color = True

def material(label, dark, light, rough):
    m=bpy.data.materials.new(label); m.use_nodes=True
    n=m.node_tree.nodes; l=m.node_tree.links; bs=n.get('Principled BSDF')
    noise=n.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value=17
    noise.inputs['Detail'].default_value=3
    ramp=n.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color=(*dark,1)
    ramp.color_ramp.elements[1].color=(*light,1)
    l.new(noise.outputs['Fac'],ramp.inputs[0]); l.new(ramp.outputs[0],bs.inputs['Base Color'])
    bs.inputs['Roughness'].default_value=rough
    fine=n.new('ShaderNodeTexNoise'); fine.inputs['Scale'].default_value=160
    bump=n.new('ShaderNodeBump'); bump.inputs['Strength'].default_value=.13
    bump.inputs['Distance'].default_value=.000045
    l.new(fine.outputs['Fac'],bump.inputs['Height']); l.new(bump.outputs['Normal'],bs.inputs['Normal'])
    return m

skin = material('ripe skin', *({'bilberry':((.012,.016,.05),(.085,.095,.19)),
    'juniper':((.05,.08,.12),(.22,.28,.32)),
    'raspberry':((.17,.003,.009),(.64,.025,.032))}[kind]), .72 if kind!='raspberry' else .5)
green=material('living pedicel',(.055,.11,.014),(.20,.27,.055),.83)
calyx=material('calyx',(.012,.009,.02),(.11,.07,.07),.87)
parts=[]
def sphere(center, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=40, ring_count=24, location=center)
    o=bpy.context.object; o.scale=scale; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(mat)
    for p in o.data.polygons: p.use_smooth=True
    parts.append(o); return o

def stalk(points, radius):
    c=bpy.data.curves.new('curved pedicel','CURVE'); c.dimensions='3D'
    c.resolution_u=8; c.bevel_depth=radius; c.bevel_resolution=3
    s=c.splines.new('BEZIER'); s.bezier_points.add(len(points)-1)
    for p,co in zip(s.bezier_points,points):
        p.co=co; p.handle_left_type='AUTO'; p.handle_right_type='AUTO'
    o=bpy.data.objects.new('pedicel',c); scene.collection.objects.link(o)
    c.materials.append(green)
    bpy.context.view_layer.objects.active=o; o.select_set(True)
    bpy.ops.object.convert(target='MESH'); parts.append(bpy.context.object)

def sepal(angle, z, radius, length, mat):
    # A thin bowed blade: no faceted cone sprouting from a cylinder.
    vs=[]; faces=[]
    for i in range(9):
        t=i/8; r=radius+length*t; w=.0014*math.sin(math.pi*t)
        for side in [-1,1]:
            vs.append((r*math.cos(angle)-side*w*math.sin(angle),
                r*math.sin(angle)+side*w*math.cos(angle),z-.002*t+.001*math.sin(math.pi*t)))
        if i<8: j=i*2; faces.append((j,j+1,j+3,j+2))
    me=bpy.data.meshes.new('sepal'); me.from_pydata(vs,[],faces); me.update()
    o=bpy.data.objects.new('sepal',me); scene.collection.objects.link(o); me.materials.append(mat)
    for p in me.polygons:p.use_smooth=True
    parts.append(o)

if kind=='raspberry':
    # Rounded aggregate fruit, widest above its rounded lower end. Staggered
    # drupelets overlap; the central receptacle fills the unpicked berry.
    sphere((0,0,0),(.0064,.0064,.008),skin)
    for row,(z,r,n) in enumerate([(-.007,.003,6),(-.0045,.0058,10),(-.001,.0071,13),(.0026,.0073,13),(.0055,.0059,10)]):
        for j in range(n):
            a=2*math.pi*(j+(row%2)*.5)/n
            jitter=random.uniform(.91,1.09)
            sphere((r*math.cos(a),r*math.sin(a),z+random.uniform(-.0004,.0004)),
                (.00205*jitter,.00205*jitter,.0023*jitter),skin)
    # Union only the fruit flesh. Keep the pedicel and calyx as independent
    # green source surfaces so voxel material assignment cannot turn them red.
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:o.select_set(True)
    bpy.context.view_layer.objects.active=parts[0]; bpy.ops.object.join()
    body=bpy.context.object
    remesh=body.modifiers.new('aggregate sculpt union','REMESH')
    remesh.mode='VOXEL'; remesh.voxel_size=.00018; remesh.use_smooth_shade=True
    remesh.use_remove_disconnected=False
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth=body.modifiers.new('soft drupelet junctions','SMOOTH')
    smooth.factor=.4; smooth.iterations=3
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    parts=[body]
    stalk([(0,0,.0065),(.0015,0,.010),(.0005,.0007,.014),(0,0,.017)],.00055)
    for j in range(5):sepal(j*2*math.pi/5,.0075,.0014,.005,green)
    target=3200
else:
    r=.005 if kind=='bilberry' else .004
    sphere((0,0,0),(r,r,r*.92),skin)
    # Bilberry's persistent five-toothed crown faces down when hanging;
    # juniper's three sutures are short and subdued on its glaucous cone.
    count=5 if kind=='bilberry' else 3
    for j in range(count):
        a=j*2*math.pi/count
        sphere((r*.36*math.cos(a),r*.36*math.sin(a),-r*.85),
            (.00075,.00075,.0005),calyx if kind=='bilberry' else skin)
    stalk([(0,0,r*.75),(.0007,0,r+.002),(.001,.0002,r+.004),(0,0,r+.006)],.0003)
    target=480

bpy.ops.object.select_all(action='DESELECT')
for o in parts:o.select_set(True)
bpy.context.view_layer.objects.active=parts[0]
bpy.ops.object.join(); high=bpy.context.object; high.name=name+'_source'
bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
low=high.copy(); low.data=high.data.copy(); scene.collection.objects.link(low)
low.name=name
bpy.context.view_layer.objects.active=low
bpy.ops.object.select_all(action='DESELECT'); low.select_set(True)
dec=low.modifiers.new('retopology budget','DECIMATE')
dec.ratio=min(1,target/(sum(len(p.vertices)-2 for p in low.data.polygons)))
bpy.ops.object.modifier_apply(modifier=dec.name)
low.data.validate(clean_customdata=False); low.data.update()
for p in low.data.polygons:p.use_smooth=True
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=1.1,island_margin=.015)
bpy.ops.object.mode_set(mode='OBJECT')
low.data.materials.clear()
result=bpy.data.materials.new(name+'_baked_PBR'); result.use_nodes=True
low.data.materials.append(result)
n=result.node_tree.nodes; l=result.node_tree.links; bs=n.get('Principled BSDF')
images={}
for label,bake_type in [('base_color','DIFFUSE'),('normal','NORMAL'),('roughness','ROUGHNESS')]:
    im=bpy.data.images.new(name+'_'+label,512,512)
    if label!='base_color':im.colorspace_settings.name='Non-Color'
    tex=n.new('ShaderNodeTexImage'); tex.image=im; n.active=tex
    bpy.ops.object.select_all(action='DESELECT'); high.select_set(True); low.select_set(True)
    bpy.context.view_layer.objects.active=low
    bpy.ops.object.bake(type=bake_type)
    im.pack(); images[label]=(im,tex)
    if label=='base_color':l.new(tex.outputs['Color'],bs.inputs['Base Color'])
    elif label=='roughness':l.new(tex.outputs['Color'],bs.inputs['Roughness'])
    else:
        normal=n.new('ShaderNodeNormalMap'); l.new(tex.outputs['Color'],normal.inputs['Color'])
        l.new(normal.outputs['Normal'],bs.inputs['Normal'])
bs.inputs['Metallic'].default_value=0
bpy.ops.object.select_all(action='DESELECT'); low.select_set(True)
bpy.context.view_layer.objects.active=low
bpy.ops.export_scene.gltf(filepath=str(out/(name+'.glb')),export_format='GLB',use_selection=True,
    export_normals=True,export_texcoords=True,export_yup=True)
high.hide_render=True; high.hide_set(True)
# The regenerating script is the editable source; avoid shipping a bulky .blend.
report={'asset':name,'source':'authored procedural Blender source; decimated retopology; Cycles bake',
    'triangles':sum(len(p.vertices)-2 for p in low.data.polygons),
    'dimensionsMeters':list(low.dimensions),'maps':list(images),'mapSize':512}
(out/(name+'.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
