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

// Default friendly-control values, read from the active species' schema.
export function controlsFromSpecies(species) {
  const c = { seed: 1, showLeaves: true, tileWorldSize: species.tileWorldSize ?? 1.5 };
  for (const d of species.controls ?? []) c[d.key] = d.get(species);
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
  if (c.showLeaves === false) s.foliage = false;
  return s;
}

/**
 * @param {object} opts { speciesList, state, onChange, onRandomize, onExport, stats }
 *   state: { speciesKey, controls }  (mutated live by the GUI)
 *   stats: { species, seed, stems, leaves, triangles } — updated via returned api
 */
export function buildGUI(opts) {
  const { speciesMap, state, sunState, envState, optState, windState, onChange, onRandomize, onExport, onSun, onScaleRef, onFog, onWind, onForest, onSpom, onOpt } = opts;
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

  gui.add(proxy, 'species', speciesNames).name('Species').onChange((key) => {
    state.speciesKey = key;
    onChange(true); // species changed → main.js resets state.controls (sync)
    Object.assign(proxy, state.controls);
    proxy.species = speciesMap[key].name;
    buildParamControls(); // rebuild sliders for this species' branching type
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
    opt.add(optState, 'meshQuality', 0.3, 1, 0.05).name('LOD0 mesh quality').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'lod1Dist', 5, 80, 1).name('LOD1 at (m)').onChange(() => onOpt('dist'));
    opt.add(optState, 'lod2Dist', 15, 150, 1).name('LOD2 at (m)').onChange(() => onOpt('dist'));
    opt.add(optState, 'billboardDist', 30, 300, 1).name('Billboard at (m)').onChange(() => onOpt('dist'));
    // Triangle BUDGETS as % of LOD0 — the builder solves mesh/leaf params to hit
    // them (HUD shows the achieved percentages). Look dials below don't change
    // the budget, only where it's spent.
    opt.add(optState, 'lod1Pct', 15, 85, 5).name('LOD1 budget (%)').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'lod1Density', 0.3, 1, 0.05).name('LOD1 foliage density').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'lod1Prune', 0, 0.85, 0.05).name('LOD1 branch prune').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'lod2Pct', 4, 40, 1).name('LOD2 budget (%)').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'lod2Density', 0.2, 1, 0.05).name('LOD2 foliage density').onChange(() => onOpt('rebuild'));
    opt.add(optState, 'lod2Prune', 0, 0.85, 0.05).name('LOD2 branch prune').onChange(() => onOpt('rebuild'));
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
      if (onForest) env.add(envState, 'forestCount', 0, 96, 8).name('Forest trees').onChange(() => onForest());
    }
  }

  gui.add({ export: () => onExport() }, 'export').name('⬇ Download .glb');

  // Sections start collapsed — the panel opens as a tidy list of headings.
  gui.foldersRecursive().forEach((f) => f.close());

  // Refresh proxy fields from state (e.g. after a species change) so the panel
  // reflects the new defaults.
  function syncFromState() {
    proxy.species = speciesMap[state.speciesKey].name;
    Object.assign(proxy, state.controls);
    gui.controllersRecursive().forEach((ctrl) => ctrl.updateDisplay());
  }

  return { gui, syncFromState };
}
