// Crossplane billboard impostor — the classic SpeedTree far LOD. Bakes the LOD0
// tree into FOUR texture channels per view (front + side):
//
//   albedo       lit flat-white → base color, re-lights at runtime
//   normal       per-pixel GEOMETRIC normals in WORLD space — leaf-clump
//                lumpiness and trunk curvature, used as detail
//   roughness    from each source material's roughness map
//   translucency from each source material's diffuse-transmission map, so the
//                billboard keeps the sun-through-leaves glow of the near LODs
//
// Shading shape uses the AAA vegetation trick on TWO layers that compose:
//  1. Base: a canopy-sphere normal field evaluated from WORLD POSITION in the
//     shader (and mirrored into the mesh vertex normals for export). Both cards
//     sample the same world-space field, so shading is continuous across the
//     cross intersection — per-card local bending would (and did) leave a hard
//     seam where the planes meet.
//  2. Detail: the baked world-space normal map blended in at low strength for
//     per-pixel foliage sparkle. Normal maps render relative to mesh normals,
//     so both layers cooperate rather than fight.
//
// WebGPU path: renderer.setRenderTarget + renderAsync + readRenderTargetPixelsAsync.
// Albedo gets linear→sRGB (render targets skip the output transform); data
// channels stay linear. Everything gets alpha-edge dilation (kills halos), then
// lands in CanvasTextures — which GLTFExporter embeds without fuss.

import {
  Scene, OrthographicCamera, RenderTarget, HemisphereLight, Box3, Vector3, Color,
  CanvasTexture, MeshBasicMaterial, MeshBasicNodeMaterial, MeshSSSNodeMaterial,
  PlaneGeometry, Mesh, Group, DoubleSide, SRGBColorSpace, NoColorSpace,
} from 'three/webgpu';
import { texture, uniform, float, vec3, vec4, mix, positionWorld, normalWorld, cameraViewMatrix, modelWorldMatrix, mrt, output, normalView } from 'three/tsl';
import { windStrength } from './wind.js';

const linToSrgb = (u) => {
  const c = u / 255;
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
};

// Flood opaque edge colors into transparent margins (color only, alpha stays 0)
// so filtering at the alpha edge never blends toward black.
function dilate(data, w, h, passes) {
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = data[i * 4 + 3] > 8 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = filled.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        if (x > 0 && filled[i - 1]) { const k = (i - 1) * 4; r += data[k]; g += data[k + 1]; b += data[k + 2]; n++; }
        if (x < w - 1 && filled[i + 1]) { const k = (i + 1) * 4; r += data[k]; g += data[k + 1]; b += data[k + 2]; n++; }
        if (y > 0 && filled[i - w]) { const k = (i - w) * 4; r += data[k]; g += data[k + 1]; b += data[k + 2]; n++; }
        if (y < h - 1 && filled[i + w]) { const k = (i + w) * 4; r += data[k]; g += data[k + 1]; b += data[k + 2]; n++; }
        if (n) {
          const k = i * 4;
          data[k] = r / n; data[k + 1] = g / n; data[k + 2] = b / n;
          next[i] = 1;
        }
      }
    }
    filled.set(next);
  }
}

// Readback row order differs by backend. Probed ONCE with a known image (white
// quad in the top half) instead of guessing from content — a content heuristic
// misfires on bottom-heavy bakes like drooping branch cards.
let readbackFlipped = null;
async function probeReadbackRowOrder(renderer) {
  if (readbackFlipped !== null) return readbackFlipped;
  const scene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 1), new MeshBasicMaterial({ color: 0xffffff }));
  quad.position.y = 0.5; // occupy the TOP half of the frustum
  scene.add(quad);
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  cam.position.z = 2;
  const prevRT = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  const rt = new RenderTarget(8, 8);
  renderer.setRenderTarget(rt);
  await renderer.renderAsync(scene, cam);
  const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, 8, 8);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevColor, prevAlpha);
  rt.dispose();
  quad.geometry.dispose();
  quad.material.dispose();
  readbackFlipped = px[3] < 128; // buffer row 0 transparent → bottom-first → flip
  return readbackFlipped;
}

function flipRows(data, w, h) {
  const row = new Uint8Array(w * 4);
  for (let y = 0; y < h >> 1; y++) {
    const a = y * w * 4, b = (h - 1 - y) * w * 4;
    row.set(data.subarray(a, a + w * 4));
    data.copyWithin(a, b, b + w * 4);
    data.set(row, b);
  }
}

// DOM-FREE pixel processing (sRGB convert + row flip + alpha dilate). Runs in the
// bake worker too, where `document` doesn't exist — the worker ships these processed
// arrays back and the main thread builds the CanvasTextures from them.
export function processPixels(pixels, size, dilatePasses, srgb, flip) {
  const data = new Uint8ClampedArray(pixels); // copy out of the GPU readback buffer
  if (srgb) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = linToSrgb(data[i]);
      data[i + 1] = linToSrgb(data[i + 1]);
      data[i + 2] = linToSrgb(data[i + 2]);
    }
  }
  if (flip) flipRows(data, size, size);
  dilate(data, size, size, dilatePasses);
  return data;
}

// Build a CanvasTexture from already-processed pixels (main thread — needs DOM).
export function textureFromProcessedPixels(data, size, srgb) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').putImageData(new ImageData(data, size, size), 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function pixelsToTexture(pixels, size, dilatePasses, srgb, flip) {
  const data = processPixels(pixels, size, dilatePasses, srgb, flip);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').putImageData(new ImageData(data, size, size), 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Unlit capture material for a data channel, preserving the source's alpha cutout.
function captureMaterial(srcMesh, channel) {
  const src = srcMesh.material;
  const m = new MeshBasicNodeMaterial();
  m.side = DoubleSide;
  if (src.alphaTest) m.alphaTest = src.alphaTest;
  const alpha = src.map ? texture(src.map).a : float(1);
  if (channel === 'normal') {
    // Raw world-space geometric normals (no face flip) — detail layer.
    m.colorNode = vec4(normalWorld.mul(0.5).add(0.5), alpha);
  } else if (channel === 'rough') {
    const r = src.roughnessMap ? texture(src.roughnessMap).g : float(src.roughness ?? 1);
    m.colorNode = vec4(vec3(r), alpha);
  } else { // 'trans'
    const dtMap = src.userData?.gltfDiffuseTransmission?.map;
    m.colorNode = vec4(vec3(dtMap ? texture(dtMap).r : float(0)), alpha);
  }
  return m;
}

// Bent vertex normals for export: the same canopy-sphere field the shader uses,
// baked into the mesh. Radial in the card plane with the sphere centre dropped
// (up-bias) — crucially z=0 and rotation-symmetric, so the front and side cards
// agree wherever they coincide in world space (no seam at the intersection).
function bentNormalCardGeometry(w, h) {
  const geo = new PlaneGeometry(w, h, 6, 6);
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    // Sphere centre dropped BELOW the card (0.55h > half height) so no normal
    // ever points downward — a down normal was blacking out the trunk base.
    v.set(pos.getX(i), pos.getY(i) + h * 0.55, 0);
    if (v.lengthSq() < 1e-6) v.set(0, 1, 0);
    v.normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  return geo;
}

const TRANSMIT = [0.42, 0.62, 0.24]; // same transmitted green as the live foliage

function makeCardMaterial(t, cardH) {
  const mat = new MeshSSSNodeMaterial({
    map: t.albedo, normalMap: t.normal, roughnessMap: t.rough,
    alphaTest: 0.35, side: DoubleSide, roughness: 1.0, metalness: 0.0,
  });
  // Live normal = canopy-sphere base (from WORLD position relative to the card's
  // origin = canopy centre, so both cards evaluate the identical field — this is
  // what kills the seam at the cross intersection) + baked world-space geometric
  // normals as low-strength per-pixel detail. No face flip: a volume's far side
  // should stay its dark side. Exports fall back to the mesh vertex normals +
  // the baked map, same two layers.
  const origin = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
  // Canopy-sphere normal, leaned 30% toward world-UP so a card's shadowed
  // hemisphere catches sky light instead of rendering fully BLACK at distance
  // (the Joshua impostors' dense dark rosette was reading as black shadow). Still
  // keeps enough radial curvature to read as a lit volume, not a flat card.
  const radial = positionWorld.sub(origin).add(vec3(0, cardH * 0.55, 0)).normalize();
  const base = mix(radial, vec3(0, 1, 0), 0.30).normalize();
  // Additive perturbation (not a lerp): detail tilts the base without diluting
  // it, the way a tangent normal map perturbs mesh normals — this is what makes
  // trunk/branch roundness actually pop through.
  const detail = texture(t.normal).xyz.mul(2).sub(1);
  const nWorld = base.add(detail.mul(0.55)).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
  // GTAO exclusion: this flat billboard keeps its bent normalNode for lighting,
  // but writes aomask=0 to the scene MRT so screen-space AO skips it entirely —
  // no whole-card blackout (bent normals face away from camera) and no dark
  // X-seam where the crossed cards intersect (the crease bent normals hide). The
  // scene pass carries {output, normal, aomask}; real geometry defaults aomask=1.
  mat.mrtNode = mrt({ output, normal: normalView, aomask: float(0) });
  // Backlit transmission from the baked translucency — the distant tree keeps
  // glowing when the sun is behind it, matching the near LODs.
  mat.thicknessColorNode = texture(t.trans).r.mul(uniform(new Color().setRGB(...TRANSMIT)));
  mat.thicknessDistortionNode = uniform(0.3);
  mat.thicknessAmbientNode = uniform(0.16); // scatter floor — see leaf-cards.js
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(6.0);
  mat.thicknessScaleNode = uniform(3.0);
  mat.userData.gltfDiffuseTransmission = { factor: 1.0, color: TRANSMIT, map: t.trans };
  return mat;
}

/**
 * Generic multichannel bake: renders `sourceRoot` through each view's camera in
 * albedo/normal/rough/trans channels and returns CanvasTextures per view:
 * { [viewName]: { albedo, normal, rough, trans } }. The root is temporarily
 * reparented into a throwaway flat-lit scene and handed back after.
 * Caller must pause its animation loop — this re-targets the renderer.
 */
export async function bakeGroupToTextures(renderer, sourceRoot, views, opts = {}) {
  const size = opts.size ?? 1024;
  const flip = await probeReadbackRowOrder(renderer);

  const scene = new Scene();
  scene.add(sourceRoot);
  scene.add(new HemisphereLight(0xffffff, 0xffffff, 3.0)); // flat white → ~albedo bake

  // Collect meshes and build per-channel capture materials.
  const meshes = [];
  sourceRoot.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh && !o.boundingSphere) o.computeBoundingSphere();
    meshes.push(o);
  });
  // Capture materials are built from each mesh's ORIGINAL material and precomputed
  // BEFORE the channel loop — never read m.material during the loop, since
  // setChannel() reassigns it each channel (reading it mid-loop would build the
  // rough/trans capture from the PREVIOUS channel's capture material, which has no
  // map/roughnessMap/transmission → those channels bake with no alpha cutout and
  // wrong data). WebGPU compiles per render object regardless, so there's no win
  // from sharing capture materials across meshes anyway.
  const original = new Map(meshes.map((m) => [m, m.material]));
  const captures = {};
  for (const ch of ['normal', 'rough', 'trans']) {
    captures[ch] = new Map(meshes.map((m) => [m, captureMaterial(m, ch)]));
  }
  const setChannel = (ch) => {
    for (const m of meshes) m.material = ch === 'albedo' ? original.get(m) : captures[ch].get(m);
  };

  const prevRT = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  const prevWind = windStrength.value;
  windStrength.value = 0; // bake a still tree — swaying mid-bake smears the cards

  const rt = new RenderTarget(size, size);
  const out = {};
  let step = 0; const total = views.length * 4;
  try {
    for (const view of views) {
      const channels = {};
      for (const ch of ['albedo', 'normal', 'rough', 'trans']) {
        setChannel(ch);
        renderer.setRenderTarget(rt);
        await renderer.renderAsync(scene, view.camera);
        const pixels = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
        channels[ch] = opts.rawPixels
          ? { data: processPixels(pixels, size, opts.dilate ?? 12, ch === 'albedo', flip), size, srgb: ch === 'albedo' }
          : pixelsToTexture(pixels, size, opts.dilate ?? 12, ch === 'albedo', flip);
        opts.onProgress?.(++step, total);
        // Hand a frame back to the main loop between bakes so the engine never
        // freezes and the progress readout can repaint (the main loop re-targets
        // to the screen; we re-set our RT before the next bake render).
        if (opts.yield) await opts.yield();
      }
      out[view.name] = channels;
    }
  } finally {
    setChannel('albedo'); // restore before the root is handed back
    for (const ch of Object.values(captures)) for (const m of ch.values()) m.dispose();
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevColor, prevAlpha);
    windStrength.value = prevWind;
    rt.dispose();
    scene.remove(sourceRoot);
  }
  return out;
}

/**
 * Bake front + side impostor cards from a tree level (research says bake from
 * LOD1 — matching silhouettes hide the final transition).
 * Caller must pause its animation loop while this runs — it re-targets the renderer.
 *
 * @returns {Promise<Group>} 2 crossed cards, named for export as `<Species>_LOD3`.
 */
export async function bakeImpostor(renderer, sourceGroup, opts = {}) {
  const size = opts.size ?? 1024;

  const clone = sourceGroup.clone(true);
  clone.visible = true; // the source level may be LOD-hidden right now
  clone.position.set(0, 0, 0);

  const box = new Box3().setFromObject(clone);
  const center = box.getCenter(new Vector3());
  const sz = box.getSize(new Vector3());
  const halfW = (Math.max(sz.x, sz.z) / 2) * 1.03;
  const halfH = (sz.y / 2) * 1.03;
  const depth = Math.max(sz.x, sz.z) + 5;

  const views = [];
  for (const [name, dir] of [['front', new Vector3(0, 0, 1)], ['side', new Vector3(1, 0, 0)]]) {
    const cam = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, depth * 2);
    cam.position.copy(center).addScaledVector(dir, depth);
    cam.lookAt(center);
    views.push({ name, camera: cam });
  }
  const baked = await bakeGroupToTextures(renderer, clone, views, { size, dilate: opts.dilate ?? 12, onProgress: opts.onProgress, yield: opts.yield });
  const viewTextures = { front: baked.front, side: baked.side };

  // Two crossed cards spanning the baked framing exactly (same margins).
  const group = new Group();
  group.name = `${(opts.name ?? 'tree').replace(/\s+/g, '_')}_${opts.lodName ?? 'LOD3'}`;
  group.userData.lodName = 'BB';
  group.userData.isBillboard = true;
  const cardGeo = bentNormalCardGeometry(halfW * 2, halfH * 2);
  for (const [i, t] of [viewTextures.front, viewTextures.side].entries()) {
    const card = new Mesh(cardGeo, makeCardMaterial(t, halfH * 2));
    card.name = i === 0 ? 'billboard_front' : 'billboard_side';
    card.position.copy(center);
    if (i === 1) card.rotation.y = -Math.PI / 2;
    // Cast (the crossed cards throw a plausible canopy blob, and the hero's
    // shadow vanishing at the last LOD switch is a visible pop); don't receive
    // (self-shadow banding across flat cards is what actually looks bad).
    card.castShadow = true;
    card.receiveShadow = false;
    card.userData.isBillboardCard = true;
    group.add(card);
  }
  return group;
}

// MAIN-THREAD assembly of the billboard from the OFF-THREAD bake's raw pixels
// (see bake-worker.js). Mirrors bakeImpostor's card build, but the 8 RT renders +
// readbacks already happened on the worker's own GPU queue — no viewer stall.
export function assembleBillboardFromRawBake(res, opts = {}) {
  const { baked, center, halfW, halfH } = res;
  const c = new Vector3(center[0], center[1], center[2]);
  const viewTex = {};
  for (const v of ['front', 'side']) {
    viewTex[v] = {};
    for (const ch of ['albedo', 'normal', 'rough', 'trans']) {
      const { data, size, srgb } = baked[v][ch];
      viewTex[v][ch] = textureFromProcessedPixels(new Uint8ClampedArray(data), size, srgb);
    }
  }
  const group = new Group();
  group.name = `${(opts.name ?? 'tree').replace(/\s+/g, '_')}_${opts.lodName ?? 'LOD3'}`;
  group.userData.lodName = 'BB';
  group.userData.isBillboard = true;
  const cardGeo = bentNormalCardGeometry(halfW * 2, halfH * 2);
  for (const [i, t] of [viewTex.front, viewTex.side].entries()) {
    const card = new Mesh(cardGeo, makeCardMaterial(t, halfH * 2));
    card.name = i === 0 ? 'billboard_front' : 'billboard_side';
    card.position.copy(c);
    if (i === 1) card.rotation.y = -Math.PI / 2;
    card.castShadow = true;
    card.receiveShadow = false;
    card.userData.isBillboardCard = true;
    group.add(card);
  }
  return group;
}

export function disposeBillboard(group) {
  group.traverse((o) => {
    if (o.userData.isBillboardCard) {
      o.material.map?.dispose();
      o.material.normalMap?.dispose();
      o.material.roughnessMap?.dispose();
      o.material.userData.gltfDiffuseTransmission?.map?.dispose();
      o.material.dispose();
      o.geometry.dispose();
    }
  });
}
