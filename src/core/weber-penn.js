// Weber & Penn parametric tree skeleton generator (pragmatic subset).
//
// Produces a flat list of "stems" (trunk + branches at every level). Each stem is
// a spine polyline with a per-point radius; the mesh builder turns each into a
// tapered generalized cylinder. Foliage attaches at terminal-stem tips.
//
// Faithful to the paper where it matters for silhouette: per-level curve, taper,
// phyllotactic child placement, down-angle, Shape-based length distribution, the
// pipe-model radius law, base flare, and vertical tropism (AttractionUp). Segment
// splitting (nSegSplits) is approximated by BaseSplits multi-leader trunks for now.
//
// Import three math from 'three/webgpu' to avoid mixing with the bare 'three'
// entry (which the WebGPU docs warn against).

import { Vector3, Quaternion } from 'three/webgpu';

const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

function qAround(axis, deg) {
  return new Quaternion().setFromAxisAngle(axis, (deg * Math.PI) / 180);
}

// Weber-Penn ShapeRatio: distributes child-branch length along the trunk.
function shapeRatio(shape, ratio) {
  switch (shape) {
    case 0: return 0.2 + 0.8 * ratio;                   // conical
    case 1: return 0.2 + 0.8 * Math.sin(Math.PI * ratio); // spherical
    case 2: return 0.2 + 0.8 * Math.sin(0.5 * Math.PI * ratio); // hemispherical
    case 3: return 1.0;                                  // cylindrical
    case 4: return 0.5 + 0.5 * ratio;                   // tapered cylindrical
    case 5: return ratio <= 0.7 ? ratio / 0.7 : (1 - ratio) / 0.3; // flame
    case 6: return 1.0 - 0.8 * ratio;                   // inverse conical
    case 7: return ratio <= 0.7 ? 0.5 + 0.5 * ratio / 0.7 : 0.5 + 0.5 * (1 - ratio) / 0.3; // tend flame
    default: return 1.0;
  }
}

// unit_taper from nTaper (0 cylinder, 1 cone, 2 spherical-tip; fractional interp).
function unitTaper(nTaper) {
  if (nTaper < 1) return nTaper;
  if (nTaper < 2) return 2 - nTaper;
  return 0;
}

const DEFAULTS = {
  seed: 'tree',
  scale: 12, scaleV: 2,        // trunk length (m)
  levels: 3,
  ratio: 0.03,                 // trunk radius / trunk length
  ratioPower: 1.2,             // pipe-model child-radius falloff
  baseSize: 0.25,              // fraction of trunk that is bare before branching
  shape: 2,                    // hemispherical crown
  flare: 0.6,                  // trunk-base swell
  lobes: 0, lobeDepth: 0,      // ribbed cross-section (cacti)
  attractionUp: 0.5,           // vertical tropism strength
  attractionUpMinLevel: 2,     // lowest level tropism applies to (1 = forks curl up)
  // ez-tree-style arbitrary growth force: bends every section toward `forceDir`
  // (world vector) with a per-section step of forceStrength/radius, so heavy limbs
  // resist and thin twigs comply. `attractionUp` stays the dedicated vertical case;
  // this is the general tropism (default strength 0 = no-op, existing trees unchanged).
  forceDir: { x: 0, y: 1, z: 0 },
  forceStrength: 0,
  forceMinLevel: 0,             // leave trunk/scaffolds rigid while guiding fine twigs
  forceLevelScale: null,        // optional per-level multiplier (heavy limbs sag less than fine shoots)
  baseSplits: 0,               // extra trunks from the base (decurrent multi-leader)
  baseSplitAngle: 20,
  // Optional true low fork: one shared bole reaches trunkForkHeight, then
  // divides into joined level-0 leaders. Unlike baseSplits this never clones a
  // complete crown at the soil and the leaders divide the L1 branch quota.
  trunkForkHeight: null,       // fraction of nominal trunk length; null disables
  trunkForkCount: 2,
  trunkForkAngle: 24,          // leader divergence half-angle (degrees)
  trunkForkAngleV: 6,
  trunkForkRadiusKeep: 0.72,   // near da Vinci R/sqrt(2)
  trunkForkBaseTaper: 0.18,    // preserve a substantial radius at the crotch
  trunkForkFlareScale: 1,
  decurrentTrunk: false,       // end leaders just beyond their last scaffold
  decurrentTrunkExtension: 0.018,
  forkChance: 0.82,            // dichotomous-fork frequency (tipCluster species)
  // Per child-level arrays (index = the level being created; [0] = trunk).
  length:    [1.0, 0.45, 0.4, 0.35],
  lengthV:   [0.0, 0.1, 0.1, 0.1],
  taper:     [1.0, 1.0, 1.0, 1.0],
  curveRes:  [10, 6, 4, 3],
  curve:     [10, 40, 40, 0],
  curveBack: [0, 0, 0, 0],
  curveV:    [40, 60, 60, 60],
  zigzagAngle:  [0, 0, 0, 0], // alternating lateral heading per section
  zigzagAngleV: [0, 0, 0, 0],
  downAngle: [0, 60, 50, 45],
  downAngleV:[0, 20, 20, 20],
  rotate:    [0, 140, 140, 140], // ~golden-angle phyllotaxy
  rotateV:   [0, 20, 20, 20],
  whorlSize:  [1, 1, 1, 1],     // >1 groups children at one node (opposite/whorled branching)
  twist:     [0, 0, 0, 0],       // axial roll (radians) accumulated per section, per level
  // Optional child-placement profiles. Defaults reproduce the original even
  // distribution (trunk starts at baseSize; all other parents start at 10%).
  // distPower < 1 concentrates shoots toward the parent's distal end.
  branchStart: null,
  branchEnd: null,
  branchDistPower: null,
  downAngleProgress: [0, 0, 0, 0], // degrees added from first to last child node
  lengthScaleBase: [1, 1, 1, 1],
  lengthScaleTip: [1, 1, 1, 1],
  branchJitter: null,
  branchSpacing: null,
  branchMin: null,
  branchMax: null,
  lengthAbsolute: null,
  lengthAbsoluteV: null,
  lengthMin: null,
  lengthMax: null,
  terminalFloor: null,
  terminalFloorV: 0,
  terminalFloorWave: 0,
  terminalFloorLobes: 3,
  terminalFloorMin: null,
  terminalFloorMax: null,


  branches:  [0, 30, 12, 0],    // children spawned by a stem at [level]
  // 0 = children distributed along the parent (broadleaf); 1 = children spawn
  // in the parent's last ~10% — dichotomous Y-forks (yucca, dragon tree).
  tipCluster: [0, 0, 0, 0],
  radialSegments: [10, 8, 6, 5],
};

export function defaultParams() {
  return structuredClone(DEFAULTS);
}

/**
 * @param {object} userParams  overrides merged onto DEFAULTS
 * @param {import('./rng.js').Rng} rng  threaded RNG (parent-before-children order)
 * @returns {{ stems: Array, tips: Array, params: object }}
 */
export function generateSkeleton(userParams, rng) {
  const p = { ...structuredClone(DEFAULTS), ...userParams };
  const stems = [];
  const tips = [];

  let trunkLen = p.scale + rng.vary(0, p.scaleV);
  // Dichotomous species: the trunk grows to the FIRST fork then splits, so its
  // length IS the height branching begins at. baseSize scales it (like the
  // oak's bare-trunk fraction) — lower = forks closer to the ground.
  if ((p.tipCluster?.[1] ?? 0) > 0.5) trunkLen *= 0.45 + 1.1 * (p.baseSize ?? 0.5);
  const trunkRadius = trunkLen * p.ratio;

  const forkHeight = Number.isFinite(p.trunkForkHeight)
    ? Math.max(0.05, Math.min(0.85, p.trunkForkHeight))
    : null;
  const forkCount = Math.max(2, Math.round(p.trunkForkCount ?? 2));
  const useSharedBole = forkHeight != null && (p.baseSplits | 0) === 0;

  if (useSharedBole) {
    // Build the shared lower trunk without its ordinary L1 children. Its end
    // stays open and thick; the leader bases overlap it into one real crotch.
    buildStem({
      level: 0,
      origin: new Vector3(0, 0, 0),
      orient: new Quaternion(),
      length: trunkLen * forkHeight,
      radius: trunkRadius,
      taperOverride: p.trunkForkBaseTaper ?? 0.18,
      curveResOverride: Math.max(2, Math.round((p.curveRes?.[0] ?? 10) * forkHeight)),
      curveScale: forkHeight,
      suppressChildren: true,
      openTip: true,
      role: 'sharedBole',
      p, rng, stems, tips,
    });
    const base = stems[0];
    const forkOrigin = base.points.at(-1).clone();
    const forkOrient = base.orients.at(-1).clone();
    const forkRadius = base.radii.at(-1);
    const forkWind = base.winds.at(-1);
    const forkPlaneAz = rng.range(0, 360);
    const totalPrimary = Math.max(0, Math.round(p.branches?.[1] ?? 0));
    const quotaBase = Math.floor(totalPrimary / forkCount);
    const quotaExtra = totalPrimary % forkCount;

    for (let t = 0; t < forkCount; t++) {
      const angle = Math.max(1, rng.vary(p.trunkForkAngle ?? 24, p.trunkForkAngleV ?? 6));
      const orient = forkOrient.clone()
        .multiply(qAround(Y, forkPlaneAz + (360 / forkCount) * t))
        .multiply(qAround(X, angle));
      // Preserve approximately the unforked vertical reach despite the initial
      // splay; cap compensation so a very wide edit cannot create giant arms.
      const compensation = Math.min(1.35, 1 / Math.max(0.72, Math.cos(angle * Math.PI / 180)));
      const leaderLength = trunkLen * (1 - forkHeight) * compensation;
      buildStem({
        level: 0,
        origin: forkOrigin,
        orient,
        length: leaderLength,
        radius: forkRadius * (p.trunkForkRadiusKeep ?? 0.72),
        curveResOverride: Math.max(2, Math.round(
          (p.curveRes?.[0] ?? 10) * (1 - forkHeight) * compensation,
        )),
        curveScale: 1 - forkHeight,
        skipBaseFlare: true,
        flareBase: forkRadius * (p.trunkForkFlareScale ?? 1),
        windBase: forkWind,
        childCountOverride: quotaBase + (t < quotaExtra ? 1 : 0),
        decurrentEligible: true,
        role: 'trunkLeader',
        parentId: base.id,
        p, rng, stems, tips,
      });
    }
  } else {
    const nTrunks = 1 + (p.baseSplits | 0);
    for (let t = 0; t < nTrunks; t++) {
      const orient = new Quaternion();
      if (nTrunks > 1) {
        // Splay multiple leaders out from the base.
        const az = (360 / nTrunks) * t + rng.vary(0, 20);
        orient.multiply(qAround(Y, az));
        orient.multiply(qAround(X, rng.vary(p.baseSplitAngle, 8)));
      }
      buildStem({
        level: 0,
        origin: new Vector3(0, 0, 0),
        orient,
        length: trunkLen,
        radius: trunkRadius,
        // A normal one-trunk tree may shorten its leader just above the last
        // scaffold. Base-split clones stay full-length so one clone cannot be
        // trimmed by a child layout that belongs only to that cloned crown.
        decurrentEligible: nTrunks === 1,
        p, rng, stems, tips,
      });
    }
  }

  return { stems, tips, params: p };
}

function buildStem({
  level, origin, orient, length, radius, p, rng, stems, tips, parentId,
  curveResOverride, curveScale = 1, taperOverride, suppressChildren = false,
  skipBaseFlare = false, flareBase, windBase = 0.05, childCountOverride,
  decurrentEligible = false, openTip = false, role = null,
}) {
  const curveRes = Math.max(2, curveResOverride ?? (p.curveRes[level] | 0));
  const segLen = length / curveRes;
  const taperValue = taperOverride ?? p.taper[level];
  const uTaper = unitTaper(taperValue);

  // Total curve for the stem, split across segments; curveBack makes an S.
  const curve = (p.curve[level] ?? 0) * curveScale;
  const curveBack = (p.curveBack[level] ?? 0) * curveScale;
  const curveV = (p.curveV[level] ?? 0) * curveScale;
  const zigzag = Math.max(0, p.zigzagAngle?.[level] ?? 0);
  const zigzagV = Math.max(0, p.zigzagAngleV?.[level] ?? 0);
  const zigzagPhase = zigzag > 0 && rng.next() < 0.5 ? -1 : 1;
  let zigzagHeading = 0;

  const points = [origin.clone()];
  const radii = [radius];
  const orients = [orient.clone()];

  const o = orient.clone();
  const pos = origin.clone();

  for (let i = 1; i <= curveRes; i++) {
    // Bend for this segment.
    let segCurve;
    if (curveBack === 0) segCurve = curve / curveRes;
    else segCurve = (i <= curveRes / 2 ? curve : curveBack) / (curveRes / 2);
    segCurve += rng.vary(0, curveV / curveRes);
    o.multiply(qAround(X, segCurve));
    if (zigzag > 0) {
      // Alternate an absolute lateral heading around the centreline. Applying
      // the delta from the preceding target makes the path truly left/right,
      // rather than merely adding equal rotations that drift in one direction.
      const amplitude = Math.max(0, rng.vary(zigzag, zigzagV));
      const targetHeading = zigzagPhase * (i % 2 ? amplitude : -amplitude);
      o.multiply(qAround(Z, targetHeading - zigzagHeading));
      zigzagHeading = targetHeading;
    }

    // Vertical tropism: pulls a stem back toward vertical along its length. For
    // dichotomous species (yucca) this is the "elbow" — arms diverge at the
    // fork, then curl upward, making a candelabra instead of a splayed tripod.
    if (level >= (p.attractionUpMinLevel ?? 2) && p.attractionUp !== 0) {
      applyTropism(o, p.attractionUp / curveRes);
    }

    // Axial twist (ez-tree parity): roll the frame about its own tangent each
    // section — spins child azimuths + bark UVs around the stem without bending it.
    const twist = p.twist?.[level] ?? 0;
    if (twist) o.multiply(new Quaternion().setFromAxisAngle(Y, twist));

    // General growth force: bend toward forceDir with a per-section step that
    // scales inversely with radius (heavy limbs resist), starting at forceMinLevel.
    const levelForce = p.forceStrength * (p.forceLevelScale?.[level] ?? 1);
    if (levelForce && level >= (p.forceMinLevel ?? 0)) applyForce(o, p.forceDir, levelForce * segLen, radius * (1 - uTaper * (i / curveRes)));

    const fwd = Y.clone().applyQuaternion(o).normalize();
    pos.addScaledVector(fwd, segLen);

    // Radius taper along the stem; the terminal level closes to a point so the
    // (uncapped) tube is sealed and the rosette sits on it. Arm CHUNKINESS is
    // governed by forkRadiusKeep (per-fork step-down), NOT by tapering each arm
    // — so arms stay nearly trunk-thick and only the final tip narrows.
    const z = i / curveRes;
    let r = radius * (1 - uTaper * z);
    // The terminal level tapers to a point by DEFAULT (taper 1 ⇒ uTaper 1 ⇒ the
    // same radius*(1-z)), but only force it when taper is left at default — so an
    // edited terminal taper (e.g. L2 taper 0) actually takes effect. Open ends
    // from a lowered taper are sealed by the tip cap in branch-mesh.js.
    if (level === p.levels - 1 && taperValue >= 0.99) r = radius * (1 - z);
    r = Math.max(r, 0.002);

    points.push(pos.clone());
    radii.push(r);
    orients.push(o.clone());
  }

  // Terminal guides may describe a curved hanging spray whose render card uses
  // the guide's arc length along its chord. Shorten the whole guide uniformly
  // when that card would cross the species' scalloped ground-clearance floor.
  let resolvedLength = length;
  if (level === p.levels - 1 && p.terminalFloor != null && points.length > 1) {
    let arcLength = 0;
    for (let i = 1; i < points.length; i++) {
      arcLength += points[i - 1].distanceTo(points[i]);
    }
    const chord = points[points.length - 1].clone().sub(origin);
    const chordLength = chord.length();
    const downward = chordLength > 1e-5 ? Math.max(0, -chord.y / chordLength) : 0;
    const azimuth = Math.atan2(origin.z, origin.x);
    const floor = Math.max(
      p.terminalFloorMin ?? -Infinity,
      Math.min(
        p.terminalFloorMax ?? Infinity,
        p.terminalFloor
          + (p.terminalFloorWave ?? 0) * Math.sin((p.terminalFloorLobes ?? 3) * azimuth)
          + rng.vary(0, p.terminalFloorV ?? 0),
      ),
    );
    const cardDrop = arcLength * downward;
    const allowedDrop = origin.y - floor;
    if (cardDrop > allowedDrop && cardDrop > 1e-5) {
      const scale = Math.max(0.02, Math.max(0, allowedDrop) / cardDrop);
      for (let i = 1; i < points.length; i++) points[i].sub(origin).multiplyScalar(scale).add(origin);
      arcLength *= scale;
    }
    resolvedLength = arcLength;
  }
  // Base flare on the trunk: swell the lowest points.
  if (level === 0 && !skipBaseFlare && p.flare > 0) {
    for (let i = 0; i < points.length; i++) {
      const z = i / (points.length - 1);
      if (z < 0.15) radii[i] *= 1 + p.flare * (1 - z / 0.15);
    }
  }

  // Fork flare (joined split geometry): a fork child's base swells to the
  // PARENT radius at the fork, so the diverging arms overlap the parent's end
  // and each other into one continuous-looking junction — the same overlapping
  // -base-flare trick the oak trunk uses for multi-leader bases. Closes the
  // "holes at junctions".
  if (flareBase) {
    for (let i = 0; i < points.length; i++) {
      const z = i / (points.length - 1);
      if (z < 0.35) radii[i] = flareBase * (1 - z / 0.35) + radii[i] * (z / 0.35);
    }
  }

  // Per-point wind weights, CONTINUOUS across forks: this stem starts at the
  // weight its parent had at the attachment point (windBase) and gains
  // flexibility toward its tip — so a child's base always sways exactly with
  // the parent ring it grows from (no joint separation in the wind shader).
  const flexGain = [0.3, 0.4, 0.5, 0.55][Math.min(level, 3)];
  const windTip = Math.min(1, windBase + flexGain);
  const winds = points.map((_, i) =>
    windBase + (windTip - windBase) * Math.pow(i / (points.length - 1), 1.15));

  const stem = {
    level,
    points,
    radii,
    orients,
    winds,
    length: resolvedLength,
    radialSegments: p.radialSegments[level] ?? 6,
    lobes: level === 0 ? p.lobes : 0,
    lobeDepth: p.lobeDepth,
    maxLevel: p.levels - 1,
    openTip,
    role,
  };
  // Branch topology (DFS insertion order): id = index in `stems`, parentId points
  // at the stem this one grew from (-1 for a trunk). Lets a consumer gather a
  // stem's whole SUBTREE (branch + its twigs + leaves) — used by the sub-branch
  // card baker to collapse a limb into one billboard on reduced/mobile LODs.
  stem.id = stems.length;
  stem.parentId = parentId ?? -1;
  stems.push(stem);

  // Record a foliage attachment tip for terminal stems.
  if (level === p.levels - 1) {
    tips.push({
      position: points[points.length - 1].clone(),
      orient: orients[orients.length - 1].clone(),
      length: resolvedLength,
    });
  }
  if (suppressChildren) return stem;

  // Spawn children (parent-before-children keeps RNG deterministic).
  const childLevel = level + 1;
  if (childLevel >= p.levels) return stem;
  const nChildren = Number.isFinite(childCountOverride)
    ? Math.max(0, Math.round(childCountOverride))
    : childCount(level, childLevel, p, rng, length);
  if (nChildren <= 0) return stem;

  // Children distributed over a configurable interval of the parent. A power
  // profile lets species such as willow retain an open structural interior by
  // concentrating fine shoots on the outer/distal portions of load-bearing limbs.
  const defaultStart = level === 0 ? p.baseSize : 0.1;
  const offsetStart = Math.max(0, Math.min(0.98, p.branchStart?.[childLevel] ?? defaultStart));
  const offsetEnd = Math.max(offsetStart + 0.01, Math.min(1, p.branchEnd?.[childLevel] ?? 1));
  const distPower = Math.max(0.05, p.branchDistPower?.[childLevel] ?? 1);
  let azimuth = rng.range(0, 360);
  const tipC = p.tipCluster?.[childLevel] ?? 0;
  const whorlSize = Math.max(1, p.whorlSize?.[childLevel] | 0);
  const whorlNodes = Math.ceil(nChildren / whorlSize);
  // Dichotomous forks (yucca): all children spring from ONE node and diverge
  // by EQUAL, opposing angles in a shared plane (L-system F→F[+F][-F]). The
  // plane's orientation is randomized per node so the tree isn't 2D.
  const forkPlaneAz = rng.range(0, 360);
  // Per-fork radius: da Vinci area preservation would give R/√n (~0.707 per
  // binary fork), but real Joshua arms stay nearly as thick as the trunk, so
  // forkRadiusKeep (default 0.85) softens the step-down. Set it to 0.707 for
  // strict area preservation.
  const forkRadius = radius * (p.forkRadiusKeep ?? 0.85);

  let jitterNode = -1, nodeJitter = 0;
  let maxChildFrac = -Infinity;
  for (let c = 0; c < nChildren; c++) {
    const whorlSlot = c % whorlSize;
    const nodeIndex = Math.floor(c / whorlSize);
    if (nodeIndex !== jitterNode) {
      jitterNode = nodeIndex;
      nodeJitter = rng.vary(0, p.branchJitter?.[childLevel] ?? 0);
    }
    const nodeT = ((whorlSize > 1 ? nodeIndex : c) + 0.5) / (whorlSize > 1 ? whorlNodes : nChildren);
    const spawnT = Math.pow(nodeT, distPower);
    let frac = Math.max(offsetStart, Math.min(offsetEnd, offsetStart + (offsetEnd - offsetStart) * spawnT + nodeJitter));
    // Tip clustering: children spawn AT the parent's tip (frac→1) so they
    // emanate from one point and cover the parent's open tube end — no bare
    // spike above the fork.
    if (tipC > 0) frac = frac * (1 - tipC) + 1.0 * tipC;
    maxChildFrac = Math.max(maxChildFrac, frac);
    const seg = frac * curveRes;
    const si = Math.min(curveRes - 1, Math.floor(seg));
    const st = seg - si;

    const cpos = points[si].clone().lerp(points[si + 1], st);
    const cor = orients[si].clone().slerp(orients[si + 1], st);
    const pradiusHere = radii[si] * (1 - st) + radii[si + 1] * st;

    const down = p.downAngle[childLevel]
      + (p.downAngleProgress?.[childLevel] ?? 0) * spawnT
      + rng.vary(0, p.downAngleV[childLevel]);
    const cOrient = cor.clone();
    if (tipC > 0.5) {
      // L-system F→F[+F][-F]: a junction that DIDN'T fork (nChildren===1)
      // continues nearly straight with a small wander — the single "F" run
      // between forks. A junction that forks sends its ≥2 children diverging
      // by EQUAL opposing angles in a shared, randomly-oriented plane (the
      // [+F][-F]), so the split is a clear V, never parallel.
      if (nChildren === 1) {
        cOrient.multiply(qAround(Y, rng.range(0, 360)));
        cOrient.multiply(qAround(X, rng.vary(0, 7)));
      } else {
        cOrient.multiply(qAround(Y, forkPlaneAz + (360 / nChildren) * c + rng.vary(0, 12)));
        cOrient.multiply(qAround(X, down));
      }
    } else if (whorlSize > 1) {
      // One shared node/azimuth per whorl; siblings divide the full circle evenly.
      // Successive nodes advance by rotate (90° gives dogwood's decussate pairs).
      if (whorlSlot === 0) azimuth += p.rotate[childLevel] + rng.vary(0, p.rotateV[childLevel]);
      const around = azimuth + (360 / whorlSize) * whorlSlot + rng.vary(0, p.rotateV[childLevel] * 0.15);
      cOrient.multiply(qAround(Y, around));
      cOrient.multiply(qAround(X, down));
    } else {
      azimuth += p.rotate[childLevel] + rng.vary(0, p.rotateV[childLevel]);
      cOrient.multiply(qAround(Y, azimuth));
      cOrient.multiply(qAround(X, down));
    }

    // Shape-driven child length; radius from da Vinci (forks) or pipe model.
    const shapeFrac = level === 0
      ? shapeRatio(p.shape, 1 - spawnT)
      : 1;
    const placementScale = (p.lengthScaleBase?.[childLevel] ?? 1) * (1 - spawnT)
      + (p.lengthScaleTip?.[childLevel] ?? 1) * spawnT;
    const absoluteLength = p.lengthAbsolute?.[childLevel];
    let rawLength;
    if (Number.isFinite(absoluteLength)) {
      rawLength = (absoluteLength + rng.vary(0, p.lengthAbsoluteV?.[childLevel] ?? 0)) * placementScale;
    } else {
      const lenFactor = p.length[childLevel] + rng.vary(0, p.lengthV[childLevel]);
      rawLength = length * lenFactor * shapeFrac * placementScale;
    }
    const childLen = Math.max(
      p.lengthMin?.[childLevel] ?? 0.05,
      Math.min(p.lengthMax?.[childLevel] ?? Infinity, rawLength),
    );
    let childRadius;
    if (tipC > 0.5) {
      // A single continuation keeps the parent radius (same arm); a real fork
      // steps down by forkRadiusKeep.
      childRadius = (nChildren === 1 ? radius * 0.97 : forkRadius) * (0.94 + 0.12 * rng.next());
    } else {
      const pipeRadius = radius * Math.pow(childLen / length, p.ratioPower);
      childRadius = Math.min(pipeRadius, pradiusHere * 0.9);
    }

    buildStem({
      level: childLevel,
      origin: cpos,
      orient: cOrient,
      length: childLen,
      radius: childRadius,
      windBase: winds[si] * (1 - st) + winds[si + 1] * st, // inherit sway at the fork
      // fork children flare their base to the parent radius here → joined split
      flareBase: tipC > 0.5 ? pradiusHere : undefined,
      p, rng, stems, tips,
      parentId: stem.id, // topology link — lets consumers gather whole subtrees
    });
  }

  if (decurrentEligible && p.decurrentTrunk && Number.isFinite(maxChildFrac)) {
    trimStemToFraction(stem, Math.min(
      1,
      maxChildFrac + Math.max(0, p.decurrentTrunkExtension ?? 0.018),
    ));
  }
  return stem;
}

// Shorten a generated leader after its children exist. Child origins are cloned,
// so this safely removes the bare apical spear while retaining a small wood stub
// beyond the highest scaffold and exact interpolated radius/orientation/wind.
function trimStemToFraction(stem, fraction) {
  const f = Math.max(0.02, Math.min(1, fraction));
  if (f >= 0.999999 || stem.points.length < 2) return;
  const last = stem.points.length - 1;
  const sample = f * last;
  const i = Math.min(last - 1, Math.floor(sample));
  const t = sample - i;
  const endPoint = stem.points[i].clone().lerp(stem.points[i + 1], t);
  const endRadius = stem.radii[i] * (1 - t) + stem.radii[i + 1] * t;
  const endOrient = stem.orients[i].clone().slerp(stem.orients[i + 1], t);
  const endWind = stem.winds[i] * (1 - t) + stem.winds[i + 1] * t;
  const keep = i + 1;
  stem.points.splice(keep, stem.points.length - keep, endPoint);
  stem.radii.splice(keep, stem.radii.length - keep, endRadius);
  stem.orients.splice(keep, stem.orients.length - keep, endOrient);
  stem.winds.splice(keep, stem.winds.length - keep, endWind);
  let arc = 0;
  for (let j = 1; j < stem.points.length; j++) {
    arc += stem.points[j].distanceTo(stem.points[j - 1]);
  }
  stem.length = arc;
}

// Number of children a stem spawns; deeper/shorter stems get fewer.
function childCount(level, childLevel, p, rng, parentLength) {
  const base = p.branches[childLevel] ?? 0;
  if (base <= 0) return 0;
  // Dichotomous forks: forkChance drives how often a node splits vs continues
  // as a single stem (no bloom that year). Higher = branchier / more arm tips.
  //   p(single)=1-fc,  p(triple)=0.2·fc,  p(double)=remainder
  if ((p.tipCluster?.[childLevel] ?? 0) > 0.5) {
    const fc = p.forkChance ?? 0.82;
    const r = rng.next();
    if (r < 1 - fc) return 1;
    if (r > 1 - 0.2 * fc) return 3;
    return 2;
  }
  if (level === 0) return Math.round(base);
  const spacing = p.branchSpacing?.[childLevel];
  if (spacing > 0) {
    const defaultStart = level === 0 ? p.baseSize : 0.1;
    const start = p.branchStart?.[childLevel] ?? defaultStart;
    const end = p.branchEnd?.[childLevel] ?? 1;
    const occupiedLength = parentLength * Math.max(0, end - start);
    const min = Math.max(1, p.branchMin?.[childLevel] ?? 1);
    const max = Math.max(min, p.branchMax?.[childLevel] ?? Infinity);
    const count = Math.max(1, Math.round(occupiedLength / spacing));
    return Math.max(min, Math.min(max, count));
  }
  return Math.max(1, Math.round(base * 0.6));
}

// Bend a section's growth toward an arbitrary world direction (ez-tree force).
// The rotation axis is (fwd × target), so when fwd already points at target the
// step is zero (no degenerate drift); the step is clamped to the remaining angle.
function applyForce(o, dir, strength, radius) {
  const target = new Vector3(dir.x, dir.y, dir.z);
  if (target.lengthSq() < 1e-9) return;
  target.normalize();
  const fwd = Y.clone().applyQuaternion(o);
  const axis = new Vector3().crossVectors(fwd, target);
  const sinFull = axis.length();
  if (sinFull < 1e-6) return;
  axis.divideScalar(sinFull);
  const fullAngle = Math.atan2(sinFull, fwd.dot(target));
  const step = strength / Math.max(radius, 0.05);
  const clamped = Math.max(-fullAngle, Math.min(fullAngle, step));
  o.premultiply(new Quaternion().setFromAxisAngle(axis, clamped));
}

// Rotate an orientation quaternion slightly toward world-up (or down if negative).
function applyTropism(o, amount) {
  const fwd = Y.clone().applyQuaternion(o);
  const target = amount >= 0 ? UP : UP.clone().negate();
  // Axis to rotate forward toward target.
  const axis = new Vector3().crossVectors(fwd, target);
  if (axis.lengthSq() < 1e-8) return;
  axis.normalize();
  const declination = Math.acos(Math.max(-1, Math.min(1, fwd.dot(target))));
  const angle = Math.abs(amount) * declination;
  o.premultiply(new Quaternion().setFromAxisAngle(axis, angle));
}
