// Terrain material v2: texture-array splatting + SPOM relief.
//
// WHY ARRAYS: the v1 material bound 15 separate textures and hit the
// adapter's hard 16-samplers-per-stage cap the moment the blend brush landed.
// All rock albedos now live in ONE DataArrayTexture (roughness packed in
// alpha) and all rock normals in another (HEIGHT packed in alpha) — the whole
// material needs ~5 samplers, gravel is just layer 5, and future biomes swap
// layer sets instead of adding bindings.
//
// SPOM (Silhouette Parallax Occlusion Mapping) — march ported from the
// eidoverse reference implementation (parallax_material.js), which documents
// the load-bearing WebGPU/TSL rules:
//   - height samples INSIDE the march loop use explicit LOD 0 (textureLevel):
//     derivative-dependent sampling in divergent flow is WGSL UB and painted
//     feather-shaped black patches on that stack.
//   - everything sampled at the marched UV uses explicit gradients of the
//     BASE uv (grad()) — the marched UV's screen derivatives are garbage and
//     implicit LOD picks bottom mips (mip-average smears).
//   - hit flag starts at 1: loop exhaustion is NOT a side exit.
//   - occlusion refinement lerps the last two layers onto the surface.
// Terrain adaptation: the heightfield REPEATS (wrapping UVs), so the
// reference's tile-edge silhouette discard has nothing to carve against in
// the interior — relief expresses as stones occluding each other during the
// march. The march samples the DOMINANT layer's height per pixel (weights
// are fixed during a pixel's march anyway), one array sample per step.

import { DataArrayTexture, RepeatWrapping, SRGBColorSpace, LinearMipmapLinearFilter, LinearFilter, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  texture, uv, attribute, mix, normalMap, vec2, vec3, vec4, float, int, uniform,
  dFdx, dFdy, positionView, cameraViewMatrix,
} from 'three/tsl';
// Silhouette Parallax Occlusion Mapping with self-shadowing — the published
// three.js contribution (examples/jsm/tsl/utils/ParallaxOcclusion.js), vendored
// with a small `height` generalization so the terrain's per-pixel dominant-layer
// height can drive the march. See src/core/parallax-occlusion.js.
import { parallaxOcclusionUV } from './parallax-occlusion.js';

// ---- CPU: compose the layer arrays -----------------------------------------
const SIZE = 1024;

async function fetchPixels(url, fallback) {
  if (!url) return fallback;
  try {
    const blob = await (await fetch(url)).blob();
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(SIZE, SIZE);
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
    bmp.close();
    return ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return fallback;
  }
}

const FLAT_NORMAL = (() => { const d = new Uint8ClampedArray(SIZE * SIZE * 4); for (let i = 0; i < d.length; i += 4) { d[i] = 128; d[i + 1] = 128; d[i + 2] = 255; d[i + 3] = 255; } return d; })();
const MID_GRAY = (() => { const d = new Uint8ClampedArray(SIZE * SIZE * 4); d.fill(140); return d; })();

/**
 * layers: [{ albedo, normal, roughness, height }] of URLs (any may be null).
 * Returns { albedoArray, normalArray, count } — albedo rgb + roughness in a
 * (sRGB transfer applies to rgb only, so the packed alpha stays linear);
 * normal rgb + HEIGHT in a.
 */
export async function buildTerrainArrays(layers) {
  const count = layers.length;
  const albedoData = new Uint8Array(SIZE * SIZE * 4 * count);
  const normalData = new Uint8Array(SIZE * SIZE * 4 * count);
  await Promise.all(layers.map(async (L, i) => {
    const [alb, nrm, rgh, hgt] = await Promise.all([
      fetchPixels(L.albedo, MID_GRAY),
      fetchPixels(L.normal, FLAT_NORMAL),
      fetchPixels(L.roughness, null),
      fetchPixels(L.height, null),
    ]);
    const aBase = i * SIZE * SIZE * 4;
    for (let p = 0; p < SIZE * SIZE; p++) {
      albedoData[aBase + p * 4] = alb[p * 4];
      albedoData[aBase + p * 4 + 1] = alb[p * 4 + 1];
      albedoData[aBase + p * 4 + 2] = alb[p * 4 + 2];
      albedoData[aBase + p * 4 + 3] = rgh ? rgh[p * 4 + 1] : 230; // roughness (g)
      normalData[aBase + p * 4] = nrm[p * 4];
      normalData[aBase + p * 4 + 1] = nrm[p * 4 + 1];
      normalData[aBase + p * 4 + 2] = nrm[p * 4 + 2];
      normalData[aBase + p * 4 + 3] = hgt ? hgt[p * 4] : 128;     // height (r)
    }
  }));
  const mk = (data, srgb) => {
    const t = new DataArrayTexture(data, SIZE, SIZE, count);
    t.wrapS = t.wrapT = RepeatWrapping;
    // No mipmaps: WebGPU's DataArrayTexture mip generation frequently leaves the
    // array incomplete → every sample reads white. Linear (no mip) is fine here.
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = false;
    t.anisotropy = 1;
    if (srgb) t.colorSpace = SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { albedoArray: mk(albedoData, true), normalArray: mk(normalData, false), count };
}

// ---- the material -----------------------------------------------------------
// Layer order convention: 0 granite, 1 slate, 2 fieldstone, 3 limestone,
// 4 basalt, 5 gravel. Value-compression multipliers keep the user-approved
// look from v1 (linear-space, so they stay in-shader, not baked into bytes).
const LAYER_TINT = [
  [1, 0, 0],       // granite
  [2.2, 0.01, 0],  // slate lifted
  [1, 0, 0],       // fieldstone
  [0.45, 0, 0],    // limestone darkened
  [2.4, 0.01, 0],  // basalt lifted
  [1, 0, 0],       // gravel
];
const LAYER_ROUGH_REMAP = [1, 0.78, 1.06, 0.94, 1.12, 1.0];

export const spomDepth = uniform(0.035);   // relief in rock-tile units (cranked up — 0.009≈6cm was imperceptible)

/**
 * opts: { albedoArray, normalArray, layerCount, grassAlbedo, grassNormal,
 *         blendBrush, spom: bool, minLayers, maxLayers }
 */
export function buildTerrainMaterial(opts) {
  const { albedoArray, normalArray, layerCount, grassAlbedo, grassNormal, blendBrush } = opts;
  // Biome-aware value remaps: the defaults tune the TEMPERATE roster (granite/
  // slate/basalt painted at wild value poles); desert layers are generated at
  // consistent mid values so they pass a NEUTRAL tint ([1,0,0]) / remap (1).
  const TINT = opts.layerTint ?? LAYER_TINT;
  const ROUGH = opts.layerRoughRemap ?? LAYER_ROUGH_REMAP;
  const mat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });

  const brushT = blendBrush ?? null;
  const sharp = (wgt, s, ox, oy) => {
    if (!brushT) return wgt;
    const b = texture(brushT, uv().mul(s).add(vec2(ox, oy))).r;
    const th = b.mul(0.7).add(0.15);
    return wgt.smoothstep(th.sub(0.22), th.add(0.22));
  };
  const w = sharp(attribute('rockness'), 0.045, 0, 0).toVar();
  const rv = attribute('rockVars', 'vec4');
  const v1 = sharp(rv.x, 0.031, 0.37, 0.71).toVar();
  const v2 = sharp(rv.y, 0.026, 0.13, 0.29).toVar();
  const v3 = sharp(rv.z, 0.037, 0.61, 0.47).toVar();
  const v4 = sharp(rv.w, 0.023, 0.83, 0.09).toVar();

  // Sequential-mix chain → explicit per-layer weights (same math as v1).
  const k1 = v1.oneMinus(), k2 = v2.oneMinus(), k3 = v3.oneMinus(), k4 = v4.oneMinus();
  const wL = [
    k1.mul(k2).mul(k3).mul(k4),        // granite
    v1.mul(k2).mul(k3).mul(k4),        // slate
    v2.mul(k3).mul(k4),                // fieldstone
    v3.mul(k4),                        // limestone
    v4,                                // basalt
  ];
  // Gravel lives in the BORDER BANDS between materials: each blend weight at
  // ~0.5 means "on the seam" — band(x) = 4x(1-x) peaks there. Its own brush
  // sample breaks the bands into patches instead of clean outlines.
  let gravel = float(0);
  if (layerCount > 5) {
    const band = (x) => x.mul(x.oneMinus()).mul(4);
    const seams = band(v1).add(band(v2)).add(band(v3)).add(band(v4)).add(band(w).mul(0.8));
    const gBrush = brushT ? texture(brushT, uv().mul(0.055).add(vec2(0.41, 0.93))).r : float(0.5);
    gravel = seams.mul(0.6).add(gBrush.mul(0.55)).sub(0.55).clamp(0, 1).mul(w).toVar();
  }
  const wAll = [...wL.map((x) => (layerCount > 5 ? x.mul(gravel.oneMinus()) : x)), ...(layerCount > 5 ? [gravel] : [])];

  // Dominant layer for the march's height lookups. MUST be a chained-SELECT
  // EXPRESSION, not If(): If() is TSL control-flow that needs a Fn build stack,
  // and this runs at the top level of the material (no stack) → it threw
  // "Cannot read properties of null (reading 'If')" and the whole SPOM material
  // silently fell back to the flat inline one. select() is a plain ternary node.
  let domIdx = int(0);
  let domW = wAll[0];
  for (let i = 1; i < wAll.length; i++) {
    const gt = wAll[i].greaterThan(domW);
    domIdx = gt.select(int(i), domIdx);
    domW = gt.select(wAll[i], domW);
  }
  // Per-layer PUSH strength: subtle on noisy fine-detail heightmaps, strong on
  // thick-edged rock (opts.layerDepthScale, one per layer), picked by the
  // dominant layer. Chained select (expression) — no If()/build stack.
  const dScale = opts.layerDepthScale ?? null;
  let rockDScale = float(dScale?.[0] ?? 1);
  for (let i = 1; i < wAll.length; i++) {
    rockDScale = domIdx.equal(int(i)).select(float(dScale?.[i] ?? 1), rockDScale);
  }

  const rockUv = uv().mul(0.55);
  // clamp gradients (canonical): quads straddling a UV seam otherwise collapse
  // every fetch to the lowest mip and streak the height-map average along it.
  const gX = dFdx(rockUv).clamp(-0.1, 0.1), gY = dFdy(rockUv).clamp(-0.1, 0.1);

  // ---- SPOM via the published parallaxOcclusionUV (self-shadowing POM) -------
  // The terrain feeds a COMPUTED height (the dominant splat layer's packed height,
  // optionally blended with the ground/gravel height by rockness) into the vendored
  // march, plus a distance-faded relief depth so the parallax converges to flat far
  // away. We consume only `uv` (marched coords) and `shadow` (self-shadow) — the
  // multi-layer albedo/normal are sampled by the terrain's own array taps below.
  let pUV = rockUv;
  let litNode = float(1); // self-shadow LIT factor (1 = fully lit, 0 = shadowed)
  if (opts.spom !== false) {
    const minLayers = opts.minLayers ?? 16;
    const maxLayers = opts.maxLayers ?? 48;
    const fadeNear = opts.fadeNear ?? 22;   // full relief within this distance (m)
    const fadeFar = opts.fadeFar ?? 90;     // flat beyond this

    // surface height (white = peak) at a coord: dominant rock layer's packed height
    // (normalArray alpha), blended with the ground(gravel) height on the flats.
    const heightAt = (tuv) => {
      const rockH = texture(normalArray, tuv).depth(domIdx).level(0).a;
      if (!opts.groundParallax || !opts.groundHeight) return rockH; // temperate: rock only
      const gH = texture(opts.groundHeight, tuv).level(0).r;
      return mix(gH, rockH, w);
    };

    // relief depth: per-material push × ground/rock blend × distance fade, gated by
    // rockness (temperate grass stays flat; desert gravel parallaxes the whole floor).
    const viewDist = positionView.z.negate();
    const fade = viewDist.smoothstep(float(fadeNear), float(fadeFar)).oneMinus();
    const groundDScale = float(opts.groundDepthScale ?? 1);
    const depthScale = opts.groundParallax ? mix(groundDScale, rockDScale, w) : rockDScale;
    const depthNode = spomDepth.mul(depthScale).mul(fade).mul(opts.groundParallax ? float(1) : w);

    const pom = parallaxOcclusionUV(null, {
      uvNode: rockUv,
      scale: depthNode,
      minLayers, maxLayers,
      minViewZ: 0.12,
      silhouette: false,   // terrain tiles — no side to carve a silhouette against
      height: heightAt,
    });
    pUV = pom.uv;

    if (opts.sunDir) {
      // sun direction in VIEW space (towards the sun); the module marches from the
      // hit point toward it in tangent space and returns a soft, proximity-weighted
      // lit factor (1 lit → 0 in relief shadow), fading out far away as depth → 0.
      const Lview = cameraViewMatrix.mul(vec4(opts.sunDir, 0)).xyz;
      litNode = pom.shadow(Lview, { steps: 12, strength: opts.shadowStrength ?? 8, bias: 0.03 });
    }
  }

  // ---- blended samples at the marched UV, gradient-correct -----------------
  const layerAlbedo = (i) => {
    const s = texture(albedoArray, pUV).depth(int(i)).grad(gX, gY);
    const [mul, add] = TINT[i] ?? [1, 0];
    return vec4(s.rgb.mul(mul).add(add), s.a);
  };
  let rockCol = layerAlbedo(0);
  let rockNrm = texture(normalArray, pUV).depth(int(0)).grad(gX, gY);
  for (let i = 1; i < layerCount; i++) {
    rockCol = mix(rockCol, layerAlbedo(i), wAll[i]);
    rockNrm = mix(rockNrm, texture(normalArray, pUV).depth(int(i)).grad(gX, gY), wAll[i]);
  }
  // macro anti-tiling patina (granite layer sampled far larger — no new binding)
  const macro = texture(albedoArray, uv().mul(0.11)).depth(int(0)).r.mul(0.8).add(0.58);

  // Desert gravel samples at the MARCHED uv (parallaxed like the rock); temperate
  // grass stays at the flat uv. Marched samples need explicit gradients.
  const gUv = opts.groundParallax ? pUV : uv();
  const grassCol = grassAlbedo
    ? (opts.groundParallax ? texture(grassAlbedo, gUv).grad(gX, gY) : texture(grassAlbedo, gUv))
    : vec4(0.2, 0.35, 0.15, 1);
  const baseCol = mix(grassCol, vec4(rockCol.rgb.mul(macro), 1), w);
  // POM self-shadow darkens the relief where the sun is occluded (down to ~30%).
  // litNode is 1 fully lit → 0 in relief shadow, so 0.3..1.0 keeps ambient fill.
  mat.colorNode = vec4(baseCol.rgb.mul(litNode.mul(0.7).add(0.3)), baseCol.a);

  if (grassNormal) {
    const gN = opts.groundParallax ? texture(grassNormal, gUv).grad(gX, gY) : texture(grassNormal, gUv);
    mat.normalNode = normalMap(mix(gN, vec4(rockNrm.rgb, 1), w));
  } else {
    mat.normalNode = normalMap(vec4(rockNrm.rgb, 1));
  }

  // roughness: TRUE per-layer maps ride the albedo array's alpha again (the
  // v1 sampler crunch forced scalar remaps; the pack restores the real maps,
  // remaps kept as artistic bias)
  let rockRgh = rockCol.a.mul(ROUGH[0]);
  // (alpha already blended through the same mix chain — bias by dominant remap)
  mat.roughnessNode = mix(float(0.88), rockRgh.clamp(0, 1), w);

  return mat;
}
