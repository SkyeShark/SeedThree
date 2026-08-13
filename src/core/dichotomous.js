// Dichotomous / rosette plant generator (Joshua tree, yuccas; saguaro later).
// See docs/dichotomous-generator.md — that doc is the contract.
//
// Fundamentally NOT the Weber-Penn broadleaf path. Here:
//   - a stochastic L-system (F → F[+F][-F]) grows short segments that fork low
//     and diverge in a V (never parallel), and NOT every junction forks;
//   - the whole skeleton is meshed as ONE merged, weldable tube network — the
//     parent tube feeds BOTH children through each fork (no split pieces, no
//     holes), children flaring their base to the parent radius;
//   - segments bend programmatically (curved centerline), not by adding forks;
//   - arms stay nearly trunk-thick; tips are left for a rosette to hide.
//
// Output: { stems, terminalStems, geometry } — `stems` match the shape the
// rosette builder (yucca-leaves.js) consumes (points/orients/radii/winds).

import { Vector3, Quaternion, BufferGeometry, BufferAttribute } from 'three/webgpu';

const UP = new Vector3(0, 1, 0);
const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const smoothstep01 = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

const DEFAULTS = {
  firstForkHeight: 1.6,   // trunk length to the first fork (m) — low by default
  armLength: 0.9,         // segment length per generation (m)
  armFalloff: 0.86,       // each generation's segment a bit shorter
  forkGenerations: 6,     // L-system depth (fork levels after the trunk)
  branchiness: 0.62,      // P(a junction forks) — NOT every junction, even at max
  forkSpread: 32,         // divergence half-angle at a fork (deg) → V total ≈ 2×
  forkTriChance: 0.15,    // chance a fork is a trident instead of a Y
  armAsymmetric: false,   // saguaro: keep a straight MAIN AXIS + lateral arms that curl up (not a symmetric V)
  armMinHeightFrac: 0,    // saguaro: arms only sprout above this fraction of the expected column height (keeps them off the lower trunk)
  armMaxOrder: 99,        // saguaro: only branch orders BELOW this may sprout arms (1 = trunk arms only; arms never re-branch → 2–4 clean arms, not a bush)
  armGenerations: 0,      // saguaro: FRESH segment budget for an arm (0 = inherit the trunk's remaining depth). Independent of sprout height, so a high arm still grows the long candelabra J instead of a stub.
  curlUp: 0.35,           // tropism toward vertical per segment (keeps some spread)
  armBend: 16,            // programmatic elbow curve along each segment (deg)
  gnarliness: 12,         // random per-segment direction jitter (deg)
  continuationKink: 8,    // how hard a single-bud continuation "veers" at the dead node (deg) — real Joshua stalks kink 10-20°; saguaro keeps it low/straight

  forkRadiusKeep: 0.86,   // arms stay nearly as thick as the trunk per fork
  forkBaseScale: 1.0,     // arm BASE-ring radius as a fraction of the parent (｜1 = flare to full trunk width; <1 necks the arm in so its tilted base tucks INSIDE the trunk instead of poking out the sides at the crotch)
  trunkRadius: 0.16,      // base trunk radius (m)
  trunkFlare: 1.7,        // ground-contact base swell (Joshua trunks widen at the base)
  trunkPinch: 0,          // saguaro: slight INWARD pinch right at the ground (no flare)
  trunkSegRes: 9,         // extra rings on the trunk for an organic, undulating flare
  branchRepel: 0.7,       // strength arms steer AWAY from existing branches (anti-intersection)
  tipClearance: 0,        // rosette-ball radius: arms keep this much room so CROWNS don't collide (species sets it)
  minRadius: 0.02,
  radialSegs: 10,         // tube ring resolution
  ribCount: 0,            // >0: flute the tube cross-section into N accordion ribs
  ribDepth: 0,            // rib amplitude as a fraction of radius (saguaro ≈ 0.12)
  segCurveRes: 4,         // rings along one (bent) segment — mesh detail, not forks
  trunks: 1,              // multi-trunk is rare
  trunkSplayDeg: 14,
  tileWorldSize: 0.8,     // bark UV tile (m)
  windWeightScale: 1,     // scales the whole wind field: the flexGain ramp is
                          // tuned for metre-scale trees; sub-metre SHRUBS get
                          // tree amplitudes over centimetres and read as jello
};

// ---- skeleton (stochastic L-system) ----------------------------------------

// Bend `dir` toward vertical by `amount` (0..1 of the remaining declination).
function tropism(dir, amount) {
  if (amount <= 0) return dir;
  const dot = Math.max(-1, Math.min(1, dir.dot(UP)));
  const decl = Math.acos(dot);
  if (decl < 1e-4) return dir;
  const axis = new Vector3().crossVectors(dir, UP);
  if (axis.lengthSq() < 1e-8) return dir;
  axis.normalize();
  return dir.clone().applyAxisAngle(axis, amount * decl).normalize();
}

// A perpendicular unit vector to `dir` (for the fork plane).
function perp(dir) {
  const a = Math.abs(dir.y) < 0.9 ? UP : X;
  return new Vector3().crossVectors(dir, a).normalize();
}

// Build one bent segment as a curved polyline of segCurveRes+1 points.
// Curvature = armBend (a smooth elbow) + gnarliness jitter, then tropism, so
// the segment bends WITHOUT introducing extra L-system forks.
function growSegment(origin, dir0, length, radius0, radius1, p, rng, resOverride) {
  const res = Math.max(1, resOverride ?? p.segCurveRes);
  const points = [origin.clone()];
  const radii = [radius0];
  const dir = dir0.clone().normalize();
  const pos = origin.clone();
  const bendPer = ((p.armBend + rng.vary(0, p.gnarliness)) * Math.PI) / 180 / res;
  const bendAxis = perp(dir); // curve the elbow within one plane per segment
  for (let i = 1; i <= res; i++) {
    dir.applyAxisAngle(bendAxis, bendPer);
    if (p.gnarliness > 0) {
      dir.applyAxisAngle(perp(dir), (rng.vary(0, p.gnarliness) * Math.PI) / 180 / res);
    }
    tropismInPlace(dir, p.curlUp / res);
    pos.addScaledVector(dir, length / res);
    points.push(pos.clone());
    radii.push(radius0 + (radius1 - radius0) * (i / res));
  }
  return { points, radii, endDir: dir.clone().normalize() };
}
function tropismInPlace(dir, amount) {
  const t = tropism(dir, amount);
  dir.copy(t);
}

// Rotation-minimizing frame → per-point orientation quaternions (local +Y =
// tangent), for placing rosettes/skirt and for tube rings.
function framesFor(points) {
  const orients = [];
  const tangents = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const t = new Vector3();
    if (i === 0) t.subVectors(points[1], points[0]);
    else if (i === n - 1) t.subVectors(points[n - 1], points[n - 2]);
    else t.subVectors(points[i + 1], points[i - 1]);
    t.normalize();
    tangents.push(t);
    orients.push(new Quaternion().setFromUnitVectors(Y, t));
  }
  return { orients, tangents };
}

function makeStem(seg, level, maxLevel, windBase, flexGain, p) {
  const { orients } = framesFor(seg.points);
  let total = 0;
  for (let i = 1; i < seg.points.length; i++) total += seg.points[i].distanceTo(seg.points[i - 1]);
  // CLAMP to 1: a child's windBase is min(1, parent windBase+flexGain), so if
  // the parent's tip weight isn't also clamped the two sides of a fork get
  // different wind amplitudes and the joint tears apart in the wind. Clamping
  // makes the parent tip weight == the child base weight → forks stay welded.
  const winds = seg.points.map((_, i) => {
    const f = seg.points.length > 1 ? i / (seg.points.length - 1) : 0;
    return Math.min(1, windBase + flexGain * Math.pow(f, 1.15));
  });
  return {
    points: seg.points, radii: seg.radii, orients, winds,
    level, maxLevel, total, terminal: false,
    lobes: 0, lobeDepth: 0, radialSegments: p.radialSegs,
    children: [],
  };
}

/**
 * @returns {{ stems, terminalStems, geometry }}
 */
export function generateDichotomous(userParams, rng) {
  const p = { ...DEFAULTS, ...userParams };
  const stems = [];
  const terminalStems = [];
  // Expected column height (per-segment climb × segment count) — arms sprout above a
  // fraction of it, and AIM for ~its crown so the candelabra tips line up (trident).
  const expectedHeight = p.firstForkHeight * p.forkGenerations;
  const armMinHeight = (p.armMinHeightFrac ?? 0) * expectedHeight;

  // Anti-intersection: steer a new arm's initial direction AWAY from existing
  // branch points near where it's headed. Depth-first growth means earlier
  // arms already exist, so later ones avoid them. The parent neighborhood is
  // excluded (it's always adjacent to the fork).
  const allPts = [];
  const tips = []; // crown centres (arm tips) — each carries a rosette ball of radius ~tipClearance
  const _rep = new Vector3(), _probe = new Vector3(), _d = new Vector3();
  function repelDir(pos, dir, len) {
    const strength = p.branchRepel ?? 0;
    if (strength <= 0) return dir;
    const clr = p.tipClearance ?? 0; // rosette radius: keep the new arm's CROWN clear too
    // Probe near the TIP (where this arm's rosette will sit), and reach out by the
    // crown radius so the ball — not just the centreline — clears other branches.
    _probe.copy(pos).addScaledVector(dir, len * 0.8);
    const reach = len * 0.6 + clr;
    const R2 = reach ** 2, near2 = (len * 0.5) ** 2;
    _rep.set(0, 0, 0);
    for (const pt of allPts) {
      if (pt.distanceToSquared(pos) < near2) continue; // skip the parent neighborhood
      const dsq = _probe.distanceToSquared(pt);
      if (dsq < R2 && dsq > 1e-4) _rep.add(_d.subVectors(_probe, pt).multiplyScalar(1 / dsq));
    }
    // Crown-vs-crown: push hard so the new rosette doesn't ram an EXISTING one.
    const crownGap2 = (clr * 1.7) ** 2;
    for (const t of tips) {
      if (t.distanceToSquared(pos) < near2) continue;
      const dsq = _probe.distanceToSquared(t);
      if (dsq < crownGap2 && dsq > 1e-4) _rep.add(_d.subVectors(_probe, t).multiplyScalar(crownGap2 / dsq));
    }
    if (_rep.lengthSq() < 1e-8) return dir;
    return dir.clone().addScaledVector(_rep.normalize(), strength).normalize();
  }

  // Recursive growth. windBase/flexGain make the wind field fork-continuous.
  // baseIsFork = this stem's BASE is a real fork (its parent split into ≥2),
  // vs a single continuation run — the skirt only tapers at true forks.
  function grow(origin, dir, radius, length, depth, level, windBase, flareBase, baseIsFork = false, isGroundBase = false) {
    const flexGain = [0.3, 0.4, 0.5, 0.55][Math.min(level, 3)];
    const r1 = Math.max(p.minRadius, radius * 0.96); // arms barely taper along a segment
    // the trunk gets extra rings so its flare + undulation can be organic
    const seg = growSegment(origin, dir, length, radius, r1, p, rng, level === 0 ? (p.trunkSegRes ?? 9) : undefined);
    // Blend the base ring toward flareBase over the first 40% of the segment. A
    // CONTINUATION passes flareBase = parent radius (widens ring0 to weld the seam);
    // a FORK ARM passes parent radius × forkBaseScale, which can be SMALLER than the
    // arm's own radius → this NECKS the base in so the tilted arm base tucks inside the
    // trunk instead of poking out at the crotch. (No `> radii[0]` guard: blend both ways.)
    if (flareBase) {
      for (let i = 0; i < seg.radii.length; i++) {
        const z = i / (seg.radii.length - 1);
        if (z < 0.4) seg.radii[i] = flareBase * (1 - z / 0.4) + seg.radii[i] * (z / 0.4);
      }
    }
    // trunk base flare: the ground-contact end swells (Joshua trunks widen at
    // the ground), now with ORGANIC undulation — low-frequency radius bumps,
    // stronger toward the base — over the extra trunk rings, so it reads as a
    // gnarled root-flare instead of a smooth cone.
    // ONLY the ground-contact segment flares. A trunk that CONTINUES (single
    // child, still level 0) must not re-flare partway up — that made a second
    // root-bulge appear mid-trunk on some seeds.
    if (level === 0 && isGroundBase && (p.trunkFlare ?? 0) > 0) {
      for (let i = 0; i < seg.radii.length; i++) {
        const z = i / (seg.radii.length - 1);
        const flare = z < 0.35 ? 1 + p.trunkFlare * (1 - z / 0.35) : 1;
        const amp = 0.10 + 0.16 * (1 - z); // undulation grows toward the base
        const und = 1 + amp * (Math.sin(z * 8.3) * 0.6 + Math.sin(z * 21.7 + 1.9) * 0.4);
        seg.radii[i] *= flare * und;
      }
    }
    // Saguaro: NO flare — instead a slight inward PINCH right at the ground contact,
    // easing back to full girth over the first ~12% of the base segment.
    if (level === 0 && isGroundBase && (p.trunkPinch ?? 0) > 0) {
      for (let i = 0; i < seg.radii.length; i++) {
        const z = i / (seg.radii.length - 1);
        if (z < 0.12) seg.radii[i] *= 1 - p.trunkPinch * (1 - z / 0.12);
      }
    }
    const stem = makeStem(seg, level, p.forkGenerations, windBase, flexGain, p);
    stem.baseIsFork = baseIsFork;
    stems.push(stem);
    for (const pt of seg.points) allPts.push(pt); // register for anti-intersection
    const endPos = seg.points[seg.points.length - 1];
    const endDir = seg.endDir;
    const endRadius = seg.radii[seg.radii.length - 1];
    const windTip = Math.min(1, windBase + flexGain);

    if (depth <= 1) { stem.terminal = true; terminalStems.push(stem); tips.push(endPos.clone()); return stem; }

    const fork = rng.next() < p.branchiness;
    // Straight main-axis continuation (the L-system's single F) — a near-vertical
    // run with a touch of jitter/curl. Used when the column simply climbs.
    const continueMainAxis = () => {
      let cdir = endDir.clone();
      // A dead flowering node redirects growth into a new stem that VEERS off at an
      // angle — not a smooth curve. continuationKink sets that elbow (Joshua ~16°).
      cdir.applyAxisAngle(perp(cdir), (rng.vary(0, p.continuationKink ?? 8) * Math.PI) / 180).normalize();
      cdir = repelDir(endPos, tropism(cdir, p.curlUp * 0.4), length);
      stem.children.push(grow(endPos, cdir, endRadius * 0.98, length, depth - 1, level, windTip, endRadius, false));
    };
    // SAGUARO: an arm may sprout only on the UPPER trunk (height gate) and only
    // from a low branch order (order gate) — so the column reliably gets a few
    // upraised arms instead of either none or a recursive bush of arms-off-arms.
    const canArm = level < (p.armMaxOrder ?? 99) && endPos.y >= armMinHeight;
    if (p.armAsymmetric && fork && canArm) {
      // SAGUARO candelabra: the MAIN AXIS keeps climbing (same level & thickness,
      // pulled near-vertical) while 1–2 lateral ARMS jut out wide, then curlUp bends
      // them back up over their run — the iconic upraised arms, not a symmetric Y.
      const childR = Math.max(p.minRadius, endRadius * p.forkRadiusKeep);
      let mdir = tropism(endDir.clone(), p.curlUp * 0.5);
      mdir.applyAxisAngle(perp(mdir), (rng.vary(0, 5) * Math.PI) / 180).normalize();
      mdir = repelDir(endPos, mdir, length);
      stem.children.push(grow(endPos, mdir, endRadius * 0.985, length, depth - 1, level, windTip, endRadius, false));
      const nArms = rng.next() < p.forkTriChance ? 2 : 1;
      const planeAz = rng.range(0, Math.PI * 2);
      for (let k = 0; k < nArms; k++) {
        const az = planeAz + k * Math.PI + rng.vary(0, 0.5);
        const tiltAxis = perp(endDir).applyAxisAngle(endDir, az);
        const spread = ((p.forkSpread + rng.vary(0, 10)) * Math.PI) / 180;
        let adir = endDir.clone().applyAxisAngle(tiltAxis, spread).normalize();
        adir = repelDir(endPos, adir, p.armLength);
        // flareBase = parent radius × forkBaseScale: <1 necks the arm base in so its
        // wide tilted base ring doesn't jut out past the trunk surface at the crotch.
        // Arm depth AIMS FOR THE CROWN: enough segments to rise from the sprout height
        // to ~the trunk top, so low arms grow the long candelabra J while high arms stay
        // short — all tips line up into the trident instead of overshooting the column.
        // (armGenerations caps it; the 0.7 accounts for the out-then-up path, not pure rise.)
        const armDepth = (p.armGenerations > 0)
          ? Math.max(2, Math.min(p.armGenerations, Math.round(Math.max(0, expectedHeight * 1.05 - endPos.y) / (p.armLength * 0.7))))
          : depth - 1;
        stem.children.push(grow(endPos, adir, childR, p.armLength, armDepth, level + 1, windTip, endRadius * (p.forkBaseScale ?? 1), true));
      }
    } else if (p.armAsymmetric) {
      // arm gate closed (too low, or an arm itself) → the column just climbs
      continueMainAxis();
    } else if (fork) {
      const nc = rng.next() < p.forkTriChance ? 3 : 2;
      const planeAz = rng.range(0, Math.PI * 2);
      const axis = perp(endDir);              // fork-plane normal seed
      const childR = Math.max(p.minRadius, endRadius * p.forkRadiusKeep);
      // Arm length is driven by the ARM LENGTH param, not the trunk height: when
      // the TRUNK (level 0) forks, its arms start at armLength; deeper forks
      // taper from there by armFalloff. Previously every segment inherited the
      // trunk's firstForkHeight, so "Trunk height" silently scaled the whole tree
      // (much more on multi-branch trees) and "Arm length" did nothing.
      const childLen = level === 0 ? p.armLength : length * p.armFalloff;
      for (let k = 0; k < nc; k++) {
        // diverge by ±spread, evenly spaced around the fork plane
        const az = planeAz + (k * Math.PI * 2) / nc;
        const spin = new Quaternion().setFromAxisAngle(endDir, az);
        const tiltAxis = axis.clone().applyQuaternion(spin);
        const spread = ((p.forkSpread + rng.vary(0, 6)) * Math.PI) / 180;
        let cdir = endDir.clone().applyAxisAngle(tiltAxis, spread).normalize();
        cdir = repelDir(endPos, cdir, childLen); // steer away from existing branches
        // nc≥2 → each child's base is a real fork junction
        const child = grow(endPos, cdir, childR, childLen, depth - 1, level + 1, windTip, endRadius * (p.forkBaseScale ?? 1), nc >= 2);
        stem.children.push(child);
      }
    } else {
      // single continuation — nearly straight run (the L-system's single F);
      // NOT a fork, so its base must not taper the skirt (continuous branch)
      continueMainAxis();
    }
    return stem;
  }

  const trunkLen = p.firstForkHeight;
  const nTrunks = Math.max(1, p.trunks | 0);
  for (let t = 0; t < nTrunks; t++) {
    const dir = UP.clone();
    if (nTrunks > 1) {
      const az = (Math.PI * 2 * t) / nTrunks;
      dir.applyAxisAngle(X, (p.trunkSplayDeg * Math.PI) / 180).applyAxisAngle(UP, az).normalize();
    }
    // windBase 0: the ground-contact ring is PINNED. Any base weight makes the
    // trunk slide laterally against the ground plane in the wind — invisible
    // on a fat Joshua trunk, an obvious "broken ankle" on 2 cm shrub stems.
    grow(new Vector3(0, 0, 0), dir, p.trunkRadius, trunkLen, p.forkGenerations, 0, 0, 0, false, true);
  }

  // Post-scale the wind field (bark aWind + foliage/fruit anchors all read
  // stem.winds). Applied after growth so the fork-continuity invariant — the
  // parent tip weight equalling the child base weight — survives untouched.
  if ((p.windWeightScale ?? 1) !== 1) {
    for (const s of stems) s.winds = s.winds.map((w) => w * p.windWeightScale);
  }

  const geometry = buildMergedMesh(stems, p);
  return { stems, terminalStems, geometry };
}

// ---- merged tube mesh ------------------------------------------------------
// One connected surface. Each stem is a tube of rings; a stem's LAST ring is
// stitched to EACH child stem's FIRST ring, so the parent feeds both children
// through the fork (merged, no split pieces, no hole). All rings share the same
// vertex count so stitching is i→i; rotation-minimizing frames avoid twist.

const _rmfAxis = new Vector3();
function ringVertices(center, tangent, refDir, radius, seg, uvY, uScale, out, ribCount = 0, ribDepth = 0, prevTangent = null, uPhase = 0, swapUV = false) {
  // Rotation-minimizing frame. Naively RE-PROJECTING a fixed refDir onto each ring
  // (n = refDir − t·(refDir·t)) collapses when the tangent swings toward refDir on a
  // STRONG bend: n→0, we fall back to perp(tangent), and that basis-dependent vector
  // JUMPS the ring's U origin + rib phase → a sheared "sliver of broken UVs". Instead
  // ROTATE the carried frame by the same rotation that turns the previous tangent into
  // this one — a continuous transport that only degenerates at a 180° reversal.
  const n = new Vector3().copy(refDir);
  if (prevTangent) {
    const dot = Math.max(-1, Math.min(1, prevTangent.dot(tangent)));
    if (dot < 0.999999) {
      _rmfAxis.crossVectors(prevTangent, tangent);
      if (_rmfAxis.lengthSq() > 1e-12) n.applyAxisAngle(_rmfAxis.normalize(), Math.acos(dot));
    }
  }
  n.addScaledVector(tangent, -n.dot(tangent)); // re-orthonormalize against the current tangent
  if (n.lengthSq() < 1e-8) n.copy(perp(tangent));
  n.normalize();
  const b = new Vector3().crossVectors(n, tangent).normalize();
  for (let j = 0; j <= seg; j++) {
    const a = (j / seg) * Math.PI * 2;
    const dir = new Vector3().copy(n).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
    // Flute the cross-section into accordion ribs: peaks (cos=+1) push OUT to form
    // the rib crests, troughs pull IN for the grooves. Vertex normals are recomputed
    // downstream (computeVertexNormals), so the rib shading falls out automatically.
    const rr = ribDepth > 0 ? radius * (1 + ribDepth * Math.cos(ribCount * a)) : radius;
    out.pos.push(center.x + dir.x * rr, center.y + dir.y * rr, center.z + dir.z * rr);
    out.nrm.push(dir.x, dir.y, dir.z);
    // swapUV (barkGrainU): the bark image's grain runs along X, so put the
    // stem's LENGTH on image X (u) and the ring wrap on image Y (v) — twig-pile
    // tiles then read as fibres running along the branch, not rings around it.
    if (swapUV) out.uv.push(uvY, (j / seg) * uScale + uPhase);
    else out.uv.push((j / seg) * uScale + uPhase, uvY);
    out.wind.push(0);
    out.center.push(center.x, center.y, center.z); // centerline → wind sway phase
  }
  return n; // carry for the next ring (parallel transport)
}

// targetGeo: pass an existing BufferGeometry to REWRITE IN PLACE (same object) —
// setAttribute/setIndex replace the buffers but keep the geometry identity, so
// WebGPU reuses the compiled pipeline instead of recompiling (~0.8s) every rebuild.
export function buildMergedMesh(stems, params, targetGeo = null) {
  const p = { ...DEFAULTS, ...params };
  // A zero/invalid rib-count can arrive while a cactus preset is being edited.
  // In particular, older presets coupled `radialSegs` to `ribCount`, so setting
  // ribs to zero also produced a zero-sided ring: j / seg then became 0 / 0 and
  // filled every mesh attribute with NaNs. A tube always needs at least a
  // triangle cross-section; zero ribs simply means a smooth tube.
  p.ribCount = Math.max(0, Math.round(Number.isFinite(p.ribCount) ? p.ribCount : 0));
  p.radialSegs = Math.max(3, Math.round(Number.isFinite(p.radialSegs) ? p.radialSegs : 3));
  // RIB LOCK invariant: the bark texture carries `ribsPerTile` rib-crest columns,
  // and the tube wraps it uScale = ribCount/ribsPerTile times. For the painted
  // areole holes to keep landing on the mesh crests (and the real spines) as the
  // user changes the rib COUNT, uScale must stay an integer → ribCount must stay a
  // multiple of ribsPerTile. Snap it here so ANY rib-count dial value stays aligned.
  if (p.ribCount > 0 && p.ribDepth > 0) {
    const rpt = Math.max(1, Math.round(Number.isFinite(p.ribsPerTile) ? p.ribsPerTile : 4));
    p.ribCount = Math.max(rpt, Math.round(p.ribCount / rpt) * rpt);
    p.radialSegs = Math.max(p.radialSegs, p.ribCount * 2); // ≥2 verts/rib, multiple of ribCount → a vertex on every crest
    p.radialSegs = Math.round(p.radialSegs / p.ribCount) * p.ribCount;
  }
  const seg = p.radialSegs;
  const ringLen = seg + 1;
  const out = { pos: [], nrm: [], uv: [], wind: [], center: [], idx: [] };
  // Rib-crest anchors (cactus): one entry per ring per rib, at the EXACT crest
  // vertex (same frame the ring uses), so the spine builder can seat areoles dead
  // on the ridge peaks. Only collected when the cross-section is fluted.
  const crestAnchors = [];
  const collectCrests = p.ribCount > 0 && p.ribDepth > 0;
  const P = out.pos;
  const dsq = (i, k) => { const a3 = i * 3, b3 = k * 3; const dx = P[a3] - P[b3], dy = P[a3 + 1] - P[b3 + 1], dz = P[a3 + 2] - P[b3 + 2]; return dx * dx + dy * dy + dz * dz; };
  const stitch = (a, b) => { // stitch two rings by base vertex index
    for (let j = 0; j < seg; j++) {
      const a0 = a + j, a1 = a + j + 1, b0 = b + j, b1 = b + j + 1;
      // Split the quad along its SHORTER diagonal (a1–b0 vs a0–b1). On a twisted or
      // forked quad the fixed split can show a crease/bowtie; picking the short one
      // keeps the two triangles well-shaped (same outward winding either way).
      if (dsq(a1, b0) <= dsq(a0, b1)) out.idx.push(a0, b0, a1, a1, b0, b1);
      else out.idx.push(a0, b0, b1, a0, b1, a1);
    }
  };

  // RING DECIMATION (reduced/mobile LODs): the skeleton's ring cadence is
  // GENERATOR-fixed — dense enough for the hero — and radialSegs only thins a
  // stem around its GIRTH. This is the lever that thins it along its LENGTH:
  // drop rings that add little shape, always keeping the base + tip (fork/weld
  // rings), and keeping a ring once, since the last kept one, the accumulated
  // BEND exceeds ringKeepAngle, the RADIUS drifts >12% (base flares/necks stay
  // shaped), or the GAP exceeds ringMaxSpacing. Off (hero) when ringMaxSpacing
  // is unset/0 — the stem is used as-is, no copies made.
  const decimate = (p.ringMaxSpacing ?? 0) > 0;
  const _da = new Vector3(), _db = new Vector3();
  const ringsOf = (stem) => {
    if (!decimate || stem.points.length <= 2) return stem;
    const keepAng = ((p.ringKeepAngle ?? 15) * Math.PI) / 180;
    const pts = stem.points;
    const keep = [0];
    let gap = 0, bend = 0, rKept = stem.radii[0];
    for (let i = 1; i < pts.length - 1; i++) {
      gap += pts[i].distanceTo(pts[i - 1]);
      _da.subVectors(pts[i], pts[i - 1]).normalize();
      _db.subVectors(pts[i + 1], pts[i]).normalize();
      bend += _da.angleTo(_db);
      const rDrift = Math.abs(stem.radii[i] - rKept) / Math.max(rKept, 1e-4);
      if (bend >= keepAng || gap >= p.ringMaxSpacing || rDrift >= 0.12) {
        keep.push(i); gap = 0; bend = 0; rKept = stem.radii[i];
      }
    }
    keep.push(pts.length - 1);
    // ANTI-ALIAS the kept rings onto the MEAN curve: the generator's gnarl
    // wiggle is shorter than the decimated ring spacing, so sampling raw points
    // lands rings on wiggle EXTREMES and the smooth wave reads as a jagged
    // chord-kinked elbow. Each interior kept ring becomes the centroid of the
    // skeleton points it replaced (window = halfway to its kept neighbours);
    // base + tip stay exact (fork/weld/cap positions are load-bearing).
    const n = keep.length;
    const points = new Array(n), radii = new Array(n), winds = new Array(n);
    for (let k = 0; k < n; k++) {
      const i = keep[k];
      if (k === 0 || k === n - 1) { points[k] = pts[i]; radii[k] = stem.radii[i]; winds[k] = stem.winds[i]; continue; }
      const lo = Math.ceil((keep[k - 1] + i) / 2), hi = Math.floor((i + keep[k + 1]) / 2);
      const c = new Vector3();
      let r = 0, w = 0, m = 0;
      for (let j = lo; j <= hi; j++) { c.add(pts[j]); r += stem.radii[j]; w += stem.winds[j]; m++; }
      points[k] = c.divideScalar(m); radii[k] = r / m; winds[k] = w / m;
    }
    return { points, radii, winds };
  };

  // Emit a stem's rings; return the base index of its FIRST and LAST ring so a
  // parent can stitch into the child's first, and children stitch into ours.
  function emitStem(stem, refDir0, vY0, tan0 = null) {
    const sv = ringsOf(stem); // decimated view of points/radii/winds (or the stem itself)
    const { tangents } = framesFor(sv.points);
    // A CONTINUATION child (main axis / single F) shares the parent's END tangent for
    // its first ring, so that ring is bit-identical to the parent's LAST ring (same
    // centre, tangent, frame, radius, rib phase). They then position-weld and the
    // normals average → no shading crease at the segment joint. (Divergent ARMS pass
    // tan0=null: their base is a genuine crease at the armpit, left as-is.)
    if (tan0) tangents[0] = tan0.clone();
    let ref = refDir0.clone();
    let vY = vY0;
    const rings = [];
    // U wrap from a radius ABOVE the base flare: the very base ring can be ~3×
    // wider than the stem body, so wrapping off radii[0] over-wraps the whole
    // stem and crushes the texels toward the top (the trunk "stretch"). Square
    // texels — V advances by the same world tile as U (tileV) — so bark furrows
    // keep a constant aspect on the trunk and the branches alike.
    const refIdx = Math.min(sv.radii.length - 1, Math.floor(sv.radii.length * 0.5));
    const circRef = 2 * Math.PI * sv.radii[refIdx];
    // CACTUS RIB LOCK: the bark texture is painted with `ribsPerTile` rib crests
    // (each carrying its column of areole/spine holes). To land those painted holes
    // dead on the mesh's rib crests — and thus on the real spine cards seated there —
    // the texture must wrap an INTEGER number of times AND that wrap count must place
    // one painted crest per mesh rib. uScale = ribCount / ribsPerTile does exactly
    // that (independent of stem radius → constant across every segment, which also
    // removes the per-stem rounding jump that misaligned one terminal segment). uPhase
    // = 0.5/ribsPerTile centres the crests inside the tile so the wrap seam falls in a
    // groove (hidden), matching how the texture is drawn.
    // The UV lock keys off ribCount ALONE (not ribDepth): the SMOOTH far rungs
    // (ribDepth 0 — mobile LOD3/LOD4 columns) must tile exactly like the fluted
    // levels, or each stem falls back to its own circumference-derived wrap
    // count and the trunk/arms visibly re-tile against each other and against
    // the nearer LODs. (The radialSegs forcing in the header stays gated on
    // ribDepth > 0 — smooth columns keep their cheap radial cut.)
    const fluted = p.ribCount > 0;
    const ribsPerTile = p.ribsPerTile ?? 4;
    let uScale, uPhase = 0, tileV;
    if (fluted) {
      uScale = Math.max(1, Math.round(p.ribCount / ribsPerTile));
      uPhase = 0.5 / ribsPerTile;
      // V rate is CONSTANT (not radius-derived) so no segment shows a vertical texel
      // jump. The Bark-tiling dial repurposes cleanly here: it sets the vertical tile
      // size (rib spacing down the column) without disturbing the locked rib columns.
      tileV = Math.max(0.05, p.tileWorldSize);
    } else {
      const wraps = circRef / p.tileWorldSize;
      uScale = wraps >= 0.75 ? Math.max(1, Math.round(wraps)) : wraps; // integer on stems, fractional only on thin twigs
      tileV = Math.max(0.02, circRef / uScale);
    }
    // RIB FADE AT A FORK BASE: a diverging arm's flared, fluted base drives sharp
    // star-peaks sideways out of the crotch (they don't align with the trunk's ribs).
    // Fade the rib depth from 0 at the base up to full over the arm's first stretch,
    // so the junction is a smooth round collar and the ribs emerge as the arm rises —
    // exactly how a saguaro arm attaches. Continuation runs (same-level) keep full ribs.
    const fadeFork = stem.baseIsFork && p.ribDepth > 0;
    let stemLen = 0; for (let i = 1; i < sv.points.length; i++) stemLen += sv.points[i].distanceTo(sv.points[i - 1]);
    const fadeLen = Math.max(0.25, stemLen * 0.4);
    let arc = 0;
    for (let i = 0; i < sv.points.length; i++) {
      const base = out.pos.length / 3;
      if (i > 0) { const dl = sv.points[i].distanceTo(sv.points[i - 1]); vY += dl / tileV; arc += dl; }
      const rd = fadeFork ? p.ribDepth * smoothstep01(arc / fadeLen) : p.ribDepth;
      ref = ringVertices(sv.points[i], tangents[i], ref, sv.radii[i], seg, vY, uScale, out, p.ribCount, rd, i > 0 ? tangents[i - 1] : null, uPhase, p.barkGrainU);
      // wind weight per ring vertex
      for (let j = 0; j < ringLen; j++) out.wind[out.wind.length - ringLen + j] = sv.winds[i];
      // rib-crest anchors: crestDir at each rib peak uses the SAME (n,b) frame AND the
      // faded rib depth the ring's vertices use, so an areole sits exactly on the crest.
      // Skip near-flat rings (rd≈0 at a fork collar) — no ridge for a spine to sit on.
      if (collectCrests && rd > 0.02) {
        const c = sv.points[i], tn = tangents[i], rad = sv.radii[i];
        const bvec = new Vector3().crossVectors(ref, tn).normalize();
        const rr = rad * (1 + rd);
        for (let k = 0; k < p.ribCount; k++) {
          const a = (k / p.ribCount) * Math.PI * 2;
          const cd = new Vector3().copy(ref).multiplyScalar(Math.cos(a)).addScaledVector(bvec, Math.sin(a));
          crestAnchors.push({
            pos: new Vector3(c.x + cd.x * rr, c.y + cd.y * rr, c.z + cd.z * rr),
            normal: cd.clone(), tangent: tn.clone(), center: c.clone(),
            radius: rad, wind: sv.winds[i], rib: k,
          });
        }
      }
      rings.push(base);
      if (i > 0) stitch(rings[i - 1], base);
    }
    const lastBase = rings[rings.length - 1];
    const lastTan = tangents[tangents.length - 1];
    // children: each starts at our end; stitch our last ring → child first ring.
    // A same-level child is the CONTINUATION (main axis) → hand it our end tangent so
    // its base ring welds seamlessly; higher-level children are divergent ARMS.
    // p.skipStem (optional predicate): omit a subtree from the tube network — the
    // rosette-card mobile rung drops TERMINAL arms whose geometry lives inside
    // their baked cards. A parent whose children are all skipped caps like a tip.
    const kids = p.skipStem ? stem.children.filter((c) => !p.skipStem(c)) : stem.children;
    for (const child of kids) {
      const isContinuation = child.level === stem.level;
      const childFirst = emitStem(child, ref, vY, isContinuation ? lastTan : null);
      stitch(lastBase, childFirst.first);
    }
    // ROUNDED STAR CAP on terminal tips: close the open tube end with a short
    // fluted dome whose radius (and thus rib amplitude) tapers to a smooth rounded
    // point — the domed star cap of a real saguaro arm/trunk tip (no hollow hole).
    if (kids.length === 0) {
      const capR = sv.radii[sv.radii.length - 1];
      const capC = sv.points[sv.points.length - 1];
      const capWind = sv.winds[sv.winds.length - 1];
      const nDome = 3;
      // cap rings share one frame (all use lastTan) → compute n,b once for spine crests
      const nCap = new Vector3().copy(ref).addScaledVector(lastTan, -ref.dot(lastTan));
      if (nCap.lengthSq() < 1e-8) nCap.copy(perp(lastTan));
      nCap.normalize();
      const bCap = new Vector3().crossVectors(nCap, lastTan).normalize();
      let prev = lastBase, capVY = vY;
      for (let s = 1; s <= nDome; s++) {
        const ang = (s / (nDome + 1)) * (Math.PI / 2);
        const dC = capC.clone().addScaledVector(lastTan, capR * Math.sin(ang));
        const base = out.pos.length / 3;
        capVY += (capR / (nDome + 1)) / tileV;
        ringVertices(dC, lastTan, ref, capR * Math.cos(ang), seg, capVY, uScale, out, p.ribCount, p.ribDepth, null, uPhase, p.barkGrainU);
        for (let j = 0; j < ringLen; j++) out.wind[out.wind.length - ringLen + j] = capWind;
        stitch(prev, base);
        prev = base;
        // Spine crests on the DOME: ONLY the top ring (near the apex). The dome's
        // BOTTOM ring sits right on top of the body's last crest ring (redundant, reads
        // as a doubled ring), so we skip it — the body already spines up to the dome base.
        const ringR = capR * Math.cos(ang);
        if (collectCrests && s === nDome) {
          const rr = ringR * (1 + p.ribDepth);
          for (let k = 0; k < p.ribCount; k++) {
            const a = (k / p.ribCount) * Math.PI * 2;
            const cd = new Vector3().copy(nCap).multiplyScalar(Math.cos(a)).addScaledVector(bCap, Math.sin(a));
            const nrm = new Vector3().copy(cd).multiplyScalar(Math.cos(ang)).addScaledVector(lastTan, Math.sin(ang)).normalize();
            crestAnchors.push({
              pos: new Vector3(dC.x + cd.x * rr, dC.y + cd.y * rr, dC.z + cd.z * rr),
              normal: nrm, tangent: lastTan.clone(), center: capC.clone(),
              radius: ringR, wind: capWind, rib: k,
              cap: true, // apex-dome areole — the bright spine cap every saguaro tip wears
            });
          }
        }
      }
      // Close the dome with a DEGENERATE apex RING (every vertex at the tip point)
      // instead of a single fanned apex vertex. Each apex vertex keeps the U of the
      // ring below it, so the texture no longer smears from the ring's full U-span
      // (0.125‥4.125) down to one point — that convergent smear read as the spiral/
      // pinwheel glitch at the tip. Standard sphere-pole UV handling.
      const aC = capC.clone().addScaledVector(lastTan, capR);
      const apexBase = out.pos.length / 3;
      const apexVY = capVY + (capR / (nDome + 1)) / tileV;
      for (let j = 0; j <= seg; j++) {
        out.pos.push(aC.x, aC.y, aC.z);
        out.nrm.push(lastTan.x, lastTan.y, lastTan.z);
        if (p.barkGrainU) out.uv.push(apexVY, (j / seg) * uScale + uPhase);
        else out.uv.push((j / seg) * uScale + uPhase, apexVY);
        out.wind.push(capWind);
        out.center.push(capC.x, capC.y, capC.z);
      }
      stitch(prev, apexBase);
    }
    return { first: rings[0], last: lastBase, endRef: ref };
  }

  // Roots = stems never referenced as a child (the trunk(s)). Emit each; the
  // recursion emits and stitches all descendants into the same buffers.
  const childSet = new Set();
  for (const s of stems) for (const c of s.children) childSet.add(c);
  for (const s of stems) {
    if (childSet.has(s)) continue;
    const t0 = new Vector3().subVectors(s.points[1], s.points[0]).normalize();
    emitStem(s, perp(t0), 0);
  }

  const g = targetGeo ?? new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(out.pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(out.nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(out.uv), 2));
  g.setAttribute('aWind', new BufferAttribute(new Float32Array(out.wind), 1));
  g.setAttribute('aStemCenter', new BufferAttribute(new Float32Array(out.center), 3));
  g.setIndex(out.idx);
  g.computeVertexNormals();
  // Weld SHADING normals across coincident positions: fork joints (parent-last ring
  // ≡ child-first ring) and the U-wrap seam (j=0 ≡ j=seg) sit at the same point but
  // are separate vertices, so computeVertexNormals leaves a hard normal edge that
  // reads as a "seam". Average the normals of every position-coincident cluster
  // (keeps vertices/UVs intact — only the normals are smoothed).
  {
    const pos = g.attributes.position.array, nrm = g.attributes.normal.array;
    const buckets = new Map();
    const Q = 1e4;
    for (let v = 0; v < pos.length / 3; v++) {
      const k = `${Math.round(pos[v * 3] * Q)},${Math.round(pos[v * 3 + 1] * Q)},${Math.round(pos[v * 3 + 2] * Q)}`;
      let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(v);
    }
    for (const b of buckets.values()) {
      if (b.length < 2) continue;
      let nx = 0, ny = 0, nz = 0;
      for (const v of b) { nx += nrm[v * 3]; ny += nrm[v * 3 + 1]; nz += nrm[v * 3 + 2]; }
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const v of b) { nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz; }
    }
    g.attributes.normal.needsUpdate = true;
  }
  g.computeBoundingSphere();
  g.computeBoundingBox();
  // Hand the rib-crest anchors to the spine builder (refreshed every rebuild, incl.
  // in-place reuse). Empty for non-fluted species.
  g.userData.ribCrests = crestAnchors;
  return g;
}
