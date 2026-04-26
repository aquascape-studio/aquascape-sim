"""Tests for the nutrient depletion model (NutrientState / deplete).

Covers: depletion over time, zero-photosynthesis invariance, floor at zero,
Redfield-ratio proportionality, time-step scaling, custom coefficients,
negative-input clamping, and integration with the photosynthesis module.
"""

from __future__ import annotations

import math

import pytest

from aquascape_sim.algo.nutrients import (
    NutrientState,
    _K_NO3,
    _K_PO4,
    _REDFIELD_NO3_PO4_MASS_RATIO,
    deplete,
)
from aquascape_sim.algo.photosynthesis import co2_response, pi_curve, temperature_response


# ---------------------------------------------------------------------------
# 1. Basic depletion over time
# ---------------------------------------------------------------------------


def test_deplete_reduces_no3_and_po4():
    """Positive photosynthesis rate must reduce both NO3 and PO4."""
    state = NutrientState(no3=10.0, po4=1.0)
    new = deplete(state, photosynthesis_rate=50.0, time_step=1.0)
    assert new.no3 < state.no3
    assert new.po4 < state.po4


def test_deplete_longer_time_step_removes_more():
    """Depletion after 2 h must exceed depletion after 1 h."""
    state = NutrientState(no3=20.0, po4=2.0)
    after_1h = deplete(state, photosynthesis_rate=40.0, time_step=1.0)
    after_2h = deplete(state, photosynthesis_rate=40.0, time_step=2.0)
    assert after_2h.no3 < after_1h.no3
    assert after_2h.po4 < after_1h.po4


@pytest.mark.parametrize("rate", [10.0, 50.0, 200.0])
def test_deplete_proportional_to_photosynthesis_rate(rate: float):
    """Nutrient removal must scale linearly with photosynthesis rate."""
    state = NutrientState(no3=100.0, po4=10.0)
    dt = 1.0
    new = deplete(state, photosynthesis_rate=rate, time_step=dt)
    expected_delta_no3 = _K_NO3 * rate * dt
    expected_delta_po4 = _K_PO4 * rate * dt
    assert math.isclose(state.no3 - new.no3, expected_delta_no3, rel_tol=1e-9)
    assert math.isclose(state.po4 - new.po4, expected_delta_po4, rel_tol=1e-9)


# ---------------------------------------------------------------------------
# 2. Zero photosynthesis — no depletion
# ---------------------------------------------------------------------------


def test_deplete_zero_photosynthesis_no_change():
    """Zero photosynthesis rate must leave concentrations unchanged."""
    state = NutrientState(no3=5.0, po4=0.5)
    new = deplete(state, photosynthesis_rate=0.0, time_step=24.0)
    assert new.no3 == state.no3
    assert new.po4 == state.po4


def test_deplete_negative_photosynthesis_treated_as_zero():
    """Negative photosynthesis (darkness / respiration) must not increase nutrients."""
    state = NutrientState(no3=5.0, po4=0.5)
    new = deplete(state, photosynthesis_rate=-100.0, time_step=1.0)
    assert new.no3 == state.no3
    assert new.po4 == state.po4


# ---------------------------------------------------------------------------
# 3. Floor at zero — nutrients cannot go negative
# ---------------------------------------------------------------------------


def test_deplete_no3_cannot_go_below_zero():
    """NO3 must be floored at 0 when depletion would exceed available supply."""
    state = NutrientState(no3=0.001, po4=100.0)
    new = deplete(state, photosynthesis_rate=1_000.0, time_step=100.0)
    assert new.no3 == 0.0


def test_deplete_po4_cannot_go_below_zero():
    """PO4 must be floored at 0 when depletion would exceed available supply."""
    state = NutrientState(no3=100.0, po4=0.001)
    new = deplete(state, photosynthesis_rate=1_000.0, time_step=100.0)
    assert new.po4 == 0.0


def test_deplete_both_at_zero_stay_at_zero():
    """Starting from 0 mg/L the nutrient state must remain at 0 regardless of rate."""
    state = NutrientState(no3=0.0, po4=0.0)
    new = deplete(state, photosynthesis_rate=500.0, time_step=12.0)
    assert new.no3 == 0.0
    assert new.po4 == 0.0


# ---------------------------------------------------------------------------
# 4. Redfield-ratio proportionality
# ---------------------------------------------------------------------------


def test_deplete_redfield_ratio_no3_to_po4():
    """NO3 and PO4 depletion must honour the Redfield mass ratio (≈ 10.44)."""
    state = NutrientState(no3=100.0, po4=100.0)
    new = deplete(state, photosynthesis_rate=30.0, time_step=1.0)
    delta_no3 = state.no3 - new.no3
    delta_po4 = state.po4 - new.po4
    ratio = delta_no3 / delta_po4
    assert math.isclose(ratio, _REDFIELD_NO3_PO4_MASS_RATIO, rel_tol=1e-9)


# ---------------------------------------------------------------------------
# 5. Zero time step — no depletion
# ---------------------------------------------------------------------------


def test_deplete_zero_time_step_no_change():
    """A zero-length time step must produce no change."""
    state = NutrientState(no3=8.0, po4=0.8)
    new = deplete(state, photosynthesis_rate=100.0, time_step=0.0)
    assert new.no3 == state.no3
    assert new.po4 == state.po4


def test_deplete_negative_time_step_treated_as_zero():
    """Negative time steps must be clamped to 0 (no depletion)."""
    state = NutrientState(no3=8.0, po4=0.8)
    new = deplete(state, photosynthesis_rate=100.0, time_step=-5.0)
    assert new.no3 == state.no3
    assert new.po4 == state.po4


# ---------------------------------------------------------------------------
# 6. Custom uptake coefficients
# ---------------------------------------------------------------------------


def test_deplete_custom_coefficients_respected():
    """Caller-supplied k_no3 / k_po4 override the defaults."""
    state = NutrientState(no3=10.0, po4=10.0)
    rate, dt = 50.0, 1.0
    k_no3_custom, k_po4_custom = 0.02, 0.01
    new = deplete(state, rate, dt, k_no3=k_no3_custom, k_po4=k_po4_custom)
    assert math.isclose(state.no3 - new.no3, k_no3_custom * rate * dt, rel_tol=1e-9)
    assert math.isclose(state.po4 - new.po4, k_po4_custom * rate * dt, rel_tol=1e-9)


# ---------------------------------------------------------------------------
# 7. Immutability — original state is not mutated
# ---------------------------------------------------------------------------


def test_deplete_does_not_mutate_input():
    """deplete() must return a new NutrientState without modifying the original."""
    state = NutrientState(no3=10.0, po4=1.0)
    original_no3, original_po4 = state.no3, state.po4
    _ = deplete(state, photosynthesis_rate=50.0, time_step=1.0)
    assert state.no3 == original_no3
    assert state.po4 == original_po4


# ---------------------------------------------------------------------------
# 8. Integration: coupled to pi_curve × response factors
# ---------------------------------------------------------------------------


def test_deplete_coupled_to_full_photosynthesis_model():
    """Nutrients should deplete measurably under realistic planted-tank conditions."""
    # Realistic high-tech planted tank: strong light, CO2-injected, warm.
    gross_rate = pi_curve(I=200.0, alpha=0.05, Pmax=100.0, theta=0.7)
    co2_factor = co2_response(co2_ppm=30.0, ph=6.8, kh=4.0)
    temp_factor = temperature_response(T=25.0, Topt=25.0)
    net_rate = gross_rate * co2_factor * temp_factor

    assert net_rate > 0.0, "Expected positive net photosynthesis rate"

    state = NutrientState(no3=10.0, po4=1.0)
    # Simulate 8 h of peak daylight.
    new = deplete(state, photosynthesis_rate=net_rate, time_step=8.0)

    assert new.no3 < state.no3, "NO3 should decrease under active photosynthesis"
    assert new.po4 < state.po4, "PO4 should decrease under active photosynthesis"
    # Under realistic conditions the drawdown should be small but non-trivial.
    assert new.no3 > 0.0, "NO3 should not be fully exhausted in 8 h at realistic rates"
    assert new.po4 > 0.0, "PO4 should not be fully exhausted in 8 h at realistic rates"


def test_deplete_zero_light_no_depletion_via_pi_curve():
    """When PAR is zero the P-I curve gives zero rate → no nutrient depletion."""
    rate = pi_curve(I=0.0, alpha=0.05, Pmax=100.0)
    state = NutrientState(no3=10.0, po4=1.0)
    new = deplete(state, photosynthesis_rate=rate, time_step=12.0)
    assert new.no3 == state.no3
    assert new.po4 == state.po4


# ---------------------------------------------------------------------------
# 9. Cumulative multi-step simulation
# ---------------------------------------------------------------------------


def test_deplete_multi_step_accumulates():
    """Repeated single-step depletions should equal one equivalent long step."""
    state = NutrientState(no3=50.0, po4=5.0)
    rate = 30.0
    # 4 × 1 h steps
    s = state
    for _ in range(4):
        s = deplete(s, photosynthesis_rate=rate, time_step=1.0)
    # single 4 h step (from original state)
    one_shot = deplete(state, photosynthesis_rate=rate, time_step=4.0)
    assert math.isclose(s.no3, one_shot.no3, rel_tol=1e-9)
    assert math.isclose(s.po4, one_shot.po4, rel_tol=1e-9)
