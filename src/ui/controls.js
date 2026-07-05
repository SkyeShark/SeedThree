// Maps friendly UI controls onto Weber-Penn species params, and builds the
// lil-gui panel. Kept separate from main.js so the parameter vocabulary lives in
// one place as we add species and controls.

import GUI from 'lil-gui';
import { mountPanelFX } from './panel-fx.js';

// Crown-shape dropdown values (Weber-Penn Shape enum) — exported so species
// control schemas can reference it.
export const CROWN_SHAPES = {
  Conical: 0, Spherical: 1, Hemispherical: 2, Cylindrical: 3,
  'Tapered cyl.': 4, Flame: 5, 'Inverse conical': 6, 'Tend flame': 7,
};

// Each species declares its OWN control schema (species.controls: an array of
// { key, name, min, max, step | dropdown, get(species), set(shaped, v) }) so a
// broadleaf's "branch density" and a Joshua tree's "fork generations" are
// different sliders mapped to that species' own params — no shared oak
// vocabulary clobbering another species' branching.

// ez-tree-parity ADVANCED per-level Weber-Penn dials: one slider per level for
// each of these params, mapped straight onto species.params arrays. Only shown
// for the broadleaf/conifer path (rosette/dichotomous species have their own
// vocabulary + generator). `trunk` = whether index 0 (the trunk) gets a dial.
export const ADVANCED_LEVEL_PARAMS = [
  { key: 'downAngle',      name: 'Down angle',  min: 0,    max: 135, step: 1,    trunk: false, dflt: 0 },
  { key: 'branches',       name: 'Children',    min: 0,    max: 60,  step: 1,    trunk: false, dflt: 0 },
  { key: 'curveV',         name: 'Gnarliness',  min: 0,    max: 120, step: 1,    trunk: true,  dflt: 40 },
  { key: 'curve',          name: 'Curve',       min: -90,  max: 90,  step: 1,    trunk: true,  dflt: 0 },
  { key: 'length',         name: 'Length ×', min: 0.02, max: 1.5, step: 0.01, trunk: false, dflt: 0.4 },
  { key: 'taper',          name: 'Taper',       min: 0,    max: 1,   step: 0.01, trunk: true,  dflt: 1 },
  { key: 'twist',          name: 'Twist',       min: -0.5, max: 0.5, step: 0.01, trunk: true,  dflt: 0 },
  { key: 'curveRes',       name: 'Sections',    min: 2,    max: 20,  step: 1,    trunk: true,  dflt: 8 },
  { key: 'radialSegments', name: 'Segments',    min: 3,    max: 16,  step: 1,    trunk: true,  dflt: 6 },
];

// Default friendly-control values, read from the active species' schema.
export function controlsFromSpecies(species) {
  const c = {
    seed: 1, showLeaves: true, tileWorldSize: species.tileWorldSize ?? 1.5,
    // ez-tree parity: raw per-level param overrides ({ paramKey: { level: value } })
    // + a general growth-force tropism (strength 0 = off, tree unchanged).
    paramOverrides: {},
    forceDirX: species.params?.forceDir?.x ?? 0,
    forceDirY: species.params?.forceDir?.y ?? 1,
    forceDirZ: species.params?.forceDir?.z ?? 0,
    forceStrength: species.params?.forceStrength ?? 0,
    // ez-tree parity leaf/bark editing. Geometry ones (angle/start/sizeVar/quads)
    // reshape on rebuild; material ones (tint/alphaTest/flat) update the cached
    // material live. Defaults read from the species so a switch re-seeds them.
    leafColorize: 0xffffff,   // colorize target (interpolated toward, not multiplied)
    leafTintAmount: 0,        // 0 = raw texture, 1 = fully recolored
    leafAngle: species.foliage?.downAngle ?? 52,
    leafStart: species.foliage?.startFrac ?? 0.1,
    leafSizeVar: species.foliage?.sizeVar ?? 0.3,
    leafAlpha: species.foliage?.alphaTest ?? 0.4,
    leafQuads: species.foliage?.quads ?? 2,
    barkTint: 0xffffff,
    barkFlat: false,
    // Desert species color editing. Fronds (Joshua/yuccas) have 3 age-stage tints
    // + a dryness bias; cactus spines (saguaro) tint like bark. All default to no
    // change and apply live via the cached material (no rebuild).
    frondGreenTint: 0xffffff,
    frondDryTint: 0xffffff,
    frondDryestTint: 0xffffff,
    frondDryness: 0,
    spineTint: 0xffffff,
  };
  for (const d of species.controls ?? []) c[d.key] = d.get(species);
  for (const d of species.advancedControls ?? []) c[d.key] = d.get(species); // L-system Advanced dials
  return c;
}

// Produce a species-like object with params/foliage overridden by the controls.
export function applySpeciesControls(species, c) {
  const s = {
    ...species,
    params: structuredClone(species.params),
    foliage: species.foliage === false ? false : { ...(species.foliage ?? {}) },
    tileWorldSize: c.tileWorldSize ?? species.tileWorldSize,
  };
  for (const d of species.controls ?? []) if (d.key in c) d.set(s, c[d.key]);
  for (const d of species.advancedControls ?? []) if (d.key in c) d.set(s, c[d.key]); // L-system Advanced dials
  // Advanced per-level overrides: write straight into the params arrays. Seed a
  // full 4-length array (shallow param merge in the generator REPLACES arrays, so
  // sparse holes would clobber the DEFAULTS) — missing slots keep the species value
  // or the advanced default.
  if (c.paramOverrides) {
    for (const [key, perLevel] of Object.entries(c.paramOverrides)) {
      if (!perLevel || !Object.keys(perLevel).length) continue;
      const cur = Array.isArray(s.params[key]) ? s.params[key] : [];
      const meta = ADVANCED_LEVEL_PARAMS.find((m) => m.key === key);
      const arr = [];
      for (let i = 0; i < 4; i++) arr[i] = cur[i] !== undefined ? cur[i] : (meta ? meta.dflt : 0);
      for (const [lvl, v] of Object.entries(perLevel)) arr[+lvl] = v;
      s.params[key] = arr;
    }
  }
  // General growth force (ez-tree tropism vector).
  if (c.forceStrength) {
    s.params.forceDir = { x: c.forceDirX ?? 0, y: c.forceDirY ?? 1, z: c.forceDirZ ?? 0 };
    s.params.forceStrength = c.forceStrength;
  }
  // Leaf GEOMETRY overrides (ez-tree parity) — reshape the foliage cards on rebuild.
  // Tint/alphaTest are MATERIAL props applied live (cached material), not here.
  if (s.foliage) {
    if (c.leafAngle !== undefined) s.foliage.downAngle = c.leafAngle;
    if (c.leafStart !== undefined) s.foliage.startFrac = c.leafStart;
    if (c.leafSizeVar !== undefined) s.foliage.sizeVar = c.leafSizeVar;
    if (c.leafQuads !== undefined) s.foliage.quads = c.leafQuads;
  }
  if (c.showLeaves === false) s.foliage = false;
  return s;
}

/**
 * @param {object} opts { speciesList, state, onChange, onRandomize, onExport, stats }
 *   state: { speciesKey, controls }  (mutated live by the GUI)
 *   stats: { species, seed, stems, leaves, triangles } — updated via returned api
 */
export function buildGUI(opts) {
  const { speciesMap, state, sunState, envState, optState, windState, camState, onChange, onRandomize, onExport, onExportPNG, onSun, onScaleRef, onFog, onWind, onForest, onSpom, onGtao, onAA, onOpt, onCamera, onLoadRebuild, onMaterialTweak } = opts;
  const gui = new GUI({ title: '' });

  // Branding header (Codex-generated logo + wordmark; falls back to plain text
  // until the images exist).
  const brand = document.createElement('div');
  brand.className = 'st-brand';
  brand.innerHTML = `
    <img class="icon" src="/assets/ui/logo.png" onerror="this.style.display='none'">
    <img class="wordmark" src="/assets/ui/wordmark.png" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'SeedThree',style:'color:#e8eee4;font-weight:600;font-size:17px;letter-spacing:0.03em'}))">`;
  gui.domElement.prepend(brand);
  gui.domElement.querySelector(':scope > .lil-title')?.remove(); // brand replaces the default title bar
  mountPanelFX(gui.domElement); // living-sap-veins GPU background

  const speciesNames = {};
  for (const key of Object.keys(speciesMap)) speciesNames[speciesMap[key].name] = key;

  const proxy = { species: speciesMap[state.speciesKey].name, ...state.controls };

  // Mobile Target availability + LOD-slider semantics live here so they can react
  // to species changes. Desert (rosette) species have no branch cards, so the
  // card-based mobile mode doesn't apply — the toggle is hidden for them. When
  // mobile is EFFECTIVELY active (toggle on AND a card species) the LOD1/LOD2
  // dials relabel to card terms and the budget-% dials (no-ops on cards) hide.
  let cMobile, cMeshQ, cLod1Pct, cLod2Pct, cLod1Den, cLod2Den, cLod1Prn, cLod2Prn;
  function applyMobileUI() {
    if (!cMobile) return;
    const isRosette = speciesMap[state.speciesKey]?.foliageType === 'rosette';
    cMobile.show(!isRosette);
    const m = !!optState?.mobileTarget && !isRosette;
    cLod1Pct.show(!m); cLod2Pct.show(!m);
    cMeshQ.name(m ? 'Twig / skeleton quality' : 'LOD0 mesh quality');
    cLod1Den.name(m ? 'LOD1 card density' : 'LOD1 foliage density');
    cLod2Den.name(m ? 'LOD2 card density' : 'LOD2 foliage density');
    cLod1Prn.name(m ? 'LOD1 twig prune' : 'LOD1 branch prune');
    cLod2Prn.name(m ? 'LOD2 twig prune' : 'LOD2 branch prune');
  }

  gui.add(proxy, 'species', speciesNames).name('Species').onChange((key) => {
    state.speciesKey = key;
    onChange(true); // species changed → main.js resets state.controls (sync)
    Object.assign(proxy, state.controls);
    proxy.species = speciesMap[key].name;
    buildParamControls(); // rebuild sliders for this species' branching type
    buildAdvancedControls();
    buildLeafBarkControls();
    applyMobileUI(); // hide the mobile toggle on desert species
  });

  gui.add(proxy, 'seed', 1, 9999, 1).name('Seed').onChange((v) => { state.controls.seed = v; onChange(); }).listen();
  gui.add({ randomize: () => onRandomize() }, 'randomize').name('🎲 Randomize seed');

  // Species-defined controls: rebuilt whenever the species changes so each
  // plant exposes sliders for ITS OWN branching type.
  const shape = gui.addFolder('Shape & Foliage');
  function buildParamControls() {
    shape.controllers.slice().forEach((ct) => ct.destroy());
    const sp = speciesMap[state.speciesKey];
    for (const d of sp.controls ?? []) {
      const ct = d.dropdown
        ? shape.add(proxy, d.key, d.dropdown)
        : shape.add(proxy, d.key, d.min, d.max, d.step);
      ct.name(d.name).onChange((v) => { state.controls[d.key] = v; onChange(); });
    }
    shape.add(proxy, 'showLeaves').name('Show leaves').onChange((v) => { state.controls.showLeaves = v; onChange(); });
    shape.add(proxy, 'tileWorldSize', 0.6, 3.0, 0.05).name('Bark tiling (m)').onChange((v) => { state.controls.tileWorldSize = v; onChange(); });
  }
  buildParamControls();

  // Advanced dials. Temperate species get raw per-level Weber-Penn params;
  // rosette/dichotomous (L-system) species get their generator's flat params
  // from the preset's `advancedControls` array. Hidden only if a species defines
  // neither.
  const advanced = gui.addFolder('Advanced: branch levels');
  function buildAdvancedControls() {
    advanced.controllers.slice().forEach((ct) => ct.destroy());
    const sp = speciesMap[state.speciesKey];
    const isRosette = sp.foliageType === 'rosette';
    const advList = sp.advancedControls;
    advanced.domElement.style.display = (isRosette && !advList?.length) ? 'none' : '';
    if (advanced.title) advanced.title(isRosette ? 'Advanced: L-system' : 'Advanced: branch levels');
    if (isRosette) {
      // Flat dichotomous-generator params (fork angle/thickness, candelabra set,
      // trunk flare, anti-intersection, …). Same {get,set} pattern as Shape dials.
      for (const d of advList ?? []) {
        if (proxy[d.key] === undefined) proxy[d.key] = d.get(sp); // guard: lil-gui add() needs a defined value
        const ct = d.dropdown
          ? advanced.add(proxy, d.key, d.dropdown)
          : advanced.add(proxy, d.key, d.min, d.max, d.step);
        if (!ct) continue; // lil-gui returns undefined for a non-primitive value — skip rather than crash
        ct.name(d.name).onChange((v) => { state.controls[d.key] = v; onChange(); });
      }
      return;
    }
    const levels = sp.params?.levels ?? 3;
    const po = (state.controls.paramOverrides ||= {});
    for (const m of ADVANCED_LEVEL_PARAMS) {
      const lo = m.trunk ? 0 : 1;
      for (let lvl = lo; lvl <= levels - 1; lvl++) {
        const pk = `adv__${m.key}__${lvl}`;
        proxy[pk] = (po[m.key]?.[lvl]) ?? sp.params?.[m.key]?.[lvl] ?? m.dflt;
        advanced.add(proxy, pk, m.min, m.max, m.step)
          .name(`${m.name} · L${lvl}`)
          .onChange((v) => { (po[m.key] ||= {})[lvl] = v; onChange(); });
      }
    }
    // General growth force (arbitrary tropism vector).
    for (const axis of ['X', 'Y', 'Z']) {
      const pk = `forceDir${axis}`;
      advanced.add(proxy, pk, -1, 1, 0.01).name(`Force dir ${axis}`).onChange((v) => { state.controls[pk] = v; onChange(); });
    }
    advanced.add(proxy, 'forceStrength', 0, 0.12, 0.001).name('Force strength').onChange((v) => { state.controls.forceStrength = v; onChange(); });
  }
  buildAdvancedControls();

  // Leaves + Bark editing (ez-tree parity). A material tweak (tint/alphaTest/flat)
  // updates the cached material live (onMaterialTweak, no rebuild); a geometry tweak
  // (angle/start/size-variance/quads) reshapes the cards on rebuild (onChange).
  const mtweak = (key) => (v) => { state.controls[key] = v; onMaterialTweak?.(); };
  const geom = (key) => (v) => { state.controls[key] = v; onChange(); };
  const leaves = gui.addFolder('Leaves');
  const fronds = gui.addFolder('Fronds'); // rosette foliage (Joshua/yuccas)
  const spines = gui.addFolder('Spines'); // cactus (saguaro)
  const bark = gui.addFolder('Bark');
  function buildLeafBarkControls() {
    leaves.controllers.slice().forEach((ct) => ct.destroy());
    fronds.controllers.slice().forEach((ct) => ct.destroy());
    spines.controllers.slice().forEach((ct) => ct.destroy());
    bark.controllers.slice().forEach((ct) => ct.destroy());
    const sp = speciesMap[state.speciesKey];
    const isRosette = sp.foliageType === 'rosette';
    const isCactus = !!sp.cactus;              // saguaro → spines
    const isFrondRosette = isRosette && !isCactus; // Joshua/yuccas → fronds
    // Rosette species (yucca/cactus) don't use the leaf-card material, so hide the
    // leaf editor for them; bark tint/flat still apply to their flesh material.
    leaves.domElement.style.display = isRosette ? 'none' : '';
    if (!isRosette) {
      // Colorize: pick a target color, then dial how far to interpolate the leaf
      // texture toward it (luminance-preserving — keeps vein/shading detail).
      leaves.addColor(proxy, 'leafColorize').name('Tint').onChange(mtweak('leafColorize'));
      leaves.add(proxy, 'leafTintAmount', 0, 1, 0.01).name('Tint amount').onChange(mtweak('leafTintAmount'));
      leaves.add(proxy, 'leafAngle', 0, 100, 1).name('Angle').onChange(geom('leafAngle'));
      leaves.add(proxy, 'leafStart', 0, 1, 0.01).name('Start').onChange(geom('leafStart'));
      leaves.add(proxy, 'leafSizeVar', 0, 1, 0.01).name('Size variance').onChange(geom('leafSizeVar'));
      leaves.add(proxy, 'leafAlpha', 0, 1, 0.01).name('Alpha test').onChange(mtweak('leafAlpha'));
      leaves.add(proxy, 'leafQuads', { 'Single': 1, 'Crossed (double)': 2 }).name('Billboard').onChange(geom('leafQuads'));
    }
    // Fronds (Joshua/yuccas): recolor each age stage (green→dry→dryest) and bias
    // the whole plant along that ramp. Live material tweaks — no rebuild.
    fronds.domElement.style.display = isFrondRosette ? '' : 'none';
    if (isFrondRosette) {
      fronds.addColor(proxy, 'frondGreenTint').name('Green tint').onChange(mtweak('frondGreenTint'));
      fronds.addColor(proxy, 'frondDryTint').name('Dry tint').onChange(mtweak('frondDryTint'));
      fronds.addColor(proxy, 'frondDryestTint').name('Dryest tint').onChange(mtweak('frondDryestTint'));
      fronds.add(proxy, 'frondDryness', 0, 1, 0.01).name('Dryness').onChange(mtweak('frondDryness'));
    }
    // Spines (saguaro): simple tint over the spine albedo.
    spines.domElement.style.display = isCactus ? '' : 'none';
    if (isCactus) {
      spines.addColor(proxy, 'spineTint').name('Spine tint').onChange(mtweak('spineTint'));
    }
    bark.addColor(proxy, 'barkTint').name('Tint').onChange(mtweak('barkTint'));
    bark.add(proxy, 'barkFlat').name('Flat shading').onChange(mtweak('barkFlat'));
  }
  buildLeafBarkControls();

  // Optimization: LOD chain preview + switch distances + billboard bake options.
  if (optState && onOpt) {
    const opt = gui.addFolder('Optimization / LODs');
    opt.add(optState, 'preview', {
      'Auto (by distance)': 'auto',
      'LOD0 — full detail': 0,
      'LOD1 — reduced geometry': 1,
      'LOD2 — baked cards': 2,
      'LOD3 — billboard': 3,
    }).name('Preview level').onChange(() => onOpt('preview'));
    // Mobile target: keep the full mesh ladder built but hidden; render the baked
    // card LOD2 as the near LOD plus two cheaper card levels. In this mode the
    // LOD1/LOD2 dials retarget onto those two card levels, so their labels switch
    // to card semantics and the mesh-only dials (budget %, mesh quality — no-ops
    // on a card LOD) hide. applyMobileOptLabels() below does the swap.
    cMobile = opt.add(optState, 'mobileTarget').name('Mobile performance target')
      .onChange(() => { applyMobileUI(); onOpt('rebuild'); });
    cMeshQ = opt.add(optState, 'meshQuality', 0.3, 1, 0.05).name('LOD0 mesh quality').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'lod1Dist', 5, 80, 1).name('LOD1 at (m)').onChange(() => onOpt('dist'));
    opt.add(optState, 'lod2Dist', 15, 150, 1).name('LOD2 at (m)').onChange(() => onOpt('dist'));
    opt.add(optState, 'billboardDist', 30, 300, 1).name('Billboard at (m)').onChange(() => onOpt('dist'));
    // Triangle BUDGETS as % of LOD0 — the builder solves mesh/leaf params to hit
    // them (HUD shows the achieved percentages). Look dials below don't change
    // the budget, only where it's spent.
    cLod1Pct = opt.add(optState, 'lod1Pct', 15, 85, 5).name('LOD1 budget (%)').onChange(() => onOpt('rebuild'));
    cLod1Den = opt.add(optState, 'lod1Density', 0.3, 1, 0.05).name('LOD1 foliage density').onChange(() => onOpt('rebuild'));
    cLod1Prn = opt.add(optState, 'lod1Prune', 0, 0.85, 0.05).name('LOD1 branch prune').onChange(() => onOpt('rebuild'));
    cLod2Pct = opt.add(optState, 'lod2Pct', 4, 40, 1).name('LOD2 budget (%)').onChange(() => onOpt('rebuild'));
    cLod2Den = opt.add(optState, 'lod2Density', 0.2, 1, 0.05).name('LOD2 foliage density').onChange(() => onOpt('rebuild'));
    cLod2Prn = opt.add(optState, 'lod2Prune', 0, 0.85, 0.05).name('LOD2 branch prune').onChange(() => onOpt('rebuild'));
    applyMobileUI(); // reflect the initial species + mobile state (hides toggle on rosettes)
    // Bake quality: card res/variants invalidate the card cache → rebake+rebuild.
    opt.add(optState, 'cardRes', { '256²': 256, '512²': 512, '1024²': 1024 }).name('Card bake res').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'cardVariants', { 2: 2, 3: 3, 4: 4 }).name('Card variants').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'billboardRes', { '512²': 512, '1024²': 1024, '2048²': 2048 }).name('Billboard res').onChange(() => onOpt('rebake'));
  }

  if (sunState && onSun) {
    const env = gui.addFolder('Environment');
    env.add(sunState, 'az', 0, 360, 1).name('Sun azimuth').onChange(() => onSun());
    env.add(sunState, 'el', 5, 88, 1).name('Sun elevation').onChange(() => onSun());
    if (windState && onWind) {
      env.add(windState, 'strength', 0, 1, 0.05).name('Wind strength').onChange(() => onWind());
      env.add(windState, 'speed', 0.2, 2.5, 0.05).name('Wind speed').onChange(() => onWind());
    }
    if (envState && onScaleRef) {
      env.add(envState, 'showScaleRef').name('Scale ref (1.8m)').onChange((v) => onScaleRef(v));
      if (onFog) env.add(envState, 'fog').name('Distance fog').onChange(() => onFog());
      if (onSpom) env.add(envState, 'spom').name('Parallax terrain (SPOM)').onChange(() => onSpom());
      if (onGtao) env.add(envState, 'gtao').name('Ambient occlusion (GTAO)').onChange(() => onGtao());
      if (onAA) env.add(envState, 'aa').name('Antialiasing (MSAA)').onChange(() => onAA());
      if (onForest) env.add(envState, 'forestCount', 0, 96, 8).name('Forest trees').onChange(() => onForest());
    }
  }

  // Camera: orbit auto-rotate (ez-tree parity).
  if (camState && onCamera) {
    const cam = gui.addFolder('Camera');
    cam.add(camState, 'autoRotate').name('Auto-rotate').onChange(() => onCamera());
    cam.add(camState, 'autoRotateSpeed', 0, 4, 0.1).name('Rotate speed').onChange(() => onCamera());
  }

  gui.add({ export: () => onExport() }, 'export').name('⬇ Download .glb');
  if (onExportPNG) gui.add({ png: () => onExportPNG() }, 'png').name('📷 Export PNG');

  // Save / Load preset (ez-tree parity): the whole editable state (species +
  // curated controls + advanced per-level overrides + growth force + seed) round-
  // trips through a small JSON file, so a tuned tree is shareable and reloadable.
  function applyPreset(preset) {
    const key = preset?.species;
    if (!key || !speciesMap[key]) { console.error('[preset] unknown species:', key); return; }
    state.speciesKey = key;
    // Merge over fresh defaults so a preset from an older version still fills gaps.
    state.controls = { ...controlsFromSpecies(speciesMap[key]), ...(preset.controls || {}) };
    proxy.species = speciesMap[key].name;
    Object.assign(proxy, state.controls);
    buildParamControls();
    buildAdvancedControls();
    buildLeafBarkControls();
    applyMobileUI(); // hide the mobile toggle on desert species
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    onLoadRebuild?.(); // main.js: biome + build for the loaded state (no controls reset)
  }
  const savePreset = () => {
    const preset = { format: 'seedthree-preset/1', species: state.speciesKey, controls: state.controls };
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${speciesMap[state.speciesKey].name.replace(/\s+/g, '_')}_seed${state.controls.seed}.seedthree.json`;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const loadPreset = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      try { applyPreset(JSON.parse(await f.text())); }
      catch (e) { console.error('[preset] load failed:', e); }
    };
    inp.click();
  };
  const io = gui.addFolder('Save & Load');
  io.add({ save: () => savePreset() }, 'save').name('💾 Save preset');
  io.add({ load: () => loadPreset() }, 'load').name('📂 Load preset');

  // Sections start collapsed — the panel opens as a tidy list of headings.
  gui.foldersRecursive().forEach((f) => f.close());

  // Refresh proxy fields from state (e.g. after a species change) so the panel
  // reflects the new defaults.
  function syncFromState() {
    proxy.species = speciesMap[state.speciesKey].name;
    Object.assign(proxy, state.controls);
    gui.controllersRecursive().forEach((ctrl) => ctrl.updateDisplay());
  }

  return { gui, syncFromState, applyPreset };
}
