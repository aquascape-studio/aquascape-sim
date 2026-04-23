"""Photosynthesis response functions for aquatic plants.

Three modular factors — light, CO2, and temperature — each return a value in
[0..1] (or μmol O2/g/h for the P-I curve) that can be multiplied together to
yield a net photosynthesis rate scalar.

References
----------
Thornley, J. H. M. & Johnson, I. R. (1990). *Plant and Crop Modelling*.
    Clarendon Press. [non-rectangular hyperbola P-I model]
Henderson, L. J. & Hasselbalch, K. A. (1908/1916). pH–CO₂ equilibrium.
    [Henderson-Hasselbalch equation used for free-CO₂ derivation]
Hochachka, P. W. & Somero, G. N. (2002). *Biochemical Adaptation*.
    Oxford University Press. [Q10 thermal response]
"""

from __future__ import annotations

import math


# ---------------------------------------------------------------------------
# 1. P-I curve (non-rectangular hyperbola, Thornley & Johnson 1990)
# ---------------------------------------------------------------------------

def pi_curve(
    I: float,
    alpha: float,
    Pmax: float,
    theta: float = 0.7,
) -> float:
    """Gross photosynthesis as a function of irradiance (P-I curve).

    Uses the non-rectangular hyperbola formulation (Thornley & Johnson 1990):

        P = [alpha*I + Pmax - sqrt((alpha*I + Pmax)^2 - 4*theta*alpha*I*Pmax)]
            / (2*theta)

    Parameters
    ----------
    I : float
        Irradiance in μmol photons·m⁻²·s⁻¹ (PAR). Clamped to [0, ∞).
    alpha : float
        Initial slope of the P-I curve (quantum yield),
        μmol O₂·μmol photons⁻¹, typically 0.03–0.06. Clamped to (0, ∞).
    Pmax : float
        Maximum (light-saturated) gross photosynthesis rate,
        μmol O₂·g⁻¹·h⁻¹. Clamped to [0, ∞).
    theta : float, optional
        Convexity parameter (0 < theta ≤ 1); default 0.7.
        theta → 0 gives a rectangular hyperbola (Michaelis-Menten);
        theta → 1 gives a sharp light-saturation break.

    Returns
    -------
    float
        Gross photosynthesis rate in μmol O₂·g⁻¹·h⁻¹. Always ≥ 0.

    Notes
    -----
    Negative I or Pmax are clamped to 0; non-positive alpha is clamped to
    a tiny epsilon so the formula stays numerically safe.  theta is clamped
    to (0, 1].
    """
    I = max(0.0, I)
    Pmax = max(0.0, Pmax)
    alpha = max(1e-12, alpha)
    theta = max(1e-9, min(1.0, theta))

    if I == 0.0 or Pmax == 0.0:
        return 0.0

    sum_term = alpha * I + Pmax
    discriminant = sum_term**2 - 4.0 * theta * alpha * I * Pmax
    # Guard against tiny negative values from floating-point rounding.
    discriminant = max(0.0, discriminant)
    return (sum_term - math.sqrt(discriminant)) / (2.0 * theta)


# ---------------------------------------------------------------------------
# 2. CO₂ response (Michaelis-Menten with Henderson-Hasselbalch derivation)
# ---------------------------------------------------------------------------

# pKa₁ of carbonic acid at ~25 °C (Stumm & Morgan, 1996)
_PKA1 = 6.35


def co2_response(
    co2_ppm: float,
    ph: float,
    kh: float,
    Km: float = 5.0,
) -> float:
    """Limitation factor for photosynthesis based on free dissolved CO₂.

    Free CO₂ in the water column is derived from the measured CO₂ concentration
    (in ppm, approximated as mg/L for freshwater), pH, and carbonate hardness
    (KH in °dH) via the Henderson-Hasselbalch relationship:

        [HCO₃⁻] = KH_mol × 10^(pH - pKa₁)   (Hasselbalch 1916)
        [CO₂]_free = [HCO₃⁻] / 10^(pH - pKa₁)

    In practice we use a simpler but equivalent formulation: the KH×pH table
    widely used in the aquarium hobby converts KH (°dH) to [HCO₃⁻] in mg/L
    (1 °dH ≈ 17.86 mg/L HCO₃⁻ as CaCO₃ equivalent, ≈ 21.8 mg/L HCO₃⁻).
    Free CO₂ (mg/L) ≈ [HCO₃⁻] / 10^(pH − pKa₁).

    The limitation factor is a simple Michaelis-Menten function:

        f_CO₂ = [CO₂]_free / ([CO₂]_free + Km)

    Parameters
    ----------
    co2_ppm : float
        Nominal CO₂ concentration in ppm (≈ mg/L for freshwater).
        Used only as a floor: the function takes the *larger* of the
        Henderson-Hasselbalch-derived free CO₂ and co2_ppm to handle tanks
        where the dosing measurement and the chemistry estimate diverge.
        Clamped to [0, ∞).
    ph : float
        Water pH. Clamped to [4.0, 10.0].
    kh : float
        Carbonate hardness in °dH. Clamped to [0, ∞).
    Km : float, optional
        Michaelis constant for CO₂ in mg/L; default 5.0.
        Literature values for submerged aquatic plants: ~1–10 mg/L
        (Madsen & Sand-Jensen 1991, Aquat. Bot.).

    Returns
    -------
    float
        Dimensionless limitation factor in [0, 1].

    Notes
    -----
    Negative inputs are clamped; the function never raises on bad input.
    """
    co2_ppm = max(0.0, co2_ppm)
    ph = max(4.0, min(10.0, ph))
    kh = max(0.0, kh)
    Km = max(1e-9, Km)

    # Convert KH (°dH) to [HCO₃⁻] in mg/L.
    # 1 °dH = 17.848 mg/L CaO equivalent ≈ 21.8 mg/L HCO₃⁻.
    hco3_mg_l = kh * 21.8  # mg/L bicarbonate

    # Henderson-Hasselbalch: [CO₂] = [HCO₃⁻] / 10^(pH - pKa₁)
    free_co2_hh = hco3_mg_l / (10.0 ** (ph - _PKA1))

    # Take the larger of the HH estimate and the measured ppm value.
    free_co2 = max(free_co2_hh, co2_ppm)

    return free_co2 / (free_co2 + Km)


# ---------------------------------------------------------------------------
# 3. Temperature response (Q10 with Gaussian penalty around Topt)
# ---------------------------------------------------------------------------

def temperature_response(
    T: float,
    Topt: float,
    Q10: float = 2.0,
    sigma_T: float = 3.0,
) -> float:
    """Dimensionless temperature multiplier for photosynthesis.

    Combines a Q10 scaling (Hochachka & Somero 2002) — which captures the
    biochemical rate increase with temperature up to the optimum — with a
    Gaussian penalty that suppresses photosynthesis when T deviates from Topt:

        f_T = Q10^((T - Topt) / 10) × exp(-0.5 × ((T - Topt) / sigma_T)²)

    The product peaks at 1.0 when T = Topt (since Q10 term = 1 and Gaussian = 1)
    and falls off on both sides:
      - Below Topt: the Gaussian dominates cold suppression (enzymes slow).
      - Above Topt: the Gaussian dominates heat denaturation.

    Parameters
    ----------
    T : float
        Actual water temperature in °C.
    Topt : float
        Optimal temperature for photosynthesis in °C (species-specific).
    Q10 : float, optional
        Rate multiplication factor per 10 °C; default 2.0 (typical for
        enzymatic reactions, Hochachka & Somero 2002).
    sigma_T : float, optional
        Width (std-dev) of the Gaussian tolerance window in °C; default 3.0.
        Smaller values produce a narrower optimum.

    Returns
    -------
    float
        Dimensionless multiplier in (0, 1]. Always positive (never exactly 0).

    Notes
    -----
    Q10 is clamped to [1.0, ∞) and sigma_T to (0, ∞) to prevent nonsensical
    inputs from producing negative or infinite results.
    """
    Q10 = max(1.0, Q10)
    sigma_T = max(1e-6, sigma_T)

    delta = T - Topt
    q10_factor = Q10 ** (delta / 10.0)
    gaussian = math.exp(-0.5 * (delta / sigma_T) ** 2)
    return q10_factor * gaussian
