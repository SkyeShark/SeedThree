import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Sphere, Group, Mesh, PerspectiveCamera } from 'three/webgpu';
import { crownUnderlayVisible, updateCrownUnderlays } from '../src/core/crown-underlay.js';

test('whole crown culls while its nearest surface is within 20m', () => {
  const center = new Vector3(0,12,0);
  assert.equal(crownUnderlayVisible(new Vector3(0,12,0),center,15),false);
  assert.equal(crownUnderlayVisible(new Vector3(0,12,34),center,15),false);
  assert.equal(crownUnderlayVisible(new Vector3(0,12,36),center,15),true);
});
test('hero policy accounts for translated and scaled plants without hiding sprays', () => {
  const root = new Group(), mesh = new Mesh(), spray = new Mesh(), camera = new PerspectiveCamera();
  root.add(mesh,spray); root.position.set(100,0,0); root.scale.setScalar(2);
  mesh.userData.crownUnderlayBounds = new Sphere(new Vector3(0,10,0),10);
  camera.position.set(100,20,39); updateCrownUnderlays(root,camera);
  assert.equal(mesh.visible,false); assert.equal(spray.visible,true);
  camera.position.z=41; updateCrownUnderlays(root,camera); assert.equal(mesh.visible,true);
});
