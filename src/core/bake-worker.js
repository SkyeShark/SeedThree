// Off-main-thread impostor baker. Runs on its OWN thread with its OWN WebGPU
// device/queue (via an OffscreenCanvas), so baking the far-LOD billboard never
// stalls the queue that draws the viewer — the UX stays smooth while a fresh,
// full-resolution (WYSIWYG) impostor is baked for the current plant.
//
// Protocol (main ↔ worker):
//   main → { type:'init', canvas: OffscreenCanvas }
//   worker → { type:'ready', backend }
//   main → { type:'bake', id, size, meshes, bitmaps, center, foliageCfg }  (serializeSource)
//   worker → { type:'baked', id, baked:{front,side}, center, halfW, halfH }  (raw pixel arrays)
//   worker → { type:'error', id, where, message }

import { WebGPURenderer, Vector3, Box3, OrthographicCamera } from 'three/webgpu';
import { reconstructSource, bitmapsToTextures } from './bake-transfer.js';
import { bakeGroupToTextures } from './impostor.js';
import { makeBarkMaterial } from './tree.js';
import { makeFoliageMaterial } from './leaf-cards.js';
import { makeYuccaMaterial } from './yucca-leaves.js';
import { makeSpineMaterial } from './cactus-spines.js';

let renderer = null;

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      renderer = new WebGPURenderer({ canvas: msg.canvas, antialias: false });
      await renderer.init();
      self.postMessage({ type: 'ready', backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'other' });
      return;
    }

    if (msg.type === 'bake') {
      if (!renderer) throw new Error('renderer not initialised');
      const assets = bitmapsToTextures(msg.bitmaps);
      const center = new Vector3(msg.center[0], msg.center[1], msg.center[2]);
      const cfg = msg.foliageCfg || {};

      // Rebuild the ACTUAL materials from the transferred textures so the impostor
      // is WYSIWYG with what the viewer draws.
      const buildMat = (kind /*, side */) => {
        if (kind === 'bark') return makeBarkMaterial(assets);
        if (kind === 'spine') return makeSpineMaterial(assets);
        if (kind === 'rosette') return makeYuccaMaterial(assets);
        const built = makeFoliageMaterial(assets, { ...cfg, mode: 'clusters' });
        if (built.centerUniform) built.centerUniform.value.copy(center);
        return built.material;
      };
      const group = reconstructSource(msg, buildMat);

      // Fit an ortho front + side view CENTERED ON THE TRUNK AXIS (x=0,z=0 — plants grow
      // from their origin), NOT the bounding-box center. An asymmetric crown (Joshua
      // arms) shifts the box center off the trunk, which drew the trunk off-center in
      // each card so the two crossed cards' trunks didn't meet at the intersection. With
      // the axis centered, the trunk is dead-center in both views → they align.
      const box = new Box3().setFromObject(group);
      const bc = box.getCenter(new Vector3());
      const c = new Vector3(0, bc.y, 0);
      const halfW = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * 1.03;
      const halfH = ((box.max.y - box.min.y) / 2) * 1.03;
      const depth = halfW * 2 + 5;
      const views = [];
      for (const [name, dir] of [['front', new Vector3(0, 0, 1)], ['side', new Vector3(1, 0, 0)]]) {
        const cam = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, depth * 2);
        cam.position.copy(c).addScaledVector(dir, depth);
        cam.lookAt(c);
        views.push({ name, camera: cam });
      }

      const baked = await bakeGroupToTextures(renderer, group, views, { size: msg.size ?? 1024, dilate: 12, rawPixels: true });

      // Transfer the pixel buffers back (zero-copy).
      const transfers = [];
      for (const v of ['front', 'side']) for (const ch of ['albedo', 'normal', 'rough', 'trans']) transfers.push(baked[v][ch].data.buffer);
      self.postMessage({ type: 'baked', id: msg.id, baked, center: [c.x, c.y, c.z], halfW, halfH }, transfers);

      // tidy: bakeGroupToTextures already removed its scene root; drop the group + textures
      group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose?.(); } });
      for (const t of Object.values(assets)) t.dispose?.();
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, where: msg.type, message: String((err && err.stack) || err).slice(0, 600) });
  }
};
