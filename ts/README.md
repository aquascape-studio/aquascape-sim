# @aquascape/sim-core

Deterministic, dependency-free TypeScript growth engine for aquascape-studio.

* `src/algo/` — 1:1 ports of the Python engine (`src/aquascape_sim/algo/`), verified
  against the Python implementation to ≤ 1e-9 (`test/parity.test.ts`).
* `src/engine.ts` — spatial extension: light grid, per-plant growth from botany
  species records, water-column + substrate nutrients, limiting factors, events.
* `src/contract.ts` — cross-repo types (orchestrator-owned, **read-only**).

`src/` has no runtime dependencies and only extensionless relative imports, so
aquascape-web can vendor-copy it verbatim (`"moduleResolution": "bundler"`).

```bash
pnpm install
pnpm typecheck
pnpm test                       # parity + engine behaviour + perf budget
python3 scripts/gen_parity.py   # regenerate test/fixtures/parity.json (needs numpy)
```

## API

```ts
import { simulate, simulateIter, createWorkerHandler, type SimInput } from "@aquascape/sim-core";

const result = simulate(input);            // SimResult: frames for day 0..days inclusive + summary
for (const frame of simulateIter(input)) { /* stream frames; generator returns SimResult */ }

// Web Worker (src/worker.ts is a ready-made `self.onmessage` entry):
const worker = new Worker(new URL("./sim-core/worker", import.meta.url), { type: "module" });
worker.postMessage({ type: "run", requestId: 1, input });
// ← { type: "frame", requestId, frame } × (days + 1), then { type: "done", requestId, result, elapsedMs }
worker.postMessage({ type: "cancel", requestId: 1 });
// ← exactly one { type: "cancelled", requestId } if the run was still in flight, then nothing
//   more for that id; cancelling an unknown/finished id posts nothing.
```

`createWorkerHandler(postMessage, { sliceMs })` implements the protocol for any
transport; it yields to the event loop every `sliceMs` (default 8 ms) so that
`cancel` messages are processed mid-run.

Also exported: `Engine` (step-wise driver; `substrateRemaining()` for diagnostics),
`algo` namespace (the Python ports), `createPrng` (sfc32), `envelopeAxis`,
`lightEnvelopeAxis` / `LightAxis` (contract 1.2.0 light axis), `co2EnvelopeAxis` /
`Co2Axis` / `co2RateFactor` (contract 1.3.0 CO2 axis and rate factor), `canopyTransmission`.

## Coordinates & units

| quantity | unit / convention |
|---|---|
| lengths | cm; origin at the centre of the tank floor; x left→right, z back→front, y up |
| PAR | µmol·m⁻²·s⁻¹ while the light is on |
| concentrations | mg/L (CO₂ ppm ≈ mg/L) |
| dosing | mg/L added per day |
| biomass | g fresh mass |
| time | days (one step = one day) |

Light grid: `nx = gridX`, `nz = max(1, round(gridX · depth / width))`, cell
`(ix, iz)` centred at `x = −W/2 + (ix+½)·W/nx`, `z = −D/2 + (iz+½)·D/nz`;
`Frame.light.par[iz * nx + ix]` is PAR at substrate level after canopy shading.

## Model summary

**Light.** Surface PAR is `surfacePar` inside a centred rectangle covering
`coverage` of the footprint (both sides scaled by √coverage) with a Gaussian
fall-off (6 cm) outside. Water attenuation is Beer-Lambert `parAtDepth`
(`K_WATER = 0.03 /cm`). Each plant covers the cells whose centre lies inside its
spread disc (at least the cell under it). Per cell, plants are ordered by top
height (`y + heightCm`; floating plants sit at the surface) and each receives
`parAtDepth(surface, H − top) · exp(−K_SHADE · Σ load above)` where load is
`biomass / footprint area` (g/cm², `K_SHADE = 2.5`, ×2 floating, ×0.8 carpet, ×0.6 moss).
`parAtPlant` is the footprint mean (lights-on PAR, not 24 h averaged);
`parDailyMean = parAtPlant · photoperiodH / 24` (contract 1.1).

**Fitness.** Botany `{min, opt, max}` envelopes become trapezoid `Axis`es with a
plateau of ±30 % around `opt` (contract `ENVELOPE_RULE`). Light is a
`LightAxis` (contract 1.2.0): plateau −30 % / +70 %, and above it the score
ramps from 1 at optMax down to `LIGHT_UPPER_FLOOR` (0.75) at `light.max` and
stays at 0.75 for any brighter PAR — botany `light.max` is the top of the
husbandry range, not a lethal limit, so light alone never collapses fitness
(0.75^(1/6) ≈ 0.95) or melts a plant (aquascape-sim#8). The lower side is the
plain trapezoid. CO2 is a `Co2Axis` (contract 1.3.0): at or below botany
`co2.min` it scores `CO2_LOWER_FLOOR` (0.6), ramps up to 1 at optMin, and its
upper side is the plain trapezoid (0 at `co2.max`). Botany `co2.min` is the
bottom of the recommended range, so CO2 alone never melts a plant
(0.6^(1/6) ≈ 0.92 fitness; aquascape-sim#11). Fitness = `compat` (geometric mean) over light, co2,
temperatureC, pH, gh, kh. `algo/envelope.ts` `Axis` stays the 1:1 Python
port (parity tests); the Python engine has no botany light axis to mirror.

**Light-response reference.** `test/fixtures/dutch60p.json` is the web app's
Dutch Streets template on an ADA 60-P (60×30, 32 cm water column, 42
placements, 11 stem species) as built by aquascape-web; `test/light-response.test.ts`
checks contract `LIGHT_RESPONSE_INVARIANTS` on it at surface PAR 100/200/320
and CO2 5/25 ppm.

**CO2-response reference.** `test/fixtures/lowtech60.json` is the web app's
Nature Low tech template on 60×30 with a 32 cm water column (55 placements, 15
species), built the same way; `test/co2-response.test.ts` checks contract
`CO2_RESPONSE_INVARIANTS` on it and on Dutch 60-P.

**Growth.** Carrying capacity `bMax = 0.02 g/cm³ · hTarget · π(spread/2)²` with
`spread = maxSpreadCm · √portions`; plants start at 12 % of it. Daily
`rgr = 0.12 · k_photosynthesis · piCurve(PAR, 1/k_light, 1) · co2RateFactor(co2Ppm, k_co2)
· temperatureResponse(T, preferred_temp_c, 2, temp_tolerance_c) · fitness · nutrient
sufficiency · health · √space · photoperiodH/8 (≤1.5) · jitter(seeded ±8 %)`,
and biomass grows logistically toward `bMax`. `co2RateFactor` is
`c / (c + k_co2)` with `c = max(co2Ppm, CO2_BASELINE_PPM = 2)` (contract 1.3.0
`CO2_RATE_RULE`); pH and KH only act through their envelope axes. The pH/KH-based
`algo.co2Response` remains as the Python parity port but the engine no longer uses it. Height/spread follow biomass
progress toward the species maxima (stems may reach 1.15 × maxHeight, capped at
the water surface). Health follows the Python rule (decay when fitness × nutrient
sufficiency < 0.5, +0.005/day otherwise); low health sheds biomass.

**Nutrients.** Water column starts from `initialNutrients` (defaults = Python
`Reservoir`: NO₃ 10, PO₄ 1, K 10, Fe 0.1 mg/L), gets daily dosing and first-order
losses (3 %, 3 %, 2 %, 15 %/day). Plants hold a tissue quota per nutrient
(1 = optimal; demand scaled by botany low/medium/high). Growth dilutes it, 2 %/day
turns over, and plants refill from the water column (Michaelis-Menten in
concentration) and from substrate cells under their footprint — root feeders
draw from the substrate first, other rooted plants from water first; epiphytes on
hardscape, mosses and floaters have no substrate access. Quota score is
`min(1, q / 0.6)`; `deficiency` fires when q < 0.5.
Aquasoil (`reserve` = 1) holds per-cm² reserves that release ~1 %/day of the fresh
amount into the water column (slowing below 30 % remaining) plus root uptake,
reaching ~95–97 % depletion by day 120. Inert substrate has no reserve.
`Frame.substrate.reserve[iz * nx + ix]` (contract 1.1) is, per light-grid cell, the
mean over NO₃/PO₄/K/Fe of remaining ÷ day-0 reserve (0..1; all 0 for inert).

**Limiting.** Factors with score < 0.8 among light, co2, temperature, pH, gh, kh,
no3, po4, k, fe, space (crowding by other plants sharing footprint cells), most
limiting first.

**Events** (contract 1.1; emitted in the frame of the day they are raised). Each
key (plant, type, detail) is raised when its condition first holds, and again only
after ≥ 7 consecutive days without it; `melt` is raised at most once per plant.
`shaded` (parAtPlant < species light.min for 3 consecutive days), `overtaken`
(`detail` = id of a plant whose top is above this one in a shared cell; plants
already above it on day 0 don't count), `deficiency` (`detail` = nutrient, one
event per deficient nutrient, tissue quota < 0.5), `melt` (health < 0.3),
`trimNeeded` (top ≥ 0.9 × tank height, or stem height ≥ species maxHeightCm).

**Determinism.** No `Math.random`, no time-dependence: same input ⇒ bit-identical
frames.

## Performance

90 days × 30 plants, gridX 24: ~15–20 ms warm, < 100 ms cold on a laptop (budget
200 ms; `SIM_PERF_MARGIN` relaxes it on CI).
