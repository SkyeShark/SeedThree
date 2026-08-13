import { Color, DataTexture, DepthTexture, FloatType, HalfFloatType, LinearFilter, Matrix4, NearestFilter, NoColorSpace, Object3D, RedFormat, RepeatWrapping, RGBAFormat, Texture, Vector2, Vector3, } from "three";
import { NodeMaterial, QuadMesh, RenderTarget, RendererUtils, TempNode, } from "three/webgpu";
import { Fn, If, Loop, NodeUpdateType, abs, clamp, cross, distance, dot, exp, float, floor, fwidth, getScreenPosition, getViewPosition, int, ivec2, mat2, max, min, mix, normalize, passTexture, pow, property, mrt, sRGBTransferOETF, smoothstep, step, sub, texture, textureLoad, uniform, uniformArray, uv, vec2, vec3, vec4, } from "three/tsl";
import bluenoiseBits from "./BlueNoise.js";
import { applyQualityMode, createDefaultN8AOConfiguration, generateDenoiseSamples, generateHemisphereSamples, resolveDisplayMode, } from "./math.js";
/**
 * Custom version of three.js's getNormalFromDepth that accepts a resolution
 * uniform instead of calling textureSize(). The built-in version generates
 * `textureDimensions(tex, level)` for all textures, but WGSL does not allow a
 * level argument for `texture_depth_multisampled_2d`. Passing resolution
 * externally avoids the invalid overload.
 */
const getNormalFromDepthWithResolution = /* @__PURE__ */ Fn(([uvCoord, depthTex, projMatInverse, res]) => {
    const p = ivec2(uvCoord.x.mul(res.x), uvCoord.y.mul(res.y)).toVar();
    const c0 = textureLoad(depthTex, p).x.toVar();
    const l2 = textureLoad(depthTex, p.sub(ivec2(2, 0))).x.toVar();
    const l1 = textureLoad(depthTex, p.sub(ivec2(1, 0))).x.toVar();
    const r1 = textureLoad(depthTex, p.add(ivec2(1, 0))).x.toVar();
    const r2 = textureLoad(depthTex, p.add(ivec2(2, 0))).x.toVar();
    const b2 = textureLoad(depthTex, p.add(ivec2(0, 2))).x.toVar();
    const b1 = textureLoad(depthTex, p.add(ivec2(0, 1))).x.toVar();
    const t1 = textureLoad(depthTex, p.sub(ivec2(0, 1))).x.toVar();
    const t2 = textureLoad(depthTex, p.sub(ivec2(0, 2))).x.toVar();
    const dl = abs(sub(float(2).mul(l1).sub(l2), c0)).toVar();
    const dr = abs(sub(float(2).mul(r1).sub(r2), c0)).toVar();
    const db = abs(sub(float(2).mul(b1).sub(b2), c0)).toVar();
    const dt = abs(sub(float(2).mul(t1).sub(t2), c0)).toVar();
    const ce = getViewPosition(uvCoord, c0, projMatInverse).toVar();
    const dpdx = dl
        .lessThan(dr)
        .select(ce.sub(getViewPosition(uvCoord.sub(vec2(float(1).div(res.x), 0)), l1, projMatInverse)), ce
        .negate()
        .add(getViewPosition(uvCoord.add(vec2(float(1).div(res.x), 0)), r1, projMatInverse)));
    const dpdy = db
        .lessThan(dt)
        .select(ce.sub(getViewPosition(uvCoord.add(vec2(0, float(1).div(res.y))), b1, projMatInverse)), ce
        .negate()
        .add(getViewPosition(uvCoord.sub(vec2(0, float(1).div(res.y))), t1, projMatInverse)));
    return normalize(cross(dpdx, dpdy));
});
function createPlaceholderTexture(data) {
    const texture = new DataTexture(new Uint8Array(data), 1, 1);
    texture.colorSpace = NoColorSpace;
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
}
function isMaterialTransparent(material) {
    if (!material || typeof material !== "object") {
        return false;
    }
    return material.transparent === true;
}
function hasTransparentMaterial(material) {
    if (Array.isArray(material)) {
        return material.some(isMaterialTransparent);
    }
    return isMaterialTransparent(material);
}
function hasTransparentMaterialWithDepthWrite(material) {
    if (Array.isArray(material)) {
        return material.some((entry) => isMaterialTransparent(entry) &&
            entry.depthWrite === true);
    }
    return (isMaterialTransparent(material) &&
        material.depthWrite === true);
}
function hasTransparentMaterialWithoutDepthWrite(material) {
    if (Array.isArray(material)) {
        return material.some((entry) => isMaterialTransparent(entry) &&
            entry.depthWrite !== true);
    }
    return (isMaterialTransparent(material) &&
        material.depthWrite !== true);
}
export class N8AONode extends TempNode {
    configuration;
    updateBeforeType = NodeUpdateType.FRAME;
    beautyNode;
    beautyTexture;
    camera;
    depthNode;
    depthTexture;
    normalNode;
    normalTexture;
    scene;
    scenePassNode;
    quadMesh = new QuadMesh();
    blueNoiseTexture = new DataTexture(bluenoiseBits, 128, 128);
    outputTarget = new RenderTarget(1, 1, {
        depthBuffer: false,
        format: RGBAFormat,
        minFilter: LinearFilter,
        type: HalfFloatType,
    });
    aoTargetA = new RenderTarget(1, 1, {
        depthBuffer: false,
        format: RGBAFormat,
        magFilter: LinearFilter,
        minFilter: LinearFilter,
    });
    aoTargetB = new RenderTarget(1, 1, {
        depthBuffer: false,
        format: RGBAFormat,
        magFilter: LinearFilter,
        minFilter: LinearFilter,
    });
    accumulationTargetA = new RenderTarget(1, 1, {
        depthBuffer: false,
        format: RGBAFormat,
        magFilter: LinearFilter,
        minFilter: LinearFilter,
        type: HalfFloatType,
    });
    accumulationTargetB = new RenderTarget(1, 1, {
        depthBuffer: false,
        format: RGBAFormat,
        magFilter: LinearFilter,
        minFilter: LinearFilter,
        type: HalfFloatType,
    });
    depthDownsampleTarget = null;
    transparencyTargetDepthWriteFalse = null;
    transparencyTargetDepthWriteTrue = null;
    outputTextureNode = passTexture(this, this.outputTarget.texture);
    aoMaterial = new NodeMaterial();
    accumulationMaterial = new NodeMaterial();
    blurMaterial = new NodeMaterial();
    compositeMaterial = new NodeMaterial();
    depthCopyMaterial = new NodeMaterial();
    downsampleMaterial = new NodeMaterial();
    resolution = new Vector2();
    lastViewMatrix = new Matrix4();
    lastProjectionMatrix = new Matrix4();
    linearColor = new Color();
    sharedColor = new Vector3();
    cameraWorldPosition = new Vector3();
    resolutionNode = uniform(new Vector2(1, 1));
    fullResolutionNode = uniform(new Vector2(1, 1));
    cameraNearNode = uniform(0.1);
    cameraFarNode = uniform(1000);
    projectionMatrixNode = uniform(new Matrix4());
    projectionMatrixInverseNode = uniform(new Matrix4());
    cameraWorldPositionNode = uniform(new Vector3());
    biasAdjustmentNode = uniform(new Vector2());
    radiusNode = uniform(5);
    distanceFalloffNode = uniform(1);
    frameNode = uniform(0);
    screenSpaceRadiusNode = uniform(false);
    blurRadiusNode = uniform(12);
    blurIndexNode = uniform(0);
    blurWorldRadiusNode = uniform(5);
    intensityNode = uniform(5);
    renderModeNode = uniform(0);
    aoTonesNode = uniform(0);
    colorNode = uniform(new Vector3());
    gammaCorrectionNode = uniform(false);
    orthoNode = uniform(false);
    fogEnabledNode = uniform(false);
    fogExpNode = uniform(false);
    fogDensityNode = uniform(0);
    fogNearNode = uniform(0);
    fogFarNode = uniform(0);
    colorMultiplyNode = uniform(true);
    transparencyAwareNode = uniform(false);
    halfResNode = uniform(false);
    blueNoiseNode = texture(this.blueNoiseTexture);
    aoSourceTextureNode = texture(this.aoTargetA.texture);
    accumulationCurrentTextureNode = texture(this.aoTargetA.texture);
    accumulationPreviousTextureNode = texture(this.accumulationTargetA.texture);
    compositeAoTextureNode = texture(this.accumulationTargetA.texture);
    depthCopySourceTextureNode;
    placeholderDepthTexture = createPlaceholderTexture([
        255, 255, 255, 255,
    ]);
    placeholderNormalTexture = createPlaceholderTexture([
        128, 128, 255, 255,
    ]);
    placeholderTransparentTexture = createPlaceholderTexture([
        0, 0, 0, 0,
    ]);
    downsampledDepthTextureNode = texture(this.placeholderDepthTexture);
    downsampledNormalTextureNode = texture(this.placeholderNormalTexture);
    transparencyDepthWriteFalseTextureNode = texture(this.placeholderTransparentTexture);
    transparencyDepthWriteTrueTextureNode = texture(this.placeholderTransparentTexture);
    transparencyDepthWriteTrueDepthTextureNode = texture(this.placeholderDepthTexture);
    aoSampleArrayNode = uniformArray(generateHemisphereSamples(createDefaultN8AOConfiguration().aoSamples));
    blurSampleArrayNode = uniformArray(generateDenoiseSamples(createDefaultN8AOConfiguration().denoiseSamples, 11));
    frame = 0;
    width = 1;
    height = 1;
    needsFrame = true;
    autoDetectTransparency = true;
    sharedContext = null;
    rendererState;
    constructor(input) {
        super("vec4");
        this.beautyNode = input.beautyNode;
        this.beautyTexture = input.beautyTexture;
        this.camera = input.camera;
        this.depthNode = input.depthNode;
        this.depthTexture = input.depthTexture;
        this.normalNode = input.normalNode;
        this.normalTexture = input.normalTexture;
        this.scenePassNode = input.scenePassNode ?? null;
        this.scene = input.scene;
        this.blueNoiseTexture.colorSpace = NoColorSpace;
        this.blueNoiseTexture.wrapS = RepeatWrapping;
        this.blueNoiseTexture.wrapT = RepeatWrapping;
        this.blueNoiseTexture.minFilter = NearestFilter;
        this.blueNoiseTexture.magFilter = NearestFilter;
        this.blueNoiseTexture.needsUpdate = true;
        this.depthCopySourceTextureNode = texture(this.depthTexture);
        this.aoMaterial.name = "N8AO.AO";
        this.blurMaterial.name = "N8AO.Blur";
        this.accumulationMaterial.name = "N8AO.Accumulation";
        this.compositeMaterial.name = "N8AO.Composite";
        this.depthCopyMaterial.name = "N8AO.DepthCopy";
        this.downsampleMaterial.name = "N8AO.Downsample";
        this.aoMaterial.depthTest = false;
        this.aoMaterial.depthWrite = false;
        this.blurMaterial.depthTest = false;
        this.blurMaterial.depthWrite = false;
        this.accumulationMaterial.depthTest = false;
        this.accumulationMaterial.depthWrite = false;
        this.compositeMaterial.depthTest = false;
        this.compositeMaterial.depthWrite = false;
        this.downsampleMaterial.depthTest = false;
        this.downsampleMaterial.depthWrite = false;
        this.depthCopyMaterial.depthTest = false;
        this.depthCopyMaterial.depthWrite = true;
        const baseConfiguration = createDefaultN8AOConfiguration();
        this.configuration = new Proxy(baseConfiguration, {
            set: (target, property, value) => {
                const key = property;
                const previousValue = target[key];
                target[key] = value;
                const changed = previousValue instanceof Color && value instanceof Color
                    ? !previousValue.equals(value)
                    : previousValue !== value;
                if (!changed) {
                    return true;
                }
                this.firstFrame();
                if (key === "aoSamples") {
                    this.configureAOPass();
                }
                else if (key === "denoiseSamples") {
                    this.configureDenoisePass();
                }
                else if (key === "halfRes") {
                    this.configureHalfResTargets();
                    this.configureAOPass();
                    this.configureCompositePass();
                }
                else if (key === "depthAwareUpsampling") {
                    this.configureCompositePass();
                }
                else if (key === "transparencyAware") {
                    this.autoDetectTransparency = false;
                    this.configureTransparencyTargets();
                    this.configureCompositePass();
                }
                else if (key === "gammaCorrection" ||
                    key === "colorMultiply" ||
                    key === "renderMode" ||
                    key === "aoTones") {
                    this.configureCompositePass();
                }
                return true;
            },
        });
        this.configureHalfResTargets();
        this.detectTransparency();
        this.configureTransparencyTargets();
        this.configureAOPass();
        this.configureDenoisePass();
        this.configureAccumulationPass();
        this.configureCompositePass();
        this.configureDepthCopyPass();
    }
    dispose() {
        this.outputTarget.dispose();
        this.aoTargetA.dispose();
        this.aoTargetB.dispose();
        this.accumulationTargetA.dispose();
        this.accumulationTargetB.dispose();
        this.depthDownsampleTarget?.dispose();
        this.transparencyTargetDepthWriteFalse?.dispose();
        this.transparencyTargetDepthWriteTrue?.dispose();
        this.blueNoiseTexture.dispose();
        this.placeholderDepthTexture.dispose();
        this.placeholderNormalTexture.dispose();
        this.placeholderTransparentTexture.dispose();
        this.aoMaterial.dispose();
        this.blurMaterial.dispose();
        this.accumulationMaterial.dispose();
        this.compositeMaterial.dispose();
        this.depthCopyMaterial.dispose();
        this.downsampleMaterial.dispose();
    }
    firstFrame() {
        this.needsFrame = true;
    }
    getTextureNode() {
        return this.outputTextureNode;
    }
    setDisplayMode(mode) {
        this.configuration.renderMode = resolveDisplayMode(mode);
    }
    setQualityMode(mode) {
        applyQualityMode(this.configuration, mode);
        this.configureAOPass();
        this.configureDenoisePass();
        this.firstFrame();
    }
    setSize(width, height) {
        this.firstFrame();
        this.width = width;
        this.height = height;
        const scale = this.configuration.halfRes ? 0.5 : 1;
        const scaledWidth = Math.max(1, Math.floor(width * scale));
        const scaledHeight = Math.max(1, Math.floor(height * scale));
        this.aoTargetA.setSize(scaledWidth, scaledHeight);
        this.aoTargetB.setSize(scaledWidth, scaledHeight);
        this.accumulationTargetA.setSize(scaledWidth, scaledHeight);
        this.accumulationTargetB.setSize(scaledWidth, scaledHeight);
        this.outputTarget.setSize(width, height);
        this.depthDownsampleTarget?.setSize(Math.max(1, Math.floor(width * 0.5)), Math.max(1, Math.floor(height * 0.5)));
        this.transparencyTargetDepthWriteFalse?.setSize(width, height);
        this.transparencyTargetDepthWriteTrue?.setSize(width, height);
    }
    setup(builder) {
        this.sharedContext = builder.getSharedContext?.() ?? null;
        this.beautyNode.build(builder);
        this.depthNode.build(builder);
        this.normalNode?.build?.(builder);
        this.configureAOPass();
        this.configureDenoisePass();
        this.configureAccumulationPass();
        this.configureCompositePass();
        this.configureDepthCopyPass();
        if (this.configuration.halfRes) {
            this.configureDownsamplePass();
        }
        return this.outputTextureNode;
    }
    updateBefore(frameContext) {
        const renderer = frameContext.renderer;
        if (renderer === null) {
            return true;
        }
        // The scene pass may not be in PostProcessing's output graph (N8AO
        // replaces it), so it won't receive automatic updateBefore calls.
        // Trigger it manually so the scene renders each frame.
        if (this.scenePassNode !== null) {
            this.scenePassNode.updateBefore(frameContext);
        }
        const currentSize = renderer.getDrawingBufferSize(this.resolution);
        if (currentSize.x !== this.width || currentSize.y !== this.height) {
            this.setSize(currentSize.x, currentSize.y);
        }
        this.camera.updateMatrixWorld();
        this.detectTransparency();
        this.syncConfigurationUniforms();
        if (this.configuration.accumulate &&
            !this.needsFrame &&
            this.lastViewMatrix.equals(this.camera.matrixWorldInverse) &&
            this.lastProjectionMatrix.equals(this.camera.projectionMatrix)) {
            this.frame += 1;
        }
        else {
            this.frame = 0;
            this.needsFrame = false;
            this.clearAccumulationTargets(renderer);
        }
        this.lastViewMatrix.copy(this.camera.matrixWorldInverse);
        this.lastProjectionMatrix.copy(this.camera.projectionMatrix);
        this.rendererState = RendererUtils.resetRendererState(renderer, this.rendererState);
        const previousBackground = this.scene
            .background;
        this.scene.background = null;
        const xrEnabled = renderer.xr.enabled;
        renderer.xr.enabled = false;
        if (this.configuration.transparencyAware) {
            this.renderTransparency(renderer);
        }
        const maxAccumulationFrames = 1024 / this.configuration.aoSamples;
        if (this.frame < maxAccumulationFrames) {
            if (this.configuration.halfRes) {
                renderer.setRenderTarget(this.depthDownsampleTarget);
                this.quadMesh.material = this.downsampleMaterial;
                this.quadMesh.name = "N8AO.Downsample";
                this.quadMesh.render(renderer);
            }
            renderer.setRenderTarget(this.aoTargetA);
            this.quadMesh.material = this.aoMaterial;
            this.quadMesh.name = "N8AO.AO";
            this.quadMesh.render(renderer);
            let readTarget = this.aoTargetA;
            let writeTarget = this.aoTargetB;
            for (let blurIteration = 0; blurIteration < this.configuration.denoiseIterations; blurIteration += 1) {
                this.blurIndexNode.value = blurIteration;
                this.aoSourceTextureNode.value = readTarget.texture;
                renderer.setRenderTarget(writeTarget);
                this.quadMesh.material = this.blurMaterial;
                this.quadMesh.name = "N8AO.Blur";
                this.quadMesh.render(renderer);
                const nextReadTarget = writeTarget;
                const nextWriteTarget = readTarget;
                readTarget = nextReadTarget;
                writeTarget = nextWriteTarget;
            }
            this.accumulationCurrentTextureNode.value = readTarget.texture;
            this.accumulationPreviousTextureNode.value =
                this.accumulationTargetA.texture;
            renderer.setRenderTarget(this.accumulationTargetB);
            this.quadMesh.material = this.accumulationMaterial;
            this.quadMesh.name = "N8AO.Accumulation";
            this.quadMesh.render(renderer);
            const previousAccumulationTarget = this.accumulationTargetA;
            this.accumulationTargetA = this.accumulationTargetB;
            this.accumulationTargetB = previousAccumulationTarget;
            this.accumulationPreviousTextureNode.value =
                this.accumulationTargetA.texture;
            this.compositeAoTextureNode.value = this.accumulationTargetA.texture;
        }
        renderer.setRenderTarget(this.outputTarget);
        this.quadMesh.material = this.compositeMaterial;
        this.quadMesh.name = "N8AO.Composite";
        this.quadMesh.render(renderer);
        renderer.xr.enabled = xrEnabled;
        this.scene.background = previousBackground;
        if (this.rendererState != null) {
            RendererUtils.restoreRendererState(renderer, this.rendererState);
        }
        return true;
    }
    applySharedContext(node) {
        if (!this.sharedContext || typeof node?.context !== "function") {
            return node;
        }
        return node.context(this.sharedContext);
    }
    clearAccumulationTargets(renderer) {
        const previousRenderTarget = renderer.getRenderTarget();
        const previousCubeFace = renderer.getActiveCubeFace?.();
        const previousMipmapLevel = renderer.getActiveMipmapLevel?.();
        const previousClearColor = renderer.getClearColor(new Color());
        const previousClearAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 1);
        renderer.setRenderTarget(this.accumulationTargetA);
        renderer.clear?.(true, true, true);
        renderer.setRenderTarget(this.accumulationTargetB);
        renderer.clear?.(true, true, true);
        renderer.setRenderTarget(previousRenderTarget, previousCubeFace, previousMipmapLevel);
        renderer.setClearColor(previousClearColor, previousClearAlpha);
    }
    detectTransparency() {
        if (!this.autoDetectTransparency) {
            return;
        }
        let hasTransparency = false;
        this.scene.traverse((object) => {
            const material = object.material;
            if (hasTransparentMaterial(material)) {
                hasTransparency = true;
            }
        });
        if (hasTransparency) {
            this.configuration.transparencyAware = true;
        }
    }
    configureHalfResTargets() {
        if (this.configuration.halfRes) {
            this.depthDownsampleTarget?.dispose();
            this.depthDownsampleTarget = new RenderTarget(1, 1, {
                count: 2,
                depthBuffer: false,
            });
            this.depthDownsampleTarget.textures[0].name = "N8AO.DownsampleDepth";
            this.depthDownsampleTarget.textures[0].format = RedFormat;
            this.depthDownsampleTarget.textures[0].type = FloatType;
            this.depthDownsampleTarget.textures[0].magFilter = NearestFilter;
            this.depthDownsampleTarget.textures[0].minFilter = NearestFilter;
            this.depthDownsampleTarget.textures[1].name = "N8AO.DownsampleNormal";
            this.depthDownsampleTarget.textures[1].format = RGBAFormat;
            this.depthDownsampleTarget.textures[1].type = HalfFloatType;
            this.depthDownsampleTarget.textures[1].magFilter = NearestFilter;
            this.depthDownsampleTarget.textures[1].minFilter = NearestFilter;
            this.downsampledDepthTextureNode.value =
                this.depthDownsampleTarget.textures[0];
            this.downsampledNormalTextureNode.value =
                this.depthDownsampleTarget.textures[1];
            this.configureDownsamplePass();
            this.setSize(this.width, this.height);
            return;
        }
        this.depthDownsampleTarget?.dispose();
        this.depthDownsampleTarget = null;
        this.downsampledDepthTextureNode.value = this.placeholderDepthTexture;
        this.downsampledNormalTextureNode.value = this.placeholderNormalTexture;
    }
    configureTransparencyTargets() {
        if (this.configuration.transparencyAware) {
            this.transparencyTargetDepthWriteFalse?.dispose();
            this.transparencyTargetDepthWriteTrue?.dispose();
            this.transparencyTargetDepthWriteFalse = new RenderTarget(1, 1, {
                depthBuffer: true,
                format: RGBAFormat,
                magFilter: NearestFilter,
                minFilter: LinearFilter,
                type: HalfFloatType,
            });
            this.transparencyTargetDepthWriteFalse.texture.name =
                "N8AO.TransparencyDepthWriteFalse";
            this.transparencyTargetDepthWriteTrue = new RenderTarget(1, 1, {
                depthBuffer: true,
                format: RGBAFormat,
                magFilter: NearestFilter,
                minFilter: LinearFilter,
                type: HalfFloatType,
            });
            this.transparencyTargetDepthWriteTrue.depthTexture = new DepthTexture(1, 1);
            this.transparencyTargetDepthWriteTrue.texture.name =
                "N8AO.TransparencyDepthWriteTrue";
            this.transparencyDepthWriteFalseTextureNode.value =
                this.transparencyTargetDepthWriteFalse.texture;
            this.transparencyDepthWriteTrueTextureNode.value =
                this.transparencyTargetDepthWriteTrue.texture;
            this.transparencyDepthWriteTrueDepthTextureNode.value =
                this.transparencyTargetDepthWriteTrue.depthTexture;
            this.configureDepthCopyPass();
            this.setSize(this.width, this.height);
            return;
        }
        this.transparencyTargetDepthWriteFalse?.dispose();
        this.transparencyTargetDepthWriteFalse = null;
        this.transparencyTargetDepthWriteTrue?.dispose();
        this.transparencyTargetDepthWriteTrue = null;
        this.transparencyDepthWriteFalseTextureNode.value =
            this.placeholderTransparentTexture;
        this.transparencyDepthWriteTrueTextureNode.value =
            this.placeholderTransparentTexture;
        this.transparencyDepthWriteTrueDepthTextureNode.value =
            this.placeholderDepthTexture;
    }
    configureDownsamplePass() {
        if (!this.configuration.halfRes || !this.depthDownsampleTarget) {
            return;
        }
        const depthTexture = this.depthTexture;
        const fullResolution = this.fullResolutionNode;
        const projectionMatrixInverse = this.projectionMatrixInverseNode;
        const resolutionNode = this.resolutionNode;
        const depthNode = this.depthNode;
        const depthOutputName = this.depthDownsampleTarget.textures[0].name;
        const normalOutputName = this.depthDownsampleTarget.textures[1].name;
        const fragmentNode = Fn(() => {
            const uvNode = uv();
            const baseUv = uvNode.sub(vec2(0.5).div(fullResolution)).toVar();
            const pixelSize = vec2(1).div(fullResolution).toVar();
            const uv00 = baseUv.toVar();
            const uv10 = baseUv.add(vec2(pixelSize.x, 0)).toVar();
            const uv01 = baseUv.add(vec2(0, pixelSize.y)).toVar();
            const uv11 = baseUv.add(pixelSize).toVar();
            const depth00 = depthNode.sample(uv00).r.toVar();
            const depth10 = depthNode.sample(uv10).r.toVar();
            const depth01 = depthNode.sample(uv01).r.toVar();
            const depth11 = depthNode.sample(uv11).r.toVar();
            const minDepth = depth00.min(depth10).min(depth01.min(depth11)).toVar();
            const maxDepth = depth00.max(depth10).max(depth01.max(depth11)).toVar();
            const fragCoord = vec2(uvNode.x, uvNode.y.oneMinus())
                .mul(resolutionNode.mul(0.5))
                .toVar();
            const targetDepth = fragCoord.x
                .add(fragCoord.y)
                .mod(2)
                .greaterThan(0.5)
                .select(maxDepth, minDepth)
                .toVar();
            const chosenUv = uv00.toVar();
            If(depth10.equal(targetDepth), () => {
                chosenUv.assign(uv10);
            });
            If(depth01.equal(targetDepth), () => {
                chosenUv.assign(uv01);
            });
            If(depth11.equal(targetDepth), () => {
                chosenUv.assign(uv11);
            });
            const chosenDepth = depthNode.sample(chosenUv).r.toVar();
            const chosenNormal = getNormalFromDepthWithResolution(chosenUv, depthTexture, projectionMatrixInverse, fullResolution).toVar();
            return mrt({
                [depthOutputName]: vec4(chosenDepth, 0, 0, 1),
                [normalOutputName]: vec4(chosenNormal, 0),
            });
        });
        this.downsampleMaterial.fragmentNode =
            this.applySharedContext(fragmentNode());
        this.downsampleMaterial.needsUpdate = true;
    }
    configureAOPass() {
        this.aoSampleArrayNode = uniformArray(generateHemisphereSamples(this.configuration.aoSamples));
        const aoNode = this.createAONode();
        this.aoMaterial.fragmentNode = this.applySharedContext(aoNode);
        this.aoMaterial.needsUpdate = true;
    }
    configureDenoisePass() {
        this.blurSampleArrayNode = uniformArray(generateDenoiseSamples(this.configuration.denoiseSamples, 11));
        const blurNode = this.createBlurNode();
        this.blurMaterial.fragmentNode = this.applySharedContext(blurNode);
        this.blurMaterial.needsUpdate = true;
    }
    configureAccumulationPass() {
        const fragmentNode = Fn(() => {
            const uvNode = uv();
            const currentAo = this.accumulationCurrentTextureNode
                .sample(uvNode)
                .rgb.toVar();
            const previousAo = this.accumulationPreviousTextureNode
                .sample(uvNode)
                .rgb.toVar();
            const alpha = 1 / (this.frame + 1);
            return vec4(mix(previousAo, currentAo, alpha), 1);
        });
        this.accumulationMaterial.fragmentNode =
            this.applySharedContext(fragmentNode());
        this.accumulationMaterial.needsUpdate = true;
    }
    configureCompositePass() {
        const compositeNode = this.createCompositeNode();
        this.compositeMaterial.fragmentNode =
            this.applySharedContext(compositeNode);
        this.compositeMaterial.needsUpdate = true;
    }
    configureDepthCopyPass() {
        const fragmentNode = Fn(() => vec4(0, 0, 0, 0));
        this.depthCopyMaterial.fragmentNode =
            this.applySharedContext(fragmentNode());
        this.depthCopyMaterial.depthNode = this.applySharedContext(this.depthCopySourceTextureNode.sample(uv()).x.add(0.00001));
        this.depthCopyMaterial.needsUpdate = true;
    }
    createAONode() {
        const resolution = this.resolutionNode;
        const projectionMatrix = this.projectionMatrixNode;
        const projectionMatrixInverse = this.projectionMatrixInverseNode;
        const radius = this.radiusNode;
        const distanceFalloff = this.distanceFalloffNode;
        const cameraNear = this.cameraNearNode;
        const cameraFar = this.cameraFarNode;
        const frame = this.frameNode;
        const biasAdjustment = this.biasAdjustmentNode;
        const aoDepthNode = this.getAoDepthNode();
        const aoDepthTexture = this.getAoDepthTexture();
        const blueNoiseNode = this.blueNoiseNode;
        const downsampledNormalTextureNode = this.downsampledNormalTextureNode;
        const orthoNode = this.orthoNode;
        const screenSpaceRadiusNode = this.screenSpaceRadiusNode;
        const aoSamples = this.configuration.aoSamples;
        const halfRes = this.configuration.halfRes;
        return Fn(() => {
            const uvNode = uv();
            const depth = aoDepthNode.sample(uvNode).x.toVar();
            const encodedNormal = property("vec3");
            const result = property("vec4");
            If(depth.equal(1), () => {
                result.assign(vec4(1, 1, 1, 1));
            }).Else(() => {
                const viewPosition = getViewPosition(uvNode, depth, projectionMatrixInverse).toVar();
                const normal = halfRes
                    ? downsampledNormalTextureNode.sample(uvNode).rgb.toVar()
                    : getNormalFromDepthWithResolution(uvNode, aoDepthTexture, projectionMatrixInverse, resolution).toVar();
                const noiseUv = vec2(uvNode.x, uvNode.y.oneMinus())
                    .mul(resolution)
                    .div(128)
                    .toVar();
                const noise = blueNoiseNode.sample(noiseUv).toVar();
                const noiseX = noise.x
                    .add(frame.mul(1.618033988749895))
                    .fract()
                    .toVar();
                const noiseY = noise.y
                    .add(frame.mul(1.324717957244746))
                    .fract()
                    .toVar();
                const helper = vec3(0, 1, 0).toVar();
                If(dot(helper, normal).greaterThan(0.99), () => {
                    helper.assign(vec3(1, 0, 0));
                });
                const tangent = helper.cross(normal).normalize().toVar();
                const bitangent = normal.cross(tangent).toVar();
                const rotationAngle = noiseX.mul(Math.PI * 2).toVar();
                const rotationSin = rotationAngle.sin().toVar();
                const rotationCos = rotationAngle.cos().toVar();
                const radiusToUse = screenSpaceRadiusNode
                    .select(distance(viewPosition, getViewPosition(uvNode.add(vec2(radius, 0).div(resolution)), depth, projectionMatrixInverse)), radius)
                    .toVar();
                const distanceFalloffToUse = screenSpaceRadiusNode
                    .select(radiusToUse.mul(distanceFalloff), radiusToUse.mul(distanceFalloff).mul(0.2))
                    .toVar();
                const computedBias = biasAdjustment.x
                    .add(biasAdjustment.y.mul(min(0.1, distanceFalloffToUse.mul(0.1))
                    .div(cameraNear)
                    .mul(fwidth(viewPosition.length()))
                    .div(radiusToUse)))
                    .toVar();
                const occluded = float(0).toVar();
                const totalWeight = float(0).toVar();
                const offsetMove = noiseY.toVar();
                const offsetMoveInv = (1 / this.configuration.aoSamples);
                const farTimesNear = cameraFar.mul(cameraNear).toVar();
                const farMinusNear = cameraFar.sub(cameraNear).toVar();
                Loop({
                    condition: "<",
                    end: int(aoSamples),
                    start: int(0),
                    type: "int",
                }, ({ i }) => {
                    const hemisphereSample = this.aoSampleArrayNode.element(i).toVar();
                    const rotatedSample = vec3(rotationCos
                        .mul(hemisphereSample.x)
                        .sub(rotationSin.mul(hemisphereSample.y)), rotationSin
                        .mul(hemisphereSample.x)
                        .add(rotationCos.mul(hemisphereSample.y)), hemisphereSample.z).toVar();
                    const sampleDirection = tangent
                        .mul(rotatedSample.x)
                        .add(bitangent.mul(rotatedSample.y))
                        .add(normal.mul(rotatedSample.z))
                        .toVar();
                    const moveAmount = offsetMove.fract().toVar();
                    offsetMove.addAssign(offsetMoveInv);
                    const samplePosition = viewPosition
                        .add(sampleDirection.mul(radiusToUse.mul(moveAmount)))
                        .toVar();
                    const sampleClipPosition = projectionMatrix
                        .mul(vec4(samplePosition, 1))
                        .toVar();
                    const sampleUv = getScreenPosition(samplePosition, projectionMatrix).toVar();
                    const sampleScreenDepth = sampleClipPosition.z
                        .div(sampleClipPosition.w)
                        .toVar();
                    const isInside = sampleUv.x
                        .greaterThan(0)
                        .and(sampleUv.x.lessThan(1))
                        .and(sampleUv.y.greaterThan(0))
                        .and(sampleUv.y.lessThan(1))
                        .and(sampleScreenDepth.greaterThan(0))
                        .and(sampleScreenDepth.lessThan(1));
                    If(isInside, () => {
                        const sampleDepth = aoDepthNode.sample(sampleUv).x.toVar();
                        const distSample = orthoNode
                            .select(cameraNear.add(sampleDepth.mul(farMinusNear)), farTimesNear.div(cameraFar.sub(sampleDepth.mul(farMinusNear))))
                            .toVar();
                        const distWorld = orthoNode
                            .select(cameraNear.add(sampleScreenDepth.mul(farMinusNear)), farTimesNear.div(cameraFar.sub(sampleScreenDepth.mul(farMinusNear))))
                            .toVar();
                        const rangeCheck = smoothstep(0, 1, distanceFalloffToUse.div(abs(distSample.sub(distWorld)))).toVar();
                        const diff = uvNode
                            .mul(resolution)
                            .sub(floor(sampleUv.mul(resolution)))
                            .toVar();
                        occluded.addAssign(rangeCheck
                            .mul(sampleDepth.notEqual(depth))
                            .mul(step(distSample.add(computedBias), distWorld))
                            .mul(step(1, dot(diff, diff))));
                        totalWeight.addAssign(1);
                    });
                });
                const occlusion = clamp(vec3(1).x.sub(occluded.div(totalWeight.equal(0).select(1, totalWeight))), 0, 1).toVar();
                encodedNormal.assign(normal.mul(0.5).add(0.5));
                result.assign(vec4(occlusion, encodedNormal));
            });
            return result;
        })();
    }
    createBlurNode() {
        const resolution = this.resolutionNode;
        const projectionMatrixInverse = this.projectionMatrixInverseNode;
        const aoDepthNode = this.getAoDepthNode();
        const aoSourceTextureNode = this.aoSourceTextureNode;
        const blueNoiseNode = this.blueNoiseNode;
        const blurIndexNode = this.blurIndexNode;
        const screenSpaceRadiusNode = this.screenSpaceRadiusNode;
        const blurWorldRadiusNode = this.blurWorldRadiusNode;
        const distanceFalloffNode = this.distanceFalloffNode;
        const blurRadiusNode = this.blurRadiusNode;
        const blurSampleArrayNode = this.blurSampleArrayNode;
        const denoiseSamples = this.configuration.denoiseSamples;
        return Fn(() => {
            const uvNode = uv();
            const depth = aoDepthNode.sample(uvNode).x.toVar();
            const data = aoSourceTextureNode.sample(uvNode).toVar();
            const result = property("vec4");
            If(depth.equal(1), () => {
                result.assign(data);
            }).Else(() => {
                const occlusion = data.r.toVar();
                const normal = data.gba.mul(2).sub(1).toVar();
                const viewPosition = getViewPosition(uvNode, depth, projectionMatrixInverse).toVar();
                const texelSize = vec2(1).div(resolution).toVar();
                const blueNoiseUv = vec2(uvNode.x, uvNode.y.oneMinus())
                    .mul(resolution)
                    .div(128)
                    .toVar();
                const noise = blueNoiseNode.sample(blueNoiseUv).toVar();
                const angle = blurIndexNode
                    .equal(0)
                    .select(noise.w.mul(Math.PI * 2), blurIndexNode
                    .equal(1)
                    .select(noise.z.mul(Math.PI * 2), blurIndexNode
                    .equal(2)
                    .select(noise.y.mul(Math.PI * 2), noise.x.mul(Math.PI * 2))))
                    .toVar();
                const rotationSin = angle.sin().toVar();
                const rotationCos = angle.cos().toVar();
                const radiusToUse = screenSpaceRadiusNode
                    .select(distance(viewPosition, getViewPosition(uvNode.add(vec2(blurWorldRadiusNode, 0).div(resolution)), depth, projectionMatrixInverse)), blurWorldRadiusNode)
                    .toVar();
                const distanceFalloffToUse = screenSpaceRadiusNode
                    .select(radiusToUse.mul(distanceFalloffNode), radiusToUse.mul(distanceFalloffNode).mul(0.2))
                    .toVar();
                const invDistance = vec3(1).x.div(distanceFalloffToUse).toVar();
                const totalWeight = float(1).toVar();
                Loop({
                    condition: "<",
                    end: int(denoiseSamples),
                    start: int(0),
                    type: "int",
                }, ({ i }) => {
                    const diskSample = blurSampleArrayNode.element(i).toVar();
                    const rotatedSample = vec2(rotationCos.mul(diskSample.x).sub(rotationSin.mul(diskSample.y)), rotationSin.mul(diskSample.x).add(rotationCos.mul(diskSample.y))).toVar();
                    const offset = rotatedSample
                        .mul(texelSize)
                        .mul(blurRadiusNode)
                        .toVar();
                    const sampleUv = uvNode.add(offset).toVar();
                    const sampleData = aoSourceTextureNode.sample(sampleUv).toVar();
                    const sampleOcclusion = sampleData.r.toVar();
                    const sampleNormal = sampleData.gba.mul(2).sub(1).toVar();
                    const sampleDepth = aoDepthNode.sample(sampleUv).x.toVar();
                    const sampleViewPosition = getViewPosition(sampleUv, sampleDepth, projectionMatrixInverse).toVar();
                    const tangentPlaneDistance = abs(dot(sampleViewPosition.sub(viewPosition), normal)).toVar();
                    const rangeCheck = sampleDepth
                        .notEqual(1)
                        .select(exp(tangentPlaneDistance.negate().mul(invDistance)).mul(max(dot(normal, sampleNormal), 0)), 0)
                        .toVar();
                    occlusion.addAssign(sampleOcclusion.mul(rangeCheck));
                    totalWeight.addAssign(rangeCheck);
                });
                const denoisedOcclusion = occlusion
                    .div(totalWeight.greaterThan(0).select(totalWeight, 1))
                    .toVar();
                const fixedOcclusion = denoisedOcclusion
                    .equal(0)
                    .select(1, clamp(denoisedOcclusion, 0, 1))
                    .toVar();
                result.assign(vec4(fixedOcclusion, normal.mul(0.5).add(0.5)));
            });
            return result;
        })();
    }
    createCompositeNode() {
        const projectionMatrixInverse = this.projectionMatrixInverseNode;
        const resolution = this.fullResolutionNode;
        const beautyNode = this.beautyNode;
        const depthNode = this.depthNode;
        const depthTexture = this.depthTexture;
        const halfResNode = this.halfResNode;
        const screenSpaceRadiusNode = this.screenSpaceRadiusNode;
        const radiusNode = this.radiusNode;
        const distanceFalloffNode = this.distanceFalloffNode;
        const compositeAoTextureNode = this.compositeAoTextureNode;
        const downsampledDepthTextureNode = this.downsampledDepthTextureNode;
        const transparencyAwareNode = this.transparencyAwareNode;
        const transparencyDepthWriteFalseTextureNode = this.transparencyDepthWriteFalseTextureNode;
        const transparencyDepthWriteTrueTextureNode = this.transparencyDepthWriteTrueTextureNode;
        const transparencyDepthWriteTrueDepthTextureNode = this.transparencyDepthWriteTrueDepthTextureNode;
        const intensityNode = this.intensityNode;
        const aoTonesNode = this.aoTonesNode;
        const fogEnabledNode = this.fogEnabledNode;
        const fogExpNode = this.fogExpNode;
        const fogDensityNode = this.fogDensityNode;
        const fogNearNode = this.fogNearNode;
        const fogFarNode = this.fogFarNode;
        const colorNode = this.colorNode;
        const colorMultiplyNode = this.colorMultiplyNode;
        const renderModeNode = this.renderModeNode;
        const gammaCorrectionNode = this.gammaCorrectionNode;
        return Fn(() => {
            const uvNode = uv();
            const sceneTexel = beautyNode.sample(uvNode).toVar();
            const depth = depthNode.sample(uvNode).r.toVar();
            const aoSample = property("vec4");
            const fogFactor = float(0).toVar();
            const result = property("vec4");
            If(halfResNode, () => {
                If(depth.equal(1), () => {
                    // Background pixels should remain fully unoccluded in half-res mode.
                    aoSample.assign(vec4(1, 1, 1, 1));
                }).Else(() => {
                    const viewPosition = getViewPosition(uvNode, depth, projectionMatrixInverse).toVar();
                    const normal = getNormalFromDepthWithResolution(uvNode, depthTexture, projectionMatrixInverse, resolution).toVar();
                    const totalWeight = float(0).toVar();
                    const weightedAo = vec4(0, 0, 0, 0).toVar();
                    const radiusToUse = screenSpaceRadiusNode
                        .select(distance(viewPosition, getViewPosition(uvNode.add(vec2(radiusNode, 0).div(resolution)), depth, projectionMatrixInverse)), radiusNode)
                        .toVar();
                    const distanceFalloffToUse = screenSpaceRadiusNode
                        .select(radiusToUse.mul(distanceFalloffNode), distanceFalloffNode)
                        .toVar();
                    Loop({
                        condition: "<=",
                        end: int(1),
                        start: int(-1),
                        type: "int",
                    }, ({ i }) => {
                        Loop({
                            condition: "<=",
                            end: int(1),
                            start: int(-1),
                            type: "int",
                        }, ({ i: j }) => {
                            const sampleUv = uvNode
                                .mul(resolution.mul(0.5))
                                .add(vec2(i, j))
                                .div(resolution.mul(0.5))
                                .toVar();
                            const sampleDepth = downsampledDepthTextureNode
                                .sample(sampleUv)
                                .x.toVar();
                            const sampleInfo = compositeAoTextureNode
                                .sample(sampleUv)
                                .toVar();
                            const sampleNormal = sampleInfo.gba.mul(2).sub(1).toVar();
                            const sampleViewPosition = getViewPosition(sampleUv, sampleDepth, projectionMatrixInverse).toVar();
                            const tangentPlaneDistance = abs(dot(sampleViewPosition.sub(viewPosition), normal)).toVar();
                            const weight = exp(tangentPlaneDistance
                                .negate()
                                .mul(vec3(1).x.div(distanceFalloffToUse)))
                                .mul(max(dot(normal, sampleNormal), 0))
                                .toVar();
                            totalWeight.addAssign(weight);
                            weightedAo.addAssign(sampleInfo.mul(weight));
                        });
                    });
                    If(totalWeight.equal(0), () => {
                        aoSample.assign(compositeAoTextureNode.sample(uvNode));
                    }).Else(() => {
                        aoSample.assign(weightedAo.div(totalWeight));
                    });
                });
            }).Else(() => {
                aoSample.assign(compositeAoTextureNode.sample(uvNode));
            });
            const finalAo = pow(aoSample.r, intensityNode).toVar();
            If(aoTonesNode.greaterThan(0), () => {
                finalAo.assign(finalAo.mul(aoTonesNode).ceil().div(aoTonesNode));
            });
            If(fogEnabledNode, () => {
                const fogDepth = distance(vec3(0, 0, 0), getViewPosition(uvNode, depth, projectionMatrixInverse)).toVar();
                If(fogExpNode, () => {
                    fogFactor.assign(vec3(1).x.sub(exp(fogDensityNode
                        .mul(fogDensityNode)
                        .mul(fogDepth)
                        .mul(fogDepth)
                        .negate())));
                }).Else(() => {
                    fogFactor.assign(smoothstep(fogNearNode, fogFarNode, fogDepth));
                });
            });
            If(transparencyAwareNode, () => {
                const transparencyDepthWriteOff = transparencyDepthWriteFalseTextureNode
                    .sample(uvNode)
                    .a.toVar();
                const transparencyDepthWriteOn = transparencyDepthWriteTrueTextureNode
                    .sample(uvNode)
                    .a.toVar();
                const trueDepthSample = transparencyDepthWriteTrueDepthTextureNode
                    .sample(uvNode)
                    .r.toVar();
                const adjustmentFactor = max(transparencyDepthWriteOff, vec3(1)
                    .x.sub(transparencyDepthWriteOn)
                    .mul(trueDepthSample.equal(depth).select(1, 0))).toVar();
                finalAo.assign(mix(finalAo, 1, adjustmentFactor));
            });
            finalAo.assign(mix(finalAo, 1, fogFactor));
            const aoApplied = colorNode
                .mul(colorMultiplyNode.select(sceneTexel.rgb, vec3(1, 1, 1)))
                .toVar();
            If(renderModeNode.equal(0), () => {
                result.assign(vec4(mix(sceneTexel.rgb, aoApplied, vec3(1).x.sub(finalAo)), sceneTexel.a));
            })
                .ElseIf(renderModeNode.equal(1), () => {
                result.assign(vec4(mix(vec3(1, 1, 1), aoApplied, vec3(1).x.sub(finalAo)), sceneTexel.a));
            })
                .ElseIf(renderModeNode.equal(2), () => {
                result.assign(vec4(sceneTexel.rgb, sceneTexel.a));
            })
                .ElseIf(renderModeNode.equal(3), () => {
                If(uvNode.x.lessThan(0.5), () => {
                    result.assign(vec4(sceneTexel.rgb, sceneTexel.a));
                })
                    .ElseIf(uvNode.x.sub(0.5).abs().lessThan(vec3(1).x.div(resolution.x)), () => {
                    result.assign(vec4(1, 1, 1, 1));
                })
                    .Else(() => {
                    result.assign(vec4(mix(sceneTexel.rgb, aoApplied, vec3(1).x.sub(finalAo)), sceneTexel.a));
                });
            })
                .Else(() => {
                If(uvNode.x.lessThan(0.5), () => {
                    result.assign(vec4(sceneTexel.rgb, sceneTexel.a));
                })
                    .ElseIf(uvNode.x.sub(0.5).abs().lessThan(vec3(1).x.div(resolution.x)), () => {
                    result.assign(vec4(1, 1, 1, 1));
                })
                    .Else(() => {
                    result.assign(vec4(mix(vec3(1, 1, 1), aoApplied, vec3(1).x.sub(finalAo)), sceneTexel.a));
                });
            });
            If(gammaCorrectionNode, () => {
                result.assign(vec4(sRGBTransferOETF(result.rgb), result.a));
            });
            return result;
        })();
    }
    getAoDepthNode() {
        return this.configuration.halfRes && this.downsampledDepthTextureNode
            ? this.downsampledDepthTextureNode
            : this.depthNode;
    }
    getAoDepthTexture() {
        return this.configuration.halfRes && this.depthDownsampleTarget
            ? this.depthDownsampleTarget.textures[0]
            : this.depthTexture;
    }
    renderTransparency(renderer) {
        if (!this.transparencyTargetDepthWriteFalse ||
            !this.transparencyTargetDepthWriteTrue) {
            return;
        }
        const previousClearColor = renderer.getClearColor(new Color());
        const previousClearAlpha = renderer.getClearAlpha();
        const previousAutoClear = renderer.autoClear;
        const previousBackground = this.scene
            .background;
        const visibility = new Map();
        this.scene.traverse((object) => {
            visibility.set(object, object.visible);
        });
        this.scene.background = null;
        renderer.autoClear = false;
        renderer.setClearColor(new Color(0, 0, 0), 0);
        renderer.setRenderTarget(this.transparencyTargetDepthWriteFalse);
        renderer.clear?.(true, true, true);
        this.quadMesh.material = this.depthCopyMaterial;
        this.quadMesh.name = "N8AO.DepthCopy.False";
        this.quadMesh.render(renderer);
        this.scene.traverse((object) => {
            const material = object.material;
            const cannotReceiveAO = object.userData
                ?.cannotReceiveAO === true;
            const treatAsOpaque = object.userData
                ?.treatAsOpaque === true;
            object.visible =
                (visibility.get(object) ?? object.visible) &&
                    ((hasTransparentMaterialWithoutDepthWrite(material) &&
                        !treatAsOpaque) ||
                        cannotReceiveAO);
        });
        renderer.render(this.scene, this.camera);
        renderer.setRenderTarget(this.transparencyTargetDepthWriteTrue);
        renderer.clear?.(true, true, true);
        this.quadMesh.material = this.depthCopyMaterial;
        this.quadMesh.name = "N8AO.DepthCopy.True";
        this.quadMesh.render(renderer);
        this.scene.traverse((object) => {
            const material = object.material;
            const treatAsOpaque = object.userData
                ?.treatAsOpaque === true;
            object.visible =
                (visibility.get(object) ?? object.visible) &&
                    hasTransparentMaterialWithDepthWrite(material) &&
                    !treatAsOpaque;
        });
        renderer.render(this.scene, this.camera);
        this.scene.traverse((object) => {
            object.visible = visibility.get(object) ?? object.visible;
        });
        this.scene.background = previousBackground;
        renderer.autoClear = previousAutoClear;
        renderer.setClearColor(previousClearColor, previousClearAlpha);
    }
    syncConfigurationUniforms() {
        this.resolutionNode.value.set(Math.max(1, Math.floor(this.width * (this.configuration.halfRes ? 0.5 : 1))), Math.max(1, Math.floor(this.height * (this.configuration.halfRes ? 0.5 : 1))));
        this.fullResolutionNode.value.set(this.width, this.height);
        this.cameraNearNode.value = this.camera.near;
        this.cameraFarNode.value = this.camera.far;
        this.projectionMatrixNode.value = this.camera.projectionMatrix;
        this.projectionMatrixInverseNode.value =
            this.camera.projectionMatrixInverse;
        this.cameraWorldPositionNode.value.copy(this.camera.getWorldPosition(this.cameraWorldPosition));
        this.biasAdjustmentNode.value.set(this.configuration.biasOffset, this.configuration.biasMultiplier);
        this.radiusNode.value =
            this.configuration.halfRes && this.configuration.screenSpaceRadius
                ? this.configuration.aoRadius * 0.5
                : this.configuration.aoRadius;
        this.distanceFalloffNode.value = this.configuration.distanceFalloff;
        this.frameNode.value = this.frame;
        this.screenSpaceRadiusNode.value = this.configuration.screenSpaceRadius;
        this.blurRadiusNode.value =
            this.configuration.denoiseRadius * (this.configuration.halfRes ? 0.5 : 1);
        this.blurWorldRadiusNode.value = this.radiusNode.value;
        this.intensityNode.value = this.configuration.intensity;
        this.renderModeNode.value = this.configuration.renderMode;
        this.aoTonesNode.value = this.configuration.aoTones;
        this.orthoNode.value = this.camera.isOrthographicCamera === true;
        this.gammaCorrectionNode.value = this.configuration.gammaCorrection;
        this.colorMultiplyNode.value = this.configuration.colorMultiply;
        this.transparencyAwareNode.value = this.configuration.transparencyAware;
        this.halfResNode.value =
            this.configuration.halfRes && this.configuration.depthAwareUpsampling;
        this.linearColor.copy(this.configuration.color).convertSRGBToLinear();
        this.sharedColor.set(this.linearColor.r, this.linearColor.g, this.linearColor.b);
        this.colorNode.value.copy(this.sharedColor);
        this.depthCopySourceTextureNode.value = this.depthTexture;
        this.compositeAoTextureNode.value = this.accumulationTargetA.texture;
        const fog = this.scene.fog;
        this.fogEnabledNode.value = fog != null;
        this.fogExpNode.value = false;
        this.fogDensityNode.value = 0;
        this.fogNearNode.value = 0;
        this.fogFarNode.value = 0;
        if (fog?.isFog) {
            this.fogNearNode.value = fog.near ?? 0;
            this.fogFarNode.value = fog.far ?? 0;
        }
        else if (fog?.isFogExp2) {
            this.fogExpNode.value = true;
            this.fogDensityNode.value = fog.density ?? 0;
        }
        this.aoSourceTextureNode.value = this.aoTargetA.texture;
        this.accumulationCurrentTextureNode.value = this.aoTargetA.texture;
        this.accumulationPreviousTextureNode.value =
            this.accumulationTargetA.texture;
    }
}
//# sourceMappingURL=N8AONode.js.map