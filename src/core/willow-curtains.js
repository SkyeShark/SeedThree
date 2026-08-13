// Willow-only hero foliage. Real level-2 feeder stems carry many lightweight
// pendant shoots; there is deliberately no one-hidden-stem-per-vine skeleton.
// Attachments are sampled metrically along each curved feeder, then each vine
// builds out in the interpolated feeder frame before easing into a near-vertical
// tail. The existing willow spray texture is mapped once across each crossed,
// segmented ribbon pair.

import {
  BufferAttribute, BufferGeometry, Mesh, Quaternion, Vector3,
} from 'three/webgpu';
import { WIND_DIR } from './wind.js';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const GOLDEN = (137.5 * Math.PI) / 180;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function feederArc(stem) {
  const cumulative = [0];
  for (let i = 1; i < stem.points.length; i++) {
    cumulative[i] = cumulative[i - 1] + stem.points[i].distanceTo(stem.points[i - 1]);
  }
  return { cumulative, length: cumulative[cumulative.length - 1] };
}

function sampleFeeder(stem, arc, frac) {
  const target = clamp(frac, 0, 1) * arc.length;
  let si = 0;
  while (si < arc.cumulative.length - 2 && arc.cumulative[si + 1] < target) si++;
  const span = Math.max(1e-6, arc.cumulative[si + 1] - arc.cumulative[si]);
  const t = clamp((target - arc.cumulative[si]) / span, 0, 1);
  const point = stem.points[si].clone().lerp(stem.points[si + 1], t);
  const tangent = stem.points[si + 1].clone().sub(stem.points[si]).normalize();
  const orient = stem.orients?.[si]
    ? stem.orients[si].clone().slerp(stem.orients[Math.min(si + 1, stem.orients.length - 1)], t)
    : new Quaternion().setFromUnitVectors(Y, tangent);
  const wind = stem.winds
    ? stem.winds[si] * (1 - t) + stem.winds[Math.min(si + 1, stem.winds.length - 1)] * t
    : 0.65;
  return { point, tangent, orient, wind };
}

// One continuous cubic curve from feeder tangent to pendant tail. P1 preserves
// the Weber-Penn feeder heading; a small quadratic horizontal sweep through
// P2/P3 keeps the whole textured run turning gently instead of spending its
// curvature at the shoulder and resolving into a vertical edge.
function unitVineCurve(
  startDir, lateralDir, segments, buildup, lateralAmount, tailPull, archLift,
  curveReach, terminalSweep,
) {
  const forward = new Vector3(startDir.x, 0, startDir.z);
  if (forward.lengthSq() < 1e-8) forward.crossVectors(UP, lateralDir);
  if (forward.lengthSq() < 1e-8) forward.set(1, 0, 0);
  forward.normalize();

  const endXZ = forward.multiplyScalar(curveReach).addScaledVector(lateralDir, lateralAmount);
  endXZ.y = 0;
  const p1 = startDir.clone().multiplyScalar(0.18 + buildup * 0.75);
  const p2 = endXZ.clone().addScaledVector(UP, archLift);
  const p3 = endXZ.clone().addScaledVector(DOWN, tailPull);
  // Adding sweep/3 and sweep to the late controls contributes exactly a
  // quadratic sweep * t^2: zero change to the root/launch tangent and a shallow
  // continuing bend all the way through the pendant hem.
  const sweepDir = endXZ.clone();
  if (sweepDir.lengthSq() < 1e-8) sweepDir.copy(lateralDir);
  sweepDir.normalize();
  p2.addScaledVector(sweepDir, terminalSweep / 3);
  p3.addScaledVector(sweepDir, terminalSweep);
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    points.push(new Vector3()
      .addScaledVector(p1, 3 * u * u * t)
      .addScaledVector(p2, 3 * u * t * t)
      .addScaledVector(p3, t * t * t));
  }

  // Normalize the polyline to one metre of arc length; requestedLength below is
  // therefore the actual textured-vine length regardless of curvature amount.
  let arcLength = 0;
  for (let i = 1; i < points.length; i++) arcLength += points[i].distanceTo(points[i - 1]);
  const invLength = 1 / Math.max(1e-6, arcLength);
  for (const point of points) point.multiplyScalar(invLength);
  return points;
}

/**
 * Build one merged curtain Mesh from real terminal feeder stems.
 *
 * Supported config aliases:
 * - vinesPerMeter or spacing/vineSpacing
 * - minPerFeeder, maxPerFeeder
 * - length/vineLength and lengthVariation/vineLengthVar
 * - curveBuildup, curveBuildupVariation
 * - lateralVariation, segments
 *
 * The supplied material should use foliageWindPosition(false). These are plain
 * tree-space vertices, so the instanced-leaf flutter term's local-Y amplitude is
 * not appropriate; per-ring sway still bends every vine progressively.
 */
export function buildWillowCurtains(feederStems, cfg, rng, material) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const thickness = [];
  const windVec = [];
  const anchorPos = [];
  const indices = [];

  const startFrac = clamp(cfg.startFrac ?? 0.12, 0, 0.98);
  const endFrac = clamp(cfg.endFrac ?? 0.98, startFrac + 0.01, 1);
  const vinesPerMeter = Math.max(0.01, cfg.vinesPerMeter ?? 9);
  const spacing = Math.max(0.01, cfg.spacing ?? cfg.vineSpacing ?? (1 / vinesPerMeter));
  const vineKeepFraction = clamp(cfg.vineKeepFraction ?? 1, 0, 1);
  const minPerFeeder = Math.max(0, Math.round(cfg.minPerFeeder ?? 6));
  const maxPerFeeder = Math.max(minPerFeeder, Math.round(cfg.maxPerFeeder ?? 36));
  const baseLength = Math.max(0.1, cfg.length ?? cfg.vineLength ?? 2.35);
  const lengthVariation = Math.max(0, cfg.lengthVariation ?? cfg.vineLengthVar ?? 0.65);
  const minLength = Math.max(0.03, cfg.minLength ?? 0.22);
  const curveBuildup = clamp(cfg.curveBuildup ?? 0.27, 0.02, 0.8);
  const curveBuildupVariation = Math.max(0, cfg.curveBuildupVariation ?? 0.08);
  const lateralVariation = Math.max(0, cfg.lateralVariation ?? 0.28);
  const outwardSpread = Math.max(0, cfg.outwardSpread ?? 0.55);
  const initialLift = cfg.initialLift ?? 0.08;
  const tangentInfluence = Math.max(0, cfg.tangentInfluence ?? 1);
  const minLaunchY = cfg.minLaunchY ?? -1;
  const archLift = Math.max(0, cfg.archLift ?? 0);
  const archLiftVariation = Math.max(0, cfg.archLiftVariation ?? 0);
  const curveReach = Math.max(0.05, cfg.curveReach ?? 0.75);
  const curveReachVariation = Math.max(0, cfg.curveReachVariation ?? 0);
  const terminalSweep = Math.max(0, cfg.terminalSweep ?? 0.20);
  const terminalSweepVariation = Math.max(0, cfg.terminalSweepVariation ?? 0);
  const tailPull = Math.max(0.2, cfg.tailPull ?? 1.25);
  const segments = Math.max(2, Math.round(cfg.segments ?? 8));
  const sheets = Math.max(1, Math.round(cfg.quads ?? 2));
  const widthRatio = Math.max(0.01, cfg.widthRatio ?? 1);
  const attachJitter = clamp(cfg.attachmentJitter ?? 0.35, 0, 0.49);
  const floorBase = cfg.floor ?? 0.28;
  const floorVariation = Math.max(0, cfg.floorVariation ?? cfg.floorVar ?? 0.10);
  const floorWave = Math.max(0, cfg.floorWave ?? 0.08);
  const floorLobes = Math.max(1, Math.round(cfg.floorLobes ?? 3));
  const floorMin = cfg.floorMin ?? 0.20;
  const floorMax = cfg.floorMax ?? 0.60;
  const floorEnabled = cfg.disableFloor !== true;
  const attachmentMinHeightRatio = clamp(cfg.attachmentMinHeightRatio ?? 0, 0, 0.9);
  const tailWindGain = clamp(cfg.tailWindGain ?? 1, 0, 1);

  const canopyTop = feederStems.reduce((top, feeder) => Math.max(
    top,
    ...((feeder.points ?? []).map((p) => p.y)),
  ), -Infinity);
  const attachmentMinHeight = !floorEnabled ? -Infinity
    : Number.isFinite(cfg.attachmentMinHeight) ? cfg.attachmentMinHeight
      : floorMin + Math.max(0, canopyTop - floorMin) * attachmentMinHeightRatio;

  const frameX = new Vector3();
  const frameZ = new Vector3();
  const outward = new Vector3();
  const lateralDir = new Vector3();
  const startDir = new Vector3();
  const center = new Vector3();
  const tangent = new Vector3();
  const side = new Vector3();
  const normal = new Vector3();
  let vineCount = 0;
  let usedFeeders = 0;

  for (const feeder of feederStems) {
    if (!feeder.points || feeder.points.length < 2) continue;
    const arc = feederArc(feeder);
    if (arc.length < 0.05) continue;
    const leafyLength = arc.length * (endFrac - startFrac);
    const count = clamp(Math.round(leafyLength / spacing), minPerFeeder, maxPerFeeder);
    if (!count) continue;
    usedFeeders++;
    let phase = rng.range(0, Math.PI * 2);

    for (let vi = 0; vi < count; vi++) {
      const slot = clamp((vi + 0.5 + rng.vary(0, attachJitter)) / count, 0.001, 0.999);
      const frac = startFrac + (endFrac - startFrac) * slot;
      const root = sampleFeeder(feeder, arc, frac);
      if (root.point.y < attachmentMinHeight) continue;

      phase += GOLDEN + rng.vary(0, 0.18);
      frameX.copy(X).applyQuaternion(root.orient);
      frameZ.copy(Z).applyQuaternion(root.orient);
      outward.copy(frameX).multiplyScalar(Math.cos(phase)).addScaledVector(frameZ, Math.sin(phase));
      // Keep the fan direction in the feeder's normal plane even when a sampled
      // frame spans a strongly curved segment.
      outward.addScaledVector(root.tangent, -outward.dot(root.tangent));
      if (outward.lengthSq() < 1e-8) outward.crossVectors(root.tangent, UP);
      outward.normalize();
      lateralDir.copy(frameX).multiplyScalar(-Math.sin(phase)).addScaledVector(frameZ, Math.cos(phase));
      lateralDir.addScaledVector(root.tangent, -lateralDir.dot(root.tangent)).normalize();

      startDir.copy(root.tangent).multiplyScalar(tangentInfluence)
        .addScaledVector(outward, outwardSpread * rng.range(0.65, 1.15))
        .addScaledVector(UP, initialLift + rng.vary(0, 0.06));
      // Feeder direction still steers the launch, but a drooping woody tip must
      // not make its flexible foliage shoot begin by diving straight downward.
      startDir.y = Math.max(startDir.y, minLaunchY + rng.vary(0, 0.04));
      startDir.normalize();
      const buildup = clamp(rng.vary(curveBuildup, curveBuildupVariation), 0.02, 0.82);
      const lateral = rng.vary(0, lateralVariation);
      const lift = Math.max(0.02, rng.vary(archLift, archLiftVariation));
      const reach = Math.max(0.05, rng.vary(curveReach, curveReachVariation));
      const sweep = Math.max(0.02, rng.vary(terminalSweep, terminalSweepVariation));
      const unit = unitVineCurve(
        startDir, lateralDir, segments, buildup, lateral, tailPull, lift, reach, sweep,
      );

      let requestedLength = Math.max(minLength, rng.vary(baseLength, lengthVariation));
      const minUnitY = Math.min(...unit.map((p) => p.y));
      const azimuth = Math.atan2(root.point.z, root.point.x);
      const targetFloor = clamp(
        floorBase + floorWave * Math.sin(floorLobes * azimuth) + rng.vary(0, floorVariation),
        floorMin,
        floorMax,
      );
      if (floorEnabled && minUnitY < -1e-5) {
        const allowedDrop = Math.max(0, root.point.y - targetFloor);
        requestedLength = Math.min(requestedLength, allowedDrop / -minUnitY);
      }
      if (requestedLength < minLength) continue;

      const path = unit.map((p) => p.clone().multiplyScalar(requestedLength).add(root.point));
      const cumulative = [0];
      for (let i = 1; i < path.length; i++) {
        cumulative[i] = cumulative[i - 1] + path[i].distanceTo(path[i - 1]);
      }
      const arcLength = cumulative[cumulative.length - 1];
      if (arcLength < minLength) continue;
      const halfWidth = 0.5 * arcLength * widthRatio;
      const roll = rng.range(0, Math.PI * 2);
      const vineThickness = 0.4 + rng.next() * 0.6;
      // Thin only after consuming the complete per-vine random stream. LOD1 can
      // therefore remove an even deterministic subset while every survivor
      // retains its exact LOD0 root, length, roll, and curve parameters.
      const keepScore = (
        usedFeeders * 0.618033988749895 + (vi + 1) * 0.754877666246693
      ) % 1;
      if (keepScore >= vineKeepFraction) continue;

      for (let sheet = 0; sheet < sheets; sheet++) {
        const angle = roll + (sheet * Math.PI) / sheets;
        // Horizontal width offsets guarantee the textured hem cannot extend
        // below the floor-safe centreline, even through the buildup bend.
        side.set(Math.cos(angle), 0, Math.sin(angle));
        const vertexBase = positions.length / 3;
        for (let i = 0; i < path.length; i++) {
          const prev = path[Math.max(0, i - 1)];
          const next = path[Math.min(path.length - 1, i + 1)];
          tangent.copy(next).sub(prev).normalize();
          normal.crossVectors(tangent, side).normalize();
          if (normal.lengthSq() < 1e-8) normal.crossVectors(UP, side).normalize();
          const t = clamp(cumulative[i] / arcLength, 0, 1);
          const wind = Math.min(1, root.wind + (1 - root.wind) * Math.pow(t, 1.15) * tailWindGain);
          center.copy(path[i]);
          for (const u of [0, 1]) {
            const sign = u ? 1 : -1;
            positions.push(center.x + side.x * halfWidth * sign, center.y, center.z + side.z * halfWidth * sign);
            normals.push(normal.x, normal.y, normal.z);
            uvs.push(u, 1 - t); // authored spray attaches at image top
            thickness.push(vineThickness);
            windVec.push(WIND_DIR.x * wind, WIND_DIR.y * wind, WIND_DIR.z * wind);
            anchorPos.push(center.x, center.y, center.z);
          }
        }
        for (let i = 0; i < segments; i++) {
          const a = vertexBase + i * 2;
          indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
        }
      }
      vineCount++;
    }
  }

  if (!vineCount) return null;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute('aThickness', new BufferAttribute(new Float32Array(thickness), 1));
  geo.setAttribute('aWindVec', new BufferAttribute(new Float32Array(windVec), 3));
  geo.setAttribute('aAnchorPos', new BufferAttribute(new Float32Array(anchorPos), 3));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const mesh = new Mesh(geo, material);
  mesh.name = 'willow-curtains';
  mesh.userData.vineCount = vineCount;
  mesh.userData.feederCount = usedFeeders;
  mesh.userData.trianglesPerVine = segments * sheets * 2;
  return mesh;
}
