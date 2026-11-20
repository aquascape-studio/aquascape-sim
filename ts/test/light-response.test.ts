/**
 * Contract 1.2.0 — light axis floor + LIGHT_RESPONSE_INVARIANTS on the Dutch
 * 60-P reference scenario (aquascape-sim#8).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  Engine, LIGHT_RESPONSE_INVARIANTS, LIGHT_UPPER_FLOOR, LightAxis, envelopeAxis, lightEnvelopeAxis, simulate,
} from "../src";
import { summarize } from "../src/engine";
import type { Frame, SimInput } from "../src/contract";

const FIXTURE: { input: SimInput } = JSON.parse(
  readFileSync(new URL("./fixtures/dutch60p.json", import.meta.url), "utf8"),
);
const BASE = FIXTURE.input;
const LIGHT = { Low: 100, Medium: 200, High: 320 } as const;
const CO2 = { off: 5, on: 25 } as const;
type Level = keyof typeof LIGHT;
type Co2 = keyof typeof CO2;

function scenario(level: Level, co2: Co2): SimInput {
  return {
    ...BASE,
    light: { ...BASE.light, surfacePar: LIGHT[level] },
    water: { ...BASE.water, co2Ppm: CO2[co2] },
  };
}

interface Run {
  b90: number;
  melts: number;
  /** melt events of plants for which light on its upper side was the only sub-1 factor */
  lightOnlyMelts: string[];
  /** plant-days on which health fell while light-above-optMax was the only sub-1 factor */
  lightOnlyHealthDrops: number;
}

/**
 * Drive the Engine day by day so per-plant envelope / nutrient scores can be
 * inspected. Invariant 4: a plant whose only envelope score < 1 is the light
 * axis on its upper side (PAR > optMax) must never lose health or melt.
 */
function run(level: Level, co2: Co2): Run {
  const e = new Engine(scenario(level, co2));
  const frames: Frame[] = [e.start()];
  // Per plant: has it ever been stressed by anything other than light-upper?
  const otherStress = new Set<string>();
  let lightOnlyHealthDrops = 0;
  for (let d = 1; d <= BASE.days; d++) {
    const before = e.plants.map((p) => p.health);
    frames.push(e.step());
    for (const p of e.plants) {
      const lightUpperOnly =
        p.par > p.axes.light.optMax &&
        p.envScores.slice(1).every((s) => s === 1) &&
        p.nutLim === 1;
      const lightLower = p.par < p.axes.light.optMin;
      const otherSub1 = p.envScores.slice(1).some((s) => s < 1) || p.nutLim < 1 || lightLower;
      if (otherSub1) otherStress.add(p.id);
      if (lightUpperOnly && p.health < before[p.idx]) lightOnlyHealthDrops++;
    }
  }
  const r = summarize(frames, e.lowLightPar);
  const lightOnlyMelts = frames
    .flatMap((f) => f.events)
    .filter((ev) => ev.type === "melt" && !otherStress.has(ev.plantId))
    .map((ev) => ev.plantId);
  return { b90: r.summary.totalBiomassG[BASE.days], melts: r.summary.eventCounts.melt, lightOnlyMelts, lightOnlyHealthDrops };
}

describe("light axis floor (contract 1.2.0 ENVELOPE_RULE)", () => {
  const cases = [
    { min: 40, opt: 70, max: 110 },
    { min: 100, opt: 160, max: 240 },
    { min: 0, opt: 15, max: 30 },
  ];

  it("LIGHT_UPPER_FLOOR is 0.75", () => {
    expect(LIGHT_UPPER_FLOOR).toBe(0.75);
  });

  it("score 1 on [optMin, optMax], 0.75 at max and at any PAR ≥ max", () => {
    for (const e of cases) {
      const ax = lightEnvelopeAxis(e);
      expect(ax).toBeInstanceOf(LightAxis);
      const optMin = e.opt - 0.3 * (e.opt - e.min);
      const optMax = e.opt + 0.7 * (e.max - e.opt);
      expect(ax.optMin).toBeCloseTo(optMin, 12);
      expect(ax.optMax).toBeCloseTo(optMax, 12);
      expect(ax.score(e.opt)).toBe(1);
      expect(ax.score(optMin)).toBeCloseTo(1, 12);
      expect(ax.score(optMax)).toBe(1);
      expect(ax.score(e.max)).toBe(LIGHT_UPPER_FLOOR);
      expect(ax.score(2 * e.max)).toBe(LIGHT_UPPER_FLOOR);
      expect(ax.score(1e6)).toBe(LIGHT_UPPER_FLOOR);
      // linear ramp 1 → 0.75 between optMax and max
      expect(ax.score((optMax + e.max) / 2)).toBeCloseTo((1 + LIGHT_UPPER_FLOOR) / 2, 12);
      expect(ax.score(optMax + 0.01 * (e.max - optMax))).toBeLessThan(1);
      expect(ax.score(optMax + 0.01 * (e.max - optMax))).toBeGreaterThan(LIGHT_UPPER_FLOOR);
    }
  });

  it("upper side is monotonic non-increasing and never below the floor", () => {
    const e = cases[0];
    const ax = lightEnvelopeAxis(e);
    let prev = 1;
    for (let x = ax.optMax; x <= 3 * e.max; x += 0.5) {
      const s = ax.score(x);
      expect(s).toBeLessThanOrEqual(prev + 1e-15);
      expect(s).toBeGreaterThanOrEqual(LIGHT_UPPER_FLOOR);
      prev = s;
    }
  });

  it("lower side unchanged: identical to the plain trapezoid Axis below optMax", () => {
    for (const e of cases) {
      const light = lightEnvelopeAxis(e);
      const plain = envelopeAxis(e, 0.3, 0.7);
      for (let i = -10; i <= 100; i++) {
        const x = e.min + ((plain.optMax - e.min) * i) / 100;
        expect(light.score(x)).toBe(plain.score(x));
      }
      expect(light.score(e.min)).toBe(0);
      if (e.min > 0) expect(light.score(e.min - 1)).toBe(0);
      expect(light.score((e.min + light.optMin) / 2)).toBeCloseTo(0.5, 12);
    }
  });

  it("the engine uses it for light only (other axes still score 0 at max)", () => {
    const sp = Object.values(BASE.species)[0];
    const e = new Engine({ ...BASE, days: 0 });
    const p = e.plants.find((q) => q.sp.id === sp.id)!;
    expect(p.axes.light).toBeInstanceOf(LightAxis);
    expect(p.axes.light.score(sp.envelope.light.max * 2)).toBe(LIGHT_UPPER_FLOOR);
    for (const k of ["co2", "temperatureC", "pH", "gh", "kh"]) {
      expect(p.axes[k]).not.toBeInstanceOf(LightAxis);
      expect(p.axes[k].score(sp.envelope[k as "co2"].max)).toBe(0);
    }
  });

  it("a plant at 2–4× light.max with everything else optimal never loses health or melts", () => {
    const sp = BASE.species["limnophila-aromatica"];
    const env = sp.envelope;
    const H = 32;
    const input: SimInput = {
      ...BASE,
      tank: { widthCm: 30, depthCm: 30, heightCm: H },
      // PAR at the plant top: ≈ 2.3 × light.max on day 0 (14 cm cutting), 4 × once it reaches the surface
      light: { surfacePar: 4 * env.light.max, photoperiodH: 8, coverage: 1 },
      water: {
        temperatureC: env.temperatureC.opt, pH: env.pH.opt, gh: env.gh.opt, kh: env.kh.opt, co2Ppm: env.co2.opt,
      },
      plants: [{ id: "solo", speciesId: sp.id, x: 0, z: 0, y: 0, portions: 1 }],
      species: { [sp.id]: sp },
      days: 90,
    };
    const e = new Engine(input);
    e.start();
    expect(e.plants[0].par).toBeGreaterThan(2 * env.light.max);
    const events: string[] = [];
    for (let d = 1; d <= 90; d++) {
      const f = e.step();
      events.push(...f.events.map((ev) => ev.type));
      expect(e.plants[0].envScores[0]).toBe(LIGHT_UPPER_FLOOR);
      expect(e.plants[0].health).toBe(1);
    }
    expect(events).not.toContain("melt");
    expect(e.plants[0].biomass).toBeGreaterThan(e.plants[0].bMax * 0.5);
  });
});

describe("light response — Dutch 60-P reference (contract 1.2.0 LIGHT_RESPONSE_INVARIANTS)", () => {
  const R: Record<Co2, Record<Level, Run>> = {
    on: { Low: run("Low", "on"), Medium: run("Medium", "on"), High: run("High", "on") },
    off: { Low: run("Low", "off"), Medium: run("Medium", "off"), High: run("High", "off") },
  };
  const B = (c: Co2, l: Level) => R[c][l].b90;

  it("fixture is the web's Dutch Streets 60-P scape", () => {
    expect(LIGHT_RESPONSE_INVARIANTS).toHaveLength(4);
    expect(BASE.tank).toEqual({ widthCm: 60, depthCm: 30, heightCm: 32 });
    expect(BASE.days).toBe(90);
    expect(BASE.plants).toHaveLength(42);
    expect(Object.keys(BASE.species)).toHaveLength(11);
    console.log(
      "[light-response] day-90 biomass g " +
        (["on", "off"] as Co2[])
          .map((c) => `CO2 ${c}: ` + (Object.keys(LIGHT) as Level[]).map((l) => `${l} ${B(c, l).toFixed(1)}`).join(" / "))
          .join(" | "),
    );
  });

  it("1. CO2 on: High ≥ Medium > Low", () => {
    expect(B("on", "High")).toBeGreaterThanOrEqual(B("on", "Medium"));
    expect(B("on", "Medium")).toBeGreaterThan(B("on", "Low"));
  });

  it("2. CO2 off: 0.8·Medium ≤ High ≤ 1.15·Medium, Medium > Low", () => {
    expect(B("off", "High")).toBeGreaterThanOrEqual(0.8 * B("off", "Medium"));
    expect(B("off", "High")).toBeLessThanOrEqual(1.15 * B("off", "Medium"));
    expect(B("off", "Medium")).toBeGreaterThan(B("off", "Low"));
  });

  it("3. CO2 on > CO2 off at every light level", () => {
    for (const l of Object.keys(LIGHT) as Level[]) expect(B("on", l)).toBeGreaterThan(B("off", l));
  });

  it("4. no melt caused solely by light ≥ light.max", () => {
    for (const c of ["on", "off"] as Co2[]) {
      for (const l of Object.keys(LIGHT) as Level[]) {
        expect(R[c][l].lightOnlyMelts, `${c}/${l}`).toEqual([]);
        expect(R[c][l].lightOnlyHealthDrops, `${c}/${l}`).toBe(0);
      }
    }
  });

  it("fixture run is deterministic", () => {
    const a = simulate(scenario("High", "on")).summary.totalBiomassG;
    expect(a[BASE.days]).toBe(B("on", "High"));
  });
});
