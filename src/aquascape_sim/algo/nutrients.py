"""Nutrient draw-down per tick.

Dissolved N/P/K/Fe decrease as plants grow. Dosing & water changes replenish.
This module owns the reservoir math only; per-plant uptake is in tick.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class Reservoir:
    """Dissolved nutrient concentrations in mg/L."""

    no3: float = 10.0
    po4: float = 1.0
    k: float = 10.0
    fe: float = 0.1

    # Dosing schedule: mg/L added per day (constant for phase 1).
    dose_no3: float = 0.0
    dose_po4: float = 0.0
    dose_k: float = 0.0
    dose_fe: float = 0.0

    # Per-day passive losses (filter, bio-denitrification).
    decay_no3: float = 0.05
    decay_po4: float = 0.02
    decay_k: float = 0.0
    decay_fe: float = 0.2  # iron oxidizes fast

    def apply_daily(self, uptake: "Uptake") -> None:
        self.no3 = max(0.0, self.no3 + self.dose_no3 - self.decay_no3 - uptake.no3)
        self.po4 = max(0.0, self.po4 + self.dose_po4 - self.decay_po4 - uptake.po4)
        self.k = max(0.0, self.k + self.dose_k - self.decay_k - uptake.k)
        self.fe = max(0.0, self.fe + self.dose_fe - self.decay_fe - uptake.fe)


@dataclass(slots=True)
class Uptake:
    no3: float = 0.0
    po4: float = 0.0
    k: float = 0.0
    fe: float = 0.0
