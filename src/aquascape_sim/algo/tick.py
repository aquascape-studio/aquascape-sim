"""Single-tick (1 day) integration.

State held per-plant:
  biomass_g   — current mass, grows via photosynthesis, decays via self-shade + stress
  health      — [0..1], multiplier on growth, decays under sustained stress

Per tick we:
  1. Compute PAR at each plant (surface → depth → canopy attenuation)
  2. Compute compatibility (envelope × actuals)
  3. Compute demanded uptake = growth_potential × stoichiometry
  4. Clamp uptake to available reservoir → actual uptake
  5. Update biomass, health; apply reservoir deltas
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from aquascape_sim.algo.envelope import Axis, compat
from aquascape_sim.algo.light import attenuate_by_canopy, par_at_depth
from aquascape_sim.algo.nutrients import Reservoir, Uptake


@dataclass(slots=True)
class PlantState:
    species_id: str
    biomass_g: float
    health: float
    depth_cm: float
    envelope: dict[str, Axis] = field(default_factory=dict)
    # Phase-1 constants; would normally come from species record.
    max_daily_growth_frac: float = 0.07  # up to 7% mass gain per day in ideal conditions
    stoichiometry_no3_per_g: float = 0.05
    stoichiometry_po4_per_g: float = 0.006
    stoichiometry_k_per_g: float = 0.03
    stoichiometry_fe_per_g: float = 0.0005


@dataclass(slots=True)
class TickState:
    surface_par: float = 120.0  # μmol·m⁻²·s⁻¹
    water_params: dict[str, float] = field(default_factory=dict)
    plants: dict[str, PlantState] = field(default_factory=dict)
    reservoir: Reservoir = field(default_factory=Reservoir)

    @classmethod
    def from_request(cls, _req: Any) -> "TickState":
        # Phase 1: ignore request shape; return a deterministic demo state.
        # Real impl will translate SimRequest → this.
        st = cls()
        st.water_params = {
            "temp": 25.0,
            "ph": 6.8,
            "gh": 6.0,
            "par": 120.0,
            "co2": 30.0,
        }
        st.plants["demo-1"] = PlantState(
            species_id="echinodorus_bleheri",
            biomass_g=2.0,
            health=1.0,
            depth_cm=20.0,
        )
        return st


def run_tick(state: TickState, _day: int) -> None:
    # Sort plants by height proxy (biomass) so taller plants shade shorter ones.
    ordered = sorted(state.plants.items(), key=lambda kv: -kv[1].biomass_g)
    overhead_bio = 0.0

    uptake_total = Uptake()

    for pid, p in ordered:
        # 1. PAR reaching this plant.
        par_surface_at_plant = par_at_depth(state.surface_par, p.depth_cm)
        par_eff = attenuate_by_canopy(par_surface_at_plant, overhead_bio)

        # 2. Compatibility — inject the effective PAR into actuals.
        actuals = {**state.water_params, "par": par_eff}
        score = compat(p.envelope, actuals) if p.envelope else 1.0

        # 3. Growth potential this tick.
        growth_g = p.biomass_g * p.max_daily_growth_frac * score * p.health

        # 4. Demanded uptake.
        demand_no3 = growth_g * p.stoichiometry_no3_per_g
        demand_po4 = growth_g * p.stoichiometry_po4_per_g
        demand_k = growth_g * p.stoichiometry_k_per_g
        demand_fe = growth_g * p.stoichiometry_fe_per_g

        # 5. Clamp to reservoir availability (convert mg/L → mg via a notional 60 L tank).
        tank_liters = 60.0
        avail_no3 = state.reservoir.no3 * tank_liters
        avail_po4 = state.reservoir.po4 * tank_liters
        avail_k = state.reservoir.k * tank_liters
        avail_fe = state.reservoir.fe * tank_liters

        k_lim = min(
            1.0,
            _safe_ratio(avail_no3, demand_no3),
            _safe_ratio(avail_po4, demand_po4),
            _safe_ratio(avail_k, demand_k),
            _safe_ratio(avail_fe, demand_fe),
        )

        actual_growth = growth_g * k_lim
        p.biomass_g += actual_growth

        # Health decays under sustained stress (score < 0.5), recovers otherwise.
        if score < 0.5:
            p.health = max(0.0, p.health - 0.02 * (0.5 - score) * 2.0)
        else:
            p.health = min(1.0, p.health + 0.005)

        # Accumulate tank-wide uptake (back to mg/L).
        uptake_total.no3 += (demand_no3 * k_lim) / tank_liters
        uptake_total.po4 += (demand_po4 * k_lim) / tank_liters
        uptake_total.k += (demand_k * k_lim) / tank_liters
        uptake_total.fe += (demand_fe * k_lim) / tank_liters

        overhead_bio += p.biomass_g

    state.reservoir.apply_daily(uptake_total)


def _safe_ratio(avail: float, demand: float) -> float:
    if demand <= 1e-12:
        return 1.0
    return avail / demand
