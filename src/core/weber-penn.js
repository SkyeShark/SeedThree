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
  baseSplits: 0,               // extra trunks from the base (decurrent multi-leader)
  baseSplitAngle: 20,
  forkChance: 0.82,            // dichotomous-fork frequency (tipCluster species)
  // Per child-level arrays (index = the level being created; [0] = trunk).
  length:    [1.0, 0.45, 0.4, 0.35],
  lengthV:   [0.0, 0.1, 0.1, 0.1],
  taper:     [1.0, 1.0, 1.0, 1.0],
  curveRes:  [10, 6, 4, 3],
  curve:     [10, 40, 40, 0],
  curveBack: [0, 0, 0, 0],
  curveV:    [40, 60, 60, 60],
  downAngle: [0, 60, 50, 45],
  downAngleV:[0, 20, 20, 20],
  rotate:    [0, 140, 140, 140], // ~golden-angle phyllotaxy
  rotateV:   [0, 20, 20, 20],
  twist:     [0, 0, 0, 0],       // axial roll (radians) accumulated per section, per level

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
      p, rng, stems, tips,
    });
  }

  return { stems, tips, params: p };
}

function buildStem({ level, origin, orient, length, radius, p, rng, stems, tips }) {
  const curveRes = Math.max(2, p.curveRes[level] | 0);
  const segLen = length / curveRes;
  const uTaper = unitTaper(p.taper[level]);

  // Total curve for the stem, split across segments; curveBack makes an S.
  const curve = p.curve[level];
  const curveBack = p.curveBack[level];
  const curveV = p.curveV[level];

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
    // scales inversely with radius (heavy limbs resist). Runs on every level.
    if (p.forceStrength) applyForce(o, p.forceDir, p.forceStrength, radius * (1 - uTaper * (i / curveRes)));

    const fwd = Y.clone().applyQuaternion(o).normalize();
    pos.addScaledVector(fwd, segLen);

    // Radius taper along the stem; the terminal level closes to a point so the
    // (uncapped) tube is sealed and the rosette sits on it. Arm CHUNKINESS is
    // governed by forkRadiusKeep (per-fork step-down), NOT by tapering each arm
    // — so arms stay nearly trunk-thick and only the final tip narrows.
    const z = i / curveRes;
    let r = radius * (1 - uTaper * z);
    if (level === p.levels - 1) r = radius * (1 - z); // final level tapers to point
    r = Math.max(r, 0.002);

    points.push(pos.clone());
    radii.push(r);
    orients.push(o.clone());
  }

  // Base flare on the trunk: swell the lowest points.
  if (level === 0 && p.flare > 0) {
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
  const flareBase = arguments[0].flareBase;
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
  const windBase = arguments[0].windBase ?? 0.05;
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
    length,
    radialSegments: p.radialSegments[level] ?? 6,
    lobes: level === 0 ? p.lobes : 0,
    lobeDepth: p.lobeDepth,
    maxLevel: p.levels - 1,
  };
  stems.push(stem);

  // Record a foliage attachment tip for terminal stems.
  if (level === p.levels - 1) {
    tips.push({
      position: points[points.length - 1].clone(),
      orient: orients[orients.length - 1].clone(),
      length,
    });
  }

  // Spawn children (parent-before-children keeps RNG deterministic).
  const childLevel = level + 1;
  if (childLevel >= p.levels) return;
  const nChildren = childCount(level, childLevel, p, rng);
  if (nChildren <= 0) return;

  // Children distributed from the bare base up to the tip.
  const offsetStart = level === 0 ? p.baseSize : 0.1;
  let azimuth = rng.range(0, 360);
  const tipC = p.tipCluster?.[childLevel] ?? 0;
  // Dichotomous forks (yucca): all children spring from ONE node and diverge
  // by EQUAL, opposing angles in a shared plane (L-system F→F[+F][-F]). The
  // plane's orientation is randomized per node so the tree isn't 2D.
  const forkPlaneAz = rng.range(0, 360);
  // Per-fork radius: da Vinci area preservation would give R/√n (~0.707 per
  // binary fork), but real Joshua arms stay nearly as thick as the trunk, so
  // forkRadiusKeep (default 0.85) softens the step-down. Set it to 0.707 for
  // strict area preservation.
  const forkRadius = radius * (p.forkRadiusKeep ?? 0.85);

  for (let c = 0; c < nChildren; c++) {
    let frac = offsetStart + (1 - offsetStart) * ((c + 0.5) / nChildren);
    // Tip clustering: children spawn AT the parent's tip (frac→1) so they
    // emanate from one point and cover the parent's open tube end — no bare
    // spike above the fork.
    if (tipC > 0) frac = frac * (1 - tipC) + 1.0 * tipC;
    const seg = frac * curveRes;
    const si = Math.min(curveRes - 1, Math.floor(seg));
    const st = seg - si;

    const cpos = points[si].clone().lerp(points[si + 1], st);
    const cor = orients[si].clone().slerp(orients[si + 1], st);
    const pradiusHere = radii[si] * (1 - st) + radii[si + 1] * st;

    const down = p.downAngle[childLevel] + rng.vary(0, p.downAngleV[childLevel]);
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
    } else {
      azimuth += p.rotate[childLevel] + rng.vary(0, p.rotateV[childLevel]);
      cOrient.multiply(qAround(Y, azimuth));
      cOrient.multiply(qAround(X, down));
    }

    // Shape-driven child length; radius from da Vinci (forks) or pipe model.
    const lenFactor = p.length[childLevel] + rng.vary(0, p.lengthV[childLevel]);
    const shapeFrac = level === 0
      ? shapeRatio(p.shape, 1 - (frac - offsetStart) / (1 - offsetStart))
      : 1;
    const childLen = Math.max(0.05, length * lenFactor * shapeFrac);
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
    });
  }
}

// Number of children a stem spawns; deeper/shorter stems get fewer.
function childCount(level, childLevel, p, rng) {
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
