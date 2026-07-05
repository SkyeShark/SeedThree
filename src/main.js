import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildTree, makeBarkMaterial, makeCactusBarkMaterial, makeThatchBarkMaterial, forestBarkMaterial } from './core/tree.js';
import { makeFoliageMaterial } from './core/leaf-cards.js';
import { makeYuccaMaterial } from './core/yucca-leaves.js';
import { makeSpineMaterial } from './core/cactus-spines.js';
import { buildEnvironment } from './core/environment.js';
import { buildTerrainArrays, buildTerrainMaterial } from './core/terrain-material.js';
import { buildVolumetricClouds } from './core/clouds.js';
import { bakeImpostor, disposeBillboard, assembleBillboardFromRawBake } from './core/impostor.js';
import { serializeSource } from './core/bake-transfer.js';
import { bakeBranchCards, disposeBranchCards, forestCardMaterial } from './core/branch-cards.js';
import { buildRocks } from './core/rocks.js';
import { buildGrass } from './core/grass.js';
import { buildScrub } from './core/scrub.js';
import { windStrength, windSpeed, sunDirectionUniform, WIND_DIR } from './core/wind.js';
import { Rng } from './core/rng.js';
import { downloadGLB } from './core/export-glb.js';
import { SPECIES, DEFAULT_SPECIES } from './species/index.js';
import { barkUrl, leafUrl, groundUrl } from './core/textures.js';
import { controlsFromSpecies, applySpeciesControls, buildGUI } from './ui/controls.js';
import { mountPanelFX } from './ui/panel-fx.js';
import { mountAmbience } from './audio/ambience.js';
import './ui/theme.css';
import { fog as tslFog, positionWorld, uniform, float, pass, mrt, output, normalView, mix, vec3, vec4 } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';

const hud = document.getElementById('hud');
const errBox = document.getElementById('err');
const fail = (msg) => { errBox.style.display = 'grid'; errBox.textContent = msg; console.error(msg); };

// Loading overlay — shown only for the UNAVOIDABLE slow paths (species switch:
// fresh build + grove rebuild + billboard bake all recompile GPU pipelines).
// Hero settings/seed edits reuse meshes and stay instant, so they never show it.
const loadingBox = document.getElementById('loading');
const loadingMsg = loadingBox?.querySelector('.msg');
const loadingBar = loadingBox?.querySelector('.bar-fill');
// Same living-sap-veins GPU background as the options panel, behind the loader
// card — the loop self-fits each frame so the initially-hidden card sizes fine.
const loadingCard = loadingBox?.querySelector('.card');
if (loadingCard) mountPanelFX(loadingCard);
const showLoading = () => { loadingBox?.classList.remove('fade'); loadingBox?.classList.add('on'); };
// Fade out (opacity is compositor-driven, so the fade stays smooth even if the
// main thread is still settling), then drop display:none once it's faded.
const hideLoading = () => {
  if (!loadingBox) return;
  loadingBox.classList.add('fade');
  setTimeout(() => loadingBox.classList.remove('on', 'fade'), 450);
};
// Two rAFs guarantee the browser actually PAINTS the overlay before we hand the
// main thread to the blocking pipeline compile (one rAF only queues it).
const nextPaint = () => new Promise((r) => {
  let done = false; const fin = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(() => requestAnimationFrame(fin));
  setTimeout(fin, 300); // fallback: a backgrounded/throttled tab pauses rAF — don't hang
});
// Hold the overlay until the render loop is producing FAST frames again — i.e.
// the compile freeze is genuinely over. Path-agnostic: it doesn't matter which
// pipeline compiled or in which render() call (the loop's sync render, not our
// renderAsync, is where the heavy Joshua SSS pipelines actually stall). We just
// don't lift the overlay until frames are smooth. Capped so it can never hang.
const waitForSmoothFrames = async (need = 2, quickMs = 100, maxWait = 9000) => {
  let quick = 0, waited = 0;
  while (quick < need && waited < maxWait) {
    const t = performance.now();
    await new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 500); }); // setTimeout: survive a paused/backgrounded tab
    const dt = performance.now() - t;
    waited += dt;
    quick = dt < quickMs ? quick + 1 : 0; // a slow frame = still compiling → reset
  }
};
// Progress bar + live step label. setStage writes the text/width; stageStep also
// YIELDS a paint so each step is SEEN before the next blocking chunk runs (a
// synchronous shader compile can't repaint mid-freeze — the bar would just jump).
const setStage = (text, frac) => {
  if (loadingMsg && text != null) loadingMsg.textContent = text;
  if (loadingBar && frac != null) loadingBar.style.width = `${Math.round(frac * 100)}%`;
};
const stageStep = async (text, frac) => { setStage(text, frac); await nextPaint(); };

// ---- texture loading (cached per species) --------------------------------
const loader = new THREE.TextureLoader();
async function loadTex(url, srgb) {
  if (!url) return null;
  const tex = await loader.loadAsync(url);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}
const assetCache = new Map();
async function loadSpeciesAssets(species, sunLight = null) {
  if (assetCache.has(species.name)) return assetCache.get(species.name);
  const base = species.bark.replace('_albedo.png', '');
  // Strip an optional _albedo suffix so `foo_albedo.png` → derived `foo_normal.png`
  // (matches how the user names rosette maps), while `white_oak_single.png` →
  // `white_oak_single_normal.png` still works.
  const leafBase = species.leaf.replace(/(_albedo)?\.png$/, '');
  // Derived leaf maps are optional per species (yucca has only the atlas).
  const opt = (url, srgb) => loadTex(url, srgb).catch(() => null);
  const [barkTexture, barkNormal, barkRoughness, leafTexture, leafTranslucency, leafNormal, leafRoughness, leafDryTexture, leafDryestTexture] = await Promise.all([
    loadTex(barkUrl(species.bark), true),
    opt(barkUrl(`${base}_normal.png`), false),
    opt(barkUrl(`${base}_roughness.png`), false),
    loadTex(leafUrl(species.leaf), true),
    opt(leafUrl(`${leafBase}_translucency.png`), false),
    opt(leafUrl(`${leafBase}_normal.png`), false),
    opt(leafUrl(`${leafBase}_roughness.png`), false),
    opt(leafUrl(`${leafBase}_dry_albedo.png`), true),    // dead/dry rosette (skirt near green)
    opt(leafUrl(`${leafBase}_dryest_albedo.png`), true), // driest — skirt FAR from any green top
  ]);
  const assets = { barkTexture, barkNormal, barkRoughness, leafTexture, leafTranslucency, leafNormal, leafRoughness, leafDryTexture, leafDryestTexture };
  // Create materials once per species and cache them — reused across every
  // rebuild so shape edits never recompile the foliage node material.
  if (species.cactus) {
    // Cactus bark: blend a CLEAN Codex skin with the real photo damage by a
    // low-freq world-space mask (breaks the vertical damage tiling; see
    // makeCactusBarkMaterial). Clean set is optional — falls back to plain bark.
    const [barkCleanAlbedo, barkCleanNormal, barkCleanRoughness] = await Promise.all([
      opt(barkUrl(`${base.replace(/_skin$/, '_skin_clean')}_albedo.png`), true),
      opt(barkUrl(`${base.replace(/_skin$/, '_skin_clean')}_normal.png`), false),
      opt(barkUrl(`${base.replace(/_skin$/, '_skin_clean')}_roughness.png`), false),
    ]);
    assets.barkCleanAlbedo = barkCleanAlbedo;
    assets.barkCleanNormal = barkCleanNormal;
    assets.barkCleanRoughness = barkCleanRoughness;
    assets.barkDamage = species.barkDamage ?? 0.35;
    assets.barkMat = makeCactusBarkMaterial(assets);
    // Spines = crossed alpha cards (own material). Pass the sun so the spine glow
    // samples the real cast-shadow map (body self-shadow).
    assets.spineMat = makeSpineMaterial(assets, sunLight);
  } else {
    assets.barkMat = makeBarkMaterial(assets);
  }
  // Thatch bark (dead-leaf sleeve) — clads the tube on reduced/mobile LODs where the
  // skirt geometry is dropped (skirtToBark). Its own bark material, cached per species.
  if (species.thatchBark) {
    const tb = species.thatchBark.replace('_albedo.png', '');
    const [thA, thN, thR] = await Promise.all([
      loadTex(barkUrl(species.thatchBark), true),
      opt(barkUrl(`${tb}_normal.png`), false),
      opt(barkUrl(`${tb}_roughness.png`), false),
    ]);
    assets.thatchTexture = thA; assets.thatchNormal = thN; assets.thatchRoughness = thR;
    // Layered: thatch clads the branches up top, real BARK on the bare lower trunk.
    assets.thatchBarkMat = makeThatchBarkMaterial(assets);
  }
  if (!species.cactus && species.foliageType === 'rosette') {
    // Rosette species: one spike-leaf material at every LOD (no card system).
    const yucca = makeYuccaMaterial(assets, species.foliage);
    assets.rosetteMat = yucca.material;
    // Per-age-stage frond tints + dryness (GUI pickers apply these live).
    assets.frondGreenTint = yucca.greenTint;
    assets.frondDryTint = yucca.dryTint;
    assets.frondDryestTint = yucca.dryestTint;
    assets.frondDryness = yucca.dryness;
  } else {
    // Two foliage materials: single-leaf (LOD0) and cluster (LOD1+). Cached & reused.
    const leafFol = makeFoliageMaterial(assets, { ...species.foliage, mode: 'leaves' });
    assets.leafMat = leafFol.material; assets.leafCenter = leafFol.centerUniform;
    assets.leafTintNode = leafFol.tintNode; assets.leafTintAmount = leafFol.tintAmount;
    const clusterFol = makeFoliageMaterial(assets, { ...species.foliage, mode: 'clusters' });
    assets.clusterMat = clusterFol.material; assets.clusterCenter = clusterFol.centerUniform;
    assets.clusterTintNode = clusterFol.tintNode; assets.clusterTintAmount = clusterFol.tintAmount;
  }
  assetCache.set(species.name, assets);
  return assets;
}

// ---- triangle counting ----------------------------------------------------
function countTriangles(group) {
  let tris = 0;
  group.traverse((o) => {
    if (!o.geometry) return;
    const g = o.geometry;
    const n = g.index ? g.index.count : g.attributes.position.count;
    tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  return Math.round(tris);
}

function disposeTree(group) {
  // Geometry only — tree materials are cached per species and reused across
  // rebuilds. Billboard cards are the exception: their baked textures/materials
  // are per-tree, so they go too.
  group.traverse((o) => {
    // Shared geometry (baked branch-card quads) is cached across rebuilds.
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    if (o.userData.isBillboardCard) {
      o.material.map?.dispose();
      o.material.normalMap?.dispose();
      o.material.roughnessMap?.dispose();
      o.material.userData.gltfDiffuseTransmission?.map?.dispose();
      o.material.dispose();
    }
  });
}

async function main() {
  const app = document.getElementById('app');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcfd8e6);
  // Light haze fallback; buildBiome re-syncs color + range to the biome sky. (Was a
  // near-black 0x0b0f14 that washed the grove to black under any forced LOD preview.)
  scene.fog = new THREE.Fog(0xcfd8e6, 95, 300);

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1600);
  camera.position.set(16, 13, 20);

  // The 5-way terrain blend samples 18 textures in one shader (3 grass + 5
  // rock albedo/normal/roughness sets); WebGPU's default limit is 16 per
  // stage, so ask the adapter for more (desktop GPUs support 100+).
  // (Samplers stay at the default 16 — three dedupes them by descriptor, and
  // this adapter caps samplers at 16 while allowing 48 sampled textures.)
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    requiredLimits: { maxSampledTexturesPerShaderStage: 32 },
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  app.appendChild(renderer.domElement);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Filmic response: highlights roll off instead of clipping, foliage greens
  // stop looking radioactive under full sun. (Applies only to the canvas pass —
  // the impostor/card bakes render to RTs, which stay linear/unlit.)
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3; // ez-tree calibration: brighter grade sells the meadow
  await renderer.init();
  const backend = renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2 (fallback)';

  // Off-thread impostor baker: its own OffscreenCanvas WebGPU device = its own GPU
  // queue, so re-baking the far-LOD billboard never stalls the viewer. Promise-based
  // request/response keyed by id. Falls back to null (no worker) → main-thread bake.
  let bakeWorker = null;
  const bakePending = new Map();
  let bakeReqId = 0;
  try {
    bakeWorker = new Worker(new URL('./core/bake-worker.js', import.meta.url), { type: 'module' });
    const off = new OffscreenCanvas(64, 64);
    bakeWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'baked') { bakePending.get(m.id)?.resolve(m); bakePending.delete(m.id); }
      else if (m.type === 'error') { console.error('[bake-worker]', m.where, m.message); bakePending.get(m.id)?.reject(new Error(m.message)); bakePending.delete(m.id); }
      else if (m.type === 'ready') console.log('[bake-worker] ready:', m.backend);
    };
    bakeWorker.onerror = (e) => console.error('[bake-worker] fatal', e.message || e);
    bakeWorker.postMessage({ type: 'init', canvas: off }, [off]);
  } catch (e) { console.error('[bake-worker] spawn failed', e); bakeWorker = null; }


  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 8.5, 0);
  controls.maxDistance = 300; // = the billboard-distance slider's max: you can
  controls.minDistance = 2;   // always zoom far enough to see the last LOD, no further
  // Orbit auto-rotate (ez-tree parity) — the anim loop already calls controls.update().
  const camState = { autoRotate: false, autoRotateSpeed: 1.0 };
  const applyCamera = () => { controls.autoRotate = camState.autoRotate; controls.autoRotateSpeed = camState.autoRotateSpeed; };

  const sunState = { az: 40, el: 32 }; // late-afternoon default — warmer light, longer shadows
  const sunDirWorld = () => {
    const a = sunState.az * Math.PI / 180, e = sunState.el * Math.PI / 180;
    return new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
  };
  const sunLight = new THREE.DirectionalLight(0xfff2e0, 3.0);
  sunLight.position.copy(sunDirWorld().multiplyScalar(100));
  // Shadows drive translucency accumulation: leaves stacked between a leaf and the
  // sun shadow it, so its transmission (which uses the shadowed light) dims.
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(4096, 4096);
  sunLight.shadow.bias = -0.0003;
  // Nearly zero: receiver normal offset eats shadows cast by small things (20cm
  // grass blades vanish at 0.2). Rock terminator acne is fixed at the SOURCE
  // instead — shadowSide: BackSide on the rock material (closed geometry).
  sunLight.shadow.normalBias = 0.04;
  // Frustum covers the hero, its long ground shadow, AND the forest ring — the
  // instanced trees self-shadow with the real map (4096² keeps the hero crisp).
  Object.assign(sunLight.shadow.camera, { left: -74, right: 74, top: 76, bottom: -30, near: 1, far: 340 });
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.target.position.set(0, 7, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);
  scene.add(new THREE.HemisphereLight(0x9fc0ff, 0x3a4a2a, 1.2));

  // Human-height (1.8m) reference box for visual scale comparison, GUI-toggled.
  const scaleRef = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 1.8, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xff5a3c, roughness: 0.7 })
  );
  scaleRef.position.set(5, 0.9, 3);
  scaleRef.visible = false;
  scene.add(scaleRef);
  const envState = { showScaleRef: false, fog: true, forestCount: 64, spom: false, gtao: false, aa: true }; // SPOM + GTAO OFF by default; MSAA antialiasing ON

  // ---- Post-processing: Ground-Truth Ambient Occlusion ----------------------
  // Canonical three.js WebGPU GTAO: an MRT scene pass exposes color + view
  // normals + depth; the GTAO node computes horizon-based occlusion which we
  // multiply into the scene color. It grounds the tree — contact darkening in
  // leaf clusters, branch crotches, where trunks meet terrain. Toggle sits next
  // to SPOM (default OFF).
  //
  // Two DISTINCT artifacts the far-LOD impostor/forest/cluster cards would suffer
  // (they're flat billboards with BENT normals — rounded outward so a flat card
  // lights like a volume):
  //   1. BLACKOUT (whole card black) — normal-driven: the bent normals point away
  //      from camera, so GTAO reads the surface as fully self-occluded (AO→0).
  //   2. CREASE SHADOWS (dark X-seam) — depth-driven: AO darkens the concave
  //      valley where the two crossed cards intersect — the very seam bent normals
  //      exist to hide.
  // Both are fixed the same correct way: EXCLUDE those cards from AO with a mask.
  // The scene pass carries an extra `aomask` channel — real geometry writes 1
  // (apply AO), the baked cards override it to 0 (see impostor.js/branch-cards.js
  // mrtNode). The composite lerps AO→1 where mask=0, so cards keep their bent
  // normals (no crease) and never darken (no blackout), while the hero mesh, leaf
  // cards, bark and terrain get full real-normal AO.
  //
  // The scene ALWAYS renders through the pipeline (never a direct canvas render):
  // that keeps the card materials' 3-target MRT output in an MRT context, so the
  // GTAO-off path can't hit a single-target mismatch (which would drop the cards).
  // The toggle just swaps the pipeline's output node (AO composite vs plain
  // color) — flipping it recompiles once. RenderPipeline applies tone mapping +
  // color space at output, so the pass renders linear HDR and our ACES grade
  // still lands once at the end.
  const postProcessing = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: normalView, aomask: float(1) })); // default 1: real geo gets AO
  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassNormal = scenePass.getTextureNode('normal');
  const scenePassDepth = scenePass.getTextureNode('depth');
  const aoMask = scenePass.getTextureNode('aomask'); // 1 = apply AO, 0 = card (skip)
  const aoPass = ao(scenePassDepth, scenePassNormal, camera);
  aoPass.resolutionScale = 0.5; // half-res AO: plenty for foliage, ~4× cheaper
  aoPass.radius.value = 0.5;    // meters — contact radius across leaf clusters/crotches
  aoPass.distanceExponent.value = 1.0;
  // Card pixels (mask 0) → AO forced to 1 (no darkening); real geo (mask 1) → real AO.
  const aoFactor = mix(float(1), aoPass.getTextureNode().r, aoMask.r);
  // AO factor is a scalar — broadcast to rgb (keep alpha) before multiplying.
  const AO_OUTPUT = scenePassColor.mul(vec4(vec3(aoFactor), 1));
  const setAOOutput = () => { // swap composite on toggle (one-time recompile)
    postProcessing.outputNode = envState.gtao ? AO_OUTPUT : scenePassColor;
    postProcessing.needsUpdate = true;
  };
  setAOOutput();
  // Always render through the pipeline (see note above); the toggle only changes
  // which output node is composited, never the render path.
  const renderFrame = () => postProcessing.render();
  // Antialiasing toggle (Environment, like SPOM/GTAO). Because the scene now
  // always renders into the pipeline's pass, MSAA lives on that pass — it inherits
  // the renderer's `antialias: true` (4 samples) by default. Toggling flips the
  // pass's sample count, recreates its render target at the new count, and rebuilds
  // the pipeline. Default ON.
  const applyAA = () => {
    const samples = envState.aa ? 4 : 0;
    if ((scenePass.options.samples ?? 4) === samples) return;
    scenePass.options.samples = samples;
    scenePass.renderTarget.dispose();  // force the RT to recreate at the new sample count
    postProcessing.needsUpdate = true; // rebuild the pass + composite pipeline
  };
  const windState = { strength: 0.5, speed: 1.0 };
  const applyWind = () => { windStrength.value = windState.strength; windSpeed.value = windState.speed; };
  applyWind();

  // Ambient soundscape: bottom-left mute toggle. Procedural wind bed + random
  // bird calls, swapped per biome (buildBiome calls setBiome). Starts silent —
  // the button is the user gesture that unlocks Web Audio.
  const ambience = mountAmbience();
  // VOLUMETRIC ring haze (not camera fog): density is a function of WORLD
  // position — it pools toward the terrain rim and hugs low altitude, so the
  // world edge melts away no matter where the camera stands. Auto-dropped
  // while a preview level is forced, or via the Environment toggle.
  const hazeColor = uniform(new THREE.Color(0xcfd8e6));
  const hazeDensity = uniform(1.0); // biome dial: desert dust is thicker...
  const hazeStart = uniform(110);   // ...AND starts closer, so the pale tan dust
                                    // reads from the same near distance as the
                                    // temperate haze (else it's invisible near).
  // Two layers: rolling low-altitude haze from hazeStart out, plus a HARD WALL
  // over the last ~30m that reaches full density at any altitude — the terrain rim
  // simply never exists.
  const hazeRadial = positionWorld.xz.length();
  const hazeNode = tslFog(
    hazeColor,
    hazeRadial.smoothstep(hazeStart, hazeStart.add(140))
      .mul(positionWorld.y.max(0).mul(-0.045).exp()).mul(float(0.9).mul(hazeDensity))
      .add(hazeRadial.smoothstep(float(245), float(278)))
      .clamp(0, 1)
  );
  const applyFog = () => { scene.fogNode = (envState.fog && optState.preview === 'auto') ? hazeNode : null; };

  function updateSun() {
    const dir = sunDirWorld();
    sunLight.position.copy(dir).multiplyScalar(100);
    sunDirectionUniform.value.copy(dir); // shared with shadow-frustum-external materials
    // Sun behaves like a sun: warms and dims toward the horizon (golden hour),
    // cool bright white overhead.
    const t = Math.min(1, Math.max(0, sunState.el / 60)); // 0 = horizon, 1 = high
    sunLight.color.setHSL(0.095 + 0.045 * t, 0.55 - 0.35 * t, 0.62 + 0.24 * t);
    sunLight.intensity = 2.2 + 1.1 * t;
    const s = environment?.getObjectByName('sun');
    if (s) s.position.copy(dir).multiplyScalar(700); // outside the far hills, inside the 850 sky dome
  }

  // Environment (sky, terrain ring, biome ground+rock, sun, clouds) — per biome.
  let environment = null;
  let currentSampler = null; // terrain height sampler, for decoration + forest placement
  async function buildBiome(species) {
    const isDesert = (species.biome ?? 'temperate') === 'desert';
    document.body.classList.toggle('biome-desert', isDesert); // UI → amber in the desert
    ambience.setBiome(isDesert ? 'desert' : 'temperate'); // swap wind tuning + bird roster
    if (environment) { scene.remove(environment); environment.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
    const groundBase = (species.groundTexture ?? 'grass_albedo.png').replace('_albedo.png', '');
    const rockBase = (species.rockTexture ?? 'rock_albedo.png').replace('_albedo.png', '');
    // Base ground + base rock (albedo/normal/roughness) — must exist per species.
    const [groundTexture, groundNormal, groundRoughness, rockTexture, rockNormal, rockRoughness] = await Promise.all([
      loadTex(groundUrl(`${groundBase}_albedo.png`), true),
      loadTex(groundUrl(`${groundBase}_normal.png`), false),
      loadTex(groundUrl(`${groundBase}_roughness.png`), false),
      loadTex(groundUrl(`${rockBase}_albedo.png`), true),
      loadTex(groundUrl(`${rockBase}_normal.png`), false),
      loadTex(groundUrl(`${rockBase}_roughness.png`), false),
    ]);
    // 4 rock VARIANTS for the anti-tiling vertex blend — a BIOME-SPECIFIC roster
    // (albedo + normal each; per-variant roughness is a scalar remap in
    // environment.js, to stay under the 16-samplers-per-stage cap). Missing files
    // degrade gracefully (null → the shader's `if (rockNT)` guard skips them).
    const tryTex = (name, srgb) => loadTex(groundUrl(name), srgb).catch(() => null);
    const variantBases = isDesert
      ? ['desert_rock2', 'desert_rock3', 'desert_rock4', 'desert_sandstone'] // muted SW roster + warm accent
      : ['rock2', 'rock3', 'rock4', 'rock5'];                                 // temperate granite/slate/limestone/basalt
    const [rockTexture2, rockTexture3, rockTexture4, rockTexture5] =
      await Promise.all(variantBases.map((b) => tryTex(`${b}_albedo.png`, true)));
    const [rockNormal2, rockNormal3, rockNormal4, rockNormal5] =
      await Promise.all(variantBases.map((b) => tryTex(`${b}_normal.png`, false)));
    const blendBrush = await tryTex('blend_brush.png', false);
    // SPOM parallax-occlusion terrain material (texture-array splatting + height
    // march, terrain-material.js). Same rock roster as above; the HEIGHT maps in
    // the normal-array alpha drive the relief. Desert passes NEUTRAL layer tints
    // (its textures are already mid-value). Falls back to the inline blend
    // material in environment.js if the array build throws.
    let terrainMaterial = null;
    if (envState.spom) try { // parallax terrain only when the toggle is on (heavy march)
      const groundHeight = await loadTex(groundUrl(`${groundBase}_height.png`), false).catch(() => null);
      const layerBases = [rockBase, ...variantBases];
      const layers = layerBases.map((b) => ({
        albedo: groundUrl(`${b}_albedo.png`), normal: groundUrl(`${b}_normal.png`),
        roughness: groundUrl(`${b}_roughness.png`), height: groundUrl(`${b}_height.png`),
      }));
      const { albedoArray, normalArray } = await buildTerrainArrays(layers);
      terrainMaterial = buildTerrainMaterial({
        albedoArray, normalArray, layerCount: layers.length,
        grassAlbedo: groundTexture, grassNormal: groundNormal, blendBrush,
        groundHeight, groundParallax: isDesert, // desert gravel floor parallaxes too
        sunDir: sunDirectionUniform, // POM self-shadow marches toward this (tracks the sun)
        // per-material push: [desert_rock chunky, sandstone soft, caliche cracks,
        // scree chunky, sandstone soft]; the fine noisy gravel floor gets a very
        // subtle push. Tune to taste.
        layerDepthScale: isDesert ? [1.3, 0.6, 1.0, 1.4, 0.5] : undefined,
        groundDepthScale: isDesert ? 0.4 : 1,
        layerTint: isDesert ? layerBases.map(() => [1, 0, 0]) : undefined,
        layerRoughRemap: isDesert ? layerBases.map(() => 1) : undefined,
      });
    } catch (e) { console.warn('[biome] SPOM terrain build failed → inline material:', e); }
    console.log('[biome] terrain material:', terrainMaterial ? 'SPOM (parallax on)'
      : (envState.spom ? 'INLINE FALLBACK (SPOM build failed)' : 'INLINE (SPOM off — default)'));
    const { group, fog, sampler } = buildEnvironment({
      groundTexture, groundNormal, groundRoughness, rockTexture, rockNormal, rockRoughness,
      rockTexture2, rockTexture3, rockNormal2, rockNormal3,
      rockTexture4, rockNormal4, rockTexture5, rockNormal5, blendBrush, terrainMaterial,
      sunDirection: sunDirWorld(), biome: species.biome ?? 'temperate', seed: state.controls.seed,
      radius: 280, // big world — decoration + haze + camera lock are scaled to it
    });
    currentSampler = sampler;
    // Scene decoration: scatter rocks always; grass only in grassy biomes. Both
    // live inside the environment group so biome swaps dispose them, and both
    // follow the terrain height sampler out across the hills.
    group.add(buildRocks({
      rockTexture, rockNormal, rockRoughness, sampler,
      seed: state.controls.seed, flatRadius: 15,
      count: (species.biome ?? 'temperate') === 'desert' ? 44 : 32,
    }));
    if (!isDesert) {
      const [tuftTexture, tuftNormal, tuftRoughness] = await Promise.all([
        loadTex(leafUrl('grass_tuft.png'), true),                       // foliage cards live in assets/leaves/ now
        loadTex(leafUrl('grass_tuft_normal.png'), false).catch(() => null),
        loadTex(leafUrl('grass_tuft_roughness.png'), false).catch(() => null),
      ]);
      const grass = buildGrass({ tuftTexture, tuftNormal, tuftRoughness, sampler, seed: state.controls.seed, flatRadius: 15 });
      if (grass) group.add(grass);
    } else {
      // Desert scrub in place of grass: sagebrush / blackbrush / creosote alpha
      // cards (skipped gracefully until Codex paints them).
      const scrubDefs = [
        { base: 'sagebrush',  tint: [0.62, 0.68, 0.52], height: 0.55, share: 1.1, quads: 9, transmit: [0.32, 0.40, 0.20] }, // silver-green, rounded
        { base: 'blackbrush', tint: [0.48, 0.49, 0.42], height: 0.48, share: 1.0, quads: 8, transmit: [0.24, 0.30, 0.16] }, // dark grey-green, twiggy
        { base: 'creosote',   tint: [0.50, 0.62, 0.40], height: 0.80, share: 0.9, quads: 7, transmit: [0.30, 0.44, 0.18] }, // olive, taller/open
      ];
      const shrubs = await Promise.all(scrubDefs.map(async (d) => ({
        ...d,
        texture: await loadTex(leafUrl(`${d.base}_albedo.png`), true).catch(() => null),
        normal: await loadTex(leafUrl(`${d.base}_normal.png`), false).catch(() => null),
        translucency: await loadTex(leafUrl(`${d.base}_translucency.png`), false).catch(() => null),
      })));
      const scrub = buildScrub({ shrubs, sampler, seed: state.controls.seed, flatRadius: 15 });
      if (scrub) group.add(scrub);
    }
    scene.add(group);
    // Desert = light TAN suspended dust (NOT orange), thick enough to read from
    // the same near distance as temperate haze. Temperate = cool haze warmed a
    // touch toward rock dust.
    if (isDesert) { hazeColor.value.set(0xcabfa2); hazeDensity.value = 1.9; hazeStart.value = 40; }
    else { hazeColor.value.set(fog).lerp(new THREE.Color(0xa8998a), 0.18); hazeDensity.value = 1.0; hazeStart.value = 110; }
    applyFog();
    scene.background = new THREE.Color(fog);
    // Keep the CLASSIC linear fog (the fallback used whenever the TSL hazeNode is
    // dropped — e.g. any forced LOD/billboard preview) in sync with the sky. It was
    // left at the near-black init color and never updated per biome, so previewing a
    // level washed everything past 40 m to black (the "darkness wash", and why the
    // fogged-out forest read as leafless). Match it to the sky and push it back so it
    // reads as gentle distance haze, not a black curtain over the grove.
    scene.fog.color.set(fog);
    scene.fog.near = isDesert ? 55 : 95;
    scene.fog.far = isDesert ? 230 : 300;
    environment = group;
  }

  // ---- state + rebuild ----------------------------------------------------
  const state = {
    speciesKey: DEFAULT_SPECIES,
    controls: controlsFromSpecies(SPECIES[DEFAULT_SPECIES]),
  };
  // Optimization panel: LOD preview/forcing, switch distances, billboard bake.
  // Defaults keep the stock camera framing (~29m) inside LOD0 hero quality.
  const optState = {
    preview: 'auto', meshQuality: 1,
    lod1Dist: 35, lod2Dist: 70, billboardDist: 120,
    lod1Pct: 50, lod2Pct: 15,         // triangle budgets as % of LOD0 (solved for)
    lod1Density: 1, lod1Prune: 0,     // look dials (budget compensates)
    lod2Density: 1, lod2Prune: 0.35,
    cardRes: 512, cardVariants: 3,
    billboardRes: 1024,
    mobileTarget: false, // card-first LOD ladder (LOD2 baked cards → LOD0 + 2 cheaper LODs)
  };
  let currentTree = null;
  let needsRebuild = false;
  let rebuilding = false;
  let lastChangeAt = 0;
  const requestRebuild = () => { needsRebuild = true; lastChangeAt = performance.now(); };

  // Mobile Performance Target LOD wiring. The full-detail mesh LODs (hiddenInApp)
  // are parked at an unreachable distance so THREE.LOD never selects them — they
  // stay built (bake source + what the shape/foliage dials edit) but never render.
  // The baked-card LOD2 becomes the visible near LOD (distance 0); the two extra
  // card LODs (LOD3/LOD4) and the billboard sit beyond it. The Optimization
  // distance sliders retarget by name: LOD1→LOD3, LOD2→LOD4, Billboard→BB. No-op
  // (returns) in desktop mode, so the normal LOD distance logic is untouched.
  const HIDE_DIST = 1e7;
  // A tree is a "mobile tree" only if it was actually BUILT with a mobile ladder
  // (hidden mesh LODs). Both paths build one under mobileTarget — the card ladder
  // (temperate) and the rosette/cactus ladder (skirtToBark + cone LOD3/LOD4) — and
  // both park LOD0/LOD1 as hiddenInApp. Gating on that flag keeps applyLodMobile
  // off trees built BEFORE the toggle flipped (they rebuild into the ladder next).
  const isMobileTree = (tree) => !!tree?.levels?.some((l) => l.object.userData.hiddenInApp);
  function applyLodMobile(tree) {
    if (!tree || !optState.mobileTarget || !isMobileTree(tree)) return;
    for (const l of tree.levels) {
      const nm = l.object.userData.lodName;
      if (l.object.userData.hiddenInApp) l.distance = HIDE_DIST; // LOD0/LOD1 mesh: never shown
      else if (nm === 'LOD2') l.distance = 0;                    // near card LOD (new effective LOD0)
      else if (nm === 'LOD3') l.distance = optState.lod1Dist;    // extra card #1
      else if (nm === 'LOD4') l.distance = optState.lod2Dist;    // extra card #2
      else if (nm === 'BB') l.distance = optState.billboardDist;
    }
    tree.levels.sort((a, b) => a.distance - b.distance); // THREE.LOD selects assuming ascending order
  }

  // Baked branch cards, cached per (species, leaf params, levels) — built from a
  // FIXED exemplar seed inside bakeBranchCards, so reseeding reuses the cache.
  const cardCache = new Map();
  async function ensureBranchCards(species, shaped) {
    if (species.foliageType === 'rosette') return null; // real geometry at every LOD
    if (!shaped.foliage || (shaped.foliage.leavesPerBranch ?? 1) <= 0) return null;
    // Mobile bakes EXTRA whole-limb card sets (its LOD3/LOD4 collapse limbs into
    // cards), so the toggle keys its own cache entry.
    const key = `${species.name}|${shaped.foliage.size}|${shaped.foliage.leavesPerBranch}|${shaped.params.levels}|${optState.cardRes}|${optState.cardVariants}|${optState.mobileTarget ? 'm' : 'd'}`;
    let cards = cardCache.get(key);
    if (cards) return cards;
    const assets = assetCache.get(species.name);
    // Card sets to bake, keyed `level:content` (mirrors the rungs in tree.js
    // lodLevels). Hybrid keepTwigs levels need FOLIAGE-ONLY per-twig cards (the
    // real tubes render — a tube in the card doubles every twig); collapse levels
    // need the full twig+leaves content. Desktop's hybrid LOD2 uses only the fol
    // set; mobile adds the two collapse sets (per-twig full + one-level-up limbs).
    const maxLevel = (shaped.params.levels ?? 3) - 1;
    const jobs = [{ level: maxLevel, foliageOnly: true }];
    if (optState.mobileTarget) {
      jobs.push({ level: maxLevel, foliageOnly: false });
      jobs.push({ level: Math.max(1, maxLevel - 1), foliageOnly: false });
    }
    baking = true; // the bake re-targets the renderer — pause the main loop
    const byLevel = new Map();
    try {
      for (const job of jobs) {
        const jobKey = `${job.level}:${job.foliageOnly ? 'fol' : 'full'}`;
        if (byLevel.has(jobKey)) continue; // clamped levels can collide on tiny trees
        const set = await bakeBranchCards(renderer, shaped, assets, {
          size: optState.cardRes, variants: optState.cardVariants,
          cardLevel: job.level, foliageOnly: job.foliageOnly,
          // Limb-level sets place as crossed pairs — no flutter (it tears the pair).
          noFlutter: job.level < maxLevel,
        });
        if (set) byLevel.set(jobKey, set);
      }
    } catch (e) {
      console.error('[SeedThree] branch card bake failed:', e);
    } finally {
      baking = false;
    }
    const near = byLevel.get(`${maxLevel}:fol`) ?? byLevel.get(`${maxLevel}:full`);
    if (!near) return null; // no usable cards → fall back to cluster foliage
    // Facade: byLevel drives the LOD builder; variants/centerUniform alias the
    // near per-twig set for the forest rebinner + billboard bake (back-compat).
    cards = { byLevel, variants: near.variants, centerUniform: near.centerUniform };
    cardCache.set(key, cards);
    if (cardCache.size > 6) { // keep VRAM bounded when params churn
      const [oldKey, old] = cardCache.entries().next().value;
      if (oldKey !== key) { cardCache.delete(oldKey); disposeBranchCards(old); }
    }
    return cards;
  }

  // Live material tweaks (ez-tree parity: leaf/bark tint, alpha, flat-shading).
  // Materials are cached per species and reused across rebuilds, so these edit the
  // cached material in place — no rebuild, no recompile for color (a uniform);
  // alphaTest/flatShading only flip needsUpdate when the value actually changes, so
  // they don't recompile every rebuild. Re-applied at the end of each rebuild so a
  // preset load (which reuses a cached material) still takes effect.
  function applyMaterialTweaks() {
    const a = assetCache.get(SPECIES[state.speciesKey].name);
    if (!a) return;
    const c = state.controls;
    // Leaf tint = luminance-preserving colorize (uniforms, no recompile): a target
    // color + an amount that interpolates the leaf texture toward it.
    if (c.leafColorize !== undefined) { a.leafTintNode?.value.set(c.leafColorize); a.clusterTintNode?.value.set(c.leafColorize); }
    if (c.leafTintAmount !== undefined) { if (a.leafTintAmount) a.leafTintAmount.value = c.leafTintAmount; if (a.clusterTintAmount) a.clusterTintAmount.value = c.leafTintAmount; }
    if (c.leafAlpha !== undefined) for (const m of [a.leafMat, a.clusterMat]) if (m && m.alphaTest !== c.leafAlpha) { m.alphaTest = c.leafAlpha; m.needsUpdate = true; }
    // Bark tint: the bark material (cactus) overrides diffuse with colorNode, so
    // its tint is a uniform; the standard bark material uses mat.color.
    if (c.barkTint !== undefined) {
      if (a.barkMat?.userData?.barkTint) {
        const lin = new THREE.Color(c.barkTint).convertSRGBToLinear();
        a.barkMat.userData.barkTint.value.set(lin.r, lin.g, lin.b); // Vector3 uniform
      } else a.barkMat?.color.set(c.barkTint);
    }
    if (c.barkFlat !== undefined && a.barkMat && a.barkMat.flatShading !== c.barkFlat) { a.barkMat.flatShading = c.barkFlat; a.barkMat.needsUpdate = true; }
    // Cactus BARK damage coverage (clean↔scarred blend). Live uniform, no rebuild.
    if (c.barkDamage !== undefined && a.barkMat?.userData?.barkDamage) a.barkMat.userData.barkDamage.value = c.barkDamage;
    // Seed offsets the world-space damage noise so a new generation reshuffles the
    // scar layout (the hero sits at a fixed origin, so without this the pattern
    // would be identical across seeds).
    if (a.barkMat?.userData?.barkSeed) {
      const h = Math.abs(Math.sin((Number(c.seed) || 0) * 12.9898) * 43758.5453);
      a.barkMat.userData.barkSeed.value.set((h % 10), ((h * 1.37) % 10), ((h * 2.71) % 10));
    }
    // Rosette FRONDS (Joshua/yuccas): per-age-stage tints multiply their albedo,
    // so hold them LINEAR (convertSRGBToLinear) to match the linearized texture.
    if (c.frondGreenTint !== undefined) a.frondGreenTint?.value.set(c.frondGreenTint).convertSRGBToLinear();
    if (c.frondDryTint !== undefined) a.frondDryTint?.value.set(c.frondDryTint).convertSRGBToLinear();
    if (c.frondDryestTint !== undefined) a.frondDryestTint?.value.set(c.frondDryestTint).convertSRGBToLinear();
    if (c.frondDryness !== undefined && a.frondDryness) a.frondDryness.value = c.frondDryness;
    // Cactus SPINES: material keeps mat.color (no colorNode override) → tint like bark.
    if (c.spineTint !== undefined) a.spineMat?.color.set(c.spineTint);
  }

  // onStage(text, frac) is the loading-screen progress reporter. It's only passed
  // on the heavy (species-switch / first-load) path; the fast reuse path calls
  // rebuild() with no arg, so `onStage?.()` is a no-op and injects no frame yields.
  async function rebuild(onStage = null, deferBake = false) {
    if (rebuilding) { needsRebuild = true; return; } // never overlap rebuilds
    rebuilding = true;
    billboardDirty = true; // plant is changing → impostor is stale until a preview/export re-bakes it
    try {
      const species = SPECIES[state.speciesKey];
      await onStage?.('Loading textures & materials', 0.2);
      const assets = await loadSpeciesAssets(species, sunLight);
      const shaped = applySpeciesControls(species, state.controls);
      await onStage?.('Baking branch cards', 0.32);
      const branchCards = await ensureBranchCards(species, shaped);
      currentCards = branchCards; // forest needs the canopy-centre uniform
      await onStage?.('Growing skeleton, branches & foliage', 0.45);
      // Reuse the existing hero LOD when only settings/seed changed within the
      // SAME rosette species — buildTree rewrites its meshes' buffers in place so
      // WebGPU doesn't recompile pipelines (the per-edit freeze). Species switch
      // or non-rosette species → fresh build + disposeTree as before.
      const reuse = (currentTree && species.foliageType === 'rosette'
        && currentTree.userData?.species === species.name
        && currentTree.userData?.mobileBuilt === optState.mobileTarget) ? currentTree : null; // toggling mobile changes LOD distances → fresh build
      const { group } = buildTree(shaped, state.controls.seed, assets, {
        lod1Dist: optState.lod1Dist, lod2Dist: optState.lod2Dist, meshQuality: optState.meshQuality,
        lod1Pct: optState.lod1Pct, lod2Pct: optState.lod2Pct,
        lod1Density: optState.lod1Density, lod1Prune: optState.lod1Prune,
        lod2Density: optState.lod2Density, lod2Prune: optState.lod2Prune,
        mobileTarget: optState.mobileTarget,
        branchCards,
      }, reuse);
      const speciesChanged = forestSpecies !== state.speciesKey;
      if (speciesChanged) clearForest(); // release old grove (shares old billboard mats) before disposing the tree
      if (currentTree && currentTree !== group) { scene.remove(currentTree); disposeTree(currentTree); }
      currentTree = group;
      if (!group.parent) scene.add(group);
      applyLodMobile(group); // mobile: park hidden mesh LODs, retarget card-LOD distances
      // Grove = the species' default tree, built ONCE per selection; hero edits
      // (settings/seed) never touch it. Frozen until you switch species.
      if (speciesChanged) {
        forestSpecies = state.speciesKey;
        await onStage?.('Planting the grove', 0.58);
        updateForest(group);
        forestPendingBillboard = true;
      }
      updateStats(species, group);
      applyMaterialTweaks(); // re-assert leaf/bark tint/alpha/flat onto the (cached) materials
      // Billboard impostor (far LOD) is baked ONCE per species, then FROZEN — same
      // policy as the grove. The bake does a blocking RT readback + a new-material
      // compile; running it after every edit-settle was the residual ~0.8s freeze
      // that hit ~600ms AFTER the (now instant) hero update. The hero reflects edits
      // live; the far impostor stays the species default (matches the frozen grove).
      // Species switch re-bakes; the GUI 'rebake' action still forces one on demand.
      // deferBake = heavyRebuild will run the bake itself (behind the overlay), so
      // don't ALSO schedule a stray one that could fire after the overlay lifts.
      // Re-bake the far-LOD billboard after ANY change (debounced). It runs on the
      // OFF-THREAD worker (own GPU queue) so the viewer never stalls — the corner
      // loader shows progress. Grove is a frozen decoupled snapshot, untouched.
      if (!deferBake) scheduleBillboardBake();
    } finally {
      rebuilding = false;
    }
  }

  let statsText = '';
  let fpsDisplay = '—';
  const refreshHud = () => { hud.textContent = `${fpsDisplay} fps\n${statsText}`; };
  function updateStats(species, group) {
    const u = group.userData;
    // Show only the levels the app actually RENDERS. Mobile Target parks the full
    // mesh LODs off-screen (hiddenInApp) — skip those, and renumber the visible
    // levels 0,1,2… by draw order so the HUD reads LOD0/LOD1/LOD2 even though the
    // near one is internally the baked-card LOD2. The billboard stays 'BB'.
    const visible = group.levels
      .filter((l) => !l.object.userData.hiddenInApp)
      .slice()
      .sort((a, b) => a.distance - b.distance);
    const tri = (l) => countTriangles(l.object);
    const ref = visible.length ? tri(visible[0]) : 1;
    let n = 0;
    const lodLine = visible.map((l, i) => {
      const isBB = l.object.userData.isBillboard || l.object.userData.lodName === 'BB';
      const nm = isBB ? 'BB' : `LOD${n++}`;
      const c = tri(l);
      const pct = i === 0 ? '' : ` (${Math.max(1, Math.round((100 * c) / ref))}%)`;
      const d = l.distance ? ` @${Math.round(l.distance)}m` : '';
      return `${nm} ${c.toLocaleString()}△${pct}${d}`;
    }).join('  ·  ');
    statsText =
      `${species.name}  ·  ${species.latin}\n` +
      `seed ${state.controls.seed}  ·  backend ${backend}  ·  ${u.stemCount} branches · ${u.leafInstances} leaves\n` +
      lodLine;
    refreshHud();
  }
  const updateStatsFromCurrent = () => { if (currentTree) updateStats(SPECIES[state.speciesKey], currentTree); };

  // ---- billboard impostor bake (LOD3) --------------------------------------
  // Baked lazily ~600ms after the last rebuild so slider drags don't thrash the
  // GPU readback. The bake yields a frame between its RT renders (see impostor.js)
  // so the engine stays responsive; a small readout shows progress under the panel.
  const bakeHud = document.createElement('div');
  bakeHud.id = 'bake-progress'; // styled in theme.css to match the HUD/panel (retints per biome)
  bakeHud.innerHTML = '<span class="bake-label">Baking billboard…</span><span class="bake-track"><i class="bake-fill" id="bake-fill"></i></span>';
  document.body.appendChild(bakeHud);
  const setBakeProgress = (frac) => {
    bakeHud.style.opacity = frac == null ? '0' : '1';
    if (frac != null) { const f = document.getElementById('bake-fill'); if (f) f.style.width = Math.round(frac * 100) + '%'; }
  };
  let baking = false;
  let bakeTimer = 0;
  let bakeToken = 0;
  let billboardDirty = false; // plant changed since the last bake → far-LOD impostor is stale (preview/export re-bakes)
  function scheduleBillboardBake() { clearTimeout(bakeTimer); bakeTimer = setTimeout(bakeBillboard, 600); }
  // The grove is built ONCE per species and then FROZEN — hero edits never
  // rebuild it (regrowing thousands of instanced clones every edit was the freeze).
  // forestSpecies = which species it's grown for; forestPendingBillboard lets the
  // first bake after a species switch fold in the billboard, then stops.
  let forestSpecies = null;
  let forestPendingBillboard = false;
  async function bakeBillboard() {
    if (!currentTree || rebuilding || baking) { scheduleBillboardBake(); return; }
    const token = ++bakeToken;
    const tree = currentTree;
    baking = true;
    setBakeProgress(0.15);
    let bb = null;
    try {
      // Bake from LOD0 (full detail, TRUE leaf size). The far LODs enlarge leaves
      // ("fewer & bigger" — growFor), so baking the sparsest level gave the billboard
      // gargantuan leaves. The billboard must be WYSIWYG with the hero, and the
      // off-thread worker makes the extra geometry cost a non-issue.
      const geomLevels = tree.levels.filter((l) => !l.object.userData.isBillboard);
      // Pin the bake source to the TRUE full-detail mesh BY NAME. applyLodMobile
      // sorts levels by distance and parks LOD0 at 1e7, so in mobile mode index 0
      // is the near CARD rung — baking cards-of-cards gave the billboard giant
      // flat leaves. The desktop-max mesh always exists (hiddenInApp, still built).
      const source = (geomLevels.find((l) => l.object.userData.lodName === 'LOD0') ?? geomLevels[0]).object;
      const opts = { name: SPECIES[state.speciesKey].name, lodName: `LOD${geomLevels.length}` };
      if (bakeWorker) {
        // OFF-THREAD: serialize the source geometry + textures, bake full-res on the
        // worker's OWN GPU queue (viewer never stalls), assemble the cards here from
        // the returned raw pixels.
        const assets = assetCache.get(SPECIES[state.speciesKey].name);
        const center = currentCards?.centerUniform?.value ?? new THREE.Vector3(0, 6, 0);
        const { payload, transfers } = await serializeSource(source, { ...assets, foliageCfg: SPECIES[state.speciesKey].foliage }, center);
        payload.id = ++bakeReqId; payload.size = optState.billboardRes;
        setBakeProgress(0.5);
        const res = await new Promise((resolve, reject) => { bakePending.set(payload.id, { resolve, reject }); bakeWorker.postMessage(payload, transfers); });
        bb = assembleBillboardFromRawBake(res, opts);
      } else {
        // Fallback (no worker): bake on the main renderer — briefly pauses the viewer.
        bb = await bakeImpostor(renderer, source, { ...opts, size: optState.billboardRes, onProgress: (n, t) => setBakeProgress(n / t) });
      }
    } catch (e) {
      console.error('[SeedThree] billboard bake failed:', e);
    } finally {
      baking = false;
      setBakeProgress(null);
    }
    if (!bb) return;
    if (token !== bakeToken || currentTree !== tree) { disposeBillboard(bb); return; } // stale bake
    const i = tree.levels.findIndex((l) => l.object.userData.isBillboard);
    if (i >= 0) {
      const old = tree.levels[i].object;
      tree.levels.splice(i, 1);
      tree.remove(old);
      if (old !== groveBillboard) disposeBillboard(old); // grove still shares this one — leave it alive
    }
    // Billboard (LOD3) threshold rides the same framing-relative scale as the
    // other levels (set in frameCameraToTree) so it never pops in while framed.
    const bbDist = tree.userData.lodBaseDist ? tree.userData.lodBaseDist * 5.5 : optState.billboardDist;
    tree.addLevel(bb, bbDist, 0.05);
    applyLodMobile(tree); // mobile: re-park hidden LODs + set BB to billboardDist after the new level shuffles the order
    billboardDirty = false; // impostor now matches the current plant
    // Fold the freshly-baked billboard into the grove ONLY on the first bake after
    // a species switch — the grove is otherwise frozen (never rebuilt on edits).
    if (forestPendingBillboard) { forestPendingBillboard = false; updateForest(tree); }
    updateStatsFromCurrent();
  }

  // Fit the camera to a freshly-built tree — each species has a wildly different
  // height/spread (Joshua vs oak vs a baby yucca), so the fixed default framing
  // doesn't suit them all. Keep the current 3/4 viewing DIRECTION; only retarget
  // to the new tree's center and pull back to the distance that frames it.
  const _frameBox = new THREE.Box3();
  const _frameSphere = new THREE.Sphere();
  const _frameDir = new THREE.Vector3();
  const _frameCenter = new THREE.Vector3();
  const _frameSize = new THREE.Vector3();
  const _frameOrigin = new THREE.Vector3();
  function frameCameraToTree(tree) {
    tree.updateMatrixWorld(true);
    _frameBox.setFromObject(tree); // unions all LOD levels + foliage instances (billboard not baked yet)
    if (_frameBox.isEmpty()) return;
    _frameBox.getCenter(_frameCenter);
    _frameBox.getSize(_frameSize);
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    // Fit the tree's BOUNDING BOX (not its loose sphere) so the plant actually
    // FILLS the frame — sphere-fit leaves ~30% empty because a tree doesn't fill
    // its bounding sphere. Tiny margin = breathing room without clipping the crown.
    const halfH = _frameSize.y / 2;
    const halfW = Math.max(_frameSize.x, _frameSize.z) / 2;
    let dist = Math.max(halfH / Math.tan(vFov / 2), halfW / Math.tan(hFov / 2)) * 1.08;
    dist = Math.min(Math.max(dist, controls.minDistance + 1), controls.maxDistance - 1);
    _frameDir.copy(camera.position).sub(controls.target);
    if (_frameDir.lengthSq() < 1e-6) _frameDir.set(16, 4.5, 20);
    // Keep the viewer's HEADING (azimuth) but force a comfortable downward-looking
    // elevation, so a species switch never lands the camera low in the grass or
    // aimed up inside the canopy (the "starts inside an instance" bug).
    const az = Math.atan2(_frameDir.z, _frameDir.x);
    const el = (18 * Math.PI) / 180; // 18° above horizontal
    _frameDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
    controls.target.copy(_frameCenter);
    camera.position.copy(_frameCenter).addScaledVector(_frameDir, dist);
    // Make the LOD switch distances RELATIVE to this framing so the DEFAULT view
    // always shows full-detail LOD0 (absolute thresholds made big trees frame past
    // the LOD1 cutoff and render as cards). Scale off the real camera→tree-origin
    // distance; the billboard (LOD3, baked later) reads back lodBaseDist.
    tree.getWorldPosition(_frameOrigin);
    const baseDist = camera.position.distanceTo(_frameOrigin);
    tree.userData.lodBaseDist = baseDist;
    if (optState.mobileTarget && isMobileTree(tree)) {
      // Mobile uses ABSOLUTE slider distances (not framing-relative) so the
      // Optimization sliders stay meaningful; park hidden LODs + place the cards.
      tree.userData.lodBaseDist = 0; // billboard bake reads billboardDist, not baseDist*5.5
      applyLodMobile(tree);
    } else {
      const LOD_MULT = [0, 1.5, 3.0, 5.5];
      tree.levels.forEach((lv, i) => { if (i < LOD_MULT.length) lv.distance = LOD_MULT[i] * baseDist; });
    }
    controls.update();
  }

  // The species switch (and first load) genuinely can't dodge the WebGPU pipeline
  // recompile — new render objects for a new species. Cover the whole slow burst
  // with the loading overlay: paint it first, then run build + first render +
  // billboard bake + grove behind it so the user sees a spinner, not a frozen app.
  async function heavyRebuild(label, before = null) {
    needsRebuild = false; // claim the pending rebuild so the anim loop won't double-fire it
    // Retint the UI (incl. this loading overlay + its sap veins) BEFORE showing it,
    // so a desert switch is amber from the first painted frame, not green-then-flip.
    document.body.classList.toggle('biome-desert', (SPECIES[state.speciesKey]?.biome ?? 'temperate') === 'desert');
    setStage(label, 0.06);
    showLoading();
    try {
      await nextPaint();                            // overlay must actually paint before we block
      if (before) { await stageStep('Building the biome', 0.12); await before(); } // swap sky/ground behind the screen
      await rebuild(stageStep, true);               // fresh build (no reuse) + grove; deferBake → we bake below, behind the overlay
      // Reframe the camera for the new plant's size/center (species switch/first
      // load only — same-species edits keep your camera). Done behind the overlay
      // so it's invisible until the fade lifts on the correctly-framed scene.
      if (currentTree) frameCameraToTree(currentTree);
      // Pick the LOD the camera will actually show FIRST, so the compile behind
      // the overlay covers the exact level the loop renders next — otherwise the
      // loop re-picks a different, un-compiled level and hangs AFTER we hide.
      if (currentTree) { currentTree.autoUpdate = false; camera.updateMatrixWorld(); currentTree.update(camera); }
      await stageStep('Compiling shaders', 0.66);   // the big one — the pipeline compile blocks on the next render
      postProcessing.render();                       // force the hero pipeline compile now, behind the overlay (always via pipeline — cards' MRT needs an MRT context)
      await stageStep('Baking distant impostor', 0.86);
      clearTimeout(bakeTimer);                      // fold the normally-deferred billboard bake in too
      await bakeBillboard();                        // its RT readback + material compile also hide here
      postProcessing.render();                       // re-render incl. the freshly-baked billboard card
      setStage('Ready', 1);
      // Hold until the render LOOP itself is producing smooth frames — the heavy
      // Joshua pipelines compile in the loop's first render() after we return, not
      // in our renderAsync above, so waiting on frame timing is what actually keeps
      // the overlay up through the whole freeze. The bar shine (compositor) keeps
      // animating during it, so the wait reads as smooth, not hung.
      await waitForSmoothFrames();
    } catch (e) {
      console.error('[SeedThree] heavy rebuild failed:', e);
    } finally {
      hideLoading();
    }
  }

  // ---- billboard forest ring ------------------------------------------------
  // ez-tree lesson: a backdrop of trees is the cheapest "alive" multiplier.
  // Instanced copies of our own baked impostor, scattered over the hills.
  let forest = null;
  let currentCards = null;
  // The billboard the frozen grove is folded from. The center tree can re-bake its
  // OWN billboard freely on edits; we keep THIS one alive (never dispose it on a
  // re-bake) so the grove — which shares its geometry+material — never breaks. It's
  // released here in clearForest (species switch), once the live tree no longer uses it.
  let groveBillboard = null;
  function clearForest() {
    if (groveBillboard) {
      if (!currentTree?.levels?.some((l) => l.object === groveBillboard)) disposeBillboard(groveBillboard);
      groveBillboard = null;
    }
    if (!forest) return;
    scene.remove(forest);
    forest.traverse((o) => {
      if (!o.isInstancedMesh) return;
      if (o.geometry.userData.forestClone) o.geometry.dispose(); // cloned card quads only
      o.dispose(); // instance buffers; geometry/materials belong to the live tree (twins are cached)
    });
    forest = null;
    forestData = null;
  }
  let forestData = null; // static slots + bucket meshes for dynamic LOD rebinning
  function updateForest(tree) {
    clearForest();
    forestData = null;
    if (!tree || !currentSampler || !envState.forestCount) return;
    // The REAL tree, GPU-instanced, with PER-INSTANCE LOD: two pre-allocated
    // bucket sets (LOD2 geometry / billboard cards) that rebinForest() below
    // re-partitions by CAMERA distance — the grove follows the same LOD chain
    // as the hero, per tree.
    const lod2 = tree.levels.find((l) => l.object.userData.lodName === 'LOD2')?.object;
    if (!lod2) return;
    const rng = new Rng(`forest:${state.controls.seed}`);
    const N = envState.forestCount;
    const centerLocal = currentCards?.centerUniform?.value ?? new THREE.Vector3(0, 6, 0);
    const slots = [];
    {
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      const Y = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < N; i++) {
        // Dense grove hugging the meadow (60% of trees in the near band); the
        // far rest CLUSTER IN THE MEADOW POCKETS (reject-sample against the
        // shared meadow noise — trees grow where the grass grows).
        let x = 0, z = 0, r = 0;
        for (let tries = 0; tries < 8; tries++) {
          const a = rng.range(0, Math.PI * 2);
          r = i < N * 0.6 ? rng.range(38, 95) : 95 + 105 * Math.sqrt(rng.next());
          x = Math.cos(a) * r; z = Math.sin(a) * r;
          if (r < 95 || (currentSampler.meadowAt?.(x, z) ?? 0) > 0.35) break;
        }
        const s = rng.range(0.5, 1.1);
        const rot = rng.range(0, Math.PI * 2);
        q.setFromAxisAngle(Y, rot);
        pos.set(x, currentSampler.heightAt(x, z) - 0.3 * s, z);
        scl.setScalar(s);
        const mtx = new THREE.Matrix4().compose(pos, q, scl);
        slots.push({ mtx, pos: pos.clone(), s, rot, origin: centerLocal.clone().applyMatrix4(mtx) });
      }
    }

    const g = new THREE.Group();
    g.name = 'forest';
    const lod2Set = { branches: null, cards: [] };
    for (const child of lod2.children) {
      if (child.isMesh && !child.isInstancedMesh) {
        // Branch skeleton bucket (matrices filled by rebinForest). The hero
        // bark material's wind runs in tree space, but instanced offsets get
        // slot-rotated afterward (see the pipeline note in wind.js) — so the
        // forest needs a material twin driven by per-slot aWindVec/aAnchorPos.
        const geo = child.geometry.clone();
        geo.userData.forestClone = true; // clearForest disposes these
        geo.setAttribute('aWindVec', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3));
        geo.setAttribute('aAnchorPos', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3));
        const im = new THREE.InstancedMesh(geo, forestBarkMaterial(child.material), N);
        im.castShadow = true;    // real self-shadowing — the depth the hero has
        im.receiveShadow = true;
        im.frustumCulled = false; // counts churn with the camera
        lod2Set.branches = im;
        g.add(im);
      } else if (child.isGroup) {
        // Card foliage buckets: flattened (tree slot × card transform) instances.
        for (const cardsMesh of child.children) {
          if (!cardsMesh.isInstancedMesh) continue;
          const k = cardsMesh.count;
          const total = k * N;
          // fresh geometry clone: per-instance buffers sized for the whole grove
          const geo = cardsMesh.geometry.clone();
          geo.userData.forestClone = true; // clearForest disposes these
          const thick = new Float32Array(total);
          for (let t = 0; t < total; t++) thick[t] = 0.4 + 0.6 * rng.next();
          geo.setAttribute('aThickness', new THREE.InstancedBufferAttribute(thick, 1));
          geo.setAttribute('aTreeOrigin', new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3));
          // wind heading×weight + phase anchor per flattened instance, written
          // per rebin (weights come from the hero cards' CPU-side copy)
          geo.setAttribute('aWindVec', new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3));
          geo.setAttribute('aAnchorPos', new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3));
          // Tile every OTHER per-instance attribute (rosette aPack, aTanSpan, …):
          // one tree's worth of values repeated per slot. NOTE: the hero cones now
          // PRE-ALLOCATE their instanced buffers to a fixed CAP (see yucca-leaves.js
          // reuse), so a buffer's `.count` is its CAPACITY, not the live instance
          // count — the old `count >= total` skip wrongly treated CAP-sized aPack/
          // aTanSpan as "already built" and left them un-tiled (zeros → NaN wind →
          // missing grove meshes). Skip only the names rebuilt above; slice the
          // valid front of each source buffer with k (= cardsMesh.count, live n).
          const rebuilt = new Set(['aThickness', 'aTreeOrigin', 'aWindVec', 'aAnchorPos']);
          for (const [name, attr] of Object.entries(cardsMesh.geometry.attributes)) {
            if (!attr.isInstancedBufferAttribute || rebuilt.has(name)) continue;
            const arr = new attr.array.constructor(total * attr.itemSize);
            for (let slot = 0; slot < N; slot++) arr.set(attr.array.subarray(0, k * attr.itemSize), slot * k * attr.itemSize);
            geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, attr.itemSize));
          }
          // Real-geometry foliage (rosettes) lights by its own normals and its
          // hero material already reads per-instance wind attrs — share it.
          // Card foliage needs the dome-normal forest twin.
          const fmat = cardsMesh.userData.shareMaterial ? cardsMesh.material : forestCardMaterial(cardsMesh.material);
          const im = new THREE.InstancedMesh(geo, fmat, total);
          im.castShadow = true;
          im.receiveShadow = true;
          im.frustumCulled = false;
          im.userData.src = cardsMesh;
          im.userData.k = k;
          // FREEZE the hero's card transforms at grove-build time. The hero mesh is
          // REUSED in place on edits (its instanceMatrix is rewritten), so reading it
          // live in rebinForest reshaped the whole grove on every edit. Snapshot now →
          // the grove is a true frozen instance of the plant's initial state.
          { const snap = new Float32Array(k * 16), _m = new THREE.Matrix4();
            for (let j = 0; j < k; j++) { cardsMesh.getMatrixAt(j, _m); snap.set(_m.elements, j * 16); }
            im.userData.srcMatrices = snap; }
          im.userData.weights = (cardsMesh.userData.windWeights ?? null)?.slice() ?? null;
          lod2Set.cards.push(im);
          g.add(im);
        }
      }
    }

    // Billboard bucket — usable once the bake exists (until then every slot
    // renders as LOD2; the post-bake updateForest call re-adds this set).
    const bbSet = [];
    let halfH = 0;
    const bbLevel = tree.levels.find((l) => l.object.userData.isBillboard)?.object;
    if (bbLevel) {
      const cards = bbLevel.children.filter((c) => c.userData.isBillboardCard);
      if (cards.length) {
        cards[0].geometry.computeBoundingBox();
        halfH = cards[0].geometry.boundingBox.max.y;
        for (const card of cards) {
          const im = new THREE.InstancedMesh(card.geometry, card.material, N);
          im.castShadow = true;    // canopy blob shadows (mostly beyond the frustum anyway)
          im.receiveShadow = false;
          im.frustumCulled = false;
          im.userData.rotY = card.rotation.y;
          bbSet.push(im);
          g.add(im);
        }
        groveBillboard = bbLevel; // grove holds this billboard's geo+mat — keep it alive across center re-bakes
      }
    }

    scene.add(g);
    forest = g;
    forestData = { slots, lod2Set, bbSet, halfH };
    rebinForest(true);
  }

  // Re-partition the grove between LOD2 geometry and billboards by CAMERA
  // distance — per-instance LOD. Throttled: ~N distance checks + buffer
  // rewrites only when the camera has actually moved.
  const _binPos = new THREE.Vector3(1e9, 0, 0);
  let _binTime = 0;
  const _binM = new THREE.Matrix4();
  const _binOut = new THREE.Matrix4();
  const _binP = new THREE.Vector3();
  const _binQ = new THREE.Quaternion();
  const _binS = new THREE.Vector3();
  const _binW = new THREE.Vector3();
  function rebinForest(force = false) {
    if (!forestData) return;
    const now = performance.now();
    if (!force && (now - _binTime < 250 || camera.position.distanceToSquared(_binPos) < 4)) return;
    _binTime = now;
    _binPos.copy(camera.position);
    const { slots, lod2Set, bbSet, halfH } = forestData;
    const near = [], far = [];
    for (const s of slots) {
      (bbSet.length && camera.position.distanceTo(s.pos) > optState.billboardDist ? far : near).push(s);
    }
    if (lod2Set.branches) {
      const bwv = lod2Set.branches.geometry.attributes.aWindVec;
      const bap = lod2Set.branches.geometry.attributes.aAnchorPos;
      near.forEach((s, i) => {
        lod2Set.branches.setMatrixAt(i, s.mtx);
        // wind heading back-rotated by the slot's yaw, unscaled (slots only
        // yaw+scale uniformly — cheaper than a matrix decompose); phase anchor
        // is the slot's trunk base, SHARED with its cards so they crest together
        const cos = Math.cos(-s.rot), sin = Math.sin(-s.rot);
        bwv.setXYZ(i,
          (WIND_DIR.x * cos + WIND_DIR.z * sin) / s.s,
          0,
          (WIND_DIR.z * cos - WIND_DIR.x * sin) / s.s);
        bap.setXYZ(i, s.pos.x, s.pos.y, s.pos.z);
      });
      bwv.needsUpdate = true;
      bap.needsUpdate = true;
      lod2Set.branches.count = near.length;
      lod2Set.branches.instanceMatrix.needsUpdate = true;
    }
    for (const im of lod2Set.cards) {
      const { src, k, weights, srcMatrices } = im.userData;
      const orig = im.geometry.attributes.aTreeOrigin;
      const wvec = im.geometry.attributes.aWindVec;
      const apos = im.geometry.attributes.aAnchorPos;
      let w = 0;
      for (const s of near) {
        for (let j = 0; j < k; j++) {
          if (srcMatrices) _binM.fromArray(srcMatrices, j * 16); // FROZEN snapshot, never the live hero
          else src.getMatrixAt(j, _binM);
          _binOut.multiplyMatrices(s.mtx, _binM);
          im.setMatrixAt(w, _binOut);
          orig.setXYZ(w, s.origin.x, s.origin.y, s.origin.z);
          // combined (slot × card) frame → wind heading×weight in instance-
          // local space; phase anchor = the slot base (same as the branches)
          _binOut.decompose(_binP, _binQ, _binS);
          const wt = weights ? weights[j] : 0.6;
          _binW.copy(WIND_DIR).applyQuaternion(_binQ.invert()).divide(_binS).multiplyScalar(wt);
          wvec.setXYZ(w, _binW.x, _binW.y, _binW.z);
          apos.setXYZ(w, s.pos.x, s.pos.y, s.pos.z);
          w++;
        }
      }
      im.count = w;
      im.instanceMatrix.needsUpdate = true;
      orig.needsUpdate = true;
      wvec.needsUpdate = true;
      apos.needsUpdate = true;
    }
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    for (const im of bbSet) {
      far.forEach((s, i) => {
        q.setFromAxisAngle(Y, s.rot + im.userData.rotY);
        p.set(s.pos.x, currentSampler.heightAt(s.pos.x, s.pos.z) + s.s * (halfH - 0.4), s.pos.z);
        sc.setScalar(s.s);
        _binOut.compose(p, q, sc);
        im.setMatrixAt(i, _binOut);
      });
      im.count = far.length;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  function onOpt(kind) {
    if (kind === 'preview') {
      applyFog();
      // Selecting the billboard LOD is an explicit "show me the impostor" action, so
      // bake it fresh for the CURRENT plant if it's stale. Editing itself NEVER bakes
      // (instant, no freeze); the one-time bake only happens when you ask to see it.
      if (optState.preview === 3 && billboardDirty) scheduleBillboardBake();
      return;
    }
    if (kind === 'rebuild') { requestRebuild(); return; }
    if (kind === 'rebake') { scheduleBillboardBake(); return; }
    if (kind === 'dist' && currentTree) {
      // Keep switch distances monotonic, then write them into the live LOD.
      optState.lod2Dist = Math.max(optState.lod2Dist, optState.lod1Dist + 5);
      optState.billboardDist = Math.max(optState.billboardDist, optState.lod2Dist + 10);
      if (optState.mobileTarget && isMobileTree(currentTree)) {
        // Retarget (keep-names): LOD1→extra card #1 (LOD3), LOD2→extra card #2
        // (LOD4), Billboard→BB. The near card LOD (LOD2) stays fixed at 0.
        applyLodMobile(currentTree);
      } else {
        for (const l of currentTree.levels) {
          const nm = l.object.userData.lodName;
          if (nm === 'LOD1') l.distance = optState.lod1Dist;
          else if (nm === 'LOD2') l.distance = optState.lod2Dist;
          else if (nm === 'BB') l.distance = optState.billboardDist;
        }
      }
      syncFromState(); // reflect any clamping back into the sliders
      updateStatsFromCurrent();
    }
  }

  // ---- GUI ----------------------------------------------------------------
  const { syncFromState, applyPreset } = buildGUI({
    speciesMap: SPECIES,
    state,
    sunState,
    envState,
    optState,
    camState,
    onCamera: () => applyCamera(),
    // Load-preset rebuild: state.speciesKey + state.controls are already set by the
    // GUI's applyPreset; run the full biome + build for them (heavyRebuild does NOT
    // reset controls — only the species dropdown's onChange path does).
    onLoadRebuild: () => heavyRebuild(`Loading ${SPECIES[state.speciesKey].name}…`, () => buildBiome(SPECIES[state.speciesKey])),
    onMaterialTweak: () => applyMaterialTweaks(), // live leaf/bark tint/alpha/flat, no rebuild
    onOpt,
    onSun: () => updateSun(),
    onScaleRef: (v) => { scaleRef.visible = v; },
    onFog: () => applyFog(),
    onGtao: () => setAOOutput(), // swap composite (AO vs plain color) + recompile once
    onAA: () => applyAA(),       // toggle MSAA on the scene pass
    windState,
    onWind: () => applyWind(),
    onForest: () => updateForest(currentTree),
    onSpom: async () => {
      // Toggling parallax rebuilds the biome (new terrain material) — cover the
      // recompile with the loading overlay.
      setStage(envState.spom ? 'Enabling parallax terrain…' : 'Disabling parallax terrain…', 0.3);
      showLoading();
      try {
        await nextPaint();
        await buildBiome(SPECIES[state.speciesKey]);
        postProcessing.render();
        await waitForSmoothFrames();
      } finally { hideLoading(); }
    },
    onChange: (speciesChanged) => {
      if (speciesChanged) {
        state.controls = controlsFromSpecies(SPECIES[state.speciesKey]);
        syncFromState();
        // Species switch is the unavoidable-recompile path → show the loading
        // overlay and run the biome swap + build + bake behind it.
        heavyRebuild(`Growing ${SPECIES[state.speciesKey].name}…`, () => buildBiome(SPECIES[state.speciesKey]));
      } else {
        requestRebuild(); // same species: hero reuse keeps this instant, no overlay
      }
    },
    onRandomize: () => {
      state.controls.seed = 1 + Math.floor(Math.random() * 9998);
      syncFromState();
      requestRebuild();
    },
    // PNG snapshot (ez-tree parity): render a fresh frame and grab the WebGPU
    // canvas in the same task (the drawing buffer isn't preserved after present).
    onExportPNG: async () => {
      try {
        postProcessing.render(); // render through the pipeline (AO if enabled)
        const bmp = await createImageBitmap(renderer.domElement);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        oc.getContext('2d').drawImage(bmp, 0, 0);
        const blob = await oc.convertToBlob({ type: 'image/png' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${SPECIES[state.speciesKey].name.replace(/\s+/g, '_')}_seed${state.controls.seed}.png`;
        document.body.appendChild(a); a.click(); a.remove();
      } catch (e) { console.error('PNG export failed:', e); }
    },
    onExport: async () => {
      if (!currentTree) return;
      try {
        // Bake the far-LOD billboard fresh for THIS plant right before export — it's
        // the plant's far LOD in the downloaded GLB. We do NOT re-bake during editing
        // (that froze the UX); a one-time bake on download is where the user expects a
        // brief wait. Let any in-flight edit rebuild / prior bake settle first. The
        // grove is decoupled (groveBillboard), so this never disturbs the instances.
        while (rebuilding || baking) await new Promise((r) => setTimeout(r, 40));
        if (billboardDirty) await bakeBillboard(); // usually already fresh (auto-rebakes on edit); guarantee it for the GLB
        const size = await downloadGLB(currentTree, `${SPECIES[state.speciesKey].name.replace(/\s+/g, '_')}_seed${state.controls.seed}`);
        if (size) console.log(`[SeedThree] exported GLB (${(size / 1024).toFixed(0)} KB)`);
      } catch (e) {
        console.error('GLB export failed:', e);
        fail(`GLB export failed: ${e.message}`);
      }
    },
  });

  // First build compiles pipelines from cold → same overlay treatment as a switch.
  await heavyRebuild('Growing SeedThree…', async () => {
    await buildBiome(SPECIES[state.speciesKey]);
    updateSun(); // apply elevation-based color/intensity to the initial sun
  });

  // Volumetric clouds — built once (the 3D noise texture is expensive to regen).
  scene.add(buildVolumetricClouds({ count: 8, altitude: 85, spread: 190 }));

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  postProcessing.render(); // first frame even if backgrounded (always via pipeline)
  let fpsFrames = 0;
  let fpsT0 = performance.now();
  renderer.setAnimationLoop(() => {
    fpsFrames++;
    const now = performance.now();
    if (now - fpsT0 >= 500) {
      fpsDisplay = Math.round((fpsFrames * 1000) / (now - fpsT0));
      fpsFrames = 0;
      fpsT0 = now;
      refreshHud();
    }
    // Debounce: rebuild only ~130ms after the last control change, and never
    // overlap rebuilds — otherwise dragging a slider recreates the foliage node
    // material every frame and the leaves flicker out mid-recompile.
    if (needsRebuild && !rebuilding && performance.now() - lastChangeAt > 130) {
      needsRebuild = false;
      rebuild();
    }
    controls.update();
    rebinForest(); // per-instance forest LOD follows the camera (throttled)
    // LOD selection is driven HERE from the view camera, never by the renderer
    // (autoUpdate off): the shadow pass would otherwise re-pick the level from
    // the SUN's camera ~100m out, casting a low-LOD shadow under a LOD0 tree.
    // 'auto' picks by camera distance; a number forces that level (billboard may
    // not be baked yet — clamp).
    if (currentTree) {
      currentTree.autoUpdate = false;
      if (optState.preview === 'auto') {
        camera.updateMatrixWorld();
        currentTree.update(camera);
      } else {
        // Force the Nth VISIBLE level, sorted by distance and skipping the hidden mesh
        // LODs that mobile parks off-screen — so the dropdown's LOD0/1/2/BB map to the
        // SAME levels the HUD renumbers, never a parked high-poly LOD or the wrong
        // billboard (the mobile preview-selector bug).
        const vis = currentTree.levels.filter((l) => !l.object.userData.hiddenInApp).sort((a, b) => a.distance - b.distance);
        const idx = Math.min(optState.preview, vis.length - 1);
        currentTree.levels.forEach((l) => { l.object.visible = false; });
        if (vis[idx]) vis[idx].object.visible = true;
      }
    }
    renderFrame(); // GTAO post-pass or direct; billboard bake is OFF-THREAD (worker) → viewer paints every frame
  });

  Object.assign(window, { THREE, scene, camera, renderer, state, optState, envState, postProcessing, aoPass, scenePass, setAOOutput, applyAA, assetCache, rebuild: () => { needsRebuild = true; }, _rebuildNow: rebuild, applyPreset });
}

main().catch((e) => fail(`Init failed: ${e?.stack || e}`));
