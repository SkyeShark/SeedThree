# PBR Map Derivation — Design Brief (v2 plan)

How to turn a single AI-generated albedo into a full PBR set properly. Current code
(`scripts/texture/derive-pbr.mjs`) is the **naive v1** (albedo-luminance → Sobel normal),
which is known-wrong. This documents the v2 upgrade.

## The core principle (what Substance/Materialize/AwesomeBump all do)

**Height is the source of truth. Albedo is only delighted and used to *seed* height —
never used directly as geometry.** Chain: height → normal, height → AO, normal → curvature.
There is no albedo→normal node in any real tool.

Why naive albedo→height is wrong: albedo is reflectance with lighting/shadow stripped, so
dark *pigment* becomes a false groove and bright marks become false bumps. For bark, dark
pigment ≠ deep fissure.

## Image model capabilities (honest)

- **Tangent-space normals: NEVER ask an image model.** They emit RGB with no unit-length/
  direction constraint → directionally wrong even after renormalizing. Derive from height instead.
- **Grayscale height & roughness: usable** (scalar fields, no vector-validity constraint).
- **Sweet spot: generate albedo + co-registered height in the SAME generation, derive the rest
  from height.** Separate-pass height risks misalignment; same-pass/conditioned keeps pixels aligned.

## Recommended pipeline (Node + sharp, permissive licenses)

```
1. ALBEDO    = Codex $imagegen (prompt: flat even diffuse lighting, seamless, tileable)
2. DELIGHT   = albedo / blur(luminance(albedo), r=W/8) * mean     # flatten soft baked lighting
3. HEIGHT_lo = EITHER Codex height (same/conditioned generation, co-registered)
               OR      Depth-Anything-V2-Small ONNX (albedo→depth as height proxy)
4. HEIGHT_hi = highpass(luminance(DELIGHT), r≈W/16) + 0.5          # signed detail only
5. HEIGHT    = normalize16(a*HEIGHT_lo + b*HEIGHT_hi)              # 16-bit avoids AO banding
6. NORMAL    = scharrNormal(HEIGHT, strength≈5, wrap=mirror, +Y/OpenGL for three.js)
               # optional multi-scale: blend coarse+fine normals with Whiteout
7. AO        = HBAO(HEIGHT, N_DIR=8, N_STEP=8, GTAO cosine weight)  # horizon on the heightfield
8. CURVATURE = fromNormal(NORMAL)                                  # optional, for wear masks
9. ROUGHNESS = clamp(baseRough + k*(1 - luminance(DELIGHT)))       # dark fissures rougher
10. METALNESS = 0                                                  # bark/foliage are dielectric
```

### Key technique details
- **Scharr > Sobel** (5× lower angular error). Scharr Gx = `[3,0,-3;10,0,-10;3,0,-3]`, Gy transposed.
- **Encode:** `N = normalize(vec3(-dx*strength, -dy*strength, 1)); rgb = N*0.5+0.5`. Renormalize — mandatory.
- **Tileable:** wrap/mirror-sample the gradient stencil at edges. In sharp: `.extend({extendWith:'mirror'})`, convolve, `.extract()` back. Only seamless if the source height tiles.
- **Three.js wants OpenGL/+Y** normals (green up). MeshStandardMaterial default `normalScale=(1,1)` expects +Y; DirectX map → negate normalScale.y. Validate by rendering: if bumps read as dents, flip green.
- **HBAO:** treat height as a heightfield, raymarch per direction tracking max horizon slope; use GTAO cosine-weighted increment (raw `sin(horizon)` over-darkens); per-pixel jitter + light blur kills banding. `heightScale` is the dominant knob.
- **16-bit** height through the whole derivation; quantize to 8-bit only on final PNG.
- Convert sRGB albedo → linear before computing luminance for height.

### Libraries (all permissive)
- **sharp** (Apache-2.0): `.convolve()`, `.blur()`, `.greyscale()`, `.linear()`, `.gamma()`, `.extend({extendWith:'mirror'})`, `.raw().toBuffer()`. Covers the hard parts.
- **onnxruntime-node** (MIT) / **@huggingface/transformers** (Apache-2.0) + **Depth-Anything-V2-Small** ONNX for the depth/height proxy.
- **Avoid DeepBump** — great quality but **GPL-3.0**, would make the app copyleft.

## Decision for SpeedThree

Primary path = **have Codex generate a co-registered grayscale HEIGHT map** alongside each bark
albedo (image models do height fine), then derive normal (Scharr) + AO (HBAO) + roughness from
height with sharp. Fallback when no height = high-pass+delight the albedo. This combines both of
the user's suggestions (ask-gpt for height + robust programmatic derivation) and is the best
quality we can ship with permissive licensing.

**Biggest quality lever is upstream:** prompt albedo with *flat, even, shadowless* lighting.
