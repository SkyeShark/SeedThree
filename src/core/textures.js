// Texture registry. Uses Vite's import.meta.glob so bark/leaf textures resolve to
// correct served URLs in dev AND get bundled into production builds — no reliance
// on the dev server happening to serve the project root. Keyed by basename so
// species presets can reference e.g. 'white_oak_albedo.png'.

const barkModules = import.meta.glob('/assets/bark/*.png', {
  eager: true, query: '?url', import: 'default',
});
const leafModules = import.meta.glob('/assets/leaves/*.png', {
  eager: true, query: '?url', import: 'default',
});
const groundModules = import.meta.glob('/assets/ground/*.png', {
  eager: true, query: '?url', import: 'default',
});
const skyModules = import.meta.glob('/assets/sky/*.png', {
  eager: true, query: '?url', import: 'default',
});

function byBasename(modules) {
  const out = {};
  for (const [path, url] of Object.entries(modules)) {
    out[path.split('/').pop()] = url;
  }
  return out;
}

export const barkUrls = byBasename(barkModules);
export const leafUrls = byBasename(leafModules);
export const groundUrls = byBasename(groundModules);
export const skyUrls = byBasename(skyModules);

export function groundUrl(name) {
  const url = groundUrls[name];
  if (!url) console.warn(`[textures] ground "${name}" not found; have: ${Object.keys(groundUrls).join(', ')}`);
  return url;
}

export function skyUrl(name) {
  const url = skyUrls[name];
  if (!url) console.warn(`[textures] sky "${name}" not found; have: ${Object.keys(skyUrls).join(', ')}`);
  return url;
}

export function barkUrl(name) {
  const url = barkUrls[name];
  if (!url) console.warn(`[textures] bark "${name}" not found; have: ${Object.keys(barkUrls).join(', ')}`);
  return url;
}

export function leafUrl(name) {
  const url = leafUrls[name];
  if (!url) console.warn(`[textures] leaf "${name}" not found; have: ${Object.keys(leafUrls).join(', ')}`);
  return url;
}
