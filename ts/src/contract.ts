/**
 * @aquascape/sim-core — cross-repo contract.
 *
 * OWNER: orchestrator only. Sub-agents MUST NOT edit this file; report
 * disagreements instead. Consumers: aquascape-web (vendored), aquascape-render.
 *
 * Coordinates: origin at the centre of the tank floor.
 *   x: left → right, z: back → front, y: up.  All lengths in cm.
 * Units: PAR µmol·m⁻²·s⁻¹, concentrations mg/L, CO2 ppm (mg/L), mass g, time days.
 */

export const CONTRACT_VERSION = "1.2.0" as const;

/*
 * Changelog
 * 1.2.0 (2026-11-20) Light above the botany range no longer kills plants
 *   (aquascape-sim#8: at High light the tops of tall stems saw ~300 PAR, above
 *   `light.max`, so the light axis scored 0, fitness collapsed and day-90
 *   biomass halved). Botany `light.max` is the top of the recommended husbandry
 *   range, not a lethal limit: submerged macrophytes saturate anywhere between
 *   ~100 and ~1000 PAR, and excess light without CO2 stalls growth (CO2
 *   limitation, algae) rather than melting plants.
 *   - ENVELOPE_RULE: the light axis upper side ramps from 1 at optMax down to
 *     LIGHT_UPPER_FLOOR at `max` and stays there for any PAR ≥ max. The lower
 *     side (and every other axis) is unchanged.
 *   - Output-affecting: day-90 biomass at High light rises; Low/Medium change
 *     only where a plant's PAR exceeded optMax. Behavioural invariants are
 *     listed under LIGHT_RESPONSE_INVARIANTS.
 * 1.1.1 (2026-11-12) ENVELOPE_RULE corrected to the 1.0 engine's actual light
 *   axis (upper plateau 0.7). Documentation-only; outputs unchanged.
 * 1.1.0 (2026-11-12, additive — 1.0 consumers keep working)
 *   - PlantFrame.parAtPlant is now documented as what 1.0 actually emitted:
 *     PAR at the top of the plant while the light is ON. New field
 *     PlantFrame.parDailyMean = parAtPlant × photoperiodH / 24.
 *   - Frame.substrate (optional): per-cell aquasoil reserve remaining, 0..1.
 *   - WorkerResponse "cancelled" acknowledges a "cancel" request.
 *   - Event semantics pinned down (see SimEvent).
 *   - Envelope rule pinned down (see ENVELOPE_RULE).
 */

/**
 * How a botany 3-point range {min, opt, max} becomes the trapezoidal fitness
 * envelope (1.1 makes the 1.0 behaviour normative; see engine.envelopeAxis):
 *   optMin = opt − 0.3 × (opt − min),  optMax = opt + u × (max − opt)
 *   where u = 0.3 for every axis except light, which uses u = 0.7 (plants
 *   tolerate PAR above opt far better than below it).
 *   Non-light axes: fitness = 0 at x ≤ min or x ≥ max, 1 on [optMin, optMax],
 *   linear ramps between.
 *   Light axis (1.2.0): fitness = 0 at x ≤ min, linear ramp up to 1 at optMin,
 *   1 on [optMin, optMax], linear ramp down from 1 at optMax to
 *   LIGHT_UPPER_FLOOR at max, and LIGHT_UPPER_FLOOR for every x ≥ max
 *   (never 0 on the high side).
 * Implementations that deviate must bump CONTRACT_VERSION.
 */
export const ENVELOPE_RULE = "trapezoid-plateau-0.3-light-upper-0.7-floor" as const;

/** Light-axis score for PAR at or above the species' `light.max` (1.2.0). */
export const LIGHT_UPPER_FLOOR = 0.75 as const;

/**
 * Behavioural invariants every engine release must satisfy (1.2.0), checked by
 * the "light response" test suite on the Dutch 60-P reference scenario
 * (60×30×36 cm, Dutch Streets template, 90 days, surface PAR Low 100 /
 * Medium 200 / High 320, CO2 off 5 ppm / on 25 ppm), total day-90 biomass B:
 *   1. With CO2:    B(High) ≥ B(Medium) > B(Low).
 *   2. Without CO2: 0.8 × B(Medium) ≤ B(High) ≤ 1.15 × B(Medium)  (plateau, no
 *      halving), and B(Medium) > B(Low).
 *   3. CO2 on > CO2 off at every light level.
 *   4. No "melt" event caused solely by light ≥ `light.max` (a plant whose only
 *      envelope score < 1 is the light axis on its upper side never melts).
 */
export const LIGHT_RESPONSE_INVARIANTS = [
  "co2-on: High >= Medium > Low",
  "co2-off: 0.8*Medium <= High <= 1.15*Medium, Medium > Low",
  "co2-on > co2-off at every light level",
  "no melt from light above max alone",
] as const;

export interface TankDims {
  /** inner width along x, cm */
  widthCm: number;
  /** inner depth along z, cm */
  depthCm: number;
  /** water column height along y, cm (substrate surface at y = 0) */
  heightCm: number;
}

export interface LightInput {
  /** PAR at the water surface directly under the fixture */
  surfacePar: number;
  /** hours of light per day */
  photoperiodH: number;
  /** fraction of the tank footprint lit by the fixture, 0..1 (centred on x, z) */
  coverage: number;
}

export interface WaterInput {
  temperatureC: number;
  pH: number;
  /** °dGH */
  gh: number;
  /** °dKH */
  kh: number;
  co2Ppm: number;
}

/** Daily dosing, mg/L added per day (averaged weekly schedules are fine). */
export interface DosingInput {
  no3: number;
  po4: number;
  k: number;
  fe: number;
}

export interface NutrientPool {
  no3: number;
  po4: number;
  k: number;
  fe: number;
}

export type SubstrateType = "aquasoil" | "inert";

export interface SubstrateInput {
  type: SubstrateType;
  /**
   * Multiplier on the default per-cell nutrient reserve (1 = fresh aquasoil).
   * Ignored (treated as ~0) for "inert".
   */
  reserve: number;
}

export interface PlantPlacement {
  /** unique instance id */
  id: string;
  /** botany id, e.g. "hemianthus-callitrichoides-cuba" */
  speciesId: string;
  x: number;
  z: number;
  /** base height above substrate (0 for planted; >0 for epiphytes on hardscape) */
  y: number;
  /** number of pots / portions planted at this spot, ≥1 */
  portions: number;
}

/** Subset of a botany plants.json record that the engine reads. */
export interface SpeciesRecord {
  id: string;
  scientificName: string;
  growthForm: string;
  envelope: {
    light: { min: number; opt: number; max: number };
    co2: { min: number; opt: number; max: number };
    temperatureC: { min: number; opt: number; max: number };
    pH: { min: number; opt: number; max: number };
    gh: { min: number; opt: number; max: number };
    kh: { min: number; opt: number; max: number };
  };
  nutrients: {
    rootFeeder: boolean;
    waterColumnFeeder: boolean;
    macros?: Record<string, string>;
    micros?: Record<string, string>;
  };
  growth: {
    rate: string;
    maxHeightCm: number;
    maxSpreadCm: number;
  };
  sim?: Record<string, number>;
  [extra: string]: unknown;
}

export interface SimInput {
  tank: TankDims;
  light: LightInput;
  water: WaterInput;
  dosing: DosingInput;
  plants: PlantPlacement[];
  /** species records keyed by id (only those referenced by plants are required) */
  species: Record<string, SpeciesRecord>;
  /** number of simulated days; frames are emitted for day 0..days inclusive */
  days: number;
  /** PRNG seed; identical input ⇒ bit-identical output */
  seed: number;
  /** light-grid resolution along x; nz derived from tank aspect ratio (≥1) */
  gridX: number;
  /** water-column nutrients at day 0, mg/L (defaults applied when omitted) */
  initialNutrients?: Partial<NutrientPool>;
  /** default { type: "aquasoil", reserve: 1 } */
  substrate?: SubstrateInput;
  /** PAR below which a grid cell is flagged low-light; default 30 */
  lowLightPar?: number;
}

export type LimitingFactor =
  | "light" | "co2" | "temperature" | "pH" | "gh" | "kh"
  | "no3" | "po4" | "k" | "fe" | "space";

export interface PlantFrame {
  id: string;
  biomassG: number;
  heightCm: number;
  /** footprint diameter, cm */
  spreadCm: number;
  /** 0..1 */
  health: number;
  /** PAR at the top of this plant while the light is ON (µmol·m⁻²·s⁻¹) */
  parAtPlant: number;
  /** 1.1: daily-mean PAR at the top of this plant = parAtPlant × photoperiodH / 24.
   *  Optional so 1.0 producers stay valid; the 1.1 engine always sets it. */
  parDailyMean?: number;
  /** factors currently limiting growth, most-limiting first; empty when unconstrained */
  limiting: LimitingFactor[];
}

export interface LightGrid {
  nx: number;
  nz: number;
  /** row-major [iz * nx + ix], PAR at substrate level after canopy shading */
  par: Float32Array;
}

export type SimEventType = "shaded" | "overtaken" | "deficiency" | "melt" | "trimNeeded";

/**
 * Event semantics (1.1):
 * - Each event is emitted once, on the day it is first raised.
 * - "deficiency" is de-duplicated per (plantId, nutrient): it is raised again
 *   only after that plant has been free of that deficiency for ≥ 7 days.
 * - "shaded" / "overtaken" / "trimNeeded" follow the same 7-day re-arm rule
 *   per (plantId, detail).
 * - "melt" is raised at most once per plant per run.
 */
export interface SimEvent {
  type: SimEventType;
  day: number;
  /** plant instance id */
  plantId: string;
  /** e.g. overtaking plant id, or nutrient name for "deficiency" */
  detail?: string;
}

/** 1.1: aquasoil reserve remaining per light-grid cell (same nx/nz as LightGrid). */
export interface SubstrateGrid {
  nx: number;
  nz: number;
  /** row-major [iz * nx + ix], fraction of the day-0 reserve left, 0..1 (all 0 for inert) */
  reserve: Float32Array;
}

export interface Frame {
  day: number;
  water: NutrientPool & { co2Ppm: number };
  plants: PlantFrame[];
  light: LightGrid;
  /** events first raised on this day */
  events: SimEvent[];
  /** 1.1: optional so 1.0 producers remain valid; the 1.1 engine always sets it */
  substrate?: SubstrateGrid;
}

export interface SimSummary {
  totalBiomassG: number[];
  /** fraction of grid cells below lowLightPar on the final day */
  lowLightFraction: number;
  eventCounts: Record<SimEventType, number>;
}

export interface SimResult {
  frames: Frame[];
  lowLightPar: number;
  summary: SimSummary;
}

/* ---------------- Web Worker protocol ---------------- */

export type WorkerRequest =
  | { type: "run"; requestId: number; input: SimInput }
  | { type: "cancel"; requestId: number };

export type WorkerResponse =
  | { type: "frame"; requestId: number; frame: Frame }
  | { type: "done"; requestId: number; result: SimResult; elapsedMs: number }
  | { type: "error"; requestId: number; message: string }
  /** 1.1: sent once after a "cancel" for a run that was still in flight; no further messages for that requestId */
  | { type: "cancelled"; requestId: number };
