import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION, Engine, createPrng, createWorkerHandler, simulate, simulateIter,
  type SimInput, type WorkerResponse, type SimEvent,
} from "../src";
import { K_WATER } from "../src/algo";
import { SPECIES, typicalScape } from "./scenarios";

const firstFe = (input: SimInput): number | undefined => {
  for (const f of simulate(input).frames) {
    const e = f.events.find((ev) => ev.type === "deficiency" && ev.detail === "fe");
    if (e) return e.day;
  }
  return undefined;
};

describe("prng", () => {
  it("same seed ⇒ identical sequence; different seed ⇒ different", () => {
    const a = createPrng(123), b = createPrng(123), c = createPrng(124);
    const sa = Array.from({ length: 64 }, () => a.next());
    const sb = Array.from({ length: 64 }, () => b.next());
    const sc = Array.from({ length: 64 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    for (const v of sa) expect(v >= 0 && v < 1).toBe(true);
  });
});

describe("simulate — shape & determinism", () => {
  const input = typicalScape({ days: 30 });
  const r = simulate(input);

  it("emits frames for day 0..days inclusive", () => {
    expect(CONTRACT_VERSION).toBe("1.0.0");
    expect(r.frames).toHaveLength(31);
    r.frames.forEach((f, i) => expect(f.day).toBe(i));
    expect(r.summary.totalBiomassG).toHaveLength(31);
    expect(r.lowLightPar).toBe(30);
  });

  it("grid dims: nx = gridX, nz = round(gridX·depth/width)", () => {
    const f = r.frames[0];
    expect(f.light.nx).toBe(24);
    expect(f.light.nz).toBe(12);
    expect(f.light.par).toBeInstanceOf(Float32Array);
    expect(f.light.par.length).toBe(24 * 12);
    const thin = simulate({ ...input, days: 0, gridX: 3, tank: { widthCm: 100, depthCm: 10, heightCm: 40 } });
    expect(thin.frames[0].light.nz).toBe(1);
  });

  it("same input ⇒ bit-identical output", () => {
    const r2 = simulate(input);
    expect(r2.frames.length).toBe(r.frames.length);
    for (let i = 0; i < r.frames.length; i++) {
      expect(Buffer.from(r2.frames[i].light.par.buffer).equals(Buffer.from(r.frames[i].light.par.buffer))).toBe(true);
      expect(r2.frames[i].plants).toEqual(r.frames[i].plants);
      expect(r2.frames[i].water).toEqual(r.frames[i].water);
      expect(r2.frames[i].events).toEqual(r.frames[i].events);
    }
    const r3 = simulate({ ...input, seed: 7 });
    expect(r3.frames[30].plants[0].biomassG).not.toBe(r.frames[30].plants[0].biomassG);
  });

  it("simulateIter yields the same frames and returns the result", () => {
    const it = simulateIter(input);
    let n = 0;
    let res;
    for (;;) {
      const s = it.next();
      if (s.done) { res = s.value; break; }
      expect(s.value.plants).toEqual(r.frames[n].plants);
      n++;
    }
    expect(n).toBe(31);
    expect(res.summary).toEqual(r.summary);
  });

  it("plants grow and stay within species maxima", () => {
    const f = simulate({ ...input, days: 90 }).frames[90];
    let grew = 0;
    for (const p of f.plants) {
      const pl = input.plants.find((q) => q.id === p.id)!;
      const sp = SPECIES[pl.speciesId];
      if (p.biomassG > r.frames[0].plants.find((q) => q.id === p.id)!.biomassG) grew++;
      const capH = sp.growthForm === "stem" ? 1.15 * sp.growth.maxHeightCm : sp.growth.maxHeightCm;
      expect(p.heightCm).toBeLessThanOrEqual(capH + 1e-9);
      expect(p.spreadCm).toBeLessThanOrEqual(sp.growth.maxSpreadCm * Math.sqrt(pl.portions) + 1e-9);
      expect(p.health).toBeGreaterThanOrEqual(0);
      expect(p.health).toBeLessThanOrEqual(1);
    }
    expect(grew).toBeGreaterThan(f.plants.length * 0.6);
  });

  it("unknown species throws", () => {
    expect(() => simulate({ ...input, plants: [{ id: "x", speciesId: "nope", x: 0, z: 0, y: 0, portions: 1 }] }))
      .toThrow(/unknown species/);
  });
});

describe("light grid", () => {
  const base: SimInput = {
    ...typicalScape({ days: 0 }),
    plants: [],
    light: { surfacePar: 200, photoperiodH: 8, coverage: 1 },
  };

  it("empty tank: Beer-Lambert through the water column", () => {
    const par = simulate(base).frames[0].light.par;
    const expected = 200 * Math.exp(-K_WATER * 36);
    for (const v of par) expect(v).toBeCloseTo(expected, 3);
  });

  it("partial coverage: centred lit area, soft fall-off toward the edges", () => {
    const f = simulate({ ...base, light: { ...base.light, coverage: 0.4 } }).frames[0].light;
    const at = (ix: number, iz: number) => f.par[iz * f.nx + ix];
    const centre = at(12, 6);
    expect(centre).toBeCloseTo(200 * Math.exp(-K_WATER * 36), 3);
    expect(at(0, 6)).toBeLessThan(centre * 0.5);
    expect(at(0, 6)).toBeGreaterThan(0);
    // monotone fall-off along x from centre
    for (let ix = 12; ix > 0; ix--) expect(at(ix - 1, 6)).toBeLessThanOrEqual(at(ix, 6) + 1e-6);
  });

  it("canopy: taller plants shade shorter ones and the substrate", () => {
    const input: SimInput = {
      ...base,
      plants: [
        { id: "tall", speciesId: "hygrophila-corymbosa", x: 0, z: 0, y: 0, portions: 3 },
        { id: "short", speciesId: "cryptocoryne-parva", x: 0, z: 0, y: 0, portions: 1 },
      ],
    };
    const f = simulate(input).frames[0];
    const tall = f.plants.find((p) => p.id === "tall")!;
    const short = f.plants.find((p) => p.id === "short")!;
    const H = 36;
    expect(tall.parAtPlant).toBeCloseTo(200 * Math.exp(-K_WATER * (H - tall.heightCm)), 6);
    expect(short.parAtPlant).toBeLessThan(200 * Math.exp(-K_WATER * (H - short.heightCm)) * 0.95);
    const c = 6 * f.light.nx + 12;
    expect(f.light.par[c]).toBeLessThan(200 * Math.exp(-K_WATER * H) * 0.95);
    expect(f.light.par[0]).toBeCloseTo(200 * Math.exp(-K_WATER * H), 3);
  });
});

describe("nutrients & substrate", () => {
  it("aquasoil, zero dosing: no Fe deficiency through day 90", () => {
    const day = firstFe(typicalScape({ days: 90 }));
    console.log(`[fe] aquasoil first Fe deficiency: ${day ?? "none ≤ 90"}`);
    expect(day).toBeUndefined();
  });

  it("inert, zero dosing: Fe deficiency appears around day 30 (20–40)", () => {
    const day = firstFe(typicalScape({ days: 90, substrate: { type: "inert", reserve: 1 } }));
    console.log(`[fe] inert first Fe deficiency: day ${day}`);
    expect(day).toBeGreaterThanOrEqual(20);
    expect(day).toBeLessThanOrEqual(40);
  });

  it("Fe dosing on inert prevents the deficiency", () => {
    const day = firstFe(typicalScape({ days: 90, substrate: { type: "inert", reserve: 1 }, dosing: { no3: 0.5, po4: 0.05, k: 0.5, fe: 0.02 } }));
    expect(day).toBeUndefined();
  });

  it("aquasoil reserve depletes ~95% by ~day 120 under a typical planting", () => {
    const e = new Engine(typicalScape({ days: 120 }));
    e.start();
    const at = (d: number) => { while (e.day < d) e.step(); return e.substrateRemaining(); };
    const d60 = at(60);
    const d120 = at(120);
    for (const k of ["no3", "po4", "k", "fe"] as const) {
      expect(d60[k]).toBeGreaterThan(0.2);
      expect(1 - d120[k]).toBeGreaterThan(0.9);
      expect(1 - d120[k]).toBeLessThan(0.995);
    }
  });

  it("dosing raises the water column", () => {
    const a = simulate(typicalScape({ days: 20, substrate: { type: "inert", reserve: 1 } })).frames[20].water;
    const b = simulate(typicalScape({ days: 20, substrate: { type: "inert", reserve: 1 }, dosing: { no3: 1, po4: 0.1, k: 1, fe: 0.05 } })).frames[20].water;
    for (const k of ["no3", "po4", "k", "fe"] as const) expect(b[k]).toBeGreaterThan(a[k]);
  });
});

describe("limiting & events", () => {
  it("limiting lists valid factors ordered most-limiting first", () => {
    const r = simulate(typicalScape({ days: 60, substrate: { type: "inert", reserve: 1 } }));
    const valid = new Set(["light", "co2", "temperature", "pH", "gh", "kh", "no3", "po4", "k", "fe", "space"]);
    let saw = 0;
    for (const f of r.frames) for (const p of f.plants) {
      for (const l of p.limiting) expect(valid.has(l)).toBe(true);
      expect(new Set(p.limiting).size).toBe(p.limiting.length);
      if (p.limiting.length) saw++;
    }
    expect(saw).toBeGreaterThan(0);
    expect(r.frames[60].plants.some((p) => p.limiting.includes("fe"))).toBe(true);
  });

  it("a plant in a cold, hard, CO2-free tank is limited by those factors", () => {
    const input: SimInput = {
      ...typicalScape({ days: 1 }),
      water: { temperatureC: 17, pH: 7.9, gh: 20, kh: 13, co2Ppm: 2 },
      plants: [{ id: "r", speciesId: "rotala-macrandra", x: 0, z: 0, y: 0, portions: 1 }],
    };
    const lim = simulate(input).frames[1].plants[0].limiting;
    for (const f of ["co2", "temperature", "gh", "kh"]) expect(lim).toContain(f);
  });

  it("events are raised at most once per plant/type and appear in that day's frame", () => {
    const r = simulate(typicalScape({ days: 130, substrate: { type: "inert", reserve: 1 } }));
    const seen = new Set<string>();
    const all: SimEvent[] = [];
    for (const f of r.frames) for (const e of f.events) {
      expect(e.day).toBe(f.day);
      const key = `${e.plantId}/${e.type}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      all.push(e);
    }
    const types = new Set(all.map((e) => e.type));
    for (const t of ["overtaken", "deficiency", "melt"]) expect(types.has(t as SimEvent["type"])).toBe(true);
    const counts = r.summary.eventCounts;
    expect(counts.deficiency).toBe(all.filter((e) => e.type === "deficiency").length);
  });

  it("overtaken: a fast stem outgrows a neighbouring rosette", () => {
    const input: SimInput = {
      ...typicalScape({ days: 80 }),
      tank: { widthCm: 60, depthCm: 30, heightCm: 60 },
      light: { surfacePar: 400, photoperiodH: 8, coverage: 1 },
      dosing: { no3: 1, po4: 0.1, k: 1, fe: 0.05 },
      plants: [
        { id: "crypt", speciesId: "cryptocoryne-balansae", x: 0, z: 0, y: 0, portions: 1 },
        { id: "stem", speciesId: "hygrophila-corymbosa", x: 2, z: 0, y: 0, portions: 2 },
      ],
    };
    const f0 = simulate({ ...input, days: 0 }).frames[0];
    expect(f0.plants[0].heightCm).toBeGreaterThan(f0.plants[1].heightCm);
    const r = simulate(input);
    expect(r.frames[0].events.find((e) => e.type === "overtaken")).toBeUndefined();
    const ev = r.frames.flatMap((f) => f.events).find((e) => e.type === "overtaken" && e.plantId === "crypt");
    expect(ev?.detail).toBe("stem");
  });

  it("shaded + melt: a light-hungry carpet under floating cover", () => {
    const input: SimInput = {
      ...typicalScape({ days: 120 }),
      light: { surfacePar: 120, photoperiodH: 8, coverage: 1 },
      plants: [
        { id: "carpet", speciesId: "glossostigma-elatinoides", x: 0, z: 0, y: 0, portions: 1 },
        { id: "float", speciesId: "pistia-stratiotes", x: 0, z: 0, y: 0, portions: 4 },
      ],
    };
    const ev = simulate(input).frames.flatMap((f) => f.events).filter((e) => e.plantId === "carpet");
    const shaded = ev.find((e) => e.type === "shaded");
    expect(shaded?.day).toBeGreaterThanOrEqual(2);
    expect(ev.some((e) => e.type === "melt")).toBe(true);
  });

  it("trimNeeded: fast stems reaching their max height", () => {
    const input: SimInput = {
      ...typicalScape({ days: 120 }),
      dosing: { no3: 1, po4: 0.1, k: 1, fe: 0.05 },
      plants: [{ id: "s", speciesId: "limnophila-sessiliflora", x: 0, z: 0, y: 0, portions: 1 }],
      light: { surfacePar: 130, photoperiodH: 8, coverage: 1 },
    };
    const ev = simulate(input).frames.flatMap((f) => f.events).find((e) => e.type === "trimNeeded");
    expect(ev).toBeDefined();
  });
});

describe("worker protocol", () => {
  it("streams frames then done", async () => {
    const msgs: WorkerResponse[] = [];
    const handle = createWorkerHandler((m) => msgs.push(m));
    await handle({ type: "run", requestId: 1, input: typicalScape({ days: 10 }) });
    expect(msgs.filter((m) => m.type === "frame")).toHaveLength(11);
    const last = msgs[msgs.length - 1];
    expect(last.type).toBe("done");
    if (last.type === "done") {
      expect(last.result.frames).toHaveLength(11);
      expect(last.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(last.requestId).toBe(1);
    }
  });

  it("supports cancel", async () => {
    const msgs: WorkerResponse[] = [];
    const handle = createWorkerHandler((m) => msgs.push(m), { sliceMs: 0 });
    const run = handle({ type: "run", requestId: 2, input: typicalScape({ days: 200 }) });
    await new Promise((r) => setTimeout(r, 0));
    await handle({ type: "cancel", requestId: 2 });
    await run;
    expect(msgs.some((m) => m.type === "done")).toBe(false);
    const last = msgs[msgs.length - 1];
    expect(last).toMatchObject({ type: "error", requestId: 2, message: "cancelled" });
    expect(msgs.filter((m) => m.type === "frame").length).toBeLessThan(201);
  });

  it("reports errors", async () => {
    const msgs: WorkerResponse[] = [];
    const handle = createWorkerHandler((m) => msgs.push(m));
    await handle({ type: "run", requestId: 3, input: { ...typicalScape({ days: 1 }), species: {} } });
    expect(msgs).toEqual([{ type: "error", requestId: 3, message: expect.stringMatching(/unknown species/) }]);
  });
});
