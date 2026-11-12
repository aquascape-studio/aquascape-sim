/**
 * Port of `aquascape_sim/algo/photosynthesis.py`.
 * P-I curve (Thornley & Johnson 1990), CO₂ response (Henderson-Hasselbalch +
 * Michaelis-Menten), temperature response (Q10 × Gaussian).
 */

/** Gross photosynthesis (µmol O₂·g⁻¹·h⁻¹) vs irradiance — non-rectangular hyperbola. */
export function piCurve(I: number, alpha: number, Pmax: number, theta = 0.7): number {
  I = Math.max(0.0, I);
  Pmax = Math.max(0.0, Pmax);
  alpha = Math.max(1e-12, alpha);
  theta = Math.max(1e-9, Math.min(1.0, theta));

  if (I === 0.0 || Pmax === 0.0) return 0.0;

  const sumTerm = alpha * I + Pmax;
  let discriminant = sumTerm ** 2 - 4.0 * theta * alpha * I * Pmax;
  discriminant = Math.max(0.0, discriminant);
  return (sumTerm - Math.sqrt(discriminant)) / (2.0 * theta);
}

/** pKa₁ of carbonic acid at ~25 °C */
export const PKA1 = 6.35;

/** Michaelis-Menten CO₂ limitation factor in [0, 1]. */
export function co2Response(co2Ppm: number, ph: number, kh: number, Km = 5.0): number {
  co2Ppm = Math.max(0.0, co2Ppm);
  ph = Math.max(4.0, Math.min(10.0, ph));
  kh = Math.max(0.0, kh);
  Km = Math.max(1e-9, Km);

  const hco3MgL = kh * 21.8;
  const freeCo2Hh = hco3MgL / 10.0 ** (ph - PKA1);
  const freeCo2 = Math.max(freeCo2Hh, co2Ppm);
  return freeCo2 / (freeCo2 + Km);
}

/** Q10 × Gaussian temperature multiplier; peaks at 1 when T = Topt. */
export function temperatureResponse(T: number, Topt: number, Q10 = 2.0, sigmaT = 3.0): number {
  Q10 = Math.max(1.0, Q10);
  sigmaT = Math.max(1e-6, sigmaT);
  const delta = T - Topt;
  const q10Factor = Q10 ** (delta / 10.0);
  const gaussian = Math.exp(-0.5 * (delta / sigmaT) ** 2);
  return q10Factor * gaussian;
}
