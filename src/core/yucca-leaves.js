// Yucca/Joshua-tree rosette foliage.
//
// CONSTRUCTION (from the user's own model):
//   TEXTURE (Codex): a CIRCLE of individual spike-leaf blades meeting at a
//   single point in the center, radiating out 360°, with transparent alpha
//   between the blades.
//   GEOMETRY: that circle is projected (planar, down the axis) onto STRAIGHT
//   tapered cone SHELLS — apex = the texture's center point, rim = the blade
//   tips. No spherical bend: each cone is straight-sided. A rosette = several
//   nested cones sharing one tip center, from a tight upward cone through a
//   near-flat disc to inverted downward cones (the hanging dead skirt). The
//   alpha cuts the cone into the individual blades.
//
// Age (green tip cones → brown flat cones → gray inverted skirt) is a per-
// instance attribute driving the color ramp; the map itself is one green
// blade-circle.

import {
  BufferGeometry, BufferAttribute, InstancedBufferAttribute, InstancedMesh,
  MeshSSSNodeMaterial, Group, Matrix4, Quaternion, Vector3, Color, DoubleSide, DynamicDrawUsage,
} from 'three/webgpu';
import { texture, uv, attribute, mix, vec3, vec4, uniform, dot, float } from 'three/tsl';
import { rosetteWindPosition, WIND_DIR } from './wind.js';

const Y = new Vector3(0, 1, 0);
const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // 137.5° — the phyllotaxis spiral step

// A STRAIGHT tapered cone shell. Apex at the arm tip (texture center), flaring
// straight out to a rim at half-angle `open`. open<90 = upward cone, 90 = flat
// disc, >90 = inverted (downward) cone. Planar radial UV: texture center →
// apex, texture rim → cone rim, so each radial blade maps to one cone meridian.
const hash1 = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
const ss01 = (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function coneGeometry({ open = 60, bend = 0, radialSegs = 12, lengthSegs = 3, waviness = 0.30 } = {}) {
  const positions = [], uvs = [], indices = [];
  // uvR = 0.5 samples from the sprite CENTER out to its full edge, so however
  // long the painted spikes are, the whole spike (tip included) maps from cone
  // apex to rim — no truncated tips.
  const collarR = 0.015, uvR = 0.5;
  const openR = (open * Math.PI) / 180, bendR = (bend * Math.PI) / 180;
  // Centerline integrated ring-by-ring: the flare angle grows by `bend` along
  // the length, so bend>0 CURVES the cone (skirt cones curve down to hug the
  // trunk). bend=0 reproduces the straight cone exactly.
  const rr = [collarR], hh = [0];
  for (let i = 1; i <= lengthSegs; i++) {
    const ai = openR + bendR * ((i - 0.5) / lengthSegs);
    const dt = 1 / lengthSegs;
    rr.push(rr[i - 1] + Math.sin(ai) * dt);
    hh.push(hh[i - 1] + Math.cos(ai) * dt);
  }
  for (let i = 0; i <= lengthSegs; i++) {
    const t = i / lengthSegs;
    for (let j = 0; j <= radialSegs; j++) {
      const az = (j / radialSegs) * Math.PI * 2;
      // subtle chaos on the local Y of the edge (rim) vertices → frond tips
      // undulate (wavy / less aligned). Grows toward the rim (t²); the wrap
      // vertex (j==radialSegs) shares j==0's jitter so the seam stays shut.
      const jw = j % radialSegs;
      const y = hh[i] + (hash1(jw * 3.17 + open * 0.7) - 0.5) * waviness * t * t;
      positions.push(Math.cos(az) * rr[i], y, Math.sin(az) * rr[i]);
      uvs.push(0.5 + Math.cos(az) * uvR * t, 0.5 + Math.sin(az) * uvR * t);
    }
  }
  const cols = radialSegs + 1;
  for (let i = 0; i < lengthSegs; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const p = i * cols + j;
      indices.push(p, p + cols, p + 1, p + 1, p + cols, p + cols + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// GREEN crown — a DENSE nested ball, mostly vertical/out, with the last couple
// pointed slightly DOWN so the green fills the band above the skirt (no bare gap).
const CROWN = [
  { open: 14,  bend: 0,  lseg: 3, lenMul: 0.70, age: 0.05 },
  { open: 30,  bend: 0,  lseg: 3, lenMul: 0.90, age: 0.11 },
  { open: 46,  bend: 0,  lseg: 3, lenMul: 1.00, age: 0.17 },
  { open: 54,  bend: 2,  lseg: 3, lenMul: 1.00, age: 0.20 }, // fills the mid-crown gap
  { open: 62,  bend: 6,  lseg: 4, lenMul: 1.00, age: 0.23 },
  { open: 78,  bend: 0,  lseg: 3, lenMul: 1.00, age: 0.29 },
  { open: 90,  bend: 0,  lseg: 3, lenMul: 1.00, age: 0.32 }, // FLAT disc at the up→down switch — only the undulation wave, no curl
  { open: 92,  bend: 8,  lseg: 4, lenMul: 1.00, age: 0.35 }, // flat/out
  { open: 106, bend: 14, lseg: 4, lenMul: 1.00, age: 0.40 }, // slightly down, still GREEN — fills the gap
  { open: 120, bend: 22, lseg: 4, lenMul: 0.98, age: 0.45 }, // more down, green→transition
];
// DRY skirt — a SMOOTH gradient of bands (no puffy step): open + bend + length
// interpolate continuously, so the drape tightens toward the trunk gradually.
const SKIRT_BANDS = 8;
const SKIRT = Array.from({ length: SKIRT_BANDS }, (_, b) => {
  const f = b / (SKIRT_BANDS - 1);
  // MODERATE downward spread (132°→158°): the spikes hang down-and-out so they
  // clear the arm and stay visible, tightening a bit lower down. (Too tight,
  // >160°, collapses the radial spread below the arm radius → spikes hide
  // inside the tube.)
  // Moderate downward curl (bend 20°→54°). (Cranking bend higher curled the lowest
  // cones back INTO the bark — the flush "thatch" look is better achieved by the
  // rail-frame fix that hugs the true surface than by over-bending here.)
  return { open: 132 + 26 * f, bend: 20 + 34 * f, lseg: 4 + Math.round(f), skirt: true };
});
const CROWN_N = CROWN.length;
const CONES = [...CROWN, ...SKIRT];
const CONE_CACHE = {};
// radialSegs is the dominant LOD lever for a rosette (each cone is
// radialSegs·lengthSegs·2 tris and rosettes are ~93% of a Joshua's triangles), so
// coarser cones at far LODs are how the dichotomous path hits its triangle budget.
function coneGeo(i, rseg = 12) {
  const key = `${i}:${rseg}`;
  if (!CONE_CACHE[key]) CONE_CACHE[key] = coneGeometry({ open: CONES[i].open, bend: CONES[i].bend, radialSegs: rseg, lengthSegs: CONES[i].lseg });
  return CONE_CACHE[key];
}
// |local-Y span| of a cone (0 at apex → most-negative at the rim), in unscaled
// units — how far the rim hangs below the apex before the len·yScale scale.
// Used to bound a skirt cone's WORLD hang so it can't drape past its own base.
const CONE_YMIN = [];
function coneYMin(i) {
  if (CONE_YMIN[i] === undefined) {
    const { open, bend, lseg } = CONES[i];
    const openR = (open * Math.PI) / 180, bendR = (bend * Math.PI) / 180, n = lseg;
    let h = 0, hmin = 0;
    for (let k = 1; k <= n; k++) { h += Math.cos(openR + bendR * ((k - 0.5) / n)) / n; hmin = Math.min(hmin, h); }
    CONE_YMIN[i] = Math.max(0.05, Math.abs(hmin));
  }
  return CONE_YMIN[i];
}

const DEFAULTS = {
  leafLen: 0.6,        // rosette radius (m)
  leafLenVar: 0.12,
  thatchStep: 0.14,    // sparse gray drape spacing on older arms
  density: 1,          // LOD dial: fraction kept
};

// Thick succulent blades: translucency deliberately VERY dim.
export function makeYuccaMaterial(assets) {
  const mat = new MeshSSSNodeMaterial({
    map: assets.leafTexture ?? null,
    color: assets.leafTexture ? 0xffffff : 0x5a7a3f,
    roughness: 0.82, metalness: 0, side: DoubleSide,
    alphaTest: assets.leafTexture ? 0.4 : 0, transparent: false,
  });
  if (assets.leafNormal) mat.normalMap = assets.leafNormal;   // shape shared by green+dry
  if (assets.leafRoughness) { mat.roughnessMap = assets.leafRoughness; mat.roughness = 1.0; }
  // aPack = (apexWindWeight, rimWindWeight, age, thickness) — packed to stay
  // within WebGPU's 8-vertex-buffer limit (see rosetteWindPosition).
  const pack = attribute('aPack', 'vec4');
  const age = pack.z;
  // Per-age-stage frond tints (green / dry / dryest) + a global dryness that
  // pushes the whole plant toward the dry/dryest end of the age ramp. All are
  // uniforms so the GUI pickers apply live; defaults are white / 0 (no change).
  // Tints are held in LINEAR space (applyMaterialTweaks converts), so multiplying
  // the linearized albedo is colour-correct.
  const greenTint = uniform(new Color(0xffffff));
  const dryTint = uniform(new Color(0xffffff));
  const dryestTint = uniform(new Color(0xffffff));
  const dryness = uniform(0);
  if (assets.leafTexture) {
    const green = texture(assets.leafTexture);
    // `age` here = DISTANCE FROM THE NEAREST GREEN ROSETTE TOP (set per skirt cone
    // in buildYuccaFoliage), NOT height down a branch — so a branch with no green
    // crown of its own reads fully dry. Ramp: crown stays green (age<0.42) →
    // DRY near green → DRIEST far from any green. Dryness shifts the ramp toward 1.
    const age2 = mix(age, float(1), dryness);
    // Tint each stage BEFORE blending so each age texture recolours independently.
    let rgb = green.rgb.mul(greenTint);
    let alpha = green.a;
    if (assets.leafDryTexture) {
      const d = texture(assets.leafDryTexture); const t = age2.smoothstep(0.42, 0.6);
      rgb = mix(rgb, d.rgb.mul(dryTint), t); alpha = mix(alpha, d.a, t);
    }
    if (assets.leafDryestTexture) {
      const d = texture(assets.leafDryestTexture); const t = age2.smoothstep(0.6, 0.92);
      rgb = mix(rgb, d.rgb.mul(dryestTint), t); alpha = mix(alpha, d.a, t);
    }
    // Fallback ONLY when no driest texture is supplied: fade the far skirt toward
    // the bark color (dead leaves compacting into the trunk skin).
    if (assets.leafDryTexture && !assets.leafDryestTexture) {
      const barkCol = uniform(new Color().setRGB(0.254, 0.184, 0.130)); // joshua bark linear mean
      const barkLum = 0.2;
      const lum = dot(rgb, vec3(0.299, 0.587, 0.114));
      const barkTinted = barkCol.mul(lum.div(barkLum).clamp(0.45, 1.7));
      rgb = mix(rgb, barkTinted, age2.smoothstep(0.72, 0.97).mul(0.8));
    }
    mat.colorNode = vec4(rgb, alpha);
  }
  // Backlit transmission — VERY dim (thick succulent blades). Uses the user's
  // translucency map when present (how Joshua fronds actually respond backlit),
  // else a flat warm-green transmit.
  const transmit = uniform(new Color().setRGB(0.10, 0.13, 0.03));
  const tThick = pack.w.mul(0.5).add(0.5);
  mat.thicknessColorNode = assets.leafTranslucency
    ? transmit.mul(texture(assets.leafTranslucency).r).mul(tThick)
    : transmit.mul(tThick);
  mat.thicknessDistortionNode = uniform(0.2);
  mat.thicknessAmbientNode = uniform(0.03);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(8.0);
  mat.thicknessScaleNode = uniform(1.2);
  mat.positionNode = rosetteWindPosition();
  return { material: mat, greenTint, dryTint, dryestTint, dryness };
}

function frameAt(stem, back, out) {
  const pts = stem.points, oris = stem.orients;
  let total = 0; const segLen = [];
  for (let i = 0; i < pts.length - 1; i++) { const l = pts[i].distanceTo(pts[i + 1]); segLen.push(l); total += l; }
  let rem = total - back, si = 0;
  while (si < segLen.length - 1 && rem > segLen[si]) { rem -= segLen[si]; si++; }
  const st = Math.max(0, Math.min(1, segLen[si] > 0 ? rem / segLen[si] : 0));
  out.pos.copy(pts[si]).lerp(pts[si + 1], st);
  out.quat.copy(oris[si]).slerp(oris[si + 1], st);
  out.wind = stem.winds ? stem.winds[si] * (1 - st) + stem.winds[si + 1] * st : 0.5;
  out.radius = stem.radii ? stem.radii[si] * (1 - st) + stem.radii[si + 1] * st : 0.1;
  out.total = total;
  return out;
}

/**
 * @param {Array} terminalStems  arms carrying a rosette at each tip
 * @param {Array} [allStems]     full skeleton — older arms get a sparse gray drape
 * @returns {Group} one InstancedMesh per cone layer (userData.shareMaterial)
 */
export function buildYuccaFoliage(terminalStems, cfg, rng, material, allStems = null, reuseGroup = null) {
  const c = { ...DEFAULTS, ...cfg };
  if (!terminalStems.length) {
    if (reuseGroup) { (reuseGroup.userData.coneMeshes || []).forEach((mm) => { if (mm) mm.count = 0; }); return reuseGroup; }
    return null;
  }
  const slots = CONES.map(() => []);
  const rp = { pos: new Vector3(), quat: new Quaternion(), wind: 0.5, total: 0 };
  const q = new Quaternion(), qRoll = new Quaternion(), _shift = new Vector3();
  const _chord = new Vector3(), _qAim = new Quaternion();
  // Heuristic learned from the user's in-scene edits (skirt-editor.js): across
  // low AND high arms they consistently dragged skirt cones ~5–7 cm UP the branch
  // toward the tip (the drape reads as sitting too low). Shift each cone up its
  // own tangent by this much.
  const SKIRT_UPSHIFT = 0.06;

  const rpTail = { pos: new Vector3(), quat: new Quaternion(), wind: 0.5, total: 0, radius: 0.1 };
  const emit = (ci, pos, quat, wind, len, age, spin = 0, yScale = 1, windTail = null, rollJit = Math.PI * 2) => {
    // `spin` (a deterministic base roll) + a random jitter of width `rollJit`.
    // CROWN cones pass a golden-angle-stepped spin with a SMALL rollJit so their
    // blade circles interleave in a true non-overlapping phyllotaxis spiral; the
    // SKIRT keeps the full-random default (2π) for natural drape variety.
    // yScale compresses ONLY the vertical (hang) axis — radial spread is kept.
    qRoll.setFromAxisAngle(Y, spin + rng.range(0, rollJit));
    q.copy(quat).multiply(qRoll);
    // windTail = branch wind weight at the branch point the cone RIM hangs over
    // (down the drape). Crown cones don't drape → tail == head (no taper).
    slots[ci].push({ pos: pos.clone(), quat: q.clone(), len, yScale, wind, windTail: windTail ?? wind, age: Math.max(0, Math.min(1, age)) });
  };

  // Canopy top — reference for the skirt's height-based color ramp.
  let maxY = -1e9;
  for (const s of terminalStems) maxY = Math.max(maxY, s.points[s.points.length - 1].y);
  const baseY = 0;

  // GREEN rosette ball at each terminal tip (dense nested crown cones). Record
  // each green top so the skirt can dry by DISTANCE FROM GREEN (not by height) —
  // arms with no green crown of their own then read fully dry, as they should.
  const greenTops = [];
  // Two interleaved copies of each crown layer (each emit() takes an independent
  // random roll) → double the blade density so the alpha gaps between spikes
  // fill in and the branch tip / cone geometry underneath stops showing. LOD1/2
  // (density < 1) keep a single copy for polys.
  const crownCopies = (c.density ?? 1) >= 1 ? 2 : 1;
  for (const stem of terminalStems) {
    frameAt(stem, 0.02, rp);
    greenTops.push(rp.pos.clone());
    for (let ci = 0; ci < CROWN_N; ci++) {
      const lm = CONES[ci].lenMul, ag = CONES[ci].age;
      for (let d = 0; d < crownCopies; d++) {
        // golden-angle spiral: each successive crown layer (and the 2nd interleaved
        // copy) is offset by 137.5° so blades pack without overlapping, + a small
        // jitter so it doesn't read mechanically perfect.
        emit(ci, rp.pos, rp.quat, rp.wind,
          c.leafLen * lm * (1 + rng.vary(0, c.leafLenVar)),
          ag + rng.vary(0, 0.04), ci * GOLDEN + d * GOLDEN * 0.5, 1, null, 0.5);
      }
    }
  }
  // distance (m) from a point to the NEAREST green rosette top.
  const DRY_SPAN = 1.8; // metres from green → fully driest
  const distToGreen = (p) => {
    let best = Infinity;
    for (const g of greenTops) { const d = g.distanceToSquared(p); if (d < best) best = d; }
    return greenTops.length ? Math.sqrt(best) : DRY_SPAN;
  };
  // map distance → skirt "age" (color ramp input): near green ≈ 0.42 (just dry),
  // DRY_SPAN away ≈ 1.0 (driest). Crown cones keep their own small ages (green).
  const dryAge = (p) => 0.42 + 0.58 * Math.min(1, distToGreen(p) / DRY_SPAN);
  // DEAD-LEAF SKIRT: downward-hanging cones (index 5) draping DOWN every arm
  // (and the trunk's upper reaches). Color ramps by world height — brown-yellow
  // just under the green rosette → gray/bark toward the base (dead leaves
  // compacting into "bark").
  const skirtStems = allStems ?? terminalStems;
  const step = c.thatchStep ?? 0.12;
  // BABY / new-growth tree: the plant hasn't forked yet, so the trunk IS the
  // whole visible plant (every crown sits on a level-0 stem, no arms). In that
  // one case the trunk carries skirt on its top & middle, fading out before a
  // bare base — like a young Joshua. (A mature tree's lower trunk stays bare.)
  const babyTree = terminalStems.length > 0 && terminalStems.every((s) => s.level === 0);
  const babyBareY = maxY * 0.35; // bottom fraction of a baby trunk stays bare bark
  for (const stem of skirtStems) {
    // A FORKING trunk (level 0 that split into ≥2 arms) carries skirt on its TOP
    // only, to fill the crotch center; the lower trunk stays bare bark. Every
    // other level-0 run stays bare — EXCEPT a baby tree's trunk (handled below).
    const isTrunk = stem.level === 0;
    const trunkFork = isTrunk && stem.children && stem.children.length >= 2;
    if (isTrunk && !trunkFork && !babyTree) continue; // bare lower trunk shows bark
    frameAt(stem, 0, rp);
    const total = rp.total;
    // Where this stem's skirt starts (distance back from its tip):
    //  • terminal arm → 0.12 (just under the green crown).
    //  • CONTINUATION parent (one child of the SAME level) → 0.12 too: its tip is a
    //    smooth segment junction that the continuing child already drapes down over,
    //    so starting a cone AT the tip would stack a SECOND center-point there — the
    //    doubled frond-centre that a hard veer pulls apart and exposes. Skip it.
    //  • FORK parent → 0.0: the diverging arms leave the crotch bare, so cover it.
    const isContPar = stem.children && stem.children.length === 1 && stem.children[0].level === stem.level;
    const start = (stem.terminal || isContPar) ? 0.12 : 0.0;
    // trunk-fork: only the top ~0.45 m (near the crotch) is skirted.
    const end = trunkFork ? Math.min(total * 0.99, 0.45) : total * 0.99;
    for (let back = start; back < end; back += step) {
      if (c.density < 1 && rng.next() > c.density) continue;
      frameAt(stem, back, rp);
      // shift the anchor up its own branch tangent (learned heuristic — see above),
      // with EXTRA lift for the topmost cones (the "cap" just under the green
      // crown of a terminal arm — the user snugged these up); fades over the
      // first ~0.25 m of drape.
      _shift.set(0, 1, 0).applyQuaternion(rp.quat);
      // cap lift for the topmost cones of EVERY arm — terminal (under the crown)
      // AND non-terminal (under the fork). The old `stem.terminal` gate skipped
      // non-terminal arms, so the user kept re-lifting those caps by hand.
      const capBoost = Math.max(0, 1 - (back - start) / 0.25) * 0.07;
      rp.pos.addScaledVector(_shift, SKIRT_UPSHIFT + capBoost);
      // baby-tree trunk: keep the lowest stretch bare (young Joshuas are bare-
      // trunked at the bottom, skirted up top).
      if (babyTree && isTrunk && rp.pos.y < babyBareY) continue;
      const downFrac = Math.max(0, Math.min(1, (maxY - rp.pos.y) / Math.max(0.6, maxY - baseY)));
      // pick the skirt band smoothly across the 8-band gradient (no puffy step)
      const band = Math.min(SKIRT_BANDS - 1, Math.floor(downFrac * SKIRT_BANDS));
      const bandOpen = CONES[CROWN_N + band].open * Math.PI / 180;
      const sinO = Math.max(0.35, Math.sin(bandOpen));
      // radial length (puff) scales with DEPTH: tight up high (the straight upper
      // arms were over-puffed) → fuller toward the crotch, where the drape needs
      // to reach around the concave inner face. Combined with the deeper skirt
      // BEND (bands curl more), the low cones wrap the trough instead of bridging.
      const len = Math.max(c.leafLen * 0.72, (rp.radius + 0.14 + 0.26 * downFrac) / sinO) * (1 + rng.vary(0, c.leafLenVar));
      // HANG CAP (replaces the old ss01 taper, which shrank the lowest cones to
      // nothing and BARED the inner crotch). At a FORK the branch kinks away
      // below the base: a cone that hangs PAST its base spears the trunk, one
      // that stops short bares the inner trough. So let the hang reach DOWN TO —
      // but not past — the base. A continuation run flows smoothly into its
      // parent → full drape (no cap). A forking trunk gets a modest fixed drape
      // (~0.4 m) so it fills the crotch without dangling down the bare trunk.
      // Trunk crotch-fill: keep the cone MODERATE-width so its capped hang stays
      // full-height (a huge width + fixed hang = a flat pancake — the exact
      // "not puffed" look at the centre). Arms keep the depth-scaled width.
      const coneLen = (isTrunk && trunkFork) ? Math.min(len, c.leafLen * 0.7) : len;
      const yMin = coneYMin(CROWN_N + band);
      const armLeft = total - back;
      let yScale = 1;
      // NO per-base taper on arms/continuations anymore. The old armLeft cap (make the
      // hang stop AT the base) shaved EVERY stem's base, which — combined with the next
      // stem starting below its own tip — is what left the SEGMENT JUNCTIONS and FORK
      // CROTCHES bare. It existed to stop a long drape spearing past the base, but the
      // realistic-length cap below already bounds every cone to ~¼ m, so a base cone can
      // only drape that short distance into the junction/crotch — which FILLS it instead
      // of baring it. The trunk keeps its special caps (bare lower trunk / baby).
      if (trunkFork) yScale = Math.min(1, 0.5 / (yMin * coneLen)); // forking trunk crotch fill
      if (babyTree && isTrunk) yScale = Math.min(yScale, Math.max(0, rp.pos.y - babyBareY) / (yMin * coneLen));
      // Cap the drape to a realistic dead-leaf length (~½ the rosette radius) so no
      // single cone's STRAIGHT hang spans the branch's CURVE. A long drape on a
      // curving/thick lowest arm cuts straight through the tube where the branch
      // bends away beneath it — the "skirt clips through the segment, wrong shape"
      // bug. The dense thatchStep overlap builds the continuous sleeve that follows
      // the bend instead (applied AFTER the base-overhang drop so it never forces one).
      yScale = Math.min(yScale, (c.leafLen * 0.5) / (yMin * coneLen));
      // tail weight: the branch's wind weight one drape-length further toward the
      // base (increasing `back`), so the cone's rim sways to match the bark it
      // hangs over instead of riding the anchor's full throw.
      const drapeM = yMin * coneLen * yScale;
      frameAt(stem, Math.min(total * 0.999, back + drapeM), rpTail);
      // Aim the cone down the branch's CHORD (anchor → drape-end point) instead of
      // the anchor tangent, so on a curving/continuation branch the drape FOLLOWS
      // the bend rather than flinging off the straight tangent — worst where a
      // continuation curves OPPOSITE the previous section. Straight branch:
      // chord == tangent, so nothing changes.
      _chord.subVectors(rp.pos, rpTail.pos);
      const qAim = _chord.lengthSq() > 1e-6 ? _qAim.setFromUnitVectors(Y, _chord.normalize()) : rp.quat;
      emit(CROWN_N + band, rp.pos, qAim, rp.wind, coneLen,
        dryAge(rp.pos) + rng.vary(0, 0.03), // dry by DISTANCE FROM GREEN, not height
        back * 4.0, yScale, rpTail.wind); // progressive roll + vertical hang taper + drape-end weight
    }
  }

  // FORK-KNUCKLE skirt: ONE NORMAL skirt cone per internal fork (children ≥ 2),
  // covering the bare bark joint. A skirt cone hangs BELOW its apex, so instead
  // of flaring a fat cone AT the joint (reads as a puffed disc), the cone is
  // placed ABOVE the joint and drapes DOWN over it — same shape as the rest.
  const _tan = new Vector3(), _kpos = new Vector3();
  for (const stem of skirtStems) {
    if (stem.level < 1 || !stem.children || stem.children.length < 2) continue;
    frameAt(stem, 0, rp);
    if (rp.total < 0.12) continue;
    _tan.set(0, 1, 0).applyQuaternion(rp.quat);         // branch tangent (toward the tip/fork)
    _kpos.copy(rp.pos).addScaledVector(_tan, 0.15);      // MOVE the cone UP over the joint
    const downFrac = Math.max(0, Math.min(1, (maxY - rp.pos.y) / Math.max(0.6, maxY - baseY)));
    const band = Math.min(SKIRT_BANDS - 1, Math.floor(downFrac * SKIRT_BANDS));
    const sinO = Math.max(0.35, Math.sin(CONES[CROWN_N + band].open * Math.PI / 180));
    const len = Math.max(c.leafLen * 0.62, (rp.radius + 0.22) / sinO) * (1 + rng.vary(0, c.leafLenVar));
    const drapeM = 0.8 * len;
    frameAt(stem, Math.min(rp.total * 0.999, drapeM), rpTail); // knuckle anchor is at back≈0 (the fork)
    emit(CROWN_N + band, _kpos, rp.quat, rp.wind, len,
      dryAge(_kpos) + rng.vary(0, 0.03), 2.1, 1, rpTail.wind); // dry by distance from green
  }

  // Persistent per-cone-type InstancedMeshes, REUSED across rebuilds (reuseGroup):
  // same mesh objects, buffers WRITTEN IN PLACE (setMatrixAt + array writes +
  // needsUpdate — never swap the instanceMatrix/attribute OBJECTS, which doesn't
  // re-bind in WebGPU) so the heavy SSS pipeline never recompiles (the freeze).
  // Instance buffers are pre-allocated to CAP so a growing tree never reallocates.
  const CAP = 1024;
  const group = reuseGroup ?? new Group();
  if (!reuseGroup) group.name = 'foliage';
  const coneMeshes = group.userData.coneMeshes ?? (group.userData.coneMeshes = []);
  const coneRSeg = Math.max(3, Math.round(c.coneRadialSegs ?? 12)); // per-LOD cone resolution
  const m = new Matrix4(), scl = new Vector3(), qInv = new Quaternion(), wv = new Vector3(), tanL = new Vector3();
  for (let ci = 0; ci < CONES.length; ci++) {
    const list = slots[ci];
    const n = Math.min(list.length, CAP);
    let mesh = coneMeshes[ci];
    if (n === 0) { if (mesh) mesh.count = 0; continue; }
    if (!mesh) {
      const geo = coneGeo(ci, coneRSeg).clone();
      // aPack = (apexWeight, rimWeight, age, thickness); aTanSpan = (branch tangent
      // .xyz tree-space, drape scale len·yScale .w). 8-vertex-buffer WebGPU cap.
      geo.setAttribute('aWindVec', new InstancedBufferAttribute(new Float32Array(CAP * 3), 3));
      geo.setAttribute('aAnchorPos', new InstancedBufferAttribute(new Float32Array(CAP * 3), 3));
      geo.setAttribute('aPack', new InstancedBufferAttribute(new Float32Array(CAP * 4), 4));
      geo.setAttribute('aTanSpan', new InstancedBufferAttribute(new Float32Array(CAP * 4), 4));
      mesh = new InstancedMesh(geo, material, CAP);
      mesh.name = `cone${ci}`;
      mesh.userData.shareMaterial = true;
      mesh.userData.coneRSeg = coneRSeg;
      mesh.castShadow = true; mesh.receiveShadow = true;
      coneMeshes[ci] = mesh;
      group.add(mesh);
    } else if (mesh.userData.coneRSeg !== coneRSeg) {
      // Cone DETAIL (meshQuality / cone-detail slider) changed on a live reuse: swap in
      // the new-resolution base geometry (per-vertex position/uv/normal/index only). The
      // CAP-sized instanced attrs are resolution-independent and stay. Same attribute
      // layout → same pipeline, so it re-uploads buffers without the recompile freeze.
      const src = coneGeo(ci, coneRSeg);
      mesh.geometry.setAttribute('position', src.getAttribute('position').clone());
      mesh.geometry.setAttribute('uv', src.getAttribute('uv').clone());
      mesh.geometry.setAttribute('normal', src.getAttribute('normal').clone());
      mesh.geometry.setIndex(src.getIndex().clone());
      mesh.userData.coneRSeg = coneRSeg;
    }
    const geo = mesh.geometry;
    const windVec = geo.getAttribute('aWindVec').array;
    const anchorPos = geo.getAttribute('aAnchorPos').array;
    const pack = geo.getAttribute('aPack').array;
    const tanSpan = geo.getAttribute('aTanSpan').array;
    const weights = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      const ys = s.yScale ?? 1;
      scl.set(s.len, s.len * ys, s.len); // non-uniform: compress hang, keep radial
      m.compose(s.pos, s.quat, scl);
      mesh.setMatrixAt(i, m); // writes into the EXISTING instanceMatrix buffer (no swap)
      // aWindVec = R⁻¹ S⁻¹ WIND_DIR — DIRECTION ONLY (weight + phase walk in shader).
      qInv.copy(s.quat).invert();
      wv.copy(WIND_DIR).applyQuaternion(qInv);
      wv.x /= s.len; wv.y /= (s.len * ys); wv.z /= s.len;
      windVec[i * 3] = wv.x; windVec[i * 3 + 1] = wv.y; windVec[i * 3 + 2] = wv.z;
      anchorPos[i * 3] = s.pos.x; anchorPos[i * 3 + 1] = s.pos.y; anchorPos[i * 3 + 2] = s.pos.z;
      tanL.set(0, 1, 0).applyQuaternion(s.quat); // branch tangent = cone local +Y under its quat
      const thickness = s.age > 0.6 ? 0.3 + 0.25 * rng.next() : 0.08 + 0.1 * rng.next();
      pack[i * 4] = s.wind; pack[i * 4 + 1] = s.windTail ?? s.wind; pack[i * 4 + 2] = s.age; pack[i * 4 + 3] = thickness;
      tanSpan[i * 4] = tanL.x; tanSpan[i * 4 + 1] = tanL.y; tanSpan[i * 4 + 2] = tanL.z; tanSpan[i * 4 + 3] = s.len * ys;
      weights[i] = s.wind;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    geo.getAttribute('aWindVec').needsUpdate = true;
    geo.getAttribute('aAnchorPos').needsUpdate = true;
    geo.getAttribute('aPack').needsUpdate = true;
    geo.getAttribute('aTanSpan').needsUpdate = true;
    mesh.userData.windWeights = weights;
    mesh.computeBoundingSphere();
  }
  return reuseGroup || group.children.length ? group : null;
}
