// Resolve GLBs through Vite so the same embedded PBR assets are available in
// dev and production. A raw project-relative URL was only served in dev.
const modules = import.meta.glob('/assets/fruits/*.glb', {
  eager: true, query: '?url', import: 'default',
});
const urls = Object.fromEntries(Object.entries(modules)
  .map(([path,url]) => [path.split('/').pop(),url]));
export function fruitUrl(name) {
  const url = urls[name];
  if (!url) throw new Error(`[SeedThree] fruit asset "${name}" not found`);
  return url;
}
