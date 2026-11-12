import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  Axis, compat, parAtDepth, attenuateByCanopy, piCurve, co2Response, temperatureResponse,
  deplete, nutrientState, Reservoir, Uptake, plantState, tickState, runTick,
} from "../src/algo";

type Num4 = [number, number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fx: any = JSON.parse(
  readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"),
);

const TOL = 1e-9;
let maxErr = 0;
function close(ts: number, py: number, label: string): void {
  const err = Math.abs(ts - py);
  if (err > maxErr) maxErr = err;
  if (!(err <= TOL)) throw new Error(`${label}: ts=${ts} py=${py} |Δ|=${err}`);
}
const axes = (o: Record<string, Num4>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Axis(...v)]));
const camel = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), v]));

describe("parity with Python engine (|ts − py| ≤ 1e-9)", () => {
  it("Axis.score", () => {
    for (const c of fx.axis) close(new Axis(...(c.axis as Num4)).score(c.x), c.y, `score ${c.axis} @${c.x}`);
  });

  it("compat (geometric mean)", () => {
    for (const c of fx.compat) close(compat(axes(c.axes), c.actuals), c.y, `compat ${JSON.stringify(c.axes)}`);
  });

  it("light", () => {
    for (const c of fx.light) {
      const f = c.fn === "par_at_depth" ? parAtDepth : attenuateByCanopy;
      close(f(c.args[0], c.args[1]), c.y, `${c.fn}(${c.args})`);
    }
  });

  it("photosynthesis", () => {
    const fns: Record<string, (...a: number[]) => number> = {
      pi_curve: (a, b, c, d) => piCurve(a, b, c, d),
      co2_response: (a, b, c, d) => co2Response(a, b, c, d),
      temperature_response: (a, b, c, d) => temperatureResponse(a, b, c, d),
    };
    for (const c of fx.photosynthesis) close(fns[c.fn](...c.args), c.y, `${c.fn}(${c.args})`);
  });

  it("nutrients", () => {
    for (const c of fx.nutrients) {
      if (c.fn === "apply_daily") {
        const r = new Reservoir(camel(c.init));
        r.applyDaily(new Uptake(c.uptake));
        [r.no3, r.po4, r.k, r.fe].forEach((v, i) => close(v, c.y[i], `apply_daily[${i}]`));
      } else {
        const [no3, po4, rate, dt, kNo3, kPo4] = c.args;
        const r = c.fn === "deplete_k"
          ? deplete(nutrientState(no3, po4), rate, dt, kNo3, kPo4)
          : deplete(nutrientState(no3, po4), rate, dt);
        close(r.no3, c.y[0], `deplete no3 ${c.args}`);
        close(r.po4, c.y[1], `deplete po4 ${c.args}`);
      }
    }
  });

  it("run_tick multi-day scenarios", () => {
    for (const sc of fx.tick) {
      const st = tickState({
        surfacePar: sc.surfacePar,
        waterParams: { ...sc.waterParams },
        reservoir: new Reservoir(camel(sc.reservoir)),
      });
      for (const p of sc.plants) {
        st.plants.set(p.id, plantState({
          speciesId: p.speciesId, biomassG: p.biomassG, health: p.health, depthCm: p.depthCm,
          envelope: axes(p.envelope),
        }));
      }
      for (let day = 0; day < sc.days; day++) {
        runTick(st, day);
        const t = sc.trace[day];
        for (const [pid, [bio, health]] of Object.entries(t.plants as Record<string, [number, number]>)) {
          close(st.plants.get(pid)!.biomassG, bio, `${sc.name} d${day} ${pid} biomass`);
          close(st.plants.get(pid)!.health, health, `${sc.name} d${day} ${pid} health`);
        }
        const r = st.reservoir;
        [r.no3, r.po4, r.k, r.fe].forEach((v, i) => close(v, t.reservoir[i], `${sc.name} d${day} res[${i}]`));
      }
    }
  });

  it("reports max error", () => {
    console.log(`[parity] max |ts - py| = ${maxErr.toExponential(3)}`);
    expect(maxErr).toBeLessThanOrEqual(TOL);
  });
});
