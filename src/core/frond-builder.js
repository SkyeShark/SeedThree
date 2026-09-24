// Pinnate FROND builder — palm crowns (date palm first; fan palms later).
// See docs/frond-builder.md — that doc is the contract for the parameters.
//
// A frond is a curved RACHIS (a tapering, slightly flattened tube that springs
// from the crown at a base elevation and bends toward gravity by a droop angle)
// carrying LEAFLET CARDS along both sides. Each leaflet is a V-folded
// (induplicate) strip placed by: count per side, a length profile along the
// rachis, the angle to the rachis, the lift above the frond plane (the frond's
// V), a multi-plane rank offset, and a little gravity sag. The petiole carries
// short spine leaflets (acanthophylls). Dead fronds reuse the same grammar with
// hanging parameters and the dead atlas pieces; fruit bunches are crossed cards.
//
// Output is TWO geometries per detail level (two materials: bark + leaves):
//   • bark   — rachis tubes, same attribute set as dichotomous buildMergedMesh
//              (position/normal/uv/aWind/aStemCenter) so they merge into the
//              trunk mesh and ride the bark wind shader;
//   • leaves — ONE merged mesh of every leaflet, spine, dead leaflet and fruit
//              card, all sampling one atlas (compose-frond-atlas.mjs), with
//              per-vertex aWindVec/aAnchorPos/aThickness for the foliage wind +
//              SSS shader (no instancing → the export writes ONE primitive).
// Plus the far-LOD path: bakeFrondCards (one straightened exemplar frond per
// variant baked to a card) + buildFrondCardFoliage (a curved V-ribbon per
// frond, instanced per droop class).
//
// Palmate (fan) fronds are NOT implemented; the frond descriptor + rachis frame
// are the shared part, a palmate blade would be a second leaflet placer that
// fans segments from the rachis tip (see the doc).

import {
  BufferGeometry, BufferAttribute, InstancedBufferAttribute, InstancedMesh, Group, Mesh,
  Vector3, Quaternion, Matrix4, OrthographicCamera, Box3,
} from 'three/webgpu';
import { uniform } from 'three/tsl';
import { Rng } from './rng.js';
import { WIND_DIR } from './wind.js';
import { bakeGroupToTextures } from './impostor.js';
import { makeCardMaterial } from './branch-cards.js';

const UP = new Vector3(0, 1, 0);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const DEG = Math.PI / 180;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export const FROND_DEFAULTS = {
  // ---- crown layout ----
  frondCount: 30,        // live fronds
  frondCountVar: 0.15,   // per-seed ± fraction
  frondLength: 4.0,      // mature frond length (m)
  frondLengthVar: 0.1,
  crownDepth: 0.9,       // band down the trunk top where live fronds attach (m)
  elevMin: 6,            // base angle from the crown axis, YOUNGEST frond (deg)
  elevMax: 88,           // … OLDEST live frond (deg)
  elevCurve: 1.15,       // age → base-angle ramp: elev = min + (max−min)·age^elevCurve (<1 = more fronds low → rounder crown)
  elevJitter: 7,
  droop: 1,              // multiplier on the droop ramp (the "Droop" dial)
  droopMin: 8,           // rachis bend toward gravity, youngest (deg)
  droopMax: 72,          // … oldest (deg)
  droopCurve: 1.4,       // age → droop ramp exponent (same form as elevCurve)
  droopPow: 1.6,         // bend distribution along the rachis (x^p: stiff base, bending tip)
  frondRoll: 8,          // random roll of the leaf plane about the rachis (deg)
  // ---- rachis ----
  petioleFrac: 0.2,      // bare (spined) petiole fraction of the frond length
  rachisRadius: 0.035,   // half-width at the petiole (m)
  rachisTipRadius: 0.005,
  rachisFlat: 0.62,      // depth / width of the cross-section (flattened petiole)
  sheathFlare: 1.4,      // extra base width where the leaf sheath wraps the trunk
  rachisNormalBend: 0.5, // crown tubes' export normals bent this far toward the crown dome (0 = true tube normals)
  // ---- leaflets ----
  leafletsPerSide: 72,
  leafletLength: 0.5,    // peak leaflet length (m)
  leafletMinFrac: 0.32,  // leaflet length at the rachis ends, fraction of peak
  leafletPeak: 0.38,     // where along the blade the longest leaflets sit (0..1)
  leafletWidth: 0.055,   // card width / leaflet length (the texture's alpha shapes the blade)
  leafletAngle: 40,      // angle to the rachis at the blade base (deg)
  leafletTipAngle: 22,   // … at the frond tip
  vFold: 28,             // lift of the leaflets above the frond plane — the frond's V (deg)
  rankSpread: 16,        // multi-plane ranks: leaflets alternate ±this about vFold (deg)
  leafletFold: 22,       // each leaflet's own induplicate fold, per half (deg)
  leafletSag: 0.12,      // gravity sag of a leaflet tip (fraction of its length)
  spinesPerSide: 9,      // acanthophylls on the petiole
  spineLength: 0.14,
  // ---- dead-frond skirt ----
  deadCount: 0,          // dead fronds hanging under the crown
  deadKeep: 0.55,        // fraction of leaflets a dead frond still carries
  skirtDepth: 1.6,       // band down the trunk (below the live crown) the skirt spans (m)
  // ---- fruit ----
  bunchCount: 0,         // date bunches (crossed atlas cards at the end of a peduncle)
  bunchLength: 0.9,
  peduncleLength: 1.6,   // arching fruit stalk from a leaf axil (m); 0 = bunches hang at the crown (old behaviour)
  peduncleRadius: 0.024, // half-width (flattened strap)
  peduncleFlat: 0.55,
  peduncleElev: 58,      // base angle from the crown axis (deg): out of the crown, slightly up
  peduncleDroop: 122,    // total bend toward gravity along the stalk (deg): ends hanging
  peduncleSeat: [0.3, 0.6], // attach band, fraction of crownDepth below the crown top
  // ---- basal offshoots ----
  offshoots: 0,
  // ---- wind ----
  trunkTopWind: 0.3,     // sway weight at the crown (trunk base = 0, frond tips = 1)
  // ---- atlas (three.js UV rects [u0,v0,u1,v1]; v up) ----
  atlas: null,           // { live: [...], dead: [...], bunch: [...] }
  // Bark-texture rects the crown tubes sample (bark slot; compose-palm-bark-atlas.mjs):
  // u across = around the tube, v = base → tip.
  rachisUV: [0, 0, 1, 1],   // live rachis strip
  deadRachisUV: null,       // dead fronds (default: rachisUV)
  peduncleUV: null,         // fruit stalks (default: rachisUV)
};

// ---------------------------------------------------------------------------
// Frond descriptor + rachis curve
// ---------------------------------------------------------------------------

// A frond: { base, axis (crown axis), h (azimuth dir ⊥ axis), elev, droop, length,
//            roll, dead, wBase, age, key } — everything a detail level needs.
// The rachis lies in the plane (axis, h): T(s) = rotate(d0, L, droop·(s/L)^p)
// where d0 = cos(elev)·axis + sin(elev)·h and L = axis × h. Rotating about +L
// moves the tangent from the axis toward h and past it — i.e. toward gravity for
// a frond leaving an upright crown. The leaf-plane normal is N = T × L (adaxial
// side: up on a horizontal frond, facing the crown centre on an upright one).
function frondCurve(fr, steps = 40) {
  if (fr._curve && fr._curve.steps === steps) return fr._curve;
  const L = new Vector3().crossVectors(fr.axis, fr.h).normalize();
  const d0 = fr.axis.clone().multiplyScalar(Math.cos(fr.elev)).addScaledVector(fr.h, Math.sin(fr.elev)).normalize();
  // Roll the lateral axis about the base direction (leaf plane twist).
  if (fr.roll) L.applyAxisAngle(d0, fr.roll);
  const pts = [fr.base.clone()], tans = [], s = [0];
  const p = fr.base.clone();
  const tan = (x) => d0.clone().applyAxisAngle(L, fr.droop * Math.pow(clamp01(x), fr.droopPow ?? 1.6));
  for (let i = 0; i < steps; i++) {
    const tm = tan((i + 0.5) / steps);
    p.addScaledVector(tm, fr.length / steps);
    pts.push(p.clone());
    s.push(((i + 1) / steps) * fr.length);
  }
  for (let i = 0; i <= steps; i++) tans.push(tan(i / steps).normalize());
  fr._curve = { steps, pts, tans, s, L, d0 };
  return fr._curve;
}

// Frame at arc s: { pos, T, N, L }.
function frameAt(fr, s, out) {
  const c = frondCurve(fr);
  const x = Math.max(0, Math.min(1, s / fr.length)) * c.steps;
  const i = Math.min(c.steps - 1, Math.floor(x)), t = x - i;
  out.pos.copy(c.pts[i]).lerp(c.pts[i + 1], t);
  out.T.copy(c.tans[i]).lerp(c.tans[i + 1], t).normalize();
  out.L.copy(c.L);
  out.N.crossVectors(out.T, out.L).normalize();
  return out;
}
const mkFrame = () => ({ pos: new Vector3(), T: new Vector3(), N: new Vector3(), L: new Vector3() });

function rachisRadiusAt(fr, cfg, s) {
  const x = s / fr.length;
  // Fruit stalk: a flattened strap, barely tapering, no sheath.
  if (fr.tube === 'peduncle') return cfg.peduncleRadius * (1 - 0.35 * x);
  const r = cfg.rachisRadius * (fr.scale ?? 1);
  const rt = cfg.rachisTipRadius * (fr.scale ?? 1);
  let rad = rt + (r - rt) * Math.pow(1 - x, 0.9);
  if (x < 0.08) rad *= 1 + cfg.sheathFlare * Math.pow(1 - x / 0.08, 2);
  return rad;
}

const windAt = (fr, s) => {
  const x = clamp01(s / fr.length);
  const tipW = fr.tipWind ?? (fr.dead ? Math.min(1, fr.wBase + 0.45) : 1);
  return fr.wBase + (tipW - fr.wBase) * Math.pow(x, 1.2);
};

// ---------------------------------------------------------------------------
// Crown layout (per individual — shared by every LOD so levels never reshuffle)
// ---------------------------------------------------------------------------

/**
 * @param {object} top  { pos, dir, radius } — trunk tip (crown seat)
 * @param {object} base { pos, radius }      — trunk base (offshoots)
 * @param {object} cfg  frond config (FROND_DEFAULTS ∪ species.foliage)
 * @param {Rng} rng
 * @returns {{ fronds: Array, bunches: Array, domeOrigin: Vector3 }}
 */
export function layoutCrown(top, base, cfg, rng) {
  const c = { ...FROND_DEFAULTS, ...cfg };
  const fronds = [];
  // Crown axis: halfway between the trunk tip tangent and vertical — a leaning
  // palm's crown turns back toward the light.
  const axis = top.dir.clone().add(UP).normalize();
  const ref = Math.abs(axis.y) < 0.95 ? UP : new Vector3(1, 0, 0);
  const e1 = new Vector3().crossVectors(axis, ref).normalize();
  const e2 = new Vector3().crossVectors(axis, e1).normalize();
  const hAt = (theta) => e1.clone().multiplyScalar(Math.cos(theta)).addScaledVector(e2, Math.sin(theta)).normalize();
  const phase = rng.range(0, Math.PI * 2);

  const n = Math.max(0, Math.round(c.frondCount));
  for (let i = 0; i < n; i++) {
    const a = n > 1 ? i / (n - 1) : 0.5; // 0 youngest (spear) → 1 oldest live
    const theta = phase + i * GOLDEN + rng.vary(0, 0.12);
    const h = hAt(theta);
    const pos = top.pos.clone()
      .addScaledVector(axis, -a * c.crownDepth + 0.05)
      .addScaledVector(h, top.radius * (0.25 + 0.7 * a));
    // Age-graded angles. elevCurve/droopCurve < 1 front-load the ramp so the
    // mid-aged majority already arches past horizontal — tip chords spread about
    // evenly in cos(angle) from the spear down to the hanging oldest fronds, which
    // is what rounds a mature crown into a sphere instead of an upward burst.
    const elev = (c.elevMin + (c.elevMax - c.elevMin) * Math.pow(a, c.elevCurve) + rng.vary(0, c.elevJitter)) * DEG;
    const droop = Math.max(0, (c.droopMin + (c.droopMax - c.droopMin) * Math.pow(a, c.droopCurve)) * c.droop + rng.vary(0, 6)) * DEG;
    const length = c.frondLength * (0.7 + 0.3 * smooth(0, 0.35, a)) * (1 - 0.08 * a) * (1 + rng.vary(0, c.frondLengthVar));
    fronds.push({
      base: pos, axis: axis.clone(), h, elev: Math.max(2 * DEG, elev), droop, droopPow: c.droopPow,
      length, roll: rng.vary(0, c.frondRoll) * DEG, dead: false, age: a,
      wBase: c.trunkTopWind, key: `f${i}`, id: i,
    });
  }

  // Dead-frond skirt: hanging below the live crown, spiralling down the trunk.
  // The skirt fills a fixed band (skirtDepth) whatever the count, so a high count
  // THICKENS it (fronds overlap round the trunk) instead of stretching it down
  // the trunk; the newest dead fronds (top of the band) still stand off the
  // trunk, the oldest hang flat against it.
  const nd = Math.max(0, Math.round(c.deadCount));
  for (let j = 0; j < nd; j++) {
    const k = nd > 1 ? j / (nd - 1) : 0;
    const theta = phase + (n + j) * GOLDEN + rng.vary(0, 0.2);
    const h = hAt(theta);
    const drop = c.crownDepth + 0.1 + k * c.skirtDepth + rng.range(0, 0.1);
    const pos = top.pos.clone().addScaledVector(axis, -drop).addScaledVector(h, top.radius * 0.95);
    fronds.push({
      base: pos, axis: axis.clone(), h,
      elev: (148 + 22 * k + rng.range(0, 10)) * DEG, droop: rng.range(0, 12) * DEG, droopPow: 1.2,
      length: c.frondLength * rng.range(0.62, 0.9), roll: rng.vary(0, 25) * DEG,
      dead: true, age: 1, wBase: c.trunkTopWind * 0.9, key: `d${j}`, id: n + j,
    });
  }

  // Basal offshoots: trunkless mini-crowns at the foot of the trunk.
  const no = Math.max(0, Math.round(c.offshoots));
  for (let o = 0; o < no; o++) {
    const theta = rng.range(0, Math.PI * 2);
    const hg = new Vector3(Math.cos(theta), 0, Math.sin(theta));
    const seat = base.pos.clone().addScaledVector(hg, base.radius * 1.3 + rng.range(0.25, 0.6));
    const oAxis = UP.clone().addScaledVector(hg, 0.35).normalize();
    const oe1 = new Vector3().crossVectors(oAxis, UP.clone().add(new Vector3(0.001, 0, 0))).normalize();
    const oe2 = new Vector3().crossVectors(oAxis, oe1).normalize();
    const k = 7 + rng.int(0, 4);
    const scale = rng.range(0.28, 0.45);
    for (let i = 0; i < k; i++) {
      const a = i / (k - 1);
      const th = rng.range(0, 1) + i * GOLDEN;
      const h = oe1.clone().multiplyScalar(Math.cos(th)).addScaledVector(oe2, Math.sin(th)).normalize();
      fronds.push({
        base: seat.clone().addScaledVector(oAxis, 0.25 * (1 - a) * scale * 4), axis: oAxis.clone(), h,
        elev: (12 + 62 * a + rng.vary(0, 8)) * DEG, droop: (10 + 40 * a) * DEG, droopPow: 1.5,
        length: c.frondLength * scale * (0.75 + 0.25 * a), roll: rng.vary(0, 10) * DEG,
        dead: false, age: a, wBase: 0.02, key: `o${o}_${i}`, id: 1000 + o * 50 + i, scale,
      });
    }
  }

  // Fruit: each bunch rides a PEDUNCLE — a long flattened stalk that leaves a
  // leaf axil inside the crown, arches out past the frond bases and ends hanging
  // straight down (a frond-like curve: base angle peduncleElev, bent by
  // peduncleDroop). The bunch cards hang from the stalk's END, below and outside
  // the lower fronds (reference: "Dates on date palm"). Bunches are spread evenly
  // round the crown (golden-angle offsets) so two never share one side.
  const bunches = [], peduncles = [];
  const nb = Math.max(0, Math.round(c.bunchCount));
  const [seat0, seat1] = c.peduncleSeat ?? [0.3, 0.6];
  const bPhase = rng.range(0, Math.PI * 2);
  for (let b = 0; b < nb; b++) {
    const theta = bPhase + (b / Math.max(1, nb)) * Math.PI * 2 + rng.vary(0, 0.35);
    const h = hAt(theta);
    const len = (c.peduncleLength ?? 0) * rng.range(0.85, 1.15);
    const blen = c.bunchLength * rng.range(0.8, 1.15);
    const tilt = rng.range(4, 14) * DEG, spin = rng.range(0, Math.PI / 3);
    if (len > 0.05) {
      const seat = top.pos.clone()
        .addScaledVector(axis, -c.crownDepth * rng.range(seat0, seat1))
        .addScaledVector(h, top.radius * 0.9);
      const pd = {
        base: seat, axis: axis.clone(), h,
        elev: (c.peduncleElev + rng.vary(0, 8)) * DEG, droop: (c.peduncleDroop + rng.vary(0, 10)) * DEG, droopPow: 1.25,
        length: len, roll: 0, dead: false, tube: 'peduncle', age: 0.5,
        wBase: c.trunkTopWind, tipWind: Math.min(1, c.trunkTopWind + 0.35), key: `p${b}`, id: 2000 + b,
      };
      const cv = frondCurve(pd);
      peduncles.push(pd);
      bunches.push({
        top: cv.pts[cv.pts.length - 1].clone(), h, length: blen, tilt, spin,
        wBase: windAt(pd, len), key: `b${b}`,
      });
    } else {
      // No stalk: hang from a leaf axil just below the live crown (the original stalkless layout).
      const hang = top.pos.clone()
        .addScaledVector(axis, -c.crownDepth * rng.range(0.45, 0.75))
        .addScaledVector(h, top.radius + rng.range(0.4, 0.65))
        .addScaledVector(UP, -rng.range(0.05, 0.3));
      bunches.push({ top: hang, h, length: blen, tilt, spin, wBase: c.trunkTopWind, key: `b${b}` });
    }
  }

  const domeOrigin = top.pos.clone().addScaledVector(UP, -Math.max(2, c.frondLength * 0.6));
  return { fronds, bunches, peduncles, domeOrigin, axis };
}

// ---------------------------------------------------------------------------
// Geometry accumulators
// ---------------------------------------------------------------------------

function barkAcc() { return { pos: [], nrm: [], uv: [], wind: [], center: [], idx: [] }; }
function leafAcc() { return { pos: [], nrm: [], uv: [], windVec: [], anchor: [], thick: [], idx: [] }; }

function accToBarkGeometry(a) {
  if (!a.idx.length) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(a.pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(a.nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(a.uv), 2));
  g.setAttribute('aWind', new BufferAttribute(new Float32Array(a.wind), 1));
  g.setAttribute('aStemCenter', new BufferAttribute(new Float32Array(a.center), 3));
  g.setIndex(a.idx);
  return g;
}

function accToLeafGeometry(a) {
  if (!a.idx.length) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(a.pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(a.nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(a.uv), 2));
  g.setAttribute('aWindVec', new BufferAttribute(new Float32Array(a.windVec), 3));
  g.setAttribute('aAnchorPos', new BufferAttribute(new Float32Array(a.anchor), 3));
  g.setAttribute('aThickness', new BufferAttribute(new Float32Array(a.thick), 1));
  g.setIndex(a.idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  // Engine export keeps only the standard attributes for this mesh (the wind /
  // SSS attributes are shader-only) — read by export-glb.js.
  g.userData.exportAttributes = ['position', 'normal', 'uv'];
  return g;
}

/**
 * Concatenate indexed geometries that share an attribute set (the trunk from
 * buildMergedMesh + the rachis tubes). Avoids BufferGeometryUtils so the core
 * stays importable under Deno's import map (no `three/addons` there).
 */
export function mergeIndexedGeometries(geos) {
  const list = geos.filter(Boolean);
  if (list.length === 1) return list[0];
  const names = Object.keys(list[0].attributes);
  const out = new BufferGeometry();
  let vCount = 0, iCount = 0;
  for (const g of list) { vCount += g.attributes.position.count; iCount += g.index.count; }
  for (const n of names) {
    const size = list[0].attributes[n].itemSize;
    const arr = new Float32Array(vCount * size);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[n].array, o); o += g.attributes[n].array.length; }
    out.setAttribute(n, new BufferAttribute(arr, size));
  }
  const idx = new Uint32Array(iCount);
  let io = 0, vo = 0;
  for (const g of list) {
    const src = g.index.array;
    for (let k = 0; k < src.length; k++) idx[io + k] = src[k] + vo;
    io += src.length; vo += g.attributes.position.count;
  }
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  if (list[0].userData?.ribCrests) out.userData.ribCrests = list[0].userData.ribCrests;
  return out;
}

// ---------------------------------------------------------------------------
// Per-frond geometry
// ---------------------------------------------------------------------------

const _f = mkFrame(), _d = new Vector3(), _nb = new Vector3(), _w = new Vector3(), _c = new Vector3();
const _e = new Vector3(), _n = new Vector3(), _dome = new Vector3(), _wv = new Vector3();
const GRAV = new Vector3(0, -1, 0);

// A crown TUBE (bark slot): a live/dead frond's rachis or a fruit-stalk peduncle.
// Each kind samples its own region of the bark atlas (u around the tube — the
// N-facing adaxial side at u 0..0.5 — and v from base to tip). Export normals are
// bent `rachisNormalBend` toward the crown dome, like the leaflets' (0.85): a
// true tube normal faces the ground on the underside, so from below every rachis
// read as a dark line against the backlit leaflets.
function emitRachis(fr, cfg, spec, acc, domeOrigin) {
  const ped = fr.tube === 'peduncle';
  const rings = Math.max(2, ped ? (spec.peduncleRings ?? spec.rachisRings) : fr.dead ? (spec.deadRachisRings ?? spec.rachisRings) : spec.rachisRings);
  const sides = Math.max(3, spec.rachisSides);
  const rect = ped ? (cfg.peduncleUV ?? cfg.rachisUV) : fr.dead ? (cfg.deadRachisUV ?? cfg.rachisUV) : cfg.rachisUV;
  const [u0, v0, u1, v1] = rect ?? [0, 0, 1, 1];
  const flat = ped ? cfg.peduncleFlat : cfg.rachisFlat;
  const bend = domeOrigin ? Math.max(0, Math.min(1, cfg.rachisNormalBend ?? 0)) : 0;
  const first = acc.pos.length / 3;
  for (let k = 0; k <= rings; k++) {
    // Ring cadence denser near the base (sheath flare + strongest bend there).
    const x = Math.pow(k / rings, ped ? 1 : 1.25);
    const s = x * fr.length;
    frameAt(fr, s, _f);
    // Start the tube slightly INSIDE the crown so the sheath never floats.
    if (k === 0) _f.pos.addScaledVector(_f.T, -0.08 * (fr.scale ?? 1));
    const rw = rachisRadiusAt(fr, cfg, s), rd = rw * flat;
    const w = windAt(fr, s);
    if (bend > 0) { _dome.copy(_f.pos).sub(domeOrigin).normalize(); _dome.y += 0.45; _dome.normalize(); }
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      acc.pos.push(
        _f.pos.x + _f.L.x * ca * rw + _f.N.x * sa * rd,
        _f.pos.y + _f.L.y * ca * rw + _f.N.y * sa * rd,
        _f.pos.z + _f.L.z * ca * rw + _f.N.z * sa * rd,
      );
      _n.copy(_f.L).multiplyScalar(ca / rw).addScaledVector(_f.N, sa / rd).normalize();
      if (bend > 0) _n.multiplyScalar(1 - bend).addScaledVector(_dome, bend).normalize();
      acc.nrm.push(_n.x, _n.y, _n.z);
      acc.uv.push(u0 + (u1 - u0) * (j / sides), v0 + (v1 - v0) * x);
      acc.wind.push(w);
      acc.center.push(_f.pos.x, _f.pos.y, _f.pos.z);
    }
  }
  const rl = sides + 1;
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < sides; j++) {
      const a0 = first + k * rl + j, a1 = a0 + 1, b0 = a0 + rl, b1 = b0 + 1;
      // (L, N, T) is right-handed → this winding faces outward.
      acc.idx.push(a0, a1, b0, a1, b1, b0);
    }
  }
}

// One V-folded leaflet strip. rows = segments + 1; fold=false → a flat 2-vertex row.
function emitLeaflet(acc, basePos, d, nb, len, width, rect, sag, segs, fold, foldAng, windW, anchor, thick, domeOrigin) {
  _w.crossVectors(d, nb).normalize();
  const hw = width * 0.5;
  const cf = Math.cos(foldAng), sf = Math.sin(foldAng);
  const [u0, v0, u1, v1] = rect;
  const first = acc.pos.length / 3;
  const cols = fold ? 3 : 2;
  for (let r = 0; r <= segs; r++) {
    const u = r / segs;
    _c.copy(basePos).addScaledVector(d, len * u).addScaledVector(GRAV, 0.5 * sag * len * u * u);
    const v = v0 + (v1 - v0) * u;
    const put = (x, y, z, uu) => {
      acc.pos.push(x, y, z);
      // Export normal: the blade's face normal bent strongly toward the canopy
      // dome (the live shader ignores geometric normals — see leaf-cards.js; this
      // is what engines shade with, same 0.85 bend export-glb gives instanced leaves).
      _dome.set(x - domeOrigin.x, y - domeOrigin.y, z - domeOrigin.z).normalize();
      _dome.y += 0.45; _dome.normalize();
      _n.copy(nb).multiplyScalar(0.15).addScaledVector(_dome, 0.85).normalize();
      acc.nrm.push(_n.x, _n.y, _n.z);
      acc.uv.push(uu, v);
      _wv.copy(WIND_DIR).multiplyScalar(windW);
      acc.windVec.push(_wv.x, _wv.y, _wv.z);
      acc.anchor.push(anchor.x, anchor.y, anchor.z);
      acc.thick.push(thick);
    };
    if (fold) {
      _e.copy(_w).multiplyScalar(-hw * cf).addScaledVector(nb, hw * sf).add(_c);
      put(_e.x, _e.y, _e.z, u0);
      put(_c.x, _c.y, _c.z, (u0 + u1) * 0.5);
      _e.copy(_w).multiplyScalar(hw * cf).addScaledVector(nb, hw * sf).add(_c);
      put(_e.x, _e.y, _e.z, u1);
    } else {
      _e.copy(_w).multiplyScalar(-hw).add(_c); put(_e.x, _e.y, _e.z, u0);
      _e.copy(_w).multiplyScalar(hw).add(_c); put(_e.x, _e.y, _e.z, u1);
    }
  }
  for (let r = 0; r < segs; r++) {
    for (let k = 0; k < cols - 1; k++) {
      const a0 = first + r * cols + k, a1 = a0 + 1, b0 = a0 + cols, b1 = b0 + 1;
      acc.idx.push(a0, a1, b1, a0, b1, b0);
    }
  }
}

// Leaflet length profile along the blade (t 0..1): a skewed bump peaking at
// cfg.leafletPeak, never below leafletMinFrac at the ends.
function leafletProfile(cfg, t) {
  const pk = Math.max(0.05, Math.min(0.95, cfg.leafletPeak));
  const a = pk / (1 - pk);
  const f = Math.pow(t, a) * (1 - t);
  const fmax = Math.pow(pk, a) * (1 - pk);
  return cfg.leafletMinFrac + (1 - cfg.leafletMinFrac) * (f / fmax);
}

function emitLeaflets(fr, cfg, spec, acc, domeOrigin) {
  const atlas = cfg.atlas ?? {};
  const rects = (fr.dead ? atlas.dead : atlas.live) ?? [[0, 0, 1, 1]];
  const liveRects = atlas.live ?? rects;
  const sc = fr.scale ?? 1;
  // Per-frond stream, drawn in a FIXED order for every level → LOD1/LOD2 keep a
  // strict subset of LOD0's leaflets in exactly the same places.
  const rng = new Rng(`frond:${fr.key}:${fr.seedKey ?? ''}`);
  const M = Math.max(2, Math.round(cfg.leafletsPerSide * (fr.dead ? 0.85 : 1) * (sc < 1 ? 0.55 + 0.45 * sc : 1)));
  const s0 = cfg.petioleFrac * fr.length;
  const keepBase = fr.dead ? cfg.deadKeep * (spec.deadKeepMul ?? 1) : 1;
  const keep = keepBase * spec.leafletKeep;
  // Card economy (docs §4): one folded segment per leaflet (the sag lives in
  // the chord), two segments only on the outermost/oldest silhouette fronds
  // (spec.outerSegments above spec.outerAge); the dead skirt is flat cards.
  const outer = spec.outerSegments && !fr.scale && fr.age >= (spec.outerAge ?? 1);
  const segs = fr.dead ? 1 : outer ? spec.outerSegments : spec.leafletSegments;
  const fold = fr.dead ? (spec.deadFold ?? spec.fold) : spec.fold;
  let count = 0;
  for (const side of [-1, 1]) {
    for (let k = 0; k < M; k++) {
      const rKeep = rng.next(), rT = rng.next(), rA = rng.next(), rL = rng.next(), rR = rng.next(), rTh = rng.next(), rS = rng.next();
      if (rKeep >= keep) continue;
      const t = Math.min(0.995, (k + 0.5 + (rT - 0.5) * 0.7) / M);
      const s = s0 + t * (fr.length - s0);
      frameAt(fr, s, _f);
      const len = cfg.leafletLength * sc * leafletProfile(cfg, t) * (0.9 + 0.2 * rS);
      let alpha, lift, sag;
      if (fr.dead) {
        alpha = (14 + 12 * rA) * DEG;
        lift = (-12 - 26 * rL) * DEG;          // collapsed, hanging below the rachis
        sag = cfg.leafletSag * 2.5;
      } else {
        alpha = (cfg.leafletAngle + (cfg.leafletTipAngle - cfg.leafletAngle) * t + (rA - 0.5) * 10) * DEG;
        const rank = [1, -0.15, -1][k % 3];
        lift = (cfg.vFold + rank * cfg.rankSpread + (rL - 0.5) * 8) * DEG;
        sag = cfg.leafletSag;
      }
      _d.copy(_f.T).multiplyScalar(Math.cos(alpha)).addScaledVector(_f.L, side * Math.sin(alpha)).normalize();
      _d.multiplyScalar(Math.cos(lift)).addScaledVector(_f.N, Math.sin(lift)).normalize();
      _nb.copy(_f.N).addScaledVector(_d, -_f.N.dot(_d)).normalize();
      const rad = rachisRadiusAt(fr, cfg, s);
      const basePos = _f.pos.clone().addScaledVector(_f.L, side * rad * 0.7);
      const rect = rects[Math.floor(rR * rects.length) % rects.length];
      const width = len * cfg.leafletWidth * (spec.widthMul ?? 1) * (fr.dead ? (spec.deadWidthMul ?? 1) : 1);
      emitLeaflet(acc, basePos, _d, _nb, len, width, rect, sag, segs, fold, cfg.leafletFold * DEG,
        windAt(fr, s), _f.pos, 0.4 + 0.6 * rTh, domeOrigin);
      count++;
    }
  }
  // Acanthophylls: short stiff spine-leaflets on the petiole (live fronds only).
  if (spec.spines && !fr.dead && cfg.spinesPerSide > 0) {
    for (const side of [-1, 1]) {
      for (let k = 0; k < cfg.spinesPerSide; k++) {
        const rT = rng.next(), rA = rng.next(), rR = rng.next();
        const t = (k + 0.5 + (rT - 0.5) * 0.5) / cfg.spinesPerSide;
        const s = (0.07 + 0.93 * t) * s0;
        frameAt(fr, s, _f);
        const len = cfg.spineLength * sc * (0.45 + 0.9 * t);
        const alpha = (26 + 14 * rA) * DEG;
        _d.copy(_f.T).multiplyScalar(Math.cos(alpha)).addScaledVector(_f.L, side * Math.sin(alpha)).normalize();
        _d.multiplyScalar(Math.cos(cfg.vFold * DEG)).addScaledVector(_f.N, Math.sin(cfg.vFold * DEG)).normalize();
        _nb.copy(_f.N).addScaledVector(_d, -_f.N.dot(_d)).normalize();
        const rad = rachisRadiusAt(fr, cfg, s);
        const basePos = _f.pos.clone().addScaledVector(_f.L, side * rad * 0.8);
        const rect = liveRects[Math.floor(rR * liveRects.length) % liveRects.length];
        emitLeaflet(acc, basePos, _d, _nb, len, len * cfg.leafletWidth * 0.6, rect, 0, 1, false, 0,
          windAt(fr, s), _f.pos, 0.3, domeOrigin);
        count++;
      }
    }
  }
  return count;
}

// Crossed fruit-bunch cards: BUNCH_PLANES quads through the hang axis, evenly
// spaced in azimuth (three at 60° read as a round hanging mass from any side;
// two crossed cards read flat, like a pinecone, from the diagonals).
const BUNCH_PLANES = 3;
const BUNCH_CAP_AT = 0.58; // depth of the horizontal cap card down the bunch (fraction of its length)
function emitBunch(b, cfg, acc, domeOrigin) {
  const rect = cfg.atlas?.bunch;
  if (!rect) return 0;
  const [u0, v0, u1, v1] = rect;
  const aspect = (u1 - u0) / Math.max(1e-4, v1 - v0);
  const len = b.length, hw = len * aspect * 0.5;
  const down = GRAV.clone().applyAxisAngle(new Vector3().crossVectors(UP, b.h).normalize(), -b.tilt).normalize();
  const side1 = b.h.clone().applyAxisAngle(UP, b.spin).setY(0).normalize();
  const sides = [];
  for (let k = 0; k < BUNCH_PLANES; k++) sides.push(side1.clone().applyAxisAngle(UP, (k / BUNCH_PLANES) * Math.PI));
  const bottom = b.top.clone().addScaledVector(down, len);
  const quads = sides.map((sd) => [
    [b.top.clone().addScaledVector(sd, -hw), u0, v1], [b.top.clone().addScaledVector(sd, hw), u1, v1],
    [bottom.clone().addScaledVector(sd, hw), u1, v0], [bottom.clone().addScaledVector(sd, -hw), u0, v0],
  ]);
  // Horizontal CAP card through the lower bunch (the dense date half of the
  // piece): seen from straight below — the park-bench view — the vertical cards
  // are edge-on and read as a thin star; the cap reads as the hanging mass.
  const capC = b.top.clone().addScaledVector(down, len * BUNCH_CAP_AT);
  const ca = side1.clone().multiplyScalar(hw * 0.85);
  const cb = new Vector3().crossVectors(down, side1).normalize().multiplyScalar(hw * 0.85);
  const vm = v0 + (v1 - v0) * 0.55;
  quads.push([
    [capC.clone().sub(ca).sub(cb), u0, v0], [capC.clone().add(ca).sub(cb), u1, v0],
    [capC.clone().add(ca).add(cb), u1, vm], [capC.clone().sub(ca).add(cb), u0, vm],
  ]);
  for (const corners of quads) {
    const first = acc.pos.length / 3;
    for (const [p, uu, vv] of corners) {
      acc.pos.push(p.x, p.y, p.z);
      _dome.copy(p).sub(domeOrigin).normalize(); _dome.y += 0.45; _dome.normalize();
      acc.nrm.push(_dome.x, _dome.y, _dome.z);
      acc.uv.push(uu, vv);
      _wv.copy(WIND_DIR).multiplyScalar(b.wBase);
      acc.windVec.push(_wv.x, _wv.y, _wv.z);
      acc.anchor.push(b.top.x, b.top.y, b.top.z);
      acc.thick.push(0.25);
    }
    acc.idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return quads.length;
}

/** Per-level detail recipes (the LOD ladder of the frond builder). */
export const FROND_LOD_SPECS = {
  // Hero: V-folded leaflets (one segment, 4 tris — the sag rides in the chord;
  // two segments on the oldest/outermost silhouette fronds), spines, flattened
  // rachis; the dead skirt as flat, slightly wider cards.
  LOD0: { rachisRings: 12, rachisSides: 5, peduncleRings: 12, deadRachisRings: 6, leafletKeep: 1, leafletSegments: 1, outerSegments: 2, outerAge: 0.9, fold: true, widthMul: 1, spines: true, deadKeepMul: 1, deadFold: false, deadWidthMul: 1.3, bunches: true },
  // Mid (~40% of LOD0): a stable 85% leaflet subset as flat single cards (2
  // tris), wider so the blade keeps its coverage; no spines.
  LOD1: { rachisRings: 7, rachisSides: 4, peduncleRings: 7, deadRachisRings: 4, leafletKeep: 0.85, leafletSegments: 1, fold: false, widthMul: 1.3, spines: false, deadKeepMul: 0.6, deadFold: false, deadWidthMul: 1.3, bunches: true },
  // Far fallback when no frond-card bake exists (headless / bake failure).
  LOD2: { rachisRings: 5, rachisSides: 3, peduncleRings: 5, leafletKeep: 0.3, leafletSegments: 1, fold: false, widthMul: 1.6, spines: false, deadKeepMul: 0.4, bunches: true },
};

/**
 * Build one detail level of a crown: bark (rachis tubes) + leaves (merged cards).
 * @returns {{ bark: BufferGeometry|null, leaves: BufferGeometry|null, leaflets: number }}
 */
export function buildCrownGeometry(layout, cfg, spec, opts = {}) {
  const c = { ...FROND_DEFAULTS, ...cfg };
  const bark = barkAcc(), leaves = leafAcc();
  let leaflets = 0;
  // opts.pedunclesOnly: the frond-card rungs still need the fruit stalks as real
  // bark tubes (the cards carry fronds only) — emit just those.
  if (!opts.pedunclesOnly) {
    for (const fr of layout.fronds) {
      if (opts.skipDead && fr.dead) continue;
      emitRachis(fr, c, spec, bark, layout.domeOrigin);
      leaflets += emitLeaflets(fr, c, spec, leaves, layout.domeOrigin);
    }
  }
  if (spec.bunches) {
    for (const pd of layout.peduncles ?? []) emitRachis(pd, c, spec, bark, layout.domeOrigin);
    if (!opts.pedunclesOnly) for (const b of layout.bunches) emitBunch(b, c, leaves, layout.domeOrigin);
  }
  return { bark: accToBarkGeometry(bark), leaves: accToLeafGeometry(leaves), leaflets };
}

// ---------------------------------------------------------------------------
// Far LOD: baked frond cards on curved V-ribbons
// ---------------------------------------------------------------------------

const CARD_DROOP_CLASSES = [0, 22, 44, 66, 88, 110]; // deg — nearest class per frond
const CARD_ROWS = 7;
const CARD_V = 16; // wing lift of the card ribbon (deg) — a shallow V reads the fold edge-on

// Curved V-ribbon in the BAKE frame: rachis along +Y from the origin, lateral
// ±X (u 0→1 = −X→+X, matching the ortho bake camera looking down −Z), leaf-plane
// normal +Z. The ribbon bends toward −Z (gravity side) by `droop` with the same
// x^p distribution as the live rachis, so one baked picture serves every frond of
// that droop class under an instance rotation.
function frondRibbonGeometry(halfW, y0, y1, lengthRef, droop, droopPow) {
  const positions = [], uvs = [], indices = [];
  const steps = 48;
  // Integrate the bent centreline from s=0 to y1 (beyond lengthRef the bend holds).
  const pts = [new Vector3(0, 0, 0)], tans = [];
  const tanAt = (s) => {
    const b = droop * Math.pow(clamp01(s / lengthRef), droopPow);
    return new Vector3(0, Math.cos(b), -Math.sin(b));
  };
  const ds = Math.max(1e-4, y1) / steps;
  for (let i = 0; i < steps; i++) pts.push(pts[i].clone().addScaledVector(tanAt((i + 0.5) * ds), ds));
  const centreAt = (s) => {
    if (s <= 0) return new Vector3(0, s, 0);
    const x = Math.min(steps, s / ds), i = Math.min(steps - 1, Math.floor(x));
    return pts[i].clone().lerp(pts[i + 1], x - i);
  };
  const lift = CARD_V * DEG;
  for (let r = 0; r <= CARD_ROWS; r++) {
    const v = r / CARD_ROWS;
    const s = y0 + (y1 - y0) * v;
    const c = centreAt(s);
    const t = tanAt(Math.max(0, s));
    const nrm = new Vector3(0, -t.z, t.y); // ⊥ T in the YZ plane, +Z at rest
    for (const [side, u] of [[-1, 0], [0, 0.5], [1, 1]]) {
      const p = c.clone();
      if (side) p.addScaledVector(new Vector3(1, 0, 0), side * halfW * Math.cos(lift)).addScaledVector(nrm, halfW * Math.sin(lift));
      positions.push(p.x, p.y, p.z);
      uvs.push(u, v);
    }
  }
  for (let r = 0; r < CARD_ROWS; r++) {
    for (let k = 0; k < 2; k++) {
      const a = r * 3 + k, b = a + 1, d = a + 3, e = d + 1;
      indices.push(a, b, e, a, e, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.userData.shared = true; // cached with the bake; placements clone it
  return g;
}

/**
 * Bake frond cards (LOD2 / mobile rungs): one STRAIGHT exemplar frond per
 * variant (two live, one dead) rendered top-down through the multichannel baker,
 * then a family of curved V-ribbons (one per droop class) that carry the picture.
 * Caller pauses its render loop (the renderer is re-targeted).
 */
export async function bakeFrondCards(renderer, species, assets, opts = {}) {
  if (!assets.leafMat || !assets.barkMat || !species.foliage) return null;
  const cfg = { ...FROND_DEFAULTS, ...species.foliage };
  const size = Math.max(256, opts.size ?? 512);
  const centerUniform = uniform(new Vector3());
  const variants = [];
  const specs = [{ dead: false, key: 'A' }, { dead: false, key: 'B' }];
  if ((cfg.deadCount ?? 0) > 0) specs.push({ dead: true, key: 'D' });
  for (const vs of specs) {
    const lengthRef = cfg.frondLength;
    // Straight frond in the bake frame: T=+Y, lateral L=−X, so N = T×L = +Z.
    const fr = {
      base: new Vector3(0, 0, 0), axis: new Vector3(0, 1, 0), h: new Vector3(0, 0, -1),
      elev: 0, droop: 0, droopPow: 1, length: lengthRef, roll: 0, dead: vs.dead, age: 0.5,
      wBase: 0.5, key: `card${vs.key}`, id: 0,
    };
    // elev 0 → d0 = axis (+Y); L = axis × h = Y × (−Z) = −X; N = T × L = +Z.
    const layout = { fronds: [fr], bunches: [], domeOrigin: new Vector3(0, -2, 0) };
    const geo = buildCrownGeometry(layout, cfg, FROND_LOD_SPECS.LOD0);
    const group = new Group();
    if (geo.bark) group.add(new Mesh(geo.bark, assets.barkMat));
    if (geo.leaves) group.add(new Mesh(geo.leaves, assets.leafMat));
    if (!group.children.length) continue;
    const box = new Box3().setFromObject(group);
    const halfW = Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) * 1.02;
    const y0 = box.min.y - 0.01, y1 = box.max.y + 0.01;
    const cy = (y0 + y1) / 2, halfH = (y1 - y0) / 2;
    const depth = Math.max(2, box.max.z - box.min.z + 2);
    const cam = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, depth * 4);
    cam.position.set(0, cy, box.max.z + depth);
    cam.lookAt(0, cy, 0);
    let baked;
    try {
      baked = (await bakeGroupToTextures(renderer, group, [{ name: 'front', camera: cam }], { size, dilate: 8 })).front;
    } finally {
      geo.bark?.dispose(); geo.leaves?.dispose();
    }
    if (!baked) continue;
    const material = makeCardMaterial(baked, centerUniform, { noFlutter: false });
    for (const droopDeg of vs.dead ? [0, 22] : CARD_DROOP_CLASSES) {
      variants.push({
        geometry: frondRibbonGeometry(halfW, y0, y1, lengthRef, droopDeg * DEG, cfg.droopPow ?? 1.6),
        material, textures: baked, dead: vs.dead, variant: vs.key, droop: droopDeg * DEG, lengthRef,
        chordLen: lengthRef,
      });
    }
  }
  return variants.length ? { variants, centerUniform, fronds: true } : null;
}

/**
 * Place baked frond cards: one curved V-ribbon per frond (nearest droop class,
 * variant alternating by frond id), instanced per (variant, class) so the forest
 * grove can re-instance them. Fruit bunches ride along as instanced crossed quads
 * on the leaf material.
 * @returns {Group|null}
 */
export function buildFrondCardFoliage(layout, cards, opts = {}) {
  const keep = Math.max(0, Math.min(1, opts.keepFraction ?? 1));
  const fronds = layout.fronds.filter((fr) => !(opts.skipDead && fr.dead));
  // Stable nested subset by frond id (golden-ratio ranking): farther rungs keep a
  // strict subset of nearer ones.
  const ranked = fronds.map((fr) => ({ fr, score: ((fr.id + 1) * 0.6180339887498949) % 1 }))
    .sort((a, b) => a.score - b.score);
  const kept = new Set(ranked.slice(0, Math.round(fronds.length * keep)).map((e) => e.fr));
  const center = layout.domeOrigin;
  cards.centerUniform.value.copy(center);

  const buckets = new Map();
  for (const fr of fronds) {
    if (!kept.has(fr)) continue;
    const pool = cards.variants.filter((v) => v.dead === fr.dead);
    if (!pool.length) continue;
    const keys = [...new Set(pool.map((v) => v.variant))];
    const vk = keys[fr.id % keys.length];
    let best = null;
    for (const v of pool) if (v.variant === vk && (!best || Math.abs(v.droop - fr.droop) < Math.abs(best.droop - fr.droop))) best = v;
    if (!buckets.has(best)) buckets.set(best, []);
    buckets.get(best).push(fr);
  }

  const group = new Group();
  group.name = 'foliage';
  const m = new Matrix4(), q = new Quaternion(), qInv = new Quaternion(), scl = new Vector3(), wv = new Vector3();
  const basis = new Matrix4(), negL = new Vector3(), N0 = new Vector3();
  const trng = new Rng('frondcards:thickness');
  let vi = 0;
  for (const [variant, list] of buckets) {
    const geo = variant.geometry.clone();
    geo.userData = {}; // private per placement → disposed with the tree
    const n = list.length;
    const thick = new Float32Array(n);
    for (let i = 0; i < n; i++) thick[i] = 0.4 + 0.6 * trng.next();
    geo.setAttribute('aThickness', new InstancedBufferAttribute(thick, 1));
    geo.setAttribute('aWindVec', new InstancedBufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aAnchorPos', new InstancedBufferAttribute(new Float32Array(n * 3), 3));
    const im = new InstancedMesh(geo, variant.material, n);
    im.name = `frondcards${vi++}`;
    const weights = new Float32Array(n);
    list.forEach((fr, i) => {
      const cv = frondCurve(fr);
      // Card frame: local +X → −L, +Y → d0, +Z → N0 = d0 × L.
      negL.copy(cv.L).negate();
      N0.crossVectors(cv.d0, cv.L).normalize();
      basis.makeBasis(negL, cv.d0, N0);
      q.setFromRotationMatrix(basis);
      const s = fr.length / variant.lengthRef;
      scl.set(s, s, s);
      m.compose(fr.base, q, scl);
      im.setMatrixAt(i, m);
      const w = fr.wBase;
      qInv.copy(q).invert();
      wv.copy(WIND_DIR).applyQuaternion(qInv).multiplyScalar(w / s);
      geo.attributes.aWindVec.setXYZ(i, wv.x, wv.y, wv.z);
      geo.attributes.aAnchorPos.setXYZ(i, fr.base.x, fr.base.y, fr.base.z);
      weights[i] = w;
    });
    im.count = n;
    im.userData.windWeights = weights;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    // Cast (ground shadow) but do not RECEIVE: ~100 overlapping ribbons
    // self-shadow into a dark mass the mesh LODs never show (a close LOD2 preview
    // read far darker than LOD1). Far cards are flat proxies anyway.
    im.castShadow = true; im.receiveShadow = false;
    group.add(im);
  }

  // Fruit bunches: instanced crossed quads on the live leaf material.
  if (opts.bunchMaterial && layout.bunches.length && opts.atlas?.bunch && opts.bunches !== false) {
    const bunchGeo = bunchCardGeometry(opts.atlas.bunch);
    const n = layout.bunches.length;
    const thick = new Float32Array(n).fill(0.25);
    bunchGeo.setAttribute('aThickness', new InstancedBufferAttribute(thick, 1));
    bunchGeo.setAttribute('aWindVec', new InstancedBufferAttribute(new Float32Array(n * 3), 3));
    bunchGeo.setAttribute('aAnchorPos', new InstancedBufferAttribute(new Float32Array(n * 3), 3));
    const im = new InstancedMesh(bunchGeo, opts.bunchMaterial, n);
    im.name = 'bunches';
    const weights = new Float32Array(n);
    layout.bunches.forEach((b, i) => {
      q.setFromAxisAngle(UP, Math.atan2(b.h.x, b.h.z) + b.spin);
      scl.set(b.length, b.length, b.length);
      m.compose(b.top, q, scl);
      im.setMatrixAt(i, m);
      qInv.copy(q).invert();
      wv.copy(WIND_DIR).applyQuaternion(qInv).multiplyScalar(b.wBase / b.length);
      bunchGeo.attributes.aWindVec.setXYZ(i, wv.x, wv.y, wv.z);
      bunchGeo.attributes.aAnchorPos.setXYZ(i, b.top.x, b.top.y, b.top.z);
      weights[i] = b.wBase;
    });
    im.userData.windWeights = weights;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    group.add(im);
  }
  return group.children.length ? group : null;
}

// Unit crossed quads hanging DOWN from the origin (length 1), atlas-mapped.
function bunchCardGeometry(rect) {
  const [u0, v0, u1, v1] = rect;
  const hw = 0.5 * (u1 - u0) / Math.max(1e-4, v1 - v0);
  const pos = [], uv = [], nrm = [], idx = [];
  for (let k = 0; k < BUNCH_PLANES; k++) {
    const ang = (k / BUNCH_PLANES) * Math.PI, ax = Math.cos(ang), az = Math.sin(ang);
    const b = pos.length / 3;
    for (const [x, y, u, v] of [[-hw, 0, u0, v1], [hw, 0, u1, v1], [hw, -1, u1, v0], [-hw, -1, u0, v0]]) {
      pos.push(x * ax, y, x * az); uv.push(u, v); nrm.push(-az, 0.45, ax);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  { // horizontal cap card (see emitBunch)
    const b = pos.length / 3, h = hw * 0.85, y = -BUNCH_CAP_AT, vm = v0 + (v1 - v0) * 0.55;
    for (const [x, z, u, v] of [[-h, -h, u0, v0], [h, -h, u1, v0], [h, h, u1, vm], [-h, h, u0, vm]]) {
      pos.push(x, y, z); uv.push(u, v); nrm.push(0, 1, 0);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}
