// Export a tree Group as a binary .glb download.
//
// Instanced foliage is BAKED to real merged geometry on export: per LOD level
// exactly one `<name>_leaves` mesh (multi-material groups for card variants)
// and one `<name>_branches` mesh. DCC imports stay clean — no dependence on
// EXT_mesh_gpu_instancing, whose Blender import scatters instanced cards.

import { Box3, Vector3, Group, Mesh, Matrix4 } from 'three/webgpu';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// GLTFExporter plugin: writes KHR_materials_diffuse_transmission (the glTF leaf/
// paper translucency extension) from material.userData.gltfDiffuseTransmission,
// since r184's exporter doesn't emit this extension natively.
class DiffuseTransmissionExtension {
  constructor(writer) { this.writer = writer; this.name = 'KHR_materials_diffuse_transmission'; }
  async writeMaterialAsync(material, materialDef) {
    const dt = material.userData && material.userData.gltfDiffuseTransmission;
    if (!dt) return;
    const ext = { diffuseTransmissionFactor: dt.factor ?? 1 };
    if (dt.color) ext.diffuseTransmissionColorFactor = dt.color;
    if (dt.map) ext.diffuseTransmissionColorTexture = { index: await this.writer.processTextureAsync(dt.map) };
    materialDef.extensions = materialDef.extensions || {};
    materialDef.extensions[this.name] = ext;
    this.writer.extensionsUsed[this.name] = true;
  }
}

// GLTFExporter plugin: MSFT_lod — the de-facto glTF LOD extension (Babylon.js,
// Windows MR, Unreal's glTF importer). glTF core has NO LOD concept, so we ship
// both conventions: `_LODn` node names (Unity-style pipelines key on these) and
// this extension, which wires those sibling nodes into a machine-readable chain
// with screen-coverage switch hints derived from the live LOD distances.
class MSFTLodExtension {
  constructor(writer, lodSource) { this.writer = writer; this.name = 'MSFT_lod'; this.lodSource = lodSource; }
  afterParse() {
    const json = this.writer.json;
    if (!json.nodes) return;
    const groups = new Map(); // base name → [{ i: node index, n: LOD rank }]
    json.nodes.forEach((node, i) => {
      const m = /^(.*)_LOD(\d+)$/.exec(node.name || '');
      if (!m) return;
      const list = groups.get(m[1]) ?? [];
      list.push({ i, n: +m[2] });
      groups.set(m[1], list);
    });
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.n - b.n);
      const base = json.nodes[list[0].i]; // extension lives on the LOD0 node
      base.extensions = base.extensions || {};
      base.extensions[this.name] = { ids: list.slice(1).map((e) => e.i) };
      const cov = this.coverages(list.length);
      if (cov) {
        base.extras = base.extras || {};
        base.extras.MSFT_screencoverage = cov; // per spec: ids.length + 1 entries
      }
      this.writer.extensionsUsed[this.name] = true;
    }
  }
  coverages(levelCount) {
    const src = this.lodSource;
    if (!src || !src.isLOD || src.levels.length < levelCount) return null;
    const height = new Box3().setFromObject(src).getSize(new Vector3()).y;
    if (!height) return null;
    // Screen coverage ≈ (projected height fraction)² at each switch distance,
    // for a 50°-vertical-fov reference camera; final entry = cull threshold.
    const covAt = (d) => Math.min(1, ((height / (2 * d * Math.tan(25 * Math.PI / 180))) ** 2));
    return [...src.levels.slice(1, levelCount).map((l) => covAt(l.distance)), 0.001];
  }
}

// One instance of an InstancedMesh's geometry, transformed, stripped to the
// attributes glTF cares about (custom per-instance attrs don't survive baking).
// `bend` > 0 bends vertex normals toward the canopy sphere around `center` —
// the exported counterpart of the live TSL dome shading (which, being a shader
// node, cannot serialize to glTF). Keeps engine imports shading like the app.
function expandInstances(im, bend = 0, center = null) {
  const geos = [];
  const m = new Matrix4();
  const p = new Vector3();
  const n = new Vector3();
  for (let i = 0; i < im.count; i++) {
    im.getMatrixAt(i, m);
    const g = im.geometry.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    g.applyMatrix4(m);
    if (bend > 0 && center) {
      const pos = g.attributes.position, nrm = g.attributes.normal;
      for (let v = 0; v < pos.count; v++) {
        // Up-biased dome (matches the live shader): never point down, or the
        // lower canopy samples dark ground ambient and goes black in engines.
        p.set(pos.getX(v), pos.getY(v), pos.getZ(v)).sub(center).normalize();
        p.y += 0.45;
        p.normalize();
        n.set(nrm.getX(v), nrm.getY(v), nrm.getZ(v)).lerp(p, bend).normalize();
        nrm.setXYZ(v, n.x, n.y, n.z);
      }
    }
    geos.push(g);
  }
  return geos;
}

// Rebuild the LOD tree as plain groups with baked geometry: per level one
// `_branches` mesh and one `_leaves` mesh (material groups keep card variants).
function buildExportTree(lodRoot) {
  const root = new Group();
  root.name = lodRoot.name;
  root.position.copy(lodRoot.position);
  const disposables = [];

  for (const level of lodRoot.levels) {
    const src = level.object;
    const lg = new Group();
    lg.name = src.name;
    lg.visible = true;

    const instanced = [];   // foliage/card InstancedMeshes → baked into _leaves
    const plain = [];       // bark cylinders (and billboard cards) → kept as real meshes
    src.traverse((o) => {
      if (!o.isMesh) return;
      (o.isInstancedMesh ? instanced : plain).push(o);
    });

    for (const [i, mesh] of plain.entries()) {
      const out = new Mesh(mesh.geometry, mesh.material);
      out.name = mesh.name || `${src.name}_branches${plain.length > 2 ? `_${i}` : ''}`;
      lg.add(out);
    }

    if (instanced.length) {
      // Merge per material first (each card variant has its own bake), then
      // merge the piles with groups → ONE mesh, one primitive per material.
      const piles = instanced.map((im) => {
        // Match the live dome shading: foliage shades (nearly) fully by the
        // canopy sphere — card orientation contributes nothing, which is what
        // kills the crossed-card light/dark disagreement in engines too.
        // Dome origin at the canopy BOTTOM (mid-canopy origins give downward
        // normals below them → black underside in engines).
        if (!im.boundingSphere) im.computeBoundingSphere();
        if (!im.boundingBox) im.computeBoundingBox();
        const domeOrigin = im.boundingSphere.center.clone();
        domeOrigin.y = im.boundingBox.min.y - 0.5;
        const merged = mergeGeometries(expandInstances(im, 0.85, domeOrigin), false);
        disposables.push(merged);
        return { geo: merged, material: im.material };
      });
      const geo = mergeGeometries(piles.map((p) => p.geo), true);
      disposables.push(geo);
      const leaves = new Mesh(geo, piles.map((p) => p.material));
      leaves.name = `${src.name}_leaves`;
      lg.add(leaves);
    }

    root.add(lg);
  }
  return { root, dispose: () => disposables.forEach((g) => g.dispose()) };
}

// Parse to a binary glTF ArrayBuffer (no download) — also used by tests/tools.
export async function exportGLB(object3d) {
  // Bake LOD trees to plain merged-mesh hierarchies; the MSFT_lod extension
  // still reads distances/coverage from the ORIGINAL live LOD object.
  const baked = object3d.isLOD ? buildExportTree(object3d) : null;
  const exporter = new GLTFExporter();
  exporter.register((writer) => new DiffuseTransmissionExtension(writer));
  exporter.register((writer) => new MSFTLodExtension(writer, object3d));
  if (baked) {
    try {
      return await exporter.parseAsync(baked.root, { binary: true, onlyVisible: false });
    } finally {
      baked.dispose();
    }
  }
  return exporter.parseAsync(object3d, {
    binary: true,
    // Include LOD-hidden levels: the tree is a THREE.LOD whose non-current
    // levels have visible=false, but the export wants the full _LOD0.._LOD3 set
    // (Unity/Unreal auto-detect the suffix convention).
    onlyVisible: false,
  });
}

export async function downloadGLB(object3d, filename) {
  const name = filename.endsWith('.glb') ? filename : `${filename}.glb`;

  // Ask for the save destination FIRST, synchronously with the user's click.
  // The export itself takes seconds, and by the time it finishes the click's
  // transient activation has expired — Chrome then treats an <a download>
  // click as an automatic download and silently blocks it after the first few.
  let handle = null;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Binary glTF', accept: { 'model/gltf-binary': ['.glb'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return 0; // user cancelled the save dialog
      handle = null; // no activation / unsupported → fall back to anchor download
    }
  }

  const result = await exportGLB(object3d);
  const blob = new Blob([result], { type: 'model/gltf-binary' });

  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return blob.size;
}
