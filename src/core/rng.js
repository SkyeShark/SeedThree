// Deterministic seeded RNG for reproducible generation.
//
// Pattern (per research): hash a string seed with xmur3 to derive a 32-bit state
// word, then run splitmix32 as the generator. splitmix32 is full-period and does
// NOT have mulberry32's flaw of skipping ~1/3 of 32-bit outputs.
//
// Thread ONE Rng instance through an entire tree generation, drawing in a fixed
// traversal order (parent before children), so a given (species, seed) always
// reproduces the same tree even as new features are added later.

// xmur3: string -> 32-bit seed generator (MurmurHash3-style mixing).
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export class Rng {
  /** @param {string|number} seed */
  constructor(seed) {
    const seedStr = typeof seed === 'number' ? `n:${seed}` : String(seed);
    this._state = xmur3(seedStr)() >>> 0;
  }

  /** Uniform float in [0, 1). splitmix32. */
  next() {
    let z = (this._state = (this._state + 0x9e3779b9) | 0);
    z ^= z >>> 16; z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15; z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return (z >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min, max) {
    return min + (max - min) * this.next();
  }

  /** Symmetric variation: base ± spread (spread is the half-range). */
  vary(base, spread) {
    return base + (this.next() * 2 - 1) * spread;
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }

  /** Pick a random element from an array. */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}
