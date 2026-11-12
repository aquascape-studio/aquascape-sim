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

export const CONTRACT_VERSION = "1.0.0" as const;

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
  /** daily-mean PAR received at the top of this plant */
  parAtPlant: number;
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

export interface SimEvent {
  type: SimEventType;
  day: number;
  /** plant instance id */
  plantId: string;
  /** e.g. overtaking plant id, or nutrient name for "deficiency" */
  detail?: string;
}

export interface Frame {
  day: number;
  water: NutrientPool & { co2Ppm: number };
  plants: PlantFrame[];
  light: LightGrid;
  /** events first raised on this day */
  events: SimEvent[];
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
  | { type: "error"; requestId: number; message: string };
