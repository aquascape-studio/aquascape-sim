#!/usr/bin/env python3
"""Generate ts/test/fixtures/parity.json from the Python reference engine.

Usage (from repo root or ts/):  python3 ts/scripts/gen_parity.py
Requires numpy (the engine's only runtime import for algo/).
"""

from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "src"))

from aquascape_sim.algo.envelope import Axis, compat  # noqa: E402
from aquascape_sim.algo.light import attenuate_by_canopy, par_at_depth  # noqa: E402
from aquascape_sim.algo.nutrients import NutrientState, Reservoir, Uptake, deplete  # noqa: E402
from aquascape_sim.algo.photosynthesis import (  # noqa: E402
    co2_response,
    pi_curve,
    temperature_response,
)
from aquascape_sim.algo.tick import PlantState, TickState, run_tick  # noqa: E402


def axis_cases() -> list[dict]:
    axes = [(0, 10, 20, 30), (5.5, 6.5, 7.2, 8.0), (20, 20, 28, 30), (1, 1, 1, 2), (-5, 0, 0, 5)]
    xs = [-10, -5, 0, 0.5, 1, 1.5, 5.5, 5.6, 6.0, 6.5, 7.0, 7.2, 7.5, 7.99, 8, 10, 15, 20, 21.3, 25, 28, 29, 30, 31]
    out = []
    for ax in axes:
        a = Axis(*map(float, ax))
        for x in xs:
            out.append({"axis": list(ax), "x": x, "y": a.score(float(x))})
    return out


def compat_cases() -> list[dict]:
    axes = {
        "temp": (20, 23, 27, 30),
        "ph": (5.5, 6.5, 7.2, 8.0),
        "gh": (1, 3, 10, 18),
        "par": (10, 40, 150, 300),
        "co2": (0, 10, 35, 50),
        "no3": (1, 5, 25, 50),
        "po4": (0.05, 0.5, 2, 5),
        "k": (1, 5, 20, 40),
        "fe": (0.01, 0.05, 0.3, 1.0),
    }
    temps = [19, 22, 25, 29.5]
    phs = [6.0, 6.8, 7.9]
    pars = [5, 25, 100, 250]
    co2s = [0, 5, 30, 45]
    out = []
    keys = list(axes)
    for t, ph, par, co2 in itertools.product(temps, phs, pars, co2s):
        actuals = {"temp": t, "ph": ph, "gh": 6.0, "par": par, "co2": co2,
                   "no3": 10.0, "po4": 0.3, "k": 12.0, "fe": 0.07}
        # vary the number of axes to exercise numpy's pairwise sum branches (n<8 and n>=8)
        for n in (1, 4, 7, 8, 9):
            sub = {k: axes[k] for k in keys[:n]}
            y = compat({k: Axis(*map(float, v)) for k, v in sub.items()}, actuals)
            out.append({"axes": sub, "actuals": actuals, "y": y})
    out.append({"axes": {}, "actuals": {"temp": 25}, "y": compat({}, {"temp": 25.0})})
    out.append({"axes": {"x": (0, 1, 2, 3)}, "actuals": {"temp": 25},
                "y": compat({"x": Axis(0, 1, 2, 3)}, {"temp": 25.0})})
    return out


def light_cases() -> list[dict]:
    out = []
    for s, d in itertools.product([0, 50, 120, 400, 1000], [0, 1, 10, 25.5, 45, 60]):
        out.append({"fn": "par_at_depth", "args": [s, d], "y": par_at_depth(float(s), float(d))})
    for p, b in itertools.product([0, 30, 120, 800], [-5, 0, 3, 50, 400, 2500]):
        out.append({"fn": "attenuate_by_canopy", "args": [p, b], "y": attenuate_by_canopy(float(p), float(b))})
    return out


def photo_cases() -> list[dict]:
    out = []
    for I, alpha, pmax, theta in itertools.product([-5, 0, 10, 50, 150, 600], [0, 0.03, 0.05, 1 / 40], [0, 1, 8.5], [0, 0.7, 1, 1.5]):
        out.append({"fn": "pi_curve", "args": [I, alpha, pmax, theta], "y": pi_curve(I, alpha, pmax, theta)})
    for co2, ph, kh, km in itertools.product([-1, 0, 5, 20, 35], [3.0, 6.0, 6.8, 7.5, 11], [-1, 0, 2, 6], [0, 5, 15]):
        out.append({"fn": "co2_response", "args": [co2, ph, kh, km], "y": co2_response(co2, ph, kh, km)})
    for T, topt, q10, sig in itertools.product([15, 22, 25, 28.5, 33], [22, 25], [0.5, 2.0, 3.0], [0, 1.5, 3.0]):
        out.append({"fn": "temperature_response", "args": [T, topt, q10, sig], "y": temperature_response(T, topt, q10, sig)})
    return out


def nutrient_cases() -> list[dict]:
    out = []
    for no3, po4, rate, dt in itertools.product([0, 2, 10], [0, 0.1, 1], [-3, 0, 4.2, 25], [-1, 0, 1, 12]):
        r = deplete(NutrientState(no3=no3, po4=po4), rate, dt)
        out.append({"fn": "deplete", "args": [no3, po4, rate, dt], "y": [r.no3, r.po4]})
    r = deplete(NutrientState(5, 0.5), 10, 2, k_no3=0.01, k_po4=0.002)
    out.append({"fn": "deplete_k", "args": [5, 0.5, 10, 2, 0.01, 0.002], "y": [r.no3, r.po4]})
    for init, upt in [
        ({}, {}),
        ({"dose_no3": 1, "dose_fe": 0.25}, {"no3": 0.3, "po4": 0.01, "k": 0.2, "fe": 0.001}),
        ({"no3": 0.01, "fe": 0.0}, {"no3": 5, "po4": 5, "k": 50, "fe": 1}),
    ]:
        res = Reservoir(**init)
        res.apply_daily(Uptake(**upt))
        out.append({"fn": "apply_daily", "init": init, "uptake": upt,
                    "y": [res.no3, res.po4, res.k, res.fe]})
    return out


def tick_scenarios() -> list[dict]:
    scenarios = []
    for name, res_kw, days in [
        ("dosed", {"dose_no3": 0.3, "dose_po4": 0.03, "dose_k": 0.1, "dose_fe": 0.22}, 45),
        ("starved", {}, 20),
    ]:
        env_a = {"temp": (20, 23, 27, 30), "ph": (5.5, 6.5, 7.2, 8.0), "par": (10, 40, 150, 300), "co2": (0, 10, 35, 50)}
        env_b = {"temp": (22, 24, 26, 28), "par": (30, 80, 200, 400), "co2": (5, 20, 40, 60)}
        env_c = {"gh": (1, 3, 10, 18), "ph": (6.0, 6.8, 7.0, 7.5), "par": (5, 20, 60, 100)}
        plants_spec = [
            ("p-a", "sp-a", 3.0, 1.0, 20.0, env_a),
            ("p-b", "sp-b", 1.0, 0.9, 35.0, env_b),
            ("p-c", "sp-c", 5.0, 0.6, 10.0, env_c),
            ("p-d", "sp-d", 1.0, 1.0, 30.0, {}),
            ("p-e", "sp-e", 3.0, 0.4, 25.0, env_b),
        ]
        st = TickState()
        st.surface_par = 140.0
        st.water_params = {"temp": 25.5, "ph": 6.9, "gh": 6.0, "par": 140.0, "co2": 22.0}
        st.reservoir = Reservoir(**res_kw)
        for pid, sid, bio, health, depth, env in plants_spec:
            st.plants[pid] = PlantState(
                species_id=sid, biomass_g=bio, health=health, depth_cm=depth,
                envelope={k: Axis(*map(float, v)) for k, v in env.items()},
            )
        trace = []
        for day in range(days):
            run_tick(st, day)
            trace.append({
                "plants": {pid: [p.biomass_g, p.health] for pid, p in st.plants.items()},
                "reservoir": [st.reservoir.no3, st.reservoir.po4, st.reservoir.k, st.reservoir.fe],
            })
        scenarios.append({
            "name": name,
            "surfacePar": 140.0,
            "waterParams": {"temp": 25.5, "ph": 6.9, "gh": 6.0, "par": 140.0, "co2": 22.0},
            "reservoir": res_kw,
            "plants": [
                {"id": pid, "speciesId": sid, "biomassG": bio, "health": h, "depthCm": d, "envelope": env}
                for pid, sid, bio, h, d, env in plants_spec
            ],
            "days": days,
            "trace": trace,
        })
    return scenarios


def main() -> None:
    fixture = {
        "generator": "ts/scripts/gen_parity.py",
        "axis": axis_cases(),
        "compat": compat_cases(),
        "light": light_cases(),
        "photosynthesis": photo_cases(),
        "nutrients": nutrient_cases(),
        "tick": tick_scenarios(),
    }
    out = HERE.parent / "test" / "fixtures" / "parity.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixture, separators=(",", ":"), allow_nan=False) + "\n")
    n = sum(len(v) for v in fixture.values() if isinstance(v, list))
    print(f"wrote {out} ({n} case groups)")


if __name__ == "__main__":
    main()
