// Export a tree Group as a binary .glb download.
//
// Instanced foliage is BAKED to real merged geometry on export: per LOD level
// exactly one `<name>_leaves` mesh (multi-material groups for card variants)
// and one `<name>_branches` mesh. DCC imports stay clean — no dependence on
// EXT_mesh_gpu_instancing, whose Blender import scatters instanced cards.

import { Box3, Vector3, Group, Mesh, Matrix4, BufferAttribute, FrontSide } from 'three/webgpu';
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

// A copy of an (indexed) geometry with every triangle's winding reversed and the
// SAME vertex normals. Paired with the original it makes a single-sided card that
// shows the same outward (dome) normal from both sides — see singleSidedCards.
function reversedWinding(geo) {
  const r = geo.clone();
  const a = r.index.array.slice();
  for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
  r.setIndex(new BufferAttribute(a, 1));
  return r;
}

// Opt-in single-sided dome-card export (leaf material userData.exportSingleSided,
// set from foliage.singleSidedExport). The live shader shades both faces of a
// card with the OUTWARD canopy-dome normal, but a glTF `doubleSided` material
// makes a conformant renderer flip the normal on the back face — so half of the
// exported crown's card faces shade as if they faced into the canopy. For
// opted-in species the dome-bent card piles are written as BOTH windings with
// the same outward normals, and the leaf material is exported single-sided
// (doubleSided: false) through a per-export copy: each face carries the normal
// the app shades it with. Fruit (solid, bend 0) is kept as is. Species without
// the flag export byte-identically.
const singleSidedCards = (material) => !!material?.userData?.exportSingleSided;

// A FrontSide copy of an opted-in material, so the export never touches the
// live material. A SHALLOW copy (same prototype, same textures / nodes /
// userData references): `material.clone()` is not usable here — node
// materials drop their map/normalMap/roughnessMap on copy() and Material.copy
// JSON-round-trips userData (the transmission texture). The copy is never
// rendered and is not disposed: it shares the original's event listeners, so a
// dispose() on it would release the LIVE material's GPU resources.
function singleSidedCopy(material) {
  const copy = Object.assign(Object.create(Object.getPrototypeOf(material)), material);
  copy.side = FrontSide;
  return copy;
}

// Rebuild the LOD tree as plain groups with baked geometry: per level one
// `_branches` mesh and one `_leaves` mesh (material groups keep card variants).
function buildExportTree(lodRoot) {
  const root = new Group();
  root.name = lodRoot.name;
  root.position.copy(lodRoot.position);
  const disposables = [];
  // Opt-in pile merge (species foliage.mergeExportPiles → LOD root userData,
  // core/tree.js): GLTFExporter writes one primitive per geometry group, so the
  // instanced piles that share a material (leaf cards, accent cards and atlas
  // fruit on one leaf-atlas material; a palm's frond-card piles) are merged into
  // one group first → one primitive per material. Species without the flag keep
  // one group per pile and export exactly as before.
  const mergeByMaterial = !!lodRoot.userData?.exportMergePiles;

  for (const level of lodRoot.levels) {
    const src = level.object;
    // Mobile Performance Target adds app-only extra card LODs (LOD3/LOD4) purely
    // for in-app rendering; the export stays the standard LOD0/LOD1/LOD2/billboard
    // set (the hidden mesh LODs are the real geometry and DO export).
    if (src.userData?.appOnly) continue;
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
      // Opt-in attribute whitelist (palm frond leaves: a merged mesh whose wind /
      // SSS attributes are shader-only) — engines get position/normal/uv only.
      let geo = mesh.geometry;
      const keepAttrs = geo.userData?.exportAttributes;
      if (keepAttrs) {
        geo = geo.clone();
        for (const name of Object.keys(geo.attributes)) if (!keepAttrs.includes(name)) geo.deleteAttribute(name);
        disposables.push(geo);
      }
      const out = new Mesh(geo, mesh.material);
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
        // Fruit is SOLID geometry with real baked normals — dome-bending them
        // would shade every apple like a leaf card; export those untouched.
        if (!im.boundingSphere) im.computeBoundingSphere();
        if (!im.boundingBox) im.computeBoundingBox();
        const domeOrigin = im.boundingSphere.center.clone();
        domeOrigin.y = im.boundingBox.min.y - 0.5;
        const bend = im.name === 'fruit' ? 0 : 0.85;
        let merged = mergeGeometries(expandInstances(im, bend, domeOrigin), false);
        disposables.push(merged);
        if (bend > 0 && singleSidedCards(im.material)) {
          const back = reversedWinding(merged);
          merged = mergeGeometries([merged, back], false);
          disposables.push(back, merged);
        }
        return { geo: merged, material: im.material };
      });
      let grouped = piles;
      if (mergeByMaterial) {
        const byMat = new Map(); // material → its piles, in first-seen order
        for (const p of piles) {
          if (!byMat.has(p.material)) byMat.set(p.material, []);
          byMat.get(p.material).push(p.geo);
        }
        grouped = [...byMat.entries()].map(([material, geos]) => {
          if (geos.length === 1) return { geo: geos[0], material };
          const g = mergeGeometries(geos, false);
          disposables.push(g);
          return { geo: g, material };
        });
      }
      const geo = mergeGeometries(grouped.map((p) => p.geo), true);
      disposables.push(geo);
      const leaves = new Mesh(geo, grouped.map((p) => p.material));
      leaves.name = `${src.name}_leaves`;
      lg.add(leaves);
    }

    root.add(lg);
  }
  // Opted-in dome-card materials export single-sided via per-export copies.
  const sided = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const swap = (m) => {
      if (!singleSidedCards(m)) return m;
      if (!sided.has(m)) sided.set(m, singleSidedCopy(m));
      return sided.get(m);
    };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
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
