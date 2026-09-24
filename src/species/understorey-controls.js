// Shared extras for the leaf-atlas garden species (pomegranate, fig,
// tamarisk): the broadleaf vocabulary + fruit / flower toggles. Fruit and
// flowers are ATLAS pieces on the leaf material, so toggling them never adds a
// material.

import { broadleafControls } from './broadleaf-controls.js';

// Fruit on/off: the shaped copy drops its fruit config (tree.js hangs none).
export const fruitToggle = (name = 'Fruit') => ({
  key: 'fruit', name, dropdown: { Off: 0, On: 1 },
  get: (s) => (s.fruit ? 1 : 0),
  set: (s, v) => { if (!Number(v)) s.fruit = null; },
});

// Flower accents on/off (foliage.accents — leaf-atlas flower cards).
export const flowerToggle = (name = 'Flowers') => ({
  key: 'flowers', name, dropdown: { Off: 0, On: 1 },
  get: (s) => (s.foliage?.accents?.some((a) => a.enabled !== false) ? 1 : 0),
  set: (s, v) => {
    if (s.foliage?.accents) s.foliage.accents = s.foliage.accents.map((a) => ({ ...a, enabled: !!Number(v) }));
  },
});

export const understoreyControls = (extras) => [...broadleafControls, ...extras];
