/**
 * Spatial growth engine built on the 1:1 algo ports.
 *
 * Coordinates follow the contract: origin at the centre of the tank floor,
 * x left→right, z back→front, y up, all cm. One step = one day.
 *
 * Per day:
 *   1. grow every plant from the light / fitness / nutrient state evaluated at
 *      the end of the previous day (photosynthesis × fitness × health),
 *   2. nutrient uptake (water column + substrate cells), substrate release,
 *      dosing, first-order water-column losses,
 *   3. rebuild footprints + light grid (Beer-Lambert + canopy shading),
 *   4. evaluate per-plant scores / limiting factors, raise events, emit frame.
 */

import type {
  Frame,
  LimitingFactor,
  NutrientPool,
  PlantFrame,
  PlantPlacement,
  SimEvent,
  SimEventType,
  SimInput,
  SimResult,
  SpeciesRecord,
} from "./contract";
import { Axis, compat } from "./algo/envelope";
import { K_WATER, parAtDepth } from "./algo/light";
import { Reservoir } from "./algo/nutrients";
import { co2Response, piCurve, temperatureResponse } from "./algo/photosynthesis";
import { createPrng } from "./prng";

/* ------------------------------------------------------------------------ */
/* Tunables (documented in README)                                          */
/* ------------------------------------------------------------------------ */

/** canopy extinction per g of biomass per cm² of footprint */
export const K_SHADE = 2.5;
/** soft fall-off length (cm) of surface PAR outside the lit footprint */
export const LIGHT_FALLOFF_CM = 6;
/** max relative growth rate (per day) at k_photosynthesis = 1, everything optimal, 8 h light */
export const RGR_MAX = 0.12;
/** reference photoperiod (h) for which RGR_MAX is defined */
export const REF_PHOTOPERIOD_H = 8;
/** fresh-mass packing density used to derive the biomass carrying capacity, g/cm³ */
export const BIOMASS_DENSITY = 0.02;
/** fraction of the carrying capacity a freshly planted portion starts at */
export const START_FRACTION = 0.12;
export const DEFAULT_LOW_LIGHT_PAR = 30;

/** nutrient order used throughout: no3, po4, k, fe */
export const NUTRIENTS = ["no3", "po4", "k", "fe"] as const;
export type NutrientKey = (typeof NUTRIENTS)[number];
const NN = 4;

/** optimal tissue content, mg per g biomass (medium demand) */
const Q_OPT_BASE = [0.5, 0.06, 0.3, 0.005];
const DEMAND_MULT: Record<string, number> = { low: 0.6, medium: 1.0, high: 1.5, "very-high": 2.0 };
/** water-column first-order loss per day (denitrification, precipitation, Fe oxidation) */
const WATER_DECAY = [0.03, 0.03, 0.02, 0.15];
/** half-saturation concentration for uptake from water, mg/L */
const WATER_KM = [1.0, 0.05, 1.0, 0.02];
/** fresh aquasoil reserve, mg per cm² of substrate footprint (reserve = 1) */
export const SUBSTRATE_RESERVE_PER_CM2 = [1.2, 0.12, 1.2, 0.036];
/** substrate half-saturation as a fraction of the fresh reserve */
const SUBSTRATE_KM_FRAC = 0.15;
/** aquasoil release to the water column: fraction of the fresh reserve per day while above KNEE */
const SUBSTRATE_RELEASE = 0.01;
const SUBSTRATE_KNEE = 0.3;
/** luxury tissue quota plants refill toward, and max daily refill (fraction of optimal content) */
const Q_LUX = 1.0;
const UPTAKE_MAX_FRAC = 0.3;
/** tissue turnover per day (leaf shedding) */
const TURNOVER = 0.02;
/** quota at which a nutrient becomes fully sufficient (score 1) */
const Q_SUFFICIENT = 0.6;
/** quota below which a "deficiency" event is raised */
const Q_DEFICIENT = 0.5;
/** max share of a pool all plants can draw in one day */
const POOL_DRAW_MAX = 0.5;

/** consecutive condition-free days after which an event key re-arms (contract 1.1) */
export const RE_ARM_DAYS = 7;

const LIMIT_THRESHOLD = 0.8;
const LIMITING_ORDER: LimitingFactor[] = [
  "light", "co2", "temperature", "pH", "gh", "kh", "no3", "po4", "k", "fe", "space",
];
const ENV_KEYS = ["light", "co2", "temperatureC", "pH", "gh", "kh"] as const;

const H0_FRAC: Record<string, number> = {
  stem: 0.35, rosette: 0.45, carpeting: 0.5, epiphyte: 0.5, moss: 0.5, floating: 0.6,
};
const S0_FRAC: Record<string, number> = { carpeting: 0.3, moss: 0.3, floating: 0.3 };
const SHADE_FORM_FACTOR: Record<string, number> = { floating: 2.0, moss: 0.6, carpeting: 0.8 };

/* ------------------------------------------------------------------------ */

/** {min, opt, max} botany envelope → trapezoid with a plateau around opt. */
export function envelopeAxis(
  e: { min: number; opt: number; max: number },
  lowerPlateau = 0.3,
  upperPlateau = 0.3,
): Axis {
  const optMin = e.opt - lowerPlateau * (e.opt - e.min);
  const optMax = e.opt + upperPlateau * (e.max - e.opt);
  return new Axis(e.min, optMin, optMax, e.max);
}

/** Canopy transmission for an overhead load of `loadGPerCm2` g/cm². */
export function canopyTransmission(loadGPerCm2: number): number {
  return Math.exp(-K_SHADE * Math.max(0, loadGPerCm2));
}

const nutrientAxis = new Axis(0, Q_SUFFICIENT, 1e9, 1e9 + 1);

interface PlantRt {
  idx: number;
  id: string;
  place: PlantPlacement;
  sp: SpeciesRecord;
  form: string;
  stem: boolean;
  floating: boolean;
  rootFeeder: boolean;
  /** 0 = no substrate access (epiphyte on hardscape, moss, floating) */
  rooted: boolean;
  axes: Record<string, Axis>;
  kPhoto: number;
  kLight: number;
  kCo2: number;
  tOpt: number;
  tTol: number;
  jitter: number;
  shadeFactor: number;
  hTarget: number;
  h0: number;
  sMax: number;
  s0: number;
  bMax: number;
  biomass: number;
  height: number;
  spread: number;
  health: number;
  qOpt: number[];
  /** tissue quota relative to optimal, per nutrient */
  q: number[];
  cells: number[];
  load: number;
  top: number;
  parSum: number;
  par: number;
  shaders: Set<number>;
  lowLightDays: number;
  /**
   * Event de-duplication state, keyed `${type}|${detail ?? ""}` → last day the
   * condition was observed true. A key re-raises only after ≥ RE_ARM_DAYS
   * consecutive days without the condition (melt: never, see events()).
   */
  evLast: Map<string, number>;
  // evaluation results
  envScores: number[];
  fitness: number;
  nutScores: number[];
  nutLim: number;
  space: number;
  limiting: LimitingFactor[];
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export class Engine {
  readonly input: SimInput;
  readonly nx: number;
  readonly nz: number;
  readonly cellW: number;
  readonly cellD: number;
  readonly cellArea: number;
  readonly volumeL: number;
  readonly lowLightPar: number;
  readonly plants: PlantRt[];
  /** surface PAR per cell (static) */
  readonly surface: Float64Array;
  /** substrate PAR per cell, current day */
  readonly substratePar: Float64Array;
  /** substrate reserves, [n * ncell + c], mg */
  readonly substrate: Float64Array;
  readonly substrate0: Float64Array;
  /** water column, mg/L */
  readonly water: number[];
  readonly dose: number[];
  readonly photoScale: number;
  /** photoperiod used for parDailyMean (h/day) */
  readonly photoperiodH: number;
  day = 0;
  private cellPlants: number[][];
  private readonly ncell: number;

  constructor(input: SimInput) {
    this.input = input;
    const { tank } = input;
    const W = Math.max(1e-3, tank.widthCm);
    const D = Math.max(1e-3, tank.depthCm);
    this.nx = Math.max(1, Math.round(num(input.gridX, 16)));
    this.nz = Math.max(1, Math.round((this.nx * D) / W));
    this.ncell = this.nx * this.nz;
    this.cellW = W / this.nx;
    this.cellD = D / this.nz;
    this.cellArea = this.cellW * this.cellD;
    this.volumeL = (W * D * Math.max(1e-3, tank.heightCm)) / 1000;
    this.lowLightPar = num(input.lowLightPar, DEFAULT_LOW_LIGHT_PAR);
    this.photoperiodH = Math.min(24, Math.max(0, num(input.light.photoperiodH, 8)));
    this.photoScale = Math.min(1.5, Math.max(0, num(input.light.photoperiodH, 8) / REF_PHOTOPERIOD_H));

    // Surface PAR with centred coverage footprint + soft fall-off.
    const cov = Math.min(1, Math.max(0.01, num(input.light.coverage, 1)));
    const halfW = (Math.sqrt(cov) * W) / 2;
    const halfD = (Math.sqrt(cov) * D) / 2;
    this.surface = new Float64Array(this.ncell);
    for (let iz = 0; iz < this.nz; iz++) {
      const z = -D / 2 + (iz + 0.5) * this.cellD;
      const dz = Math.max(0, Math.abs(z) - halfD);
      for (let ix = 0; ix < this.nx; ix++) {
        const x = -W / 2 + (ix + 0.5) * this.cellW;
        const dx = Math.max(0, Math.abs(x) - halfW);
        const d = Math.sqrt(dx * dx + dz * dz) / LIGHT_FALLOFF_CM;
        this.surface[iz * this.nx + ix] = Math.max(0, input.light.surfacePar) * Math.exp(-d * d);
      }
    }
    this.substratePar = new Float64Array(this.ncell);

    // Water column (Python Reservoir defaults) and dosing.
    const res = new Reservoir();
    const init = input.initialNutrients ?? {};
    this.water = [
      num(init.no3, res.no3), num(init.po4, res.po4), num(init.k, res.k), num(init.fe, res.fe),
    ];
    this.dose = NUTRIENTS.map((n) => Math.max(0, num(input.dosing?.[n], 0)));

    // Substrate reserve.
    const sub = input.substrate ?? { type: "aquasoil", reserve: 1 };
    const mult = sub.type === "aquasoil" ? Math.max(0, num(sub.reserve, 1)) : 0;
    this.substrate = new Float64Array(NN * this.ncell);
    for (let n = 0; n < NN; n++) {
      this.substrate.fill(SUBSTRATE_RESERVE_PER_CM2[n] * this.cellArea * mult, n * this.ncell, (n + 1) * this.ncell);
    }
    this.substrate0 = this.substrate.slice();

    this.cellPlants = Array.from({ length: this.ncell }, () => []);

    const rng = createPrng(input.seed);
    this.plants = input.plants.map((pl, idx) => this.makePlant(pl, idx, rng.range(0.92, 1.08)));
  }

  private makePlant(place: PlantPlacement, idx: number, jitter: number): PlantRt {
    const sp = this.input.species[place.speciesId];
    if (!sp) throw new Error(`unknown species "${place.speciesId}" for plant "${place.id}"`);
    const H = this.input.tank.heightCm;
    const form = sp.growthForm;
    const stem = form === "stem";
    const floating = form === "floating";
    const y = Math.max(0, num(place.y, 0));
    const portions = Math.max(1, num(place.portions, 1));
    const sim = sp.sim ?? {};
    const maxH = Math.max(0.5, sp.growth.maxHeightCm);
    const room = Math.max(0.5, H - y);
    const hTarget = floating ? maxH : Math.min(stem ? 1.15 * maxH : maxH, room);
    const h0 = Math.min(hTarget, (H0_FRAC[form] ?? 0.4) * maxH);
    const sMax = Math.max(0.5, sp.growth.maxSpreadCm) * Math.sqrt(portions);
    const s0 = (S0_FRAC[form] ?? 0.45) * sMax;
    const bMax = Math.max(0.5, BIOMASS_DENSITY * hTarget * Math.PI * (sMax / 2) ** 2);
    const axes: Record<string, Axis> = {};
    // Light above opt is rarely harmful until close to max: wider upper plateau.
    for (const k of ENV_KEYS) axes[k] = k === "light" ? envelopeAxis(sp.envelope[k], 0.3, 0.7) : envelopeAxis(sp.envelope[k]);
    const macros = sp.nutrients.macros ?? {};
    const micros = sp.nutrients.micros ?? {};
    const dm = (s: string | undefined) => DEMAND_MULT[s ?? "medium"] ?? 1;
    const demand = [
      dm(macros.nitrogenDemand), dm(macros.phosphorusDemand), dm(macros.potassiumDemand), dm(micros.ironDemand),
    ];
    const tOpt = num(sim.preferred_temp_c, sp.envelope.temperatureC.opt);
    return {
      idx, id: place.id, place, sp, form, stem, floating,
      rootFeeder: !!sp.nutrients.rootFeeder,
      rooted: !floating && form !== "moss" && !(form === "epiphyte") && y <= 0.5,
      axes,
      kPhoto: num(sim.k_photosynthesis, 0.6),
      kLight: Math.max(1, num(sim.k_light, sp.envelope.light.opt * 0.6)),
      kCo2: Math.max(0.1, num(sim.k_co2, 10)),
      tOpt,
      tTol: Math.max(0.5, num(sim.temp_tolerance_c, 3)),
      jitter,
      shadeFactor: SHADE_FORM_FACTOR[form] ?? 1,
      hTarget, h0, sMax, s0, bMax,
      biomass: START_FRACTION * bMax,
      height: h0,
      spread: s0,
      health: 1,
      qOpt: Q_OPT_BASE.map((b, n) => b * demand[n]),
      q: [1, 1, 1, 1],
      cells: [],
      load: 0,
      top: 0,
      parSum: 0,
      par: 0,
      shaders: new Set(),
      lowLightDays: 0,
      evLast: new Map(),
      envScores: [1, 1, 1, 1, 1, 1],
      fitness: 1,
      nutScores: [1, 1, 1, 1],
      nutLim: 1,
      space: 1,
      limiting: [],
    };
  }

  /* -------------------------------- light -------------------------------- */

  private footprints(): void {
    const { nx, nz, cellW, cellD } = this;
    const W = this.input.tank.widthCm;
    const D = this.input.tank.depthCm;
    const H = this.input.tank.heightCm;
    for (const cp of this.cellPlants) cp.length = 0;
    for (const p of this.plants) {
      const r = p.spread / 2;
      const cx = p.place.x;
      const cz = p.place.z;
      p.cells.length = 0;
      const ix0 = Math.max(0, Math.floor((cx - r + W / 2) / cellW));
      const ix1 = Math.min(nx - 1, Math.floor((cx + r + W / 2) / cellW));
      const iz0 = Math.max(0, Math.floor((cz - r + D / 2) / cellD));
      const iz1 = Math.min(nz - 1, Math.floor((cz + r + D / 2) / cellD));
      for (let iz = iz0; iz <= iz1; iz++) {
        const z = -D / 2 + (iz + 0.5) * cellD;
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = -W / 2 + (ix + 0.5) * cellW;
          if ((x - cx) ** 2 + (z - cz) ** 2 <= r * r) p.cells.push(iz * nx + ix);
        }
      }
      if (p.cells.length === 0) {
        const ix = Math.min(nx - 1, Math.max(0, Math.floor((cx + W / 2) / cellW)));
        const iz = Math.min(nz - 1, Math.max(0, Math.floor((cz + D / 2) / cellD)));
        p.cells.push(iz * nx + ix);
      }
      p.load = (p.biomass * p.shadeFactor) / (p.cells.length * this.cellArea);
      p.top = p.floating ? H : Math.min(H, Math.max(0, p.place.y) + p.height);
      for (const c of p.cells) this.cellPlants[c].push(p.idx);
    }
  }

  private computeLight(): void {
    this.footprints();
    const H = this.input.tank.heightCm;
    const plants = this.plants;
    for (const p of plants) {
      p.parSum = 0;
      p.shaders.clear();
    }
    const byTop = (a: number, b: number) => plants[b].top - plants[a].top || a - b;
    for (let c = 0; c < this.ncell; c++) {
      const surf = this.surface[c];
      const list = this.cellPlants[c];
      if (list.length > 1) list.sort(byTop);
      let load = 0;
      for (let i = 0; i < list.length; i++) {
        const p = plants[list[i]];
        p.parSum += parAtDepth(surf, Math.max(0, H - p.top)) * canopyTransmission(load);
        for (let j = 0; j < i; j++) {
          const q = plants[list[j]];
          if (q.top > p.top + 1e-9) p.shaders.add(q.idx);
        }
        load += p.load;
      }
      this.substratePar[c] = parAtDepth(surf, H) * canopyTransmission(load);
    }
    for (const p of plants) p.par = p.parSum / p.cells.length;
  }

  /* ------------------------------ evaluation ----------------------------- */

  private evaluate(): void {
    const w = this.input.water;
    for (const p of this.plants) {
      const actuals: Record<string, number> = {
        light: p.par, co2: w.co2Ppm, temperatureC: w.temperatureC, pH: w.pH, gh: w.gh, kh: w.kh,
      };
      p.fitness = compat(p.axes, actuals);
      for (let i = 0; i < ENV_KEYS.length; i++) p.envScores[i] = p.axes[ENV_KEYS[i]].score(actuals[ENV_KEYS[i]]);
      let lim = 1;
      for (let n = 0; n < NN; n++) {
        p.nutScores[n] = nutrientAxis.score(p.q[n]);
        if (p.nutScores[n] < lim) lim = p.nutScores[n];
      }
      p.nutLim = lim;
      // Space: crowding by other substrate-level plants sharing footprint cells.
      let acc = 0;
      for (const c of p.cells) {
        let others = 0;
        for (const j of this.cellPlants[c]) {
          if (j !== p.idx && this.plants[j].rooted === p.rooted && !this.plants[j].floating) others++;
        }
        acc += 1 / (1 + 0.5 * others);
      }
      p.space = p.floating ? 1 : acc / p.cells.length;
      const scored: [LimitingFactor, number][] = [];
      const all = [...p.envScores, ...p.nutScores, p.space];
      for (let i = 0; i < LIMITING_ORDER.length; i++) {
        if (all[i] < LIMIT_THRESHOLD) scored.push([LIMITING_ORDER[i], all[i]]);
      }
      scored.sort((a, b) => a[1] - b[1]);
      p.limiting = scored.map((s) => s[0]);
    }
  }

  /* -------------------------------- growth ------------------------------- */

  private grow(): void {
    const w = this.input.water;
    const N = this.ncell;
    const V = this.volumeL;
    const waterReq = [0, 0, 0, 0];
    const subReq = new Float64Array(NN * N);
    // per plant requested amounts: water[n], substrate per-cell share[n]
    const reqW: number[][] = [];
    const reqS: number[][] = [];

    for (const p of this.plants) {
      const lightF = piCurve(p.par, 1 / p.kLight, 1.0);
      const co2F = co2Response(w.co2Ppm, w.pH, w.kh, p.kCo2);
      const tempF = Math.min(1, temperatureResponse(w.temperatureC, p.tOpt, 2.0, p.tTol));
      const vigor =
        lightF * co2F * tempF * p.fitness * p.nutLim * p.health * Math.sqrt(p.space) * this.photoScale * p.jitter;
      const rgr = RGR_MAX * p.kPhoto * vigor;
      const b0 = p.biomass;
      let b1 = b0 + b0 * rgr * Math.max(0, 1 - b0 / p.bMax);

      // Health (same rule as python run_tick), stress = fitness × nutrient sufficiency.
      const stress = p.fitness * p.nutLim;
      if (stress < 0.5) p.health = Math.max(0, p.health - 0.02 * (0.5 - stress) * 2.0);
      else p.health = Math.min(1, p.health + 0.005);
      b1 *= 1 - 0.05 * Math.max(0, 0.6 - p.health);
      p.biomass = b1;

      const prog = Math.min(1, Math.max(0, (b1 / p.bMax - START_FRACTION) / (1 - START_FRACTION)));
      p.height = Math.max(p.height, p.h0 + (p.hTarget - p.h0) * prog);
      p.spread = Math.max(p.spread, p.s0 + (p.sMax - p.s0) * prog);

      // Tissue: dilute by growth, turnover; request refill.
      const rw = [0, 0, 0, 0];
      const rs = [0, 0, 0, 0];
      const nc = p.cells.length;
      for (let n = 0; n < NN; n++) {
        const content = p.q[n] * p.qOpt[n] * b0 * (1 - TURNOVER);
        p.q[n] = content / (p.qOpt[n] * b1);
        const want = Math.min(UPTAKE_MAX_FRAC * p.qOpt[n] * b1, Math.max(0, Q_LUX * p.qOpt[n] * b1 - content));
        if (want <= 0) continue;
        const cw = this.water[n] / (this.water[n] + WATER_KM[n]);
        let subMean = 0;
        if (p.rooted) {
          for (const c of p.cells) subMean += this.substrate[n * N + c];
          subMean /= nc;
        }
        const km = SUBSTRATE_KM_FRAC * SUBSTRATE_RESERVE_PER_CM2[n] * this.cellArea;
        const cs = p.rooted ? subMean / (subMean + km) : 0;
        let fromS: number;
        let fromW: number;
        if (p.rootFeeder) {
          fromS = want * cs;
          fromW = (want - fromS) * cw;
        } else {
          fromW = want * cw;
          fromS = (want - fromW) * cs * 0.5;
        }
        rw[n] = fromW;
        rs[n] = fromS / nc;
        waterReq[n] += fromW;
        if (fromS > 0) for (const c of p.cells) subReq[n * N + c] += fromS / nc;
      }
      reqW.push(rw);
      reqS.push(rs);
    }

    // Scale requests to pool availability, then grant.
    const wScale = NUTRIENTS.map((_, n) => {
      const avail = POOL_DRAW_MAX * this.water[n] * V;
      return waterReq[n] > avail ? avail / waterReq[n] : 1;
    });
    const sScale = new Float64Array(NN * N);
    for (let i = 0; i < NN * N; i++) {
      const avail = POOL_DRAW_MAX * this.substrate[i];
      sScale[i] = subReq[i] > avail ? avail / subReq[i] : 1;
    }
    const waterUsed = [0, 0, 0, 0];
    for (const p of this.plants) {
      const rw = reqW[p.idx];
      const rs = reqS[p.idx];
      for (let n = 0; n < NN; n++) {
        let got = rw[n] * wScale[n];
        waterUsed[n] += got;
        if (rs[n] > 0) {
          for (const c of p.cells) {
            const g = rs[n] * sScale[n * N + c];
            this.substrate[n * N + c] -= g;
            got += g;
          }
        }
        p.q[n] += got / (p.qOpt[n] * p.biomass);
      }
    }

    // Water column: uptake, aquasoil release, dosing, first-order losses.
    for (let n = 0; n < NN; n++) {
      let release = 0;
      for (let c = 0; c < N; c++) {
        const i = n * N + c;
        const r0 = this.substrate0[i];
        if (r0 <= 0) continue;
        const r = this.substrate[i];
        const rel = Math.min(r, SUBSTRATE_RELEASE * r0 * Math.min(1, r / (SUBSTRATE_KNEE * r0)));
        this.substrate[i] = Math.max(0, r - rel);
        release += rel;
      }
      const mass = Math.max(0, this.water[n] * V - waterUsed[n]) + release;
      this.water[n] = Math.max(0, (mass / V) * (1 - WATER_DECAY[n]) + this.dose[n]);
    }
  }

  /* -------------------------------- events ------------------------------- */

  /**
   * Observe that condition (type, detail) holds for `p` today and raise the
   * event if its key is armed (contract 1.1 SimEvent semantics):
   *  - first observation in the run raises (unless `silent`, used for day-0
   *    overtaken so the initial layout never counts as overtaking);
   *  - later observations raise again only when the previous observation was
   *    ≥ RE_ARM_DAYS + 1 days ago, i.e. ≥ 7 consecutive condition-free days;
   *  - `once` keys (melt) never re-arm.
   */
  private observe(
    p: PlantRt, type: SimEventType, out: SimEvent[], detail?: string, once = false, silent = false,
  ): void {
    const key = detail === undefined ? type : `${type}|${detail}`;
    const last = p.evLast.get(key);
    p.evLast.set(key, this.day);
    if (silent) return;
    if (last !== undefined && (once || this.day - last - 1 < RE_ARM_DAYS)) return;
    const ev: SimEvent = { type, day: this.day, plantId: p.id };
    if (detail !== undefined) ev.detail = detail;
    out.push(ev);
  }

  private events(): SimEvent[] {
    const out: SimEvent[] = [];
    const H = this.input.tank.heightCm;
    for (const p of this.plants) {
      const lmin = p.sp.envelope.light.min;
      p.lowLightDays = p.par < lmin ? p.lowLightDays + 1 : 0;
      if (p.lowLightDays >= 3) this.observe(p, "shaded", out);
      // Overtaken, per overtaking plant: condition = q's top is above p in a
      // shared cell. Shaders present on day 0 are recorded silently, so a
      // plant is only "overtaken" by someone who rises above it later (or
      // again after ≥ 7 days of not being above it). Raised in idx order.
      if (p.shaders.size) {
        const sh = p.shaders.size > 1 ? [...p.shaders].sort((a, b) => a - b) : p.shaders;
        for (const j of sh) this.observe(p, "overtaken", out, this.plants[j].id, false, this.day === 0);
      }
      // Deficiency, per nutrient (NUTRIENTS order).
      for (let n = 0; n < NN; n++) {
        if (p.q[n] < Q_DEFICIENT) this.observe(p, "deficiency", out, NUTRIENTS[n]);
      }
      if (p.health < 0.3) this.observe(p, "melt", out, undefined, true);
      const top = Math.max(0, p.place.y) + p.height;
      if ((!p.floating && top >= 0.9 * H) || (p.stem && p.height >= p.sp.growth.maxHeightCm)) {
        this.observe(p, "trimNeeded", out);
      }
    }
    return out;
  }

  /* -------------------------------- frames ------------------------------- */

  private frame(events: SimEvent[]): Frame {
    const plants: PlantFrame[] = this.plants.map((p) => ({
      id: p.id,
      biomassG: p.biomass,
      heightCm: p.height,
      spreadCm: p.spread,
      health: p.health,
      parAtPlant: p.par,
      parDailyMean: (p.par * this.photoperiodH) / 24,
      limiting: p.limiting.slice(),
    }));
    const water: NutrientPool & { co2Ppm: number } = {
      no3: this.water[0], po4: this.water[1], k: this.water[2], fe: this.water[3],
      co2Ppm: this.input.water.co2Ppm,
    };
    return {
      day: this.day,
      water,
      plants,
      light: { nx: this.nx, nz: this.nz, par: Float32Array.from(this.substratePar) },
      events,
      substrate: { nx: this.nx, nz: this.nz, reserve: this.substrateReserve() },
    };
  }

  /**
   * Contract 1.1 Frame.substrate.reserve: per cell, the MEAN over the four
   * tracked nutrients (no3, po4, k, fe) of remaining / day-0 reserve, each
   * clamped to 0..1. Cells with no day-0 reserve (inert substrate) are 0.
   * Without dosing this is monotonic non-increasing (the pool only loses mass
   * to root uptake and release; nothing refills it).
   */
  private substrateReserve(): Float32Array {
    const N = this.ncell;
    const out = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      let s = 0;
      for (let n = 0; n < NN; n++) {
        const r0 = this.substrate0[n * N + c];
        if (r0 > 0) s += Math.min(1, Math.max(0, this.substrate[n * N + c] / r0));
      }
      out[c] = s / NN;
    }
    return out;
  }

  /** Day-0 frame (initial planting, no growth). */
  start(): Frame {
    this.day = 0;
    this.computeLight();
    this.evaluate();
    return this.frame(this.events());
  }

  /** Advance one day and return its frame. */
  step(): Frame {
    this.day += 1;
    this.grow();
    this.computeLight();
    this.evaluate();
    return this.frame(this.events());
  }

  /** Fraction of the fresh substrate reserve remaining, per nutrient (NaN for inert). */
  substrateRemaining(): Record<NutrientKey, number> {
    const out = {} as Record<NutrientKey, number>;
    const N = this.ncell;
    NUTRIENTS.forEach((k, n) => {
      let a = 0;
      let b = 0;
      for (let c = 0; c < N; c++) {
        a += this.substrate[n * N + c];
        b += this.substrate0[n * N + c];
      }
      out[k] = b > 0 ? a / b : Number.NaN;
    });
    return out;
  }

  /** Mean Beer-Lambert extinction used for substrate PAR (exposed for docs/tests). */
  static readonly kWater = K_WATER;
}

export function summarize(frames: Frame[], lowLightPar: number): SimResult {
  const eventCounts: Record<SimEventType, number> = {
    shaded: 0, overtaken: 0, deficiency: 0, melt: 0, trimNeeded: 0,
  };
  const totalBiomassG: number[] = [];
  for (const f of frames) {
    let s = 0;
    for (const p of f.plants) s += p.biomassG;
    totalBiomassG.push(s);
    for (const e of f.events) eventCounts[e.type]++;
  }
  const last = frames[frames.length - 1];
  let low = 0;
  if (last) for (let i = 0; i < last.light.par.length; i++) if (last.light.par[i] < lowLightPar) low++;
  return {
    frames,
    lowLightPar,
    summary: {
      totalBiomassG,
      lowLightFraction: last && last.light.par.length ? low / last.light.par.length : 0,
      eventCounts,
    },
  };
}
