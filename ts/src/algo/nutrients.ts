/**
 * Port of `aquascape_sim/algo/nutrients.py`.
 *
 * Reservoir (mg/L, tick-level, absolute daily decay) and the
 * photosynthesis-coupled Redfield depletion model (NutrientState / deplete).
 */

export class Uptake {
  no3 = 0.0;
  po4 = 0.0;
  k = 0.0;
  fe = 0.0;
  constructor(init: Partial<Pick<Uptake, "no3" | "po4" | "k" | "fe">> = {}) {
    Object.assign(this, init);
  }
}

export interface ReservoirInit {
  no3?: number; po4?: number; k?: number; fe?: number;
  doseNo3?: number; dosePo4?: number; doseK?: number; doseFe?: number;
  decayNo3?: number; decayPo4?: number; decayK?: number; decayFe?: number;
}

/** Dissolved nutrient concentrations in mg/L. */
export class Reservoir {
  no3 = 10.0;
  po4 = 1.0;
  k = 10.0;
  fe = 0.1;

  // Dosing schedule: mg/L added per day (constant for phase 1).
  doseNo3 = 0.0;
  dosePo4 = 0.0;
  doseK = 0.0;
  doseFe = 0.0;

  // Per-day passive losses (filter, bio-denitrification).
  decayNo3 = 0.05;
  decayPo4 = 0.02;
  decayK = 0.0;
  decayFe = 0.2; // iron oxidizes fast

  constructor(init: ReservoirInit = {}) {
    Object.assign(this, init);
  }

  applyDaily(uptake: Uptake): void {
    this.no3 = Math.max(0.0, this.no3 + this.doseNo3 - this.decayNo3 - uptake.no3);
    this.po4 = Math.max(0.0, this.po4 + this.dosePo4 - this.decayPo4 - uptake.po4);
    this.k = Math.max(0.0, this.k + this.doseK - this.decayK - uptake.k);
    this.fe = Math.max(0.0, this.fe + this.doseFe - this.decayFe - uptake.fe);
  }
}

/** g/mol (NO₃⁻) */
export const M_NO3 = 62.0;
/** g/mol (HPO₄²⁻) */
export const M_PO4 = 95.0;
/** Redfield N:P 16:1 (atoms) as NO₃:PO₄ mass ratio ≈ 10.44 */
export const REDFIELD_NO3_PO4_MASS_RATIO = (16.0 * M_NO3) / M_PO4;
/** mg PO₄ / (µmol O₂·g⁻¹·h⁻¹) per hour */
export const K_PO4 = 8e-4;
/** NO₃ coefficient derived from the Redfield mass ratio (≈ 8.35e-3) */
export const K_NO3 = K_PO4 * REDFIELD_NO3_PO4_MASS_RATIO;

/** Snapshot of dissolved NO₃ and PO₄ (mg/L). */
export interface NutrientState {
  no3: number;
  po4: number;
}

export function nutrientState(no3 = 10.0, po4 = 1.0): NutrientState {
  return { no3, po4 };
}

/** New NO₃/PO₄ after `timeStep` hours of photosynthesis-coupled uptake. Input not mutated. */
export function deplete(
  state: NutrientState,
  photosynthesisRate: number,
  timeStep: number,
  kNo3: number = K_NO3,
  kPo4: number = K_PO4,
): NutrientState {
  photosynthesisRate = Math.max(0.0, photosynthesisRate);
  timeStep = Math.max(0.0, timeStep);
  const deltaNo3 = kNo3 * photosynthesisRate * timeStep;
  const deltaPo4 = kPo4 * photosynthesisRate * timeStep;
  return {
    no3: Math.max(0.0, state.no3 - deltaNo3),
    po4: Math.max(0.0, state.po4 - deltaPo4),
  };
}
