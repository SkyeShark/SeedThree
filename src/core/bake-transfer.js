// Serialize a bake-source LOD group (bark mesh + instanced foliage) into plain
// transferable data for the off-thread impostor baker, and reconstruct it back
// into a three.js Group inside the worker. No THREE objects cross the postMessage
// boundary — only ArrayBuffers + ImageBitmaps (both transferable) + plain descriptors.
//
// Material KIND is inferred from the geometry's attributes so we don't have to tag
// meshes at build time:
//   aStemCenter → 'bark'      (MeshStandardNodeMaterial tube)
//   aThickness  → 'foliage'   (MeshSSSNodeMaterial leaf/cluster cards)
//   aPack       → 'rosette'   (yucca/saguaro cones, MeshSSSNodeMaterial)
//
// The worker rebuilds the ACTUAL materials (makeBarkMaterial / makeFoliageMaterial /
// makeYuccaMaterial) from transferred textures, so the impostor is WYSIWYG.

import {
  BufferGeometry, BufferAttribute, InstancedBufferAttribute, InstancedMesh, Mesh,
  Group, Texture, Vector3, Matrix4, SRGBColorSpace, LinearFilter, RepeatWrapping, ClampToEdgeWrapping,
} from 'three/webgpu';

function matKindOf(geo) {
  const a = geo.attributes;
  if (a.aSpine) return 'spine'; // cactus spine cards (also carry aStemCenter — check first)
  if (a.aStemCenter) return 'bark';
  if (a.aPack) return 'rosette';
  if (a.aThickness) return 'foliage';
  return 'bark';
}

// ---- main thread: source Group → transfer payload -------------------------
// Returns { payload, transfers }. Post as worker.postMessage(payload, transfers).
export async function serializeSource(sourceGroup, assets, center) {
  const meshes = [];
  const transfers = [];

  sourceGroup.updateWorldMatrix(true, true);
  sourceGroup.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    const instCount = o.isInstancedMesh ? o.count : 0;
    const attrs = {};
    for (const [name, attr] of Object.entries(geo.attributes)) {
      const isInst = !!attr.isInstancedBufferAttribute;
      // CAP-preallocated instanced attrs over-allocate; copy only the live instances.
      // (copy, not the live buffer, so transferring doesn't detach the running geometry)
      const len = isInst && instCount ? instCount * attr.itemSize : attr.array.length;
      const arr = attr.array.slice(0, len);
      attrs[name] = { array: arr, itemSize: attr.itemSize, instanced: isInst };
      transfers.push(arr.buffer);
    }
    let index = null;
    if (geo.index) { const arr = geo.index.array.slice(); index = { array: arr }; transfers.push(arr.buffer); }
    const m = { kind: matKindOf(geo), attrs, index, side: o.material?.side ?? 0, name: o.name || '' };
    if (o.isInstancedMesh) {
      // CAP-preallocated meshes (yucca/saguaro cones) over-allocate instanceMatrix to
      // the CAP, not the live count — send only the live instances so the worker's
      // count-sized InstancedMesh matrix matches.
      const im = o.instanceMatrix.array.slice(0, o.count * 16);
      m.instanceMatrix = im; m.count = o.count; transfers.push(im.buffer);
    }
    meshes.push(m);
  });

  // textures → ImageBitmaps (transferable). One entry per asset key we might need.
  const texKeys = ['barkTexture', 'barkNormal', 'barkRoughness',
    'leafTexture', 'leafNormal', 'leafRoughness', 'leafTranslucency',
    'leafDryTexture', 'leafDryestTexture']; // rosette materials read the leaf* keys too
  const bitmaps = {};
  for (const k of texKeys) {
    const tex = assets?.[k];
    const img = tex?.image;
    if (!img) continue;
    try {
      const bmp = await createImageBitmap(img);
      bitmaps[k] = { bitmap: bmp, colorSpace: tex.colorSpace === SRGBColorSpace ? 'srgb' : 'linear', flipY: tex.flipY };
      transfers.push(bmp);
    } catch { /* skip unbitmappable textures */ }
  }

  const payload = {
    type: 'bake', meshes, bitmaps,
    center: center ? [center.x, center.y, center.z] : [0, 0, 0],
    foliageCfg: assets?.foliageCfg ?? null,
  };
  return { payload, transfers };
}

// ---- worker: transfer payload → three.js Group ----------------------------
export function reconstructSource(payload, buildMaterialForKind) {
  const group = new Group();
  const _m = new Matrix4();
  for (const md of payload.meshes) {
    const geo = new BufferGeometry();
    for (const [name, a] of Object.entries(md.attrs)) {
      const Ctor = a.array.constructor;
      const AttrCtor = a.instanced ? InstancedBufferAttribute : BufferAttribute;
      geo.setAttribute(name, new AttrCtor(new Ctor(a.array), a.itemSize));
    }
    if (md.index) geo.setIndex(new BufferAttribute(new Uint32Array(md.index.array), 1));
    const material = buildMaterialForKind(md.kind, md.side);
    let mesh;
    if (md.instanceMatrix) {
      mesh = new InstancedMesh(geo, material, md.count);
      mesh.instanceMatrix.array.set(md.instanceMatrix.subarray(0, Math.min(md.instanceMatrix.length, md.count * 16)));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = md.count;
    } else {
      mesh = new Mesh(geo, material);
    }
    mesh.name = md.name; mesh.frustumCulled = false;
    mesh.castShadow = false; mesh.receiveShadow = false;
    group.add(mesh);
  }
  return group;
}

// worker: ImageBitmap descriptors → THREE.Textures keyed by asset name
export function bitmapsToTextures(bitmaps) {
  const out = {};
  for (const [k, d] of Object.entries(bitmaps || {})) {
    const t = new Texture(d.bitmap);
    t.colorSpace = d.colorSpace === 'srgb' ? SRGBColorSpace : 'srgb-linear';
    t.flipY = d.flipY ?? false;
    t.wrapS = t.wrapT = k.includes('bark') ? RepeatWrapping : ClampToEdgeWrapping;
    t.minFilter = LinearFilter; t.magFilter = LinearFilter;
    t.needsUpdate = true;
    out[k] = t;
  }
  return out;
}
