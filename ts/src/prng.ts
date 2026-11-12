/**
 * Deterministic PRNG (sfc32 seeded via splitmix32). Pure 32-bit integer
 * arithmetic ⇒ identical sequences on every JS engine for the same seed.
 */

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export interface Prng {
  /** uniform float in [0, 1) with 32 bits of entropy */
  next(): number;
  /** uniform uint32 */
  nextU32(): number;
  /** uniform float in [lo, hi) */
  range(lo: number, hi: number): number;
}

export function createPrng(seed: number): Prng {
  const init = splitmix32(Number.isFinite(seed) ? Math.trunc(seed) : 0);
  let a = init();
  let b = init();
  let c = init();
  let d = init();
  const nextU32 = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) nextU32();
  const next = (): number => nextU32() / 4294967296;
  return { next, nextU32, range: (lo, hi) => lo + (hi - lo) * next() };
}
