/**
 * Port of `aquascape_sim/algo/envelope.py`.
 *
 * Trapezoidal per-axis membership + geometric-mean compatibility
 * (Liebig's law of the minimum, smoothed).
 */

export class Axis {
  readonly min: number;
  readonly optMin: number;
  readonly optMax: number;
  readonly max: number;

  constructor(min: number, optMin: number, optMax: number, max: number) {
    this.min = min;
    this.optMin = optMin;
    this.optMax = optMax;
    this.max = max;
  }

  score(x: number): number {
    if (x <= this.min || x >= this.max) return 0.0;
    if (x < this.optMin) return (x - this.min) / Math.max(this.optMin - this.min, 1e-9);
    if (x > this.optMax) return (this.max - x) / Math.max(this.max - this.optMax, 1e-9);
    return 1.0;
  }
}

/**
 * Sum matching numpy's pairwise summation (`pairwise_sum`) for n ≤ 128,
 * which is what `np.mean` uses on a contiguous float64 array. Keeps parity
 * with the Python engine bit-for-bit in the common case.
 */
export function npSum(a: readonly number[]): number {
  const n = a.length;
  if (n < 8) {
    let res = 0.0;
    for (let i = 0; i < n; i++) res += a[i];
    return res;
  }
  if (n <= 128) {
    const r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      for (let j = 0; j < 8; j++) r[j] += a[i + j];
    }
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[i];
    return res;
  }
  const n2 = Math.floor(n / 2);
  const half = n2 - (n2 % 8);
  return npSum(a.slice(0, half)) + npSum(a.slice(half));
}

/** Geometric mean of per-axis scores over the axes present in both maps. */
export function compat(axes: Record<string, Axis>, actuals: Record<string, number>): number {
  const logs: number[] = [];
  for (const k of Object.keys(axes)) {
    if (!Object.prototype.hasOwnProperty.call(actuals, k)) continue;
    const s = axes[k].score(actuals[k]);
    // Clamp to tiny epsilon so the geometric mean doesn't zero-out prematurely.
    logs.push(Math.log(s > 0 ? s : 1e-3));
  }
  if (logs.length === 0) return 1.0;
  return Math.exp(npSum(logs) / logs.length);
}
