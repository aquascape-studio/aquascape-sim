/** Port of `aquascape_sim/algo/light.py` — Beer-Lambert PAR attenuation. */

/** per cm water extinction (clear planted tank, phase 1 constant) */
export const K_WATER = 0.03;
/** per g of overhead biomass */
export const K_CANOPY = 0.002;

export function parAtDepth(surfacePar: number, depthCm: number): number {
  return surfacePar * Math.exp(-K_WATER * depthCm);
}

export function attenuateByCanopy(parIn: number, overheadBiomassG: number): number {
  return parIn * Math.exp(-K_CANOPY * Math.max(overheadBiomassG, 0.0));
}
