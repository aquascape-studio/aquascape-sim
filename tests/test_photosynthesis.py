"""Tests for the photosynthesis module.

Covers pi_curve, co2_response, and temperature_response with parametrize.
"""

from __future__ import annotations

import math

import pytest

from aquascape_sim.algo.photosynthesis import co2_response, pi_curve, temperature_response


# ---------------------------------------------------------------------------
# pi_curve
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "I, alpha, Pmax, theta, expected_zero",
    [
        # Zero light → zero photosynthesis regardless of other params
        (0.0, 0.05, 100.0, 0.7, True),
        (0.0, 0.03, 50.0, 0.5, True),
        # Zero Pmax → zero photosynthesis
        (200.0, 0.05, 0.0, 0.7, True),
    ],
    ids=["zero-light-typical", "zero-light-low-alpha", "zero-pmax"],
)
def test_pi_curve_zero_light(I, alpha, Pmax, theta, expected_zero):
    result = pi_curve(I, alpha, Pmax, theta)
    assert result == 0.0


@pytest.mark.parametrize(
    "I, alpha, Pmax, theta, tolerance",
    [
        # Very high irradiance → gross photosynthesis should be close to Pmax.
        # The non-rectangular hyperbola converges slowly; use I >> Pmax/alpha
        # and a generous tolerance that still confirms near-saturation.
        # I = 1e7 ensures I*alpha >> Pmax for both cases.
        (1_000_000.0, 0.05, 100.0, 0.7, 0.02),   # within 2% of Pmax
        (1_000_000.0, 0.03, 200.0, 0.5, 0.02),
    ],
    ids=["high-I-theta0.7", "high-I-theta0.5"],
)
def test_pi_curve_saturating_light_near_pmax(I, alpha, Pmax, theta, tolerance):
    result = pi_curve(I, alpha, Pmax, theta)
    assert result > Pmax * (1.0 - tolerance), (
        f"Expected result ≥ {Pmax * (1 - tolerance):.2f}, got {result:.4f}"
    )
    assert result <= Pmax, f"Gross photosynthesis must not exceed Pmax ({Pmax})"


@pytest.mark.parametrize(
    "I, alpha, Pmax, theta",
    [
        (100.0, 0.05, 100.0, 0.7),
        (50.0,  0.04, 80.0,  0.5),
    ],
    ids=["moderate-I-typical", "moderate-I-low-alpha"],
)
def test_pi_curve_monotone_increasing(I, alpha, Pmax, theta):
    """P-I curve must be strictly increasing with irradiance."""
    low = pi_curve(I * 0.5, alpha, Pmax, theta)
    high = pi_curve(I, alpha, Pmax, theta)
    assert high > low


@pytest.mark.parametrize(
    "I, alpha, Pmax, theta",
    [
        # Negative I should clamp to zero → same as I=0
        (-50.0, 0.05, 100.0, 0.7),
        # Negative Pmax should clamp to zero
        (200.0, 0.05, -10.0, 0.7),
    ],
    ids=["negative-irradiance", "negative-pmax"],
)
def test_pi_curve_negative_inputs_clamped_not_raised(I, alpha, Pmax, theta):
    """Negative inputs must not raise; they are silently clamped."""
    result = pi_curve(I, alpha, Pmax, theta)
    assert result == 0.0


@pytest.mark.parametrize(
    "theta",
    [0.7, 0.3, 1.0, 0.01],
    ids=["theta-0.7", "theta-0.3", "theta-1.0", "theta-0.01"],
)
def test_pi_curve_result_bounded_by_pmax(theta):
    """Result must never exceed Pmax for any valid theta."""
    Pmax = 150.0
    result = pi_curve(500.0, 0.05, Pmax, theta)
    assert 0.0 <= result <= Pmax


# ---------------------------------------------------------------------------
# co2_response
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "co2_ppm, ph, kh, Km, expected_low",
    [
        # Very low CO2 (near zero ppm, low KH, high pH) → factor < 0.5
        (0.5, 8.0, 0.5, 5.0, True),
        # Low KH and high pH → Henderson-Hasselbalch gives tiny free CO2
        (1.0, 8.5, 0.2, 5.0, True),
    ],
    ids=["low-co2-high-ph", "very-low-kh-high-ph"],
)
def test_co2_response_low_co2_limits_factor(co2_ppm, ph, kh, Km, expected_low):
    result = co2_response(co2_ppm, ph, kh, Km)
    assert result < 0.5, f"Expected factor < 0.5 under low CO2, got {result:.4f}"


@pytest.mark.parametrize(
    "co2_ppm, ph, kh, Km",
    [
        # Ample CO2: high ppm or low pH/high KH raises free CO2 >> Km
        (30.0, 6.8, 4.0, 5.0),
        (50.0, 7.0, 3.0, 5.0),
    ],
    ids=["adequate-co2-planted-tank", "high-co2-injection"],
)
def test_co2_response_adequate_co2_near_saturation(co2_ppm, ph, kh, Km):
    result = co2_response(co2_ppm, ph, kh, Km)
    assert result > 0.5, f"Expected factor > 0.5 with adequate CO2, got {result:.4f}"


def test_co2_response_output_bounded():
    """Result must always be in [0, 1]."""
    for co2 in [0.0, 1.0, 10.0, 100.0, 1000.0]:
        r = co2_response(co2, ph=7.0, kh=3.0)
        assert 0.0 <= r <= 1.0, f"Out-of-bounds for co2={co2}: {r}"


@pytest.mark.parametrize(
    "co2_ppm, ph, kh",
    [
        (-5.0, 7.0, 3.0),   # negative CO2
        (10.0, 7.0, -1.0),  # negative KH
    ],
    ids=["negative-co2", "negative-kh"],
)
def test_co2_response_negative_inputs_clamped_not_raised(co2_ppm, ph, kh):
    """Negative inputs must not raise exceptions."""
    result = co2_response(co2_ppm, ph, kh)
    assert 0.0 <= result <= 1.0


# ---------------------------------------------------------------------------
# temperature_response
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "Topt, Q10, sigma_T",
    [
        (25.0, 2.0, 3.0),
        (22.0, 1.8, 4.0),
        (28.0, 2.5, 2.5),
    ],
    ids=["topt-25", "topt-22", "topt-28"],
)
def test_temperature_response_at_optimum_is_one(Topt, Q10, sigma_T):
    """At T = Topt the response must be exactly 1.0."""
    result = temperature_response(Topt, Topt, Q10, sigma_T)
    assert math.isclose(result, 1.0, rel_tol=1e-9), (
        f"Expected 1.0 at optimum, got {result}"
    )


@pytest.mark.parametrize(
    "T, Topt, Q10, sigma_T, max_allowed",
    [
        # 10 °C from Topt with sigma_T=3 → Gaussian ≈ exp(-0.5*(10/3)²) ≈ 1e-2
        (35.0, 25.0, 2.0, 3.0, 0.1),
        (15.0, 25.0, 2.0, 3.0, 0.1),
        # 15 °C from Topt with tight sigma
        (40.0, 25.0, 2.0, 2.0, 0.01),
    ],
    ids=["10-above-topt", "10-below-topt", "15-above-topt-tight"],
)
def test_temperature_response_far_from_topt_severe_reduction(T, Topt, Q10, sigma_T, max_allowed):
    result = temperature_response(T, Topt, Q10, sigma_T)
    assert result < max_allowed, (
        f"Expected severe reduction (< {max_allowed}) at T={T} vs Topt={Topt}, "
        f"got {result:.6f}"
    )


@pytest.mark.parametrize(
    "T, Topt, Q10, sigma_T, min_expected",
    [
        # At T=Topt-1: Q10 factor = 2^(-0.1) ≈ 0.933, Gaussian ≈ 0.946 → ~0.883.
        # At T=Topt+1: Q10 factor = 2^(+0.1) ≈ 1.072, Gaussian ≈ 0.946 → ~1.014
        #   (clipped by multiplication; still well above 0.9).
        # Threshold 0.85 covers both cold and warm sides conservatively.
        (24.0, 25.0, 2.0, 3.0, 0.85),
        (26.0, 25.0, 2.0, 3.0, 0.85),
    ],
    ids=["slightly-below-topt", "slightly-above-topt"],
)
def test_temperature_response_near_topt_close_to_one(T, Topt, Q10, sigma_T, min_expected):
    """Within 1 °C of Topt the multiplier should be close to 1."""
    result = temperature_response(T, Topt, Q10=Q10, sigma_T=sigma_T)
    assert result > min_expected, f"Expected > {min_expected} near optimum, got {result:.4f}"


@pytest.mark.parametrize(
    "T, Topt, Q10, sigma_T",
    [
        # Extreme high temperature — should not raise, just return a tiny positive value
        (100.0, 25.0, 2.0, 3.0),
        # Extreme cold
        (-50.0, 25.0, 2.0, 3.0),
    ],
    ids=["extreme-hot", "extreme-cold"],
)
def test_temperature_response_extreme_inputs_no_raise(T, Topt, Q10, sigma_T):
    """Extreme temperature inputs must not raise exceptions."""
    result = temperature_response(T, Topt, Q10, sigma_T)
    assert result >= 0.0


def test_temperature_response_always_positive():
    """The response should always be strictly positive (never exactly 0)."""
    for delta in [0, 5, 10, 20, 50]:
        r = temperature_response(25.0 + delta, 25.0)
        assert r > 0.0, f"Zero response at delta={delta}"
