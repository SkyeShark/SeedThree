// Whole-crown textures are deliberately low frequency. Keep their ENTIRE
// bounding sphere at least 20m away, even when a grove forces the LOD2 rung.
// Basing this on the surface envelope (not just the trunk) also covers tall
// crowns, scaled grove slots and a camera walking inside the crown.
export const CROWN_UNDERLAY_NEAR_CLEARANCE = 20;
export function crownUnderlayVisible(cameraPosition, center, radius) {
  return cameraPosition.distanceToSquared(center)
    >= (Math.max(0, radius) + CROWN_UNDERLAY_NEAR_CLEARANCE) ** 2;
}
export function updateCrownUnderlays(root, camera) {
  root.updateWorldMatrix(true, true);
  root.traverse(mesh => {
    if (!mesh.userData.crownUnderlayBounds) return;
    const sphere = mesh.userData.crownUnderlayBounds.clone().applyMatrix4(mesh.matrixWorld);
    mesh.visible = crownUnderlayVisible(camera.position, sphere.center, sphere.radius);
  });
}
