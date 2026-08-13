// Neutral, repeatable Eidoverse reference turntable for SeedThree species.
// The Eidoverse harness injects THREE, canvas, GPU_DEVICE, GPU_ADAPTER,
// makeSeedTree, WIDTH/HEIGHT, and TOTAL_FRAMES before evaluating this file.

const species = Deno.env.get('SEEDTHREE_SPECIES') || 'paperBirch';
const seed = Math.max(1, Number.parseInt(Deno.env.get('SEEDTHREE_SEED') || '1', 10));

function setCamera(camera, target, distance, treeHeight, progress) {
  // Three equally useful probes over the render: left three-quarter, front,
  // and right three-quarter. Avoid a full orbit whose first/last probes match.
  const angle = THREE.MathUtils.degToRad(-38 + 106 * progress);
  camera.position.set(
    target.x + Math.sin(angle) * distance,
    target.y + treeHeight * 0.055,
    target.z + Math.cos(angle) * distance,
  );
  camera.lookAt(target);
}

globalThis.setup = async function setup() {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    adapter: GPU_ADAPTER,
    device: GPU_DEVICE,
  });
  renderer.setSize(WIDTH, HEIGHT);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xaeb9bf);

  const camera = new THREE.PerspectiveCamera(47, WIDTH / HEIGHT, 0.05, 500);

  const hemisphere = new THREE.HemisphereLight(0xeaf4ff, 0x46503f, 1.45);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff1d8, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.018;
  scene.add(sun);
  scene.add(sun.target);

  // Use SeedThree's textured headless API, which is the same geometry/material
  // path as the app. Rendering one explicit level avoids camera-dependent LOD.
  await globalThis.makeSeedTree.setWind({ strength: 0, speed: 1 });
  const grown = await globalThis.makeSeedTree({
    species,
    seed,
    scene,
    sunLight: sun,
    level: 'LOD0',
    textured: true,
  });
  const tree = grown.object;
  tree.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(tree);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const target = new THREE.Vector3(center.x, center.y, center.z);

  // Fit both height and width to the identical 47-degree camera. The 12%
  // margin makes silhouette comparisons independent of species dimensions.
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const fitHeight = size.y / (2 * Math.tan(verticalFov / 2));
  const fitWidth = Math.max(size.x, size.z) / (2 * Math.tan(horizontalFov / 2));
  const distance = Math.max(fitHeight, fitWidth) * 1.12;
  camera.near = Math.max(0.02, distance / 500);
  camera.far = Math.max(100, distance * 8);
  camera.updateProjectionMatrix();
  setCamera(camera, target, distance, size.y, 0);

  const groundExtent = Math.max(12, Math.max(size.x, size.z) * 2.4);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundExtent, groundExtent),
    new THREE.MeshStandardNodeMaterial({
      color: 0x70786d,
      roughness: 0.92,
      metalness: 0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = bounds.min.y - 0.015;
  ground.receiveShadow = true;
  ground.userData.isBackdrop = true;
  scene.add(ground);

  const lightScale = Math.max(size.y, size.x, size.z);
  sun.position.copy(center).add(new THREE.Vector3(
    -0.85 * lightScale,
    1.45 * lightScale,
    0.75 * lightScale,
  ));
  sun.target.position.copy(center);
  const shadowExtent = Math.max(size.x, size.z, size.y * 0.65) * 0.8;
  Object.assign(sun.shadow.camera, {
    left: -shadowExtent,
    right: shadowExtent,
    top: shadowExtent,
    bottom: -shadowExtent,
    near: 0.1,
    far: lightScale * 5,
  });
  sun.shadow.camera.updateProjectionMatrix();

  globalThis._r = renderer;
  globalThis._s = scene;
  globalThis._c = camera;
  globalThis._treeReference = { target, distance, height: size.y };

  console.log('[seedthree-reference]', JSON.stringify({
    species,
    seed,
    dimensions: { width: size.x, height: size.y, depth: size.z },
    stats: grown.stats.summary,
  }));
};

globalThis.renderFrame = async function renderFrame(t) {
  const fps = globalThis.FPS || 30;
  const duration = Math.max(1 / fps, (TOTAL_FRAMES - 1) / fps);
  const progress = THREE.MathUtils.clamp(t / duration, 0, 1);
  const ref = globalThis._treeReference;
  setCamera(globalThis._c, ref.target, ref.distance, ref.height, progress);
  await globalThis._r.renderAsync(globalThis._s, globalThis._c);
};
