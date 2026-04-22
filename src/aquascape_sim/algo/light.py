"""Canopy PAR attenuation.

Light reaching a plant depends on:
  - surface PAR (from fixture + schedule),
  - depth (Beer-Lambert through water),
  - self/neighbor shading (top-down).

For phase 1 we use a coarse columnar model: bucket plants by their (x,z) cell,
sort by height, and apply `exp(-k * sum_of_higher_biomass)` to subsequent plants.
"""

from __future__ import annotations

import math

K_WATER = 0.03  # per cm water extinction (clear planted tank, phase 1 constant)
K_CANOPY = 0.002  # per g of overhead biomass


def par_at_depth(surface_par: float, depth_cm: float) -> float:
    return surface_par * math.exp(-K_WATER * depth_cm)


def attenuate_by_canopy(par_in: float, overhead_biomass_g: float) -> float:
    return par_in * math.exp(-K_CANOPY * max(overhead_biomass_g, 0.0))
