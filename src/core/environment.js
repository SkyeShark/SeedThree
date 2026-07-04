// Scene environment: gradient sky dome, a "terrain ring" (flat centre where the
// plant sits, rising into noisy hills around the rim), a glowing sun, and cloud
// billboards. The ground blends two materials (grass ↔ rock) by a per-vertex
// "rockness" weight — vertex-painted material blending done in a TSL node material.

import {
  Group, Mesh, SphereGeometry, PlaneGeometry, BufferAttribute,
  MeshBasicMaterial, MeshStandardNodeMaterial, Color, BackSide, RepeatWrapping,
  Sprite, SpriteMaterial, CanvasTexture, AdditiveBlending, Vector3,
} from 'three/webgpu';
import { texture, uv, attribute, mix, normalMap, vec2, float } from 'three/tsl';

// ---- deterministic value noise -------------------------------------------
function hash2(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const u = smooth(fx), v = smooth(fz);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, z, seed) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 4; o++) { sum += amp * valueNoise(x * freq, z * freq, seed + o * 17); amp *= 0.5; freq *= 2; }
  return sum;
}

const BIOMES = {
  temperate: { zenith: 0x3f6ea8, horizon: 0xc6dcec, fog: 0xc6dcec, sun: 0xfff4d6 },
  // Desert: paler bleached-blue zenith, warm dust haze at the horizon (distance
  // reads as suspended sand), warm low sun.
  desert:    { zenith: 0x7a9cc4, horizon: 0xdcc6a0, fog: 0xd8be95, sun: 0xffeec2 },
};

function radialSprite(inner, outer, stops) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, inner, 128, 128, outer);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = 'srgb';
  return tex;
}

/**
 * @param {object} opts { groundTexture, groundNormal, groundRoughness, rockTexture,
 *   cloudTexture, sunDirection:Vector3, biome, seed, radius, flatRadius, hillHeight }
 */
// Analytic terrain height/rockness — shared by the terrain mesh AND the
// decoration scatter (grass/rocks placed on the hills, not just the flat disc).
export function makeHeightSampler(seed, { R = 75, flatR = 15, hillH = 12 } = {}) {
  const noiseScale = 0.06;
  // Hills rise over a FIXED ~70m foothill band, then roll at full amplitude out
  // to R — on a big terrain the old R-proportional ramp left everything flat.
  const ramp = (x, z) => smooth(Math.max(0, Math.min(1, (Math.hypot(x, z) - flatR) / 70)));
  const heightAt = (x, z) => {
    if (Math.hypot(x, z) <= flatR) return 0;
    const rp = ramp(x, z);
    const n = fbm(x * noiseScale, z * noiseScale, seed);
    return rp * hillH * (0.35 + 0.9 * n) + rp * 0.5 * (fbm(x * 0.25, z * 0.25, seed + 5) - 0.5);
  };
  // Soft meadow pockets scattered through the distant hills — they cut the
  // rockness down, which simultaneously (a) paints grass texture there via the
  // terrain blend, (b) lets the grass scatter seed there, and (c) attracts the
  // forest trees. One noise, three systems agreeing.
  const meadowAt = (x, z) => {
    const n = fbm(x * 0.018 + 31, z * 0.018 - 17, seed + 23);
    return smooth(Math.max(0, Math.min(1, (n - 0.42) / 0.25)));
  };
  const rocknessAt = (x, z) =>
    Math.min(1, ramp(x, z) * 1.15 + 0.15 * (fbm(x * 0.3, z * 0.3, seed + 9) - 0.5))
    * (1 - 0.85 * meadowAt(x, z));
  return { heightAt, rocknessAt, meadowAt, R, flatR, hillH };
}

export function buildEnvironment(opts = {}) {
  const b = BIOMES[opts.biome] ?? BIOMES.temperate;
  const seed = opts.seed ?? 1;
  const R = opts.radius ?? 75;
  const flatR = opts.flatRadius ?? 15;
  const hillH = opts.hillHeight ?? 12;
  const sampler = makeHeightSampler(seed, { R, flatR, hillH });

  const group = new Group();
  group.name = 'environment';

  // ---- sky dome: vertical gradient via vertex colours ---------------------
  const skyGeo = new SphereGeometry(850, 32, 16);
  const zenith = new Color(b.zenith), horizon = new Color(b.horizon);
  const spos = skyGeo.attributes.position;
  const scol = new Float32Array(spos.count * 3);
  const tmp = new Color();
  for (let i = 0; i < spos.count; i++) {
    const t = Math.max(0, Math.min(1, (spos.getY(i) / 850 + 0.15)));
    tmp.copy(horizon).lerp(zenith, smooth(t));
    scol[i * 3] = tmp.r; scol[i * 3 + 1] = tmp.g; scol[i * 3 + 2] = tmp.b;
  }
  skyGeo.setAttribute('color', new BufferAttribute(scol, 3));
  // depthWrite:false + renderOrder -1 → the dome is pure background and never
  // depth-occludes the sun or clouds (it's centered at origin, so parts of it are
  // closer to an offset camera than they are). Scene geometry still occludes them.
  const skyMesh = new Mesh(skyGeo, new MeshBasicMaterial({
    vertexColors: true, side: BackSide, fog: false, depthWrite: false,
  }));
  skyMesh.renderOrder = -1;
  group.add(skyMesh);

  // ---- terrain ring with vertex-painted grass↔rock blend ------------------
  const segs = 320; // big-world plane needs the density for hill silhouettes
  const geo = new PlaneGeometry(R * 2, R * 2, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const rockness = new Float32Array(p.count);
  // ONE packed vec4 instead of 4 separate rockVar attributes: 4 vertex buffers →
  // 1, so the geometry stays under WebGPU's hard 8-vertex-buffer cap once SPOM
  // adds the `tangent` attribute (position/normal/uv/rockness/rockVars/tangent=6).
  const rockVars = new Float32Array(p.count * 4);
  // Sequential-mix coverage thresholds staggered so 5 rock types each own
  // roughly a fifth of the hills (later selectors need lower coverage).
  const sel = [
    { f: 0.022, ox: 91, s: 41, t: 0.47 },
    { f: 0.017, ox: -47, s: 71, t: 0.53 },
    { f: 0.026, ox: 133, s: 97, t: 0.56 },
    { f: 0.014, ox: -211, s: 123, t: 0.59 },
  ];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, sampler.heightAt(x, z));
    rockness[i] = sampler.rocknessAt(x, z); // rock on the hills + noise mottling
    for (let v = 0; v < 4; v++) {
      const c = sel[v];
      rockVars[i * 4 + v] = smooth(Math.max(0, Math.min(1, (fbm(x * c.f + c.ox, z * c.f, seed + c.s) - c.t) * 6 + 0.5)));
    }
  }
  geo.setAttribute('rockness', new BufferAttribute(rockness, 1));
  geo.setAttribute('rockVars', new BufferAttribute(rockVars, 4));
  geo.computeVertexNormals();

  const tiles = (R * 2) / (opts.groundTileSize ?? 4);
  const uvA = geo.attributes.uv;
  for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * tiles, uvA.getY(i) * tiles);

  const setup = (t) => { if (t) { t.wrapS = t.wrapT = RepeatWrapping; } return t; };
  const grassT = setup(opts.groundTexture);
  const rockT = setup(opts.rockTexture);
  const terrainMat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  if (grassT && rockT) {
    // Full PBR blend by the per-vertex rockness weight: albedo, tangent-space
    // normals (linear blend of the samples, then perturb), and roughness.
    //
    // BRUSH-SHAPED BORDERS: vertex weights alone crossfade over meters — a
    // smooth airbrushed gradient no real terrain has. Each weight instead
    // sweeps through a per-pixel organic threshold from the blend-brush mask
    // (equalized histogram, so the front advances evenly): where the brush is
    // dark the material flips early, where light it holds out — ragged
    // growth-front borders (grass fingers into rock, geology interlocking)
    // with a soft 0.09 edge. Each blend samples the brush at its own
    // scale/offset so no two borders share contours.
    const brushT = setup(opts.blendBrush);
    const sharp = (wgt, s, ox, oy) => {
      if (!brushT) return wgt;
      const b = texture(brushT, uv().mul(s).add(vec2(ox, oy))).r;
      const th = b.mul(0.7).add(0.15); // brush 0..1 → threshold 0.15..0.85
      // ±0.22 feather: borders follow the brush contours but each island
      // edge still crossfades (±0.09 read as hard alpha-cutout edges).
      return wgt.smoothstep(th.sub(0.22), th.add(0.22));
    };
    const w = sharp(attribute('rockness'), 0.045, 0, 0).toVar();
    // 5 distinct rock materials (granite/slate/mossy fieldstone/limestone/
    // basalt — the temperate roster; desert_sandstone_* is banked for the
    // desert biome) chosen by low-freq vertex weights — genuinely mixed
    // geology across the hills instead of one repeating tile.
    const rock2T = setup(opts.rockTexture2);
    const rock3T = setup(opts.rockTexture3);
    const rock4T = setup(opts.rockTexture4);
    const rock5T = setup(opts.rockTexture5);
    const rv = attribute('rockVars', 'vec4');
    const v1 = sharp(rv.x, 0.031, 0.37, 0.71).toVar();
    const v2 = sharp(rv.y, 0.026, 0.13, 0.29).toVar();
    const v3 = sharp(rv.z, 0.037, 0.61, 0.47).toVar();
    const v4 = sharp(rv.w, 0.023, 0.83, 0.09).toVar();
    // Rock samples at ~7m tiles (grass keeps 4m): the 4m repeat was tuned for
    // close-up ground and reads as wallpaper across a whole hillside.
    const rockUv = uv().mul(0.55);
    // Value compression (linear-space): the variants were painted at wild
    // value poles (sRGB means — slate 56, basalt 53, limestone 186 vs granite
    // 107, fieldstone 86) — remap all three outliers toward the pack so no
    // rock reads as a hole or a highlight at distance.
    // Per-variant value remaps: the TEMPERATE roster was painted at wild value
    // poles (slate 56/basalt 53 vs limestone 186), so it needs correction. The
    // DESERT variants are generated at consistent mid values, so they blend
    // NEUTRALLY (×1, no offset) — applying the temperate remaps to them blew the
    // sandstone/scree out to white. Biome-aware.
    const isDesert = opts.biome === 'desert';
    const rm = isDesert ? [[1, 0], [1, 0], [1, 0], [1, 0]]
                        : [[2.2, 0.01], [1, 0], [0.45, 0], [2.4, 0.01]];
    let rockCol = texture(rockT, rockUv);
    if (rock2T) rockCol = mix(rockCol, texture(rock2T, rockUv).mul(rm[0][0]).add(rm[0][1]), v1);
    if (rock3T) rockCol = mix(rockCol, texture(rock3T, rockUv).mul(rm[1][0]).add(rm[1][1]), v2);
    if (rock4T) rockCol = mix(rockCol, texture(rock4T, rockUv).mul(rm[2][0]).add(rm[2][1]), v3);
    if (rock5T) rockCol = mix(rockCol, texture(rock5T, rockUv).mul(rm[3][0]).add(rm[3][1]), v4);
    // Macro luminance modulation: the SAME rock sampled far larger multiplies
    // as a light/dark patina — its repeat period beats against the base tiles
    // and the visible grid dissolves (classic macro-variation trick).
    const macro = texture(rockT, uv().mul(0.11)).r.mul(0.8).add(0.58);
    rockCol = rockCol.mul(macro);
    terrainMat.colorNode = mix(texture(grassT, uv()), rockCol, w);
    // Normals + roughness get the SAME 5-way variant blend — full independent
    // materials per rock variant, not one relief set wearing five colors.
    const gN = setup(opts.groundNormal), rN = setup(opts.rockNormal);
    const rN2 = setup(opts.rockNormal2), rN3 = setup(opts.rockNormal3);
    const rN4 = setup(opts.rockNormal4), rN5 = setup(opts.rockNormal5);
    if (gN && rN) {
      let rockNrm = texture(rN, rockUv);
      if (rN2) rockNrm = mix(rockNrm, texture(rN2, rockUv), v1);
      if (rN3) rockNrm = mix(rockNrm, texture(rN3, rockUv), v2);
      if (rN4) rockNrm = mix(rockNrm, texture(rN4, rockUv), v3);
      if (rN5) rockNrm = mix(rockNrm, texture(rN5, rockUv), v4);
      terrainMat.normalNode = normalMap(mix(texture(gN, uv()), rockNrm, w));
    } else if (gN) terrainMat.normalMap = gN;
    const rR = setup(opts.rockRoughness);
    if (rR) {
      // SAMPLER BUDGET (hard 16/stage on this adapter, and the shadow map's
      // comparison sampler takes one): per-variant roughness rides the BASE
      // rock roughness with scalar remaps, and GRASS roughness is a constant
      // — the grass map is ~uniform matte anyway, and dropping it is what
      // makes room for the blend-brush sampler.
      let rockRgh = texture(rR, rockUv).g;
      if (rock2T) rockRgh = mix(rockRgh, rockRgh.mul(0.78), v1);          // slate: cleaved faces semi-smooth
      if (rock3T) rockRgh = mix(rockRgh, rockRgh.mul(1.06).min(1), v2);   // mossy fieldstone: moss is matte
      if (rock4T) rockRgh = mix(rockRgh, rockRgh.mul(0.94), v3);          // limestone: dissolved-smooth
      if (rock5T) rockRgh = mix(rockRgh, rockRgh.mul(1.12).min(1), v4);   // basalt: matte
      terrainMat.roughnessNode = mix(float(0.88), rockRgh, w);
    }
  } else if (grassT) {
    terrainMat.map = grassT;
    if (opts.groundNormal) terrainMat.normalMap = setup(opts.groundNormal);
    if (opts.groundRoughness) terrainMat.roughnessMap = setup(opts.groundRoughness);
  } else {
    terrainMat.color = new Color(0x2f5a2a);
  }
  // Prefer the SPOM parallax-occlusion material when the caller built one (needs
  // a tangent basis for the view-space march); else the inline blend material.
  let activeMat = terrainMat;
  if (opts.terrainMaterial) {
    try { geo.computeTangents(); activeMat = opts.terrainMaterial; }
    catch (e) { console.warn('[env] SPOM tangents failed, using inline terrain material:', e); }
  }
  const terrain = new Mesh(geo, activeMat);
  terrain.receiveShadow = true;
  group.add(terrain);

  // ---- sun (glow + bright core), in a movable group -----------------------
  const sunDir = (opts.sunDirection ?? new Vector3(10, 18, 8)).clone().normalize();
  const sunColor = new Color(b.sun);
  const sun = new Group(); sun.name = 'sun';
  sun.position.copy(sunDir).multiplyScalar(700);
  // depthTest:true so the tree/terrain occlude the sun (it's in front of the sky
  // dome but behind scene geometry). depthWrite:false keeps transparent sorting.
  const glow = new Sprite(new SpriteMaterial({
    map: radialSprite(0, 128, [[0, 'rgba(255,248,224,0.9)'], [0.25, 'rgba(255,244,214,0.5)'], [1, 'rgba(255,244,214,0)']]),
    color: sunColor, blending: AdditiveBlending, depthWrite: false, depthTest: true, fog: false, transparent: true,
  }));
  glow.scale.setScalar(120); sun.add(glow);
  const core = new Sprite(new SpriteMaterial({
    map: radialSprite(0, 70, [[0, 'rgba(255,255,250,1)'], [0.5, 'rgba(255,250,235,1)'], [0.75, 'rgba(255,248,224,0.6)'], [1, 'rgba(255,248,224,0)']]),
    color: sunColor, blending: AdditiveBlending, depthWrite: false, depthTest: true, fog: false, transparent: true,
  }));
  core.scale.setScalar(34); sun.add(core);
  group.add(sun);

  // Clouds are built separately (volumetric, see core/clouds.js) and added once.

  return { group, fog: b.fog, sampler };
}
