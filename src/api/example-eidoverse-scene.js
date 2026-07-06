// ILLUSTRATIVE eidoverse scene — how to plant SeedThree trees in a rendered
// video. This shows the WIRING, not a scene to reproduce (per eidoverse's
// "examples are illustrative" rule): take the SeedThree hookup, throw away the
// framing/lighting and build YOUR piece around it.
//
// A working copy of this scene rendered successfully via
// `python eido.py render <scene.json> --probe` (see eidoverse work/seedthree_probe).
//
// VERIFIED GOTCHAS (against the real engine):
//  • The engine eval()s scene scripts, so a relative dynamic import() resolves
//    against the ENGINE's URL, not your work folder — build an absolute file URL
//    from Deno.cwd() (the repo root). Deno.readFile takes plain relative paths.
//  • Shadows WORK (full canopy + self-shadowing, verified frame 45 of a real
//    render with the config below) — but the FIRST FRAME renders before a
//    modified shadow frustum settles, showing all receivers black. Known
//    eidoverse first-frame wonk. So: judge shadowed scenes from a LATER frame,
//    never a single-frame --probe; in productions the first frames are inside
//    your fade-in anyway.
const SEEDTHREE_URL = new URL('../SeedThree/', `file:///${Deno.cwd().replaceAll('\\', '/')}/`).href;
const SEEDTHREE = '../SeedThree'; // filesystem prefix for Deno.readFile

globalThis.setup = async function () {
  // REQUIRED for SeedThree (or any procedural tree): eidoverse's post-setup
  // clipping audit auto-separates "intersecting" meshes — but a tree IS
  // intentionally-overlapping geometry (foliage through branches, rosette cones
  // through tubes, spines through skin). Without this the audit DISMEMBERS the
  // plants ("separated 39 clipping pairs" = joshua arms scattered across the set).
  globalThis._noAutoFixPlacement = true;

  const renderer = new THREE.WebGPURenderer({
    canvas, antialias: true, adapter: GPU_ADAPTER, device: GPU_DEVICE,
  });
  renderer.setSize(WIDTH, HEIGHT);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 300);
  camera.position.set(13, 6.5, 20);
  camera.lookAt(0, 5.5, 0);

  // Lighting/sky is YOUR job per the brief — HDRI, terrain, etc. (minimal here).
  // Shadow config from the SeedThree app: 4096 map + these biases keep leaf
  // cards and thin twigs from self-shadow acne; size the frustum to your scene.
  const sun = new THREE.DirectionalLight(0xfff0dd, 3.2);
  sun.position.set(14, 18, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.04;
  sun.shadow.camera.left = -30; sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
  scene.add(sun, new THREE.HemisphereLight(0xcfe6ff, 0x5a4a36, 1.1));

  // --- SeedThree tree -------------------------------------------------------
  const st = await import(`${SEEDTHREE_URL}src/api/seedthree.js`);

  // The SEED is the main dial — every seed is a different individual of the
  // species. Iterate the seed first; open the fine dials only when the shot
  // needs them: st.describe() / st.describe('whiteOak') / st.describe('whiteOak', 'shape').
  st.setWind({ strength: 0.35 }); // trees sway by default (0.5); 0 = still

  // Bridge SeedThree's on-disk PNGs to eidoverse's Deno-native texture decoder.
  const loadTexture = async (path, { srgb }) =>
    globalThis.loadImageTexture(await Deno.readFile(path), { srgb });

  const oak = await st.createTree({
    species: 'whiteOak',
    seed: 42,                 // ← the knob that matters
    loadTexture,
    assetsDir: `${SEEDTHREE}/assets`,
    sunLight: sun,
    level: 'LOD0',            // hero up close → full detail; omit for the whole THREE.LOD
  });
  oak.object.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(oak.object);
  console.log('[scene] planted', oak.stats.summary);

  globalThis._r = renderer; globalThis._s = scene; globalThis._c = camera;
};

globalThis.renderFrame = async function (t) {
  const c = globalThis._c;
  c.position.x = Math.cos(0.6 + t * 0.1) * 24;
  c.position.z = Math.sin(0.6 + t * 0.1) * 24;
  c.lookAt(0, 5.5, 0);
  await globalThis._r.renderAsync(globalThis._s, globalThis._c);
};
// preflight: (no declared ASSETS — SeedThree reads its own assets/ off disk)
