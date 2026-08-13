import { Color, Vector2, Vector3 } from "three";
export const DepthType = {
    Default: 1,
    Log: 2,
    Reverse: 3,
};
export function createDefaultN8AOConfiguration() {
    return {
        aoSamples: 16,
        aoRadius: 5,
        aoTones: 0,
        denoiseSamples: 8,
        denoiseRadius: 12,
        distanceFalloff: 1,
        intensity: 5,
        denoiseIterations: 2,
        renderMode: 0,
        biasOffset: 0,
        biasMultiplier: 0,
        color: new Color(0, 0, 0),
        gammaCorrection: true,
        depthBufferType: DepthType.Default,
        screenSpaceRadius: false,
        halfRes: false,
        depthAwareUpsampling: true,
        autoRenderBeauty: true,
        colorMultiply: true,
        transparencyAware: false,
        stencil: false,
        accumulate: false,
    };
}
export function generateHemisphereSamples(sampleCount) {
    const samples = [];
    for (let index = 0; index < sampleCount; index += 1) {
        const theta = 2.399963 * index;
        const radius = Math.sqrt(index + 0.5) / Math.sqrt(sampleCount);
        const x = radius * Math.cos(theta);
        const y = radius * Math.sin(theta);
        const z = Math.sqrt(1 - (x * x + y * y));
        samples.push(new Vector3(x, y, z));
    }
    return samples;
}
export function generateDenoiseSamples(numSamples, numRings) {
    const angleStep = (2 * Math.PI * numRings) / numSamples;
    const invNumSamples = 1 / numSamples;
    const radiusStep = invNumSamples;
    const samples = [];
    let radius = invNumSamples;
    let angle = 0;
    for (let index = 0; index < numSamples; index += 1) {
        samples.push(new Vector2(Math.cos(angle), Math.sin(angle)).multiplyScalar(Math.pow(radius, 0.75)));
        radius += radiusStep;
        angle += angleStep;
    }
    return samples;
}
export function applyQualityMode(configuration, mode) {
    if (mode === "Performance") {
        configuration.aoSamples = 8;
        configuration.denoiseSamples = 4;
        configuration.denoiseRadius = 12;
        return;
    }
    if (mode === "Low") {
        configuration.aoSamples = 16;
        configuration.denoiseSamples = 4;
        configuration.denoiseRadius = 12;
        return;
    }
    if (mode === "Medium") {
        configuration.aoSamples = 16;
        configuration.denoiseSamples = 8;
        configuration.denoiseRadius = 12;
        return;
    }
    if (mode === "High") {
        configuration.aoSamples = 64;
        configuration.denoiseSamples = 8;
        configuration.denoiseRadius = 6;
        return;
    }
    configuration.aoSamples = 64;
    configuration.denoiseSamples = 16;
    configuration.denoiseRadius = 6;
}
export function resolveDisplayMode(mode) {
    return ["Combined", "AO", "No AO", "Split", "Split AO"].indexOf(mode);
}
//# sourceMappingURL=math.js.map