"""Compatibility scoring between plant tolerance envelopes and tank water params.

Envelope = multi-axis tolerance window (temperature, pH, gH, PAR, CO2, NO3, PO4, K, Fe).
Each axis contributes a [0..1] score via a trapezoidal membership function:

    score(x) = 0                                 if x <= min or x >= max
               (x - min) / (opt_min - min)       if min <  x <  opt_min
               1                                 if opt_min <= x <= opt_max
               (max - x) / (max - opt_max)       if opt_max <  x <  max

The overall compatibility is the geometric mean of per-axis scores (so any
single limiting factor dominates — Liebig's Law of the Minimum, smoothed).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True, slots=True)
class Axis:
    min: float
    opt_min: float
    opt_max: float
    max: float

    def score(self, x: float) -> float:
        if x <= self.min or x >= self.max:
            return 0.0
        if x < self.opt_min:
            return (x - self.min) / max(self.opt_min - self.min, 1e-9)
        if x > self.opt_max:
            return (self.max - x) / max(self.max - self.opt_max, 1e-9)
        return 1.0


def compat(axes: dict[str, Axis], actuals: dict[str, float]) -> float:
    """Geometric mean of per-axis scores over the axes present in both dicts."""
    scores: list[float] = []
    for k, ax in axes.items():
        if k not in actuals:
            continue
        s = ax.score(actuals[k])
        # Clamp to tiny epsilon so geometric mean doesn't zero-out prematurely;
        # but keep true-zero semantics when strictly out-of-envelope.
        scores.append(s if s > 0 else 1e-3)
    if not scores:
        return 1.0
    return float(np.exp(np.mean(np.log(scores))))
