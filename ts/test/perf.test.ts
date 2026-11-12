import { expect, it } from "vitest";
import { simulate } from "../src";
import { typicalScape } from "./scenarios";

/** Local budget 200 ms. Set SIM_PERF_MARGIN (e.g. 3) to relax on slow CI runners. */
const MARGIN = Number(process.env.SIM_PERF_MARGIN ?? 1);

it("90 days × 30 plants, gridX 24 runs < 200 ms", () => {
  const input = typicalScape({ days: 90, gridX: 24 });
  expect(input.plants).toHaveLength(30);
  // cold run (includes JIT warm-up)
  let t0 = performance.now();
  simulate(input);
  const cold = performance.now() - t0;
  const runs: number[] = [];
  for (let i = 0; i < 5; i++) {
    t0 = performance.now();
    simulate({ ...input, seed: i });
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  const median = runs[2];
  console.log(`[perf] 90d×30 plants gridX24: cold ${cold.toFixed(1)} ms, warm median ${median.toFixed(1)} ms`);
  expect(cold).toBeLessThan(200 * MARGIN);
  expect(median).toBeLessThan(200 * MARGIN);
});
