// Cattail/reed card preset. SeedThree owns the plant asset and rendering
// primitive; applications decide where their wetland/shoreline habitat is.

import {
  createCardClumpGeometry,
  createGroundCoverMaterial,
} from './ground-cover.js';

export const CATTAIL_TEXTURE_FILES = {
  albedo: 'cattail_reed_card.png',
  normal: 'cattail_reed_card_normal.png',
  roughness: 'cattail_reed_card_roughness.png',
  translucency: 'cattail_reed_card_translucency.png',
};

export const CATTAIL_CARD_SPEC = {
  quads: 4,
  width: 0.78,
  tiltMin: 0.025,
  tiltSpan: 0.12,
  heightMin: 0.9,
  heightSpan: 0.2,
  baseSpread: 0.08,
};

export function createCattailGeometry(overrides = {}) {
  return createCardClumpGeometry({ ...CATTAIL_CARD_SPEC, ...overrides });
}

export function createCattailMaterial(textures, options = {}) {
  return createGroundCoverMaterial({
    name: 'SeedThree cattails',
    textures,
    transmit: [0.28, 0.42, 0.13],
    windAmount: 0.22,
    ...options,
  });
}
