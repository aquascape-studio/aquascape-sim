"""Nutrient draw-down per tick.

Dissolved N/P/K/Fe decrease as plants grow. Dosing & water changes replenish.
This module owns the reservoir math only; per-plant uptake is in tick.py.

It also provides a finer-grained, photosynthesis-coupled depletion model
(``NutrientState`` / ``deplete``) that can integrate over arbitrary time steps
(hours) and is directly coupled to the photosynthesis rate computed by
``algo.photosynthesis``.

Redfield-ratio background
--------------------------
The canonical oceanic Redfield ratio (Redfield 1934) is C:N:P ≈ 106:16:1 by
atoms. For freshwater planted aquaria the same stoichiometry is commonly
applied as an approximation: for every 1 μmol P assimilated, ~16 μmol N are
consumed. Converting to mass:

    mass_NO3 / mass_PO4 ≈ (16 × 62 g/mol) / (1 × 95 g/mol) ≈ 10.44

where 62 g/mol is the molar mass of NO₃⁻ and 95 g/mol is HPO₄²⁻ (PO₄-P
species used in aquarium testing). We use this ratio to derive the NO₃
depletion coefficient from the PO₄ coefficient.

References
----------
Redfield, A. C. (1934). On the proportions of organic derivatives in sea water
    and their relation to the composition of plankton. *James Johnstone Memorial
    Volume*, 176–192.
Geider, R. J. & La Roche, J. (2002). Redfield revisited. *European Journal of
    Phycology*, 37(1), 1–17.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# ---------------------------------------------------------------------------
# Existing tick-level classes (used by tick.py — do not remove).
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Photosynthesis-coupled depletion model (Round 2)
# ---------------------------------------------------------------------------

# Molar masses used for the Redfield mass ratio.
_M_NO3 = 62.0   # g/mol  (NO₃⁻)
_M_PO4 = 95.0   # g/mol  (HPO₄²⁻, dominant species at aquarium pH)

# Redfield N:P atom ratio (16:1) converted to NO₃:PO₄ mass ratio.
_REDFIELD_NO3_PO4_MASS_RATIO = 16.0 * _M_NO3 / _M_PO4  # ≈ 10.44

# PO₄ base uptake coefficient:
#   mg PO₄ consumed per (μmol O₂ · g biomass⁻¹ · h⁻¹) · h
#   Derived from empirical planted-tank nutrient budgets; plants assimilate
#   roughly 0.0008 mg PO₄ per μmol O₂ produced per gram dry weight.
#   (Rationale: Chapin et al. 2002, "Principles of Terrestrial Ecosystem
#   Ecology"; values scaled to aquatic macrophytes via Barko & Smart 1981.)
_K_PO4: float = 8e-4   # mg PO₄ / (μmol O₂·g⁻¹·h⁻¹) per hour

# NO₃ coefficient derived directly from Redfield mass ratio.
_K_NO3: float = _K_PO4 * _REDFIELD_NO3_PO4_MASS_RATIO  # ≈ 8.35e-3


@dataclass(slots=True)
class NutrientState:
    """Snapshot of dissolved NO₃ and PO₄ concentrations in mg/L.

    Parameters
    ----------
    no3 : float
        Dissolved nitrate concentration in mg/L. Must be ≥ 0.
    po4 : float
        Dissolved phosphate concentration in mg/L. Must be ≥ 0.
    """

    no3: float = 10.0   # mg/L
    po4: float = 1.0    # mg/L


def deplete(
    state: NutrientState,
    photosynthesis_rate: float,
    time_step: float,
    k_no3: float = _K_NO3,
    k_po4: float = _K_PO4,
) -> NutrientState:
    """Compute new NO₃ and PO₄ concentrations after one time step.

    Depletion is proportional to the gross photosynthesis rate: when plants
    photosynthesize more, they assimilate more dissolved nutrients.  The
    coupling follows Redfield stoichiometry so that NO₃ and PO₄ are consumed
    in the canonical 16:1 molar (≈ 10.44:1 mass as NO₃:PO₄) ratio.

    The update rule for each nutrient X is:

        ΔX = k_X × photosynthesis_rate × time_step
        X_new = max(0, X_old − ΔX)

    Concentrations are floored at 0 mg/L (nutrients cannot go negative).

    Parameters
    ----------
    state : NutrientState
        Current NO₃ and PO₄ concentrations in mg/L.
    photosynthesis_rate : float
        Gross photosynthesis rate in μmol O₂·g⁻¹·h⁻¹, as returned by
        ``algo.photosynthesis.pi_curve`` (or the product of pi_curve ×
        co2_response × temperature_response for a full net rate).
        Values ≤ 0 produce no depletion.
    time_step : float
        Integration window in hours. Must be > 0; negative values are clamped
        to 0 (no depletion).
    k_no3 : float, optional
        NO₃ uptake coefficient in mg·NO₃ per (μmol O₂·g⁻¹·h⁻¹) per hour.
        Defaults to the Redfield-derived value ``_K_NO3`` (≈ 8.35 × 10⁻³).
    k_po4 : float, optional
        PO₄ uptake coefficient in mg·PO₄ per (μmol O₂·g⁻¹·h⁻¹) per hour.
        Defaults to ``_K_PO4`` (8 × 10⁻⁴).

    Returns
    -------
    NutrientState
        New concentrations after depletion.  Original *state* is not mutated.

    Notes
    -----
    The function is intentionally stateless: it returns a **new** ``NutrientState``
    rather than modifying the input.  Callers that want in-place semantics can
    reassign:  ``state = deplete(state, rate, dt)``.
    """
    photosynthesis_rate = max(0.0, photosynthesis_rate)
    time_step = max(0.0, time_step)

    delta_no3 = k_no3 * photosynthesis_rate * time_step
    delta_po4 = k_po4 * photosynthesis_rate * time_step

    return NutrientState(
        no3=max(0.0, state.no3 - delta_no3),
        po4=max(0.0, state.po4 - delta_po4),
    )
