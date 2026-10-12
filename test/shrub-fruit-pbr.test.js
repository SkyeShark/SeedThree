import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { SPECIES } from '../src/species/index.js';
import { generate, placeholderAssets } from '../src/api/seedthree.js';
import { prepareFruitGeometry } from '../src/core/fruit.js';

for (const key of ['commonJuniper','bilberry','raspberry']) {
  test(`${key} embeds PBR maps at real size and bears outer-shoot fruit over ten seeds`, () => {
    const sp=SPECIES[key],b=readFileSync(new URL('../assets/fruits/'+sp.fruit.mesh,import.meta.url));
    const j=JSON.parse(b.toString('utf8',20,20+b.readUInt32LE(12)));
    const p=j.meshes[0].primitives[0],m=j.materials[p.material],a=j.accessors[p.attributes.POSITION];
    assert.ok(m.pbrMetallicRoughness.baseColorTexture);
    assert.ok(m.pbrMetallicRoughness.metallicRoughnessTexture);
    assert.ok(m.normalTexture);
    assert.equal(p.attributes.COLOR_0,undefined);
    assert.ok(j.images.every(i=>Number.isInteger(i.bufferView)), 'maps must be embedded');
    const d=a.max.map((v,i)=>v-a.min[i]);
    assert.ok(d.every(v=>Number.isFinite(v)&&v>0&&v<.06), 'GLB must be authored in metres');
    assert.ok(sp.fruit.startFrac>=.6);
    const assets=placeholderAssets(key);
    // Placement consumes the fruit bounds; a box with the GLB's exact bounds
    // exercises that same branch-intersection rejection without image decoding.
    assets.fruitGeo=prepareFruitGeometry(new BoxGeometry(...d));
    assets.fruitMat=new MeshStandardNodeMaterial();
    for(let seed=1;seed<=10;seed++) {
      const g=generate({species:key,seed,assets}).group;
      const counts=g.levels.map(l=>l.object.userData.fruitMesh?.count??0);
      assert.ok(counts[0]>0, `${key} seed ${seed} must bear fruit`);
      assert.equal(counts[2],0,'far rung must avoid fruit instance cost');
      g.traverse(o=>{if(o.userData.fruitMesh)o.userData.fruitMesh.geometry.dispose();});
    }
  });
}
