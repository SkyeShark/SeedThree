import { Object3D, UnsignedByteType } from "three";
import { diffuseColor, directionToColor, mrt, normalView, output, pass, } from "three/tsl";
/**
 * Create a minimal scene pass with the beauty, depth, diffuse, and encoded
 * normal outputs needed by N8AONode.
 */
export function createN8AOScenePass(scene, camera) {
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({
        output,
        diffuseColor,
        normal: directionToColor(normalView),
    }));
    // Match the bandwidth optimization used by the original integration.
    scenePass.getTexture("diffuseColor").type = UnsignedByteType;
    scenePass.getTexture("normal").type = UnsignedByteType;
    return scenePass;
}
//# sourceMappingURL=createN8AOScenePass.js.map