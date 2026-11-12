/**
 * Port of `aquascape_sim/algo/tick.py` — single-tick (1 day) integration of
 * the phase-1 columnar model. Kept 1:1 for parity; the spatial engine lives
 * in `../engine`.
 */

import { Axis, compat } from "./envelope";
import { attenuateByCanopy, parAtDepth } from "./light";
import { Reservoir, Uptake } from "./nutrients";

export interface PlantState {
  speciesId: string;
  biomassG: number;
  health: number;
  depthCm: number;
  envelope: Record<string, Axis>;
  maxDailyGrowthFrac: number;
  stoichiometryNo3PerG: number;
  stoichiometryPo4PerG: number;
  stoichiometryKPerG: number;
  stoichiometryFePerG: number;
}

export function plantState(
  init: Pick<PlantState, "speciesId" | "biomassG" | "health" | "depthCm"> & Partial<PlantState>,
): PlantState {
  return {
    envelope: {},
    maxDailyGrowthFrac: 0.07,
    stoichiometryNo3PerG: 0.05,
    stoichiometryPo4PerG: 0.006,
    stoichiometryKPerG: 0.03,
    stoichiometryFePerG: 0.0005,
    ...init,
  };
}

export interface TickState {
  surfacePar: number;
  waterParams: Record<string, number>;
  /** insertion-ordered like the Python dict */
  plants: Map<string, PlantState>;
  reservoir: Reservoir;
}

export function tickState(init: Partial<TickState> = {}): TickState {
  return {
    surfacePar: 120.0,
    waterParams: {},
    plants: new Map(),
    reservoir: new Reservoir(),
    ...init,
  };
}

/** Port of `TickState.from_request`: the deterministic phase-1 demo state. */
export function tickStateFromRequest(_req?: unknown): TickState {
  const st = tickState();
  st.waterParams = { temp: 25.0, ph: 6.8, gh: 6.0, par: 120.0, co2: 30.0 };
  st.plants.set(
    "demo-1",
    plantState({ speciesId: "echinodorus_bleheri", biomassG: 2.0, health: 1.0, depthCm: 20.0 }),
  );
  return st;
}

export function safeRatio(avail: number, demand: number): number {
  if (demand <= 1e-12) return 1.0;
  return avail / demand;
}

export function runTick(state: TickState, _day: number): void {
  // Sort plants by height proxy (biomass) so taller plants shade shorter ones (stable).
  const ordered = [...state.plants.entries()].sort((a, b) => -a[1].biomassG - -b[1].biomassG);
  let overheadBio = 0.0;
  const uptakeTotal = new Uptake();

  for (const [, p] of ordered) {
    const parSurfaceAtPlant = parAtDepth(state.surfacePar, p.depthCm);
    const parEff = attenuateByCanopy(parSurfaceAtPlant, overheadBio);

    const actuals = { ...state.waterParams, par: parEff };
    const score = Object.keys(p.envelope).length > 0 ? compat(p.envelope, actuals) : 1.0;

    const growthG = p.biomassG * p.maxDailyGrowthFrac * score * p.health;

    const demandNo3 = growthG * p.stoichiometryNo3PerG;
    const demandPo4 = growthG * p.stoichiometryPo4PerG;
    const demandK = growthG * p.stoichiometryKPerG;
    const demandFe = growthG * p.stoichiometryFePerG;

    const tankLiters = 60.0;
    const availNo3 = state.reservoir.no3 * tankLiters;
    const availPo4 = state.reservoir.po4 * tankLiters;
    const availK = state.reservoir.k * tankLiters;
    const availFe = state.reservoir.fe * tankLiters;

    const kLim = Math.min(
      1.0,
      safeRatio(availNo3, demandNo3),
      safeRatio(availPo4, demandPo4),
      safeRatio(availK, demandK),
      safeRatio(availFe, demandFe),
    );

    const actualGrowth = growthG * kLim;
    p.biomassG += actualGrowth;

    if (score < 0.5) {
      p.health = Math.max(0.0, p.health - 0.02 * (0.5 - score) * 2.0);
    } else {
      p.health = Math.min(1.0, p.health + 0.005);
    }

    uptakeTotal.no3 += (demandNo3 * kLim) / tankLiters;
    uptakeTotal.po4 += (demandPo4 * kLim) / tankLiters;
    uptakeTotal.k += (demandK * kLim) / tankLiters;
    uptakeTotal.fe += (demandFe * kLim) / tankLiters;

    overheadBio += p.biomassG;
  }

  state.reservoir.applyDaily(uptakeTotal);
}
